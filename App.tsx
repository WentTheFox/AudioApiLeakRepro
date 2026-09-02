/**
 * Minimal repro: repeatedly creating a fresh AudioBufferSourceNode + GainNode
 * pair that both wrap the SAME, already-built AudioBuffer - stopping and
 * disconnecting the previous pair before creating each new one, exactly the
 * "seek by tearing down and rebuilding the one-shot source" pattern the Web
 * Audio API requires - leaks native heap that disconnect() never releases.
 *
 * Tap "Run 60 rapid seeks" and watch the RSS counter/sparkline at the top:
 * it climbs continuously during the run and never comes back down, even
 * though every source+gain pair from prior iterations should be unreachable
 * from JS by the time the next one is created.
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

interface MemoryInfoNativeModule {
  getMemoryInfoKb(): Promise<{ rssKb: number }>;
}
const MemoryInfo = NativeModules.MemoryInfo as MemoryInfoNativeModule | undefined;

function useRssSamples(): { latestMb: number; peakMb: number; samples: number[] } {
  const [samples, setSamples] = useState<number[]>([]);
  const peakRef = useRef(0);

  useEffect(() => {
    if (!MemoryInfo) return;
    const interval = setInterval(() => {
      MemoryInfo!.getMemoryInfoKb()
        .then(({ rssKb }) => {
          if (rssKb < 0) return;
          if (rssKb > peakRef.current) peakRef.current = rssKb;
          setSamples((prev) => {
            const next = [...prev, rssKb];
            return next.length > 120 ? next.slice(next.length - 120) : next;
          });
        })
        .catch(() => {});
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const latestKb = samples[samples.length - 1] ?? 0;
  return { latestMb: latestKb / 1024, peakMb: peakRef.current / 1024, samples };
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
  const { latestMb, peakMb, samples } = useRssSamples();
  const [status, setStatus] = useState('Building silent 4-minute buffer…');
  const [iteration, setIteration] = useState(0);
  const [running, setRunning] = useState(false);

  const contextRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const currentRef = useRef<{ source: any; gain: any } | null>(null);

  useEffect(() => {
    const context = new AudioContext();
    contextRef.current = context;
    const buffer = context.createBuffer(CHANNELS, FRAME_COUNT, SAMPLE_RATE);
    const silence = new Float32Array(FRAME_COUNT); // all zeros
    for (let channel = 0; channel < CHANNELS; channel++) {
      buffer.copyToChannel(silence, channel);
    }
    bufferRef.current = buffer;
    setStatus('Ready.');
  }, []);

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
    if (!bufferRef.current || running) return;
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
          <View style={styles.sparkline}>
            {samples.map((kb, i) => {
              const max = Math.max(...samples, 1);
              const min = Math.min(...samples);
              const range = Math.max(max - min, 1);
              const heightFraction = (kb - min) / range;
              return (
                <View
                  key={i}
                  style={[styles.bar, { height: Math.max(2, heightFraction * 40) }]}
                />
              );
            })}
          </View>
        </View>

        <Text style={styles.title}>react-native-audio-api native heap leak repro</Text>
        <Text style={styles.status}>{status}</Text>
        <Text style={styles.status}>Seek iteration: {iteration} / {SEEK_ITERATIONS}</Text>

        <Pressable
          style={[styles.button, running && styles.buttonDisabled]}
          onPress={() => void runRapidSeeks()}
          disabled={running}>
          <Text style={styles.buttonText}>
            {running ? 'Running…' : `Run ${SEEK_ITERATIONS} rapid seeks`}
          </Text>
        </Pressable>

        <Text style={styles.hint}>
          Each "seek" stops+disconnects the previous AudioBufferSourceNode/GainNode pair,
          then creates a new pair wrapping the SAME AudioBuffer and starts it at a random
          offset - the standard pattern for repositioning a one-shot source node. Watch RSS
          above: it climbs during the run and never drops back down.
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
    marginBottom: 4,
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
