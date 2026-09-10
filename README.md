# react-native-audio-api native heap leak repro

Minimal reproduction of a native heap leak in `react-native-audio-api` (0.13.3)
on Android: repeatedly creating a fresh `AudioBufferSourceNode`/`GainNode` pair
that both wrap the **same, already-built** `AudioBuffer` - stopping and
disconnecting the previous pair before creating each new one, which is the
standard pattern for repositioning a one-shot source node (there's no
`seek()` on a live `AudioBufferSourceNode`, in this library or any browser) -
leaks native heap that `disconnect()` never releases.

Filed upstream at: https://github.com/software-mansion/react-native-audio-api/issues/1263

**Status: root-caused and fixed.** The leak is `AudioBufferSourceNodeHostObject::setBuffer()`
deep-copying the entire `AudioBuffer` on every `.buffer = x` reassignment, even when
reassigning the exact same underlying buffer - exactly what this repro (and any real
seek-by-rebuilding-the-source-node usage) does on every seek. A pnpm patch that fixes
it by caching the defensive copy on the JS-visible buffer object, reusing it across
reassignments, lives at `../BPMix/patches/react-native-audio-api@0.13.3.patch` -
see that patch and the "What we observed after the fix" section below for how to
apply and verify it against this repro.

## What this app does

- Builds one 4-minute, silent, stereo `AudioBuffer` on launch (the audio
  content is irrelevant to the bug - silence just needs to be long enough to
  be a realistic track length, so no bundled asset is needed).
- A live RSS (resident memory) readout and sparkline at the top, backed by a
  tiny native module that reads `/proc/self/status` directly (not
  `dumpsys`/`android.os.Debug`, both of which force a GC pass as a side
  effect of measuring - which would mask the leak).
- One button: **"Run 60 rapid seeks"**. Each iteration stops+disconnects the
  previous source/gain pair, creates a new pair wrapping the *same*
  `AudioBuffer` instance, and starts it at a random offset - ~150ms apart,
  roughly human rapid-tapping speed, not synthetic max-speed spam.

## What we observed

On a Samsung Galaxy S24+ (Android 16 / API 36, arm64-v8a):

- RSS climbs continuously during the run and **never drops back down**, even
  though every source+gain pair from prior iterations should be unreachable
  from JS by the time the next one is created.
- A single run of 60 iterations took RSS from ~369 MB to **4637 MB** - about
  **71 MB leaked per seek**, suspiciously close to the full buffer's size
  (240s × 44100Hz × 2ch × 4 bytes ≈ 84.7 MB), suggesting each new source
  triggers an internal full copy of the PCM data rather than sharing/
  referencing the existing buffer.
- `adb shell dumpsys meminfo <package>` confirms the leaked memory sits in
  **Native Heap** (not Java/Dalvik heap, not graphics) - Native Heap Size/
  Alloc reached ~5.2 GB after that same run, with ~3.2 GB of it swapped to
  disk under the resulting memory pressure.
- Eventually this crashes the app via a Hermes GC OOM (`SIGSEGV` in the
  `mqt_v_js` thread) once system memory pressure from the leak leaves nothing
  for Hermes to grow into.

## What we observed after the fix

Same device, `react-native-audio-api@0.13.3` with the patch applied
(`node_modules/react-native-audio-api` overwritten with the patched source,
native code rebuilt):

- Three consecutive runs of 60 seeks each, measured with `adb shell dumpsys
  meminfo <package>` (not the in-app RSS readout - see the gotcha below)
  sampled before each run and 30s after it settled: run 1 added ~88 MB net,
  runs 2 and 3 added **~0 MB** each (one even settled slightly lower than
  where it started). The one-time bump on run 1 is Hermes JIT-warming the
  seek loop's bytecode and first-time audio-thread/pool setup, not a
  per-seek cost - it does not recur on subsequent runs.
- This is a >99% reduction from the unpatched ~71 MB/seek (4260 MB over the
  same 60-seek run) to no measurable per-seek growth at all.

**Measurement gotcha:** the in-app RSS poller (calling the native module
every 500ms) was itself driving several MB/s of apparent "leak" even with
no `AudioContext` ever created - just the constant bridge/JS churn from
polling that fast outpaces Hermes's GC cadence in a debug build. The app's
poll interval defaults to 2s and the header text warns about this, but for
a rigorous before/after comparison, cross-check with an external `adb shell
dumpsys meminfo <package>` sample instead (unaffected by in-app JS
activity), or slow `RSS_SAMPLE_INTERVAL_MS` down further in `App.tsx`.

## Running it

```sh
npm install
npm start
# in another terminal, with a device/emulator connected:
npm run android
```

Watch the RSS counter at the top, then tap "Run 60 rapid seeks".

## Why this matters

This is the pattern `AudioBufferSourceNode`'s one-shot design *requires* for
any kind of seek/reposition functionality - it's not an unusual or contrived
usage. Under ordinary, human-paced repeated seeking within a single track (a
real app doing exactly this - not this synthetic repro - saw the same native
heap leak and crash), this makes the library unusable for any playback UI
that supports seeking.
