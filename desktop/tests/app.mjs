// Black-box tests of the built app (the release bundle, no test hooks) with
// real key presses through macOS: the keyboard path into the page, the menu
// bar, the clipboard, the window and the process. They need the screen
// unlocked, so they start only when the Mac has been left alone for a while
// with the screen on (see harness.mjs), they stop at the first touch, and a
// launch's window listed only off-screen stops the run as not run
// (harness.mjs, firstWindow; DISH-G-50).
// What happens inside the page is checked in e2e.mjs; here the page is read
// only through what a person can do: peek, copy, and paste the clipboard.
//
// Run from desktop/: npm run test:app   (exit code 0 only when every test passes)

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DESKTOP, EVIDENCE, HOME, NotRun, alive, copiesOf, decryptRecord, drive, driveRaw, endCopies, firstWindow, freshStart, note, recordLaunch, refuseLaunchWhileEnding, run, sleep, until } from './harness.mjs';
import { appMenuTitle, launchable, menuBarOf, webDataFolder } from './launch-guard.mjs';

const APP = process.env.PLAIN_SIGHT_APP || path.join(DESKTOP, 'src-tauri/target/release/bundle/macos/Plain Sight.app');
// Before anything else, and before the harness's run() moves any data aside:
// a bundle sandboxed under the real identifier is refused (DM-240, ledger
// D-39) unless PLAIN_SIGHT_ALLOW_REAL_ID=1; until the move of the app's data
// this suite runs on a copy under a test identifier (npm run app:testcopy,
// then PLAIN_SIGHT_APP=<the copy>). The facts read here also say where the
// bundle's web data lives: in its container when it is sandboxed.
const BUNDLE = launchable('app', APP);
// The app menu is titled by the bundle's name, "Plain Sight test copy" on a
// test copy; its items keep the app's own words (DM-241).
const APP_MENU = appMenuTitle(BUNDLE);
// The bundle the next launch opens: the bundle under test, or the fresh copy
// of it that a test asked for a first launch (firstLaunchAgain, DM-247); and
// every bundle this run opened, for finding and ending its copies.
let current = BUNDLE;
const opened = [BUNDLE.app];
let app = null;   // { pid }
let frontBefore = -1;

const launched = [];

// Every running copy of the release app, from any bundle this run opened: a
// process whose program, as ps names it, is that bundle's executable
// (harness.mjs, copiesOf; round 13).
function instances() {
  return [...new Set(opened.flatMap((bundle) => copiesOf(bundle)))];
}

// Opened the way a person opens it, through LaunchServices. A copy left
// running would be found in place of the new one, so none may be running.
// Never once the run is ending; and a launch under way when it began is
// marked (launching) until its copy is recorded, so that after() ends that
// copy too (DM-249).
let launching = false;
async function launch() {
  refuseLaunchWhileEnding('the release app');
  assert.deepEqual(instances(), [], 'no copy of the release app is running before it is opened');
  launching = true;
  let pid = 0;
  try {
    execFileSync('open', ['-n', current.app]);
    pid = await until(() => instances().find((p) => !launched.includes(p)) || 0, 'the app process', 15000);
    launched.push(pid);
    recordLaunch(pid, current.app);
  } finally {
    launching = false;
  }
  app = { pid };
  note('opened pid ' + pid);
  await firstWindow(pid, (windows) => windows.some((w) => w.layer === 0 && w.onscreen), 'the app window', 15000);
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

// A first launch again, so the intro is up and no vault is on. The harness's
// freshStart clears an unsandboxed bundle's data; a sandboxed bundle's
// container is never cleared during the run, since macOS refused that removal
// (EPERM, release-run-1): the next launch opens a fresh copy of the bundle
// under test instead, under a new test identifier (DM-247).
async function firstLaunchAgain() {
  await quitIfRunning();
  current = freshStart(BUNDLE);
  if (!opened.includes(current.app)) opened.push(current.app);
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
  assert.deepEqual(menus.filter((t) => t !== 'Apple'), menuBarOf(BUNDLE));
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
// the same files. It sits alone in a folder of the test's own under the
// evidence directory (DM-263, round 14): once the open panel shows that
// folder, the panel has no other file for Open to open.
const OPEN_FROM = path.join(EVIDENCE, 'folders', 'Opened from the panel');
const OPEN_NAME = 'made-outside-the-app.sight';
async function sightFile(text, password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const data = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const b64 = (u) => Buffer.from(u).toString('base64');
  mkdirSync(OPEN_FROM, { recursive: true });
  const file = path.join(OPEN_FROM, OPEN_NAME);
  writeFileSync(file, JSON.stringify({ format: 'plain-sight', version: 1, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations: 310000, salt: b64(salt), iv: b64(iv), data: b64(data) }, null, 2));
  return file;
}

// The page's Open panel is an app-modal dialog titled "Open" at window level
// 8; Accessibility lists it about a second before it is on screen, and while
// it is open the app takes no other input, so a test that fails with it open
// cancels it (diag-open-panel, app-run-2).
//
// macOS draws open and save panels in a separate process (Apple's NSOpenPanel
// and NSSavePanel pages: always since macOS 10.15, sandboxed or not), and the
// driver posts keys only to the app's own process, so a key reaches a panel
// only through the app; no real-key run saw a panel take a typed character
// (PO-R13-1). The steps inside a panel go by the clipboard instead (goTo,
// round 14). A failed step presses the panel's Cancel through
// Accessibility (the driver's panel-button), noting each try in run.log,
// whether or not the test's own check sees the panel: in app-run-1 the save
// panel was smaller than that check expected, stayed up and blocked every
// later test. Esc only when no Cancel button is found.
const openPanelShown = () => (driveRaw('windows', app.pid).windows || []).some((w) => w.title === 'Open' && w.subrole === 'AXDialog');
async function inPanel(isOpen, steps) {
  try { await steps(); } catch (err) {
    for (let i = 0; i < 4; i++) {
      const shown = isOpen();
      const cancel = driveRaw('panel-button', app.pid, 'Cancel');
      note('a panel step failed; cancel try ' + (i + 1) + ': the test sees the panel ' + shown + ', panel-button Cancel -> ' + JSON.stringify(cancel));
      if (!cancel.ok && !shown) break;
      if (!cancel.ok) await keys.press('escape');
      await sleep(1000);
    }
    throw err;
  }
}
// The panels, read through Accessibility (round 14): the app's dialogs (the
// open panel) and the sheets on its windows (the save and folder panels),
// with everything inside them, never the page. Each read is a driveRaw, so a
// poll writes nothing to run.log; the depth reaches a panel's buttons, menus
// and fields.
const PANEL_DEPTH = 12;
// The Go to Folder sheet on this macOS (FinderKit's GotoWindow.nib and
// GotoWindow.loctable, read in round 14): a window titled "Go to Folder", a
// path field labelled "Enter a Path", a list of completions and a close
// button ("CloseButton", an xmark image). It has no Go button.
const GO_TO_TITLE = 'Go to Folder';
const GO_TO_FIELD = 'Enter a Path';
const FIELD_ROLES = ['AXTextField', 'AXComboBox'];
const isField = (node) => FIELD_ROLES.includes(node.role);
const opensPanel = (node) => node.subrole === 'AXDialog' || node.role === 'AXSheet' || node.title === GO_TO_TITLE;
function panelNodes() {
  const found = [];
  const walk = (node, inside) => {
    if (!node || typeof node !== 'object') return;
    const here = inside || opensPanel(node);
    if (here) found.push(node);
    for (const child of node.children || []) walk(child, here);
  };
  for (const w of driveRaw('tree', app.pid, PANEL_DEPTH).windows || []) walk(w, false);
  return found;
}
function within(node, test) {
  if (!node || typeof node !== 'object') return null;
  if (test(node)) return node;
  for (const child of node.children || []) {
    const hit = within(child, test);
    if (hit) return hit;
  }
  return null;
}
// The Go to Folder sheet's own field: the first field inside a node titled
// "Go to Folder", or a field labelled "Enter a Path"; never the save panel's
// name field, so a Return sent while this field is seen can act on the sheet
// alone. null while no such sheet is up.
function goToField() {
  const nodes = panelNodes();
  const sheet = nodes.find((n) => n.title === GO_TO_TITLE);
  return (sheet && within(sheet, isField)) || nodes.find((n) => isField(n) && [n.title, n.description].includes(GO_TO_FIELD)) || null;
}
// The folder a panel shows: the value of its location menu (the open panel's
// folder menu, the save panel's "Where" menu), by name.
const panelFolders = () => panelNodes().filter((n) => n.role === 'AXPopUpButton' && typeof n.value === 'string').map((n) => n.value);
// What the panels show, for run.log when a step fails: the titles of their
// windows, sheets and buttons, their menus' values and their fields' values,
// leaving out every file list (its names can be the person's files).
function panelSummary() {
  const LISTS = ['AXOutline', 'AXTable', 'AXList', 'AXBrowser', 'AXGrid', 'AXRow', 'AXCell'];
  const out = [];
  const walk = (node, inside, listed) => {
    if (!node || typeof node !== 'object') return;
    const here = inside || opensPanel(node);
    const inList = listed || LISTS.includes(node.role);
    if (here && !inList) {
      if (['AXWindow', 'AXSheet', 'AXButton'].includes(node.role) && node.title) out.push(node.role + ' ' + JSON.stringify(node.title));
      if (node.role === 'AXPopUpButton' && typeof node.value === 'string') out.push('menu ' + JSON.stringify(node.value));
      if (isField(node)) out.push('field ' + JSON.stringify(String(node.value ?? '')) + (node.description ? ' (' + node.description + ')' : ''));
    }
    for (const child of node.children || []) walk(child, here, inList);
  };
  try {
    for (const w of driveRaw('tree', app.pid, PANEL_DEPTH).windows || []) walk(w, false, false);
  } catch (err) {
    out.push('(the tree could not be read: ' + err.message + ')');
  }
  return out;
}

// Go to a folder, or to a file, whose folder the panel then shows with the
// file selected, through the panel's Go to Folder sheet (round 14, PO-R13-1).
// Every event stays on the app's own process, and each step is read back
// through Accessibility before the next:
// 1. the path on the clipboard (the run saved the person's clipboard before
//    its first test and puts it back at its end);
// 2. Cmd+Shift+G, then the Go to Folder sheet's field must be seen;
// 3. Cmd+V, the app's Paste, then that field must hold exactly the path. A
//    typed path never reaches a panel; the app's Edit actions do (Cmd+C put
//    the save panel's proposed name on the clipboard through the app's Copy
//    in app-run-1, 16:08:06.364: "VBWAIT: validate action", "sendAction:");
// 4. Return, then the sheet must be gone and the panel must show the folder
//    by its location menu. The sheet has no Go button. Return reached a
//    panel as a key equivalent in wave-d app-run-1 and app-run-3 (21
//    October: the folder panel's default button, with no other input), and
//    it is sent only while the sheet's own field is seen holding the path.
// A step not seen fails here, so no panel button is pressed over the
// panel's start folder (DM-239 d) and inPanel cancels the panel. A Go to
// Folder sheet left up would hold off the panel's Cancel, so a failure first
// presses Esc, the sheet's close key, and notes what the panels show.
async function goTo(target, folder = target) {
  const name = path.basename(folder);
  try {
    execFileSync('pbcopy', [], { input: target });
    await keys.press('cmd+shift+g');
    await until(() => goToField() !== null, 'the panel\'s Go to Folder sheet after Cmd+Shift+G', 10000);
    await keys.press('cmd+v');
    await until(() => (goToField() || {}).value === target, 'the Go to Folder field to hold the pasted path', 10000);
    await keys.press('return');   // go: only the sheet's field, seen holding the path, can take it
    await until(() => goToField() === null && panelFolders().includes(name), 'the panel to show ' + name + ' after the Go to Folder sheet', 15000);
  } catch (err) {
    let sheetUp = false;
    try { sheetUp = goToField() !== null; } catch { /* the read failed too */ }
    if (sheetUp) await keys.press('escape');
    note('the Go to Folder step failed' + (sheetUp ? ' with the sheet up (Esc pressed)' : '') + '; the panels show: ' + JSON.stringify(panelSummary()));
    throw err;
  }
  note('the panel shows ' + name + ' after the Go to Folder sheet');
}
// DM-263 (and DM-239 d): a panel's own button acts on the folder the panel
// shows, and the open panel's Open on the file selected in it. The button is
// pressed only when the panel shows the test's own folder, by its location
// menu, and that folder holds exactly what the test put there: its one file
// for Open, nothing for Save and for the folder panel, so the button can act
// on nothing but the test's own. The driver reads no selection (its tree has
// no AXSelected), so the open test makes the selection not matter: in a
// folder that holds the test's file alone, Open can open only that file.
// Otherwise the test fails here, naming the folder the panel shows by its
// name only, and inPanel cancels the panel.
function mustShowOwnFolder(folder, holds) {
  const name = path.basename(folder);
  const shown = panelFolders();
  if (!shown.includes(name)) {
    throw new Error('the panel shows ' + (shown.length ? shown.map((s) => JSON.stringify(s)).join(', ') : 'no folder by name') + ', not the test\'s own folder ' + JSON.stringify(name) + ', so the test cancels the panel instead of pressing its button');
  }
  const held = readdirSync(folder).sort();
  if (JSON.stringify(held) !== JSON.stringify(holds)) {
    throw new Error('the test\'s own folder ' + JSON.stringify(name) + ' holds ' + JSON.stringify(held) + ', not ' + JSON.stringify(holds) + ', so the test cancels the panel instead of pressing its button');
  }
  note('the panel shows the test\'s own folder ' + name + ', which holds ' + JSON.stringify(holds));
}
// A panel's own button, pressed through Accessibility (the driver's
// panel-button), never by Return: the first of the titles the panel has.
async function pressPanelButton(...titles) {
  const pressed = await until(() => titles.find((title) => driveRaw('panel-button', app.pid, title).ok), 'the panel\'s ' + titles.join(' or ') + ' button', 5000);
  note('panel-button ' + pressed + ' pressed');
}

// Open: the page's Open button, the system open panel, Go to the file by the
// clipboard (goTo), the panel's Open button through Accessibility, then the
// page's password dialog, typed with real keys.
async function openWithKeys(file, password) {
  await pressControl('btn-open');
  await until(() => openPanelShown() && drive('cgwindows', app.pid).windows.some((w) => w.onscreen && w.layer === 8), 'the open panel on screen', 10000);
  await sleep(800);
  await inPanel(openPanelShown, async () => {
    await goTo(file, path.dirname(file));   // the panel shows the file's folder, with the file selected
    mustShowOwnFolder(path.dirname(file), [path.basename(file)]);   // DM-263: Open can open nothing but the test's file
    await pressPanelButton('Open');
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
// The save panel is a second window on screen at the normal level, of any
// size: in app-run-1 (29 October, the sandboxed copy) it came up 370 by 210
// in its compact form, centred on the document window, and a check for a
// second window wider than 400 never saw it (PO-R13-1).
const savePanelShown = () => drive('cgwindows', app.pid).windows.filter((x) => x.onscreen && x.layer === 0).length >= 2;
test('Save without a folder opens the system save panel; saved into the test\'s own folder through the panel, the .sight file decrypts to the text', async () => {
  mkdirSync(SAVE_AS, { recursive: true });
  await cleanPage();
  await keys.type('saved through the panel');
  await pressControl('btn-save');
  await sleep(700);
  await keys.type('panel password 2026');   // the page's password dialog, then its Save button
  await keys.press('return');
  await sleep(3000);   // the key derives from the password (310,000 rounds)
  await inPanel(savePanelShown, async () => {
    await until(savePanelShown, 'the save panel on screen', 10000);
    note('windows with the save panel open: ' + JSON.stringify(drive('cgwindows', app.pid).windows.filter((x) => x.onscreen)));
    await goTo(SAVE_AS);
    mustShowOwnFolder(SAVE_AS, []);   // DM-263's rule: the folder Save writes into is the test's own, still empty
    await pressPanelButton('Save');   // through Accessibility, now that the panel shows the test's folder
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
  drive('menu', app.pid, APP_MENU, 'About Plain Sight');
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

// Super Stealth (web 1.5.0, BR-46) in the app (round 16): the ? button opens
// the intro after the set number of quick clicks, the page's default until a
// count is stored, and Cmd+Shift+H opens it whatever the count; no app menu
// item takes Shift+H (config.mjs), so the page gets the chord. The clicks
// are Accessibility presses about 150 ms apart, inside the page's 600 ms
// window. The count is set as a person sets it, by typing its figure into the
// focused setting, and Start keeps it. The folder tests that follow open a
// fresh copy, which starts with nothing stored.
const HELP_CLICKS_DEFAULT = Number(readFileSync(path.join(DESKTOP, '..', 'index.html'), 'utf8').match(/const HELP_CLICKS_DEFAULT = (\d+);/)[1]);
const introShown = () => drive('text', app.pid, 'intro').present === true;
const helpSetting = () => (drive('controls', app.pid).controls.find((c) => c.id === 'help-clicks') || {}).value;
async function clickHelp(times) {
  for (let i = 0; i < times; i++) {
    drive('press', app.pid, 'btn-help');
    await sleep(150);
  }
}
test('Super Stealth in the app: the ? button opens the intro after the default count of quick clicks, then only after a stored count, and Cmd+Shift+H opens it whatever the count', async () => {
  await cleanPage();
  await reachPage();
  assert.equal(introShown(), false, 'the intro is closed');
  if (HELP_CLICKS_DEFAULT > 1) {
    await clickHelp(HELP_CLICKS_DEFAULT - 1);
    await sleep(1000);
    assert.equal(introShown(), false, 'one click short of the default shows nothing');
  }
  await clickHelp(HELP_CLICKS_DEFAULT);
  await until(introShown, 'the intro after ' + HELP_CLICKS_DEFAULT + ' quick click(s), the default', 3000);
  note('the setting with nothing stored: ' + JSON.stringify(helpSetting()));
  await focusControl('help-clicks');
  await keys.type('3');
  await until(() => /^3 /.test(String(helpSetting())), 'the setting to show 3 quick clicks', 3000);
  await pressControl('btn-start');
  await until(() => !introShown(), 'the intro to close after Start', 3000);
  await clickHelp(1);
  await sleep(1000);
  assert.equal(introShown(), false, 'with 3 stored, one click on ? shows nothing');
  await clickHelp(3);
  await until(introShown, 'the intro after 3 quick clicks', 3000);
  await pressControl('btn-start');
  await until(() => !introShown(), 'the intro to close after Start', 3000);
  await keys.press('cmd+shift+h');
  await until(introShown, 'the intro after Cmd+Shift+H', 3000);
  await pressControl('btn-start');
  await cleanPage();
});

// Wave B: the real system folder picker, from the intro's folder button. The
// folder the test chooses in the panel is its own, under the evidence
// directory, made before the panel opens and removed after the file it holds
// is kept as evidence; nothing is written into ~/Documents (Mac_PS_010).
const BUILD_TEST = path.join(EVIDENCE, 'folders', 'Chosen in the panel');

test('the system folder picker opens from the folder button, at the normal window level', async () => {
  await firstLaunchAgain();
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
    mustShowOwnFolder(BUILD_TEST, []);   // DM-263's rule: the folder chosen is the one shown, the test's own and empty, so nothing in it can be chosen instead
    await pressPanelButton('Open', 'Choose');   // the folder panel's default button (rfd sets no prompt, so NSOpenPanel's own "Open"), through Accessibility
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
  await firstLaunchAgain();
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
// text typed and Cmd+Q pressed at once, the vault's record found in the web
// data folder of the bundle the test launched (inside its container when it
// is sandboxed: a fresh copy's, DM-247), and the phrase with the chord
// reopening it after a relaunch.
const VAULT_PHRASE = 'release vault phrase 2026';
function vaultRecordInReleaseData() {
  const dir = webDataFolder(HOME, current);
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
  await firstLaunchAgain();
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
  assert.equal(vaultRecordInReleaseData(), 1, 'one vault record, in ' + webDataFolder(HOME, current));
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

// The person's clipboard, kept in the evidence folder for the run: the
// tests write markers and paths to the clipboard (pbcopy), so before() saves
// it before the first test, and after() puts it back (PO-R14-1, round 15).
const CLIPBOARD = path.join(EVIDENCE, 'clipboard.plist');

await run(tests, {
  name: 'app',
  needUnlocked: true,
  before: () => {
    frontBefore = driveRaw('frontmost').pid;
    note('clipboard saved: ' + JSON.stringify(driveRaw('clip-save', CLIPBOARD)));
  },
  after: async () => {
    // Every copy running from a bundle this run opened ends with the run,
    // recorded or not: a launch whose wait for its pid timed out never
    // recorded its copy, which was left running (DISH I-14, QA-01's
    // observation 6). The run starts only when no copy of the app is running
    // (mayStart), so these are the run's own. A launch under way when the run
    // began to end records its copy first (DM-249).
    // endCopies asks each copy to quit and ends any copy still running 5 s
    // later; a copy is a process whose program is one of the opened bundles'
    // executables, so a bystander whose arguments merely hold such a path is
    // never touched (round 13).
    // The clipboard goes back after the copies have ended, so that none
    // writes to it afterwards, and before the front app comes back; in a
    // finally, so nothing the wait or endCopies meets can skip it. The
    // harness's cleanup calls after() on every path that ends a run once
    // before() has run: a signal, a stop, a launch refused while the run
    // ends, and the end itself (PO-R14-1, round 15).
    try {
      await until(() => !launching, 'a launch under way to record its copy', 16000).catch(() => {});
      await endCopies(opened, (pid) => driveRaw('quit-app', pid));
    } finally {
      note('clipboard put back: ' + JSON.stringify(driveRaw('clip-restore', CLIPBOARD)));
      if (frontBefore > 0) driveRaw('front', frontBefore);
    }
  }
});
