// Shared parts of the desktop app's end-to-end tests (app.mjs and e2e.mjs):
// the driver, the safety rules for running on someone's Mac, the app's data
// folders, the Downloads folder and a small test runner.
//
// The safety rules:
// - a run starts only while the screen is locked or after PLAIN_SIGHT_IDLE_MIN
//   seconds (default 120) without keyboard or mouse use, and stops at the
//   first touch (exit code 3), because the app's window takes the front. The
//   three suites that launch the app (e2e.mjs, release.mjs, app.mjs) need an
//   unlocked Mac left alone with the display on: they do not start on a
//   locked screen, stop if it locks, and stop as not run when a launch's
//   window is listed only off-screen (firstWindow, DISH-G-50);
// - the app's own data folders are moved aside first and put back after, so
//   a real vault or folder choice is never seen or changed by a test; a run
//   that cannot put one back ends with exit code 6 and says where it is;
// - test data that macOS will not let the run remove (the container a test
//   copy's launch made: App Data protection answers EPERM) is left where it
//   is and named, never counted as the person's data not coming back; with
//   nothing worse, the run ends with exit code 8 (DM-243). A test copy runs
//   once: a run on a copy whose container is still there does not start;
// - only files the run created are moved out of ~/Downloads, into the
//   evidence folder, matched by name and time.
//
// Exit codes, the most serious first when several apply: 6 the app's own
// data could not be put back (the run says where it waits); 3 the run
// stopped (a touch of the keyboard or mouse, the screen locked during a run
// that needs it unlocked, or a launch's window listed only off-screen); 1 a
// test failed; 8 test data left behind,
// your own data is back; 0 every test passed or was not run. A run that does
// not start ends with 4 (the app is open, the Mac is in use, the screen is
// locked for a suite that needs it unlocked, the test copy ran before, or a
// folder could not be moved aside, in which case everything is put back) or
// 5 (another GUI run holds the lock), and launch-guard.mjs ends a suite with
// 7 before the run when it refuses the bundle. A run without the
// Accessibility permission for the program running it does not start and
// ends with 1; a run stopped by Ctrl+C or a kill puts everything back and
// ends with 130. The last lines of a run that starts list any test data left
// behind and every test container on the Mac by name (never opened), the
// summary and the exit code.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleIdentifier } from './launch-guard.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DESKTOP = path.resolve(HERE, '..');
export const ROOT = path.resolve(DESKTOP, '..');
export const ID = 'com.pranavongole.plainsight';
// The bundle under test, when there is one (PLAIN_SIGHT_APP, read by
// release.mjs and app.mjs): a copy under a test identifier (tests/testcopy.mjs,
// DM-240) keeps its data under that identifier, so its folders are moved
// aside and put back like the app's own. A path that is no readable bundle
// counts as the app's own identifier here; the suite's launch guard then
// refuses it with its own message before anything is moved.
export const APP_ID = (process.env.PLAIN_SIGHT_APP && bundleIdentifier(process.env.PLAIN_SIGHT_APP)) || ID;
export const HOME = os.homedir();
// Where macOS keeps the containers of sandboxed apps: listed by name here,
// never opened.
const CONTAINERS = path.join(HOME, 'Library', 'Containers');
// Where the app's downloads land: the real Downloads folder for the release
// app, or the folder named in PLAIN_SIGHT_E2E_DOWNLOADS, which the test build
// writes into instead (folder.rs, e2e feature only). e2e.mjs names a folder
// under the evidence directory before this module loads (e2e-downloads.mjs),
// so a run of the test build never touches ~/Downloads (Mac_PS_010).
export const DOWNLOADS = process.env.PLAIN_SIGHT_E2E_DOWNLOADS || path.join(HOME, 'Downloads');
export const IDLE_MIN = Number(process.env.PLAIN_SIGHT_IDLE_MIN || 120);
export const EVIDENCE = process.env.PLAIN_SIGHT_EVIDENCE || mkdtempSync(path.join(os.tmpdir(), 'plain-sight-test-'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(path.join(EVIDENCE, 'downloads'), { recursive: true });
const logFile = createWriteStream(path.join(EVIDENCE, 'run.log'), { flags: 'a' });
export const note = (line) => logFile.write(new Date().toISOString() + ' ' + line + '\n');

// ---------------------------------------------------------------------------
// The driver, compiled once per source version into the temp folder.
// ---------------------------------------------------------------------------
const DRIVER_SRC = path.join(HERE, 'drive.swift');
const DRIVER = path.join(os.tmpdir(), 'plain-sight-drive-' + createHash('sha256').update(readFileSync(DRIVER_SRC)).digest('hex').slice(0, 12));
if (!existsSync(DRIVER)) execFileSync('swiftc', ['-O', DRIVER_SRC, '-o', DRIVER], { stdio: 'inherit' });

export function driveRaw(...args) {
  let out;
  try {
    out = execFileSync(DRIVER, args.map(String), { encoding: 'utf8', timeout: 30000 });
  } catch (err) {
    out = String(err.stdout || '');
  }
  return JSON.parse(out.trim().split('\n').pop() || '{}');
}
export function drive(...args) {
  guard();
  const result = driveRaw(...args);
  note('drive ' + args.map(String).join(' ').slice(0, 120) + ' -> ' + JSON.stringify(result).slice(0, 200));
  if (!result.ok) throw new Error('driver: ' + (result.error || JSON.stringify(result)) + ' (' + args.join(' ') + ')');
  return result;
}

// ---------------------------------------------------------------------------
// Someone at the keyboard stops the run.
// ---------------------------------------------------------------------------
export class UserActivity extends Error {}
// A test that cannot run in the Mac's present state (one that needs the app's
// window to be the key window while the screen is locked, say) throws NotRun:
// it is counted as not run, with its reason, and the tests after it still run.
export class NotRun extends Error {}
let runStart = 0;
let idleAtStart = 0;
let requireUnlocked = false;
export function guard() {
  if (!runStart) return;
  const s = driveRaw('session');
  const expected = idleAtStart + (Date.now() - runStart) / 1000;
  if (s.idle + 2 < expected) throw new UserActivity('keyboard or mouse used during the run (idle ' + Number(s.idle).toFixed(1) + ' s)');
  if (requireUnlocked && s.locked) throw new UserActivity('the screen locked during the run');
}
// Returns null when the run may start, or the reason it may not.
// Any copy of the app already running, release or test build (both are
// processes named plain-sight). A run moves the app's data aside, so it must
// never start while someone is using the app: their notes would go with it.
export function appCopiesRunning() {
  try { return execFileSync('pgrep', ['-x', 'plain-sight'], { encoding: 'utf8' }).trim().split('\n').map(Number).filter((p) => p > 0); } catch { return []; }
}
export function mayStart({ needUnlocked = false } = {}) {
  const open = appCopiesRunning();
  if (open.length) return 'the app is open (pid ' + open.join(', ') + '); close it first, since a run moves the app\'s data aside';
  // A test copy runs once. The container its first run made is still there,
  // and macOS may let this run neither move it aside nor clear it, so the run
  // would start over that run's data or stop in the middle of the move
  // (DM-243). The container's name is checked; it is never opened.
  if (APP_ID !== ID && existsSync(path.join(CONTAINERS, APP_ID))) return 'the bundle under test, ' + APP_ID + ', has a container from an earlier run, which macOS may let this run neither move aside nor clear; make a fresh copy with npm run app:testcopy, or remove that container by hand (see wave-g/probe/DESIGN.md, Leftovers)';
  const s = driveRaw('session');
  // The three suites that launch the app (e2e.mjs, release.mjs, app.mjs) need
  // it: with the screen locked on 26 October 2026 every window of the app was
  // listed off-screen and the runs said nothing about the app (DISH-G-50).
  if (needUnlocked && s.locked) return 'the screen is locked: these suites need an unlocked Mac left alone, display on';
  if (!s.locked && s.idle < IDLE_MIN) return `the Mac was used ${Number(s.idle).toFixed(0)} s ago; the run needs ${IDLE_MIN} s without keyboard or mouse use`;
  return null;
}
export function startGuard() {
  const s = driveRaw('session');
  runStart = Date.now();
  idleAtStart = s.idle;
  note('run started: screen ' + (s.locked ? 'locked' : 'unlocked') + ', idle ' + Number(s.idle).toFixed(0) + ' s');
}
export function stopGuard() { runStart = 0; }

export async function until(fn, what, ms = 5000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      if (err instanceof UserActivity) throw err;
      last = err;
    }
    await sleep(80);
  }
  throw new Error('timed out after ' + ms + ' ms waiting for ' + what + (last ? ': ' + last.message : ''));
}

// A launch's first wait for its window, in the three suites that launch the
// app. With the screen locked on 26 October 2026, macOS listed the app's
// document window with onscreen false for the whole run (e2e-run-1: 888
// listings, release-run-1: 211, none on-screen), and each wait was counted as
// a failure. So when the wait ends with a window of the document's size
// listed and no window of the app ever on-screen, the run stops as not run
// (exit code 3), as it does at a touch, instead of counting a failure
// (DISH-G-50). AppKit's own helper windows are listed off-screen in every
// run (500 by 500 and 0 by 0 in the runs of 21 October), so they alone count
// as no window: an app that shows no document window still fails. An app
// that made its window and never showed it would look like a locked screen
// here; the suites check the screen before and during the run, so a locked
// screen is refused or stopped first.
export const OFF_SCREEN = 'every window is off-screen (the screen locked or the display asleep during the run)';
export class OffScreen extends UserActivity {}
const documentSized = (w) => w.layer === 0 && w.width >= 600 && w.height >= 400;
export async function firstWindow(pid, want, what, ms) {
  let listed = false;
  let shown = false;
  try {
    return await until(() => {
      const windows = drive('cgwindows', pid).windows;
      if (windows.some(documentSized)) listed = true;
      if (windows.some((w) => w.onscreen)) shown = true;
      return want(windows);
    }, what, ms);
  } catch (err) {
    if (err instanceof UserActivity || !listed || shown) throw err;
    note('the first wait for the window of pid ' + pid + ' saw it only off-screen: ' + err.message);
    throw new OffScreen(OFF_SCREEN);
  }
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Starts an executable with its output in the evidence folder.
export function spawnApp(exe, env = {}) {
  const child = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const out = createWriteStream(path.join(EVIDENCE, 'app-output.log'), { flags: 'a' });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  note('launched ' + exe + ' as pid ' + child.pid);
  return child;
}

export async function stopApp(app) {
  if (!app || !alive(app.pid)) return;
  app.child.kill('SIGTERM');
  await until(() => !alive(app.pid), 'the app to stop', 8000).catch(() => app.child.kill('SIGKILL'));
}

// ---------------------------------------------------------------------------
// The app's data folders: moved aside before the run, put back after.
// ---------------------------------------------------------------------------
const BACKUP_ROOT = path.join(HOME, 'cover-story-delivery', 'desktop', 'appdata-backup');
// The folders an app with this bundle identifier keeps its data in.
const dataFoldersOf = (id) => [
  `Library/WebKit/${id}`,
  `Library/Application Support/${id}`,
  `Library/Caches/${id}`,
  `Library/HTTPStorages/${id}`,
  `Library/HTTPStorages/${id}.binarycookies`,
  `Library/Saved Application State/${id}.savedState`,
  // The sandboxed app (D-37) keeps all of its data in its container. macOS
  // asks the person at the Mac before a program outside the sandbox opens
  // another app's container (Apple, "Accessing files from the macOS App
  // Sandbox"), unless that program has Full Disk Access, so moving it aside
  // can put that question on screen.
  `Library/Containers/${id}`
];
export const DATA_DIRS = [
  ...dataFoldersOf(ID),
  // An executable run outside a bundle keeps its WebKit data under its own name.
  'Library/WebKit/plain-sight',
  'Library/Caches/plain-sight',
  // The test copy's folders too, when the bundle under test is one (DM-240).
  ...(APP_ID === ID ? [] : dataFoldersOf(APP_ID))
].map((p) => path.join(HOME, p));
// A test identifier: a copy's (testcopy.mjs) or a sandbox probe's. A data
// folder whose name starts with one holds test data only, never the
// person's (DM-243).
const TEST_ID = /^com\.pranavongole\.plainsight\.(testcopy|sbprobe)-/;
export const isTestData = (dir) => TEST_ID.test(path.basename(dir));
// The test containers on this Mac, by name only.
export function testContainers() {
  try { return readdirSync(CONTAINERS).filter((name) => TEST_ID.test(name)).sort(); } catch { return []; }
}
let backupDir = null;
// The data folders that were there before the run. The run moves each of them
// aside; a restore clears only a folder the run moved aside or one that was
// not there before, so what was there before can never be cleared in place
// (Mac_PS_011). Kept here and, for the record, as before.json in the backup.
let existedBefore = [];
// Where the run stands with the app's data: 'untouched' before the backup,
// 'moving' while the folders are moved aside, 'aside' once the backup is
// complete (the only state a restore works in), 'restored' after a complete
// restore, when a second restore changes nothing (QA-G-24).
let phase = 'untouched';
const asideOf = (dir) => path.join(backupDir, Buffer.from(dir).toString('base64url'));
// What a backup folder still holds, one line per folder: the place it came
// from (its base64url name decoded), where it waits, and whether moved.json
// lists it. For the run that refuses to start over an earlier backup, and
// for a cleanup that must not run while the backup is incomplete.
export function leftBehind(root = BACKUP_ROOT) {
  const lines = [];
  for (const run of existsSync(root) ? readdirSync(root) : []) {
    const dir = path.join(root, run);
    if (!statSync(dir).isDirectory()) { lines.push('a file, not a backup: ' + dir); continue; }
    let moved = null;
    try { moved = JSON.parse(readFileSync(path.join(dir, 'moved.json'), 'utf8')); } catch { moved = null; }
    const names = readdirSync(dir).filter((n) => n !== 'moved.json' && n !== 'before.json');
    for (const name of names) {
      const from = Buffer.from(name, 'base64url').toString();
      const listed = moved === null ? 'moved.json is missing' : moved.includes(from) ? 'listed in moved.json' : 'not listed in moved.json';
      lines.push('put back ' + from + ' from ' + path.join(dir, name) + ' (' + listed + ')');
    }
    if (!names.length) lines.push('nothing to put back from ' + dir + ', which can be removed');
  }
  return lines;
}
export function backupAppData() {
  if (existsSync(BACKUP_ROOT) && readdirSync(BACKUP_ROOT).length) {
    throw new Error('an earlier run left app data in ' + BACKUP_ROOT + '; put it back by hand before running again:\n  ' + leftBehind().join('\n  '));
  }
  phase = 'moving';
  backupDir = path.join(BACKUP_ROOT, String(Date.now()));
  existedBefore = DATA_DIRS.filter((dir) => existsSync(dir));
  const moved = [];
  for (const dir of existedBefore) {
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, 'before.json'), JSON.stringify(existedBefore, null, 2));
    try {
      renameSync(dir, asideOf(dir));
    } catch (err) {
      // A move that macOS refuses (the container's, say) puts back what was
      // already moved, so the run stops with every folder in its place. The
      // empty backup folder is then removed, never anything with data in it.
      for (const done of moved.reverse()) renameSync(asideOf(done), done);
      rmSync(path.join(backupDir, 'moved.json'), { force: true });
      rmSync(path.join(backupDir, 'before.json'), { force: true });
      rmdirSync(backupDir);
      if (!readdirSync(BACKUP_ROOT).length) rmdirSync(BACKUP_ROOT);
      backupDir = null;
      existedBefore = [];
      phase = 'untouched';
      throw new Error('could not move ' + dir + ' aside (' + (err.code || err.message) + '); everything was put back');
    }
    moved.push(dir);
    // Written after every move, so a run that is stopped leaves an exact record.
    writeFileSync(path.join(backupDir, 'moved.json'), JSON.stringify(moved, null, 2));
  }
  if (!moved.length) backupDir = null;
  phase = 'aside';
  note('app data moved aside: ' + JSON.stringify(moved));
}
const movedAside = () => (backupDir ? JSON.parse(readFileSync(path.join(backupDir, 'moved.json'), 'utf8')) : []);
// A folder that holds the run's own data: one the run moved aside (what is
// there now came after), or one that was not there before the run.
const clearable = (dir, moved) => moved.includes(dir) || !existedBefore.includes(dir);
export function clearTestData() {
  if (phase !== 'aside') throw new Error('the app data is not moved aside (' + phase + '), so nothing is cleared');
  const moved = movedAside();
  for (const dir of DATA_DIRS) if (clearable(dir, moved)) rmSync(dir, { recursive: true, force: true });
}
// Puts the app's data back folder by folder: the test data in each place is
// cleared, then what was there before the run comes back. A folder that
// cannot be cleared (a container that macOS keeps closed, say) never keeps
// the others from coming back. What could not come back stays in the backup,
// which then lists only that, and the error says where it is. The backup is
// never deleted recursively, and a folder that was there before the run and
// is not in the backup (one an earlier restore put back, say) is in its place
// already: it is never cleared. Before the backup, and while it is incomplete,
// nothing is cleared or put back: the run refuses and names what to put back
// by hand and from where; after a complete restore a second call changes
// nothing (QA-G-24). A test identifier's folder that the run made and that
// macOS will not let it remove (a test copy's container: EPERM, or EACCES)
// holds test data only: it is left where it is and returned in the list of
// test data left behind, never counted as a folder that did not come back
// (DM-243). Returns that list.
export function restoreAppData() {
  if (phase === 'untouched') { note('nothing to restore: the app data was never moved aside'); return []; }
  if (phase === 'restored') { note('nothing to restore: the app data is back already'); return []; }
  if (phase === 'moving') {
    throw new Error('the backup of the app data is incomplete, so nothing is cleared or put back by the run; put back by hand:\n  ' + leftBehind().join('\n  '));
  }
  const moved = movedAside();
  const problems = [];
  const left = [];
  const testDataLeft = [];
  for (const dir of DATA_DIRS) {
    if (!clearable(dir, moved)) continue;
    let step = 'clear the test data in';
    try {
      rmSync(dir, { recursive: true, force: true });
      step = 'put back';
      if (moved.includes(dir)) renameSync(asideOf(dir), dir);
    } catch (err) {
      if (step === 'clear the test data in' && !moved.includes(dir) && isTestData(dir) && (err.code === 'EPERM' || err.code === 'EACCES')) {
        testDataLeft.push(dir);
        continue;
      }
      problems.push('could not ' + step + ' ' + dir + ' (' + (err.code || err.message) + ')');
      if (moved.includes(dir)) left.push(dir);
    }
  }
  if (left.length) {
    writeFileSync(path.join(backupDir, 'moved.json'), JSON.stringify(left, null, 2));
    problems.push('what was in ' + left.join(', ') + ' before the run is still in ' + backupDir);
  } else if (backupDir) {
    rmSync(path.join(backupDir, 'moved.json'), { force: true });
    rmSync(path.join(backupDir, 'before.json'), { force: true });
    try {
      rmdirSync(backupDir);
      if (!readdirSync(BACKUP_ROOT).length) rmdirSync(BACKUP_ROOT);
    } catch (err) {
      problems.push('the backup folder ' + backupDir + ' was not empty (' + (err.code || err.message) + ')');
    }
  }
  if (problems.length) throw Object.assign(new Error(problems.join('; ')), { testDataLeft });
  backupDir = null;
  existedBefore = [];
  phase = 'restored';
  note('app data restored' + (testDataLeft.length ? '; test data left behind: ' + JSON.stringify(testDataLeft) : ''));
  return testDataLeft;
}

// The run's own safety: Ctrl+C and a kill are watched from the start, before
// the app's data is moved aside, so a signal during the move cannot end the
// run by its default action with a folder half moved and the next run
// refusing to start (QA-G-24). Node runs a signal handler only between turns
// of the event loop and the backup is one synchronous stretch, so a signal
// during it is taken after it, when the cleanup puts everything back; and
// a cleanup that ever ran with the backup incomplete is refused by
// restoreAppData, which clears nothing and names what to put back. Exported
// for the harness checks, which run it against a fake home.
export function watchSignalsThenBackup(cleanup) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { note('stopped by ' + signal); cleanup().finally(() => process.exit(130)); });
  }
  backupAppData();
}

// ---------------------------------------------------------------------------
// Downloads: only files this run created, matched by name and time: the
// names Save makes, the encrypted file and the three plain formats.
// ---------------------------------------------------------------------------
const OURS = /^(untitled-draft|q3-planning-notes|manuscript-draft)-\d{8}-\d{4}( \(\d+\))?\.sight$|^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}( \(\d+\))?\.(txt|md|docx)$/;
let downloadsBefore = new Set();
export function markDownloads() { downloadsBefore = new Set(readdirSync(DOWNLOADS)); }
export function newDownloads() {
  return readdirSync(DOWNLOADS).filter((n) => !downloadsBefore.has(n) && OURS.test(n) && statSync(path.join(DOWNLOADS, n)).mtimeMs >= runStartedAt - 1000);
}
let runStartedAt = Date.now();
export function collectDownloads() {
  const moved = [];
  for (const name of newDownloads()) {
    renameSync(path.join(DOWNLOADS, name), path.join(EVIDENCE, 'downloads', name));
    moved.push(name);
  }
  note('downloads moved to evidence: ' + JSON.stringify(moved));
  return moved;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
// The novel as the engine renders it with no typos: markers consumed, one
// block per line. Visible cover text must be a prefix of this, give or take
// one wrong letter at the very end (a simulated typo waiting for its fix).
export async function novelText() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'covers', 'book.js')).href);
  const blocks = [];
  let cur = null;
  for (const raw of mod.default.text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { cur = null; continue; }
    const marker = line.startsWith('## ') || line.startsWith('- ');
    if (marker || !cur || cur.marker) { cur = { marker, text: line.replace(/^(## |- )/, '') }; blocks.push(cur); }
    else cur.text += ' ' + line;
  }
  return blocks.map((b) => b.text).join('\n');
}
export function isCoverPrefix(visible, full) {
  return full.startsWith(visible) || full.startsWith(visible.slice(0, -1));
}

// Decrypts a .sight file or vault record outside the app, to prove what it saved.
export async function decryptRecord(record, password) {
  const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: Buffer.from(record.salt, 'base64'), iterations: record.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(record.iv, 'base64') }, key, Buffer.from(record.data, 'base64')));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
// One GUI run at a time on this Mac: two would fight over the app's data
// folders, the Downloads folder and the front window.
const LOCK = path.join(HOME, 'cover-story-delivery', 'desktop', '.gui-test.lock');
function takeLock(name) {
  mkdirSync(path.dirname(LOCK), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Created only if it does not exist yet, so two runs cannot both take it.
      writeFileSync(LOCK, process.pid + ' ' + name + ' ' + new Date().toISOString(), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = Number(readFileSync(LOCK, 'utf8').split(' ')[0]);
      if (holder && alive(holder)) return false;
      rmSync(LOCK, { force: true });   // left by a run that no longer exists
    }
  }
  return false;
}
function dropLock() {
  if (existsSync(LOCK) && Number(readFileSync(LOCK, 'utf8').split(' ')[0]) === process.pid) rmSync(LOCK);
}

export async function run(tests, { name, needUnlocked = false, before = () => {}, after = async () => {} }) {
  const only = process.env.PLAIN_SIGHT_ONLY ? new RegExp(process.env.PLAIN_SIGHT_ONLY) : null;
  if (!driveRaw('trusted').accessibility) { console.log('Accessibility permission is missing for the program running the tests. Errors: 1'); process.exit(1); }
  const reason = mayStart({ needUnlocked });
  if (reason) { console.log(`${name}: not started: ${reason}. Errors: 0`); process.exit(4); }
  if (!takeLock(name)) { console.log(`${name}: not started: another GUI test run holds ${LOCK}. Errors: 0`); process.exit(5); }
  requireUnlocked = needUnlocked;
  // Ctrl+C or a kill puts everything back: the app stops, its data and the
  // Downloads folder are restored, the lock is released.
  let cleaned = false;
  let restored = true;
  let testDataLeft = [];
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    stopGuard();
    try { await after(); } catch (err) { note('after: ' + err.message); }
    try { collectDownloads(); } catch (err) { note('downloads: ' + err.message); }
    try { testDataLeft = restoreAppData(); } catch (err) { restored = false; testDataLeft = err.testDataLeft || []; console.log('Could not restore app data: ' + err.message); }
    for (const dir of testDataLeft) console.log('test data left behind: ' + dir + ' (macOS refused to remove it; remove it by hand, see wave-g/probe/DESIGN.md, Leftovers)');
    dropLock();
  };
  markDownloads();
  runStartedAt = Date.now();
  try {
    watchSignalsThenBackup(cleanup);
  } catch (err) {
    // A move aside that macOS refuses, or a backup an earlier run left:
    // backupAppData put back whatever it had moved, so the run did not start
    // (DM-243). Before, the error left the run with exit code 1 and the lock.
    dropLock();
    console.log(`${name}: not started: ${err.message}. Errors: 0`);
    process.exit(4);
  }
  startGuard();
  let passed = 0, failed = 0, notRun = 0, stopped = null;
  try {
    await before();
    for (const t of tests) {
      if (only && !only.test(t.name)) continue;
      if (stopped) { notRun += 1; console.log('skip - ' + t.name + ' (not run: ' + stopped + ')'); continue; }
      try {
        await t.fn();
        passed += 1;
        console.log('ok   - ' + t.name);
      } catch (err) {
        if (err instanceof UserActivity) { stopped = err.message; notRun += 1; console.log('stop - ' + t.name + ' (' + err.message + ')'); continue; }
        if (err instanceof NotRun) { notRun += 1; console.log('skip - ' + t.name + ' (not run: ' + err.message + ')'); continue; }
        failed += 1;
        console.log('FAIL - ' + t.name);
        console.log('       ' + String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n       '));
      }
    }
  } finally {
    await cleanup();
  }
  console.log(`\nEvidence: ${EVIDENCE}`);
  console.log('Test containers on this Mac at the end of the run (names only, never opened): ' + (testContainers().join(', ') || 'none'));
  console.log(`${passed} passed, ${failed} failed, ${notRun} not run, ${passed + failed + notRun} total. Errors: ${failed + (restored ? 0 : 1)}`);
  const code = !restored ? 6 : stopped ? 3 : failed ? 1 : testDataLeft.length ? 8 : 0;
  console.log('Exit code: ' + code + (code === 8 ? ' (test data left behind; your own data is back)' : ''));
  process.exit(code);
}
