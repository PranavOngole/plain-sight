// Black-box tests of the built app (the release bundle, no test hooks) with
// real key presses through macOS: the keyboard path into the page, the menu
// bar, the clipboard, the window and the process. They need the screen
// unlocked, so they start only when the Mac has been left alone for a while
// with the screen on (see harness.mjs), and they stop at the first touch.
// What happens inside the page is checked in e2e.mjs; here the page is read
// only through what a person can do: peek, copy, and paste the clipboard.
//
// Run from desktop/: npm run test:app   (exit code 0 only when every test passes)

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DESKTOP, EVIDENCE, HOME, NotRun, alive, clearTestData, decryptRecord, drive, driveRaw, note, run, sleep, until } from './harness.mjs';
import { launchable, webDataFolder } from './launch-guard.mjs';

const APP = process.env.PLAIN_SIGHT_APP || path.join(DESKTOP, 'src-tauri/target/release/bundle/macos/Plain Sight.app');
// Before anything else, and before the harness's run() moves any data aside:
// a bundle sandboxed under the real identifier is refused (DM-240, ledger
// D-39) unless PLAIN_SIGHT_ALLOW_REAL_ID=1; until the move of the app's data
// this suite runs on a copy under a test identifier (npm run app:testcopy,
// then PLAIN_SIGHT_APP=<the copy>). The facts read here also say where the
// bundle's web data lives: in its container when it is sandboxed.
const BUNDLE = launchable('app', APP);
let app = null;   // { pid }
let frontBefore = -1;

const launched = [];

// Every running copy of the release app.
function instances() {
  try {
    return execFileSync('pgrep', ['-f', path.join(APP, 'Contents/MacOS/plain-sight')], { encoding: 'utf8' }).trim().split('\n').map(Number).filter((p) => Number.isInteger(p) && p > 0);
  } catch { return []; }
}

// Opened the way a person opens it, through LaunchServices. A copy left
// running would be found in place of the new one, so none may be running.
async function launch() {
  assert.deepEqual(instances(), [], 'no copy of the release app is running before it is opened');
  execFileSync('open', ['-n', APP]);
  const pid = await until(() => instances().find((p) => !launched.includes(p)) || 0, 'the app process', 15000);
  launched.push(pid);
  app = { pid };
  note('opened pid ' + pid);
  await until(() => drive('cgwindows', pid).windows.some((w) => w.layer === 0 && w.onscreen), 'the app window', 15000);
  await until(() => drive('front', pid).ok, 'the app in front', 8000);
  await sleep(1200);   // the page and its cover module load
}

const keys = {
  type: async (text) => { drive('type', app.pid, text, 14); await sleep(200); },
  press: async (chord) => { drive('key', app.pid, chord); await sleep(250); }
};

// Puts a known value on the clipboard, then peeks and copies with real keys.
// The clipboard afterwards is what the page put there, or the marker if the
// page copied nothing.
async function quitIfRunning() {
  if (app && alive(app.pid)) {
    await keys.press('cmd+q');
    await until(() => !alive(app.pid), 'the app to quit', 10000);
  }
  app = null;
}

async function copyRealText(mod = 'cmd') {
  const marker = 'clipboard marker ' + Date.now();
  execFileSync('pbcopy', [], { input: marker });
  await keys.press(mod + '+shift+g');
  await keys.press(mod + '+c');
  await keys.press(mod + '+shift+g');
  await sleep(300);
  const text = drive('clip-text').text;
  return text === marker ? null : text;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the app opens from its bundle as a normal Mac app: one window, in front, with a standard menu bar', async () => {
  await launch();
  const windows = drive('cgwindows', app.pid).windows.filter((w) => w.layer === 0 && w.onscreen);
  assert.equal(windows.length, 1);
  assert.equal(driveRaw('frontmost').pid, app.pid);
  const menus = drive('menus', app.pid).menus.map((m) => m.title);
  note('menus: ' + JSON.stringify(drive('menus', app.pid).menus));
  assert.deepEqual(menus.filter((t) => t !== 'Apple'), ['Plain Sight', 'File', 'Edit', 'View', 'Window', 'Help']);
});

test('real keys reach the page: Return starts writing, typing goes to the hidden buffer, Cmd+Shift+G then Cmd+C copies exactly it', async () => {
  await keys.press('return');   // the intro's Start button has the focus on a first launch
  await keys.type('meet me at the north gate at nine');
  assert.equal(await copyRealText('cmd'), 'meet me at the north gate at nine');
});

test('the Ctrl versions of the chords work too', async () => {
  await keys.type(' sharp');
  assert.equal(await copyRealText('ctrl'), 'meet me at the north gate at nine sharp');
});

test('Esc erases the text: a peek and a copy afterwards copy nothing', async () => {
  await keys.press('escape');
  assert.equal(await copyRealText('cmd'), null);
});

test('Backspace removes the last character from the hidden buffer', async () => {
  await keys.type('abcd');
  await keys.press('backspace');
  assert.equal(await copyRealText('cmd'), 'abc');
  await keys.press('escape');
});

// The page's own focus: a real click in the middle of the document window.
async function focusPage() {
  const w = drive('cgwindows', app.pid).windows.filter((x) => x.layer === 0 && x.onscreen).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  drive('clickat', app.pid, Math.round(w.x + w.width / 2), Math.round(w.y + w.height / 2));
  await sleep(300);
}

// A clean page: Esc twice erases the text, closes the intro and any dialog.
async function cleanPage() {
  await keys.press('escape');
  await keys.press('escape');
}

// The page's buttons and fields are pressed through Accessibility by their
// DOM id, as a click would press them; text still goes in by real keys.
// (Counting Option+Tab presses broke whenever the page gained a control.)
// WebKit may build its accessibility tree a moment after the first request,
// so the first look waits up to 15 s. If Accessibility never reaches the
// page, the tests that need it report not run, with the reason.
let pageReachable = null;
async function reachPage() {
  if (pageReachable === null) {
    const t0 = Date.now();
    pageReachable = await until(() => { const c = driveRaw('controls', app.pid); return c.ok && c.controls.length > 0; }, 'the page through Accessibility', 15000).then(() => true, () => false);
    note('Accessibility reaches the page: ' + pageReachable + ' (' + (Date.now() - t0) + ' ms)');
  }
  if (!pageReachable) throw new NotRun('Accessibility shows no web area in the release app, so its page controls cannot be pressed');
}
async function pressControl(id) {
  await reachPage();
  await until(() => { drive('press', app.pid, id); return true; }, 'the control ' + id, 8000);
  await sleep(400);
}
async function focusControl(id) {
  await reachPage();
  await until(() => { drive('focus', app.pid, id); return true; }, 'focus on ' + id, 8000);
  await sleep(250);
}

// A .sight file made outside the app, by the format the README documents:
// it is what the web page writes, so opening it in the app proves the two read
// the same files.
async function sightFile(text, password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const data = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const b64 = (u) => Buffer.from(u).toString('base64');
  const file = path.join(EVIDENCE, 'made-outside-the-app.sight');
  writeFileSync(file, JSON.stringify({ format: 'plain-sight', version: 1, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations: 310000, salt: b64(salt), iv: b64(iv), data: b64(data) }, null, 2));
  return file;
}

// The page's Open panel is an app-modal dialog titled "Open" at window level
// 8; Accessibility lists it about a second before it is on screen, and while
// it is open the app takes no other input, so a test that fails with it open
// cancels it (diag-open-panel, app-run-2).
const openPanelShown = () => (driveRaw('windows', app.pid).windows || []).some((w) => w.title === 'Open' && w.subrole === 'AXDialog');
async function inPanel(isOpen, steps) {
  try { await steps(); } catch (err) {
    // Cancel until it is gone: Esc may close only the Go-to box on top of it.
    for (let i = 0; i < 4 && isOpen(); i++) {
      if (!driveRaw('panel-button', app.pid, 'Cancel').ok) await keys.press('escape');
      await sleep(1000);
    }
    throw err;
  }
}
const openPanelBusy = () => (driveRaw('windows', app.pid).windows || []).some((w) => w.title === 'Open' && (w.sheets || []).length > 0);

// Go to (Cmd+Shift+G) the test's own folder inside a save or folder panel,
// typed with real keys. The panel's default button is pressed only once the
// panel shows that folder by name (its location control, read through
// Accessibility): if the Go-to box did not take the path, the default button
// would save into or choose the panel's start folder, a personal one, which
// no test may touch (DM-239 d), so the test fails here, naming the box, and
// inPanel cancels the panel.
function panelShowsFolder(name) {
  const shows = (node) => Boolean(node) && typeof node === 'object'
    && ([node.title, node.value, node.description].includes(name) || (node.children || []).some(shows));
  return (drive('tree', app.pid, 16).windows || []).some(shows);
}
async function goTo(folder) {
  await keys.press('cmd+shift+g');
  await sleep(1000);
  drive('type', app.pid, folder, 10);
  await sleep(800);
  await keys.press('return');   // go to the folder
  await sleep(1500);
  if (!panelShowsFolder(path.basename(folder))) {
    throw new Error('the panel\'s Go-to box did not take ' + folder + ': the panel does not show that folder, so the test cancels the panel instead of pressing its default button over the panel\'s start folder');
  }
  note('the panel shows ' + path.basename(folder) + ' after the Go-to box');
}

// Open: the page's Open button, the system open panel, Go to (Cmd+Shift+G)
// the file typed with real keys, the panel's Open button, then the page's
// password dialog, typed with real keys.
async function openWithKeys(file, password) {
  await pressControl('btn-open');
  await until(() => openPanelShown() && drive('cgwindows', app.pid).windows.some((w) => w.onscreen && w.layer === 8), 'the open panel on screen', 10000);
  await sleep(800);
  await inPanel(openPanelShown, async () => {
    await keys.press('cmd+shift+g');
    await sleep(1000);
    drive('type', app.pid, file, 10);
    await sleep(800);
    await keys.press('return');   // go to the file, which is then selected
    await until(() => !openPanelBusy(), 'the Go-to box to close', 8000);
    await sleep(800);
    await until(() => { drive('panel-button', app.pid, 'Open'); return true; }, 'the panel\'s Open button', 5000);
    await until(() => !openPanelShown(), 'the open panel to close', 8000);
  });
  await sleep(700);
  await keys.type(password);
  await keys.press('return');
  await sleep(3000);   // the key derives from the password (310,000 rounds)
}

test('Open shows the system open panel; a wrong password changes nothing; the right one restores a file made outside the app', async () => {
  const file = await sightFile('opened from a file made outside the app', 'outside password 2026');
  await cleanPage();
  await openWithKeys(file, 'not the right password');
  assert.equal(await copyRealText('cmd'), null, 'a wrong password leaves the page empty');
  await openWithKeys(file, 'outside password 2026');
  assert.equal(await copyRealText('cmd'), 'opened from a file made outside the app');
});

// Save without a folder shows the system save panel (D-49), a sheet on the
// document window started in Downloads with the page's proposed name. The
// robot goes to a folder of its own under the evidence directory through
// the panel's Go-to box, as the folder test does, and presses Save (the
// panel's default button) only once the panel shows that folder (DM-239 d);
// the file must land there and decrypt to the text.
const SAVE_AS = path.join(EVIDENCE, 'folders', 'Saved from the panel');
const savePanelShown = () => drive('cgwindows', app.pid).windows.filter((x) => x.onscreen && x.layer === 0 && x.width > 400).length >= 2;
test('Save without a folder opens the system save panel; saved into the test\'s own folder through the panel, the .sight file decrypts to the text', async () => {
  mkdirSync(SAVE_AS, { recursive: true });
  await cleanPage();
  await keys.type('saved through the panel');
  await pressControl('btn-save');
  await sleep(700);
  await keys.type('panel password 2026');   // the page's password dialog, then its Save button
  await keys.press('return');
  await sleep(3000);   // the key derives from the password (310,000 rounds)
  await until(savePanelShown, 'the save panel on screen', 10000);
  note('windows with the save panel open: ' + JSON.stringify(drive('cgwindows', app.pid).windows.filter((x) => x.onscreen)));
  await inPanel(savePanelShown, async () => {
    await goTo(SAVE_AS);
    await keys.press('return');   // Save, the panel's default button, now that the panel shows the test's folder
    await until(() => !savePanelShown(), 'the save panel to close', 8000);
  });
  const fresh = await until(() => { const n = readdirSync(SAVE_AS); return n.length ? n : null; }, 'a file in the test\'s folder', 8000);
  assert.equal(fresh.length, 1);
  assert.match(fresh[0], /^untitled-draft-\d{8}-\d{4}\.sight$/, 'the name the page proposed');
  const record = JSON.parse(readFileSync(path.join(SAVE_AS, fresh[0]), 'utf8'));
  assert.equal(await decryptRecord(record, 'panel password 2026'), 'saved through the panel');
  renameSync(path.join(SAVE_AS, fresh[0]), path.join(EVIDENCE, 'downloads', 'save-panel ' + fresh[0]));
  rmSync(SAVE_AS, { recursive: true, force: true });
  await cleanPage();
});

// Without a peek the page takes Cmd+C itself, so the Edit menu's Copy never
// runs with nothing selected and the clipboard keeps what it held
// (Mac_PS_006); none of the real text reaches it either way.
test('Cmd+C without a peek leaves the clipboard as it was: the sentinel is still there, and none of the real text', async () => {
  await cleanPage();
  await keys.type('not for the clipboard');
  const marker = 'clipboard marker ' + Date.now();
  execFileSync('pbcopy', [], { input: marker });
  await keys.press('cmd+c');
  await sleep(300);
  const text = drive('clip-text').text;
  note('clipboard after Cmd+C without a peek: ' + JSON.stringify(text));
  assert.equal(text, marker, 'the clipboard still holds the sentinel');
  assert.ok(!text.includes('not for the clipboard'), 'the real text stays off the clipboard');
  await cleanPage();
});

test('a window blur ends a peek: after the About panel has had the focus, Cmd+C puts none of the real text on the clipboard', async () => {
  await cleanPage();
  await keys.type('hidden while away');
  await keys.press('cmd+shift+g');               // peek on
  drive('menu', app.pid, 'Plain Sight', 'About Plain Sight');
  await until(() => drive('cgwindows', app.pid).windows.filter((x) => x.onscreen).length >= 2, 'the About panel', 5000);
  await sleep(500);
  await keys.press('cmd+w');                     // close the About panel
  await sleep(500);
  await focusPage();
  const marker = 'clipboard marker ' + Date.now();
  execFileSync('pbcopy', [], { input: marker });
  await keys.press('cmd+c');                     // would copy the real text if the peek were still on
  await sleep(300);
  const text = drive('clip-text').text;
  note('clipboard after the About panel and Cmd+C: ' + JSON.stringify(text));
  assert.ok(!text.includes('hidden while away'), 'the peek ended when the window lost focus');
  await cleanPage();
});

// Wave B: the real system folder picker, from the intro's folder button. The
// folder the test chooses in the panel is its own, under the evidence
// directory, made before the panel opens and removed after the file it holds
// is kept as evidence; nothing is written into ~/Documents (Mac_PS_010).
const BUILD_TEST = path.join(EVIDENCE, 'folders', 'Chosen in the panel');

test('the system folder picker opens from the folder button, at the normal window level', async () => {
  await quitIfRunning();
  clearTestData();   // a first launch again, so the intro is up
  await launch();
  await pressControl('btn-folder');
  const sheet = await until(() => {
    const w = drive('cgwindows', app.pid).windows.filter((x) => x.onscreen && x.width > 400);
    return w.length >= 2 ? w : null;
  }, 'a second large window (the picker) on screen', 10000);
  note('windows with the picker open: ' + JSON.stringify(sheet));
  const levels = sheet.map((w) => w.layer);
  writeFileSync(path.join(EVIDENCE, 'picker-windows.json'), JSON.stringify(sheet, null, 2));
  assert.ok(levels.every((l) => l === 0), 'the picker sits at the normal window level, not above other apps: layers ' + levels.join(', '));
});

// The folder panel is a sheet on the document window (rfd); its default
// button chooses the folder shown.
const folderSheetShown = () => drive('cgwindows', app.pid).windows.filter((x) => x.onscreen && x.layer === 0 && x.width > 400).length >= 2;
test('choosing the test\'s own folder in the picker (typed into its Go-to box), then Save, writes the text there', async () => {
  mkdirSync(BUILD_TEST, { recursive: true });
  await inPanel(folderSheetShown, async () => {
    await goTo(BUILD_TEST);
    await keys.press('return');   // choose it (the panel's default button), now that the panel shows the test's folder
    await until(() => !folderSheetShown(), 'the picker to close', 8000);
  });
  await keys.press('escape');   // Esc on the intro applies it like Start
  await sleep(600);
  const before = new Set(existsSync(BUILD_TEST) ? readdirSync(BUILD_TEST) : []);
  await keys.type('Written by Plain Sight Desktop into the folder chosen in the system picker.');
  await pressControl('btn-save');
  const fresh = await until(() => { const n = readdirSync(BUILD_TEST).filter((f) => !before.has(f)); return n.length ? n : null; }, 'a new file in the chosen folder', 8000);
  assert.equal(fresh.length, 1);
  assert.match(fresh[0], /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/);
  assert.equal(readFileSync(path.join(BUILD_TEST, fresh[0]), 'utf8'), 'Written by Plain Sight Desktop into the folder chosen in the system picker.');
  // The file stays as evidence; the folder the panel chose goes.
  renameSync(path.join(BUILD_TEST, fresh[0]), path.join(EVIDENCE, 'downloads', 'chosen-folder ' + fresh[0]));
  rmSync(BUILD_TEST, { recursive: true, force: true });
  note('the written file is kept as evidence under downloads/, the chosen folder removed');
});

test('Cmd+Q quits the app', async () => {
  await keys.press('escape');   // the page still holds the saved text, and a quit with text to lose now asks first (D-48)
  await keys.press('cmd+q');
  await until(() => !alive(app.pid), 'the app to quit', 10000);
  app = null;
});

test('Cmd+W closes the window, and closing the window quits the app', async () => {
  await launch();
  await keys.press('cmd+w');
  await until(() => !alive(app.pid), 'the app to quit after Cmd+W', 10000);
  app = null;
});

// Pressed through Accessibility: a posted click on the title bar's buttons
// does not register (app-run-1), while the press runs the button's own action.
test('the window\'s red close button quits the app', async () => {
  await launch();
  drive('close-button', app.pid);
  await until(() => !alive(app.pid), 'the app to quit after the close button', 10000);
  app = null;
});

// Wave G, round 2: the "Quit without saving?" sheet on real keys (D-48,
// Mac_PS_005). With text on the page and no vault, Cmd+Q shows the sheet;
// Return presses Cancel, the default button, and the app stays with its text;
// Cmd+W shows it again, and its Quit button, pressed through Accessibility
// (the sheet is a child of the document window), ends the app.
const sheetShown = () => drive('cgwindows', app.pid).windows.filter((x) => x.onscreen).length >= 2;
test('Cmd+Q with text on the page asks "Quit without saving?": Return cancels and keeps the text; after Cmd+W the sheet\'s Quit button ends the app', async () => {
  await quitIfRunning();
  clearTestData();   // a first launch, so the intro is up and no vault is on
  await launch();
  await keys.press('return');   // the intro's Start button has the focus on a first launch
  await keys.type('words a quit would lose');
  await keys.press('cmd+q');
  await until(sheetShown, 'the sheet after Cmd+Q', 8000);
  note('windows with the sheet: ' + JSON.stringify(drive('cgwindows', app.pid).windows.filter((x) => x.onscreen)));
  await keys.press('return');   // Cancel, the default button
  await until(() => !sheetShown(), 'the sheet to go after Return', 5000);
  await sleep(1500);
  assert.ok(alive(app.pid), 'the app is still running after Cancel');
  assert.equal(await copyRealText('cmd'), 'words a quit would lose', 'the text is untouched');
  await keys.press('cmd+w');
  await until(sheetShown, 'the sheet after Cmd+W', 8000);
  const t0 = Date.now();
  drive('panel-button', app.pid, 'Quit');
  await until(() => !alive(app.pid), 'the app to end after Quit', 10000);
  note('Quit pressed in the sheet: the app ended ' + (Date.now() - t0) + ' ms after the press');
  app = null;
});

// The vault in the release app (AC-3.3, DM-223): turned on in the intro, the
// text typed and Cmd+Q pressed at once, the vault's record found in the release
// app's own web data folder (inside its container when it is sandboxed), and
// the phrase with the chord reopening it after a relaunch.
const VAULT_PHRASE = 'release vault phrase 2026';
const WEB_DATA = webDataFolder(HOME, BUNDLE);
function vaultRecordInReleaseData() {
  const dir = WEB_DATA;
  const out = execFileSync('python3', ['-c', `
import os, sqlite3, sys
found = []
for root, _, files in os.walk(sys.argv[1]):
    for f in files:
        if f.lower() == 'localstorage.sqlite3':
            c = sqlite3.connect('file:' + os.path.join(root, f) + '?mode=ro', uri=True)
            if c.execute("select count(*) from ItemTable where key = 'plainSight.vault'").fetchone()[0]:
                found.append(os.path.join(root, f))
print(len(found))
`, dir], { encoding: 'utf8' });
  return Number(out.trim());
}

test('the vault in the release app keeps the text typed just before Cmd+Q, in its own web data, and the phrase reopens it after a relaunch', async () => {
  await quitIfRunning();
  clearTestData();   // a first launch, so the intro is up
  await launch();
  await pressControl('vault-on');
  await focusControl('vault-phrase');
  await keys.type(VAULT_PHRASE);
  await pressControl('btn-start');
  await sleep(2500);   // the key derives from the phrase
  const words = 'kept in the release vault';
  await keys.type(words);
  await keys.press('cmd+q');   // at once, before the autosave runs
  await until(() => !alive(app.pid), 'the app to quit', 10000);
  app = null;
  assert.equal(vaultRecordInReleaseData(), 1, 'one vault record, in ' + WEB_DATA);
  await launch();
  await keys.type(VAULT_PHRASE);
  await keys.press('cmd+e');
  await keys.press('cmd+return');
  await sleep(2500);   // the key derives again
  assert.equal(await copyRealText('cmd'), words, 'the reopened vault holds every keystroke typed before Cmd+Q');
  await keys.press('cmd+q');
  await until(() => !alive(app.pid), 'the app to quit', 10000);
  app = null;
});

await run(tests, {
  name: 'app',
  needUnlocked: true,
  before: () => {
    frontBefore = driveRaw('frontmost').pid;
    driveRaw('clip-save', path.join(EVIDENCE, 'clipboard.plist'));
  },
  after: async () => {
    // No copy this run opened outlives it, however a test ended; a copy someone
    // else opened is never touched.
    const ours = () => instances().filter((p) => launched.includes(p));
    for (const pid of ours()) driveRaw('quit-app', pid);
    await until(() => !ours().length, 'every copy this run opened to end', 5000).catch(() => ours().forEach((p) => process.kill(p, 'SIGKILL')));
    driveRaw('clip-restore', path.join(EVIDENCE, 'clipboard.plist'));
    if (frontBefore > 0) driveRaw('front', frontBefore);
  }
});
