// Tests of the release app itself, the sealed bundle `npm run app:build`
// makes, without key presses: it opens through LaunchServices as a
// double-click does, its menu bar is the app's own, and each way out (the
// Quit item, a quit request as the Dock sends it, the window's close button
// and Close Window) ends it. The suite needs an unlocked Mac left alone with
// the display on: with the screen locked on 26 October 2026 macOS listed
// every window of the app off-screen (release-run-1), so a locked screen is
// refused and a launch's window listed only off-screen stops the run as not
// run (harness.mjs, firstWindow; DISH-G-50). The close button and Close
// Window tests still report not run when Accessibility shows no windows or
// the window is not the key window. The network watch runs around all of
// it.
//
// Run from desktop/ after `npm run app:build`: npm run test:release

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DESKTOP, EVIDENCE, HOME, NotRun, alive, drive, firstWindow, note, recordLaunch, refuseLaunchWhileEnding, run, sleep, until } from './harness.mjs';
import { appMenuTitle, launchable, menuBarOf, webDataFolder } from './launch-guard.mjs';

const APP = process.env.PLAIN_SIGHT_APP || path.join(DESKTOP, 'src-tauri/target/release/bundle/macos/Plain Sight.app');
// Before anything else, and before the harness's run() moves any data aside:
// a bundle sandboxed under the real identifier is refused (DM-240, ledger
// D-39) unless PLAIN_SIGHT_ALLOW_REAL_ID=1; until the move of the app's data
// this suite runs on a copy under a test identifier (npm run app:testcopy,
// then PLAIN_SIGHT_APP=<the copy>). The facts read here also say where the
// bundle's web data lives: in its container when it is sandboxed.
const BUNDLE = launchable('release', APP);
// The app menu is titled by the bundle's name, "Plain Sight test copy" on a
// test copy; its items keep the app's own words (DM-241).
const APP_MENU = appMenuTitle(BUNDLE);
const EXE = path.join(APP, 'Contents/MacOS/plain-sight');
const WEB_DATA = webDataFolder(HOME, BUNDLE);
let app = null;
let watch = null;
const launched = [];

// Every running copy of the release app.
function instances() {
  try { return execFileSync('pgrep', ['-f', EXE], { encoding: 'utf8' }).trim().split('\n').map(Number).filter((p) => Number.isInteger(p) && p > 0); } catch { return []; }
}
const documentWindows = () => drive('cgwindows', app.pid).windows.filter((w) => w.layer === 0 && w.onscreen);

// Opened the way a double-click opens it: through LaunchServices. A copy that
// a failed test left running is ended first, so it is never taken for the new
// one; a copy this run did not open is never touched. Never once the run is
// ending (the check comes right before the open, with no wait between, since
// the run may begin to end while an earlier copy ends); and a launch under
// way when it began is marked (launching) until its copy is recorded, so that
// after() ends that copy too (DM-249).
let launching = false;
async function open() {
  for (const pid of instances()) {
    assert.ok(launched.includes(pid), 'a copy of the release app that this run did not open is running: ' + pid);
    note('ending the copy an earlier test left running: ' + pid);
    drive('quit-app', pid);
    await until(() => !alive(pid), 'the earlier copy to end', 8000);
  }
  refuseLaunchWhileEnding('the release app');
  launching = true;
  let pid = 0;
  try {
    execFileSync('open', ['-n', APP]);
    pid = await until(() => instances().find((p) => !launched.includes(p)) || 0, 'the app process', 15000);
    launched.push(pid);
    recordLaunch(pid, APP);
  } finally {
    launching = false;
  }
  app = { pid };
  note('opened pid ' + pid);
  await firstWindow(pid, (windows) => windows.filter((w) => w.layer === 0 && w.onscreen).length === 1, 'the document window', 15000);
  await sleep(1500);
}
// Each way out runs the page's Esc first and ends when the adapter says the
// page is done (quit_ready), which is never sooner than 0.7 s: the adapter
// waits that long for WebKit to commit the page's last write (adapter.js). The
// app's own safety timer ends it after 4 s. So an end between 0.6 s and 2.5 s
// shows the way out went through the page and the page answered; an end at
// once would mean the page's Esc was skipped.
async function ended(how) {
  const t0 = Date.now();
  await until(() => !alive(app.pid), 'the app to end after ' + how, 8000);
  const ms = Date.now() - t0;
  note(how + ': ended after ' + ms + ' ms');
  app = null;
  assert.ok(ms >= 600, how + ' ended after ' + ms + ' ms, sooner than the page\'s quit allows');
  assert.ok(ms < 2500, how + ' ended after ' + ms + ' ms, too late for the page\'s answer');
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the sealed release app opens through LaunchServices as a double-click does: one window, and its web data in its own folder', async () => {
  assert.equal(existsSync(WEB_DATA), false, 'no web data before the first launch (moved aside by the harness)');
  await open();
  assert.equal(documentWindows().length, 1);
  await sleep(6000);
  assert.ok(alive(app.pid), 'still running after several seconds');
  assert.ok(existsSync(WEB_DATA), 'WebKit keeps the page data in ' + WEB_DATA + (BUNDLE.sandboxed ? ' (inside the container)' : ''));
});

test('its menu bar is the app\'s own and holds only standard items', async () => {
  const menus = drive('menus', app.pid).menus.filter((m) => m.title !== 'Apple');
  note('menu bar: ' + JSON.stringify(menus));
  assert.deepEqual(menus.map((m) => m.title), menuBarOf(BUNDLE));
  const items = Object.fromEntries(menus.map((m) => [m.title, m.items.map((i) => i.title).filter(Boolean)]));
  for (const want of ['About Plain Sight', 'Services', 'Hide Plain Sight', 'Hide Others', 'Show All', 'Quit Plain Sight']) assert.ok(items[APP_MENU].includes(want), want);
  assert.equal(/peek|vault|hidden|reload|inspect|debug|developer|devtools/i.test(Object.values(items).flat().join(' | ')), false);
});

test('the app\'s own Quit item ends it', async () => {
  drive('menu', app.pid, APP_MENU, 'Quit Plain Sight');
  await ended('the Quit item');
});

test('a quit request as the Dock sends it ends it', async () => {
  await open();
  drive('quit-app', app.pid);
  await ended('the Dock-style quit request');
});

// The document window as Accessibility shows it, or null while the screen is
// locked (macOS then shows no windows).
function documentWindow() {
  const windows = drive('windows', app.pid).windows;
  note('windows through Accessibility: ' + JSON.stringify(windows.map((w) => ({ subrole: w.subrole, title: w.title, main: w.main, focused: w.focused }))));
  return windows.find((w) => w.subrole === 'AXStandardWindow') || null;
}
async function endAndSkip(reason) {
  drive('menu', app.pid, APP_MENU, 'Quit Plain Sight');
  await ended('the Quit item');
  throw new NotRun(reason);
}

test('the window\'s close button ends it', async () => {
  await open();
  if (!documentWindow()) await endAndSkip('macOS shows Accessibility no windows while the screen is locked');
  drive('close-button', app.pid);
  await ended('the close button');
});

test('Close Window in the File menu ends it', async () => {
  await open();
  const w = documentWindow();
  if (!w) await endAndSkip('macOS shows Accessibility no windows while the screen is locked');
  if (!w.main) await endAndSkip('the window is not the key window, so the item has nothing to close');
  drive('menu', app.pid, 'File', 'Close Window');
  await ended('Close Window');
});

test('no network use was seen from the app or its web view during these launches', async () => {
  watch.child.kill('SIGTERM');
  await until(() => existsSync(watch.report), 'the network watch report', 15000);
  const report = JSON.parse(readFileSync(watch.report, 'utf8'));
  note('netwatch: ' + JSON.stringify({ appPids: report.appPids, networkPids: report.networkPids, samples: report.samples, sockets: report.sockets.length, nettop: report.nettopLinesForOurPids.length, verdict: report.verdict }));
  for (const pid of launched) assert.ok(report.appPids.includes(pid), 'the watch saw launch ' + pid);
  // Each launch has its own WebKit networking process; one per launch must be watched (DM-219).
  assert.ok(report.networkPids.length >= launched.length, 'a networking process watched for each of the ' + launched.length + ' launches: ' + report.networkPids.length);
  assert.equal(report.verdict, 'no network use seen');
});

await run(tests, {
  name: 'release',
  needUnlocked: true,
  before: () => {
    // The watch is handed the bundle, so it finds the networking process by
    // that bundle's web data: its container when it is sandboxed (DM-242).
    const report = path.join(EVIDENCE, 'netwatch.json');
    const child = spawn(process.execPath, [path.join(DESKTOP, 'tests', 'netwatch.mjs'), '600', report, APP], { stdio: 'ignore' });
    watch = { child, report };
  },
  after: async () => {
    // No copy this run opened outlives it, however a test ended; a copy someone
    // else opened is never touched. A launch under way when the run began to
    // end records its copy first, so that copy is ended too (DM-249).
    await until(() => !launching, 'a launch under way to record its copy', 16000).catch(() => {});
    const ours = () => instances().filter((p) => launched.includes(p));
    for (const pid of ours()) { try { drive('quit-app', pid); } catch (err) { note('quit-app ' + pid + ': ' + err.message); } }
    await until(() => !ours().length, 'every copy this run opened to end', 5000).catch(() => ours().forEach((p) => process.kill(p, 'SIGKILL')));
    if (watch && watch.child.exitCode === null) watch.child.kill('SIGTERM');
  }
});
