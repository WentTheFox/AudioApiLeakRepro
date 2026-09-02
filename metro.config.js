const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const projectRoot = __dirname;

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * react-native-audio-api's `api.ts` barrel re-exports its optional
 * Audio/AudioControls convenience UI (unused by this repro - it imports
 * AudioContext directly), and that subtree unconditionally imports
 * react-native-reanimated and react-native-gesture-handler. Rather than
 * pull in two real native libraries (and their own native rebuilds) just
 * to satisfy an import Metro must resolve but this app never executes,
 * both are stubbed - see metro-stubs/ for why.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    extraNodeModules: {
      'react-native-reanimated': path.resolve(projectRoot, 'metro-stubs/react-native-reanimated.js'),
      'react-native-gesture-handler': path.resolve(projectRoot, 'metro-stubs/react-native-gesture-handler.js'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
