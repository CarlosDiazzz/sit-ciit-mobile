const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Run the component against a native player that becomes invalid on unmount.
// Reproduces Expo's release-before-component-cleanup ordering from the crash.
function mount({ delayMode = false, rejectMode = false } = {}) {
  const effects = [];
  const state = [];
  let released = false, playing = false, closes = 0;
  let resolveMode;
  const mode = delayMode ? new Promise(resolve => { resolveMode = resolve; }) : rejectMode ? Promise.reject(new Error('Audio unavailable')) : Promise.resolve();
  const player = {
    set loop(value) { assert.equal(released, false, 'loop touched a released player'); },
    play() { assert.equal(released, false, 'play touched a released player'); playing = true; },
    pause() { assert.equal(released, false, 'pause touched a released player'); playing = false; },
  };
  const jsx = (type, props) => ({ type, props });
  const imports = {
    react: { useEffect: fn => effects.push(fn), useRef: value => ({ current: value }), useState: value => [value, value => state.push(value)] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Image: 'Image', Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: value => value } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-audio': { useAudioPlayer: () => player, setAudioModeAsync: () => mode },
  };
  const source = ts.transpileModule(readFileSync('src/components/AlarmNotice.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => imports[name] ?? name });
  const tree = exports.default({ message: 'Impacto · Unidad U1', onDismiss: () => { closes++; } });
  const cleanups = effects.map(fn => fn());
  const unmount = () => { released = true; playing = false; cleanups.forEach(fn => fn?.()); };
  return { tree, state, unmount, dismiss: tree.props.onRequestClose, resolveMode: () => resolveMode(), get playing() { return playing; }, get closes() { return closes; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('silencing a playing alarm unmounts without touching the released native object', async () => {
  const alarm = mount();
  await settle();
  assert.equal(alarm.playing, true);
  alarm.dismiss();
  alarm.dismiss();
  assert.equal(alarm.closes, 1);
  assert.doesNotThrow(alarm.unmount);
  assert.equal(alarm.playing, false);
});
test('closing before audio setup completes never starts playback', async () => {
  const alarm = mount({ delayMode: true });
  alarm.dismiss();
  alarm.resolveMode();
  await settle();
  assert.equal(alarm.playing, false);
  alarm.unmount();
});
test('replacing the alarm during pending audio setup never accesses released audio', async () => {
  const old = mount({ delayMode: true });
  old.unmount();
  old.resolveMode();
  const next = mount();
  await settle();
  assert.equal(old.playing, false);
  assert.equal(next.playing, true);
  next.unmount();
});
test('audio setup failure remains dismissible', async () => {
  const alarm = mount({ rejectMode: true });
  await settle();
  assert.equal(alarm.state[0], true);
  assert.doesNotThrow(alarm.dismiss);
  alarm.unmount();
});
test('alarm covers the display with red and provides a white dismiss button', () => {
  const { tree, unmount } = mount();
  assert.equal(tree.props.presentationStyle, 'fullScreen');
  assert.equal(tree.props.transparent, undefined);
  assert.equal(tree.props.statusBarTranslucent, true);
  assert.equal(tree.props.navigationBarTranslucent, true);
  const screen = tree.props.children;
  assert.equal(screen.props.style.backgroundColor, '#C62828');
  const notice = screen.props.children.props.children;
  const button = notice.props.children.find(node => node.type === 'Pressable');
  assert.equal(button.props.style({ pressed: false })[0].backgroundColor, '#FFF');
  assert.match(notice.props.children[0].props.source, /danger-white.png$/);
  unmount();
});
