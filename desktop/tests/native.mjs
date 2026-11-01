// Tests for the desktop app's branch of the engine. They run the real
// index.html in jsdom with a fake window.PlainSightNative, the adapter the
// desktop app injects before the page, and check that the page uses it for
// the folder, shows the app's wording and erases itself when the app quits.
// The adapter itself (the Rust side) is tested by the app tests.
//
// Run from the repository root: node desktop/tests/native.mjs   (exit code 0
// only when every test passes)

import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// A promise the page leaves rejected is recorded, not fatal, so a test that
// expects a toast still reports its own assertion.
const unhandled = [];
process.on('unhandledRejection', (err) => { unhandled.push(String(err && err.message ? err.message : err)); });
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits until fn() holds, for at most ms.
async function until(fn, what, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error('timed out after ' + ms + ' ms waiting for ' + what);
}
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/;

// A fake adapter with the same surface as desktop/adapter.js. It records
// every call; files is the set of names already in the folder, so the
// counter rule can be checked from the page's side.
//
// Continue (folder.rs: list_notes, read_note): notes holds the folder's notes
// as [name, text], newest first; every Save through writeTextFile puts its
// file first, as the app's listing would order it. listNotes and readNote
// answer as the app does: a failure is a plain string, which is what Tauri's
// invoke rejects with for a command's Err (tauri 2.12.4, scripts/core.js),
// and a .docx is refused with the app's own words.
const WORD_REFUSED = 'The newest note is a Word file, which the app cannot read; save as .txt or .md to continue here';
function fakeNative({ saved = null, pick = { name: 'Build_Test_1' }, failPick = false, failForget = false, failWrite = false, failDownload = false, cancelDownload = false, downloadAnswer = null, writeGate = null, downloadGate = null, notes = [], failList = null, failRead = null, listGate = null } = {}) {
  const calls = [];
  const files = new Set();
  const held = notes.map(([name, text]) => [name, text]);
  let quit = null;
  let unsaved = null;
  let folder = saved;
  return {
    calls,
    files,
    quit: () => quit(),
    hasQuit: () => typeof quit === 'function',
    // The app's question before a quit (D-48), as the adapter asks it.
    unsaved: () => Boolean(unsaved && unsaved()),
    api: {
      pickFolder: async () => { calls.push(['pickFolder']); if (failPick) throw new Error('Could not remember the folder'); if (pick) folder = pick; return pick; },
      savedFolder: async () => { calls.push(['savedFolder']); return folder; },
      // As the app does (folder.rs): a failed forget changes nothing, on disk or in memory (DM-220).
      forgetFolder: async () => { calls.push(['forgetFolder']); if (failForget) throw new Error('Could not forget the folder'); folder = null; },
      writeTextFile: async (base, ext, text) => {
        calls.push(['writeTextFile', base, ext, text]);
        if (writeGate) await writeGate;   // a write still under way, until the test lets it land
        if (failWrite) throw new Error('disk full');
        let name = base + ext;
        for (let n = 2; files.has(name); n++) name = base + ' (' + n + ')' + ext;
        files.add(name);
        held.unshift([name, text]);
        return name;
      },
      listNotes: async () => {
        calls.push(['listNotes']);
        if (listGate) await listGate;   // the listing still under way, until the test lets it answer
        if (failList) throw failList;
        return held.map(([name]) => name);
      },
      readNote: async (name) => {
        calls.push(['readNote', name]);
        if (failRead) throw failRead;
        if (name.endsWith('.docx')) throw WORD_REFUSED;
        const note = held.find(([n]) => n === name);
        if (!note) throw 'That is not a note the app wrote';
        return note[1];
      },
      // As the app does (folder.rs): the save panel's name, or null when it was cancelled (D-49).
      saveDownload: async (name, text) => {
        calls.push(['saveDownload', name, text]);
        if (downloadGate) await downloadGate;   // the save panel still open, until the test lets it answer
        if (failDownload) throw new Error('Could not save the file: Operation not permitted');
        if (cancelDownload) return null;
        return downloadAnswer || name;
      },
      onQuit: (callback) => { calls.push(['onQuit']); quit = callback; },
      onUnsavedText: (callback) => { calls.push(['onUnsavedText']); unsaved = callback; }
    }
  };
}

// onDerive, given a function, runs before every key derivation the page asks
// for (and is awaited), so a test can count derivations or slow one down.
function cryptoWith(onDerive) {
  if (!onDerive) return webcrypto;
  return {
    getRandomValues: (a) => webcrypto.getRandomValues(a),
    subtle: {
      importKey: (...a) => webcrypto.subtle.importKey(...a),
      deriveKey: async (...a) => { await onDerive(); return webcrypto.subtle.deriveKey(...a); },
      encrypt: (...a) => webcrypto.subtle.encrypt(...a),
      decrypt: (...a) => webcrypto.subtle.decrypt(...a)
    }
  };
}
async function loadPage({ native = null, storage = {}, html = HTML, onDerive = null } = {}) {
  const errors = [];
  const downloads = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.Math.random = () => 1;   // no simulated typos
      Object.defineProperty(window, 'crypto', { value: cryptoWith(onDerive), configurable: true });
      window.URL.createObjectURL = (blob) => { downloads.push({ blob, name: null }); return 'blob:http://localhost/' + downloads.length; };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () { const d = downloads[downloads.length - 1]; if (d) d.name = this.download; };
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
      if (native) Object.defineProperty(window, 'PlainSightNative', { value: Object.freeze(native.api), configurable: false });
    }
  });
  const w = dom.window;
  const d = w.document;
  const $ = (sel) => d.querySelector(sel);
  // jsdom does not run module scripts: hand the page its cover the way the
  // page's loader does, and answer its requests for another cover.
  const cover = async (id) => (await import(pathToFileURL(path.join(ROOT, 'covers', id + '.js')).href)).default;
  d.addEventListener('plainsight:select', async (e) => w.PlainSight.setCover(await cover(e.detail.id)));
  w.PlainSight.setCover(await cover(w.PlainSight.selectedCoverId()));
  await w.PlainSight.ready;
  await sleep(0);
  const page = {
    w, d, $, errors, downloads,
    press(key, init = {}) {
      const ev = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      (d.activeElement || d.body).dispatchEvent(ev);
    },
    type(str) { for (const ch of str) page.press(ch); },
    async real() {
      page.press('G', { ctrlKey: true, shiftKey: true });
      const text = $('#real').textContent;
      page.press('G', { ctrlKey: true, shiftKey: true });
      return text;
    },
    toast: () => $('#toast').textContent,
    start() { $('#btn-start').click(); },
    async settle(ms = 30) { await sleep(ms); },
    close() { w.close(); }
  };
  return page;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// The page with one line added after the declaration of the quit question's
// mark, so a test can read the mark through the window: a count of edits, or
// null. Only the tests load it; the page itself has no such line, and nothing
// on window reads its state (README, "Your text is one variable in memory").
const MARK = '  let savedAt = null;\n';
function withMarkReader() {
  assert.equal(HTML.split(MARK).length, 2, 'index.html declares the mark once: ' + JSON.stringify(MARK));
  return HTML.replace(MARK, MARK + '  window.__testSavedAt = () => savedAt;\n');
}

// The page's Open button, as the file panel would answer it.
function chooseFile(p, file) {
  const input = p.$('#file-input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new p.w.Event('change', { bubbles: true }));
}
const pick = (p, group, value) => {
  const radio = p.$('input[name="' + group + '"][value="' + value + '"]');
  radio.checked = true;
  radio.dispatchEvent(new p.w.Event('change', { bubbles: true }));
};

test('the fake adapter has exactly the calls of desktop/adapter.js, so these tests drive the surface the app gives the page', () => {
  const adapter = readFileSync(path.join(ROOT, 'desktop', 'adapter.js'), 'utf8');
  const block = adapter.slice(adapter.indexOf("fixed('PlainSightNative', Object.freeze({"), adapter.indexOf('}));'));
  const calls = [...block.matchAll(/^    (\w+): /gm)].map((m) => m[1]).sort();
  assert.deepEqual(calls, ['forgetFolder', 'listNotes', 'onQuit', 'onUnsavedText', 'pickFolder', 'readNote', 'saveDownload', 'savedFolder', 'writeTextFile']);
  assert.deepEqual(Object.keys(fakeNative().api).sort(), calls);
});

test('without the adapter the page keeps its browser wording and registers nothing', async () => {
  const p = await loadPage();
  try {
    assert.match(p.$('#vault-on').parentElement.textContent, /in this browser/);
    assert.match(p.$('#folder-note').textContent, /Folder access exists in Chrome/);
    assert.doesNotMatch(p.$('#folder-note').textContent, /The phrase stops a guess/, 'the folder half of Continue is the app\'s: the web page does not speak of it');
    assert.ok(p.d.querySelectorAll('[data-app]').length >= 6, 'the app wording is carried in data-app attributes');
    assert.match(p.$('#intro').textContent, /download/i, 'on the web the intro speaks of downloads');
    assert.equal(p.$('#folder-status').textContent, 'Save downloads an encrypted .sight file.');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

// A browser's tab, which the intro may never name in the app: the word tab or
// tabs, in any case, once each key chord that ends in Tab (Option+Shift+Tab,
// Shift+Tab) is taken out, since those name the Tab key (PO-GUI-1, round 18;
// e2e.mjs and native.mjs hold the same rule, and config.mjs compares them).
const namesATab = (text) => /\btabs?\b/i.test(text.replace(/\b(?:(?:Cmd|Command|Ctrl|Control|Option|Alt|Shift)\s*\+\s*)+Tab\b/gi, ''));
test('the intro\'s tab rule refuses a browser\'s tab in any case and allows a key chord that ends in Tab (PO-GUI-1)', () => {
  for (const words of ['Option+Shift+Tab to the button', 'Shift+Tab alone when Keyboard navigation is on', 'Option + Shift + Tab', 'a stable table', 'Cmd + Shift + H'])
    assert.equal(namesATab(words), false, JSON.stringify(words) + ' names no tab');
  for (const words of ['in a new tab', 'Close the Tab', 'TABS', 'every tab of the browser', 'Shift+Tab, then close the tab', 'tab'])
    assert.equal(namesATab(words), true, JSON.stringify(words) + ' names a tab');
});

test('with the adapter the folder box offers the system picker, no browser help, and the app wording', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    await p.settle();
    assert.equal(p.$('#btn-folder').hidden, false, 'the folder button shows in the app');
    assert.equal(p.$('#folder-help').hidden, true, 'no browser-specific help in the app');
    assert.equal(p.$('#folder-note').textContent.includes('Chrome'), false, 'the browser sentence is gone');
    assert.match(p.$('#folder-note').textContent, /straight into that folder\. Plain means anyone who can open the file can read it, and the computer indexes, previews and backs it up like any document; a synced folder uploads it\.\s+The phrase stops a guess at the keyboard\. It does not lock the files: anyone who can open the folder, or who presses Open and picks a file, can read a plain note\.$/);   // main 1.3.10's wording (Web_PS_011), the browser's sentence emptied in the app, then the app's sentence on what the phrase does and does not do (Continue)
    assert.match(p.$('#vault-on').parentElement.textContent, /Save my text on this computer, encrypted/);
    assert.match(p.$('#intro').textContent, /Nothing you type leaves this app/);
    assert.match(p.$('#intro').textContent, /Closing the window or quitting erases the hidden text/);
    assert.match(p.$('#intro').textContent, /clears itself after 10 minutes with its window minimized or hidden/);
    assert.match(p.$('#intro').textContent, /Stored only on this computer\./);
    assert.equal(p.$('#intro').textContent.includes('browser'), false, 'no sentence of the intro mentions a browser');
    assert.equal(namesATab(p.$('#intro').textContent), false, 'no sentence of the intro mentions a tab, a key chord that ends in Tab aside');
    // In the app Save opens a save panel with no folder chosen, or writes straight into the chosen folder: nothing is downloaded (QA-G-23).
    assert.equal(/download/i.test(p.$('#intro').textContent), false, 'no sentence of the intro, its labels included, mentions a download');
    assert.match(p.$('#intro').textContent, /Save opens a save panel and writes your text where you put it, as a \.sight file encrypted with AES-256-GCM/);
    assert.match(p.$('#intro').textContent, /With a folder chosen below, Save writes a plain file straight into it\. Open restores it/);
    assert.equal(p.$('#folder-status').textContent, 'Save opens a save panel for an encrypted .sight file.');
    assert.deepEqual([...p.d.querySelectorAll('input[name="save-mode"]')].map((r) => r.parentElement.textContent.trim()), ['An encrypted .sight file (asks for a password)', 'A plain .txt file named by the moment, no password', 'A Markdown .md file named by the moment, no password', 'A Word .docx file named by the moment, no password']);
    assert.deepEqual(native.calls.filter((c) => c[0] === 'onQuit').length, 1, 'the quit hook is registered once');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('choosing a folder and pressing Save writes the text through the adapter, named by the moment, no password', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    p.start();
    p.type('first line of the real text');
    p.$('#btn-help').click();
    p.$('#btn-folder').click();
    await p.settle();
    assert.equal(p.toast(), 'Save now writes into Build_Test_1');
    assert.equal(p.$('#folder-status').textContent, 'Save writes a plain text file into the folder "Build_Test_1".');
    assert.equal(p.$('#btn-folder-forget').hidden, false);
    assert.equal(native.calls.filter((c) => c[0] === 'forgetFolder').length, 0, 'a picked folder is kept, not forgotten');
    p.start();
    p.$('#btn-save').click();
    await p.settle();
    const writes = native.calls.filter((c) => c[0] === 'writeTextFile');
    assert.equal(writes.length, 1);
    assert.match(writes[0][1], STAMP, 'the base name is the moment of the click, without the extension');
    assert.equal(writes[0][2], '.txt', '.txt unless another format is picked');
    assert.equal(writes[0][3], 'first line of the real text');
    assert.equal(p.toast(), 'Saved ' + writes[0][1] + '.txt in Build_Test_1');
    assert.equal(p.$('#pw').hidden, true, 'no password is asked');
    assert.equal(p.downloads.length, 0, 'nothing is downloaded');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('two saves in the same second keep both files: the adapter\'s counter name reaches the toast', async () => {
  const native = fakeNative({ saved: { name: 'Notes' } });
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    p.type('same second');
    p.$('#btn-save').click();
    p.$('#btn-save').click();
    await p.settle();
    const writes = native.calls.filter((c) => c[0] === 'writeTextFile');
    assert.equal(writes.length, 2);
    assert.equal(writes[0][1], writes[1][1], 'both saves carry the same moment');
    assert.equal(p.toast(), 'Saved ' + writes[0][1] + ' (2).txt in Notes');
    assert.deepEqual([...native.files], [writes[0][1] + '.txt', writes[0][1] + ' (2).txt']);
  } finally { p.close(); }
});

test('a folder remembered by the app is used after a relaunch, without asking again', async () => {
  const native = fakeNative({ saved: { name: 'Build_Test_1' } });
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    assert.ok(native.calls.some((c) => c[0] === 'savedFolder'));
    p.type('after a relaunch');
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(native.calls.filter((c) => c[0] === 'pickFolder').length, 0, 'no picker');
    assert.equal(native.calls.filter((c) => c[0] === 'writeTextFile').length, 1);
    assert.match(p.toast(), /^Saved \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt in Build_Test_1$/);
  } finally { p.close(); }
});

test('a cancelled picker changes nothing and forgets nothing', async () => {
  const native = fakeNative({ saved: { name: 'Kept' }, pick: null });
  const p = await loadPage({ native });
  try {
    await p.settle();
    const before = p.$('#folder-status').textContent;
    p.$('#btn-folder').click();
    await p.settle();
    assert.equal(p.$('#folder-status').textContent, before);
    assert.equal(native.calls.filter((c) => c[0] === 'forgetFolder').length, 0, 'the remembered folder is not forgotten');
    assert.equal(p.toast(), '', 'no toast');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a folder the app could not keep says so and changes nothing', async () => {
  const native = fakeNative({ saved: { name: 'Kept' }, failPick: true });
  const p = await loadPage({ native });
  try {
    await p.settle();
    const before = p.$('#folder-status').textContent;
    p.$('#btn-folder').click();
    await p.settle();
    assert.equal(p.toast(), 'Could not use that folder');
    assert.equal(p.$('#folder-status').textContent, before, 'the status still names the folder in use');
    assert.equal(native.calls.filter((c) => c[0] === 'forgetFolder').length, 0);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('when the app cannot forget the folder, the page says so and keeps using it, so Save and the screen agree', async () => {
  const native = fakeNative({ saved: { name: 'Build_Test_1' }, failForget: true });
  const p = await loadPage({ native });
  try {
    await p.settle();
    p.start();
    p.type('still in the folder');
    p.$('#btn-help').click();
    const before = p.$('#folder-status').textContent;
    p.$('#btn-folder-forget').click();
    await p.settle();
    assert.equal(p.toast(), 'Could not stop using the folder');
    assert.equal(p.$('#folder-status').textContent, before, 'the status still names the folder');
    assert.equal(p.$('#btn-folder-forget').hidden, false, 'the button to stop is still there');
    p.start();
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(p.$('#pw').hidden, true, 'no password: Save still writes into the folder');
    assert.equal(native.calls.filter((c) => c[0] === 'writeTextFile').length, 1, 'the text went into the folder');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('"Stop using the folder" forgets it in the app and Save goes through the save panel again', async () => {
  const native = fakeNative({ saved: { name: 'Build_Test_1' } });
  const p = await loadPage({ native });
  try {
    await p.settle();
    p.start();
    p.type('back to the download');
    p.$('#btn-help').click();
    p.$('#btn-folder-forget').click();
    await p.settle();
    assert.equal(native.calls.filter((c) => c[0] === 'forgetFolder').length, 1);
    assert.equal(p.toast(), 'Save opens a save panel for an encrypted file again');
    assert.equal(p.$('#folder-status').textContent, 'Save opens a save panel for an encrypted .sight file.');
    p.start();
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(p.$('#pw').hidden, false, 'Save asks for a password for the panel\'s file again');
    assert.equal(native.calls.filter((c) => c[0] === 'writeTextFile').length, 0);
  } finally { p.close(); }
});

test('a failed write shows a toast and keeps the text', async () => {
  const native = fakeNative({ saved: { name: 'Full' }, failWrite: true });
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    p.type('not lost');
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(p.toast(), 'Could not write to the folder');
    assert.equal(await p.real(), 'not lost');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

// The app asks before it quits whether a quit would lose text (D-48): yes
// with text on the page and no vault open, no otherwise.
test('the page answers the app\'s question before a quit: text to lose only when text is on the page and no vault keeps it (D-48)', async () => {
  const native = fakeNative();
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    assert.equal(native.calls.filter((c) => c[0] === 'onUnsavedText').length, 1, 'the answer is registered once');
    assert.equal(native.unsaved(), false, 'an empty page has nothing to lose');
    p.type('words a quit would lose');
    assert.equal(native.unsaved(), true, 'text on the page, no vault');
    p.press('Escape');
    assert.equal(native.unsaved(), false, 'Esc erased it');
    p.type('words the vault keeps');
    assert.equal(native.unsaved(), true);
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();
    await p.settle(600);   // the key derives and the vault opens
    assert.ok(p.d.body.classList.contains('vault-open'));
    assert.equal(native.unsaved(), false, 'an open vault keeps the text: nothing to lose');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

// After a successful Save or Open in the app the quit question answers false
// until the text changes, since a file on disk then holds that text too
// (DM-236); a keystroke or Backspace makes it true again, and so does typing
// back to the saved words, since the page counts its edits instead of
// keeping a copy of the saved text (QA-G-33: a needless question, the safe
// direction); a cancelled panel, a refused write and "Could not save" leave
// it true. The folder Save and the .sight Save through the panel are the
// Delivery Manager's AT-01 and AT-02 (dm-appstore-2783e5d/adv/dm-native-adv.mjs),
// adopted with the answer the fix sets: before it, both answered true, and
// the sheet said the text had not been saved right after "Saved".
test('in the app a successful Save or Open answers the quit question with false until the text changes; a cancelled panel, a refused write and a failed save keep it true (DM-236; AT-01, AT-02)', async () => {
  // AT-01: a folder Save.
  {
    const native = fakeNative({ saved: { name: 'Notes' } });
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
    try {
      await p.settle(50);
      p.type('words I just saved');
      assert.equal(native.unsaved(), true, 'before the Save: text to lose');
      p.$('#btn-save').click();
      await p.settle(80);
      assert.match(p.toast(), /^Saved .*\.txt in Notes$/, 'the folder write happened: ' + p.toast());
      assert.equal(native.unsaved(), false, 'after a successful folder Save nothing would be lost');
      p.press('Backspace');
      assert.equal(native.unsaved(), true, 'Backspace after the Save: the text differs from the file');
      p.type('d');
      assert.equal(native.unsaved(), true, 'typed back to the saved words, the text has still changed since the Save: the page counts edits, not the saved text, so a quit asks (QA-G-33)');
      p.type('!');
      assert.equal(native.unsaved(), true, 'one more keystroke: unsaved again');
      p.press('Escape');
      assert.equal(native.unsaved(), false, 'Esc cleared the page: nothing to lose, as before');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
  // A refused folder write keeps it true.
  {
    const native = fakeNative({ saved: { name: 'Notes' }, failWrite: true });
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
    try {
      await p.settle(50);
      p.type('not written');
      p.$('#btn-save').click();
      await p.settle(80);
      assert.equal(p.toast(), 'Could not write to the folder');
      assert.equal(native.unsaved(), true, 'a refused folder write keeps the text unsaved');
    } finally { p.close(); }
  }
  // A plain Save through the panel, then a cancelled one and a failed one.
  for (const [options, expected, toast] of [[{}, false, 'Saved 2'], [{ cancelDownload: true }, true, ''], [{ failDownload: true }, true, 'Could not save']]) {
    const native = fakeNative(options);
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1', 'plainSight.saveMode': 'txt' } });
    try {
      await p.settle(50);
      p.type('plain words');
      p.$('#btn-save').click();
      await p.settle(80);
      assert.ok(p.toast().startsWith(toast), JSON.stringify(options) + ': toast ' + JSON.stringify(p.toast()));
      assert.equal(native.unsaved(), expected, JSON.stringify(options) + ': the quit question');
      if (!expected) { p.type('x'); assert.equal(native.unsaved(), true, 'a keystroke after the panel Save: unsaved again'); }
    } finally { p.close(); }
  }
  // AT-02: the encrypted Save through the panel.
  {
    const native = fakeNative();
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
    try {
      await p.settle(50);
      p.type('words in a sight file');
      p.$('#btn-save').click();
      await p.settle(30);
      p.$('#pw-input').value = 'a long enough password';
      p.$('#pw-ok').click();
      await p.settle(900);
      assert.equal(p.toast(), 'Saved');
      assert.match(native.calls.find((c) => c[0] === 'saveDownload')[1], /\.sight$/);
      assert.equal(native.unsaved(), false, 'after a successful encrypted Save through the panel nothing would be lost');
      p.type('x');
      assert.equal(native.unsaved(), true);
    } finally { p.close(); }
  }
  // Open of a plain note, then of a .sight file.
  {
    const native = fakeNative();
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
    try {
      await p.settle(50);
      chooseFile(p, new p.w.File(['opened from a note'], 'note.txt', { type: 'text/plain' }));
      await p.settle(80);
      assert.equal(p.toast(), 'Opened');
      assert.equal(await p.real(), 'opened from a note');
      assert.equal(native.unsaved(), false, 'the text matches the opened file');
      p.type('!');
      assert.equal(native.unsaved(), true, 'a keystroke after the Open: unsaved again');
      p.press('Escape');
      chooseFile(p, await sightFile(p.w, 'opened from a sight file', 'a phrase for the file'));
      await p.settle(30);
      p.$('#pw-input').value = 'a phrase for the file';
      p.$('#pw-ok').click();
      await p.settle(900);
      assert.equal(p.toast(), 'Opened');
      assert.equal(await p.real(), 'opened from a sight file');
      assert.equal(native.unsaved(), false, 'the text matches the decrypted file');
      p.type('!');
      assert.equal(native.unsaved(), true);
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

// QA-G-31: in the app the page kept the text of the last successful Save or
// Open after Esc, the ten-minute wipe and the quit, since wipe() never
// cleared it, so a full copy of the last saved text stayed in the page's
// memory until the next Save, Open or the window closed. Since QA-G-33 the
// page keeps no lasting copy, only a count of its edits at the last Save or
// Open, which the wipe drops; the cases below keep their intent: after a
// wipe, the same words typed again are text a quit would lose (QA-01's
// repro: Save "abc", Esc, type "abc"; true is the answer the fix sets, false
// before it). A Save still being written when Esc comes marks nothing when it
// lands: the mark, read through the test's own copy of the page with one
// line added (withMarkReader), stays null. Through the question alone that
// rule cannot show, since the wipe also moves the count on.
test('in the app Esc, the ten-minute wipe and the quit keep no copy of the last saved text: the same words typed again would be lost, and a Save that lands after Esc marks nothing (QA-G-31)', async () => {
  const loaded = async (native, storage = {}, html = HTML) => {
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1', ...storage }, html });
    await p.settle(50);
    return p;
  };
  // QA-01's repro: a folder Save of "abc", Esc, then "abc" typed again.
  {
    const native = fakeNative({ saved: { name: 'Notes' } });
    const p = await loaded(native);
    try {
      p.type('abc');
      p.$('#btn-save').click();
      await p.settle(80);
      assert.match(p.toast(), /^Saved .*\.txt in Notes$/, 'the folder write happened: ' + p.toast());
      assert.equal(native.unsaved(), false, 'right after the Save nothing would be lost');
      p.press('Escape');
      assert.equal(native.unsaved(), false, 'Esc emptied the page');
      p.type('abc');
      assert.equal(native.unsaved(), true, 'after Esc the page keeps no copy of the saved text: the same words typed again are text a quit would lose');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
  // The ten-minute wipe, after a plain Save through the panel.
  {
    const native = fakeNative();
    const p = await loaded(native, { 'plainSight.saveMode': 'txt' });
    try {
      p.type('abc');
      p.$('#btn-save').click();
      await p.settle(80);
      assert.equal(native.unsaved(), false, 'right after the panel Save nothing would be lost');
      let now = p.w.Date.now();
      p.w.Date.now = () => now;
      const setHidden = (hidden) => {
        Object.defineProperty(p.d, 'hidden', { get: () => hidden, configurable: true });
        p.d.dispatchEvent(new p.w.Event('visibilitychange'));
      };
      setHidden(true);
      now += 10 * 60 * 1000 + 1000;
      setHidden(false);
      assert.equal(p.toast(), 'Cleared after 10 minutes in the background');
      p.type('abc');
      assert.equal(native.unsaved(), true, 'the ten-minute wipe dropped the copy with the text');
    } finally { p.close(); }
  }
  // The quit hook, which runs Esc before the app ends.
  {
    const native = fakeNative({ saved: { name: 'Notes' } });
    const p = await loaded(native);
    try {
      p.type('abc');
      p.$('#btn-save').click();
      await p.settle(80);
      assert.equal(native.unsaved(), false);
      await native.quit();
      p.type('abc');
      assert.equal(native.unsaved(), true, 'the quit\'s wipe dropped the copy too');
    } finally { p.close(); }
  }
  // A folder Save still being written when Esc comes: it lands after the wipe and marks nothing.
  {
    let land = null;
    const native = fakeNative({ saved: { name: 'Notes' }, writeGate: new Promise((resolve) => { land = resolve; }) });
    const p = await loaded(native, {}, withMarkReader());
    try {
      p.type('abc');
      p.$('#btn-save').click();
      await p.settle(30);
      assert.equal(native.calls.filter((c) => c[0] === 'writeTextFile').length, 1, 'the write is under way');
      p.press('Escape');
      land();
      await p.settle(80);
      assert.match(p.toast(), /^Saved .*\.txt in Notes$/, 'the write landed after Esc: ' + p.toast());
      assert.equal(p.w.__testSavedAt(), null, 'the folder Save that landed after Esc marked nothing');
      p.type('abc');
      assert.equal(native.unsaved(), true, 'a folder Save that lands after Esc keeps no copy of the text');
    } finally { p.close(); }
  }
  // A Save through the panel, plain and encrypted, whose panel is still open
  // when Esc comes: the file is written once the panel answers, and nothing
  // is kept. (The panel is held open here, since the key of an encrypted
  // Save derives in a few milliseconds on a fast Mac: a wait would let the
  // Save land before Esc.)
  for (const mode of ['txt', 'sight']) {
    let answer = null;
    const native = fakeNative({ downloadGate: new Promise((resolve) => { answer = resolve; }) });
    const p = await loaded(native, { 'plainSight.saveMode': mode }, withMarkReader());
    try {
      p.type('abc');
      p.$('#btn-save').click();
      if (mode === 'sight') {
        await p.settle(30);
        p.$('#pw-input').value = 'a long enough password';
        p.$('#pw-ok').click();
      }
      await until(() => native.calls.some((c) => c[0] === 'saveDownload'), 'the save panel, ' + mode);
      p.press('Escape');
      assert.equal(await p.real(), '', mode + ': Esc emptied the page while the panel was open');
      answer();
      await p.settle(80);
      assert.equal(p.toast(), mode === 'sight' ? 'Saved' : 'Saved ' + native.calls.find((c) => c[0] === 'saveDownload')[1], mode + ': the Save went on after Esc, as it always has');
      assert.equal(p.w.__testSavedAt(), null, mode + ': the Save through the panel that landed after Esc marked nothing');
      p.type('abc');
      assert.equal(native.unsaved(), true, mode + ': a Save through the panel that lands after Esc keeps no copy of the text');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

// QA-G-33: the page kept a full copy of the text of the last Save or Open to
// answer the quit question; it outlived Backspace to an empty page, a
// partial deletion kept it whole, and the ten-minute wipe never arms on an
// empty page, so the copy could stay in memory until the quit (QA-01,
// r7_wk_adv.mjs D1 to D3). The page now keeps a count of its edits instead:
// a Save marks the count it took at its click, an Open the count after the
// replace, and a quit asks whenever the count moved since. QA-01's repro:
// Save "abc", Backspace three times, type "abc": true (534f3cc said false).
// Words typed while a Save is still being written stay unsaved when it lands,
// on all three Save paths: the mark is the count at the click, not at the
// landing (QA-G-35; the Delivery Manager's AT-D2 and AT-D3, DM-245); for the
// encrypted Save also while its key is derived, before the save panel is
// asked (DISH-G-73).
test('in the app the quit question counts edits and keeps no copy of the saved text: Save "abc", three Backspaces and "abc" again is text a quit would lose, and words typed while a Save is written stay unsaved after it lands (QA-G-33, QA-G-35, DM-245, DISH-G-73)', async () => {
  const loaded = async (native, storage = {}, html = HTML) => {
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1', ...storage }, html });
    await p.settle(50);
    return p;
  };
  // QA-01's repro, through a folder Save.
  {
    const native = fakeNative({ saved: { name: 'Notes' } });
    const p = await loaded(native);
    try {
      p.type('abc');
      p.$('#btn-save').click();
      await p.settle(80);
      assert.match(p.toast(), /^Saved .*\.txt in Notes$/, 'the folder write happened: ' + p.toast());
      assert.equal(native.unsaved(), false, 'right after the Save nothing would be lost');
      for (let i = 0; i < 3; i++) p.press('Backspace');
      assert.equal(await p.real(), '', 'three Backspaces emptied the page');
      assert.equal(native.unsaved(), false, 'an empty page has nothing to lose');
      p.type('abc');
      assert.equal(native.unsaved(), true, 'the saved words typed again after Backspace to an empty page are text a quit would lose: the page kept no copy to compare them with');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
  // The mark itself, read through the test's own copy of the page: a count
  // after the Save and after the Backspaces, never the text, and null after Esc.
  {
    const native = fakeNative({ saved: { name: 'Notes' } });
    const p = await loaded(native, {}, withMarkReader());
    try {
      p.type('abc');
      p.$('#btn-save').click();
      await p.settle(80);
      assert.equal(typeof p.w.__testSavedAt(), 'number', 'after the Save the mark is a count of edits, not the text: ' + JSON.stringify(p.w.__testSavedAt()));
      for (let i = 0; i < 3; i++) p.press('Backspace');
      assert.equal(typeof p.w.__testSavedAt(), 'number', 'and still a count once Backspace has emptied the page');
      p.press('Escape');
      assert.equal(p.w.__testSavedAt(), null, 'Esc drops the mark');
    } finally { p.close(); }
  }
  // A partial deletion, through a panel Save: three Backspaces, then the letters typed back.
  {
    const native = fakeNative();
    const p = await loaded(native, { 'plainSight.saveMode': 'txt' });
    try {
      p.type('abcdef');
      p.$('#btn-save').click();
      await p.settle(80);
      assert.equal(native.unsaved(), false, 'right after the panel Save nothing would be lost');
      for (let i = 0; i < 3; i++) p.press('Backspace');
      assert.equal(native.unsaved(), true, 'half the text deleted: text a quit would lose');
      p.type('def');
      assert.equal(native.unsaved(), true, 'typed back to the saved words: the question is still asked, the safe direction');
    } finally { p.close(); }
  }
  // Words typed while a folder write is still under way (writeGate).
  {
    let land = null;
    const native = fakeNative({ saved: { name: 'Notes' }, writeGate: new Promise((resolve) => { land = resolve; }) });
    const p = await loaded(native);
    try {
      p.type('abc');
      p.$('#btn-save').click();
      await until(() => native.calls.some((c) => c[0] === 'writeTextFile'), 'the folder write');
      p.type('Z');
      land();
      await p.settle(80);
      assert.match(p.toast(), /^Saved .*\.txt in Notes$/, 'the write landed: ' + p.toast());
      assert.equal(native.calls.find((c) => c[0] === 'writeTextFile')[3], 'abc', 'the file holds the text at the click');
      assert.equal(native.unsaved(), true, 'folder: the Z typed while the write was under way is not in the file, so a quit would lose it');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
  // The same with the save panel still open, plain and encrypted (downloadGate).
  for (const mode of ['txt', 'sight']) {
    let answer = null;
    const native = fakeNative({ downloadGate: new Promise((resolve) => { answer = resolve; }) });
    const p = await loaded(native, { 'plainSight.saveMode': mode });
    try {
      p.type('abc');
      p.$('#btn-save').click();
      if (mode === 'sight') {
        await p.settle(30);
        p.$('#pw-input').value = 'a long enough password';
        p.$('#pw-ok').click();
      }
      await until(() => native.calls.some((c) => c[0] === 'saveDownload'), 'the save panel, ' + mode);
      p.type('Z');
      answer();
      await p.settle(80);
      const call = native.calls.find((c) => c[0] === 'saveDownload');
      assert.equal(p.toast(), mode === 'sight' ? 'Saved' : 'Saved ' + call[1], mode + ': the Save landed');
      if (mode === 'txt') assert.equal(call[2], 'abc', 'txt: the file holds the text at the click');
      assert.equal(native.unsaved(), true, mode + ': the Z typed while the save panel was open is not in the file, so a quit would lose it');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
  // Words typed while the encrypted Save derives its key: after the password
  // is confirmed and before the save panel is asked (DISH-G-73). The page
  // takes the count before the derivation on purpose (`const at = edits;`
  // before `await exportEncrypted(password)`, which reads the text in the
  // same turn); with the count taken after it (DISH's E10, the Delivery
  // Manager's JC4) the letter would count as saved and a quit would lose it
  // with no question, and the cases above, which type only once the panel is
  // up, all passed. DISH's probe case (wave-g/dish/dish_r8_delta/src_adv/
  // desktop/tests/dish_g73.mjs), adopted; the Delivery Manager's AT-D3
  // (dm-appstore-a3387d9/adv/dm-native-adv-a33.mjs) types in the same window.
  {
    let answer = null;
    const native = fakeNative({ downloadGate: new Promise((resolve) => { answer = resolve; }) });
    const p = await loaded(native, { 'plainSight.saveMode': 'sight' });
    try {
      p.type('abc');
      p.$('#btn-save').click();
      await p.settle(30);
      p.$('#pw-input').value = 'a long enough password';
      p.$('#pw-ok').click();
      await sleep(2);   // the Save goes on: exportEncrypted has read the text and derives the key (about 25 ms here)
      assert.equal(native.calls.some((c) => c[0] === 'saveDownload'), false, 'sight: the save panel is not asked yet, the key is still being derived');
      p.type('Z');
      await until(() => native.calls.some((c) => c[0] === 'saveDownload'), 'the save panel, sight');
      answer();
      await p.settle(80);
      assert.equal(p.toast(), 'Saved', 'sight: the Save landed');
      assert.equal(native.unsaved(), true, 'sight: the Z typed while the key was derived is not in the file, so a quit would lose it');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

// QA-G-33, read in the page's source: no lasting copy of the hidden text. No
// savedText is left; the hidden buffer is written only by setReal, which
// counts each change; the count moves only there; and the quit question's
// mark is set from a count (the count at a Save's click, or after an Open's
// replace) and dropped by the wipe, never set from the text.
test('the page keeps no lasting copy of the hidden text: no savedText, every change to the buffer counted by setReal, and the quit question\'s mark is a count, never the text (QA-G-33)', () => {
  assert.equal(/\bsavedText\b/.test(HTML), false, 'index.html holds no savedText (onUnsavedText, the adapter\'s name, is another word)');
  const script = HTML.slice(HTML.indexOf('<script>'), HTML.indexOf('</script>'));
  const lineAt = (index) => script.slice(script.lastIndexOf('\n', index) + 1, script.indexOf('\n', index)).replace(/\s*\/\/.*$/, '').trim();
  const writes = (name) => [...script.matchAll(new RegExp('(?<![.\\w$])' + name + '\\s*(?:\\+\\+|--|[-+*/]?=(?!=))', 'g'))].map((m) => lineAt(m.index));
  const SET_REAL = 'function setReal(text) { real = text; edits += 1; }';
  assert.deepEqual(writes('real'), ["let real = '';", SET_REAL], 'the hidden buffer is written only by setReal');
  assert.deepEqual(writes('edits'), ['let edits = 0;', SET_REAL], 'the count moves only with the buffer');
  const MARK_FN = 'function markSaved(at, wipes) { if (native && wipes === wipeCount) savedAt = at; }';
  assert.deepEqual(writes('savedAt'), ['savedAt = null;', 'let savedAt = null;', MARK_FN], 'the mark is set only by markSaved and dropped by the wipe');
  assert.deepEqual([...script.matchAll(/markSaved\(([^)]*)\)/g)].map((m) => m[1]), ['at, wipes', 'at, wipes', 'at, wipes', 'at, wipes', 'edits, wipes', 'edits, wipes', 'edits, wipes'], 'the mark takes a count: a Save\'s count at its click, an Open\'s after the replace, and Continue\'s after its replace when the page holds exactly the note');
  assert.equal(script.split('const at = edits;').length - 1, 3, 'each of the three Saves takes the count at its click');
  assert.ok(script.includes('native.onUnsavedText(() => real.length > 0 && !vaultOpen() && edits !== savedAt);'), 'the quit question compares counts');
});

test('quitting erases the text and the screen like Esc', async () => {
  const native = fakeNative();
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    p.type('gone on quit');
    assert.ok(p.$('#cover').textContent.length > 0);
    await native.quit();
    assert.equal(await p.real(), '', 'the hidden text is erased');
    assert.equal(p.$('#cover').textContent, '', 'the screen is erased');
  } finally { p.close(); }
});

test('quitting with the vault open writes the last text, locks the vault and settles after the write', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();
    await p.settle(600);   // key derivation and the first write
    assert.ok(p.d.body.classList.contains('vault-open'));
    p.type('typed just before quitting');
    await native.quit();   // no autosave has run yet: the quit itself must write
    assert.ok(!p.d.body.classList.contains('vault-open'), 'the vault is locked');
    const record = JSON.parse(p.w.localStorage.getItem('plainSight.vault'));
    const key = await webcrypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: Buffer.from(record.salt, 'base64'), iterations: record.iterations, hash: 'SHA-256' },
      await webcrypto.subtle.importKey('raw', new TextEncoder().encode('correct horse battery staple'), 'PBKDF2', false, ['deriveKey']),
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(record.iv, 'base64') }, key, Buffer.from(record.data, 'base64')));
    assert.equal(plain, 'typed just before quitting', 'the copy holds the last keystrokes when the quit promise settles');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('in the app the plain .txt Save goes through the app, and the toast names the file the app wrote', async () => {
  const native = fakeNative({ downloadAnswer: 'numbered by the app (2).txt' });
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1', 'plainSight.saveMode': 'txt' } });
  try {
    await p.settle();
    p.type('plain words');
    p.$('#btn-save').click();
    await p.settle();
    const saves = native.calls.filter((c) => c[0] === 'saveDownload');
    assert.equal(saves.length, 1);
    assert.match(saves[0][1], /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/);
    assert.equal(saves[0][2], 'plain words');
    assert.equal(p.toast(), 'Saved numbered by the app (2).txt', 'the toast names what the app wrote');
    assert.equal(p.downloads.length, 0, 'no browser download in the app');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('in the app the encrypted Save goes through the app after the password, as a .sight file that opens with it', async () => {
  const native = fakeNative();
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    p.type('secret words');
    p.$('#btn-save').click();
    await p.settle();
    p.$('#pw-input').value = 'a file password';
    p.$('#pw-ok').click();
    await p.settle(800);   // the key derives from the password
    const saves = native.calls.filter((c) => c[0] === 'saveDownload');
    assert.equal(saves.length, 1);
    assert.match(saves[0][1], /^untitled-draft-\d{8}-\d{4}\.sight$/);
    const record = JSON.parse(saves[0][2]);
    const key = await webcrypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: Buffer.from(record.salt, 'base64'), iterations: record.iterations, hash: 'SHA-256' },
      await webcrypto.subtle.importKey('raw', new TextEncoder().encode('a file password'), 'PBKDF2', false, ['deriveKey']),
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(record.iv, 'base64') }, key, Buffer.from(record.data, 'base64')));
    assert.equal(plain, 'secret words');
    assert.equal(p.toast(), 'Saved');
    assert.equal(p.downloads.length, 0);
  } finally { p.close(); }
});

test('in the app a Save the app could not write says so, in both modes, and never says Saved (DM-202)', async () => {
  for (const mode of ['txt', 'sight']) {
    const native = fakeNative({ failDownload: true });
    const storage = { 'plainSight.introSeen': '1' };
    if (mode === 'txt') storage['plainSight.saveMode'] = 'txt';
    const p = await loadPage({ native, storage });
    try {
      await p.settle();
      p.type('not written');
      p.$('#btn-save').click();
      await p.settle();
      if (mode === 'sight') {
        p.$('#pw-input').value = 'a file password';
        p.$('#pw-ok').click();
        await p.settle(800);
      }
      assert.equal(native.calls.filter((c) => c[0] === 'saveDownload').length, 1, mode + ': the app was asked');
      assert.equal(p.toast(), 'Could not save', mode + ': the failure is told');
      assert.equal(await p.real(), 'not written', mode + ': the text stays');
      assert.deepEqual(unhandled, [], mode + ': the page handled the failure itself');
    } finally { p.close(); }
  }
});

test('in the app a cancelled save panel shows no toast and keeps the text, in both modes (D-49)', async () => {
  for (const mode of ['txt', 'sight']) {
    const native = fakeNative({ cancelDownload: true });
    const storage = { 'plainSight.introSeen': '1' };
    if (mode === 'txt') storage['plainSight.saveMode'] = 'txt';
    const p = await loadPage({ native, storage });
    try {
      await p.settle();
      p.type('kept after a cancel');
      p.$('#btn-save').click();
      await p.settle();
      if (mode === 'sight') {
        p.$('#pw-input').value = 'a file password';
        p.$('#pw-ok').click();
        await p.settle(800);
      }
      assert.equal(native.calls.filter((c) => c[0] === 'saveDownload').length, 1, mode + ': the app was asked');
      assert.equal(p.toast(), '', mode + ': nothing is said, as after a cancelled folder choice');
      assert.equal(await p.real(), 'kept after a cancel', mode + ': the text stays');
      assert.deepEqual(unhandled, [], mode + ': nothing left unhandled');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

test('in the app the folder formats reach the app as text: .md as it is, and .docx for the app to make (folder.rs)', async () => {
  const native = fakeNative({ saved: { name: 'Notes' } });
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    p.$('#btn-help').click();
    assert.equal(p.$('#folder-format').hidden, false, 'the folder formats are offered in the app');
    pick(p, 'folder-format', 'md');
    assert.equal(p.$('#folder-status').textContent, 'Save writes a Markdown file into the folder "Notes".');
    p.start();
    p.type('# a heading');
    p.$('#btn-save').click();
    await p.settle();
    p.$('#btn-help').click();
    pick(p, 'folder-format', 'docx');
    p.start();
    p.press('Tab');
    p.type('tabbed');
    p.$('#btn-save').click();
    await p.settle();
    const writes = native.calls.filter((c) => c[0] === 'writeTextFile');
    assert.equal(writes.length, 2);
    assert.deepEqual(writes.map((c) => c.slice(2)), [['.md', '# a heading'], ['.docx', '# a heading\ttabbed']], 'the extension and the text, never a file of bytes');
    assert.equal(typeof writes[1][3], 'string', 'the app makes the Word document itself');
    assert.equal(p.toast(), 'Saved ' + writes[1][1] + '.docx in Notes');
    assert.equal(p.downloads.length, 0, 'nothing is downloaded');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('in the app a .md or .docx download reaches the app as text, named by the moment', async () => {
  for (const mode of ['md', 'docx']) {
    const native = fakeNative();
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1', 'plainSight.saveMode': mode } });
    try {
      await p.settle();
      p.type('plain words');
      p.$('#btn-save').click();
      await p.settle();
      const saves = native.calls.filter((c) => c[0] === 'saveDownload');
      assert.equal(saves.length, 1, mode);
      assert.match(saves[0][1], new RegExp('^\\d{4}-\\d{2}-\\d{2} \\d{2}-\\d{2}-\\d{2}\\.' + mode + '$'), mode + ': named by the moment');
      assert.equal(saves[0][2], 'plain words', mode + ': the text, not a file of bytes');
      assert.equal(p.toast(), 'Saved ' + saves[0][1], mode);
      assert.equal(p.downloads.length, 0, mode + ': no browser download in the app');
      assert.deepEqual(p.errors, [], mode);
    } finally { p.close(); }
  }
});

// In the app, Cmd+C with no peek would reach the Edit menu's Copy, which with
// nothing selected empties the clipboard (Mac_PS_006): the page takes the key
// unless a text field holds a selection of its own; on the web the browser
// keeps it, as before.
test('in the app Cmd+C with no peek is taken by the page unless a text field holds a selection (Mac_PS_006); on the web it is left to the browser', async () => {
  const copyKey = (p, target, init) => {
    const ev = new p.w.KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const native = fakeNative();
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    p.type('words that stay off the clipboard');
    assert.equal(copyKey(p, p.d.body, { metaKey: true }), true, 'Cmd+C on the page with no peek is taken');
    assert.equal(copyKey(p, p.d.body, { ctrlKey: true }), true, 'Ctrl+C too');
    assert.equal(copyKey(p, p.d.body, { metaKey: true, shiftKey: true }), false, 'Cmd+Shift+C is not the copy chord and is left alone');
    assert.equal(copyKey(p, p.d.body, { metaKey: true, altKey: true }), false, 'Cmd+Alt+C is left alone');
    p.$('#btn-help').click();
    const area = p.$('#custom-text');
    area.value = 'pasted cover text';
    area.focus();
    area.setSelectionRange(0, 6);
    assert.equal(copyKey(p, area, { metaKey: true }), false, 'a text field with a selection keeps Cmd+C for its own copy');
    area.setSelectionRange(3, 3);
    assert.equal(copyKey(p, area, { metaKey: true }), true, 'a text field without a selection does not');
    p.start();
    assert.equal(await p.real(), 'words that stay off the clipboard', 'the text is untouched');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  const web = await loadPage({ storage: { 'plainSight.introSeen': '1' } });
  try {
    await web.settle();
    web.type('words on the web');
    assert.equal(copyKey(web, web.d.body, { metaKey: true }), false, 'without the adapter the browser keeps Cmd+C');
  } finally { web.close(); }
});

// The menu items File > Open..., File > Save... and Help > Plain Sight Help
// run menu.rs's PRESS script in the page (D-44). The script is read from
// menu.rs as text and run here as the app runs it, so the guard tested is the
// one the app holds.
const PRESS = (() => {
  const rs = readFileSync(path.join(ROOT, 'desktop/src-tauri/src/menu.rs'), 'utf8');
  const m = rs.match(/^const PRESS: &str = r"(.*)";$/m);
  if (!m) throw new Error('menu.rs holds no PRESS script');
  return (button) => m[1].replace('BUTTON', button);
})();

test('the menu items press the page\'s buttons only while no dialog is open: Save... asks for the password, Help opens the intro, Open... opens the file chooser (D-44)', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });   // a first visit: the intro is open
  try {
    await p.settle();
    let chooser = 0;
    p.$('#file-input').click = () => { chooser += 1; };   // the system panel, which jsdom has not got
    assert.equal(p.$('#intro').hidden, false, 'the intro is open');
    assert.equal(p.w.eval(PRESS('btn-save')), false, 'Save... does nothing over the intro');
    assert.equal(p.w.eval(PRESS('btn-open')), false, 'Open... does nothing over the intro');
    assert.equal(p.w.eval(PRESS('btn-help')), false, 'Help does nothing over the intro');
    await p.settle();
    assert.equal(p.$('#pw').hidden, true, 'no password dialog');
    assert.equal(chooser, 0, 'no file chooser');
    p.start();
    p.type('words to save');
    assert.equal(p.w.eval(PRESS('btn-save')), true, 'Save... presses the Save button');
    await p.settle();
    assert.equal(p.$('#pw').hidden, false, 'the password dialog is up');
    assert.equal(p.w.eval(PRESS('btn-help')), false, 'Help does nothing over the password dialog');
    assert.equal(p.w.eval(PRESS('btn-open')), false, 'Open... does nothing over the password dialog');
    assert.equal(p.w.eval(PRESS('btn-save')), false, 'Save... does nothing over the password dialog');
    await p.settle();
    assert.equal(p.$('#intro').hidden, true, 'the intro stayed closed');
    assert.equal(chooser, 0);
    p.press('Escape');   // closes the password dialog
    await p.settle();
    assert.equal(p.$('#pw').hidden, true);
    assert.equal(p.w.eval(PRESS('btn-help')), true, 'Help opens the intro');
    await p.settle();
    assert.equal(p.$('#intro').hidden, false, 'the intro is up');
    p.start();
    assert.equal(p.w.eval(PRESS('btn-open')), true, 'Open... presses the Open button');
    assert.equal(chooser, 1, 'which opens the file chooser');
    assert.equal(await p.real(), 'words to save', 'the text is untouched');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the menu items click no hidden button: a button the page hides is left alone and the press reports false (QA-G-26, Me3)', async () => {
  const native = fakeNative();
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    let clicks = 0;
    p.$('#btn-save').addEventListener('click', () => { clicks += 1; });
    p.$('#btn-save').hidden = true;
    assert.equal(p.w.eval(PRESS('btn-save')), false, 'a hidden Save button is not pressed');
    assert.equal(clicks, 0, 'no click reached it');
    p.$('#btn-save').hidden = false;
    p.type('words to save');
    assert.equal(p.w.eval(PRESS('btn-save')), true, 'shown again, it is pressed');
    assert.equal(clicks, 1);
    assert.equal(p.w.eval(PRESS('btn-missing')), false, 'a button the page has not got is nothing to press');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

// A .sight file of the text, in the page's own format, so that a text with
// carriage returns reaches the page unchanged (Open of a plain note turns
// them into line feeds; the web suite opens the sample the same way).
// Super Stealth (web 1.5.0, BR-46) in the app (round 16): the two notes on
// the intro speak of a browser on the web; in the app each carries its own
// words in data-app, true for the app. No app menu item takes Shift+H
// (config.mjs), so Cmd+Shift+H and Ctrl+Shift+H reach the page as Cmd+Shift+G
// and Ctrl+Shift+G do in the real-key runs; Option+Tab moves between the
// page's buttons (the first real-key run counted Option+Tab presses), and
// Tab alone does when Keyboard navigation is on in System Settings.
test('in the app the two Super Stealth notes say what the app does, and on the web they keep the browser\'s words (web 1.5.0, BR-46)', async () => {
  const app = ['Cmd + Shift + H (Ctrl + Shift + H works too). With the keyboard: Option+Shift+Tab to the button (Shift+Tab alone when Keyboard navigation is on in System Settings), then Enter the same number of times.', 'Kept only on this computer.'];
  const web = ['Ctrl + Shift + H, on a Mac too (Cmd + Shift + H also works where the browser leaves it to the page; Safari also uses it for its home page, so use Ctrl there). With the keyboard: Shift+Tab to the button (Option+Shift+Tab in Safari), then Enter the same number of times.', 'Kept only in this browser (localStorage).'];
  for (const [native, says, never] of [[fakeNative(), app, ['browser', 'Safari', 'localStorage']], [null, web, ['Keyboard navigation', 'this computer']]]) {
    const p = await loadPage({ native });
    try {
      await p.settle();
      const box = p.$('#stealth-box');
      assert.deepEqual([...box.querySelectorAll('[data-app]')].map((el) => el.textContent), says, (native ? 'the app' : 'the web') + ': both notes say this');
      for (const word of never) assert.equal(box.textContent.includes(word), false, (native ? 'the app' : 'the web') + ': no ' + JSON.stringify(word));
      assert.match(box.textContent, /This screen comes back when you click the \? at the bottom right the number of times set here, quickly, or when you press /, 'the rest of the note is the same on both');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

// DM-138 with DM-245 (round 16): main's queue runs folder writes one after
// another, in the order Save was pressed, and the candidate marks the text
// saved after a write that succeeded. Merged: a Save queued behind another
// marks the text when its own write lands, and a failed write marks nothing
// while the queue goes on to the next Save.
test('in the app a folder Save queued behind another marks the text saved when its own write lands, and a failed write marks nothing while the next Save still writes (DM-138, DM-245)', async () => {
  {
    let release;
    const native = fakeNative({ saved: { name: 'Notes' }, writeGate: new Promise((r) => { release = r; }) });
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
    try {
      await p.settle(50);
      p.type('first');
      p.$('#btn-save').click();
      await p.settle(40);
      p.type(' and second');
      p.$('#btn-save').click();
      await p.settle(40);
      assert.equal(native.calls.filter((c) => c[0] === 'writeTextFile').length, 1, 'the second write waits in the queue behind the first');
      assert.equal(native.unsaved(), true, 'nothing is marked saved while the first write is under way');
      release();
      await until(() => native.calls.filter((c) => c[0] === 'writeTextFile').length === 2 && native.unsaved() === false, 'both writes to land');
      assert.deepEqual(native.calls.filter((c) => c[0] === 'writeTextFile').map((c) => c[3]), ['first', 'first and second'], 'the writes ran in order, each with the text at its click');
      assert.match(p.toast(), /^Saved .*\.txt in Notes$/, 'the second Save says where it wrote');
      p.type('!');
      assert.equal(native.unsaved(), true, 'a keystroke after the queued Save: unsaved again');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
  {
    const native = fakeNative({ saved: { name: 'Notes' } });
    const write = native.api.writeTextFile;
    let fails = 1;
    native.api.writeTextFile = async (base, ext, text) => {
      if (fails-- > 0) { native.calls.push(['writeTextFile', base, ext, text]); throw new Error('disk full'); }
      return write(base, ext, text);
    };
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
    try {
      await p.settle(50);
      p.type('kept');
      p.$('#btn-save').click();
      await p.settle(80);
      assert.equal(p.toast(), 'Could not write to the folder');
      assert.equal(native.unsaved(), true, 'the failed write marked nothing');
      p.$('#btn-save').click();
      await p.settle(80);
      assert.match(p.toast(), /^Saved .*\.txt in Notes$/, 'the queue went on after the failure: the next Save wrote');
      assert.equal(native.unsaved(), false, 'and marked the text saved');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

async function sightFile(w, text, password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const data = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const b64 = (u) => Buffer.from(u).toString('base64');
  const record = { format: 'plain-sight', version: 1, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations: 310000, salt: b64(salt), iv: b64(iv), data: b64(data) };
  return new w.File([JSON.stringify(record)], 'sample.sight', { type: 'application/json' });
}

test('the page makes, byte for byte, the Word document the app is held to (tests/fixtures at the root, docx.rs)', async () => {
  const sample = readFileSync(path.join(ROOT, 'tests/fixtures/sample.txt'), 'utf8');
  const expected = readFileSync(path.join(ROOT, 'tests/fixtures/sample.docx'));
  assert.ok(sample.includes('\r\n') && /[^\r]\r[^\n]/.test(sample) && ['\u000b', '\u000c', '\u0001', '\u001f', '\ufffe', '\uffff'].every((c) => sample.includes(c)), 'the sample holds a CRLF, a lone CR, U+000B, U+000C, U+0001, U+001F, U+FFFE and U+FFFF (QA-G-25)');
  const p = await loadPage({ storage: { 'plainSight.introSeen': '1', 'plainSight.saveMode': 'docx' } });
  try {
    await p.settle();
    chooseFile(p, await sightFile(p.w, sample, 'a phrase for the sample'));
    await p.settle();
    p.$('#pw-input').value = 'a phrase for the sample';
    p.$('#pw-ok').click();
    await p.settle(800);   // the key derives from the password
    assert.equal(await p.real(), sample, 'the encrypted file carries the sample exactly, carriage returns included');
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(p.downloads.length, 1);
    assert.match(p.downloads[0].name, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.docx$/);
    const bytes = Buffer.from(await p.downloads[0].blob.arrayBuffer());
    assert.ok(bytes.equals(expected), 'the same bytes as tests/fixtures/sample.docx (' + bytes.length + ' and ' + expected.length + ' bytes)');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

// ---------------------------------------------------------------------------
// Continue in the app (1 November 2026, on the App Store candidate): the phrase
// on a line of its own, then Enter twice, brings back a locked copy, or, with a
// folder chosen and no copy kept, the newest note in the folder. The phrase
// check (plainSight.continueCheck) is written on Start or Esc on the intro.
// ---------------------------------------------------------------------------
const PHRASE = 'correct horse battery staple';
const CHECK_KEY = 'plainSight.continueCheck';
const ONE_PHRASE = 'With a copy kept on this device, the phrase brings back the copy; with no copy kept, it brings back the newest note in the folder.';
const NO_COPY_NOTE = 'To come back to your text: type your phrase on the page on a line of its own, then press Enter twice. Nothing happens for a wrong phrase. There is no recovery for a forgotten one.';
// A record in the page's own format, made outside the page, as the page would store it.
async function recordFor(text, phrase, iterations = 310000) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const data = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const b64 = (u) => Buffer.from(u).toString('base64');
  return JSON.stringify({ format: 'plain-sight', version: 1, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations, salt: b64(salt), iv: b64(iv), data: b64(data) });
}
// The plaintext of a stored record under a phrase, or null when the phrase does not open it.
async function openRecord(json, phrase) {
  try {
    const r = JSON.parse(json);
    const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveKey']);
    const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: Buffer.from(r.salt, 'base64'), iterations: r.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(r.iv, 'base64') }, key, Buffer.from(r.data, 'base64')));
  } catch (err) { return null; }
}
const stored = (p, key) => p.w.localStorage.getItem(key);
async function chooseFolder(p) {
  if (p.$('#intro').hidden) p.$('#btn-help').click();
  p.$('#btn-folder').click();
  await until(() => /into the folder/.test(p.$('#folder-status').textContent), 'the folder chosen');
}
const enter2 = (p) => { p.press('Enter'); p.press('Enter'); };
const counter = () => { const c = { n: 0 }; c.spy = async () => { c.n += 1; }; return c; };
// Two notes in the folder, newest first, a folder remembered from the last run and the phrase check: what a person comes back to.
const NOTES = [['2026-11-01 10-00-02 (2).txt', 'the newest note\nwith two lines'], ['2026-11-01 10-00-02.txt', 'an older note'], ['2026-11-01 09-59-59.md', 'the oldest note']];
async function comeBack({ notes = NOTES, extra = {}, storage = {}, onDerive = null } = {}) {
  const native = fakeNative({ saved: { name: 'Notes' }, notes, ...extra });
  const p = await loadPage({ native, onDerive, storage: { 'plainSight.introSeen': '1', [CHECK_KEY]: await recordFor('check', PHRASE), ...storage } });
  await p.settle();   // the remembered folder arrives from the app
  return { native, p };
}
const listed = (native) => native.calls.filter((c) => c[0] === 'listNotes').length;

test('Continue in the app: with a folder chosen the phrase field is in use with the box unticked; choosing or giving up the folder on the open intro turns it on or off and leaves what is typed and the box alone; the note then says which comes back', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    await p.settle();
    assert.equal(p.$('#vault-on').checked, false);
    assert.equal(p.$('#vault-phrase').disabled, true, 'no folder, box unticked: the field is not in use');
    assert.equal(p.$('#vault-status').textContent, NO_COPY_NOTE, 'without a folder the note teaches the copy only');
    await chooseFolder(p);
    assert.equal(p.$('#vault-phrase').disabled, false, 'a folder chosen: the field is in use');
    assert.equal(p.$('#vault-on').checked, false, 'the box is left as it was');
    assert.equal(p.$('#vault-status').textContent, NO_COPY_NOTE + ' ' + ONE_PHRASE, 'the note says what the phrase brings back, true whether or not a copy is kept');
    p.$('#vault-phrase').value = 'being typed';
    p.$('#btn-folder-forget').click();
    await until(() => p.$('#vault-phrase').disabled, 'the field out of use once the folder is given up');
    assert.equal(p.$('#vault-phrase').value, 'being typed', 'what is typed stays');
    assert.equal(p.$('#vault-status').textContent, NO_COPY_NOTE);
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    assert.equal(p.$('#vault-phrase').disabled, false, 'the box ticked: in use, folder or not');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: Start with a folder chosen writes the phrase check, a record in the vault\'s shape that opens to the word "check" under the phrase only, holding neither the phrase nor the text; typing in the field writes nothing; no copy is made with the box unticked', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    await chooseFolder(p);
    p.start();
    p.type('the hidden words of today');
    await chooseFolder(p);
    const field = p.$('#vault-phrase');
    field.value = PHRASE;
    field.dispatchEvent(new p.w.Event('input', { bubbles: true }));
    field.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    await p.settle(500);
    assert.equal(stored(p, CHECK_KEY), null, 'nothing is written while the phrase is typed: Start or Esc writes it');
    p.start();
    await until(() => stored(p, CHECK_KEY), 'the phrase check');
    const raw = stored(p, CHECK_KEY);
    const rec = JSON.parse(raw);
    assert.deepEqual(Object.keys(rec).sort(), ['cipher', 'data', 'format', 'iterations', 'iv', 'kdf', 'salt', 'version']);
    assert.deepEqual([rec.format, rec.version, rec.cipher, rec.kdf, rec.iterations], ['plain-sight', 1, 'AES-256-GCM', 'PBKDF2-SHA-256', 310000], 'the vault\'s shape and round count');
    assert.deepEqual([Buffer.from(rec.salt, 'base64').length, Buffer.from(rec.iv, 'base64').length], [16, 12]);
    assert.equal(await openRecord(raw, PHRASE), 'check', 'the phrase opens it to the fixed word');
    assert.equal(await openRecord(raw, 'another phrase entirely'), null, 'another phrase does not');
    for (const needle of ['correct', 'horse', 'hidden words', 'today']) assert.ok(!raw.includes(needle), 'the record holds no ' + needle);
    assert.equal(stored(p, 'plainSight.vault'), null, 'no copy with the box unticked');
    assert.equal(await p.real(), 'the hidden words of today', 'the page text is untouched');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: Esc on the intro writes the phrase check like Start; a new phrase replaces it under a fresh salt; an empty field leaves it as it is', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    await chooseFolder(p);
    p.$('#vault-phrase').value = PHRASE;
    p.press('Escape');                       // on the intro, Esc applies every choice like Start
    await until(() => stored(p, CHECK_KEY), 'the phrase check after Esc');
    assert.equal(p.$('#intro').hidden, true);
    const first = stored(p, CHECK_KEY);
    assert.equal(await openRecord(first, PHRASE), 'check');
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a second phrase here';
    p.start();
    await until(() => stored(p, CHECK_KEY) !== first, 'the replaced check');
    const second = stored(p, CHECK_KEY);
    assert.equal(await openRecord(second, 'a second phrase here'), 'check', 'the new phrase opens it');
    assert.equal(await openRecord(second, PHRASE), null, 'the old phrase no longer does');
    assert.notEqual(JSON.parse(second).salt, JSON.parse(first).salt, 'a fresh salt');
    p.$('#btn-help').click();
    p.start();
    await p.settle(500);
    assert.equal(stored(p, CHECK_KEY), second, 'an empty field leaves the check as it is');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: with a folder chosen and the box unticked, a phrase of 1 to 11 characters is refused with the vault\'s words and the intro stays open; nothing is written', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    await chooseFolder(p);
    p.$('#vault-phrase').value = 'elevenchars';
    p.start();
    assert.equal(p.$('#intro').hidden, false, 'the intro stays open');
    assert.equal(p.toast(), 'Use a phrase of at least 12 characters');
    await p.settle(500);
    assert.equal(stored(p, CHECK_KEY), null, 'no phrase check');
    p.$('#vault-phrase').value = 'twelve chars';
    p.start();
    assert.equal(p.$('#intro').hidden, true, '12 characters are accepted');
    await until(() => stored(p, CHECK_KEY), 'the phrase check');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: "Stop using the folder" deletes the phrase check; when the app cannot forget the folder, the check stays with it', async () => {
  const kept = await comeBack({ extra: { failForget: true } });
  try {
    kept.p.$('#btn-help').click();
    kept.p.$('#btn-folder-forget').click();
    await until(() => kept.p.toast() === 'Could not stop using the folder', 'the refusal');
    assert.ok(stored(kept.p, CHECK_KEY), 'the folder is still in use, and so is its check');
    assert.deepEqual(kept.p.errors, []);
  } finally { kept.p.close(); }
  const { p } = await comeBack();
  try {
    p.$('#btn-help').click();
    p.$('#btn-folder-forget').click();
    await until(() => p.$('#btn-folder-forget').hidden, 'the folder given up');
    assert.equal(stored(p, CHECK_KEY), null, 'the phrase check is deleted with the folder');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: with the box ticked and a folder chosen, the one field keys both the copy and the phrase check, so the two phrases can never differ', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    await chooseFolder(p);
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = PHRASE;
    p.start();
    await until(() => stored(p, CHECK_KEY) && stored(p, 'plainSight.vault'), 'both records');
    assert.equal(await openRecord(stored(p, CHECK_KEY), PHRASE), 'check');
    assert.equal(await openRecord(stored(p, 'plainSight.vault'), PHRASE), '', 'the copy opens with the same phrase');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: after two Saves into the folder and Esc, the phrase on a line of its own and Enter twice bring back the newest note, silently; the quit question answers false, and true after the next key', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    await chooseFolder(p);
    p.$('#vault-phrase').value = PHRASE;
    p.start();
    await until(() => stored(p, CHECK_KEY), 'the phrase check');
    p.type('first draft');
    p.$('#btn-save').click();
    await until(() => /^Saved /.test(p.toast()), 'the first Save');
    p.type(' and more');
    const firstToast = p.toast();
    p.$('#btn-save').click();
    await until(() => native.calls.filter((c) => c[0] === 'writeTextFile').length === 2 && p.toast() !== firstToast, 'the second Save');
    const newest = p.toast().match(/^Saved (.+) in Build_Test_1$/)[1];
    p.press('Escape');
    assert.equal(await p.real(), '');
    p.type(PHRASE);
    enter2(p);
    await until(() => native.calls.some((c) => c[0] === 'readNote'), 'the note read');
    await p.settle();
    assert.equal(await p.real(), 'first draft and more', 'the newest note is back, and the phrase line and its two Enters are gone');
    const read = native.calls.filter((c) => c[0] === 'readNote');
    assert.equal(read.length, 1);
    assert.equal(read[0][1], newest, 'the first name the app listed: the second Save\'s file');
    assert.equal(p.toast(), 'Saved ' + newest + ' in Build_Test_1', 'silent on success: the last toast is still the Save\'s');
    assert.equal(p.$('#cover').textContent.length > 0, true, 'the cover was rebuilt');
    assert.equal(native.unsaved(), false, 'the page holds exactly what the note holds: nothing to lose');
    p.type('x');
    assert.equal(native.unsaved(), true, 'a key later, text a quit would lose');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: text typed before the phrase line follows the note, and the quit question answers true, since that text is not on disk', async () => {
  const { native, p } = await comeBack();
  try {
    p.type('typed today first\n' + PHRASE);
    enter2(p);
    await until(() => native.calls.some((c) => c[0] === 'readNote'), 'the note read');
    await p.settle();
    assert.equal(await p.real(), 'the newest note\nwith two linestyped today first\n', 'the note first, then the text typed before, in order');
    assert.equal(native.unsaved(), true, 'the text typed before is not in the note');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: keys typed while the check runs follow the note, and the quit question answers true', async () => {
  let release;
  const { native, p } = await comeBack({ extra: { listGate: new Promise((r) => { release = r; }) } });
  try {
    p.type(PHRASE);
    enter2(p);
    await until(() => listed(native) === 1, 'the listing asked for');
    p.type('ab');
    release();
    await until(() => native.calls.some((c) => c[0] === 'readNote'), 'the note read');
    await p.settle();
    assert.equal(await p.real(), 'the newest note\nwith two linesab');
    assert.equal(native.unsaved(), true, 'the keys typed during the check are not in the note');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: a wrong line changes nothing and shows nothing, and the folder is never listed; one Enter derives nothing; a line under 12 characters is never derived', async () => {
  const c = counter();
  const { native, p } = await comeBack({ onDerive: c.spy });
  try {
    p.type('not the phrase at all');
    enter2(p);
    await p.settle(500);
    assert.equal(c.n, 1, 'the line was tried');
    assert.equal(await p.real(), 'not the phrase at all\n\n', 'nothing changed');
    assert.equal(p.toast(), '', 'no message');
    assert.equal(listed(native), 0, 'the folder was never listed');
    p.press('Escape');
    p.type(PHRASE);
    p.press('Enter');
    await p.settle(400);
    assert.equal(c.n, 1, 'one Enter: nothing derived');
    p.press('Escape');
    p.type('elevenchars');
    enter2(p);
    await p.settle(300);
    assert.equal(c.n, 1, 'a line of 11 characters: nothing derived');
    assert.equal(listed(native), 0);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: a locked copy wins over the folder, and a failure there never tries the folder, even with the phrase the folder\'s check would take', async () => {
  const { native, p } = await comeBack({ storage: { 'plainSight.vault': await recordFor('the copy text', 'the copy phrase here') } });
  try {
    p.type(PHRASE);                          // opens the folder's check, not the copy
    enter2(p);
    await p.settle(800);
    assert.equal(listed(native), 0, 'the folder is never tried while a copy is kept');
    assert.equal(await p.real(), PHRASE + '\n\n', 'nothing changed');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    p.press('Escape');
    p.type('the copy phrase here');
    enter2(p);
    await until(() => p.d.body.classList.contains('vault-open'), 'the copy open');
    assert.equal(await p.real(), 'the copy text', 'the copy came back');
    assert.equal(listed(native), 0, 'and the folder was not listed');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: after a note came back nothing is tried until Esc; after Esc the phrase works again', async () => {
  const c = counter();
  const { native, p } = await comeBack({ onDerive: c.spy });
  try {
    p.type(PHRASE);
    enter2(p);
    await until(() => native.calls.some((x) => x[0] === 'readNote'), 'the note read');
    await p.settle();
    const n = c.n;
    p.type('\n' + PHRASE);
    enter2(p);
    await p.settle(500);
    assert.equal(c.n, n, 'nothing derived after a bring-back');
    assert.equal(listed(native), 1);
    p.press('Escape');
    p.type(PHRASE);
    enter2(p);
    await until(() => listed(native) === 2, 'tried again after Esc');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: nothing is tried while the vault is open, folder and phrase check or not', async () => {
  const c = counter();
  const { native, p } = await comeBack({ onDerive: c.spy });
  try {
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = PHRASE;
    p.start();
    await until(() => p.d.body.classList.contains('vault-open'), 'the vault open');
    await p.settle(300);
    const n = c.n;
    p.type(PHRASE);
    enter2(p);
    await p.settle(500);
    assert.equal(c.n, n, 'no key derived while the vault is open');
    assert.equal(listed(native), 0);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: Esc while the note is on its way cancels it; the page stays blank', async () => {
  let release;
  const { native, p } = await comeBack({ extra: { listGate: new Promise((r) => { release = r; }) } });
  try {
    p.type(PHRASE);
    enter2(p);
    await until(() => listed(native) === 1, 'the listing asked for');
    p.press('Escape');
    release();
    await p.settle(300);
    assert.equal(await p.real(), '', 'nothing came back after Esc');
    assert.equal(native.calls.some((c) => c[0] === 'readNote'), false, 'the note was not read');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: after the right phrase a toast says why no note came, and the page stays as typed: a Word file newest, an empty folder, a folder the app could not read, a note too large', async () => {
  const cases = [
    [{ notes: [['2026-11-01 10-00-03.docx', ''], ...NOTES] }, WORD_REFUSED],
    [{ notes: [] }, 'No note in the folder yet'],
    [{ extra: { failList: 'Could not read the folder: Operation not permitted (os error 1)' } }, 'Could not read the folder: Operation not permitted (os error 1)'],
    [{ extra: { failRead: 'The note is too large to bring back' } }, 'The note is too large to bring back']
  ];
  for (const [opts, words] of cases) {
    const { p } = await comeBack(opts);
    try {
      p.type(PHRASE);
      enter2(p);
      await until(() => p.toast() === words, JSON.stringify(words));
      assert.equal(await p.real(), PHRASE + '\n\n', 'the page is as typed: ' + words);
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

test('Continue in the app: another folder chosen, or a phrase check replaced, while the check runs drops it', async () => {
  for (const change of ['folder', 'check']) {
    let release;
    const { native, p } = await comeBack({ extra: { listGate: new Promise((r) => { release = r; }) } });
    try {
      p.type(PHRASE);
      enter2(p);
      await until(() => listed(native) === 1, 'the listing asked for');
      if (change === 'folder') {
        const check = stored(p, CHECK_KEY);
        await chooseFolder(p);               // "Choose a different folder": the phrase check stays
        assert.equal(stored(p, CHECK_KEY), check, 'the phrase check is untouched by another folder');
        p.start();                           // the intro closes, so the peek can read the page
      } else {
        p.w.localStorage.setItem(CHECK_KEY, await recordFor('check', 'a different phrase here'));
      }
      release();
      await p.settle(300);
      assert.equal(await p.real(), PHRASE + '\n\n', change + ': nothing came back');
      assert.equal(native.calls.some((c) => c[0] === 'readNote'), false, change + ': no note read');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
});

test('Continue in the app: a Backspace back into the phrase line while the check runs drops it; the page keeps what was typed', async () => {
  let release;
  const { native, p } = await comeBack({ extra: { listGate: new Promise((r) => { release = r; }) } });
  try {
    p.type(PHRASE);
    enter2(p);
    await until(() => listed(native) === 1, 'the listing asked for');
    p.press('Backspace');                    // the second Enter goes
    p.type('x');
    release();
    await p.settle(300);
    assert.equal(await p.real(), PHRASE + '\nx', 'nothing removed or added');
    assert.equal(native.calls.some((c) => c[0] === 'readNote'), false, 'the note was not read');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: "Stop using the folder" while the phrase check is still being made leaves no check behind', async () => {
  let slow = true;
  const native = fakeNative();
  const p = await loadPage({ native, onDerive: async () => { if (slow) await sleep(400); } });
  try {
    await chooseFolder(p);
    p.$('#vault-phrase').value = PHRASE;
    p.start();                               // the check's key derives for 400 ms
    p.$('#btn-help').click();
    p.$('#btn-folder-forget').click();
    await until(() => p.$('#btn-folder-forget').hidden, 'the folder given up');
    slow = false;
    await p.settle(800);
    assert.equal(stored(p, CHECK_KEY), null, 'the slower write never lands after the folder was given up');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: without a folder no phrase check is written, whatever the vault does', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    await p.settle();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = PHRASE;
    p.start();
    await until(() => p.d.body.classList.contains('vault-open'), 'the vault open');
    await p.settle(500);
    assert.equal(stored(p, CHECK_KEY), null, 'no folder, no phrase check');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: with a folder chosen the phrase field stays in use when the box is unticked and when another document changes the copy while the intro is open', async () => {
  const { p } = await comeBack();
  try {
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-phrase').disabled, false, 'a folder remembered from the last run: in use at once');
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-on').checked = false;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    assert.equal(p.$('#vault-phrase').disabled, false, 'unticked again: still in use for the folder');
    const record = await recordFor('words', 'another phrase here');
    p.w.localStorage.setItem('plainSight.vault', record);
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: null, newValue: record }));
    assert.equal(p.$('#vault-on').checked, true, 'the intro follows the other document\'s copy');
    p.w.localStorage.removeItem('plainSight.vault');
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: record, newValue: null }));
    assert.equal(p.$('#vault-on').checked, false, 'and its delete');
    assert.equal(p.$('#vault-phrase').disabled, false, 'the redraw keeps the field in use for the folder');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: a record that opens under the phrase to anything but the word "check" brings back nothing', async () => {
  const { native, p } = await comeBack({ storage: { [CHECK_KEY]: await recordFor('not the check word', PHRASE) } });
  try {
    p.type(PHRASE);
    enter2(p);
    await p.settle(600);
    assert.equal(listed(native), 0, 'the folder was never listed');
    assert.equal(await p.real(), PHRASE + '\n\n');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Continue in the app: localStorage never holds the phrase, the typed text, a note\'s text or its name, and holds only the page\'s known keys (tests/smoke.mjs KNOWN_KEYS)', async () => {
  const known = new Set([...readFileSync(path.join(ROOT, 'tests', 'smoke.mjs'), 'utf8').match(/const KNOWN_KEYS = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  assert.ok(known.has(CHECK_KEY), 'smoke.mjs knows the phrase check');
  const native = fakeNative({ notes: [['2026-11-01 08-00-00.txt', 'SENTINEL note text']] });
  const p = await loadPage({ native });
  const check = (step) => {
    for (let i = 0; i < p.w.localStorage.length; i++) {
      const k = p.w.localStorage.key(i);
      const v = p.w.localStorage.getItem(k);
      assert.ok(known.has(k), step + ': unknown key ' + k);
      for (const needle of ['SENTINEL', 'correct', 'horse', 'battery', '2026-11-01 08-00-00', 'typed words']) assert.ok(!k.includes(needle) && !v.includes(needle), step + ': ' + k + ' holds ' + needle);
    }
  };
  try {
    await chooseFolder(p);
    p.$('#vault-phrase').value = PHRASE;
    p.start();
    await until(() => stored(p, CHECK_KEY), 'the phrase check');
    check('phrase set');
    p.type('typed words');
    p.$('#btn-save').click();
    await until(() => /^Saved /.test(p.toast()), 'the Save');
    check('saved');
    p.press('Escape');
    p.type(PHRASE);
    enter2(p);
    await until(() => native.calls.some((c) => c[0] === 'readNote'), 'the note read');
    await p.settle();
    check('brought back');
    p.press('Escape');
    check('Esc');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
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
