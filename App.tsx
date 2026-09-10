/**
 * Minimal repro: repeatedly creating a fresh AudioBufferSourceNode + GainNode
 * pair that both wrap the SAME, already-built AudioBuffer - stopping and
 * disconnecting the previous pair before creating each new one, exactly the
 * "seek by tearing down and rebuilding the one-shot source" pattern the Web
 * Audio API requires.
 *
 * Against an UNPATCHED react-native-audio-api@0.13.3, tap "Create
 * AudioContext" then "Run 60 rapid seeks" and watch the RSS counter/sparkline:
 * it climbs by roughly the full buffer's size on every single seek and never
 * comes back down, even though every source+gain pair from prior iterations
 * should be unreachable from JS by the time the next one is created - see
 * https://github.com/software-mansion/react-native-audio-api/issues/1263.
 *
 * Against the PATCHED library (see ../BPMix/patches/react-native-audio-api@0.13.3.patch,
 * which caches the defensive buffer copy on the JS-visible AudioBuffer object
 * instead of re-copying it on every reassignment), repeated runs settle to no
 * net growth: only the *first* run adds a one-time bump (Hermes JIT warming
 * up the seek loop's bytecode, audio-thread pool setup, etc.) - runs 2, 3, ...
 * add nothing further. Confirmed via `adb shell dumpsys meminfo <pkg>` sampled
 * before/after/+30s-settled across three consecutive runs.
 *
 * Gotcha found while measuring this: the in-app RSS poller below calling the
 * native module every 500ms was ITSELF driving several MB/s of apparent
 * "leak" even with no AudioContext ever created - the constant bridge/JS churn
 * from polling that fast outpaces Hermes's GC cadence in a debug build. Slowing
 * the poll interval down (or cross-checking with an external `dumpsys meminfo`
 * sample, which isn't affected by in-app JS activity) makes that artifact
 * disappear. Don't mistake a fast poll rate for a real leak.
 *
 * The audio content itself is irrelevant to the bug (a single 4-minute
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
const SEEK_ITERATIONS = 60;
const SEEK_INTERVAL_MS = 150; // roughly human rapid-tapping speed, not synthetic max-speed spam
const RSS_SAMPLE_INTERVAL_MS = 2000;
const RATE_WINDOW_SAMPLES = 6; // 3s trailing window - smooths per-sample jitter

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
  const windowStart = samples[Math.max(0, samples.length - 1 - RATE_WINDOW_SAMPLES)];
  const windowSpanSamples = Math.min(RATE_WINDOW_SAMPLES, samples.length - 1);
  const rateMbPerSec =
    windowSpanSamples > 0 && windowStart !== undefined
      ? (latestKb - windowStart) / 1024 / ((windowSpanSamples * RSS_SAMPLE_INTERVAL_MS) / 1000)
      : 0;

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

  const createAndStartSource = (offsetSeconds: number) => {
    const context = contextRef.current!;
    const buffer = bufferRef.current!;
    const source = context.createBufferSource({ pitchCorrection: false });
    source.buffer = buffer; // same AudioBuffer instance every time - never rebuilt
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    source.start(context.currentTime, offsetSeconds);
    currentRef.current = { source, gain };
  };

  const runRapidSeeks = async () => {
    if (!bufferRef.current || !contextCreated || running) return;
    setRunning(true);
    createAndStartSource(0);
    for (let i = 1; i <= SEEK_ITERATIONS; i++) {
      await delay(SEEK_INTERVAL_MS);
      const offset = Math.random() * (DURATION_SECONDS - 5);
      stopAndDisconnectCurrent();
      createAndStartSource(offset);
      setIteration(i);
    }
    stopAndDisconnectCurrent();
    setRunning(false);
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

        <Text style={styles.title}>react-native-audio-api native heap leak repro</Text>
        <Text style={styles.status}>{status}</Text>
        <Text style={styles.status}>Seek iteration: {iteration} / {SEEK_ITERATIONS}</Text>

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
          onPress={() => void runRapidSeeks()}
          disabled={!contextCreated || running}>
          <Text style={styles.buttonText}>
            {running ? 'Running…' : `Run ${SEEK_ITERATIONS} rapid seeks`}
          </Text>
        </Pressable>

        <Text style={styles.hint}>
          Each "seek" stops+disconnects the previous AudioBufferSourceNode/GainNode pair,
          then creates a new pair wrapping the SAME AudioBuffer and starts it at a random
          offset - the standard pattern for repositioning a one-shot source node. Against an
          unpatched library, RSS climbs by roughly the buffer's size on every seek and never
          comes back down. Repeat the run a few times to check: only the first run should add
          net growth once the fix is applied - see the file header for measurement gotchas.
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
