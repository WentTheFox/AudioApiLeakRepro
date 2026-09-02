// Stub for Metro resolution only. react-native-audio-api's `api.ts` barrel
// re-exports its optional Audio/AudioControls convenience UI (which we
// don't use - our AudioEngine adapter imports AudioContext directly), and
// that subtree unconditionally imports react-native-reanimated. Rather than
// pull in a real native animation library (and its own native rebuild) just
// to satisfy an import Metro must resolve but this app never executes, this
// stub exists so bundling succeeds; nothing here needs to actually animate.
const DummyComponent = () => null;

exports.__esModule = true;
exports.default = new Proxy({}, { get: () => DummyComponent });
exports.useAnimatedRef = () => ({ current: null });
exports.useSharedValue = (initial) => ({ value: initial });
exports.useAnimatedStyle = () => ({});
exports.withTiming = (value) => value;
exports.withSpring = (value) => value;
exports.runOnJS = (fn) => fn;
