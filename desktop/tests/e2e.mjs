// End-to-end tests of the desktop app that run inside the real app: the real
// shell, the real WebKit view, the real files on disk and real relaunches.
// They need the test build (`npm run build:e2e`, cargo feature e2e), which
// lets a test read the page, run a line of script in it and take a picture of
// it. Key presses are dispatched inside the page; what needs real keys (the
// keyboard path through macOS, the clipboard, the open panel, the menus) is
// in app.mjs. The suite still needs an unlocked Mac left alone with the
// display on: with the screen locked on 26 October 2026 macOS listed every
// window of the app off-screen and the run could not see it (e2e-run-1), so a
// locked screen is refused and a launch's window listed only off-screen stops
// the run as not run (harness.mjs, firstWindow; DISH-G-50).
//
// Run from desktop/: npm run test:e2e   (exit code 0 only when every test passes)

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// First: names the folder the test build writes downloads into, under the
// evidence directory, before the harness reads it (Mac_PS_010).
import './e2e-downloads.mjs';
import {
  DESKTOP, DOWNLOADS, EVIDENCE, HOME, ID, NotRun, ROOT, UserActivity, alive, decryptRecord, drive, firstWindow, isCoverPrefix, newDownloads, note,
  novelText, run, sleep, spawnApp, stopApp, stopCurrentApp, until
} from './harness.mjs';

// The page's own Word document writer (index.html, docxBytes), run here as it
// is, so that a .docx the app makes (docx.rs) can be checked byte for byte.
const pageDocx = (() => {
  const src = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const start = src.indexOf('  function docxBytes(text) {');
  const end = src.indexOf('  // Which browser family this is');
  if (start < 0 || end < start) throw new Error('the page\'s docxBytes was not found in index.html');
  const make = new Function(src.slice(start, end) + '\nreturn docxBytes;')();
  return (text) => Buffer.from(make(text));
})();
// What macOS's own reader finds in a document.
const readBack = (file) => execFileSync('textutil', ['-convert', 'txt', '-stdout', file], { encoding: 'utf8' });

const EXE = process.env.PLAIN_SIGHT_E2E_APP || path.join(DESKTOP, 'src-tauri/target/e2e/release/plain-sight');
const PROBE = path.join(EVIDENCE, 'probe');
const PICTURES = path.join(EVIDENCE, 'pictures');
mkdirSync(PROBE, { recursive: true });
mkdirSync(PICTURES, { recursive: true });

let app = null;
let requestId = 0;

// The app's visible windows. The window server also lists an off-screen
// helper window of AppKit's for every app; it is never shown.
const documentWindows = () => drive('cgwindows', app.pid).windows.filter((w) => w.layer === 0 && w.onscreen);

// One request at a time through the probe folder (see src-tauri/src/e2e.rs).
async function ask(request, ms = 8000) {
  const id = ++requestId;
  const tmp = path.join(PROBE, 'request.tmp');
  writeFileSync(tmp, JSON.stringify({ id, ...request }));
  renameSync(tmp, path.join(PROBE, 'request.json'));
  const answer = path.join(PROBE, `response-${id}.json`);
  await until(() => existsSync(answer), 'the app to answer request ' + id, ms);
  const reply = JSON.parse(readFileSync(answer, 'utf8'));
  rmSync(answer);
  note('probe ' + JSON.stringify(request).slice(0, 140) + ' -> ' + JSON.stringify(reply).slice(0, 200));
  if (!reply.ok) throw new Error('probe: ' + reply.error);
  return reply.value;
}
const js = (expression) => ask({ eval: expression });
async function picture(name) {
  const value = await ask({ snapshot: name }, 10000).catch((err) => { note('picture failed: ' + err.message); return null; });
  if (value === null) return null;
  const from = path.join(PROBE, name);
  if (existsSync(from)) renameSync(from, path.join(PICTURES, name));
  return path.join(PICTURES, name);
}

// Every launch names the probe folder, the folder that stands for Downloads
// (the test build's PLAIN_SIGHT_E2E_DOWNLOADS, folder.rs) and the save
// panel's stand-in (PLAIN_SIGHT_E2E_SAVE_AS: a folder takes the name the page
// proposes, a file path is the panel's answer as it is and must carry the
// proposed extension, DM-238), never ~/Downloads.
async function launch(env = {}) {
  const child = spawnApp(EXE, { PLAIN_SIGHT_E2E_DIR: PROBE, PLAIN_SIGHT_E2E_DOWNLOADS: DOWNLOADS, PLAIN_SIGHT_E2E_SAVE_AS: DOWNLOADS, ...env });
  const pid = child.pid;
  app = { child, pid };
  await firstWindow(pid, (windows) => windows.filter((w) => w.layer === 0 && w.onscreen).length === 1, 'the app window', 20000);
  await until(async () => (await js('window.PlainSight && window.PlainSight.coverId()')) !== null, 'the cover to load', 15000);
  return app;
}

// The page, through the probe. Key presses are dispatched where the page
// listens for them, the focused element or the body, as a key press would be.
const page = {
  text: (id) => js(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return el && el.getClientRects().length ? el.textContent : null; })()`),
  // The cover's blocks, one per line, as the reference model renders them.
  coverBlocks: () => js(`Array.from(document.querySelectorAll('#cover > p, #cover > h2, #cover > ul > li')).map((el) => el.textContent).join('\\n')`),
  shown: (id) => js(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return Boolean(el && el.getClientRects().length); })()`),
  press: (key, mods = {}) => js(`(() => { const t = document.activeElement || document.body; const e = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, metaKey: ${!!mods.meta}, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift}, altKey: ${!!mods.alt}, bubbles: true, cancelable: true }); t.dispatchEvent(e); return e.defaultPrevented; })()`),
  type: (text) => js(`(() => { for (const ch of ${JSON.stringify(text)}) { const t = document.activeElement || document.body; t.dispatchEvent(new KeyboardEvent('keydown', { key: ch === '\\n' ? 'Enter' : ch, bubbles: true, cancelable: true })); } return true; })()`),
  click: (id) => js(`(() => { document.getElementById(${JSON.stringify(id)}).click(); return true; })()`),
  choose: (name, value) => js(`(() => { const r = document.querySelector('input[name=${JSON.stringify(name)}][value=${JSON.stringify(value)}]'); r.click(); return r.checked; })()`),
  async peekText() {
    await page.press('G', { meta: true, shift: true });
    const text = await page.text('real');
    await page.press('G', { meta: true, shift: true });
    return text;
  },
  async start() {
    await page.click('btn-start');
    await until(async () => !(await page.shown('intro')), 'the intro to close');
  },
  async openIntro() {
    await page.click('btn-help');
    await until(() => page.shown('intro'), 'the intro to open');
  },
  async password(value) {
    await until(() => page.shown('pw'), 'the password dialog');
    await js(`(() => { document.getElementById('pw-input').value = ${JSON.stringify(value)}; document.getElementById('pw-ok').click(); return true; })()`);
  },
  toast: () => js(`document.getElementById('toast').textContent`),
  waitToast: (fragment, ms = 15000) => until(async () => { const t = await page.toast(); return t.includes(fragment) && t; }, 'a toast with "' + fragment + '"', ms)
};

const PASSWORD = 'file password for the test run';
const PHRASE = 'vault phrase for the test run';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('first launch: one document window, the page from the app itself in a secure context, the intro on top', async () => {
  await launch();
  const windows = documentWindows();
  assert.equal(windows.length, 1, 'one window');
  // Asked for at 1000 x 760; the window server has reported 980 x 744 while the
  // display was asleep and locked, so the size is checked against the bounds.
  note('window size ' + windows[0].width + ' x ' + windows[0].height);
  assert.ok(windows[0].width >= 520 && windows[0].width <= 1000 && windows[0].height >= 420 && windows[0].height <= 790, 'a document-sized window: ' + windows[0].width + ' x ' + windows[0].height);
  const facts = await js(`({ href: location.href, secure: window.isSecureContext, subtle: typeof crypto.subtle, title: document.title, intro: document.getElementById('intro').hidden === false, header: document.getElementById('header-left').textContent, notice: document.getElementById('load-notice').hidden })`);
  assert.deepEqual(facts, { href: 'tauri://localhost', secure: true, subtle: 'object', title: 'Untitled draft', intro: true, header: 'Untitled draft', notice: true });
  await picture('a01-intro.png');
});

test('typing shows the novel, never the real text; the word count counts the cover', async () => {
  await page.start();
  await page.type('meet me at the north gate at nine');
  const cover = await page.coverBlocks();
  assert.ok(cover.length > 20, 'the cover shows text');
  assert.ok(isCoverPrefix(cover, await novelText()), 'the cover is the novel: ' + JSON.stringify(cover));
  assert.equal(await js(`document.body.innerText.includes('north gate')`), false, 'the real text is nowhere on screen');
  const words = (cover.match(/\S+/g) || []).length;
  assert.equal(await page.text('word-count'), words + (words === 1 ? ' word' : ' words'));
  await picture('a02-novel.png');
});

test('Cmd+Shift+G shows exactly the real text and hides it again; typing ends a peek', async () => {
  assert.equal(await page.press('G', { meta: true, shift: true }), true, 'the chord is taken by the page');
  assert.equal(await page.text('real'), 'meet me at the north gate at nine');
  assert.equal(await page.shown('cover'), false, 'the cover is hidden while peeking');
  await picture('a03-peek.png');
  await page.press('G', { meta: true, shift: true });
  assert.equal(await page.shown('real'), false);
  await page.press('G', { meta: true, shift: true });
  await page.type('!');
  assert.equal(await page.shown('real'), false, 'typing ended the peek');
  assert.equal(await page.peekText(), 'meet me at the north gate at nine!');
});

test('Esc erases the real text and the screen', async () => {
  await page.press('Escape');
  assert.equal(await page.text('cover'), '');
  assert.equal(await page.peekText(), '');
});

test('the work document and the research paper covers load from the intro, with their own looks', async () => {
  await page.openIntro();
  assert.equal(await page.choose('mode', 'work'), true);
  await page.start();
  await until(async () => (await page.text('header-left')) === 'Q3 planning notes', 'the work header');
  assert.equal(await page.text('last-edited'), 'Last edited just now');
  assert.equal(await page.shown('toolbar'), true, 'the decorative toolbar shows');
  assert.equal(await js('document.title'), 'Q3 planning notes');
  await page.type('ordinary words for the work cover');
  await picture('a04-work.png');
  await page.press('Escape');
  await page.openIntro();
  await page.choose('mode', 'paper');
  await page.start();
  await until(async () => (await page.text('header-left')) === 'Manuscript draft', 'the paper header');
  assert.equal(await page.text('page-count'), 'Page 1 of 1');
  assert.match(await page.text('paper-title'), /^Variability in Regional Rainfall/);
  await page.type('ordinary words for the paper cover');
  await picture('a05-paper.png');
  await page.press('Escape');
  await page.openIntro();
  await page.choose('mode', 'book');
  await page.start();
  await until(async () => (await page.text('header-left')) === 'Untitled draft', 'the novel header');
});

// Save without a folder goes through the save panel (D-49); the test build
// writes where PLAIN_SIGHT_E2E_SAVE_AS says instead, the folder named above.
test('Save without a folder saves an encrypted .sight file under the page\'s proposed name, where the save panel\'s stand-in points; it decrypts to the text', async () => {
  assert.ok(DOWNLOADS.startsWith(EVIDENCE), 'the test build writes downloads under the evidence directory, not into ~/Downloads: ' + DOWNLOADS);
  await page.type('saved through the app');
  await page.click('btn-save');
  await page.password(PASSWORD);
  await page.waitToast('Saved');
  const files = await until(() => { const f = newDownloads().filter((n) => n.endsWith('.sight')); return f.length ? f : null; }, 'a .sight file in Downloads', 10000);
  assert.equal(files.length, 1);
  assert.match(files[0], /^untitled-draft-\d{8}-\d{4}\.sight$/);
  const record = JSON.parse(readFileSync(path.join(DOWNLOADS, files[0]), 'utf8'));
  assert.equal(record.format, 'plain-sight');
  assert.equal(record.iterations, 310000);
  assert.equal(Buffer.from(record.salt, 'base64').length, 16);
  assert.equal(Buffer.from(record.iv, 'base64').length, 12);
  assert.equal(await decryptRecord(record, PASSWORD), 'saved through the app');
});

test('the plain .txt mode downloads the exact text, named by the moment', async () => {
  await page.openIntro();
  await page.choose('save-mode', 'txt');
  await page.start();
  await page.click('btn-save');
  const name = (await page.waitToast('Saved 2')).replace(/^Saved /, '');
  assert.match(name, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/);
  await until(() => newDownloads().includes(name), 'the .txt file', 10000);
  assert.equal(readFileSync(path.join(DOWNLOADS, name), 'utf8'), 'saved through the app');
});

test('the file the save panel returns is written under the panel\'s name and replaces what is there, as the panel confirmed (D-49)', async () => {
  // The stand-in as a file path: the panel's answer, with a name of its own
  // and a file already at that path.
  const chosen = path.join(EVIDENCE, 'chosen in the panel.txt');
  writeFileSync(chosen, 'the file the panel offered to replace');
  await stopApp(app);
  await launch({ PLAIN_SIGHT_E2E_SAVE_AS: chosen });
  await page.press('Escape');
  await page.openIntro();
  await page.choose('save-mode', 'txt');
  await page.start();
  await page.type('written where the panel said');
  await page.click('btn-save');
  assert.equal(await page.waitToast('Saved '), 'Saved chosen in the panel.txt', 'the toast names the file the panel chose');
  assert.equal(readFileSync(chosen, 'utf8'), 'written where the panel said', 'replaced, as the panel confirmed');
  await stopApp(app);
  await launch();
  await page.press('Escape');
  await page.openIntro();
  await page.choose('save-mode', 'txt');
  await page.start();
  await page.type('saved through the app');
  await page.openIntro();
  await page.choose('save-mode', 'sight');
  await page.start();
});

test('the .md and .docx modes download the text as Markdown and as a Word document the app makes', async () => {
  for (const mode of ['md', 'docx']) {
    await page.openIntro();
    await page.choose('save-mode', mode);
    await page.start();
    await page.click('btn-save');
    // The toast must name this file: the extension keeps an earlier toast from answering.
    const name = (await page.waitToast('.' + mode)).replace(/^Saved /, '');
    assert.match(name, new RegExp('^\\d{4}-\\d{2}-\\d{2} \\d{2}-\\d{2}-\\d{2}( \\(\\d+\\))?\\.' + mode + '$'), name);
    await until(() => newDownloads().includes(name), 'the .' + mode + ' file', 10000);
    const file = path.join(DOWNLOADS, name);
    if (mode === 'md') {
      assert.equal(readFileSync(file, 'utf8'), 'saved through the app');
    } else {
      assert.ok(readFileSync(file).equals(pageDocx('saved through the app')), 'the Word document the page itself would make');
      assert.equal(readBack(file).trim(), 'saved through the app', 'macOS reads the text back');
    }
  }
  await page.openIntro();
  await page.choose('save-mode', 'sight');
  await page.start();
});

test('a Save the app cannot write says "Could not save" in both modes and writes nothing (DM-202)', async () => {
  // A folder that cannot be written, as a panel's answer inside a folder
  // macOS refused: the test build's overrides point at it for this launch.
  const home = path.join(EVIDENCE, 'home-without-downloads');
  const blocked = path.join(home, 'Downloads');
  mkdirSync(blocked, { recursive: true });
  execFileSync('chmod', ['555', blocked]);
  await stopApp(app);
  try {
    await launch({ HOME: home, PLAIN_SIGHT_E2E_DOWNLOADS: blocked, PLAIN_SIGHT_E2E_SAVE_AS: blocked });
    await page.press('Escape');
    await page.openIntro();
    await page.choose('save-mode', 'txt');
    await page.start();
    await page.type('words that cannot be written');
    await page.click('btn-save');
    await page.waitToast('Could not save');
    await page.openIntro();
    await page.choose('save-mode', 'sight');
    await page.start();
    await page.click('btn-save');
    await page.password(PASSWORD);
    await page.waitToast('Could not save');
    assert.equal(await page.peekText(), 'words that cannot be written', 'the text stays');
    assert.deepEqual(readdirSync(blocked), [], 'nothing was written');
  } finally {
    await stopApp(app);
    execFileSync('chmod', ['755', blocked]);
    await launch();
  }
});

// The web view's own downloads are refused (main.rs, on_download, DM-202): a
// click on a link with a download attribute asks WebKit for a download, wry
// then asks the app for a destination (wry 0.57.0, src/wkwebview/download.rs,
// download_policy: the Downloads folder of the process's HOME plus the
// suggested name), and the app's handler answers false, so WebKit writes
// nothing. This launch runs under a HOME of its own under the evidence
// directory, so even an app that allowed the download would write into that
// folder and never into the real one. Written, not run (DM-237 c).
const onscreenCount = () => drive('cgwindows', app.pid).windows.filter((w) => w.onscreen).length;
test('a download link clicked in the page writes nothing: the web view\'s downloads are refused, and no window opens (DM-202, DM-237 c)', async () => {
  const home = path.join(EVIDENCE, 'home-for-the-download-link');
  const downloads = path.join(home, 'Downloads');
  mkdirSync(downloads, { recursive: true });
  const before = readdirSync(DOWNLOADS).length;
  await stopApp(app);
  try {
    await launch({ HOME: home });
    await page.press('Escape');   // the intro of a first launch under this home
    const windows = onscreenCount();
    await js(`(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['a download the app must refuse'], { type: 'text/plain' })); a.download = 'refused-download.txt'; document.body.appendChild(a); a.click(); a.remove(); return true; })()`);
    await sleep(3000);
    assert.deepEqual(readdirSync(downloads), [], 'nothing landed in this launch\'s Downloads folder');
    assert.equal(readdirSync(DOWNLOADS).length, before, 'nothing landed in the test\'s Downloads folder');
    assert.equal(onscreenCount(), windows, 'no new window');
    assert.equal(await js('location.href'), 'tauri://localhost', 'still on the app page');
    assert.ok(alive(app.pid), 'the app is still running');
  } finally {
    await stopApp(app);
    await launch();
  }
});

test('the shell shows nothing but the app: navigation away and new windows are refused', async () => {
  await js(`(() => { location.href = 'https://example.com/'; return true; })()`);
  await sleep(1500);
  assert.equal(await js('location.href'), 'tauri://localhost', 'still on the app page');
  await js(`(() => { window.open('https://example.com/'); return true; })()`);
  await sleep(1500);
  assert.equal(documentWindows().length, 1, 'still one window');
});

test('the content security policy is enforced twice: by the shell\'s header and by the page', async () => {
  await js(`(() => { window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => window.__violations.push({ directive: e.effectiveDirective, policy: e.originalPolicy, uri: e.blockedURI })); fetch('https://example.com/').then(() => { window.__fetched = 'yes'; }, () => { window.__fetched = 'blocked'; }); return true; })()`);
  await sleep(1500);
  assert.equal(await js('window.__fetched'), 'blocked');
  const violations = await js('window.__violations');
  const policies = violations.map((v) => v.policy.split(';').map((d) => d.trim()).sort().join('; '));
  note('violations: ' + JSON.stringify(violations));
  assert.equal(violations.length, 2, 'one violation from each of the two policies');
  assert.equal(policies[0], policies[1], 'the shell\'s policy holds the same directives as the page\'s');
  assert.ok(violations.every((v) => v.directive === 'connect-src'));
});

test('the device vault keeps its copy across a quit and a relaunch, and the phrase plus Cmd+E then Cmd+Return reopens it', async () => {
  await page.press('Escape');
  await page.openIntro();
  await js(`(() => { const box = document.getElementById('vault-on'); box.click(); document.getElementById('vault-phrase').value = ${JSON.stringify(PHRASE)}; return box.checked; })()`);
  await page.start();
  await until(() => js(`document.body.classList.contains('vault-open')`), 'the vault to open', 10000);
  await page.type('kept in the vault');
  await sleep(4000);   // the autosave settles 1.5 s after the last key (timers run slower in a hidden page)
  const store = path.join(HOME, 'Library/WebKit', path.basename(EXE) === 'plain-sight' ? 'plain-sight' : ID);
  note('quitting with the vault open; WebKit data folder ' + store);
  await stopApp(app);   // SIGTERM: the window close and Cmd+Q paths are checked in app.mjs and in Wave C
  await launch();
  assert.equal(await page.shown('intro'), false, 'no intro on a return');
  await page.type(PHRASE);
  assert.equal(await page.press('e', { meta: true }), true, 'Cmd+E is taken while a vault exists');
  assert.equal(await page.press('Enter', { meta: true }), true, 'Cmd+Return is taken');
  await until(() => js(`document.body.classList.contains('vault-open')`), 'the vault to reopen', 10000);
  assert.equal(await page.peekText(), 'kept in the vault');
  await picture('a06-vault-open.png');
});

test('a wrong phrase does nothing', async () => {
  await page.press('Escape');
  await page.type('this is not the phrase at all');
  await page.press('e', { meta: true });
  await page.press('Enter', { meta: true });
  await sleep(2500);
  assert.equal(await js(`document.body.classList.contains('vault-open')`), false);
  assert.equal(await page.peekText(), 'this is not the phrase at all');
});

// ---------------------------------------------------------------------------
// Wave B: the folder, through the app's adapter. The test build's picker
// returns PLAIN_SIGHT_E2E_PICK instead of showing the panel (the real panel is
// tested with real keys in app.mjs).
// ---------------------------------------------------------------------------
const FOLDER = path.join(EVIDENCE, 'folders', 'Notes for the test');
const folderFiles = () => (existsSync(FOLDER) ? readdirSync(FOLDER).sort() : []);
const stamp = (d) => { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds()); };

test('the folder button opens the real system folder panel, as a window at the normal level (D-27)', async () => {
  // No picker override in this launch: this is rfd's panel itself. With the
  // screen locked it cannot be used, so the test only checks that it opens and
  // where it sits; the next test ends this launch.
  await page.press('Escape');
  await page.openIntro();
  await page.click('btn-folder');
  const windows = await until(() => { const w = drive('cgwindows', app.pid).windows.filter((x) => x.onscreen); return w.length >= 2 ? w : null; }, 'the folder panel', 8000);
  note('windows with the folder panel open: ' + JSON.stringify(windows));
  writeFileSync(path.join(EVIDENCE, 'picker-windows.json'), JSON.stringify(windows, null, 2));
  assert.ok(windows.every((w) => w.layer === 0), 'the panel does not float above other apps: layers ' + windows.map((w) => w.layer).join(', '));
});

// The intro's folder status in the app with no folder chosen and the
// encrypted mode picked: the page's own words (index.html, folderRender),
// which the jsdom suite holds the page to (native.mjs). They read "Save
// downloads an encrypted .sight file." until Save without a folder went
// through the save panel (a460b1f, 22 October 2026); the two tests that read
// the status still expected the old words in e2e-run-3 (26 October), the
// first failing on them and the second timing out waiting for them.
const NO_FOLDER_STATUS = 'Save opens a save panel for an encrypted .sight file.';

test('in the app the intro speaks of an app, not a browser, and offers the system folder picker', async () => {
  mkdirSync(FOLDER, { recursive: true });
  await stopApp(app);
  await launch({ PLAIN_SIGHT_E2E_PICK: FOLDER });
  await page.press('Escape');
  await page.openIntro();
  const intro = await js(`document.getElementById('intro').textContent`);
  assert.equal(/browser/i.test(intro), false, 'no browser in the intro');
  assert.equal(/\btab\b/i.test(intro), false, 'no tab in the intro');
  assert.match(intro, /Nothing you type leaves this app/);
  assert.match(intro, /Save my text on this computer, encrypted/);
  assert.equal(await page.shown('btn-folder'), true, 'the folder button shows');
  assert.equal(await page.shown('folder-help'), false, 'no browser help');
  assert.equal(await page.text('folder-status'), NO_FOLDER_STATUS);
  await picture('b01-intro-app-wording.png');
});

test('choosing a folder: the toast and the status name the folder, never its path', async () => {
  await page.click('btn-folder');
  await page.waitToast('Save now writes into Notes for the test');
  assert.equal(await page.text('folder-status'), 'Save writes a plain text file into the folder "Notes for the test".');
  assert.equal(await page.shown('btn-folder-forget'), true);
  assert.equal(await js(`document.body.innerText.includes(${JSON.stringify(EVIDENCE)})`), false, 'the path is nowhere on the page');
  await picture('b02-folder-chosen.png');
  await page.start();
});

test('Save writes the exact text into the folder as a .txt named by the moment, with no password', async () => {
  await page.type('first words into the folder');
  const downloads = newDownloads().length;
  await page.click('btn-save');
  const toast = await page.waitToast(' in Notes for the test');
  const name = toast.replace(/^Saved /, '').replace(/ in Notes for the test$/, '');
  assert.match(name, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/);
  assert.equal(readFileSync(path.join(FOLDER, name), 'utf8'), 'first words into the folder');
  assert.equal(await page.shown('pw'), false, 'no password asked');
  assert.equal(newDownloads().length, downloads, 'nothing downloaded');
});

test('two saves in the same second keep both files: the second gets " (2)"', async () => {
  let pair = null;
  for (let attempt = 0; attempt < 5 && !pair; attempt++) {
    const before = new Set(folderFiles());
    await js(`(() => { const b = document.getElementById('btn-save'); b.click(); b.click(); return true; })()`);
    await sleep(1200);
    const fresh = folderFiles().filter((n) => !before.has(n));
    const first = fresh.find((n) => !n.includes(' ('));
    if (first && fresh.includes(first.replace(/\.txt$/, ' (2).txt'))) pair = [first, first.replace(/\.txt$/, ' (2).txt')];
  }
  assert.ok(pair, 'a same-second pair was written');
  for (const n of pair) assert.equal(readFileSync(path.join(FOLDER, n), 'utf8'), 'first words into the folder');
});

test('a name already in the folder gets the next number and the file there is left untouched', async () => {
  const taken = [];
  for (let s = 0; s < 4; s++) {
    const name = stamp(new Date(Date.now() + s * 1000)) + '.txt';
    if (!existsSync(path.join(FOLDER, name))) { writeFileSync(path.join(FOLDER, name), 'placed by the test'); taken.push(name); }
  }
  await page.click('btn-save');
  const name = (await page.waitToast(' in Notes for the test')).replace(/^Saved /, '').replace(/ in Notes for the test$/, '');
  assert.match(name, / \(\d+\)\.txt$/, 'the saved name is numbered: ' + name);
  assert.equal(readFileSync(path.join(FOLDER, name), 'utf8'), 'first words into the folder');
  for (const n of taken) assert.equal(readFileSync(path.join(FOLDER, n), 'utf8'), 'placed by the test', n + ' untouched');
});

test('the folder takes .md and .docx files too: Markdown as typed, and a Word document the app makes', async () => {
  for (const format of ['md', 'docx']) {
    await page.openIntro();
    await page.choose('folder-format', format);
    await page.start();
    await page.click('btn-save');
    const toast = await page.waitToast('.' + format + ' in Notes for the test');
    const name = toast.replace(/^Saved /, '').replace(/ in Notes for the test$/, '');
    assert.match(name, new RegExp('^\\d{4}-\\d{2}-\\d{2} \\d{2}-\\d{2}-\\d{2}( \\(\\d+\\))?\\.' + format + '$'), name);
    const file = path.join(FOLDER, name);
    if (format === 'md') {
      assert.equal(readFileSync(file, 'utf8'), 'first words into the folder');
    } else {
      assert.ok(readFileSync(file).equals(pageDocx('first words into the folder')), 'the Word document the page itself would make');
      assert.equal(readBack(file).trim(), 'first words into the folder', 'macOS reads the text back');
    }
  }
  await page.openIntro();
  await page.choose('folder-format', 'txt');
  await page.start();
});

test('the folder is remembered across a relaunch, in the app\'s own data folder', async () => {
  // A security-scoped bookmark of the folder (bookmark.rs), never its plain path.
  const data = path.join(HOME, 'Library/Application Support', ID);
  const bookmark = readFileSync(path.join(data, 'folder.bookmark'));
  assert.equal(bookmark.subarray(0, 4).toString('latin1'), 'book', 'the app keeps a bookmark, in its data folder');
  assert.ok(bookmark.includes(Buffer.from(path.basename(FOLDER))), 'a bookmark of the chosen folder');
  assert.equal(existsSync(path.join(data, 'folder.txt')), false, 'no plain path is kept');
  await stopApp(app);
  await launch({ PLAIN_SIGHT_E2E_PICK: '/nonexistent/should-not-be-used' });
  await page.openIntro();
  assert.equal(await page.text('folder-status'), 'Save writes a plain text file into the folder "Notes for the test".');
  await page.start();
  await page.type('after the relaunch');
  const count = folderFiles().length;
  await page.click('btn-save');
  await page.waitToast(' in Notes for the test');
  assert.equal(folderFiles().length, count + 1);
});

test('the adapter cannot be replaced, gives no path, refuses any other file name, and the page can call nothing else', async () => {
  const facts = await js(`(() => {
    const n = window.PlainSightNative;
    let replaced = false; try { window.PlainSightNative = {}; replaced = window.PlainSightNative !== n; } catch (e) {}
    let deleted = false; try { deleted = delete window.PlainSightNative; } catch (e) {}
    return { frozen: Object.isFrozen(n), replaced, deleted, still: window.PlainSightNative === n, keys: Object.keys(n).sort() };
  })()`);
  assert.deepEqual(facts, { frozen: true, replaced: false, deleted: false, still: true, keys: ['forgetFolder', 'onQuit', 'onUnsavedText', 'pickFolder', 'saveDownload', 'savedFolder', 'writeTextFile'] });
  await js(`(() => { window.__r = {}; const I = window.__TAURI_INTERNALS__.invoke; const N = window.PlainSightNative;
    const note = (k, p) => p.then((v) => { window.__r[k] = 'ok ' + JSON.stringify(v); }, (e) => { window.__r[k] = 'refused ' + String(e); });
    note('saved', N.savedFolder());
    note('traversal', N.writeTextFile('../../outside', '.txt', 'x'));
    note('nameWithSlash', N.writeTextFile('2026-10-21 00-00-00/x', '.txt', 'x'));
    note('extension', N.writeTextFile('2026-10-21 00-00-00.txt', '.txt', 'x'));
    note('extTraversal', N.writeTextFile('2026-10-21 00-00-00', '/../../../outside.txt', 'x'));
    note('extOther', N.writeTextFile('2026-10-21 00-00-00', '.sh', 'x'));
    note('extMissing', N.writeTextFile('2026-10-21 00-00-00', 'x'));
    note('downloadDocm', N.saveDownload('2026-10-21 00-00-00.docm', 'x'));
    note('downloadTraversal', N.saveDownload('../../outside.txt', 'x'));
    note('downloadSlash', N.saveDownload('untitled-draft-20261021-0000.sight/../../x', 'x'));
    note('downloadOtherName', N.saveDownload('notes.sh', 'x'));
    const others = ['plugin:dialog|open', 'plugin:window|close', 'plugin:event|listen', 'plugin:fs|read_text_file', 'plugin:app|version', 'plugin:webview|print', 'plugin:menu|new', 'plugin:path|resolve_directory', 'plugin:image|new', 'plugin:resources|close', 'plugin:tray|new', 'plugin:shell|open', 'plugin:http|fetch', 'plugin:opener|open_url', 'plugin:updater|check', 'plugin:clipboard-manager|read_text', 'plugin:notification|notify', 'quit_ready'];
    others.forEach((cmd, i) => note('other' + i + ' ' + cmd, I(cmd, { path: '/etc/hosts', event: 'x', handler: 0, url: 'https://example.com' })));
    return true; })()`);
  await sleep(1500);
  const r = await js('window.__r');
  note('adapter probes: ' + JSON.stringify(r));
  assert.equal(r.saved, 'ok {"name":"Notes for the test"}', 'only the name');
  for (const k of ['traversal', 'nameWithSlash', 'extension']) assert.match(r[k], /^refused .*moment/, k);
  for (const k of ['extTraversal', 'extOther']) assert.match(r[k], /^refused .*only \.txt, \.md and \.docx/, k);
  assert.match(r.extMissing, /^refused /, 'a call without the text is refused');
  for (const k of ['downloadTraversal', 'downloadSlash', 'downloadOtherName', 'downloadDocm']) assert.match(r[k], /^refused .*not one Save makes/, k);
  const others = Object.keys(r).filter((k) => k.startsWith('other'));
  assert.equal(others.length, 18, 'eighteen other commands were tried');
  for (const k of others) assert.match(r[k], /^refused /, k + ' is refused');
  assert.equal(existsSync(path.join(FOLDER, '..', '..', 'outside.txt')), false);
});

test('a folder that has gone away: Save says it could not write, and the text stays', async () => {
  const moved = FOLDER + ' (moved away)';
  renameSync(FOLDER, moved);
  try {
    await page.click('btn-save');
    await page.waitToast('Could not write to the folder');
    assert.equal(await page.peekText(), 'after the relaunch');
  } finally {
    renameSync(moved, FOLDER);
  }
});

test('"Stop using the folder" forgets it, in the app\'s data too, and Save asks for a password again', async () => {
  await page.openIntro();
  await page.click('btn-folder-forget');
  await until(async () => (await page.text('folder-status')) === NO_FOLDER_STATUS, 'the status to change back');
  assert.equal(existsSync(path.join(HOME, 'Library/Application Support', ID, 'folder.bookmark')), false, 'the bookmark is deleted');
  await page.start();
  await page.click('btn-save');
  await until(() => page.shown('pw'), 'the password dialog');
  await page.press('Escape');
  await picture('b03-after-stop.png');
});

// ---------------------------------------------------------------------------
// Wave C: the window title, the context menu, and quitting like Esc. The test
// build answers {"windowTitle": true} and acts on {"close": true},
// {"quit": "menu"} and {"quit": "terminate"} (src/e2e.rs): the red button or
// Cmd+W, the app's Quit item, and the Dock's Quit (or a logout).
// ---------------------------------------------------------------------------
const windowTitle = () => ask({ windowTitle: true });

test('the window title follows the cover on screen', async () => {
  await page.press('Escape');
  await until(async () => (await windowTitle()) === 'Untitled draft', 'the novel title', 5000);
  await page.openIntro();
  await page.choose('mode', 'work');
  await page.start();
  await until(async () => (await windowTitle()) === 'Q3 planning notes', 'the work title', 5000);
  await page.openIntro();
  await page.choose('mode', 'paper');
  await page.start();
  await until(async () => (await windowTitle()) === 'Manuscript draft', 'the paper title', 5000);
  await page.openIntro();
  await page.choose('mode', 'book');
  await page.start();
  await until(async () => (await windowTitle()) === 'Untitled draft', 'back to the novel title', 5000);
});

test('the web view holds Writing Tools off (none, -1) where macOS has them', async () => {
  const value = await ask({ writingTools: true });
  note('writingToolsBehavior: ' + JSON.stringify(value));
  assert.equal(value, -1);
});

test('the app\'s delegate answers applicationShouldTerminate:, so a quit request from macOS waits for the page (Mac_PS_007)', async () => {
  // quit.rs adds the method to tao's delegate class at start and says on
  // stderr when it cannot; this reads the result back from AppKit.
  assert.equal(await ask({ delegateResponds: true }), true);
});

// What the page's visibility follows on the Mac, for the evidence: whether
// any part of the window is visible (its occlusion state) and whether the app
// is the active one, as the hook reads them from AppKit (windowState in
// src-tauri/src/e2e.rs), and the front app's pid and the app's windows as the
// driver sees them. In e2e-run-4 (28 October 2026) the page stayed hidden for
// the whole wait after show, and run.log said nothing of the window. Each part
// that cannot be read is noted with the others; a person at the keyboard
// still stops the run. Evidence only: no test passes on it.
async function windowEvidence(when) {
  const parts = [];
  const read = async (label, fn) => {
    try {
      parts.push(label + ' ' + JSON.stringify(await fn()));
    } catch (err) {
      if (err instanceof UserActivity) throw err;
      parts.push(label + ' could not be read: ' + err.message);
    }
  };
  await read('hook', () => ask({ windowState: true }));
  await read('front app', () => { const pid = drive('frontmost').pid; return { pid, thisApp: Boolean(app) && pid === app.pid }; });
  await read('driver', () => drive('windows', app.pid));
  note('window state ' + when + ' (evidence only, never a pass): ' + parts.join('; '));
}

// Waits up to 5 s for the page's visibility. On a timeout the window's state
// goes into run.log first, and the test still fails with the timeout.
async function waitForVisibility(want, what) {
  try {
    await until(async () => (await js(`document.visibilityState`)) === want, what, 5000);
  } catch (err) {
    if (err instanceof UserActivity) throw err;
    await windowEvidence('at the timeout waiting for ' + what);
    throw err;
  }
}

test('a minimized window and a hidden app give the page a hidden document, which is what starts its ten-minute wipe', async () => {
  // While the screen is locked macOS already counts the window as not visible,
  // so the change can only be seen on an unlocked screen.
  const before = await js(`document.visibilityState`);
  note('visibility before: ' + before);
  if (before !== 'visible') throw new NotRun('the page is already hidden, as while the screen is locked');
  // The state with the page visible, to read a timeout's record against; it
  // also runs the evidence's reads in every run, not only after a failure.
  await windowEvidence('with the page visible, before the minimize');
  // The hook's show brings the hidden app back as a click on its Dock icon
  // does: it unhides the app, then asks macOS to make it the active app.
  for (const [away, back] of [['minimize', 'unminimize'], ['hide', 'show']]) {
    await ask({ window: away });
    await waitForVisibility('hidden', 'a hidden page after ' + away);
    await ask({ window: back });
    await waitForVisibility('visible', 'a visible page after ' + back);
  }
});

test('the menu bar is the app\'s own and holds only standard items', async () => {
  const menus = drive('menus', app.pid).menus.filter((m) => m.title !== 'Apple');
  note('menu bar: ' + JSON.stringify(menus));
  assert.deepEqual(menus.map((m) => m.title), ['Plain Sight', 'File', 'Edit', 'View', 'Window', 'Help']);
  const items = Object.fromEntries(menus.map((m) => [m.title, m.items.map((i) => i.title).filter(Boolean)]));
  for (const want of ['About Plain Sight', 'Services', 'Hide Plain Sight', 'Hide Others', 'Show All', 'Quit Plain Sight']) {
    assert.ok(items['Plain Sight'].includes(want), 'the app menu has ' + want);
  }
  // The File menu shows Open..., Save... and Close Window. AppKit adds Close
  // All as Close Window's alternate: the same key W with the Option modifier
  // (AXMenuItemCmdModifiers 2 in the driver's listing; Redo, Shift, shows 1),
  // seen only while Option is held. e2e-run-3 (26 October 2026, run.log line
  // 357) listed it, and the old exact list failed on it. So the three visible
  // items are expected exactly, and Close All only as that alternate, so that
  // any other item still fails (D-44).
  const file = menus.find((m) => m.title === 'File').items.filter((i) => i.title);
  assert.deepEqual(file.filter((i) => i.title !== 'Close All').map((i) => i.title), ['Open...', 'Save...', 'Close Window'], 'the File menu of a document app (D-44)');
  const close = file.find((i) => i.title === 'Close Window');
  assert.deepEqual([close.key, close.mods], ['W', 0], 'Close Window is Cmd+W');
  const closeAll = file.filter((i) => i.title === 'Close All');
  assert.ok(closeAll.length <= 1, 'Close All at most once: ' + JSON.stringify(closeAll));
  for (const i of closeAll) assert.deepEqual([i.key, i.mods], ['W', 2], 'Close All only as the Option alternate of Close Window: ' + JSON.stringify(i));
  for (const want of ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All']) assert.ok(items.Edit.includes(want), 'Edit has ' + want);
  assert.ok(items.Help.includes('Plain Sight Help'), 'the Help menu has the help item (D-44): ' + items.Help.join(', '));
  const all = Object.values(items).flat().join(' | ');
  assert.equal(/peek|vault|hidden|reload|inspect|debug|developer|devtools/i.test(all), false, 'nothing names the trick or a browser tool: ' + all);
});

test('a right click gives no menu on the page, and the usual one in the text fields', async () => {
  const r = await js(`(() => {
    const fire = (el) => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
    return { page: fire(document.getElementById('cover')), body: fire(document.body), field: fire(document.getElementById('custom-text')), password: fire(document.getElementById('pw-input')) };
  })()`);
  assert.deepEqual(r, { page: true, body: true, field: false, password: false });
});

// Each quit path, straight after typing with the vault open: the last
// keystrokes must be in the copy on disk when the app is gone, and the phrase
// must reopen it after a relaunch. The window is closed as its red button does
// (performClose:, through the probe, since macOS shows Accessibility no windows
// while the screen is locked); the Quit item is pressed in the real menu bar
// through Accessibility; the Dock's quit is the same quit request the Dock
// sends.
const QUIT_PATHS = [
  ['closing the window', () => ask({ close: true })],
  ['the Quit item in the menu bar', () => drive('menu', app.pid, 'Plain Sight', 'Quit Plain Sight')],
  ['a quit request as the Dock sends it', () => drive('quit-app', app.pid)]
];
for (const [how, quit] of QUIT_PATHS) {
  test(`${how} works like Esc: the vault keeps the last keystrokes, the app ends, and the phrase reopens them`, async () => {
    const words = 'typed just before ' + how;
    await page.press('Escape');
    await page.type(PHRASE);
    await page.press('e', { meta: true });
    await page.press('Enter', { meta: true });
    await until(() => js(`document.body.classList.contains('vault-open')`), 'the vault to open', 10000);
    await page.press('Escape');            // locked again, empty page
    await page.type(PHRASE);
    await page.press('e', { meta: true });
    await page.press('Enter', { meta: true });
    await until(() => js(`document.body.classList.contains('vault-open')`), 'the vault to open again', 10000);
    const before = await page.peekText();
    await page.type(words);               // no pause: the autosave has not run
    const t0 = Date.now();
    await quit();
    await until(() => !alive(app.pid), 'the app to end after ' + how, 8000);
    const ms = Date.now() - t0;
    note(how + ': the app ended ' + ms + ' ms after the request');
    // Through the page's quit (never sooner than its 0.7 s commit wait), and
    // ended by the page's answer, not the 4 s safety timer.
    assert.ok(ms >= 600 && ms < 2500, how + ': ended after ' + ms + ' ms');
    await launch();
    await page.type(PHRASE);
    await page.press('e', { meta: true });
    await page.press('Enter', { meta: true });
    await until(() => js(`document.body.classList.contains('vault-open')`), 'the vault to reopen', 10000);
    assert.equal(await page.peekText(), before + words, 'the copy holds every keystroke typed before ' + how);
  });
}

// ---------------------------------------------------------------------------
// Wave G, round 2: the "Quit without saving?" sheet (D-48, Mac_PS_005). With
// text on the page and no vault open, every way out first shows a sheet on
// the document window: Cancel (the default button) keeps everything as it
// was and answers a terminate request from macOS with cancel; Quit runs the
// quit as before. The test build presses the sheet's buttons through the
// probe ({"sheet": "cancel"} or "quit"), never through Accessibility.
// ---------------------------------------------------------------------------
const onscreenWindows = () => drive('cgwindows', app.pid).windows.filter((w) => w.onscreen);
const sheetUp = async (how) => {
  const windows = await until(() => { const w = onscreenWindows(); return w.length >= 2 ? w : null; }, 'the sheet after ' + how, 8000);
  note('windows with the sheet (' + how + '): ' + JSON.stringify(windows));
  return windows;
};

test('with text on the page and no vault, closing the window asks "Quit without saving?": Cancel keeps the app and the text, Quit ends it through the page', async () => {
  await page.press('Escape');
  await page.type('words a quit would lose');
  await ask({ close: true });
  await sheetUp('the close');
  assert.equal(await ask({ sheet: 'cancel' }), true, 'the probe pressed Cancel');
  await until(() => onscreenWindows().length === 1, 'the sheet to go', 5000);
  await sleep(1500);
  assert.ok(alive(app.pid), 'the app is still running after Cancel');
  assert.equal(await page.peekText(), 'words a quit would lose', 'the text is untouched');
  await ask({ close: true });
  await sheetUp('the second close');
  const t0 = Date.now();
  assert.equal(await ask({ sheet: 'quit' }), true, 'the probe pressed Quit');
  await until(() => !alive(app.pid), 'the app to end after Quit', 8000);
  const ms = Date.now() - t0;
  note('Quit in the sheet: the app ended ' + ms + ' ms after the press');
  assert.ok(ms >= 600 && ms < 2500, 'ended through the page\'s quit, not at once nor by the timer: ' + ms + ' ms');
  await launch();
});

test('a quit request as the Dock sends it shows the sheet too, and Cancel answers it with cancel: the app stays open', async () => {
  await page.press('Escape');
  await page.type('words the Dock would lose');
  drive('quit-app', app.pid);
  await sheetUp('the Dock quit request');
  assert.equal(await ask({ sheet: 'cancel' }), true);
  await until(() => onscreenWindows().length === 1, 'the sheet to go', 5000);
  await sleep(2000);
  assert.ok(alive(app.pid), 'the app is still running: the request was answered with cancel');
  assert.equal(await page.peekText(), 'words the Dock would lose');
  // After the cancel a plain quit still works, through the sheet once more.
  drive('menu', app.pid, 'Plain Sight', 'Quit Plain Sight');
  await sheetUp('the Quit item');
  assert.equal(await ask({ sheet: 'quit' }), true);
  await until(() => !alive(app.pid), 'the app to end', 8000);
  await launch();
});

test('with no text on the page there is no sheet: the close ends the app as before', async () => {
  await page.press('Escape');
  assert.equal(await page.peekText(), '', 'nothing on the page');
  await ask({ close: true });
  await sleep(400);
  const windows = onscreenWindows().length;
  note('windows 400 ms after the close with nothing to lose: ' + windows);
  assert.ok(windows <= 1, 'no sheet: ' + windows + ' windows');
  await until(() => !alive(app.pid), 'the app to end without a sheet', 8000);
  await launch();
});

// ---------------------------------------------------------------------------
// Wave G: the window is not restorable (D-45, Mac_PS_015). macOS keeps a
// restorable window's state, and may keep a picture of it (a third-party
// reverse-engineering of the format, mothersruin.com, describes window
// snapshot files; Apple's pages do not say), under Saved Application
// State, written at key times (Apple, Mac App Programming Guide, User
// Interface Preservation: "changes are coalesced and written at key times,
// such as when the user switches to another app or logs out") and at a quit.
// The folder is named after the bundle identifier; the test build is a bare
// binary without one, and macOS names its other data after the process
// (Library/WebKit/plain-sight), so both names are watched and every folder
// that names the app is listed for the record.
// ---------------------------------------------------------------------------
const SAVED_STATE = path.join(HOME, 'Library', 'Saved Application State');
const savedStateFolders = () => (existsSync(SAVED_STATE) ? readdirSync(SAVED_STATE) : [])
  .filter((n) => n === ID + '.savedState' || n === path.basename(EXE) + '.savedState' || /plain.?sight/i.test(n));
function assertNoWindowState(when) {
  const folders = savedStateFolders();
  const listing = folders.map((f) => [f, readdirSync(path.join(SAVED_STATE, f)).map((n) => n + ' (' + statSync(path.join(SAVED_STATE, f, n)).size + ' bytes)')]);
  note('saved state folders ' + when + ': ' + JSON.stringify(listing));
  for (const [folder, files] of listing) {
    // A restorable window leaves windows.plist with an entry per window and
    // data files holding its state and picture; none of that may be here.
    assert.deepEqual(files.filter((f) => !f.startsWith('windows.plist')), [], when + ': ' + folder + ' holds window data: ' + files.join(', '));
    if (files.length) {
      const listed = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(SAVED_STATE, folder, 'windows.plist')], { encoding: 'utf8' }));
      assert.deepEqual(listed, [], when + ': ' + folder + '/windows.plist lists a window: ' + JSON.stringify(listed).slice(0, 300));
    }
  }
}

test('the window is marked not restorable, and macOS keeps no window state or picture after a forced end while peeking, nor after a quit (D-45)', async () => {
  assert.equal(await ask({ windowRestorable: true }), false, 'NSWindow isRestorable is false');
  await page.press('Escape');
  await page.type('words on screen while the app is ended by force');
  await page.press('G', { meta: true, shift: true });
  assert.equal(await page.shown('real'), true, 'peeking');
  await sleep(3000);   // time for a periodic save of window state, if macOS does one
  process.kill(app.pid, 'SIGKILL');
  await until(() => !alive(app.pid), 'the app to be gone', 8000);
  await sleep(1000);
  assertNoWindowState('after SIGKILL while peeking');
  await launch();
  await page.press('Escape');
  await page.type('words on screen before a quit');
  await page.press('G', { meta: true, shift: true });
  // Since D-48 a close with text on the page and no vault first asks "Quit
  // without saving?", so the close waits for the sheet; e2e-run-3 (26
  // October 2026) timed out here waiting for the app to end. The sheet's
  // Quit, pressed through the probe as the sheet test above presses it, ends
  // the app through the page's quit: its Esc ends the peek, then the app
  // ends, and a restorable window's state would be written then.
  await ask({ close: true });
  await sheetUp('the close before a quit');
  assert.equal(await ask({ sheet: 'quit' }), true, 'the probe pressed Quit in the sheet');
  await until(() => !alive(app.pid), 'the app to end after the close', 8000);
  await sleep(1000);
  assertNoWindowState('after a quit');
  await launch();
});

// ---------------------------------------------------------------------------
// Wave G: File > Open..., File > Save... and Help > Plain Sight Help press
// the page's own buttons, and do nothing while a dialog is open (D-44,
// Mac_PS_013). The items are pressed in the real menu bar through
// Accessibility, as the quit tests press the Quit item.
// ---------------------------------------------------------------------------
test('File > Save... with text on the page asks for the password, and over that dialog the Help item does nothing', async () => {
  await page.press('Escape');
  await page.type('words for the File menu');
  drive('menu', app.pid, 'File', 'Save...');
  await until(() => page.shown('pw'), 'the password dialog from File > Save...', 8000);
  drive('menu', app.pid, 'Help', 'Plain Sight Help');
  await sleep(1000);
  assert.equal(await page.shown('intro'), false, 'Help does nothing while the password dialog is up');
  assert.equal(await page.shown('pw'), true, 'the password dialog is still up');
  await page.press('Escape');
  await until(async () => !(await page.shown('pw')), 'the password dialog to close');
  assert.equal(await page.peekText(), 'words for the File menu', 'the text is untouched');
  await picture('g01-save-item.png');
});

test('Help > Plain Sight Help opens the intro, and over it File > Save... does nothing', async () => {
  drive('menu', app.pid, 'Help', 'Plain Sight Help');
  await until(() => page.shown('intro'), 'the intro from the Help item', 8000);
  drive('menu', app.pid, 'File', 'Save...');
  await sleep(1000);
  assert.equal(await page.shown('pw'), false, 'Save... does nothing while the intro is up');
  assert.equal(await page.shown('intro'), true);
  await picture('g02-help-item.png');
  await page.start();
});

// The Open panel is app-modal (DM-226), so this runs last, cancels the panel
// through Accessibility and reports not run while the screen is locked, when
// macOS shows Accessibility no windows and the panel could not be cancelled.
const openPanelOnScreen = () => drive('cgwindows', app.pid).windows.some((w) => w.onscreen && w.layer === 8);
test('File > Open... opens the system open panel, which the test cancels', async () => {
  if (!drive('windows', app.pid).windows.length) throw new NotRun('macOS shows Accessibility no windows while the screen is locked, so the panel could not be cancelled');
  await page.press('Escape');
  drive('menu', app.pid, 'File', 'Open...');
  await until(openPanelOnScreen, 'the open panel (a window at level 8)', 10000);
  note('windows with the open panel: ' + JSON.stringify(drive('cgwindows', app.pid).windows.filter((w) => w.onscreen)));
  try {
    for (let i = 0; i < 4 && openPanelOnScreen(); i++) {
      try { drive('panel-button', app.pid, 'Cancel'); } catch (err) { note('cancel: ' + err.message); }
      await sleep(1000);
    }
  } finally {
    assert.equal(openPanelOnScreen(), false, 'the panel is gone');
  }
});

await run(tests, {
  name: 'e2e',
  needUnlocked: true,
  // The app that is current when each stop ends, so a copy a test launched
  // again while the cleanup waited is stopped too; once the run is ending no
  // test can launch one (spawnApp refuses; DM-249).
  after: () => stopCurrentApp(() => app)
});
