/**
 * Repro app for react-native-audio-api native bugs found while building BPMix.
 *
 * The original bug this app was built for - a native heap leak from
 * re-copying an AudioBuffer on every setBuffer() reassignment during rapid
 * seeks (https://github.com/software-mansion/react-native-audio-api/issues/1263)
 * - is fixed upstream (PR #1281/#1283) and via
 * ../BPMix/patches/react-native-audio-api@0.13.3.patch, so its repro UI has
 * been removed to keep this screen focused on what's still open. The gotcha
 * that repro surfaced is still worth knowing if you're using the RSS poller
 * below for anything: calling the native memory-info module every 500ms was
 * ITSELF driving several MB/s of apparent "leak" even with no AudioContext
 * ever created - fast bridge/JS churn outpaces Hermes's GC cadence in a debug
 * build. Slowing the poll interval down (or cross-checking with an external
 * `adb shell dumpsys meminfo <pkg>` sample, unaffected by in-app JS activity)
 * makes that artifact disappear.
 *
 * What's left is a still-open SIGSEGV theory: see
 * runOnEndedChurnStress/runCrossfadeStyleChurnStress's own comments below.
 *
 * The audio content itself is irrelevant to any of this (a single 4-minute
 * silent stereo buffer, built once), so no bundled asset is needed - this
 * keeps the repro to a single file with no extra dependencies.
 *
 * @format
 */

import { useEffect, useRef, useState } from 'react';
import { NativeModules, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { AudioContext, type AudioBuffer } from 'react-native-audio-api';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const DURATION_SECONDS = 240; // 4 minutes - long enough to be a realistic track length
const FRAME_COUNT = SAMPLE_RATE * DURATION_SECONDS;
// Stress test: repro for the SIGSEGV filed against AudioEventHandlerRegistry's
// unregisterHandler() releasing a jsi::Function off the JS thread (see the button's own
// comment below) - deliberately much faster/longer than the seek-leak repro above, since
// this is a race between the AudioDestructor worker thread tearing a node down and the
// registry's own dispatch worker thread posting its "ended" event to the JS thread, and
// needs many attempts at a tight interval to land the two on top of each other.
const CHURN_ITERATIONS = 4000;
const CHURN_INTERVAL_MS = 20;
// Third stress test: closer to BPMix's actual crossfade/track-switch shape than the
// churn above - see runCrossfadeStyleChurnStress's own comment for what's different
// and why each difference was added.
const CROSSFADE_ITERATIONS = 3000;
const CROSSFADE_INTERVAL_MS = 25;
const CROSSFADE_OVERLAP_MIN_MS = 5;
const CROSSFADE_OVERLAP_MAX_MS = 30;
const GC_PRESSURE_INTERVAL_MS = 4;
const RSS_SAMPLE_INTERVAL_MS = 2000;

interface MemoryInfoNativeModule {
  getMemoryInfoKb(): Promise<{ rssKb: number }>;
}
const MemoryInfo = NativeModules.MemoryInfo as MemoryInfoNativeModule | undefined;

// Kept on globalThis (not module-scope state) so the launch baseline and peak
// survive a Metro Fast Refresh - which re-evaluates this module and would
// otherwise reset both - and only reset on an actual process relaunch, which
// is what "since launch" should mean while iterating on this file.
interface RssGlobals {
  __rssBaselineKb?: number;
  __rssPeakKb?: number;
}
const rssGlobals = globalThis as unknown as RssGlobals;

function useRssSamples(): {
  latestMb: number;
  peakMb: number;
  baselineMb: number;
  rateMbPerSec: number;
  samples: number[];
} {
  const [samples, setSamples] = useState<number[]>([]);
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!MemoryInfo) return;
    const interval = setInterval(() => {
      MemoryInfo!.getMemoryInfoKb()
        .then(({ rssKb }) => {
          if (rssKb < 0) return;
          if (!rssGlobals.__rssBaselineKb) rssGlobals.__rssBaselineKb = rssKb;
          if (rssKb > (rssGlobals.__rssPeakKb ?? 0)) {
            rssGlobals.__rssPeakKb = rssKb;
            forceRender((n) => n + 1);
          }
          setSamples((prev) => {
            const next = [...prev, rssKb];
            return next.length > 120 ? next.slice(next.length - 120) : next;
          });
        })
        .catch(() => {});
    }, RSS_SAMPLE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const latestKb = samples[samples.length - 1] ?? 0;
  // Consecutive-sample delta, not a multi-sample trailing window - a windowed
  // average amplifies one big jump into a scarier-looking sustained rate long
  // after the jump itself is over; comparing only the current bar to the one
  // right before it settles back down again just as fast as RSS itself does.
  const previousKb = samples[samples.length - 2];
  const rateMbPerSec =
    previousKb !== undefined ? (latestKb - previousKb) / 1024 / (RSS_SAMPLE_INTERVAL_MS / 1000) : 0;

  return {
    latestMb: latestKb / 1024,
    peakMb: (rssGlobals.__rssPeakKb ?? 0) / 1024,
    baselineMb: (rssGlobals.__rssBaselineKb ?? 0) / 1024,
    rateMbPerSec,
    samples,
  };
}

// Three-way color for the MB/s readout: green while shrinking, blue for a
// slow/flat trickle (< 1 MB/s), red once it's climbing at a full MB/s or more -
// the threshold that made the pre-fix ~71 MB/seek leak impossible to miss.
function rateColorStyle(rateMbPerSec: number) {
  if (rateMbPerSec < 0) return styles.rateDown;
  if (rateMbPerSec < 0.3) return styles.rateFlat;
  return styles.rateUp;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const { latestMb, peakMb, baselineMb, rateMbPerSec, samples } = useRssSamples();
  const deltaMb = latestMb - baselineMb;
  const [status, setStatus] = useState(
    'Not started - tap "Create AudioContext" to build the engine and buffer.',
  );
  const [contextCreated, setContextCreated] = useState(false);
  const [iteration, setIteration] = useState(0);
  const [running, setRunning] = useState(false);

  const contextRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  // Second, DISTINCT AudioBuffer/AudioBufferHostObject - BPMix's real crossfade
  // decodes a fresh buffer per track (never reassigns the same JS AudioBuffer
  // object across a track switch the way the leak/churn repros above do), so
  // alternating between two real, separate buffers here is closer to that than
  // reusing one - see runCrossfadeStyleChurnStress.
  const bufferBRef = useRef<AudioBuffer | null>(null);
  const currentRef = useRef<{ source: any; gain: any } | null>(null);

  // Deferred to a button (not auto-created on mount) so the pre/post-creation
  // RSS trend can be compared within the same running app instance - useful
  // for telling "AudioContext's own render thread leaks even while idle" apart
  // from ordinary app/dev-build warm-up that would happen either way.
  const createContext = () => {
    if (contextRef.current) return;
    const context = new AudioContext();
    contextRef.current = context;
    const buffer = context.createBuffer(CHANNELS, FRAME_COUNT, SAMPLE_RATE);
    const silence = new Float32Array(FRAME_COUNT); // all zeros
    for (let channel = 0; channel < CHANNELS; channel++) {
      buffer.copyToChannel(silence, channel);
    }
    bufferRef.current = buffer;
    // Genuinely separate AudioBuffer/AudioBufferHostObject, not a second handle
    // onto the same one - see bufferBRef's own comment.
    const bufferB = context.createBuffer(CHANNELS, FRAME_COUNT, SAMPLE_RATE);
    for (let channel = 0; channel < CHANNELS; channel++) {
      bufferB.copyToChannel(silence, channel);
    }
    bufferBRef.current = bufferB;
    setContextCreated(true);
    setStatus('Ready.');
  };

  const stopAndDisconnectCurrent = () => {
    const current = currentRef.current;
    if (!current) return;
    try {
      current.source.stop(contextRef.current!.currentTime);
    } catch {
      // already stopped - fine.
    }
    current.source.disconnect();
    current.gain.disconnect();
    currentRef.current = null;
  };

  // Registers a real onended callback - that's what puts an actual
  // jsi::Function into AudioEventHandlerRegistry's eventHandlers_ map, which
  // is what unregisterHandler() has to release when the node is torn down.
  const createAndStartSourceWithOnEnded = (offsetSeconds: number) => {
    const context = contextRef.current!;
    const buffer = bufferRef.current!;
    const source = context.createBufferSource({ pitchCorrection: false });
    source.buffer = buffer;
    source.onEnded = () => {};
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    source.start(context.currentTime, offsetSeconds);
    currentRef.current = { source, gain };
  };

  // Repro for the SIGSEGV filed against AudioEventHandlerRegistry::unregisterHandler():
  // it dropped the map's last shared_ptr<jsi::Function> reference (destructing the
  // jsi::Function) on whatever thread called it. unregisterHandler() runs from
  // ~EventCaller(), which runs on whatever thread destroys the owning node -
  // AudioGraphManager's nodeDestructor_ (AudioDestructor) is a dedicated background
  // thread, not the JS thread, so a node torn down there while a fresh "ended" event
  // for some OTHER node is concurrently in flight through the registry's dispatch
  // worker -> JS thread pipeline races the JS thread's own live use of the Hermes
  // runtime. Tight create/stop/destroy churn with a real onEnded listener attached
  // (see createAndStartSourceWithOnEnded) is what's needed to actually collide the
  // two - the leak repro above never registers a listener at all, so it can't hit this.
  const runOnEndedChurnStress = async () => {
    if (!bufferRef.current || !contextCreated || running) return;
    setRunning(true);
    createAndStartSourceWithOnEnded(0);
    for (let i = 1; i <= CHURN_ITERATIONS; i++) {
      await delay(CHURN_INTERVAL_MS);
      const offset = Math.random() * (DURATION_SECONDS - 5);
      stopAndDisconnectCurrent();
      createAndStartSourceWithOnEnded(offset);
      setIteration(i);
    }
    stopAndDisconnectCurrent();
    setRunning(false);
  };

  // Busy-work on the JS thread with no audio API involvement at all - churns
  // objects/strings fast enough to keep Hermes's GC actually running
  // concurrently with the stress loop below, rather than sitting idle between
  // its sparse allocations. BPMix's JS thread has real, unrelated work
  // happening during a track switch (React re-renders, metadata/lyrics
  // lookups, persistence writes) that this repro otherwise has no equivalent
  // of - see runCrossfadeStyleChurnStress's own comment for why that
  // concurrent JS-thread activity might matter to actually hitting the race.
  const startGcPressure = (): (() => void) => {
    let n = 0;
    const handle = setInterval(() => {
      const junk: unknown[] = [];
      for (let i = 0; i < 200; i++) {
        junk.push({ i, n, s: `pressure-${n}-${i}` });
      }
      n++;
    }, GC_PRESSURE_INTERVAL_MS);
    return () => clearInterval(handle);
  };

  const createAndStartOverlapping = (buffer: AudioBuffer, offsetSeconds: number) => {
    const context = contextRef.current!;
    const source = context.createBufferSource({ pitchCorrection: false });
    source.buffer = buffer;
    source.onEnded = () => {};
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    source.start(context.currentTime, offsetSeconds);
    return { source, gain };
  };

  /**
   * Repro attempt #2 for the same AudioEventHandlerRegistry::unregisterHandler()
   * SIGSEGV theory as runOnEndedChurnStress - that first attempt (same buffer
   * reused every iteration, strict stop-then-create, nothing else happening on
   * the JS thread) ran 16,000 iterations with zero crashes, so it's missing
   * something about the real BPMix conditions. Three differences from it:
   *
   * 1. Alternates between two DISTINCT AudioBuffers (bufferRef/bufferBRef)
   *    instead of reusing one - BPMix always decodes a fresh buffer per track.
   * 2. Genuinely OVERLAPS nodes instead of stopping the previous one before
   *    starting the next: the new node starts first and is left as
   *    currentRef, while the old one is stopped/disconnected a short random
   *    delay later - during that window two real nodes (two EventCaller/
   *    onEnded registrations) coexist, matching an actual crossfade's shape
   *    instead of a strict one-at-a-time seek.
   * 3. Runs startGcPressure() concurrently for real JS-thread/Hermes-GC
   *    contention during the whole stress run, not just whatever incidental
   *    GC the loop's own small allocations trigger on their own.
   */
  const runCrossfadeStyleChurnStress = async () => {
    if (!bufferRef.current || !bufferBRef.current || !contextCreated || running) return;
    setRunning(true);
    const stopGcPressure = startGcPressure();
    try {
      let previous = createAndStartOverlapping(bufferRef.current, 0);
      for (let i = 1; i <= CROSSFADE_ITERATIONS; i++) {
        await delay(CROSSFADE_INTERVAL_MS);
        const buffer = i % 2 === 0 ? bufferRef.current! : bufferBRef.current!;
        const offset = Math.random() * (DURATION_SECONDS - 5);
        const next = createAndStartOverlapping(buffer, offset);
        currentRef.current = next;
        const overlapMs =
          CROSSFADE_OVERLAP_MIN_MS +
          Math.random() * (CROSSFADE_OVERLAP_MAX_MS - CROSSFADE_OVERLAP_MIN_MS);
        await delay(overlapMs);
        try {
          previous.source.stop(contextRef.current!.currentTime);
        } catch {
          // already stopped - fine.
        }
        previous.source.disconnect();
        previous.gain.disconnect();
        previous = next;
        setIteration(i);
      }
      try {
        previous.source.stop(contextRef.current!.currentTime);
      } catch {
        // already stopped - fine.
      }
      previous.source.disconnect();
      previous.gain.disconnect();
      currentRef.current = null;
    } finally {
      stopGcPressure();
      setRunning(false);
    }
  };

  return (
    <>
      <StatusBar barStyle="light-content" />
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.memoryBox}>
          <Text style={styles.memoryLabel}>
            RSS {latestMb.toFixed(0)} MB · peak {peakMb.toFixed(0)} MB
          </Text>
          <Text style={styles.deltaLabel}>
            {deltaMb >= 0 ? '+' : ''}
            {deltaMb.toFixed(0)} MB since launch ·{' '}
            <Text style={rateColorStyle(rateMbPerSec)}>
              {rateMbPerSec >= 0 ? '+' : ''}
              {rateMbPerSec.toFixed(2)} MB/s
            </Text>
          </Text>
          <View style={styles.sparkline}>
            {samples.map((kb, i) => {
              // Scaled against the all-time peak, not this window's min/max,
              // so the baseline stays fixed at 0 and bar height reflects
              // true magnitude rather than shape within a shifting range.
              const heightFraction = kb / Math.max(peakMb * 1024, 1);
              const prevKb = i > 0 ? samples[i - 1] : kb;
              // Color each bar by its trend vs. the previous sample, not its
              // absolute level - makes a slow-but-steady climb (a handful of
              // KB per tick) visually obvious even once it's dwarfed by peak.
              const barColor =
                kb > prevKb ? styles.barUp : kb < prevKb ? styles.barDown : styles.barFlat;
              return (
                <View
                  key={i}
                  style={[styles.bar, barColor, { height: Math.max(2, heightFraction * 40) }]}
                />
              );
            })}
          </View>
        </View>

        <Text style={styles.title}>react-native-audio-api SIGSEGV repro</Text>
        <Text style={styles.status}>{status}</Text>
        <Text style={styles.status}>Iteration: {iteration}</Text>

        <Pressable
          style={[styles.button, contextCreated && styles.buttonDisabled]}
          onPress={createContext}
          disabled={contextCreated}>
          <Text style={styles.buttonText}>
            {contextCreated ? 'AudioContext created' : 'Create AudioContext'}
          </Text>
        </Pressable>

        <Pressable
          style={[styles.button, (!contextCreated || running) && styles.buttonDisabled]}
          onPress={() => void runOnEndedChurnStress()}
          disabled={!contextCreated || running}>
          <Text style={styles.buttonText}>
            {running ? 'Running…' : `Run ${CHURN_ITERATIONS} onended churn (SIGSEGV repro)`}
          </Text>
        </Pressable>

        <Text style={styles.hint}>
          Each iteration registers a real `source.onEnded` listener before tearing the node
          down, at a tight interval. Against an unpatched library this can crash the whole app
          with a native SIGSEGV (check `adb logcat` for "Fatal signal 11" in a thread named
          mqt_v_js, with a backtrace through jsi::Function::call / jsi::Object::setProperty
          inside libhermesvm.so) - AudioEventHandlerRegistry::unregisterHandler() can release a
          jsi::Function off the JS thread when the owning node is torn down by
          AudioGraphManager's background AudioDestructor. It's a race, not deterministic -
          multiple runs (or increasing CHURN_ITERATIONS) may be needed to hit it.
        </Text>

        <Pressable
          style={[styles.button, (!contextCreated || running) && styles.buttonDisabled]}
          onPress={() => void runCrossfadeStyleChurnStress()}
          disabled={!contextCreated || running}>
          <Text style={styles.buttonText}>
            {running
              ? 'Running…'
              : `Run ${CROSSFADE_ITERATIONS} crossfade-style overlap churn`}
          </Text>
        </Pressable>

        <Text style={styles.hint}>
          Same SIGSEGV theory as the button above, closer to BPMix's actual crossfade shape:
          alternates between two DISTINCT AudioBuffers instead of reusing one, genuinely
          overlaps each new node with the outgoing one for a few ms instead of stopping it
          first, and runs background GC-pressure busywork on the JS thread throughout - see
          runCrossfadeStyleChurnStress's own comment for why each difference was added
          (16,000 iterations of the simpler churn above produced zero crashes).
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    padding: 16,
  },
  memoryBox: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    padding: 8,
    marginBottom: 16,
  },
  memoryLabel: {
    color: '#fff',
    fontSize: 13,
    marginBottom: 2,
  },
  deltaLabel: {
    color: '#ccc',
    fontSize: 12,
    marginBottom: 4,
    fontWeight: '600',
  },
  rateUp: {
    color: '#e5484d',
  },
  rateFlat: {
    color: '#3987e5',
  },
  rateDown: {
    color: '#3dd68c',
  },
  sparkline: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'flex-end',
    overflow: 'hidden',
  },
  bar: {
    width: 2,
    marginRight: 1,
  },
  barUp: {
    backgroundColor: '#e5484d',
  },
  barDown: {
    backgroundColor: '#3dd68c',
  },
  barFlat: {
    backgroundColor: '#3987e5',
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  status: {
    color: '#ccc',
    fontSize: 14,
    marginBottom: 4,
  },
  button: {
    backgroundColor: '#2a78d6',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 16,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    color: '#999',
    fontSize: 13,
    lineHeight: 18,
  },
});

export default App;
