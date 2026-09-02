// Stub for Metro resolution only - see react-native-reanimated.js in this
// same directory for why. Same unused Audio/ subtree, same reasoning.
const chainable = new Proxy(function chainable() {
  return chainable;
}, {
  get: () => chainable,
});

exports.__esModule = true;
exports.Gesture = chainable;
exports.GestureDetector = (props) => (props && props.children) || null;
exports.GestureHandlerRootView = (props) => (props && props.children) || null;
