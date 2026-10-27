// Tests for desktop/adapter.js, the script the app injects before the page.
// It runs here in jsdom with a fake __TAURI_INTERNALS__.invoke that records
// each app command, so the adapter's own rules are checked: its objects are
// fixed, each call becomes one command, the quit sequence waits for the page
// (at most 1.8 s), then for the storage to answer (at most 0.4 s) and for
// WebKit's commit (0.7 s), the app's question whether a quit would lose text
// is answered by the page's callback (D-48), and a right click shows no menu
// outside the text fields. The commands themselves are tested by the app tests.
//
// Run from the repository root: node desktop/tests/adapter.mjs   (exit code 0
// only when every test passes)

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTER = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapter.js'), 'utf8');
const unhandled = [];
process.on('unhandledRejection', (err) => { unhandled.push(String(err && err.message ? err.message : err)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A window with the adapter in it. answers maps a command to a function that
// gives its result (or throws); every call is recorded with its time, and so
// is each storage estimate (estimate gives its answer; storage: false leaves
// navigator.storage out).
function load(answers = {}, { estimate = () => Promise.resolve({ usage: 0, quota: 1 }), storage = true } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const calls = [];
  const t0 = Date.now();
  if (storage) {
    Object.defineProperty(dom.window.navigator, 'storage', {
      value: { estimate: () => { calls.push({ cmd: 'estimate', at: Date.now() - t0 }); return estimate(); } }
    });
  }
  dom.window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      calls.push({ cmd, args, at: Date.now() - t0 });
      const answer = answers[cmd];
      return new dom.window.Promise((resolve, reject) => {
        try { resolve(answer ? answer(args) : null); } catch (err) { reject(err); }
      });
    }
  };
  dom.window.eval(ADAPTER);
  return { window: dom.window, native: dom.window.PlainSightNative, calls, close: () => dom.window.close() };
}
const quitCalls = (calls) => calls.filter((c) => c.cmd === 'quit_ready');
const commandCalls = (calls) => calls.filter((c) => c.cmd !== 'estimate');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the adapter and the quit hook can be neither replaced nor deleted, and the adapter cannot be changed', () => {
  const a = load();
  try {
    const native = a.window.PlainSightNative;
    const quit = a.window.__plainSightQuit;
    a.window.eval(`window.PlainSightNative = { pickFolder: () => 'swapped' }; window.__plainSightQuit = () => 'swapped';
      delete window.PlainSightNative; delete window.__plainSightQuit;
      try { window.PlainSightNative.pickFolder = () => 'swapped'; } catch (e) {}`);
    assert.equal(a.window.PlainSightNative, native, 'the same adapter object');
    assert.equal(a.window.__plainSightQuit, quit, 'the same quit hook');
    assert.equal(Object.isFrozen(native), true, 'the adapter is frozen');
    for (const name of ['PlainSightNative', '__plainSightQuit']) {
      const d = Object.getOwnPropertyDescriptor(a.window, name);
      assert.deepEqual([d.writable, d.configurable, d.enumerable], [false, false, false], name);
    }
    assert.throws(() => a.window.eval(`'use strict'; window.PlainSightNative = {};`), /read only|read-only|Cannot assign/);
  } finally { a.close(); }
});

test('each call becomes exactly one app command, with the arguments the app expects', async () => {
  const a = load({ pick_folder: () => ({ name: 'Notes' }), saved_folder: () => null, forget_folder: () => 'ignored', write_text_file: () => '2026-10-21 10-00-00 (2).docx', save_download: () => 'moment (2).txt' });
  try {
    assert.deepEqual(await a.native.pickFolder(), { name: 'Notes' });
    assert.equal(await a.native.savedFolder(), null);
    assert.equal(await a.native.forgetFolder(), undefined, 'forgetFolder answers nothing');
    assert.equal(await a.native.writeTextFile('2026-10-21 10-00-00', '.docx', 'the real text'), '2026-10-21 10-00-00 (2).docx');
    assert.equal(await a.native.saveDownload('moment.txt', 'the real text'), 'moment (2).txt');
    // The arguments were made in the page's realm; copied, they compare by value.
    assert.deepEqual(commandCalls(a.calls).map((c) => [c.cmd, c.args === undefined ? undefined : { ...c.args }]), [
      ['pick_folder', undefined],
      ['saved_folder', undefined],
      ['forget_folder', undefined],
      ['write_text_file', { base: '2026-10-21 10-00-00', ext: '.docx', text: 'the real text' }],
      ['save_download', { name: 'moment.txt', text: 'the real text' }]
    ]);
    assert.deepEqual(Object.keys(a.native).sort(), ['forgetFolder', 'onQuit', 'onUnsavedText', 'pickFolder', 'saveDownload', 'savedFolder', 'writeTextFile']);
  } finally { a.close(); }
});

test('a cancelled save panel reaches the page as null, not as a name', async () => {
  const a = load({ save_download: () => null });
  try {
    assert.equal(await a.native.saveDownload('2026-10-21 10-00-00.txt', 'the real text'), null);
  } finally { a.close(); }
});

test('a failed command reaches the page as a failure', async () => {
  const a = load({ write_text_file: () => { throw new Error('Could not write the file'); }, save_download: () => { throw new Error('Could not save the file'); } });
  try {
    await assert.rejects(a.native.writeTextFile('2026-10-21 10-00-00', '.txt', 'x'), /Could not write the file/);
    await assert.rejects(a.native.saveDownload('moment.txt', 'x'), /Could not save the file/);
  } finally { a.close(); }
});

// The time the quit hook took for one page callback. A hook that has not
// finished after 5 s counts as 5 s, so a test fails on its own assertion
// instead of waiting for ever.
async function timedQuit(a, callback) {
  if (callback !== undefined) a.native.onQuit(callback);
  const t0 = Date.now();
  await Promise.race([a.window.__plainSightQuit(), sleep(5000)]);
  return Date.now() - t0;
}

test('quitting waits for the page\'s callback, then for the storage to answer, then 0.7 s for WebKit\'s commit, and says quit_ready once', async () => {
  const a = load();
  try {
    let pageDone = -1;
    const t0 = Date.now();
    await timedQuit(a, () => sleep(300).then(() => { pageDone = Date.now() - t0; }));
    const q = quitCalls(a.calls);
    const e = a.calls.filter((c) => c.cmd === 'estimate');
    assert.equal(q.length, 1, 'quit_ready once');
    assert.equal(e.length, 1, 'one storage estimate');
    assert.ok(e[0].at >= pageDone - 5, 'the estimate only after the page was done: ' + e[0].at + ' ms, page done at ' + pageDone + ' ms');
    assert.ok(q[0].at >= pageDone + 690, 'quit_ready 0.7 s after the page and the storage: ' + q[0].at + ' ms, page done at ' + pageDone + ' ms');
    assert.ok(q[0].at < pageDone + 1100, 'and not much later: ' + q[0].at + ' ms');
  } finally { a.close(); }
});

test('a page callback that never finishes gets 1.8 s, and the quit still ends inside the app\'s 4 s safety timer', async () => {
  const a = load();
  try {
    a.native.onQuit(() => new Promise(() => {}));
    const t0 = Date.now();
    const done = a.window.__plainSightQuit();
    await sleep(1700);
    assert.equal(a.calls.length, 0, 'still waiting for the page at 1.7 s');
    await Promise.race([done, sleep(3300)]);
    const waited = Date.now() - t0;
    assert.equal(quitCalls(a.calls).length, 1);
    assert.ok(waited >= 2450 && waited < 2950, 'quit_ready after about 1.8 + 0.7 s, not ' + waited + ' ms');
  } finally { a.close(); }
});

test('the storage gets 0.4 s to answer: a slow answer is awaited, a missing one is not, and no storage estimate at all still waits for the commit', async () => {
  const slow = load({}, { estimate: () => sleep(250).then(() => ({})) });
  const never = load({}, { estimate: () => new Promise(() => {}) });
  const broken = load({}, { estimate: () => { throw new Error('no storage manager'); } });
  const none = load({}, { storage: false });
  try {
    const ms = { slow: await timedQuit(slow), never: await timedQuit(never), broken: await timedQuit(broken), none: await timedQuit(none) };
    assert.ok(ms.slow >= 940 && ms.slow < 1400, 'a 0.25 s answer, then 0.7 s: ' + ms.slow + ' ms');
    assert.ok(ms.never >= 1090 && ms.never < 1550, 'at most 0.4 s, then 0.7 s: ' + ms.never + ' ms');
    assert.ok(ms.broken >= 690 && ms.broken < 1150, 'a failing estimate, then 0.7 s: ' + ms.broken + ' ms');
    assert.ok(ms.none >= 690 && ms.none < 1150, 'no navigator.storage, then 0.7 s: ' + ms.none + ' ms');
    for (const a of [slow, never, broken, none]) assert.equal(quitCalls(a.calls).length, 1, 'quit_ready once');
  } finally { for (const a of [slow, never, broken, none]) a.close(); }
});

test('a callback that throws or rejects is not waited for: the app may quit after the commit wait', async () => {
  for (const [how, callback] of [['throws', () => { throw new Error('page broke'); }], ['rejects', () => Promise.reject(new Error('page broke'))]]) {
    const a = load();
    try {
      const ms = await timedQuit(a, callback);
      assert.equal(quitCalls(a.calls).length, 1, how + ': quit_ready');
      assert.ok(ms >= 690 && ms < 1150, how + ': after the commit wait only, ' + ms + ' ms');
    } finally { a.close(); }
  }
  await sleep(50);
  assert.deepEqual(unhandled, [], 'no failure left unhandled');
});

test('without a callback, or with anything but a function, the app may quit after the commit wait', async () => {
  for (const given of [undefined, 'not a function', null, {}]) {
    const a = load();
    try {
      const ms = await timedQuit(a, given);
      assert.equal(quitCalls(a.calls).length, 1);
      assert.ok(ms >= 690 && ms < 1150, String(given) + ': ' + ms + ' ms');
    } finally { a.close(); }
  }
  const a = load();
  try {
    let ran = false;
    a.native.onQuit(() => { ran = true; });
    a.native.onQuit(null);   // ignored: the page's callback stays
    await a.window.__plainSightQuit();
    assert.equal(ran, true, 'a non-function does not replace the callback');
  } finally { a.close(); }
});

// The quit's longest path is the three waits in a row, measured by WebKit's
// timers, which run late on a loaded Mac; the app's safety timer is a precise
// thread sleep that ends the app regardless. Read from both files as text,
// so that a change to either side is caught here (D-42, Mac_PS_008).
test('the adapter\'s three waits leave the app\'s safety timer a full second of margin (D-42)', () => {
  const quitRs = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'src', 'quit.rs'), 'utf8');
  const safety = quitRs.match(/^const SAFETY: Duration = Duration::from_secs\((\d+)\);$/m);
  assert.ok(safety, 'quit.rs names its safety timer in whole seconds');
  const hook = ADAPTER.slice(ADAPTER.indexOf("fixed('__plainSightQuit'"), ADAPTER.indexOf('// A right click'));
  assert.ok(hook.length > 0, 'the quit hook was found in adapter.js');
  const waits = [...hook.matchAll(/wait\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.equal(waits.length, 3, 'the page callback, the storage answer and the commit wait: ' + waits.join(', '));
  const longest = waits.reduce((a, b) => a + b, 0);
  assert.ok(longest + 1000 <= Number(safety[1]) * 1000, 'the waits take ' + longest + ' ms at most, which leaves less than 1000 ms before the ' + safety[1] + ' s safety timer');
});

// The quit's answer timer (D-48, DISH-G-37): quit.rs's ASK is read as text,
// as SAFETY is above, and held to 1.5 s, the figure the README's quit bullet
// and the quit.rs header state together with the two timers' sum (DM-237 b:
// before this test, ASK set to 15 s passed every suite).
test('the quit\'s answer timer is 1.5 s in quit.rs, and the README and the quit.rs header state that figure and its sum with the safety timer (DM-237 b)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const quitRs = readFileSync(path.join(here, '..', 'src-tauri', 'src', 'quit.rs'), 'utf8');
  const ask = quitRs.match(/^const ASK: Duration = Duration::from_millis\((\d+)\);$/m);
  assert.ok(ask, 'quit.rs names its answer timer in whole milliseconds');
  const safety = quitRs.match(/^const SAFETY: Duration = Duration::from_secs\((\d+)\);$/m);
  assert.ok(safety, 'quit.rs names its safety timer in whole seconds');
  const askSeconds = Number(ask[1]) / 1000;
  assert.equal(askSeconds, 1.5, 'the answer timer is 1.5 s (D-48)');
  const total = askSeconds + Number(safety[1]);
  const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The header is a wrapped //! comment: its lines are joined before the match.
  const header = quitRs.split('\n').filter((l) => l.startsWith('//!')).map((l) => l.replace(/^\/\/! ?/, '')).join(' ');
  assert.match(header, new RegExp(literal('is quit after the ' + askSeconds + '-second answer timer and then the ' + safety[1] + '-second safety timer, about ' + total + ' seconds in all')), 'the quit.rs header states both timers and their sum');
  const readme = readFileSync(path.join(here, '..', '..', 'README.md'), 'utf8');
  assert.match(readme, new RegExp(literal('the quit goes on after ' + askSeconds + ' seconds, and if it then never says it is done, the app\'s own timer ends it after ' + safety[1] + ' more seconds, so about ' + total + ' seconds in all')), 'the README\'s quit bullet states both timers and their sum');
});

// DM-237 (b), at the use: the pin above reads ASK's declaration, so a timer
// thread that slept a literal 15 s while ASK stayed 1.5 s passed every suite
// (the Delivery Manager's RM07b). The app's code in quit.rs, its tests left
// out, sleeps exactly twice: for ASK in ask()'s answer timer and for SAFETY
// in run_hook()'s safety timer.
test('quit.rs\'s two timers sleep for ASK and SAFETY themselves: ask()\'s answer timer and run_hook()\'s safety timer are the only sleeps in the app\'s code (DM-237 b; the Delivery Manager\'s RM07b)', () => {
  const quitRs = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'src', 'quit.rs'), 'utf8');
  const testsAt = quitRs.indexOf('\n#[cfg(test)]');
  assert.ok(testsAt > 0, 'quit.rs keeps its tests in a module at its end');
  const app = quitRs.slice(0, testsAt);
  assert.deepEqual([...app.matchAll(/std::thread::sleep\(([^;]*)\);/g)].map((m) => m[1]), ['ASK', 'SAFETY'], 'the only sleeps in the app\'s code, in this order');
  const body = (name) => {
    const at = app.indexOf('\nfn ' + name + '(');
    assert.ok(at >= 0, 'quit.rs has fn ' + name);
    return app.slice(at, app.indexOf('\n}\n', at));
  };
  assert.ok(body('ask').includes('    std::thread::spawn(move || {\n        std::thread::sleep(ASK);\n        answered(question, false);\n    });'), 'ask()\'s timer sleeps ASK, then counts the silence as nothing to lose');
  assert.ok(body('run_hook').includes('    std::thread::spawn(|| {\n        std::thread::sleep(SAFETY);\n        finish();\n    });'), 'run_hook()\'s timer sleeps SAFETY, then ends the app');
});

test('the app\'s question whether a quit would lose text is answered by the page\'s callback, and false without one or when it fails (D-48)', () => {
  const a = load();
  try {
    assert.equal(typeof a.window.__plainSightUnsaved, 'function', 'the app can ask');
    assert.equal(a.window.__plainSightUnsaved(), false, 'no callback: nothing to lose');
    for (const given of ['not a function', null, {}]) { a.native.onUnsavedText(given); assert.equal(a.window.__plainSightUnsaved(), false, String(given) + ' is ignored'); }
    a.native.onUnsavedText(() => true);
    assert.equal(a.window.__plainSightUnsaved(), true, 'the page says there is text to lose');
    a.native.onUnsavedText(() => 'yes');
    assert.equal(a.window.__plainSightUnsaved(), true, 'a truthy answer counts as true');
    a.native.onUnsavedText(() => false);
    assert.equal(a.window.__plainSightUnsaved(), false);
    a.native.onUnsavedText(() => { throw new Error('page broke'); });
    assert.equal(a.window.__plainSightUnsaved(), false, 'a failing callback never holds the quit');
    a.native.onUnsavedText(null);   // ignored: the callback stays
    assert.equal(a.window.__plainSightUnsaved(), false);
    const d = Object.getOwnPropertyDescriptor(a.window, '__plainSightUnsaved');
    assert.deepEqual([d.writable, d.configurable, d.enumerable], [false, false, false], 'the question cannot be replaced');
  } finally { a.close(); }
});

test('a quit_ready the app refuses (it is not quitting) is swallowed', async () => {
  const a = load({ quit_ready: () => { throw new Error('not quitting'); } });
  try {
    assert.equal(await a.window.__plainSightQuit(), undefined);
    await sleep(50);
    assert.deepEqual(unhandled, [], 'no failure left unhandled');
  } finally { a.close(); }
});

test('a right click shows no menu on the page; text fields keep theirs; checkboxes and buttons do not', () => {
  const a = load();
  try {
    const d = a.window.document;
    d.body.innerHTML = `<div id="cover"><p id="para">text</p></div><textarea id="area"></textarea><input id="plain"><input id="text" type="text">
      <input id="password" type="password"><input id="search" type="search"><input id="box" type="checkbox"><input id="radio" type="radio"><button id="button">Go</button>`;
    const fire = (id) => { const e = new a.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }); d.getElementById(id).dispatchEvent(e); return e.defaultPrevented; };
    const result = Object.fromEntries(['cover', 'para', 'area', 'plain', 'text', 'password', 'search', 'box', 'radio', 'button'].map((id) => [id, fire(id)]));
    assert.deepEqual(result, { cover: true, para: true, area: false, plain: false, text: false, password: false, search: false, box: true, radio: true, button: true });
    const e = new a.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    d.body.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true, 'the page body');
  } finally { a.close(); }
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log('ok   - ' + t.name);
  } catch (err) {
    failed += 1;
    console.log('FAIL - ' + t.name);
    console.log('       ' + String(err && err.stack ? err.stack : err).split('\n').join('\n       '));
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total. Errors: ${failed}`);
process.exit(failed ? 1 : 0);
