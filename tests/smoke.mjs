// Smoke test for Plain Sight. Runs the real index.html in jsdom and drives it
// through the DOM: keyboard events, the header, the dialogs, the download
// path and the public console API. Nothing reaches into the page's closure.
//
// Run with: npm test   (exit code 0 only when every test passes)

import { JSDOM, VirtualConsole } from 'jsdom';
import { headersFor } from '../tools/vercel-headers.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const UNLOCK_WINDOW_MS = 2000;
const VAULT_SAVE_DELAY_MS = 1500;
const TEN_MINUTES = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Page harness
// ---------------------------------------------------------------------------
// jsdom does not execute <script type="module">, so the harness plays the part
// of the page's cover loader: it imports covers/<id>.js in node (which also
// proves the file is a valid ES module) and hands the object to
// PlainSight.setCover(), exactly as the bridge script does, and it answers the
// same plainsight:select event when the page asks for another cover.
async function importCover(id) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'covers', id + '.js')).href);
  return mod.default;
}

// With slowEncrypt set, every AES-GCM encryption in the page takes that many
// milliseconds (or, given a function, the milliseconds it returns for the nth
// encryption), so a test can press Esc while a vault write is in flight.
// slowDerive does the same for key derivations. With failDerive set to a number,
// that many key derivations reject at once before they work again; given a
// function, the nth derivation rejects after the milliseconds it returns, or
// derives normally when it returns false.
// With noSubtle, the page sees a crypto object without subtle, as on a plain http address.
function cryptoFor(slowEncrypt, failDerive = 0, noSubtle = false, slowDerive = 0) {
  if (noSubtle) return { getRandomValues: (a) => webcrypto.getRandomValues(a) };
  if (!slowEncrypt && !failDerive && !slowDerive) return webcrypto;
  let calls = 0;
  let derives = 0;
  const pick = (opt, n) => (typeof opt === 'function' ? opt(n) : opt);
  const delayFor = () => pick(slowEncrypt, calls++);
  return {
    getRandomValues: (a) => webcrypto.getRandomValues(a),
    subtle: {
      importKey: (...a) => webcrypto.subtle.importKey(...a),
      deriveKey: async (...a) => {
        const n = derives++;
        const refuse = typeof failDerive === 'function' ? failDerive(n) : (n < failDerive ? 0 : false);
        if (refuse !== false) { await sleep(refuse); throw new Error('deriveKey refused by the test'); }
        const wait = pick(slowDerive, n);
        if (wait) await sleep(wait);
        return webcrypto.subtle.deriveKey(...a);
      },
      decrypt: (...a) => webcrypto.subtle.decrypt(...a),
      encrypt: async (...a) => { if (slowEncrypt) await sleep(delayFor()); return webcrypto.subtle.encrypt(...a); }
    }
  };
}

// An unhandled promise rejection raised in the page reaches Node's process handler
// (a browser would show it as a console error). It is recorded on every page open at
// the time, and a run with any such rejection fails even if no test asserted on it.
const openErrors = new Set();
let unhandled = 0;
process.on('unhandledRejection', (reason) => {
  unhandled += 1;
  const text = 'unhandled rejection: ' + (reason && reason.message ? reason.message : String(reason));
  for (const errors of openErrors) errors.push(text);
});

async function loadPage({ random = () => 1, storage = {}, inject = true, folder = null, slowEncrypt = 0, failDerive = 0, slowDerive = 0, noSubtle = false, userAgent = undefined, brave = false, cssSupports = false, maskComputed = true, refuseKeys = [] } = {}) {
  const errors = [];
  openErrors.add(errors);
  const downloads = [];
  const copied = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));

  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (userAgent) Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
      if (brave) Object.defineProperty(window.navigator, 'brave', { value: { isBrave: async () => true }, configurable: true });
      // jsdom has no CSS.supports; with cssSupports the page sees a browser that can mask a text field.
      if (cssSupports) {
        Object.defineProperty(window, 'CSS', { value: { supports: () => true }, configurable: true });
        // jsdom computes no vendor property: a masked field reports the mask as applied, or not with maskComputed false.
        const computed = window.getComputedStyle.bind(window);
        window.getComputedStyle = (el, pseudo) => {
          const cs = computed(el, pseudo);
          if (el.classList && el.classList.contains('masked')) Object.defineProperty(cs, 'webkitTextSecurity', { value: maskComputed ? 'disc' : '', configurable: true });
          return cs;
        };
      }
      // Deterministic typos: Math.random() === 1 means "never a typo".
      window.Math.random = random;
      // jsdom has no crypto.subtle, URL.createObjectURL or navigator.clipboard.
      Object.defineProperty(window, 'crypto', { value: cryptoFor(slowEncrypt, failDerive, noSubtle, slowDerive), configurable: true });
      window.URL.createObjectURL = (blob) => { downloads.push({ blob, name: null }); return 'blob:http://localhost/' + downloads.length; };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () {
        const d = downloads[downloads.length - 1];
        if (d && this.href === 'blob:http://localhost/' + downloads.length) d.name = this.download;
      };
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: async (text) => { copied.push(text); } },
        configurable: true
      });
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
      // A browser that refuses to store some keys (storage full or blocked), from the first script on: setItem throws for them.
      if (refuseKeys.length) {
        const proto = Object.getPrototypeOf(window.localStorage);
        const original = proto.setItem;
        proto.setItem = function (key, value) {
          if (refuseKeys.includes(key)) { const e = new window.Error('quota'); e.name = 'QuotaExceededError'; throw e; }
          return original.call(this, key, value);
        };
      }
      // A fake File System Access API: a directory picker that hands back a
      // folder whose files are recorded in folder.written.
      if (folder) {
        window.showDirectoryPicker = async () => {
          if (folder.cancel) throw new window.DOMException('The user aborted a request.', 'AbortError');
          return folder.handle;
        };
      }
    }
  });

  const w = dom.window;
  const d = w.document;
  const $ = (sel) => d.querySelector(sel);

  const loads = [];
  const failCovers = new Set();   // ids whose load the harness should fail on purpose
  async function loadCover(id) {
    loads.push(id);
    if (failCovers.has(id)) { w.PlainSight.coverFailed(id); return; }
    try { w.PlainSight.setCover(await importCover(id)); } catch (err) { w.PlainSight.coverFailed(id); }
  }
  d.addEventListener('plainsight:select', (e) => { loadCover(e.detail.id); });
  if (inject) {
    await loadCover(w.PlainSight.selectedCoverId());
    await w.PlainSight.ready;
  }

  const page = {
    w, d, $, errors, downloads, copied, loads, loadCover, failCovers,
    press(key, init = {}, target = null) {
      const ev = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      (target || d.activeElement || d.body).dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    release(key) {
      d.body.dispatchEvent(new w.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    },
    type(str) { for (const ch of str) page.press(ch); },
    coverText() { return $('#cover').textContent; },
    // Cover characters on screen. A paragraph break is a keystroke's worth of
    // cover, so it counts as one character.
    coverLength() {
      const blocks = page.blocks();
      return blocks.reduce((n, b) => n + b.text.length, 0) + Math.max(0, blocks.length - 1);
    },
    // Blocks in screen order. Bullets live inside a shared ul, so they are
    // listed as the li elements themselves.
    blocks() {
      return Array.from($('#cover').querySelectorAll(':scope > p, :scope > h2, :scope > ul > li'))
        .map((el) => ({ type: el.classList.contains('ref') ? 'ref' : el.tagName.toLowerCase(), text: el.textContent }));
    },
    peeking() { return d.body.classList.contains('peek'); },
    // Ctrl+Shift+G toggles the peek. peek() turns it on and reads the real
    // text off the screen; readReal() reads it and turns the peek off again.
    peekChord() { return page.press('G', { ctrlKey: true, shiftKey: true }); },
    async peek() {
      if (!page.peeking()) page.peekChord();
      return $('#real').textContent;
    },
    async readReal() {
      const text = await page.peek();
      page.peekChord();
      return text;
    },
    unlockChord() {
      const armed = page.press('e', { ctrlKey: true });
      const fired = page.press('Enter', { ctrlKey: true });
      return { armed, fired };
    },
    storageDump() {
      const ls = page.w.localStorage;
      const out = {};
      for (let i = 0; i < ls.length; i++) { const k = ls.key(i); out[k] = ls.getItem(k); }
      return out;
    },
    // Turns the device vault on through the intro screen.
    async vaultOn(phrase) {
      if ($('#intro').hidden) $('#btn-help').click();
      $('#vault-on').checked = true;
      $('#vault-on').dispatchEvent(new w.Event('change', { bubbles: true }));
      $('#vault-phrase').value = phrase;
      page.start();
      await sleep(400);   // key derivation and the first save
    },
    wordCount() { return $('#word-count').textContent; },
    toast() { return $('#toast').textContent; },
    start() { $('#btn-start').click(); },
    async submitPassword(value) {
      assert.equal($('#pw').hidden, false, 'password dialog should be open');
      $('#pw-input').value = value;
      $('#pw-ok').click();
      await sleep(0);
    },
    async settle(ms = 50) { await sleep(ms); },
    close() { openErrors.delete(errors); w.close(); }
  };
  return page;
}

// Reference model of the cover display after n keystrokes with no typos.
// Mirrors the engine's rules so the tests can state expectations without
// hard-coding the story: markers are consumed at a block start, '\n' is a
// paragraph break, the end of the text is a break followed by a loop.
const MARKERS = [
  { prefix: '## ', type: 'h2' },
  { prefix: '- ', type: 'li' },
  { pattern: /^\[\d+\] /, type: 'ref' }   // typed as text, styled as a reference entry
];
function expectedBlocks(coverText, n) {
  const blocks = [];
  let pos = 0;
  const start = () => {
    let type = 'p';
    for (const m of MARKERS) {
      if (m.prefix && coverText.startsWith(m.prefix, pos)) { pos += m.prefix.length; type = m.type; break; }
      if (m.pattern && m.pattern.test(coverText.slice(pos, pos + 16))) { type = m.type; break; }
    }
    blocks.push({ type, text: '' });
  };
  start();
  for (let i = 0; i < n; i++) {
    if (pos >= coverText.length) { pos = 0; start(); continue; }
    const ch = coverText[pos];
    if (ch === '\n') { pos += 1; start(); continue; }
    blocks[blocks.length - 1].text += ch;
    pos += 1;
  }
  return blocks;
}
function countWords(blocks) {
  return blocks.reduce((n, b) => n + (b.text.match(/\S+/g) || []).length, 0);
}
// Makes a vault record outside the page, in the page's own format, as another tab would store it.
async function encryptVaultRecord(text, phrase, iterations = 310000) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const data = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const b64 = (u) => Buffer.from(u).toString('base64');
  return JSON.stringify({ format: 'plain-sight', version: 1, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations, salt: b64(salt), iv: b64(iv), data: b64(data) });
}
// Decrypts a stored vault record outside the page, to prove what the page saved.
async function decryptVault(record, phrase) {
  const salt = Buffer.from(record.salt, 'base64');
  const iv = Buffer.from(record.iv, 'base64');
  const data = Buffer.from(record.data, 'base64');
  const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: record.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data));
}
function fakeFolder(name, { permission = 'granted', permissionDelay = 0 } = {}) {
  const written = [];
  const files = new Set();
  const handle = {
    kind: 'directory',
    name,
    queryPermission: async () => { if (permissionDelay) await sleep(permissionDelay); return permission; },
    requestPermission: async () => permission,
    getFileHandle: async (fileName, opts) => {
      const create = Boolean(opts && opts.create);
      if (!create && !files.has(fileName)) throw new Error('NotFoundError');
      files.add(fileName);
      return {
        createWritable: async () => ({
          write: async (text) => { written.push({ name: fileName, text, create }); },
          close: async () => {}
        })
      };
    }
  };
  return { handle, written, files, cancel: false };
}
function makeCoverFile(w, json) {
  return new w.File([json], 'test.sight', { type: 'application/json' });
}
function chooseFile(page, file) {
  const input = page.$('#file-input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new page.w.Event('change', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Tiny runner
// ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test('inline scripts parse with node --check', () => {
  const scripts = [...HTML.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1, 'expected at least one inline script');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cover-story-check-'));
  try {
    scripts.forEach((m, i) => {
      const isModule = m[0].startsWith('<script type="module"');
      const file = path.join(dir, `script-${i}.${isModule ? 'mjs' : 'cjs'}`);
      writeFileSync(file, m[1]);
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('first visit: intro shows, Start hides it, book cover loaded, empty page', async () => {
  const p = await loadPage();
  try {
    assert.equal(p.$('#intro').hidden, false, 'intro visible on first visit');
    assert.equal(p.w.localStorage.getItem('plainSight.introSeen'), null);
    p.start();
    assert.equal(p.$('#intro').hidden, true, 'intro hidden after Start');
    assert.equal(p.w.localStorage.getItem('plainSight.introSeen'), '1');
    assert.equal(p.d.title, 'Untitled draft');
    assert.ok(p.d.body.classList.contains('font-serif'));
    assert.equal(p.$('#header-left').textContent, 'Untitled draft');
    assert.equal(p.wordCount(), '0 words');
    assert.equal(p.coverText(), '');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: '' }], 'the story opens with a chapter heading block');
    assert.equal(p.w.PlainSight.coverId(), 'book', 'the cover loaded is book');
    assert.deepEqual(p.loads, ['book'], 'exactly one cover load was requested');
    assert.equal(p.w.localStorage.getItem('plainSight.cover'), 'book', 'the selection persists');
    assert.equal(p.$('#load-notice').hidden, true);
    assert.ok(p.w.PlainSight.coverText().length > 1500, 'cover text present');
    assert.equal(p.$('#cover').querySelector('.caret').textContent, '', 'caret adds no text');
    assert.equal(p.$('#intro-title').textContent, 'Plain Sight');
    assert.equal(p.$('#vault-on').checked, false, 'the device vault is off by default');
    assert.equal(p.$('#vault-phrase').disabled, true);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('typing N printable keys renders exactly N cover characters; real buffer equals what was typed; no peek class', async () => {
  const p = await loadPage();
  try {
    p.start();
    const typed = 'The quick brown fox jumps over the lazy dog, twice; 42!'.slice(0, 40);
    assert.equal(typed.length, 40);
    for (const ch of typed) assert.equal(p.press(ch), true, 'printable key is preventDefaulted');
    assert.equal(p.coverLength(), 40, 'exactly N cover characters');
    const expected = expectedBlocks(p.w.PlainSight.coverText(), 40);
    assert.deepEqual(p.blocks(), expected);
    assert.equal(p.peeking(), false, 'peek class absent after typing');
    assert.equal(await p.readReal(), typed, 'real buffer equals what was typed');
    assert.equal(p.peeking(), false, 'the second chord ends the peek');
    assert.equal(p.$('#real').textContent, '', 'real text removed from the page after peek');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Backspace shortens both buffers by one', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('abcdefghij');
    for (let i = 0; i < 3; i++) assert.equal(p.press('Backspace'), true);
    assert.equal(p.coverLength(), 7);
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 7));
    assert.equal(await p.readReal(), 'abcdefg');
    // Backspace on an empty page is harmless.
    for (let i = 0; i < 10; i++) p.press('Backspace');
    assert.equal(p.coverText(), '');
    assert.equal(await p.readReal(), '');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Esc empties both buffers', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('some secret words here');
    assert.equal(p.press('Escape'), true);
    assert.equal(p.coverText(), '');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: '' }]);
    assert.equal(p.wordCount(), '0 words');
    assert.equal(await p.readReal(), '');
    // Typing after a wipe starts the cover from the top again.
    p.type('xy');
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 2));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Enter and Tab are recorded and advance one cover character; Shift+Tab is left to the browser', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('ab');
    assert.equal(p.press('Enter'), true);
    assert.equal(p.press('Tab'), true);
    assert.equal(p.coverLength(), 4);
    assert.equal(await p.readReal(), 'ab\n\t');
    assert.equal(p.press('Tab', { shiftKey: true }), false, 'Shift+Tab not prevented');
    assert.equal(p.coverLength(), 4);
    assert.equal(await p.readReal(), 'ab\n\t');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('keys with Ctrl, Cmd or Alt held are not recorded and not prevented; isComposing events are ignored', async () => {
  const p = await loadPage();
  try {
    p.start();
    assert.equal(p.press('b', { ctrlKey: true }), false);
    assert.equal(p.press('b', { metaKey: true }), false);
    assert.equal(p.press('b', { altKey: true }), false);
    assert.equal(p.press('s', { metaKey: true }), false, 'Cmd+S goes to the browser');
    assert.equal(p.press('e', { ctrlKey: true }), false, 'Ctrl+E goes to the browser while no vault exists');
    assert.equal(p.press('Enter', { ctrlKey: true }), false, 'Ctrl+Enter goes to the browser while no vault exists');
    assert.equal(p.press('a', { isComposing: true }), false);
    assert.equal(p.press('Enter', { isComposing: true }), false);
    assert.equal(p.coverText(), '');
    assert.equal(await p.readReal(), '');
    // Arrow keys and Shift alone are left alone too.
    assert.equal(p.press('ArrowLeft'), false);
    assert.equal(p.press('Shift', { shiftKey: true }), false);
    assert.equal(p.coverText(), '');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Ctrl+Shift+G toggles the peek; typing, a window blur and a hidden tab end it; Cmd+Shift+G works too', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('hidden text');
    assert.equal(p.peeking(), false);
    assert.equal(p.press('G', { ctrlKey: true, shiftKey: true }), true, 'the chord is handled');
    assert.equal(p.peeking(), true, 'peek on');
    assert.equal(p.$('#real').textContent, 'hidden text');
    assert.equal(p.press('G', { ctrlKey: true, shiftKey: true }), true);
    assert.equal(p.peeking(), false, 'peek off again');
    assert.equal(p.$('#real').textContent, '', 'real text removed from the page');
    // Typing ends a peek and is still recorded.
    p.peekChord();
    assert.equal(p.peeking(), true);
    p.type('!');
    assert.equal(p.peeking(), false, 'typing ends the peek');
    assert.equal(p.$('#real').textContent, '');
    // Backspace ends it too.
    p.peekChord();
    p.press('Backspace');
    assert.equal(p.peeking(), false);
    // A window blur (for example Cmd+Tab away) ends it.
    p.press('g', { metaKey: true, shiftKey: true });
    assert.equal(p.peeking(), true, 'Cmd+Shift+G peeks too');
    p.w.dispatchEvent(new p.w.Event('blur'));
    assert.equal(p.peeking(), false, 'blur ends peek');
    // Holding Ctrl on its own no longer does anything.
    p.press('Control', { ctrlKey: true });
    await sleep(1100);
    assert.equal(p.peeking(), false, 'a held modifier never peeks');
    p.release('Control');
    // Ctrl+G without Shift is the browser's.
    assert.equal(p.press('g', { ctrlKey: true }), false);
    assert.equal(p.peeking(), false);
    assert.equal(await p.readReal(), 'hidden text');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
test('Ctrl+C while peeking copies the real text; Ctrl+C otherwise is left to the browser', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('copy me');
    assert.equal(p.press('c', { ctrlKey: true }), false, 'not peeking: browser copy');
    assert.deepEqual(p.copied, []);
    await p.peek();
    assert.equal(p.press('c', { ctrlKey: true }), true, 'peeking: handled');
    await p.settle();
    assert.deepEqual(p.copied, ['copy me']);
    assert.equal(p.toast(), 'Copied');
    assert.equal(await p.$('#real').textContent, 'copy me', 'still peeking, buffer intact');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('simulated typo: a wrong neighbouring letter appears at a word start and the next keystroke removes it', async () => {
  const p = await loadPage({ random: () => 0 });   // 0 < 3.5 percent: typo on every word start
  try {
    p.start();
    const text = p.w.PlainSight.coverText();
    const expected1 = expectedBlocks(text, 1);
    const correct = expected1[expected1.length - 1].text;   // the first real cover letter
    p.press('a');
    assert.equal(p.coverLength(), 1, 'one character on screen');
    assert.notEqual(p.coverText(), correct, 'and it is the wrong one');
    assert.match(p.coverText(), /^[A-Za-z]$/);
    p.press('b');
    assert.equal(p.coverLength(), 0, 'the correcting keystroke removes it');
    p.press('c');
    assert.deepEqual(p.blocks(), expected1, 'then the right letter appears');
    p.type('def');   // inside the word: no typos
    assert.deepEqual(p.blocks(), expectedBlocks(text, 4));
    assert.equal(await p.readReal(), 'abcdef', 'the real buffer has every keystroke');
    // Backspace while a wrong letter is pending removes it and one real character.
    p.press(' ');   // the next paragraph starts here: another word start, another typo
    assert.equal(p.blocks().length, 2);
    assert.equal(p.blocks()[1].text.length, 1);
    assert.notEqual(p.blocks()[1].text, expectedBlocks(text, 5)[1].text, 'wrong letter pending');
    p.press('Backspace');
    assert.deepEqual(p.blocks(), expectedBlocks(text, 4));
    assert.equal(await p.readReal(), 'abcdef');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('custom cover text from localStorage is used; when it runs out the cover breaks a paragraph and loops', async () => {
  const p = await loadPage({ storage: { 'plainSight.customText': 'ab cd', 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.$('#intro').hidden, true, 'intro not shown on a return visit');
    assert.equal(p.w.PlainSight.coverText(), 'ab cd');
    p.type('1234567');
    assert.deepEqual(p.blocks(), [{ type: 'p', text: 'ab cd' }, { type: 'p', text: 'a' }]);
    assert.deepEqual(expectedBlocks('ab cd', 7), p.blocks(), 'reference model agrees on a hand-checked case');
    assert.equal(p.wordCount(), '3 words');
    p.press('Backspace');
    p.press('Backspace');
    assert.deepEqual(p.blocks(), [{ type: 'p', text: 'ab cd' }], 'Backspace undoes the paragraph break');
    assert.equal(p.wordCount(), '2 words');
    assert.equal(await p.readReal(), '12345');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a cover line starting with ## renders as a heading; the marker costs no keystrokes; Backspace walks back through it', async () => {
  const p = await loadPage({ storage: { 'plainSight.customText': '## Title\n\nBody text', 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.w.PlainSight.coverText(), '## Title\nBody text');
    p.type('12345');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: 'Title' }]);
    p.type('6');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: 'Title' }, { type: 'p', text: '' }]);
    p.type('7890');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: 'Title' }, { type: 'p', text: 'Body' }]);
    assert.equal(p.wordCount(), '2 words');
    for (let i = 0; i < 5; i++) p.press('Backspace');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: 'Title' }]);
    assert.equal(await p.readReal(), '12345');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the word count counts the cover text on screen, not the real text', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('aaaaaaaaaaaaaaaaaaaa');   // one real word, 20 keystrokes
    const expected = countWords(expectedBlocks(p.w.PlainSight.coverText(), 20));
    assert.ok(expected > 1, 'the first 20 cover characters hold more than one word');
    assert.equal(p.wordCount(), expected + ' words');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Save writes a .sight with a 16-byte salt, 12-byte IV and data; Open restores it with the right password and refuses wrong passwords, damaged files, foreign formats and bad iteration counts with a toast', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('hello world');
    const save = async (password) => {
      const before = p.downloads.length;
      p.$('#btn-save').click();
      await p.submitPassword(password);
      await p.settle(400);
      assert.equal(p.downloads.length, before + 1, 'one download per save');
      return p.downloads[before].blob.text();
    };
    const open = async (fileText, password) => {
      chooseFile(p, makeCoverFile(p.w, fileText));
      await p.settle();
      if (p.$('#pw').hidden) return p.toast();   // refused before the password prompt
      await p.submitPassword(password);
      await p.settle(400);
      return p.toast();
    };
    const json = await save('correct horse');
    const f = JSON.parse(json);
    assert.equal(f.format, 'plain-sight');
    assert.equal(f.version, 1);
    assert.equal(f.cipher, 'AES-256-GCM');
    assert.equal(f.kdf, 'PBKDF2-SHA-256');
    assert.equal(f.iterations, 310000);
    assert.equal(Buffer.from(f.salt, 'base64').length, 16);
    assert.equal(Buffer.from(f.iv, 'base64').length, 12);
    assert.equal(Buffer.from(f.data, 'base64').length, 'hello world'.length + 16, 'ciphertext plus the 16-byte GCM tag');
    assert.ok(!json.includes('hello world'), 'plaintext is not in the file');
    const g = JSON.parse(await save('correct horse'));
    assert.notEqual(g.salt, f.salt, 'fresh salt every time');
    assert.notEqual(g.iv, f.iv, 'fresh IV every time');
    // An empty password is not accepted; the dialog stays open until cancelled.
    p.$('#btn-save').click();
    await p.submitPassword('');
    assert.equal(p.$('#pw').hidden, false, 'an empty password is refused');
    p.press('Escape');
    assert.equal(p.$('#pw').hidden, true);

    p.press('Escape');
    assert.equal(await p.readReal(), '');
    assert.equal(await open(json, 'wrong password'), 'Wrong password or damaged file');
    assert.equal(await p.readReal(), '', 'a failed open changes nothing');
    assert.equal(await open(json, 'correct horse'), 'Opened');
    assert.equal(await p.readReal(), 'hello world', 'round trip');
    assert.equal(p.coverLength(), 'hello world'.length, 'the cover is rebuilt to the same length');
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 11));

    // Damaged, foreign or hostile files are refused, most of them before any key derivation.
    const variant = (changes) => JSON.stringify({ ...f, ...changes });
    assert.equal(await open('{"salt":1}', 'x'), 'That is not a .sight file');
    assert.equal(await open('not json', 'x'), 'That is not a .sight file');
    assert.equal(await open(variant({ iterations: 50000000 }), 'correct horse'), 'Wrong password or damaged file', 'iteration cap');
    assert.equal(await open(variant({ iterations: 999 }), 'correct horse'), 'Wrong password or damaged file', 'iteration floor');
    assert.equal(await open(variant({ iterations: '310000' }), 'correct horse'), 'That is not a .sight file', 'iterations must be a number');
    assert.equal(await open(variant({ iv: f.salt }), 'correct horse'), 'Wrong password or damaged file', 'IV length');
    assert.equal(await open(variant({ format: 'other' }), 'correct horse'), 'That is not a .sight file');
    assert.equal(await open(variant({ format: 'cover-story' }), 'correct horse'), 'Opened', 'files from the earlier name still open');
    assert.equal(await open(variant({ version: 2 }), 'correct horse'), 'That is not a .sight file');
    assert.equal(await open(variant({ cipher: 'AES-128-GCM' }), 'correct horse'), 'That is not a .sight file');
    assert.equal(await open(variant({ kdf: 'scrypt' }), 'correct horse'), 'That is not a .sight file');
    const bytes = Buffer.from(f.data, 'base64');
    bytes[0] ^= 1;
    assert.equal(await open(variant({ data: bytes.toString('base64') }), 'correct horse'), 'Wrong password or damaged file', 'a flipped ciphertext bit fails authentication');
    assert.equal(await p.readReal(), 'hello world', 'every refusal left the buffer alone');
    // Nothing on the console object touches the buffer.
    assert.deepEqual(Object.keys(p.w.PlainSight).sort(), ['coverFailed', 'coverId', 'coverIds', 'coverText', 'ready', 'selectedCoverId', 'setCover', 'version']);
    assert.equal(p.w.PlainSight.version, '1.3.11');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Save button: password dialog, then a .sight download holding valid JSON; nothing to save shows a toast', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(p.$('#pw').hidden, true, 'no dialog when there is nothing to save');
    assert.equal(p.toast(), 'Nothing to save yet');
    p.type('a note');
    p.$('#btn-save').click();
    assert.equal(p.$('#pw').hidden, false, 'dialog opens');
    // Keys typed into the dialog do not reach the hidden buffer.
    p.press('z', {}, p.$('#pw-input'));
    await p.submitPassword('pw-1234');
    await p.settle(400);
    assert.equal(p.$('#pw').hidden, true);
    assert.equal(p.downloads.length, 1, 'one download');
    assert.match(p.downloads[0].name, /^untitled-draft-\d{8}-\d{4}\.sight$/);
    const f = JSON.parse(await p.downloads[0].blob.text());
    assert.ok(f.salt && f.iv && f.data);
    assert.equal(p.toast(), 'Saved');
    assert.equal(await p.readReal(), 'a note', 'saving keeps the text on the page');
    // Cancel path.
    p.$('#btn-save').click();
    assert.equal(p.$('#pw').hidden, false);
    assert.equal(p.press('Escape'), true, 'Esc closes the dialog');
    assert.equal(p.$('#pw').hidden, true);
    assert.equal(await p.readReal(), 'a note', 'Esc in a dialog does not wipe');
    assert.equal(p.downloads.length, 1);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Open: wrong password fails with a toast and no console error; right password restores the text', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('first draft');
    p.$('#btn-save').click();
    await p.submitPassword('right');
    await p.settle(400);
    const json = await p.downloads[0].blob.text();
    p.press('Escape');
    p.type('xyz');

    chooseFile(p, makeCoverFile(p.w, json));
    await p.settle();
    await p.submitPassword('wrong');
    await p.settle(400);
    assert.equal(p.toast(), 'Wrong password or damaged file');
    assert.equal(await p.readReal(), 'xyz', 'nothing changed');

    chooseFile(p, makeCoverFile(p.w, json));
    await p.settle();
    await p.submitPassword('right');
    await p.settle(400);
    assert.equal(p.toast(), 'Opened');
    assert.equal(await p.readReal(), 'first draft');
    assert.equal(p.coverLength(), 'first draft'.length);

    chooseFile(p, makeCoverFile(p.w, 'this is not json'));
    await p.settle();
    assert.equal(p.$('#pw').hidden, true, 'no password prompt for a non-cover file');
    assert.equal(p.toast(), 'That is not a .sight file');
    assert.deepEqual(p.errors, [], 'no console errors on any failure path');
  } finally { p.close(); }
});

test('a tab hidden for more than 10 minutes with text in the buffer is wiped on return; a short absence is not', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('do not keep this');
    const realNow = p.w.Date.now();
    let fakeNow = realNow;
    p.w.Date.now = () => fakeNow;
    const setHidden = (hidden) => {
      Object.defineProperty(p.d, 'hidden', { get: () => hidden, configurable: true });
      p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    };
    setHidden(true);
    fakeNow += 60 * 1000;
    setHidden(false);
    assert.equal(p.coverLength(), 'do not keep this'.length, 'one minute away keeps the text');
    setHidden(true);
    fakeNow += TEN_MINUTES + 1000;
    setHidden(false);
    assert.equal(p.coverText(), '', 'cover wiped');
    assert.equal(p.wordCount(), '0 words');
    assert.equal(p.toast(), 'Cleared after 10 minutes in the background');
    assert.equal(await p.readReal(), '', 'real wiped');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('while a dialog is open nothing is recorded, Esc closes the dialog instead of wiping, and the ? button reopens the intro', async () => {
  const p = await loadPage();
  try {
    assert.equal(p.$('#intro').hidden, false);
    p.type('abc');
    assert.equal(p.coverText(), '');
    assert.equal(p.press('Escape'), true);
    assert.equal(p.$('#intro').hidden, true, 'Esc closes the intro');
    p.type('abc');
    assert.equal(p.coverLength(), 3);
    p.$('#btn-help').click();
    assert.equal(p.$('#intro').hidden, false, '? reopens the intro');
    p.type('def');
    p.press('Backspace');
    assert.equal(p.coverLength(), 3, 'keys in the intro do not touch the page');
    // Custom text entered in the intro is applied and remembered on Start.
    p.$('#custom-text').value = 'one two three four five six';
    p.start();
    assert.equal(p.w.localStorage.getItem('plainSight.customText'), 'one two three four five six');
    assert.equal(p.w.PlainSight.coverText(), 'one two three four five six');
    assert.equal(p.coverText(), 'one', 'the screen is rebuilt for the 3 keystrokes already typed');
    assert.equal(await p.readReal(), 'abc');
    // Clearing the box goes back to the built-in text.
    p.$('#btn-help').click();
    p.$('#custom-text').value = '';
    p.start();
    assert.equal(p.w.localStorage.getItem('plainSight.customText'), null);
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 3));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('intro has the three mode radios; book is checked; the selection is written on Start', async () => {
  const p = await loadPage();
  try {
    const radios = Array.from(p.d.querySelectorAll('input[name="mode"]'));
    assert.deepEqual(radios.map((r) => r.value), ['book', 'work', 'paper']);
    assert.deepEqual(radios.map((r) => r.checked), [true, false, false]);
    assert.equal(p.w.localStorage.getItem('plainSight.cover'), null, 'nothing stored before Start');
    p.start();
    assert.equal(p.w.localStorage.getItem('plainSight.cover'), 'book');
    assert.equal(p.w.PlainSight.selectedCoverId(), 'book');
    assert.deepEqual(p.loads, ['book'], 'picking the cover already on screen requests nothing');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a remembered cover id is used on the next visit; unknown ids fall back to book', async () => {
  const p = await loadPage({ storage: { 'plainSight.cover': 'nonsense', 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.w.PlainSight.selectedCoverId(), 'book');
    assert.equal(p.w.PlainSight.coverId(), 'book');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('before a cover is on screen typing is ignored and left to the browser; a failed load shows the notice; a bad cover object is refused', async () => {
  const p = await loadPage({ inject: false, storage: { 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.w.PlainSight.coverId(), null);
    assert.equal(p.press('a'), false, 'not prevented');
    assert.equal(p.press('Escape'), false);
    assert.equal(p.$('#cover').children.length, 0);
    assert.equal(p.$('#load-notice').hidden, true);
    p.w.PlainSight.coverFailed('book');
    assert.equal(p.$('#load-notice').hidden, false, 'notice shown');
    assert.equal(p.toast(), 'Could not load the cover text');
    assert.throws(() => p.w.PlainSight.setCover({ id: 'book', text: 'x' }), /Not a cover object/);
    assert.throws(() => p.w.PlainSight.setCover({ id: 'evil', label: 'x', tabTitle: 'x', font: 'serif', header: { left: 'x', right: [] }, text: 'x' }), /Not a cover object/);
    await p.loadCover('book');
    assert.equal(p.$('#load-notice').hidden, true, 'notice hidden once a cover arrives');
    assert.equal(p.w.PlainSight.coverId(), 'book');
    assert.equal(p.press('a'), true);
    assert.equal(p.coverLength(), 1);
    assert.equal(await p.readReal(), 'a');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the module bridge imports ./covers/<id>.js for the selected id and listens for plainsight:select', () => {
  const m = HTML.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, 'module script present');
  const src = m[1];
  assert.ok(src.includes("import('./covers/' + id + '.js')"), 'dynamic import of the cover file');
  assert.ok(src.includes('api.setCover(mod.default)'));
  assert.ok(src.includes("addEventListener('plainsight:select'"));
  assert.ok(src.includes('load(api.selectedCoverId())'), 'initial load uses the remembered selection');
  assert.ok(src.includes('api.coverFailed(id)'), 'failure path reports to the page');
  assert.equal((HTML.match(/<script type="module">/g) || []).length, 1, 'one module script');
  assert.ok(!HTML.includes('fetch(') && !HTML.includes('XMLHttpRequest') && !HTML.includes('sendBeacon') && !HTML.includes('WebSocket'), 'no network APIs in the page');
  assert.ok(!/<script[^>]+src=/.test(HTML), 'no external scripts');
  assert.ok(!/<link[^>]+rel="stylesheet"/.test(HTML), 'no external stylesheets');
});

test('covers/book.js is a valid ES module with the shared shape, at least 1,500 words and chapter headings', async () => {
  const c = await importCover('book');
  assert.equal(c.id, 'book');
  assert.equal(typeof c.label, 'string');
  assert.equal(c.tabTitle, 'Untitled draft');
  assert.equal(c.font, 'serif');
  assert.equal(c.header.left, 'Untitled draft');
  assert.deepEqual(c.header.right, ['word count']);
  const words = (c.text.replace(/^## .*$/gm, '').match(/\S+/g) || []).length;
  assert.ok(words >= 1500, 'at least 1,500 words, got ' + words);
  assert.ok((c.text.match(/^## /gm) || []).length >= 2, 'chapter headings present');
  const src = readFileSync(path.join(ROOT, 'covers', 'book.js'), 'utf8');
  assert.match(src, /fictional/i, 'the file says its names are fictional');
});

test('switching to work loads that cover: sans chrome, static "Last edited just now", a decorative toolbar, no word count', async () => {
  const p = await loadPage({ storage: { 'plainSight.cover': 'work', 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.w.PlainSight.coverId(), 'work');
    assert.equal(p.d.title, 'Q3 planning notes');
    assert.equal(p.$('#header-left').textContent, 'Q3 planning notes');
    assert.ok(p.d.body.classList.contains('font-sans') && p.d.body.classList.contains('cover-work'));
    assert.ok(!p.d.body.classList.contains('font-serif') && !p.d.body.classList.contains('cover-book'));
    assert.equal(p.$('#last-edited').textContent, 'Last edited just now');
    assert.equal(p.$('#word-count'), null, 'no word count on the work document');
    const toolbar = p.$('#toolbar');
    assert.equal(toolbar.getAttribute('aria-hidden'), 'true');
    assert.equal(toolbar.querySelectorAll('button, a, input, select').length, 0, 'nothing in the toolbar is a control');
    assert.ok(toolbar.querySelectorAll('.ic').length >= 6, 'icon placeholders present');
    assert.match(HTML, /body\.cover-work \.toolbar \{ display: flex; \}/, 'toolbar shown with the work cover');
    assert.match(HTML, /\.toolbar \{\n\s+display: none;/, 'and hidden otherwise');
    const typed = 'Hello there, typing on the work document now.';
    p.type(typed);
    assert.equal(p.$('#last-edited').textContent, 'Last edited just now', 'the static text does not change');
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), typed.length));
    assert.equal(await p.readReal(), typed, 'the real buffer is unaffected by the cover');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a cover line starting with "- " renders inside a list item; bullets share one list; headings render as headings; Backspace walks back out', async () => {
  const p = await loadPage({ storage: { 'plainSight.cover': 'work', 'plainSight.introSeen': '1', 'plainSight.customText': '## Agenda\n- first item\n- second item\n\nClosing line' } });
  try {
    assert.equal(p.w.PlainSight.coverText(), '## Agenda\n- first item\n- second item\nClosing line');
    const h2 = { type: 'h2', text: 'Agenda' };
    p.type('123456');
    assert.deepEqual(p.blocks(), [h2]);
    assert.equal(p.$('#cover > h2').textContent, 'Agenda', 'heading line renders as a heading');
    p.type('7');
    assert.deepEqual(p.blocks(), [h2, { type: 'li', text: '' }]);
    assert.equal(p.d.querySelectorAll('#cover > ul > li').length, 1, 'the bullet sits inside a ul');
    p.type('first item');
    p.type('x');
    p.type('second item');
    assert.equal(p.d.querySelectorAll('#cover > ul').length, 1, 'consecutive bullets share one list');
    assert.equal(p.d.querySelectorAll('#cover > ul > li').length, 2);
    p.type('x');
    p.type('Closing');
    assert.deepEqual(p.blocks(), [h2, { type: 'li', text: 'first item' }, { type: 'li', text: 'second item' }, { type: 'p', text: 'Closing' }]);
    assert.deepEqual(Array.from(p.$('#cover').children).map((e) => e.tagName), ['H2', 'UL', 'P']);
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 37), 'reference model agrees');
    for (let i = 0; i < 8; i++) p.press('Backspace');     // "Closing" and its break
    assert.deepEqual(p.blocks(), [h2, { type: 'li', text: 'first item' }, { type: 'li', text: 'second item' }]);
    assert.deepEqual(Array.from(p.$('#cover').children).map((e) => e.tagName), ['H2', 'UL']);
    for (let i = 0; i < 12; i++) p.press('Backspace');    // second bullet and its break
    assert.deepEqual(p.blocks(), [h2, { type: 'li', text: 'first item' }]);
    assert.equal(p.d.querySelectorAll('#cover > ul').length, 1, 'the list stays while it has an item');
    for (let i = 0; i < 11; i++) p.press('Backspace');    // first bullet and its break
    assert.deepEqual(p.blocks(), [h2]);
    assert.equal(p.d.querySelectorAll('#cover > ul').length, 0, 'an emptied list is removed');
    assert.equal(await p.readReal(), '123456', '37 keystrokes minus 31 backspaces');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('picking another look on the intro switches the cover in place and keeps the real text', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('abc');
    p.$('#btn-help').click();
    assert.equal(p.$('input[name="mode"][value="book"]').checked, true);
    assert.equal(p.$('input[name="mode"][value="work"]').disabled, false, 'the work document can be picked');
    p.$('input[name="mode"][value="work"]').checked = true;
    p.start();
    await p.settle();
    assert.deepEqual(p.loads, ['book', 'work'], 'the page asked the loader for the work cover');
    assert.equal(p.w.PlainSight.coverId(), 'work');
    assert.equal(p.w.localStorage.getItem('plainSight.cover'), 'work');
    assert.equal(p.d.title, 'Q3 planning notes');
    assert.ok(p.d.body.classList.contains('cover-work'));
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 3), 'the screen is rebuilt for the three keystrokes');
    assert.equal(await p.readReal(), 'abc');
    p.$('#btn-help').click();
    assert.equal(p.$('input[name="mode"][value="work"]').checked, true, 'the intro shows the current cover');
    p.$('input[name="mode"][value="book"]').checked = true;
    p.start();
    await p.settle();
    assert.deepEqual(p.loads, ['book', 'work', 'book']);
    assert.equal(p.w.PlainSight.coverId(), 'book');
    assert.equal(p.d.title, 'Untitled draft');
    assert.equal(await p.readReal(), 'abc');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('covers/work.js: a sans work document of at least 1,200 words with headings, bullets, owners and a decisions section', async () => {
  const c = await importCover('work');
  assert.equal(c.id, 'work');
  assert.equal(c.font, 'sans');
  assert.equal(c.tabTitle, 'Q3 planning notes');
  assert.equal(c.header.left, 'Q3 planning notes');
  assert.deepEqual(c.header.right, ['last edited']);
  const words = (c.text.replace(/^(## |- )/gm, '').match(/\S+/g) || []).length;
  assert.ok(words >= 1200, 'at least 1,200 words, got ' + words);
  assert.ok((c.text.match(/^## /gm) || []).length >= 4, 'short headings');
  assert.ok((c.text.match(/^- /gm) || []).length >= 10, 'bullet lists');
  assert.match(c.text, /^## Decisions$/m, 'a decisions section');
  assert.match(c.text, /^## Action items$/m);
  assert.ok((c.text.match(/Owner: /g) || []).length >= 5, 'action items carry owners');
  const src = readFileSync(path.join(ROOT, 'covers', 'work.js'), 'utf8');
  assert.match(src, /fictional/i, 'the file says its company and people are fictional');
});

test('switching to paper loads that cover: the title block renders, "Page 1 of 1" is static, academic serif, no toolbar', async () => {
  const p = await loadPage({ storage: { 'plainSight.cover': 'paper', 'plainSight.introSeen': '1' } });
  try {
    const c = await importCover('paper');
    assert.equal(p.w.PlainSight.coverId(), 'paper');
    assert.equal(p.d.title, 'Manuscript draft');
    assert.equal(p.$('#header-left').textContent, 'Manuscript draft');
    assert.ok(p.d.body.classList.contains('font-academic') && p.d.body.classList.contains('cover-paper'));
    assert.ok(!p.d.body.classList.contains('cover-work'), 'the toolbar class is not on the body');
    assert.equal(p.$('#title-block').hidden, false, 'title block shown');
    assert.equal(p.$('#paper-title').textContent, c.titleBlock.title);
    assert.equal(p.$('#paper-authors').textContent, c.titleBlock.authors);
    assert.equal(p.$('#paper-affiliation').textContent, c.titleBlock.affiliation);
    assert.equal(p.$('#page-count').textContent, 'Page 1 of 1');
    assert.equal(p.$('#word-count'), null);
    assert.equal(p.$('#last-edited'), null);
    const typed = 'Typing on the manuscript, a sentence long enough to pass the abstract heading.';
    p.type(typed);
    assert.equal(p.$('#page-count').textContent, 'Page 1 of 1', 'static');
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), typed.length));
    assert.equal(p.blocks()[0].type, 'h2', 'the paper opens with the Abstract heading');
    assert.equal(await p.readReal(), typed);
    // Back to the novel: the title block goes away.
    p.$('#btn-help').click();
    p.$('input[name="mode"][value="book"]').checked = true;
    p.start();
    await p.settle();
    assert.equal(p.w.PlainSight.coverId(), 'book');
    assert.equal(p.$('#title-block').hidden, true, 'title block hidden for the novel');
    assert.equal(p.$('#page-count'), null);
    assert.equal(await p.readReal(), typed);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('[1] style citations pass through as plain text; reference entries are typed as text and styled as references', async () => {
  const custom = 'See [1] and [2] for details.\n\n## References\n[1] First reference.\n[2] Second reference.';
  const p = await loadPage({ storage: { 'plainSight.cover': 'paper', 'plainSight.introSeen': '1', 'plainSight.customText': custom } });
  try {
    assert.equal(p.w.PlainSight.coverText(), 'See [1] and [2] for details.\n## References\n[1] First reference.\n[2] Second reference.');
    p.type('a'.repeat(28));
    assert.deepEqual(p.blocks(), [{ type: 'p', text: 'See [1] and [2] for details.' }]);
    assert.equal(p.$('#cover').querySelectorAll('a, sup').length, 0, 'citations are plain text, not links or superscripts');
    p.type('a'.repeat(1 + 10));                 // break, "References"
    assert.deepEqual(p.blocks()[1], { type: 'h2', text: 'References' });
    p.type('a'.repeat(1 + 20));                 // break, "[1] First reference."
    assert.deepEqual(p.blocks()[2], { type: 'ref', text: '[1] First reference.' }, 'the [1] prefix is typed like any text');
    assert.equal(p.$('#cover > p.ref').textContent, '[1] First reference.');
    p.type('a'.repeat(1 + 4));                  // break, "[2] "
    assert.deepEqual(p.blocks()[3], { type: 'ref', text: '[2] ' });
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 28 + 11 + 21 + 5), 'reference model agrees');
    for (let i = 0; i < 5; i++) p.press('Backspace');
    assert.equal(p.blocks().length, 3);
    assert.equal(await p.readReal(), 'a'.repeat(28 + 11 + 21));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('covers/paper.js: academic paper of at least 1,500 words with the required sections, [n] citations and fictional references', async () => {
  const c = await importCover('paper');
  assert.equal(c.id, 'paper');
  assert.equal(c.font, 'academic');
  assert.equal(c.tabTitle, 'Manuscript draft');
  assert.deepEqual(c.header.right, ['page x of y']);
  assert.ok(c.titleBlock && c.titleBlock.title.length > 20 && c.titleBlock.authors && c.titleBlock.affiliation, 'title block present');
  const body = c.text.replace(/^## .*$/gm, '').replace(/^\[\d+\] /gm, '');
  const words = (body.match(/\S+/g) || []).length;
  assert.ok(words >= 1500, 'at least 1,500 words, got ' + words);
  for (const h of ['## Abstract', '## 1. Introduction', '## 2. Method', '## 3. Results', '## 4. Discussion', '## References']) {
    assert.ok(new RegExp('^' + h.replace('.', '\\.') + '$', 'm').test(c.text), 'section present: ' + h);
  }
  assert.ok((c.text.match(/ \[\d\]/g) || []).length >= 6, 'in-text [n] citations');
  const refs = c.text.match(/^\[\d+\] .+$/gm) || [];
  assert.ok(refs.length >= 5, 'reference entries');
  const cited = new Set((c.text.match(/\[(\d+)\]/g) || []).map((m) => m.slice(1, -1)));
  for (const r of refs) assert.ok(cited.has(r.match(/^\[(\d+)\]/)[1]), 'every reference is cited: ' + r.slice(0, 12));
  const src = readFileSync(path.join(ROOT, 'covers', 'paper.js'), 'utf8');
  assert.match(src, /citations are fictional/i, 'the file states that all citations are fictional');
  assert.match(src, /PLACEHOLDER/, 'author and affiliation are marked as placeholders in the code');
});

test('localStorage never holds the hidden text: only the three known keys, and no value contains what was typed', async () => {
  const p = await loadPage();
  try {
    p.start();
    const secret = 'zq7 secret phrase 991';
    p.type(secret);
    const allowed = ['plainSight.introSeen', 'plainSight.cover', 'plainSight.customText', 'plainSight.folderVersion', 'plainSight.saveMode'];
    const check = (label) => {
      const ls = p.w.localStorage;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        const v = ls.getItem(k);
        assert.ok(allowed.includes(k), label + ': unexpected key ' + k + ' (the vault is off in this test)');
        assert.ok(!v.includes('secret phrase') && !v.includes('zq7'), label + ': ' + k + ' holds typed text');
      }
    };
    check('after typing');
    p.$('#btn-save').click();
    await p.submitPassword('pw');
    await p.settle(400);
    check('after save');
    chooseFile(p, makeCoverFile(p.w, await p.downloads[0].blob.text()));
    await p.settle();
    await p.submitPassword('pw');
    await p.settle(400);
    check('after open');
    p.$('#btn-help').click();
    p.$('#custom-text').value = 'my own cover words';
    p.start();
    check('after custom text');
    assert.equal(p.w.localStorage.getItem('plainSight.customText'), 'my own cover words');
    await p.peek();
    p.peekChord();
    check('after peek');
    await sleep(VAULT_SAVE_DELAY_MS + 300);
    check('after the autosave delay, with the vault off');
    assert.equal(await p.readReal(), secret);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('opening a dialog ends an active peek, so the real text is never under the Save prompt or the intro', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('under the dialog');
    await p.peek();
    assert.equal(p.peeking(), true);
    p.$('#btn-save').click();
    assert.equal(p.$('#pw').hidden, false);
    assert.equal(p.peeking(), false, 'opening the password dialog ends the peek');
    assert.equal(p.$('#real').textContent, '');
    assert.equal(p.press('G', { ctrlKey: true, shiftKey: true }), false, 'the chord does nothing while a dialog is open');
    assert.equal(p.peeking(), false);
    p.press('Escape');
    assert.equal(p.$('#pw').hidden, true);
    await p.peek();
    assert.equal(p.peeking(), true);
    p.$('#btn-help').click();
    assert.equal(p.peeking(), false, 'opening the intro ends an active peek');
    assert.equal(p.$('#real').textContent, '');
    p.press('Escape');   // closes the intro
    assert.equal(p.$('#intro').hidden, true);
    assert.equal(await p.readReal(), 'under the dialog');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
test('a cover switch whose import fails keeps the current cover, shows a toast and forgets the failed choice', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('abc');
    p.failCovers.add('work');
    p.$('#btn-help').click();
    p.$('input[name="mode"][value="work"]').checked = true;
    p.start();
    await p.settle();
    assert.deepEqual(p.loads, ['book', 'work']);
    assert.equal(p.w.PlainSight.coverId(), 'book', 'the novel stays on screen');
    assert.equal(p.$('#load-notice').hidden, true, 'no notice while a cover is on screen');
    assert.equal(p.toast(), 'Could not load the cover text');
    assert.equal(p.w.localStorage.getItem('plainSight.cover'), 'book', 'the failed choice is not remembered');
    assert.equal(await p.readReal(), 'abc');
    assert.deepEqual(p.errors, []);
    // With nothing on screen the stored id is dropped and the notice is shown.
    const q = await loadPage({ inject: false, storage: { 'plainSight.cover': 'paper', 'plainSight.introSeen': '1' } });
    try {
      q.w.PlainSight.coverFailed('paper');
      assert.equal(q.w.localStorage.getItem('plainSight.cover'), null);
      assert.equal(q.$('#load-notice').hidden, false);
      assert.deepEqual(q.errors, []);
    } finally { q.close(); }
  } finally { p.close(); }
});

test('device vault: on with a phrase, ciphertext only in localStorage, autosave, the tell, Esc locks and keeps the copy', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('first words');
    await p.vaultOn('correct horse battery staple');
    assert.equal(p.$('#intro').hidden, true, 'Start closed the intro');
    assert.ok(p.d.body.classList.contains('vault-open'), 'the vault is open');
    let dump = p.storageDump();
    assert.ok(dump['plainSight.vault'], 'a vault record exists');
    let rec = JSON.parse(dump['plainSight.vault']);
    assert.equal(rec.format, 'plain-sight');
    assert.equal(Buffer.from(rec.salt, 'base64').length, 16);
    assert.equal(Buffer.from(rec.iv, 'base64').length, 12);
    assert.equal(Buffer.from(rec.data, 'base64').length, 'first words'.length + 16, 'ciphertext of the current text');
    for (const v of Object.values(dump)) assert.ok(!v.includes('first words') && !v.includes('correct horse'), 'neither the text nor the phrase is stored in clear');
    // Autosave after typing.
    p.type(' and more');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const rec2 = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(Buffer.from(rec2.data, 'base64').length, 'first words and more'.length + 16, 'autosave caught the new text');
    assert.notEqual(rec2.iv, rec.iv, 'a fresh IV every save');
    assert.equal(rec2.salt, rec.salt, 'the salt stays with the phrase');
    // Esc saves the words typed since the last autosave, wipes the screen,
    // locks the vault and keeps the copy.
    p.type(' typed just before Esc');
    p.press('Escape');
    assert.equal(p.coverText(), '');
    assert.equal(await p.readReal(), '');
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked');
    await sleep(500);
    const rec3 = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.notEqual(rec3.iv, rec2.iv, 'Esc wrote a fresh save');
    assert.equal(await decryptVault(rec3, 'correct horse battery staple'), 'first words and more typed just before Esc', 'the copy holds everything typed up to Esc');
    // While locked, typing is not saved anywhere and no timer fires later.
    p.type('typed while locked');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    assert.equal(JSON.parse(p.storageDump()['plainSight.vault']).iv, rec3.iv, 'nothing written while locked');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: the unlock chord restores the saved text on a later visit; a wrong phrase does nothing; untick deletes the copy', async () => {
  const p = await loadPage();
  let storage;
  try {
    p.start();
    p.type('kept between visits');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    storage = p.storageDump();
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }

  // A later visit: same browser storage, fresh page, vault locked.
  const q = await loadPage({ storage });
  try {
    assert.equal(q.$('#intro').hidden, true);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'locked on arrival');
    assert.equal(q.coverText(), '', 'nothing on screen');
    // Wrong phrase: the chord does nothing and the typed phrase stays.
    q.type('wrong phrase typed here');
    let r = q.unlockChord();
    assert.equal(r.armed, true, 'Ctrl+E is handled while a vault exists');
    assert.equal(r.fired, true, 'Ctrl+Enter completes the chord');
    await sleep(500);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'still locked');
    assert.equal(await q.readReal(), 'wrong phrase typed here', 'nothing changed');
    q.press('Escape');
    // Right phrase.
    q.type('correct horse battery staple');
    q.unlockChord();
    await sleep(500);
    assert.ok(q.d.body.classList.contains('vault-open'), 'open');
    assert.equal(await q.readReal(), 'kept between visits', 'the saved text replaced the phrase');
    assert.equal(q.coverLength(), 'kept between visits'.length, 'the cover was rebuilt to the saved length');
    for (const v of Object.values(q.storageDump())) assert.ok(!v.includes('kept between') && !v.includes('correct horse'));
    // The chord does nothing while the vault is already open.
    q.type(' plus');
    q.unlockChord();
    await sleep(300);
    assert.equal(await q.readReal(), 'kept between visits plus');
    // Enter outside the window does not fire.
    q.press('Escape');
    q.type('correct horse battery staple');
    q.press('e', { ctrlKey: true });
    const realNow = q.w.Date.now();
    q.w.Date.now = () => realNow + UNLOCK_WINDOW_MS + 1000;
    assert.equal(q.press('Enter', { ctrlKey: true }), false, 'a late Enter is the browser\'s');
    await sleep(300);
    assert.ok(!q.d.body.classList.contains('vault-open'));
    q.w.Date.now = () => realNow;
    // Untick in the intro: the copy is deleted.
    q.$('#btn-help').click();
    assert.equal(q.$('#vault-on').checked, true, 'the intro shows the vault as on');
    q.$('#vault-on').checked = false;
    q.$('#vault-on').dispatchEvent(new q.w.Event('change', { bubbles: true }));
    q.start();
    assert.equal(q.storageDump()['plainSight.vault'], undefined, 'copy deleted');
    assert.equal(q.toast(), 'Saved copy deleted from this device');
    assert.equal(q.press('e', { ctrlKey: true }), false, 'Ctrl+E is the browser\'s again');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: a short or missing phrase is refused and the intro stays open; the box can be left unticked', async () => {
  const p = await loadPage();
  try {
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    assert.equal(p.$('#vault-phrase').disabled, false);
    p.start();
    assert.equal(p.$('#intro').hidden, false, 'no phrase: stays open');
    assert.equal(p.toast(), 'Enter a phrase to keep your text on this device');
    p.$('#vault-phrase').value = 'short one';
    p.start();
    assert.equal(p.$('#intro').hidden, false, 'short phrase: stays open');
    assert.equal(p.toast(), 'Use a phrase of at least 12 characters');
    assert.equal(p.storageDump()['plainSight.vault'], undefined);
    p.$('#vault-on').checked = false;
    p.start();
    assert.equal(p.$('#intro').hidden, true, 'unticked: closes without a vault');
    assert.equal(p.storageDump()['plainSight.vault'], undefined);
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a phrase entered while the copy is locked opens it (text typed before follows), a wrong one is refused, and Esc on the intro applies the choices like Start', async () => {
  const p = await loadPage();
  let storage;
  try {
    p.start();
    p.type('saved earlier');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    storage = p.storageDump();
  } finally { p.close(); }
  const q = await loadPage({ storage });
  try {
    q.type('new words');
    q.$('#btn-help').click();
    assert.equal(q.$('#vault-on').checked, true);
    // Wrong phrase: refused, nothing overwritten, intro stays open.
    q.$('#vault-phrase').value = 'definitely not the phrase';
    q.start();
    await sleep(500);
    assert.equal(q.$('#intro').hidden, false, 'intro stays open');
    assert.equal(q.toast(), 'That phrase does not open the saved copy. Untick the box to delete it and start over.');
    assert.equal(await decryptVault(JSON.parse(q.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'saved earlier', 'the copy is untouched');
    assert.ok(!q.d.body.classList.contains('vault-open'));
    // Right phrase, applied with Esc instead of Start: the copy opens and the new words follow it.
    q.$('#vault-phrase').value = 'correct horse battery staple';
    q.press('Escape');
    await sleep(600);
    assert.equal(q.$('#intro').hidden, true, 'Esc applied the choice and closed the intro');
    assert.ok(q.d.body.classList.contains('vault-open'), 'open');
    assert.equal(q.toast(), 'Saved copy opened');
    assert.equal(await q.readReal(), 'saved earliernew words');
    // A new phrase while open re-keys the copy; the old phrase stops working.
    q.$('#btn-help').click();
    q.$('#vault-phrase').value = 'a brand new phrase here';
    q.start();
    await sleep(600);
    const rec = JSON.parse(q.storageDump()['plainSight.vault']);
    assert.equal(await decryptVault(rec, 'a brand new phrase here'), 'saved earliernew words');
    await assert.rejects(decryptVault(rec, 'correct horse battery staple'), 'the old phrase no longer opens it');
    // Esc on the intro with the box unticked deletes the copy, like Start would.
    q.$('#btn-help').click();
    q.$('#vault-on').checked = false;
    q.press('Escape');
    await sleep(100);
    assert.equal(q.storageDump()['plainSight.vault'], undefined, 'deleted');
    assert.ok(!q.d.body.classList.contains('vault-open'));
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: an unreadable record can be deleted from the intro, and Ctrl+E is left to the browser while the record is unreadable', async () => {
  const p = await loadPage({ storage: { 'plainSight.vault': '{not json', 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.press('e', { ctrlKey: true }), false, 'an unreadable record does not arm the chord');
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, false, 'unreadable: shown as off');
    p.$('#vault-on').checked = false;
    p.start();
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'the orphan record is removed');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: Esc cancels an unlock in flight; keys typed during the derivation are kept after the saved text; another chord resets the armed state', async () => {
  const p = await loadPage();
  let storage;
  try {
    p.start();
    p.type('saved text');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    storage = p.storageDump();
  } finally { p.close(); }
  const q = await loadPage({ storage });
  try {
    // Esc right after the chord: the unlock never lands.
    q.type('correct horse battery staple');
    q.unlockChord();
    q.press('Escape');
    await sleep(700);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'cancelled');
    assert.equal(await q.readReal(), '', 'buffer stays empty');
    // Keys typed while the key derives are kept after the saved text.
    q.type('correct horse battery staple');
    q.unlockChord();
    q.type('ab');
    await sleep(700);
    assert.ok(q.d.body.classList.contains('vault-open'));
    assert.equal(await q.readReal(), 'saved textab');
    q.press('Escape');
    await sleep(300);
    // Ctrl+E, then another chord, then Ctrl+Enter: not an unlock.
    q.type('correct horse battery staple');
    assert.equal(q.press('e', { ctrlKey: true }), true);
    assert.equal(q.press('b', { ctrlKey: true }), false, 'another chord goes to the browser');
    assert.equal(q.press('Enter', { ctrlKey: true }), false, 'and the armed state is gone');
    await sleep(400);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'not unlocked');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: a page hide saves the latest words; nothing is written after a lock', async () => {
  const p = await loadPage();
  try {
    p.start();
    await p.vaultOn('correct horse battery staple');
    p.type('typed then hidden');
    p.w.dispatchEvent(new p.w.Event('pagehide'));
    await sleep(500);
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'typed then hidden');
    p.type(' and more');
    p.press('Escape');
    await sleep(500);
    const afterEsc = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(await decryptVault(afterEsc, 'correct horse battery staple'), 'typed then hidden and more');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    assert.equal(JSON.parse(p.storageDump()['plainSight.vault']).iv, afterEsc.iv, 'no write after the lock');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('storage keys from the 1.0 name are moved to the new ones once, and the old ones removed', async () => {
  const p = await loadPage({ storage: { 'coverStory.introSeen': '1', 'coverStory.cover': 'work', 'coverStory.customText': 'my own words here' } });
  try {
    assert.equal(p.$('#intro').hidden, true, 'a returning visitor does not see the intro again');
    assert.equal(p.w.PlainSight.coverId(), 'work', 'the cover choice carries over');
    assert.equal(p.w.PlainSight.coverText(), 'my own words here', 'custom text carries over');
    const dump = p.storageDump();
    assert.deepEqual(Object.keys(dump).sort(), ['plainSight.cover', 'plainSight.customText', 'plainSight.introSeen']);
    assert.equal(dump['plainSight.cover'], 'work');
    // Existing new keys win over old ones.
    const q = await loadPage({ storage: { 'coverStory.cover': 'work', 'plainSight.cover': 'paper', 'plainSight.introSeen': '1' } });
    try {
      assert.equal(q.w.PlainSight.coverId(), 'paper');
      assert.equal(q.storageDump()['coverStory.cover'], undefined, 'old key removed');
      assert.deepEqual(q.errors, []);
    } finally { q.close(); }
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('save folder: Save writes a plain text file named by the moment into the chosen folder, no password; forgetting the folder brings the download back', async () => {
  const folder = fakeFolder('Notes');
  const p = await loadPage({ folder });
  try {
    assert.equal(p.$('#btn-folder').hidden, false, 'the picker is offered');
    assert.equal(p.$('#btn-folder-forget').hidden, true);
    assert.match(p.$('#folder-status').textContent, /downloads an encrypted/);
    p.$('#btn-folder').click();
    await p.settle();
    assert.equal(p.$('#folder-status').textContent, 'Save writes a plain text file into the folder "Notes".');
    assert.equal(p.$('#btn-folder-forget').hidden, false);
    assert.equal(p.toast(), 'Save now writes into Notes');
    p.start();
    p.type('plain words for the folder');
    p.$('#btn-save').click();
    await p.settle(200);
    assert.equal(p.$('#pw').hidden, true, 'no password dialog');
    assert.equal(folder.written.length, 1, 'one file written');
    assert.match(folder.written[0].name, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/);
    assert.equal(folder.written[0].text, 'plain words for the folder');
    assert.equal(folder.written[0].create, true);
    assert.equal(p.downloads.length, 0, 'no download');
    assert.equal(p.toast(), 'Saved ' + folder.written[0].name + ' in Notes');
    assert.equal(await p.readReal(), 'plain words for the folder', 'saving keeps the text');
    // Forget the folder: Save downloads an encrypted file again.
    p.$('#btn-help').click();
    p.$('#btn-folder-forget').click();
    await p.settle();
    assert.equal(p.toast(), 'Save downloads an encrypted file again');
    assert.equal(p.$('#btn-folder-forget').hidden, true);
    p.start();
    p.$('#btn-save').click();
    assert.equal(p.$('#pw').hidden, false, 'password dialog is back');
    await p.submitPassword('pw-1');
    await p.settle(400);
    assert.equal(p.downloads.length, 1);
    assert.equal(folder.written.length, 1, 'nothing more written to the folder');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('save folder: a cancelled picker changes nothing; a refused permission or a failed write shows a toast and keeps the text', async () => {
  const folder = fakeFolder('Blocked', { permission: 'denied' });
  const p = await loadPage({ folder });
  try {
    folder.cancel = true;
    p.$('#btn-folder').click();
    await p.settle();
    assert.match(p.$('#folder-status').textContent, /downloads an encrypted/, 'cancel leaves the download');
    folder.cancel = false;
    p.$('#btn-folder').click();
    await p.settle();
    p.start();
    p.type('kept');
    p.$('#btn-save').click();
    await p.settle(200);
    assert.equal(p.toast(), 'No permission for the folder. Choose it again under the ? button.');
    assert.equal(folder.written.length, 0);
    assert.equal(await p.readReal(), 'kept');
    // A write that throws.
    folder.handle.queryPermission = async () => 'granted';
    folder.handle.getFileHandle = async () => { throw new Error('disk gone'); };
    p.$('#btn-save').click();
    await p.settle(200);
    assert.equal(p.toast(), 'Could not write to the folder');
    assert.equal(await p.readReal(), 'kept');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('save folder: without the folder API the picker is hidden and Save downloads', async () => {
  const p = await loadPage();
  try {
    assert.equal(typeof p.w.showDirectoryPicker, 'undefined');
    assert.equal(p.$('#btn-folder').hidden, true);
    assert.match(p.$('#folder-status').textContent, /downloads an encrypted/);
    assert.equal(p.$('#folder-help').hidden, false, 'the browser-specific help shows instead');
    p.start();
    p.type('abc');
    p.$('#btn-save').click();
    assert.equal(p.$('#pw').hidden, false);
    p.press('Escape');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Esc during a vault setup or phrase change sticks: no vault appears afterwards, and a phrase change in flight leaves the old copy intact', async () => {
  const p = await loadPage();
  try {
    // New vault: Esc right after Start, before the key is derived.
    p.start();
    p.type('setup words');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();
    p.press('Escape');
    await sleep(700);
    assert.ok(!p.d.body.classList.contains('vault-open'), 'the vault did not reopen after Esc');
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'no copy was written after Esc');
    assert.equal(await p.readReal(), '');
    // Phrase change on an open vault: Esc right after Start keeps the old copy under the old phrase.
    p.type('keep this text');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a different phrase entirely';
    p.start();
    p.press('Escape');
    await sleep(700);
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked');
    const rec = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(await decryptVault(rec, 'correct horse battery staple'), 'keep this text', 'the old copy survives under the old phrase');
    await assert.rejects(decryptVault(rec, 'a different phrase entirely'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Esc during Save still saves the text that was on the page; Esc during Open cancels it and the buffer stays empty', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('words to save');
    p.$('#btn-save').click();
    await p.submitPassword('pw-1');
    p.press('Escape');   // while the key derives
    await sleep(600);
    assert.equal(p.downloads.length, 1);
    assert.equal(p.toast(), 'Saved');
    const f = JSON.parse(await p.downloads[0].blob.text());
    assert.equal(Buffer.from(f.data, 'base64').length, 'words to save'.length + 16, 'the file holds the text, not nothing');
    assert.equal(await p.readReal(), '', 'and the page was wiped');
    // Open, then Esc while the key derives: nothing comes back.
    chooseFile(p, makeCoverFile(p.w, JSON.stringify(f)));
    await p.settle();
    await p.submitPassword('pw-1');
    p.press('Escape');
    await sleep(600);
    assert.equal(p.toast(), 'Open cancelled');
    assert.equal(await p.readReal(), '', 'the file text did not land after Esc');
    assert.equal(p.coverText(), '');
    // Without the Esc the same file opens.
    chooseFile(p, makeCoverFile(p.w, JSON.stringify(f)));
    await p.settle();
    await p.submitPassword('pw-1');
    await sleep(600);
    assert.equal(await p.readReal(), 'words to save');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('another tab deleting or re-keying the copy locks this tab, which never writes the old copy back', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('shared copy');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const original = p.storageDump()['plainSight.vault'];
    // Another tab unticks: the record disappears and a storage event arrives.
    p.w.localStorage.removeItem('plainSight.vault');
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: null }));
    assert.ok(!p.d.body.classList.contains('vault-open'), 'this tab locked');
    assert.equal(p.toast(), 'The saved copy changed in another tab; this tab is locked');
    p.type(' more');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'nothing written back');
    // Re-keyed in another tab: a record with a different salt.
    p.press('Escape');
    p.type('second round');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const mine = JSON.parse(p.storageDump()['plainSight.vault']);
    const theirs = JSON.stringify({ ...mine, salt: Buffer.from(new Uint8Array(16).fill(7)).toString('base64') });
    p.w.localStorage.setItem('plainSight.vault', theirs);
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: JSON.stringify(mine), newValue: theirs }));
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked on a re-key');
    p.type(' x');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    assert.equal(p.storageDump()['plainSight.vault'], theirs, 'the other tab\'s copy stands');
    // The write path checks the salt too, in case the event is late. First drop
    // the foreign copy (untick), then start a fresh vault of our own.
    p.press('Escape');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = false;
    p.start();
    assert.equal(p.storageDump()['plainSight.vault'], undefined);
    p.type('third');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const mine3 = p.storageDump()['plainSight.vault'];
    p.w.localStorage.setItem('plainSight.vault', theirs);   // changed underneath, no event
    p.type(' typed');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    assert.equal(p.storageDump()['plainSight.vault'], theirs, 'a stale key never overwrites another tab\'s copy');
    assert.ok(!p.d.body.classList.contains('vault-open'), 'and the tab locks');
    assert.notEqual(mine3, theirs);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('leaving the page saves an open vault (beforeunload as well as pagehide)', async () => {
  const p = await loadPage();
  try {
    p.start();
    await p.vaultOn('correct horse battery staple');
    p.type('typed then leaving');
    p.w.dispatchEvent(new p.w.Event('beforeunload', { cancelable: true }));
    await sleep(500);
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'typed then leaving');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Esc while a vault write is still encrypting never loses the save: new vault, phrase change and a double Esc', async () => {
  const phrase = 'correct horse battery staple';
  const p = await loadPage({ slowEncrypt: 400 });
  try {
    // New vault: the first write is encrypting when Esc lands.
    p.start();
    p.type('first save');
    await p.vaultOn(phrase);            // returns about 400 ms in: key derived, first write in flight
    p.press('Escape');
    await sleep(1200);
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), phrase), 'first save', 'the copy exists and holds the text');
    // Double Esc: the first Esc's write is encrypting when the second lands.
    p.type(phrase); p.unlockChord(); await sleep(700);
    assert.ok(p.d.body.classList.contains('vault-open'), 'reopened');
    p.type(' second');
    p.press('Escape'); p.press('Escape');
    await sleep(1200);
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), phrase), 'first save second', 'nothing dropped');
    // Phrase change: Esc while the re-keyed copy is being written.
    p.type(phrase); p.unlockChord(); await sleep(700);
    p.type(' third');
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();
    await sleep(350);                   // key derived, the fresh write is encrypting
    p.press('Escape');
    await sleep(1500);
    const rec = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(await decryptVault(rec, 'a brand new phrase here'), 'first save second third', 'the new phrase holds the latest words');
    await assert.rejects(decryptVault(rec, phrase), 'the old phrase is gone');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('untick while the first vault write is still encrypting leaves no copy behind; a storage event for another key does not lock', async () => {
  const phrase = 'correct horse battery staple';
  const p = await loadPage({ slowEncrypt: 400 });
  try {
    p.start();
    p.type('should vanish');
    await p.vaultOn(phrase);
    p.$('#btn-help').click();
    p.$('#vault-on').checked = false;
    p.start();                          // untick during the in-flight write
    await sleep(1200);
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'the late write did not resurrect the copy');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    // Unrelated storage events leave an open vault alone.
    await p.vaultOn(phrase);
    await sleep(900);
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.customText', oldValue: null, newValue: 'x' }));
    assert.ok(p.d.body.classList.contains('vault-open'), 'still open');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('save folder: Esc during the permission prompt still writes the text that was on the page; a name already taken gets a counter', async () => {
  const folder = fakeFolder('Notes', { permissionDelay: 300 });
  const p = await loadPage({ folder });
  try {
    p.$('#btn-folder').click();
    await p.settle();
    p.start();
    p.type('kept despite Esc');
    p.$('#btn-save').click();
    await sleep(100);
    p.press('Escape');                  // during the permission prompt
    await sleep(600);
    assert.equal(folder.written.length, 1);
    assert.equal(folder.written[0].text, 'kept despite Esc');
    assert.equal(await p.readReal(), '', 'the page was wiped');
    // Freeze the clock so two saves share a name.
    const RealDate = p.w.Date;
    const fixed = new RealDate(2026, 9, 20, 14, 55, 3).getTime();
    p.w.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } };
    p.type('one');
    p.$('#btn-save').click();
    await sleep(500);
    p.$('#btn-save').click();
    await sleep(500);
    assert.equal(folder.written[1].name, '2026-10-20 14-55-03.txt');
    assert.equal(folder.written[2].name, '2026-10-20 14-55-03 (2).txt', 'a taken name gets a counter');
    assert.equal(folder.written[2].text, 'one');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('save folder: a folder change in another tab reaches this tab, which stops writing there', async () => {
  const folder = fakeFolder('Notes');
  const p = await loadPage({ folder });
  try {
    p.$('#btn-folder').click();
    await p.settle();
    const announced = p.w.localStorage.getItem('plainSight.folderVersion');
    assert.equal(announced !== null, true, 'the change is announced to other tabs');
    p.start();
    // Another tab forgot the folder: it bumps the announcement; this tab reloads the handle (none here) and drops it.
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.folderVersion', oldValue: '1', newValue: '2' }));
    await p.settle();
    p.type('abc');
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(folder.written.length, 0, 'nothing written to the old folder');
    assert.equal(p.$('#pw').hidden, false, 'Save downloads instead');
    p.press('Escape');
    // Forgetting a folder is announced too, and an open intro in the other tab is redrawn.
    const f2 = fakeFolder('Again');
    p.w.showDirectoryPicker = async () => f2.handle;
    p.$('#btn-help').click();
    p.$('#btn-folder').click();
    await p.settle();
    const afterChoose = p.w.localStorage.getItem('plainSight.folderVersion');
    assert.notEqual(afterChoose, announced, 'choosing announces');
    await sleep(5);
    p.$('#btn-folder-forget').click();
    await p.settle();
    assert.notEqual(p.w.localStorage.getItem('plainSight.folderVersion'), afterChoose, 'forgetting announces');
    // Intro open while the other tab changes the folder: the box redraws.
    p.$('#btn-folder').click();
    await p.settle();
    assert.match(p.$('#folder-status').textContent, /"Again"/);
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.folderVersion', oldValue: '1', newValue: '3' }));
    await p.settle();
    assert.match(p.$('#folder-status').textContent, /downloads/, 'the open intro shows the download state after the other tab dropped the folder');
    p.press('Escape');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('plain .txt download mode: Save downloads a text file named by the moment with no password; the choice persists; it applies in every browser', async () => {
  const p = await loadPage();
  try {
    assert.equal(p.$('input[name="save-mode"][value="sight"]').checked, true, 'encrypted download by default');
    p.$('input[name="save-mode"][value="txt"]').checked = true;
    p.$('input[name="save-mode"][value="txt"]').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    assert.equal(p.w.localStorage.getItem('plainSight.saveMode'), 'txt');
    assert.match(p.$('#folder-status').textContent, /plain \.txt file/);
    p.start();
    p.type('plain download words');
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(p.$('#pw').hidden, true, 'no password dialog');
    assert.equal(p.downloads.length, 1);
    assert.match(p.downloads[0].name, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/);
    assert.equal(await p.downloads[0].blob.text(), 'plain download words');
    assert.equal(p.downloads[0].blob.type, 'text/plain');
    assert.equal(p.toast(), 'Saved ' + p.downloads[0].name);
    assert.equal(await p.readReal(), 'plain download words');
    // The choice survives a new visit.
    const q = await loadPage({ storage: p.storageDump() });
    try {
      assert.equal(q.$('input[name="save-mode"][value="txt"]').checked, true, 'rendered from storage at load');
      q.type('again');
      q.$('#btn-save').click();
      await q.settle();
      assert.equal(q.downloads.length, 1);
      assert.equal(await q.downloads[0].blob.text(), 'again');
      // Back to encrypted.
      q.$('#btn-help').click();
      q.$('input[name="save-mode"][value="sight"]').checked = true;
      q.$('input[name="save-mode"][value="sight"]').dispatchEvent(new q.w.Event('change', { bubbles: true }));
      assert.equal(q.w.localStorage.getItem('plainSight.saveMode'), null);
      q.start();
      q.$('#btn-save').click();
      assert.equal(q.$('#pw').hidden, false, 'password dialog is back');
      q.press('Escape');
      assert.deepEqual(q.errors, []);
    } finally { q.close(); }
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('folder help text fits the browser: Brave gets its setting, Safari and Firefox their download tip, folder-capable browsers no help', async () => {
  const cases = [
    { opts: { brave: true }, expect: /^Brave keeps folder access switched off\. To write into a folder: open brave:\/\/flags\/#file-system-access-api in a new tab, set it to Enabled, click Relaunch, then come back here\.$/ },
    { opts: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' }, expect: /^Safari cannot write into a folder, so Save downloads a file\. To choose where each file goes: Safari menu, Settings, General, "File download location", pick "Ask for each download"\. Safari also opens downloaded text files in TextEdit by itself unless "Open safe files after downloading" is off in the same settings pane; with the plain \.txt choice, that would put your text on screen\.$/ },
    { opts: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:120.0) Gecko/20100101 Firefox/120.0' }, expect: /^Firefox cannot write into a folder, so Save downloads a file\. To choose where each file goes: Settings, General, Downloads, "Always ask you where to save files"\.$/ },
    { opts: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }, expect: /^This browser cannot write into a folder, so Save downloads a file\.$/ }
  ];
  for (const c of cases) {
    const p = await loadPage(c.opts);
    try {
      assert.equal(p.$('#folder-help').hidden, false, JSON.stringify(c.opts));
      assert.match(p.$('#folder-help').textContent, c.expect, JSON.stringify(c.opts));
      assert.equal(p.$('#btn-folder').hidden, true);
      assert.deepEqual(p.errors, []);
    } finally { p.close(); }
  }
  const f = await loadPage({ folder: fakeFolder('Notes') });
  try {
    assert.equal(f.$('#folder-help').hidden, true, 'no help where folders work');
    assert.equal(f.$('#btn-folder').hidden, false);
  } finally { f.close(); }
});

test('vault writes land in the order asked for: a slow older write never overwrites a faster Esc save', async () => {
  const phrase = 'correct horse battery staple';
  // First encryption (the vault's first write) takes 700 ms; every later one 30 ms.
  const p = await loadPage({ slowEncrypt: (n) => (n === 0 ? 700 : 30) });
  try {
    p.start();
    p.type('A');
    await p.vaultOn(phrase);            // key derived, first write ('A') now encrypting slowly
    p.type('B');
    p.press('Escape');                  // the Esc save ('AB') encrypts fast
    await sleep(1300);                  // both have finished
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), phrase), 'AB', 'the newer save is what stays');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('save folder: the file is named by the moment of the click, not the end of the permission prompt; a folder dropped during the prompt is not written to', async () => {
  const folder = fakeFolder('Slow', { permissionDelay: 1500 });
  const p = await loadPage({ folder });
  try {
    p.$('#btn-folder').click();
    await p.settle();
    p.start();
    p.type('named at click');
    const RealDate = p.w.Date;
    let fixed = new RealDate(2026, 9, 21, 9, 30, 0).getTime();
    p.w.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } };
    p.$('#btn-save').click();
    fixed += 2000;                       // the clock moves on while the prompt is up
    await sleep(1900);
    assert.equal(folder.written.length, 1);
    assert.equal(folder.written[0].name, '2026-10-21 09-30-00.txt', 'the name is the click moment');
    // Forget the folder while the prompt is up: nothing is written and the toast says so.
    p.$('#btn-save').click();
    await sleep(100);
    p.$('#btn-help').click();
    p.$('#btn-folder-forget').click();
    await p.settle();
    p.start();
    await sleep(1800);
    assert.equal(folder.written.length, 1, 'no second file');
    assert.equal(p.toast(), 'The folder changed; press Save again');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('untick while a phrase change is still writing leaves no copy behind', async () => {
  const phrase = 'correct horse battery staple';
  const p = await loadPage({ slowEncrypt: 400 });
  try {
    p.start();
    p.type('to be removed');
    await p.vaultOn(phrase);
    await sleep(900);
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();                            // re-key: derive, then a slow fresh write
    await sleep(350);
    p.$('#btn-help').click();
    p.$('#vault-on').checked = false;
    p.start();                            // untick while that write is in flight
    await sleep(1200);
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'the late re-key write did not resurrect the copy');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('forgetting the folder names the download choice correctly, and a choice change in another tab redraws an open intro', async () => {
  const folder = fakeFolder('Notes');
  const p = await loadPage({ folder });
  try {
    p.$('input[name="save-mode"][value="txt"]').checked = true;
    p.$('input[name="save-mode"][value="txt"]').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#btn-folder').click();
    await p.settle();
    p.$('#btn-folder-forget').click();
    await p.settle();
    assert.equal(p.toast(), 'Save downloads a plain .txt file again');
    assert.match(p.$('#folder-status').textContent, /plain \.txt/);
    // Another tab switches the choice back to encrypted: the open intro here redraws.
    p.w.localStorage.removeItem('plainSight.saveMode');
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.saveMode', oldValue: 'txt', newValue: null }));
    assert.match(p.$('#folder-status').textContent, /encrypted/);
    assert.equal(p.$('input[name="save-mode"][value="sight"]').checked, true);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('an intro opened and closed while a first-time setup is still deriving keeps the setup', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('kept');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();                           // key derivation starts
    p.$('#btn-help').click();            // the intro reopens at once
    assert.equal(p.$('#vault-on').checked, true, 'the pending setup shows as ticked');
    assert.match(p.$('#vault-status').textContent, /being set up/);
    p.start();                           // closed again without touching the box
    assert.equal(p.$('#intro').hidden, true, 'the intro closes with an empty phrase field');
    await sleep(900);
    assert.ok(p.d.body.classList.contains('vault-open'), 'the vault opened');
    const record = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(await decryptVault(record, 'correct horse battery staple'), 'kept');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('after another tab deletes the copy, the intro no longer shows a setup as pending', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('gone soon');
    await p.vaultOn('correct horse battery staple');    // setup complete, vault open
    assert.ok(p.d.body.classList.contains('vault-open'));
    p.w.localStorage.removeItem('plainSight.vault');    // another tab unticked
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: 'x', newValue: null }));
    assert.ok(!p.d.body.classList.contains('vault-open'), 'this tab locked');
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, false, 'nothing stored, nothing open, nothing pending');
    assert.match(p.$('#vault-status').textContent, /To come back to your text later/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

async function lockedCopyStorage() {
  const p = await loadPage();
  try {
    p.start();
    p.type('saved text');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    return p.storageDump();
  } finally { p.close(); }
}

test('device vault: an untick during an unlock in flight drops the unlock, so nothing reopens on a deleted copy', async () => {
  const q = await loadPage({ storage: await lockedCopyStorage() });
  try {
    q.type('correct horse battery staple');
    q.unlockChord();                         // the key derives in the background
    q.$('#btn-help').click();
    q.$('#vault-on').checked = false;
    q.start();                               // untick: the copy is deleted at once
    assert.equal(q.toast(), 'Saved copy deleted from this device');
    await sleep(900);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'nothing reopened');
    assert.equal(q.storageDump()['plainSight.vault'] || '', '', 'no copy written back');
    assert.equal(await q.readReal(), 'correct horse battery staple', 'the typed phrase stays as text');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: a copy deleted by another tab during an unlock in flight drops the unlock', async () => {
  const q = await loadPage({ storage: await lockedCopyStorage() });
  try {
    q.type('correct horse battery staple');
    q.unlockChord();
    const original = q.storageDump()['plainSight.vault'];
    q.w.localStorage.removeItem('plainSight.vault');
    q.w.dispatchEvent(new q.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: null }));
    await sleep(900);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'nothing reopened');
    assert.equal(q.storageDump()['plainSight.vault'], undefined, 'no copy written back');
    assert.equal(await q.readReal(), 'correct horse battery staple');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: a copy deleted by another tab while the intro checks a phrase leaves the vault closed and says so', async () => {
  const q = await loadPage({ storage: await lockedCopyStorage() });
  try {
    q.$('#btn-help').click();
    assert.equal(q.$('#vault-on').checked, true, 'a locked copy shows as ticked');
    q.$('#vault-phrase').value = 'correct horse battery staple';
    q.start();                               // the phrase is checked against the copy in the background
    const original = q.storageDump()['plainSight.vault'];
    q.w.localStorage.removeItem('plainSight.vault');
    q.w.dispatchEvent(new q.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: null }));
    await sleep(900);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'not opened on a deleted copy');
    assert.equal(q.$('#intro').hidden, false, 'the intro stays open');
    assert.equal(q.toast(), 'The saved copy changed in another tab');
    assert.equal(q.$('#vault-on').checked, false, 'the intro now shows that no copy exists');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: a failed key derivation drops the setup, says so, and leaves nothing shown as pending', async () => {
  const p = await loadPage({ failDerive: 1 });
  try {
    p.start();
    p.type('not kept');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();
    await sleep(300);
    assert.equal(p.toast(), 'The vault could not be set up');
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, false, 'nothing shown as pending');
    assert.match(p.$('#vault-status').textContent, /To come back to your text later/);
    p.$('#vault-on').checked = true;              // the next try works
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();
    await sleep(900);
    assert.ok(p.d.body.classList.contains('vault-open'));
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'not kept');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: on an address without encryption the intro says so and keeps the vault off', async () => {
  const p = await loadPage({ noSubtle: true });
  try {
    assert.equal(p.$('#intro').hidden, false, 'first visit');
    assert.equal(p.$('#vault-on').disabled, true);
    assert.equal(p.$('#vault-on').checked, false);
    assert.match(p.$('#vault-status').textContent, /no encryption/);
    p.start();
    assert.equal(p.$('#intro').hidden, true);
    p.type('typed anyway');
    assert.equal(await p.readReal(), 'typed anyway');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.equal(p.storageDump()['plainSight.vault'], undefined);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: when the copy changes during the intro phrase check, the cover and custom text picked on the intro are kept', async () => {
  const q = await loadPage({ storage: await lockedCopyStorage() });
  try {
    q.$('#btn-help').click();
    q.$('input[name="mode"][value="work"]').checked = true;
    q.$('#custom-text').value = 'my own cover words';
    q.$('#vault-phrase').value = 'correct horse battery staple';
    q.start();                               // phrase check in flight
    const original = q.storageDump()['plainSight.vault'];
    q.w.localStorage.removeItem('plainSight.vault');
    q.w.dispatchEvent(new q.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: null }));
    await sleep(900);
    assert.equal(q.$('#intro').hidden, false);
    assert.equal(q.toast(), 'The saved copy changed in another tab');
    assert.equal(q.$('input[name="mode"][value="work"]').checked, true, 'the picked cover stays');
    assert.equal(q.$('#custom-text').value, 'my own cover words', 'the custom text stays');
    assert.equal(q.$('#vault-on').checked, false);
    assert.equal(q.$('#vault-phrase').value, '', 'the phrase field is emptied by the redraw');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: a phrase change still deriving is dropped when another tab deletes the copy, and this tab stays locked', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('open here');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const original = p.storageDump()['plainSight.vault'];
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();                               // the new key derives in the background
    p.w.localStorage.removeItem('plainSight.vault');
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: null }));
    assert.equal(p.toast(), 'The saved copy changed in another tab; this tab is locked');
    await sleep(900);
    assert.ok(!p.d.body.classList.contains('vault-open'), 'still locked');
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'no new copy written');
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, false, 'nothing pending, nothing stored');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a copy rewritten by another tab under the same salt during an unlock drops the unlock', async () => {
  const q = await loadPage({ storage: await lockedCopyStorage() });
  try {
    q.type('correct horse battery staple');
    q.unlockChord();
    const original = q.storageDump()['plainSight.vault'];
    const other = JSON.parse(original);
    other.data = other.data.slice(0, -4) + (other.data.endsWith('AAAA') ? 'BBBB' : 'AAAA');   // same salt, other ciphertext
    const rewritten = JSON.stringify(other);
    q.w.localStorage.setItem('plainSight.vault', rewritten);
    q.w.dispatchEvent(new q.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: rewritten }));
    await sleep(900);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'not opened on a copy that changed');
    assert.equal(q.storageDump()['plainSight.vault'], rewritten, 'the other copy is untouched');
    assert.equal(await q.readReal(), 'correct horse battery staple');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: a setup dropped by Esc is not shown as pending', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('short lived');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();                               // derivation starts
    p.press('Escape');                       // wipes the page and drops the setup
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, false, 'nothing pending');
    assert.match(p.$('#vault-status').textContent, /To come back to your text later/);
    p.start();
    await sleep(900);
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.equal(p.storageDump()['plainSight.vault'], undefined);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a phrase change of an open vault shows the open-vault status while it derives, not a setup', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('kept open');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();                               // the new key derives in the background
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, true);
    assert.match(p.$('#vault-status').textContent, /^The vault is open and saving as you type/);
    p.start();
    await sleep(900);
    assert.ok(p.d.body.classList.contains('vault-open'));
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'a brand new phrase here'), 'kept open');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: without encryption, Start and Esc on the intro leave a saved copy alone', async () => {
  const storage = await lockedCopyStorage();
  const original = storage['plainSight.vault'];
  const p = await loadPage({ noSubtle: true, storage });
  try {
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').disabled, true);
    assert.equal(p.$('#vault-on').checked, false);
    p.start();
    assert.equal(p.$('#intro').hidden, true);
    assert.equal(p.storageDump()['plainSight.vault'], original, 'the copy is untouched by Start');
    assert.notEqual(p.toast(), 'Saved copy deleted from this device');
    p.$('#btn-help').click();
    p.press('Escape');
    assert.equal(p.$('#intro').hidden, true);
    assert.equal(p.storageDump()['plainSight.vault'], original, 'the copy is untouched by Esc');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('without encryption, Save and Open say so instead of asking for a password or opening a file', async () => {
  const p = await loadPage({ noSubtle: true, storage: { 'plainSight.introSeen': '1' } });
  try {
    assert.match(p.toast(), /no encryption/, 'a return visit sees the notice');
    p.type('words');
    p.$('#toast').textContent = '';
    p.$('#btn-save').click();
    await p.settle();
    assert.match(p.toast(), /no encryption/);
    assert.equal(p.$('#pw').hidden, true, 'no password dialog');
    let picked = false;
    p.$('#file-input').click = () => { picked = true; };
    p.$('#toast').textContent = '';
    p.$('#btn-open').click();
    assert.match(p.toast(), /no encryption/);
    assert.equal(picked, false, 'no file picker');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a delete by another tab during the first save under a new phrase is not undone by that save', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 0 ? 0 : 1500) });
  try {
    p.start();
    p.type('open here');
    await p.vaultOn('correct horse battery staple');
    const original = p.storageDump()['plainSight.vault'];
    assert.ok(original, 'first copy written at once');
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();                               // the new key derives, then its first save takes 1500 ms
    await sleep(900);                        // the key is derived, the save is in flight
    p.w.localStorage.removeItem('plainSight.vault');
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: null }));
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked at once');
    await sleep(2200);
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'the copy did not come back');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: another tab clearing this site\'s storage locks this tab at once, and nothing shows as pending', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('cleared away');
    await p.vaultOn('correct horse battery staple');
    p.w.localStorage.clear();
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: null, oldValue: null, newValue: null }));
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked');
    assert.equal(p.toast(), 'The saved copy changed in another tab; this tab is locked');
    assert.equal(await p.readReal(), 'cleared away', 'the text on the page stays');
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, false);
    assert.match(p.$('#vault-status').textContent, /To come back to your text later/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: between the key and its first save the status says the vault is open', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 0 ? 1500 : 0) });
  try {
    p.start();
    p.type('first save pending');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();
    await sleep(900);                        // derived, first save still in flight
    assert.ok(p.d.body.classList.contains('vault-open'));
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'nothing written yet');
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, true);
    assert.match(p.$('#vault-status').textContent, /^The vault is open and saving as you type/);
    p.start();
    await sleep(1500);
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'first save pending');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: an open intro on a locked tab follows the copy: a same-salt autosave keeps the typed phrase, a delete unticks the box', async () => {
  const q = await loadPage({ storage: await lockedCopyStorage() });
  try {
    q.$('#btn-help').click();
    assert.equal(q.$('#vault-on').checked, true);
    q.$('#vault-phrase').value = 'correct horse';
    const original = q.storageDump()['plainSight.vault'];
    const other = JSON.parse(original);
    other.data = other.data.slice(0, -4) + (other.data.endsWith('AAAA') ? 'BBBB' : 'AAAA');   // same salt: an autosave elsewhere
    const rewritten = JSON.stringify(other);
    q.w.localStorage.setItem('plainSight.vault', rewritten);
    q.w.dispatchEvent(new q.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: rewritten }));
    assert.equal(q.$('#vault-phrase').value, 'correct horse', 'typing is not disturbed by an autosave');
    assert.equal(q.$('#vault-on').checked, true);
    q.w.localStorage.removeItem('plainSight.vault');
    q.w.dispatchEvent(new q.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: rewritten, newValue: null }));
    assert.equal(q.$('#vault-on').checked, false, 'the box follows the deleted copy');
    assert.match(q.$('#vault-status').textContent, /To come back to your text later/);
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: Esc during a phrase change\'s first save, then a delete in another tab: nothing comes back', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 1 ? 1500 : 0) });   // the first save under the new phrase takes 1500 ms
  try {
    p.start();
    p.type('open here');
    await p.vaultOn('correct horse battery staple');
    const original = p.storageDump()['plainSight.vault'];
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();
    await sleep(900);                        // the new key is derived, its first save is in flight
    assert.ok(p.d.body.classList.contains('vault-open'));
    p.press('Escape');                       // locks; the Esc save queues behind the slow first save
    p.w.localStorage.removeItem('plainSight.vault');
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: null }));
    await sleep(2500);
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'neither the first save nor the Esc save brought the copy back');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a delete event with an unreadable old value still drops the queued saves of a locked tab', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 1 ? 1500 : 0) });
  try {
    p.start();
    p.type('open here');
    await p.vaultOn('correct horse battery staple');
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();
    await sleep(900);                        // the new key is derived, its first save is in flight
    p.press('Escape');                       // locks; the Esc save queues behind it
    p.w.localStorage.removeItem('plainSight.vault');
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: 'not json', newValue: null }));
    await sleep(2500);
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'nothing came back');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: an Esc save that finds the copy gone does not disturb a new vault set up meanwhile', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 1 ? 1500 : 0) });   // the Esc save is the second encryption
  try {
    p.start();
    p.type('old words');
    await p.vaultOn('correct horse battery staple');
    p.press('Escape');                       // the Esc save starts, slowly
    p.w.localStorage.removeItem('plainSight.vault');   // deleted elsewhere meanwhile; no storage event reaches this tab
    p.type('new words');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();                               // a new vault; its first save is immediate
    await sleep(900);
    assert.ok(p.d.body.classList.contains('vault-open'), 'the new vault is open');
    await sleep(1500);                       // the old Esc save lands on a copy that is not its own and is dropped
    assert.ok(p.d.body.classList.contains('vault-open'), 'still open');
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'a brand new phrase here'), 'new words');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a save that finds the copy gone while a phrase change derives locks the tab and drops the change', async () => {
  const p = await loadPage();
  let hidden = false;
  try {
    p.start();
    p.type('fallback path');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    p.w.localStorage.removeItem('plainSight.vault');   // deleted elsewhere; no storage event reaches this tab
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();                               // the new key derives
    Object.defineProperty(p.d, 'hidden', { get: () => hidden, configurable: true });
    hidden = true;
    p.d.dispatchEvent(new p.w.Event('visibilitychange'));   // the save on hide runs under the old key and finds no copy
    await sleep(900);
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked by the failed save');
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'the phrase change wrote nothing');
    hidden = false;
    p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, false, 'nothing pending');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a clear by another document when no copy exists leaves a phrase being typed alone', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('fresh start');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'half a phr';
    p.w.localStorage.clear();
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: null, oldValue: null, newValue: null }));
    assert.equal(p.$('#vault-phrase').value, 'half a phr');
    assert.equal(p.$('#vault-on').checked, true);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: an open intro showing a saved copy unticks at once when another document clears the storage', async () => {
  const q = await loadPage({ storage: await lockedCopyStorage() });
  try {
    q.$('#btn-help').click();
    assert.equal(q.$('#vault-on').checked, true);
    q.w.localStorage.clear();
    q.w.dispatchEvent(new q.w.StorageEvent('storage', { key: null, oldValue: null, newValue: null }));
    assert.equal(q.$('#vault-on').checked, false);
    assert.match(q.$('#vault-status').textContent, /To come back to your text later/);
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('a clear by another document redraws the download choice on an open intro', async () => {
  const p = await loadPage();
  try {
    p.$('input[name="save-mode"][value="txt"]').checked = true;
    p.$('input[name="save-mode"][value="txt"]').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    assert.match(p.$('#folder-status').textContent, /plain \.txt/);
    p.w.localStorage.clear();
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: null, oldValue: null, newValue: null }));
    assert.equal(p.$('input[name="save-mode"][value="sight"]').checked, true);
    assert.match(p.$('#folder-status').textContent, /encrypted/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('untick while a first-time vault setup is still deriving its key leaves no copy and no open vault', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('never stored');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();                           // key derivation starts (about 200 ms)
    p.$('#btn-help').click();
    p.$('#vault-on').checked = false;
    p.start();                           // untick before the key exists
    assert.equal(p.toast(), 'Vault setup cancelled');
    await sleep(900);
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'no copy written');
    assert.ok(!p.d.body.classList.contains('vault-open'), 'not open');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: an intro reopened while this tab\'s own first save is in flight unticks when another tab then deletes the copy', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 0 ? 1500 : 0) });
  try {
    p.start();
    p.type('drawn early');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();
    await sleep(900);                        // key derived, the first save still encrypting
    p.$('#btn-help').click();                // the intro draws an open vault with no copy yet
    assert.match(p.$('#vault-status').textContent, /^The vault is open and saving as you type/);
    await sleep(1200);                       // the first save lands while the intro is open
    const record = p.storageDump()['plainSight.vault'];
    assert.ok(record, 'the copy exists');
    p.w.localStorage.removeItem('plainSight.vault');
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: record, newValue: null }));
    assert.equal(p.toast(), 'The saved copy changed in another tab; this tab is locked');
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked');
    assert.equal(p.$('#vault-on').checked, false, 'the intro follows the deleted copy');
    assert.match(p.$('#vault-status').textContent, /To come back to your text later/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: an intro reopened during this tab\'s own setup keeps a phrase being typed when another tab autosaves under the same salt', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 0 ? 1500 : 0) });
  try {
    p.start();
    p.type('same salt elsewhere');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();
    await sleep(900);                        // key derived, the first save still encrypting
    p.$('#btn-help').click();                // reopened before any copy exists
    p.$('#vault-phrase').value = 'a new phr';   // a phrase change half typed
    await sleep(1200);                       // this tab's first save lands under the open intro
    const original = p.storageDump()['plainSight.vault'];
    assert.ok(original, 'the copy exists');
    assert.equal(p.$('#vault-phrase').value, 'a new phr', 'this tab\'s own save leaves the phrase alone');
    const other = JSON.parse(original);
    other.data = other.data.slice(0, -4) + (other.data.endsWith('AAAA') ? 'BBBB' : 'AAAA');   // same salt: an autosave elsewhere
    const rewritten = JSON.stringify(other);
    p.w.localStorage.setItem('plainSight.vault', rewritten);
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: rewritten }));
    assert.equal(p.$('#vault-phrase').value, 'a new phr', 'an autosave elsewhere leaves the phrase alone');
    assert.ok(p.d.body.classList.contains('vault-open'), 'a same-salt save does not lock this tab');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: an intro reopened while the key derives says the vault is open as soon as the key exists', async () => {
  const p = await loadPage({ slowDerive: (n) => (n === 0 ? 300 : 0), slowEncrypt: (n) => (n === 0 ? 1500 : 0) });
  try {
    p.start();
    p.type('status follows');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();
    p.$('#btn-help').click();                // reopened during the derivation
    assert.match(p.$('#vault-status').textContent, /^Your phrase is being set up/);
    await sleep(1000);                       // the key exists, the first save is still in flight
    assert.ok(p.d.body.classList.contains('vault-open'));
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'nothing written yet');
    assert.equal(p.$('#vault-on').checked, true);
    assert.match(p.$('#vault-status').textContent, /^The vault is open and saving as you type/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a key derivation that fails after a newer setup started says nothing and leaves the newer setup pending', async () => {
  const p = await loadPage({ failDerive: (n) => (n === 0 ? 500 : false), slowDerive: (n) => (n === 1 ? 1000 : 0) });
  try {
    p.start();
    p.type('second try wins');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'first phrase fails';
    p.start();                               // this derivation is refused 500 ms in
    p.$('#btn-help').click();                // the intro shows the pending setup
    assert.equal(p.$('#vault-on').checked, true);
    assert.match(p.$('#vault-status').textContent, /^Your phrase is being set up/);
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();                               // a newer setup starts while the first still derives
    await sleep(700);                        // the first has failed by now; the newer one still derives
    assert.notEqual(p.toast(), 'The vault could not be set up', 'a superseded failure says nothing');
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, true, 'the newer setup still shows as pending');
    assert.match(p.$('#vault-status').textContent, /^Your phrase is being set up/);
    p.start();                               // closing with an empty phrase keeps the setup
    await sleep(1200);
    assert.ok(p.d.body.classList.contains('vault-open'));
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'second try wins');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: an intro left open across the 10-minute wipe shows the lock, not an open vault (DM-129)', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('kept at the wipe');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    p.$('#btn-help').click();                // the intro left open
    assert.match(p.$('#vault-status').textContent, /^The vault is open and saving as you type/);
    const realNow = p.w.Date.now();
    let fakeNow = realNow;
    p.w.Date.now = () => fakeNow;
    const setHidden = (hidden) => {
      Object.defineProperty(p.d, 'hidden', { get: () => hidden, configurable: true });
      p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    };
    setHidden(true);
    fakeNow += TEN_MINUTES + 1000;
    setHidden(false);                        // the wipe locks the vault with the intro still open
    assert.equal(p.toast(), 'Cleared after 10 minutes in the background');
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked by the wipe');
    assert.equal(p.$('#vault-on').checked, true, 'the copy is still on the device');
    assert.match(p.$('#vault-status').textContent, /^A saved copy is on this device/);
    await sleep(600);                        // the save made at the wipe lands
    assert.match(p.$('#vault-status').textContent, /^A saved copy is on this device/);
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'kept at the wipe');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: an open intro follows the silent lock when the open vault\'s own save finds its copy gone (DM-129)', async () => {
  const p = await loadPage();
  let hidden = false;
  try {
    p.start();
    p.type('silent lock');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    p.w.localStorage.removeItem('plainSight.vault');   // deleted elsewhere; no storage event reaches this tab
    p.$('#btn-help').click();                // the intro, drawn while the vault still looks open
    assert.match(p.$('#vault-status').textContent, /^The vault is open and saving as you type/);
    Object.defineProperty(p.d, 'hidden', { get: () => hidden, configurable: true });
    hidden = true;
    p.d.dispatchEvent(new p.w.Event('visibilitychange'));   // the save on hide finds no copy and locks the tab
    await sleep(600);
    hidden = false;
    p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked');
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'nothing written');
    assert.match(p.$('#vault-status').textContent, /To come back to your text later/, 'the status follows the lock and the missing copy');
    assert.equal(p.$('#vault-on').checked, true, 'the box keeps the person\'s choice until Start');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a same-salt save by another tab leaves a locked tab\'s Esc save alone, so the last save wins', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 1 ? 1500 : 0) });   // the Esc save is the second encryption
  try {
    p.start();
    p.type('kept after Esc');
    await p.vaultOn('correct horse battery staple');
    const original = p.storageDump()['plainSight.vault'];
    p.press('Escape');                       // locks; the Esc save encrypts slowly
    const other = JSON.parse(original);
    other.data = other.data.slice(0, -4) + (other.data.endsWith('AAAA') ? 'BBBB' : 'AAAA');   // same salt: another tab's save
    const rewritten = JSON.stringify(other);
    p.w.localStorage.setItem('plainSight.vault', rewritten);
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: rewritten }));
    await sleep(2200);
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'kept after Esc', 'the Esc save landed after the other tab\'s save');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a re-key by another tab while this tab is locked drops its queued first save and Esc save', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 1 ? 1500 : 0) });   // the first save under the new phrase takes 1500 ms
  try {
    const rekeyed = await encryptVaultRecord('the other tab\'s text', 'phrase of the other tab');
    p.start();
    p.type('open here');
    await p.vaultOn('correct horse battery staple');
    const original = p.storageDump()['plainSight.vault'];
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();
    await sleep(900);                        // the new key is derived, its first save is in flight
    assert.ok(p.d.body.classList.contains('vault-open'));
    p.press('Escape');                       // locks; the Esc save queues behind the slow first save
    p.w.localStorage.setItem('plainSight.vault', rekeyed);   // another tab re-keys the copy meanwhile
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: rekeyed }));
    await sleep(2500);
    assert.equal(p.storageDump()['plainSight.vault'], rekeyed, 'neither the first save nor the Esc save overwrote the other tab\'s copy');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: an Esc save that finds the copy gone in a locked tab is dropped without an error', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 1 ? 1500 : 0) });   // the Esc save is the second encryption
  try {
    p.start();
    p.type('gone meanwhile');
    await p.vaultOn('correct horse battery staple');
    p.press('Escape');                       // locks; the Esc save encrypts slowly
    p.w.localStorage.removeItem('plainSight.vault');   // deleted elsewhere; no storage event reaches this tab
    await sleep(2200);
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'the save is dropped');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.deepEqual(p.errors, [], 'nothing thrown on the way');
  } finally { p.close(); }
});

test('device vault: an untick made on the intro stands through this tab\'s own autosave, and Start then deletes the copy (DM-130)', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('private words');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    p.type(' and more');                     // an autosave is due 1.5 s on
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, true);
    p.$('#vault-phrase').value = 'an abandoned new phrase';   // a new phrase typed, then the person changes their mind
    p.$('#vault-on').checked = false;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    const before = p.storageDump()['plainSight.vault'];
    await sleep(VAULT_SAVE_DELAY_MS + 400);  // the autosave lands under the open intro
    assert.notEqual(p.storageDump()['plainSight.vault'], before, 'the autosave landed');
    assert.equal(p.$('#vault-on').checked, false, 'this tab\'s own save does not tick the box again');
    p.start();
    await sleep(300);
    assert.equal(p.toast(), 'Saved copy deleted from this device');
    assert.ok(!p.storageDump()['plainSight.vault'], 'the copy is deleted, not re-keyed under the abandoned phrase');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: an untick made on an intro reopened during the setup stands when the key arrives, and Start then leaves no copy (DM-130)', async () => {
  const p = await loadPage({ slowDerive: (n) => (n === 0 ? 600 : 0) });
  try {
    p.start();
    p.type('first words');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();                               // the setup derives for 600 ms and more
    p.$('#btn-help').click();                // reopened during the derivation
    assert.match(p.$('#vault-status').textContent, /^Your phrase is being set up/);
    p.$('#vault-on').checked = false;        // the person cancels
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    await sleep(1200);                       // the key arrives and the first write lands
    assert.equal(p.$('#vault-on').checked, false, 'the key\'s arrival does not tick the box again');
    p.start();
    await sleep(300);
    assert.ok(!p.d.body.classList.contains('vault-open'), 'no vault');
    assert.ok(!p.storageDump()['plainSight.vault'], 'no copy');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: an untick made on the intro stands across the 10-minute wipe, and Start then deletes the copy (DM-130)', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('kept until Start');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    p.$('#btn-help').click();
    p.$('#vault-on').checked = false;        // the person wants the copy deleted
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    const realNow = p.w.Date.now();
    let fakeNow = realNow;
    p.w.Date.now = () => fakeNow;
    const setHidden = (hidden) => {
      Object.defineProperty(p.d, 'hidden', { get: () => hidden, configurable: true });
      p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    };
    setHidden(true);
    fakeNow += TEN_MINUTES + 1000;
    setHidden(false);                        // the wipe locks the vault with the intro still open
    assert.equal(p.toast(), 'Cleared after 10 minutes in the background');
    assert.equal(p.$('#vault-on').checked, false, 'the wipe does not tick the box again');
    assert.match(p.$('#vault-status').textContent, /^A saved copy is on this device/);
    await sleep(600);                        // the save made at the wipe lands
    p.start();
    await sleep(300);
    assert.equal(p.toast(), 'Saved copy deleted from this device');
    assert.ok(!p.storageDump()['plainSight.vault'], 'the copy is deleted');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a phrase typed into the intro but not submitted does not survive the 10-minute wipe (DM-131)', async () => {
  const q = await loadPage({ storage: await lockedCopyStorage() });
  try {
    q.type('typed later');                   // text on the page, so the wipe arms
    q.$('#btn-help').click();
    q.$('#vault-phrase').value = 'correct horse battery staple';   // typed, not submitted
    const realNow = q.w.Date.now();
    let fakeNow = realNow;
    q.w.Date.now = () => fakeNow;
    const setHidden = (hidden) => {
      Object.defineProperty(q.d, 'hidden', { get: () => hidden, configurable: true });
      q.d.dispatchEvent(new q.w.Event('visibilitychange'));
    };
    setHidden(true);
    fakeNow += TEN_MINUTES + 1000;
    setHidden(false);
    assert.equal(q.toast(), 'Cleared after 10 minutes in the background');
    assert.equal(q.$('#vault-phrase').value, '', 'the phrase typed before the wipe is gone');
    q.press('Escape');                       // someone at the machine: Esc on the intro applies it like Start
    await sleep(900);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'nothing opened');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('a password typed into the Open dialog but not submitted does not survive the 10-minute wipe: the wipe ends the dialog (DM-131)', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('file contents');
    p.$('#btn-save').click();
    await p.submitPassword('file password');
    await p.settle(400);
    const json = await p.downloads[0].blob.text();
    p.press('Escape');
    p.type('other text');                    // the buffer is not empty, so the wipe arms
    chooseFile(p, makeCoverFile(p.w, json));
    await p.settle();
    assert.equal(p.$('#pw').hidden, false, 'the dialog waits for the password');
    p.$('#pw-input').value = 'file password';   // typed, not submitted
    const realNow = p.w.Date.now();
    let fakeNow = realNow;
    p.w.Date.now = () => fakeNow;
    const setHidden = (hidden) => {
      Object.defineProperty(p.d, 'hidden', { get: () => hidden, configurable: true });
      p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    };
    setHidden(true);
    fakeNow += TEN_MINUTES + 1000;
    setHidden(false);
    assert.equal(p.toast(), 'Cleared after 10 minutes in the background');
    assert.equal(p.$('#pw').hidden, true, 'the wipe ended the waiting dialog');
    p.$('#pw-ok').click();                   // someone at the machine
    await sleep(600);
    assert.equal(await p.readReal(), '', 'nothing opened');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: another tab\'s re-key empties a phrase half typed on this tab\'s open intro, although this tab\'s own saves leave it alone', async () => {
  const p = await loadPage();
  try {
    const rekeyed = await encryptVaultRecord('the other tab\'s text', 'phrase of the other tab');
    p.start();
    p.type('open here');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const original = p.storageDump()['plainSight.vault'];
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'half a phr';
    p.w.localStorage.setItem('plainSight.vault', rekeyed);
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: rekeyed }));
    assert.equal(p.toast(), 'The saved copy changed in another tab; this tab is locked');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.equal(p.$('#vault-phrase').value, '', 'the phrase meant for the old copy is gone');
    assert.equal(p.$('#vault-on').checked, true, 'the box shows the other tab\'s locked copy');
    assert.match(p.$('#vault-status').textContent, /^A saved copy is on this device/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a copy made with another iteration count keeps that count through this tab\'s saves, so it still opens on the next visit', async () => {
  const record = await encryptVaultRecord('old words', 'correct horse battery staple', 1000);   // made elsewhere, at the lowest count the page accepts
  const p = await loadPage({ storage: { 'plainSight.vault': record, 'plainSight.introSeen': '1' } });
  try {
    p.type('correct horse battery staple');
    p.unlockChord();
    await sleep(900);
    assert.ok(p.d.body.classList.contains('vault-open'), 'opened at the record\'s own count');
    p.type(' and new');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const saved = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(saved.iterations, 1000, 'the saved record states the count the key was made with');
    assert.equal(await decryptVault(saved, 'correct horse battery staple'), 'old words and new');
    const q = await loadPage({ storage: p.storageDump() });   // the next visit
    try {
      q.type('correct horse battery staple');
      q.unlockChord();
      await sleep(900);
      assert.ok(q.d.body.classList.contains('vault-open'), 'the next visit opens the copy');
      assert.equal(await q.readReal(), 'old words and new');
      assert.deepEqual(q.errors, []);
    } finally { q.close(); }
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: when the browser refuses to store the copy, the vault says so and does not pretend to be open', async () => {
  const p = await loadPage();
  const proto = Object.getPrototypeOf(p.w.localStorage);
  const original = proto.setItem;
  try {
    p.start();
    p.type('nowhere to keep this');
    proto.setItem = function (key, value) {
      if (key === 'plainSight.vault') { const e = new p.w.Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      return original.call(this, key, value);
    };
    await p.vaultOn('correct horse battery staple');
    await sleep(600);
    assert.ok(!p.d.body.classList.contains('vault-open'), 'not shown as open');
    assert.equal(p.toast(), 'The copy could not be kept on this device: storage is full or blocked');
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'nothing stored');
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, false, 'nothing shown as pending or open');
    assert.deepEqual(p.errors, []);
  } finally { proto.setItem = original; p.close(); }
});

test('the phrase and password fields keep the browser\'s password manager out: no generated-password hint, manager ignore marks, a masked text field where the browser can mask one, a password field elsewhere', async () => {
  const p = await loadPage({ cssSupports: true });
  const q = await loadPage();
  try {
    for (const id of ['#vault-phrase', '#pw-input']) {
      const el = p.$(id);
      assert.equal(el.getAttribute('autocomplete'), 'off', id + ' does not ask for a generated password');
      assert.equal(el.getAttribute('data-1p-ignore'), '', id + ' tells 1Password to stay out');
      assert.equal(el.getAttribute('data-lpignore'), 'true', id + ' tells LastPass to stay out');
      assert.equal(el.getAttribute('data-bwignore'), '', id + ' tells Bitwarden to stay out');
      assert.equal(el.getAttribute('autocorrect'), 'off');
      assert.equal(el.getAttribute('autocapitalize'), 'off');
      assert.equal(el.type, 'text', id + ' is a masked text field, which no password manager treats as a password');
      assert.ok(el.classList.contains('masked'), id + ' carries the mask class');
      assert.ok(el.matches('.card input.secret'), id + ' keeps the page\'s field styling, which no longer depends on the type');
      assert.equal(q.$(id).type, 'password', id + ' stays a password field where the browser cannot mask a text field');
      assert.ok(q.$(id).matches('.card input.secret'));
    }
    const css = p.$('style').textContent;
    assert.match(css, /\.secret\.masked\s*\{[^}]*-webkit-text-security:\s*disc/, 'the mask lives in the stylesheet');
    assert.match(css, /\.card input\.secret\s*\{/, 'the field rule selects the class');
    assert.ok(!/input\[type="password"\]/.test(css), 'no rule depends on the password type any more');
    assert.ok(p.$('#vault-phrase').matches('.vault input.secret:disabled'), 'the disabled phrase field keeps its disabled look');
    assert.deepEqual(p.errors, []);
    assert.deepEqual(q.errors, []);
  } finally { p.close(); q.close(); }
});

test('the Save and Open buttons and the word count carry no tooltip that names encryption or the file format', async () => {
  const p = await loadPage();
  try {
    p.start();
    for (const sel of ['#btn-save', '#btn-open', '#word-count']) assert.equal(p.$(sel).title, '', sel + ' has no tooltip');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a copy made with another iteration count opened through the intro keeps that count in its saves', async () => {
  const record = await encryptVaultRecord('old words', 'correct horse battery staple', 1000);
  const p = await loadPage({ storage: { 'plainSight.vault': record, 'plainSight.introSeen': '1' } });
  try {
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, true, 'the locked copy shows');
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();                               // the phrase check opens the copy
    await sleep(900);
    assert.ok(p.d.body.classList.contains('vault-open'));
    p.type(' and new');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const saved = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(saved.iterations, 1000, 'the saved record states the count the key was made with');
    assert.equal(await decryptVault(saved, 'correct horse battery staple'), 'old words and new');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: with nothing typed on the page, a phrase typed on the intro over a locked copy still goes with the 10-minute wipe (DM-132)', async () => {
  const q = await loadPage({ storage: await lockedCopyStorage() });
  try {
    q.$('#btn-help').click();
    q.$('#vault-phrase').value = 'correct horse battery staple';   // typed, not submitted; the buffer is empty
    const realNow = q.w.Date.now();
    let fakeNow = realNow;
    q.w.Date.now = () => fakeNow;
    const setHidden = (hidden) => {
      Object.defineProperty(q.d, 'hidden', { get: () => hidden, configurable: true });
      q.d.dispatchEvent(new q.w.Event('visibilitychange'));
    };
    setHidden(true);
    fakeNow += TEN_MINUTES + 1000;
    setHidden(false);
    assert.equal(q.toast(), 'Cleared after 10 minutes in the background');
    assert.equal(q.$('#vault-phrase').value, '', 'the phrase typed before the absence is gone');
    q.press('Escape');                       // someone at the machine
    await sleep(900);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'nothing opened');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('with nothing typed on the page, a password typed into the Open dialog still goes with the 10-minute wipe (DM-132)', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('file contents');
    p.$('#btn-save').click();
    await p.submitPassword('file password');
    await p.settle(400);
    const json = await p.downloads[0].blob.text();
    p.press('Escape');                       // the buffer is empty from here on
    chooseFile(p, makeCoverFile(p.w, json));
    await p.settle();
    assert.equal(p.$('#pw').hidden, false);
    p.$('#pw-input').value = 'file password';   // typed, not submitted
    const realNow = p.w.Date.now();
    let fakeNow = realNow;
    p.w.Date.now = () => fakeNow;
    const setHidden = (hidden) => {
      Object.defineProperty(p.d, 'hidden', { get: () => hidden, configurable: true });
      p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    };
    setHidden(true);
    fakeNow += TEN_MINUTES + 1000;
    setHidden(false);
    assert.equal(p.$('#pw').hidden, true, 'the wipe ended the waiting dialog');
    p.$('#pw-ok').click();                   // someone at the machine
    await sleep(600);
    assert.equal(await p.readReal(), '', 'nothing opened');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a dropped write inside the cross-tab sync window leaves the intro following the copy it drew, so the other tab\'s event still redraws it', async () => {
  const p = await loadPage();
  let hidden = false;
  try {
    const rekeyed = await encryptVaultRecord('the other tab\'s text', 'phrase of the other tab');
    p.start();
    p.type('open here');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const original = p.storageDump()['plainSight.vault'];
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'half a phr';
    p.w.localStorage.setItem('plainSight.vault', rekeyed);   // the other tab's re-key is in storage, its event not yet delivered
    Object.defineProperty(p.d, 'hidden', { get: () => hidden, configurable: true });
    hidden = true;
    p.d.dispatchEvent(new p.w.Event('visibilitychange'));   // this tab's save on hide finds another salt and is dropped
    await sleep(600);
    hidden = false;
    p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    assert.equal(p.$('#vault-phrase').value, 'half a phr', 'the dropped write disturbs nothing on the intro');
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: rekeyed }));   // the event arrives
    assert.equal(p.$('#vault-phrase').value, '', 'the other tab\'s change redraws the intro and empties the phrase meant for the old copy');
    assert.equal(p.$('#vault-on').checked, true, 'the box shows the other tab\'s locked copy');
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('without encryption, the 10-minute wipe leaves the intro\'s no-encryption notice in place', async () => {
  const p = await loadPage({ noSubtle: true });
  try {
    p.start();
    p.type('typed without encryption');
    p.$('#btn-help').click();
    assert.match(p.$('#vault-status').textContent, /no encryption/);
    const realNow = p.w.Date.now();
    let fakeNow = realNow;
    p.w.Date.now = () => fakeNow;
    const setHidden = (h) => {
      Object.defineProperty(p.d, 'hidden', { get: () => h, configurable: true });
      p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    };
    setHidden(true);
    fakeNow += TEN_MINUTES + 1000;
    setHidden(false);
    assert.equal(p.toast(), 'Cleared after 10 minutes in the background');
    assert.match(p.$('#vault-status').textContent, /no encryption/, 'the notice stays');
    assert.equal(p.$('#vault-on').disabled, true);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('where the browser says it can mask a text field but the mask does not reach the field, the phrase and password fields stay password fields', async () => {
  const p = await loadPage({ cssSupports: true, maskComputed: false });
  try {
    for (const id of ['#vault-phrase', '#pw-input']) {
      assert.equal(p.$(id).type, 'password', id + ' fell back to a password field');
      assert.ok(!p.$(id).classList.contains('masked'), id + ' carries no mask class');
    }
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('an intro left open with nothing typed anywhere does not arm the 10-minute wipe', async () => {
  const p = await loadPage({ storage: { 'plainSight.introSeen': '1' } });
  try {
    p.$('#btn-help').click();                // open, the phrase field empty, the buffer empty
    const realNow = p.w.Date.now();
    let fakeNow = realNow;
    p.w.Date.now = () => fakeNow;
    const setHidden = (h) => {
      Object.defineProperty(p.d, 'hidden', { get: () => h, configurable: true });
      p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    };
    setHidden(true);
    fakeNow += TEN_MINUTES + 1000;
    setHidden(false);
    assert.equal(p.toast(), '', 'nothing to clear, so no wipe and no toast');
    assert.equal(p.$('#intro').hidden, false, 'the intro is still open');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a phrase change of a copy made at another count saves under the page\'s own count', async () => {
  const record = await encryptVaultRecord('old words', 'correct horse battery staple', 1000);
  const p = await loadPage({ storage: { 'plainSight.vault': record, 'plainSight.introSeen': '1' } });
  try {
    p.type('correct horse battery staple');
    p.unlockChord();
    await sleep(900);
    assert.ok(p.d.body.classList.contains('vault-open'));
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();                               // the phrase change derives a new key at the page's count
    await sleep(900);
    const saved = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(saved.iterations, 310000, 'the new copy states the count its key was made with');
    assert.equal(await decryptVault(saved, 'a brand new phrase here'), 'old words');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: the save at Esc states the count the key was made with, for a copy made at another count', async () => {
  const record = await encryptVaultRecord('old words', 'correct horse battery staple', 1000);
  const p = await loadPage({ storage: { 'plainSight.vault': record, 'plainSight.introSeen': '1' } });
  try {
    p.type('correct horse battery staple');
    p.unlockChord();
    await sleep(900);
    assert.ok(p.d.body.classList.contains('vault-open'));
    p.type(' then Esc');
    p.press('Escape');                       // the Esc save runs under the key derived at 1,000 rounds
    await sleep(600);
    const saved = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(saved.iterations, 1000, 'the saved record states the count the key was made with');
    assert.equal(await decryptVault(saved, 'correct horse battery staple'), 'old words then Esc');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a refused autosave updates an open intro\'s status: locked, with the earlier copy still on the device', async () => {
  const p = await loadPage();
  const proto = Object.getPrototypeOf(p.w.localStorage);
  const original = proto.setItem;
  try {
    p.start();
    p.type('kept once');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);  // the first copy is stored
    p.type(' then refused');                 // an autosave is due 1.5 s on
    p.$('#btn-help').click();
    assert.match(p.$('#vault-status').textContent, /^The vault is open and saving as you type/);
    proto.setItem = function (key, value) {
      if (key === 'plainSight.vault') { const e = new p.w.Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      return original.call(this, key, value);
    };
    await sleep(VAULT_SAVE_DELAY_MS + 400);  // the autosave is refused under the open intro
    assert.equal(p.toast(), 'The copy could not be kept on this device: storage is full or blocked');
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked');
    assert.match(p.$('#vault-status').textContent, /^A saved copy is on this device/, 'the status follows the lock; the earlier copy is still there');
    assert.deepEqual(p.errors, []);
  } finally { proto.setItem = original; p.close(); }
});

test('device vault: an older key\'s refused autosave does not lock a vault re-keyed meanwhile', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 1 ? 1500 : 0) });   // the autosave after the setup is the second encryption
  const proto = Object.getPrototypeOf(p.w.localStorage);
  const original = proto.setItem;
  try {
    p.start();
    p.type('old words');
    await p.vaultOn('correct horse battery staple');
    p.type(' and more');                     // an autosave under the first key is due 1.5 s on and then encrypts for 1.5 s
    await sleep(VAULT_SAVE_DELAY_MS + 200);
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a brand new phrase here';
    p.start();                               // a phrase change: the new key derives while the old autosave still encrypts
    await sleep(500);
    assert.ok(p.d.body.classList.contains('vault-open'), 'open under the new phrase while the old save still encrypts');
    let refused = 0;
    proto.setItem = function (key, value) {
      if (key === 'plainSight.vault' && refused === 0) { refused += 1; const e = new p.w.Error('quota'); e.name = 'QuotaExceededError'; throw e; }   // the next vault write is refused, once
      return original.call(this, key, value);
    };
    await sleep(1200);                       // the old key's save is refused; the new phrase's first write follows and lands
    assert.equal(refused, 1, 'the old key\'s save was the one refused');
    assert.equal(p.toast(), 'The copy could not be kept on this device: storage is full or blocked');
    assert.ok(p.d.body.classList.contains('vault-open'), 'the re-keyed vault is not locked by an older key\'s refusal');
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'a brand new phrase here'), 'old words and more');
    assert.deepEqual(p.errors, []);
  } finally { proto.setItem = original; p.close(); }
});

test('device vault: a locked tab\'s refused Esc save says so and throws nothing', async () => {
  const p = await loadPage({ slowEncrypt: (n) => (n === 1 ? 1500 : 0) });   // the Esc save is the second encryption
  const proto = Object.getPrototypeOf(p.w.localStorage);
  const original = proto.setItem;
  try {
    p.start();
    p.type('old words');
    await p.vaultOn('correct horse battery staple');
    p.press('Escape');                       // locks; the Esc save encrypts slowly
    await sleep(300);
    proto.setItem = function (key, value) {
      if (key === 'plainSight.vault') { const e = new p.w.Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      return original.call(this, key, value);
    };
    await sleep(1600);                       // the Esc save is refused in a locked tab
    assert.equal(p.toast(), 'The copy could not be kept on this device: storage is full or blocked');
    assert.ok(!p.d.body.classList.contains('vault-open'), 'still locked');
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'old words', 'the earlier copy stays');
    assert.deepEqual(p.errors, [], 'nothing thrown on the way');
  } finally { proto.setItem = original; p.close(); }
});

test('the folder note says that plain files are indexed, previewed, backed up and, in a synced folder, uploaded', async () => {
  const p = await loadPage();
  try {
    assert.match(p.$('#folder-note').textContent, /the computer indexes, previews and backs it up like any document; a synced folder uploads it/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the one-time key migration keeps the old key when the new one cannot be written', async () => {
  const p = await loadPage({ storage: { 'coverStory.customText': 'old custom text' } });
  try {
    assert.equal(p.storageDump()['plainSight.customText'], 'old custom text', 'migrated when storage works');
    assert.equal(p.storageDump()['coverStory.customText'], undefined, 'the old key goes once the new one holds the value');
  } finally { p.close(); }
  // The browser refuses the write under one new key: that old key must stay for next time, and the other pair still moves.
  const q = await loadPage({ storage: { 'coverStory.customText': 'old custom text', 'coverStory.cover': 'paper' }, refuseKeys: ['plainSight.customText'] });
  try {
    assert.equal(q.storageDump()['coverStory.customText'], 'old custom text', 'the old key is kept when the new write is refused');
    assert.equal(q.storageDump()['plainSight.customText'], undefined, 'nothing under the new key');
    assert.equal(q.storageDump()['plainSight.cover'], 'paper', 'the pair whose write works still migrates');
    assert.equal(q.storageDump()['coverStory.cover'], undefined, 'and its old key goes');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
  const r = await loadPage({ storage: { 'coverStory.cover': 'paper' } });
  try {
    assert.equal(r.storageDump()['plainSight.cover'], 'paper');
    assert.deepEqual(r.errors, []);
  } finally { r.close(); }
});

test('the header policy served from vercel.json keeps its shape: nothing but the page\'s own origin and its two inline scripts by hash, no framing, and the other headers as documented', async () => {
  const headers = headersFor(HTML);
  const get = (k) => (headers.find((h) => h.key === k) || {}).value;
  const csp = get('Content-Security-Policy');
  assert.ok(csp.startsWith("default-src 'none'; "), 'everything is refused by default');
  const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '));
  assert.match(scriptSrc, /^script-src 'self'( 'sha256-[A-Za-z0-9+/=]{44}'){2}$/, 'the page\'s own origin and exactly two inline script hashes, nothing else');
  assert.ok(!/unsafe-inline/.test(scriptSrc), 'no inline script other than the two');
  for (const d of ["style-src 'unsafe-inline'", 'img-src data:', "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(csp.split('; ').includes(d), 'policy keeps ' + d);
  assert.equal(get('X-Frame-Options'), 'DENY');
  assert.equal(get('X-Content-Type-Options'), 'nosniff');
  assert.equal(get('Referrer-Policy'), 'no-referrer');
  assert.equal(get('Permissions-Policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  assert.equal(get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(headers.length, 7, 'seven headers, no more');
  const meta = HTML.match(/http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/)[1];
  assert.equal(meta, "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'", 'the meta policy is unchanged');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
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
await sleep(100);   // a rejection raised by the last test's page lands before the count
if (unhandled) console.log(`\n${unhandled} unhandled promise rejection(s) in the page during the run`);
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total. Errors: ${failed + unhandled}`);
process.exit(failed || unhandled ? 1 : 0);
