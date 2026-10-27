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
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/;

// A fake adapter with the same surface as desktop/adapter.js. It records
// every call; files is the set of names already in the folder, so the
// counter rule can be checked from the page's side.
function fakeNative({ saved = null, pick = { name: 'Build_Test_1' }, failPick = false, failForget = false, failWrite = false, failDownload = false, cancelDownload = false, downloadAnswer = null, writeGate = null } = {}) {
  const calls = [];
  const files = new Set();
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
        return name;
      },
      // As the app does (folder.rs): the save panel's name, or null when it was cancelled (D-49).
      saveDownload: async (name, text) => {
        calls.push(['saveDownload', name, text]);
        if (failDownload) throw new Error('Could not save the file: Operation not permitted');
        if (cancelDownload) return null;
        return downloadAnswer || name;
      },
      onQuit: (callback) => { calls.push(['onQuit']); quit = callback; },
      onUnsavedText: (callback) => { calls.push(['onUnsavedText']); unsaved = callback; }
    }
  };
}

async function loadPage({ native = null, storage = {} } = {}) {
  const errors = [];
  const downloads = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.Math.random = () => 1;   // no simulated typos
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
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

test('without the adapter the page keeps its browser wording and registers nothing', async () => {
  const p = await loadPage();
  try {
    assert.match(p.$('#vault-on').parentElement.textContent, /in this browser/);
    assert.match(p.$('#folder-note').textContent, /Folder access exists in Chrome/);
    assert.ok(p.d.querySelectorAll('[data-app]').length >= 6, 'the app wording is carried in data-app attributes');
    assert.match(p.$('#intro').textContent, /download/i, 'on the web the intro speaks of downloads');
    assert.equal(p.$('#folder-status').textContent, 'Save downloads an encrypted .sight file.');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('with the adapter the folder box offers the system picker, no browser help, and the app wording', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    await p.settle();
    assert.equal(p.$('#btn-folder').hidden, false, 'the folder button shows in the app');
    assert.equal(p.$('#folder-help').hidden, true, 'no browser-specific help in the app');
    assert.equal(p.$('#folder-note').textContent.includes('Chrome'), false, 'the browser sentence is gone');
    assert.match(p.$('#folder-note').textContent, /straight into that folder\. Plain means anyone who can open the file can read it, and the computer indexes, previews and backs it up like any document; a synced folder uploads it\.\s*$/);   // main 1.3.10's wording (Web_PS_011); the app's empty span ends the note there
    assert.match(p.$('#vault-on').parentElement.textContent, /Save my text on this computer, encrypted/);
    assert.match(p.$('#intro').textContent, /Nothing you type leaves this app/);
    assert.match(p.$('#intro').textContent, /Closing the window or quitting erases the hidden text/);
    assert.match(p.$('#intro').textContent, /clears itself after 10 minutes with its window minimized or hidden/);
    assert.match(p.$('#intro').textContent, /Stored only on this computer\./);
    assert.equal(p.$('#intro').textContent.includes('browser'), false, 'no sentence of the intro mentions a browser');
    assert.equal(p.$('#intro').textContent.includes('tab'), false, 'no sentence of the intro mentions a tab');
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
// while the page still holds exactly that text, which a file on disk now
// holds too (DM-236); a keystroke or Backspace makes it true again, and a
// cancelled panel, a refused write and "Could not save" leave it true. The
// folder Save and the .sight Save through the panel are the Delivery
// Manager's AT-01 and AT-02 (dm-appstore-2783e5d/adv/dm-native-adv.mjs),
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
      assert.equal(native.unsaved(), false, 'the same text again is the saved text');
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
// memory until the next Save, Open or the window closed. That copy lives
// inside the page's script, out of a test's reach, so its absence is shown by
// its one effect: after a wipe, the same words typed again are text a quit
// would lose (QA-01's repro: Save "abc", Esc, type "abc"; true is the answer
// the fix sets, false before it). A Save still being written when Esc comes
// marks nothing when it lands, so it cannot bring the copy back after the
// wipe either.
test('in the app Esc, the ten-minute wipe and the quit keep no copy of the last saved text: the same words typed again would be lost, and a Save that lands after Esc marks nothing (QA-G-31)', async () => {
  const loaded = async (native, storage = {}) => {
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1', ...storage } });
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
    const p = await loaded(native);
    try {
      p.type('abc');
      p.$('#btn-save').click();
      await p.settle(30);
      assert.equal(native.calls.filter((c) => c[0] === 'writeTextFile').length, 1, 'the write is under way');
      p.press('Escape');
      land();
      await p.settle(80);
      assert.match(p.toast(), /^Saved .*\.txt in Notes$/, 'the write landed after Esc: ' + p.toast());
      p.type('abc');
      assert.equal(native.unsaved(), true, 'a folder Save that lands after Esc keeps no copy of the text');
    } finally { p.close(); }
  }
  // An encrypted Save whose key is still deriving when Esc comes: the file is written, and nothing is kept.
  {
    const native = fakeNative();
    const p = await loaded(native);
    try {
      p.type('abc');
      p.$('#btn-save').click();
      await p.settle(30);
      p.$('#pw-input').value = 'a long enough password';
      p.$('#pw-ok').click();
      await p.settle(30);   // the Save has taken the text and its key is deriving
      p.press('Escape');
      await p.settle(900);
      assert.equal(p.toast(), 'Saved', 'the encrypted Save went on after Esc, as it always has');
      assert.match(native.calls.find((c) => c[0] === 'saveDownload')[1], /\.sight$/);
      p.type('abc');
      assert.equal(native.unsaved(), true, 'an encrypted Save that lands after Esc keeps no copy of the text');
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
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
