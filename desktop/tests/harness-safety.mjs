// The test harness's own safety (harness.mjs), checked on every `npm test`
// against a fake home inside a temporary folder of this test's own, never the
// real one (QA-G-30): before any backup a restore or a clear changes nothing;
// a restore asked for while the backup is incomplete is refused and names
// what to put back; a second restore after a complete one changes nothing;
// and the signal handlers are installed before the app's data is moved
// aside, so a Ctrl+C or a kill during the move is taken after it and
// everything is put back (QA-G-24). The cases named run-* run the harness's
// run() itself, with tests of their own that launch nothing: a test copy's
// container that macOS will not let the run remove is test data left
// behind, exit code 8, while the same refusal on a folder of the person's own
// still ends with 6; a run on a copy whose container is still there, and a
// move aside that macOS refuses, do not start (DM-243). Every case runs in a
// child process whose HOME, TMPDIR and evidence folder lie inside that
// temporary folder, which is removed at the end. The driver never runs: a
// stand-in in the child answers run()'s questions to it (Accessibility, the
// screen's lock and idle time, the app's windows) and to pgrep (whether the
// app is open) from the case's own state, so no app is launched and nothing
// on the Mac is touched.
//
// Run from the repository root: node desktop/tests/harness-safety.mjs

import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'harness.mjs');
// The child's own folder, which its HOME and TMPDIR must lie inside.
const BOX = 'PLAIN_SIGHT_HARNESS_TEST_BOX';
// The parent writes this file in the box once it has sent the signal.
const SIGNAL_SENT = 'signal-sent';
// The harness compiles its driver at import unless the file for this source
// version exists. No case here runs the driver, so an empty file stands in
// for it, in the child's own temporary folder.
const DRIVER = 'plain-sight-drive-' + createHash('sha256').update(readFileSync(path.join(HERE, 'drive.swift'))).digest('hex').slice(0, 12);
const BACKUP_ROOT = (home) => path.join(home, 'cover-story-delivery', 'desktop', 'appdata-backup');
const LOCK = (home) => path.join(home, 'cover-story-delivery', 'desktop', '.gui-test.lock');
const CONTAINERS = (home) => path.join(home, 'Library', 'Containers');
const marker = (dir) => path.join(dir, 'marker');
const real = (home, dir) => 'REAL ' + path.relative(home, dir);
// A test copy's identifier, as testcopy.mjs makes one, and its data folders,
// which the run makes, never the person.
const TEST_COPY = 'com.pranavongole.plainsight.testcopy-1761000003';
const isTestFolder = (dir) => /^com\.pranavongole\.plainsight\.(testcopy|sbprobe)-/.test(path.basename(dir));

// ---------------------------------------------------------------------------
// The child: one case against the harness, under the fake home.
// ---------------------------------------------------------------------------
if (process.argv[2] === '--child') {
  const which = process.argv[3];
  const box = process.env[BOX];
  const home = os.homedir();
  const inside = (p) => Boolean(box) && p.startsWith(box + path.sep);
  if (!inside(home) || home === os.userInfo().homedir || !inside(os.tmpdir())) {
    console.log('refusing: HOME ' + home + ' or TMPDIR ' + os.tmpdir() + ' is not inside the test folder ' + box);
    process.exit(2);
  }
  writeFileSync(path.join(os.tmpdir(), DRIVER), '');
  // A hook around every move and every removal of a data folder, bound
  // before the harness loads its own imports of renameSync and rmSync.
  let onRename = null;
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (onRename) onRename(from, to); return rename(from, to); };
  let onRemove = null;
  const remove = fs.rmSync;
  fs.rmSync = (target, options) => { if (onRemove) onRemove(target); return remove(target, options); };
  // The stand-in for the driver and for pgrep: run() asks the driver whether
  // this program may use Accessibility, whether the screen is locked and how
  // long the Mac has been idle, and for the app's windows, and pgrep whether
  // the app is open. It answers from `fake`, the case's state; every other
  // program runs as it is (plutil reads a fake bundle's Info.plist).
  const fake = { locked: false, idle: 600, windows: [] };
  const started = Date.now();
  const exec = childProcess.execFileSync;
  childProcess.execFileSync = (file, args = [], options) => {
    if (path.basename(String(file)) === DRIVER) {
      const command = String(args[0]);
      const answer = command === 'trusted' ? { ok: true, accessibility: true }
        : command === 'session' ? { ok: true, locked: fake.locked, idle: fake.idle + (Date.now() - started) / 1000 }
          : command === 'cgwindows' ? { ok: true, windows: fake.windows }
            : { ok: false, error: 'the stand-in has no answer for ' + command };
      return JSON.stringify(answer) + '\n';
    }
    if (file === 'pgrep') throw Object.assign(new Error('pgrep found no process'), { status: 1, stdout: '' });
    return exec(file, args, options);
  };
  syncBuiltinESMExports();
  const h = await import(pathToFileURL(HARNESS).href);
  // The person's own data folders hold their data before the run; a test
  // copy's folders do not exist yet: its launch makes them. Two cases leave
  // one place of the real identifier's empty, so that the run itself makes
  // it there (QA-01's H8c and H8d).
  const realContainer = path.join(home, 'Library', 'Containers', h.ID);
  const realCookies = path.join(home, 'Library', 'HTTPStorages', h.ID + '.binarycookies');
  const unseeded = { 'run-real-container-made': realContainer, 'run-real-cookies-made': realCookies }[which];
  const dirs = h.DATA_DIRS.filter((d) => !isTestFolder(d) && d !== unseeded);
  console.log('DIRS ' + JSON.stringify(dirs.map((d) => path.relative(home, d))));
  for (const d of dirs) { mkdirSync(d, { recursive: true }); writeFileSync(marker(d), real(home, d)); }
  const intact = () => dirs.forEach((d) => assert.equal(existsSync(marker(d)) ? readFileSync(marker(d), 'utf8') : null, real(home, d), 'the data in ' + d + ' is as it was'));
  const backups = () => (existsSync(BACKUP_ROOT(home)) ? readdirSync(BACKUP_ROOT(home)) : []);
  const cleanup = async () => { h.restoreAppData(); };
  const cases = {
    'restore-before-backup'() {
      h.restoreAppData();
      intact();
      assert.deepEqual(backups(), [], 'no backup folder');
    },
    'clear-before-backup'() {
      assert.throws(() => h.clearTestData(), /not moved aside/, 'refused');
      intact();
    },
    'restore-while-moving'() {
      let moves = 0;
      let refusal = null;
      onRename = () => {
        moves += 1;
        if (moves !== 2) return;
        try { h.restoreAppData(); refusal = 'returned'; } catch (err) { refusal = err.message; }
      };
      h.backupAppData();
      onRename = null;
      assert.notEqual(refusal, null, 'the second move was reached');
      assert.match(refusal, /incomplete/, 'refused while the backup is incomplete: ' + refusal);
      assert.ok(refusal.includes('put back ' + dirs[0] + ' from ' + BACKUP_ROOT(home)) && refusal.includes('(listed in moved.json)'), 'the refusal names the folder moved so far, decoded, and where it waits: ' + refusal);
      assert.ok(!refusal.includes(dirs[1]), 'and not one not yet moved: ' + refusal);
      dirs.forEach((d) => assert.ok(!existsSync(d), 'the backup went on to the end: ' + d));
      h.restoreAppData();
      intact();
      assert.deepEqual(backups(), [], 'nothing left in the backup');
    },
    'restore-twice'() {
      h.backupAppData();
      dirs.forEach((d) => { mkdirSync(d, { recursive: true }); writeFileSync(marker(d), 'TEST DATA'); });
      h.restoreAppData();
      intact();
      h.restoreAppData();
      intact();
      assert.deepEqual(backups(), [], 'no backup folder');
    },
    async 'handlers-before-backup'() {
      let seen = null;
      onRename = () => { if (!seen) seen = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s)); };
      h.watchSignalsThenBackup(cleanup);
      onRename = null;
      assert.notEqual(seen, null, 'a folder was moved');
      console.log('HANDLERS DURING THE FIRST MOVE ' + JSON.stringify(seen));
      assert.ok(seen.every((n) => n >= 1), 'each handler was installed before the first move: ' + JSON.stringify(seen));
      dirs.forEach((d) => assert.ok(!existsSync(d), 'moved aside: ' + d));
      // The handler's own path, run the way Node runs it between turns of
      // the event loop: the cleanup puts everything back and the run ends
      // with 130.
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 5000));
      console.log('THE HANDLER DID NOT END THE RUN');
      process.exit(9);
    },
    async 'signal-during-backup'() {
      // The parent sends SIGINT while the second folder is being moved: the
      // hook holds that move until the parent says the signal is on its way,
      // so the signal lands inside the backup, which Node can only queue.
      let moves = 0;
      onRename = () => {
        moves += 1;
        if (moves !== 2) return;
        console.log('MOVING 2');
        const sent = path.join(box, SIGNAL_SENT);
        const until = Date.now() + 15000;
        while (!existsSync(sent)) {
          if (Date.now() > until) { console.log('THE SIGNAL NEVER CAME'); process.exit(7); }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      };
      h.watchSignalsThenBackup(cleanup);
      onRename = null;
      console.log('BACKUP DONE');
      await new Promise((r) => setTimeout(r, 5000));
      console.log('THE HANDLER DID NOT END THE RUN');
      process.exit(9);
    },
    // DM-243: the run's own end. A test copy's launch makes its container
    // (here a folder in the fake home), macOS App Data protection refuses its
    // removal (here the hook, as EPERM), and run() ends the process itself.
    async 'run-test-container-refused'() {
      onRemove = (target) => { if (target === container) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer]);
    },
    // QA-01's harness cases on 534f3cc (wave-g/qa/scripts/app/r7_harness_adv.mjs
    // with r7_harness_child.mjs, H4 to H28), on this file's stand-in: QA-01
    // made macOS's refusals real (chflags uchg for EPERM, an ACL "deny delete"
    // for EACCES); here the hook answers with the same error codes. H4: the
    // container refused with EACCES.
    async 'run-test-container-eacces'() {
      onRemove = (target) => { if (target === container) throw refused('rmdir', target, 'EACCES'); };
      await runSuite([launchMakesContainer]);
    },
    // DM-247: a real-key test that needs a first launch of a sandboxed bundle
    // asks freshStart, which asks the copy script's makeTestCopy (a stand-in
    // here, recording what it was asked) for a fresh copy and clears nothing:
    // the bundle's own container keeps what its launch wrote. The fresh
    // copy's first launch makes its own container; at the run's end both
    // containers, which macOS keeps, are named as test data left behind.
    async 'run-fresh-start'() {
      const fresh = path.join(CONTAINERS(home), 'com.pranavongole.plainsight.testcopy-1761000020000');
      onRemove = (target) => { if (target === container || target === fresh) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer, {
        name: 'a test that needs a first launch gets a fresh copy, and nothing is cleared',
        fn: async () => {
          const removed = [];
          const atTheEnd = onRemove;
          onRemove = (target) => { removed.push(target); atTheEnd(target); };
          const asked = [];
          const made = h.freshStart({ app: process.env.PLAIN_SIGHT_APP, identifier: h.APP_ID, sandboxed: true }, {
            now: () => 1761000020000,
            makeCopy: (source, destination, stamp) => { asked.push({ source, destination, stamp }); return { made: { app: path.join(destination, 'Plain Sight test copy.app'), identifier: 'com.pranavongole.plainsight.testcopy-' + stamp, sandboxed: true } }; }
          });
          onRemove = atTheEnd;
          console.log('FRESH ' + JSON.stringify({ asked, made, removed }));
          assert.deepEqual(removed, [], 'nothing was removed for the first launch');
          assert.equal(readFileSync(marker(path.join(container, 'Data', 'Library', 'WebKit', 'WebsiteData')), 'utf8'), 'TEST DATA', 'the bundle\'s own container keeps what its launch wrote');
          testData(path.join(fresh, 'Data'));   // the fresh copy's first launch makes its container
        }
      }]);
    },
    // A fresh copy never takes an identifier whose folders exist already: the
    // next stamp is taken, and the folder that was there is left alone.
    async 'run-fresh-start-taken'() {
      const taken = path.join(CONTAINERS(home), 'com.pranavongole.plainsight.testcopy-1761000030000');
      mkdirSync(taken, { recursive: true });
      writeFileSync(marker(taken), 'ANOTHER RUN\'S CONTAINER');
      await runSuite([{
        name: 'a fresh copy skips an identifier that is taken',
        fn: async () => {
          const made = h.freshStart({ app: process.env.PLAIN_SIGHT_APP, identifier: h.APP_ID, sandboxed: true }, {
            now: () => 1761000030000,
            makeCopy: (source, destination, stamp) => ({ made: { app: path.join(destination, 'Plain Sight test copy.app'), identifier: 'com.pranavongole.plainsight.testcopy-' + stamp, sandboxed: true } })
          });
          console.log('FRESH ' + JSON.stringify({ made }));
        }
      }]);
    },
    // An unsandboxed bundle still gets its folders cleared, and no copy.
    async 'run-fresh-start-unsandboxed'() {
      await runSuite([{
        name: 'a test that needs a first launch of an unsandboxed bundle gets its folders cleared',
        fn: async () => {
          testData(dirs[0]);
          const facts = { app: '/nowhere/Plain Sight.app', identifier: h.ID, sandboxed: false };
          const made = h.freshStart(facts, { makeCopy: () => { throw new Error('no copy is made for an unsandboxed bundle'); } });
          assert.equal(made, facts, 'the next launch opens the same bundle');
          assert.equal(existsSync(marker(dirs[0])), false, 'its folders were cleared');
        }
      }]);
    },
    // DM-248: a signal while the run's own cleanup is under way, as the
    // suites' after() waits for the app to quit. The Delivery Manager's AT-H6
    // (one SIGINT then) and AT-H7 (a first SIGINT during a test, a second
    // while after() waits), dm-appstore-534f3cc/adv/tests534/desktop/tests/
    // dm-harness-adv-534.mjs, and a SIGTERM during a test, then a SIGHUP
    // during the cleanup, with a test after them that must not start.
    async 'run-signal-during-cleanup'() {
      await runSuite([{ name: 'a test that writes test data', fn: async () => { testData(dirs[0]); } }], { after: slowAfter });
    },
    async 'run-second-signal'() {
      await runSuite([{ name: 'a long test', fn: async () => { testData(dirs[0]); console.log('IN TEST'); await new Promise((r) => setTimeout(r, 6000)); } }], { after: slowAfter });
    },
    async 'run-term-then-hup'() {
      await runSuite([
        { name: 'a short test', fn: async () => { testData(dirs[0]); console.log('IN TEST'); await new Promise((r) => setTimeout(r, 1000)); } },
        { name: 'a test after the signal', fn: async () => { console.log('TEST AFTER THE SIGNAL'); } }
      ], { after: slowAfter });
    },
    // H5: a sandbox probe's container (the bundle under test carries an
    // sbprobe- identifier), refused like a test copy's.
    async 'run-probe-container-refused'() {
      onRemove = (target) => { if (target === container) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer]);
    },
    // H6: a failed test and a leftover.
    async 'run-leftover-and-failure'() {
      onRemove = (target) => { if (target === container) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer, { name: 'a test that fails', fn: async () => { throw new Error('an assertion failed'); } }]);
    },
    // The Delivery Manager's AT-H3 (dm-appstore-534f3cc/adv, QA-01's H7): a
    // stop and a leftover.
    async 'run-leftover-and-stop'() {
      onRemove = (target) => { if (target === container) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer, { name: 'a test the person interrupts', fn: async () => { throw new h.UserActivity('keyboard or mouse used during the run (idle 0.0 s)'); } }, laterTest]);
    },
    // H8b: a test copy's folder that was there before the run, which the run
    // moved aside, is made again and refused on the way back.
    async 'run-copy-caches-kept'() {
      const caches = path.join(home, 'Library', 'Caches', h.APP_ID);
      mkdirSync(caches, { recursive: true });
      writeFileSync(marker(caches), 'OLD TEST DATA OF AN EARLIER RUN');
      onRemove = (target) => { if (target === caches) throw refused('rmdir', target); };
      await runSuite([{ name: 'the test copy\'s Caches folder is made again and macOS refuses its removal', fn: async () => { testData(caches); } }]);
    },
    // H8c: the real identifier's container, not there before the run, made by
    // the run (the D-39 trap) and refused on removal.
    async 'run-real-container-made'() {
      onRemove = (target) => { if (target === realContainer) throw refused('rmdir', target); };
      await runSuite([{ name: 'a run makes the real identifier\'s container and macOS refuses its removal', fn: async () => { testData(path.join(realContainer, 'Data')); } }]);
    },
    // H8d: the real identifier's cookie file, likewise: a name that starts
    // with the real identifier and a dot is not a test identifier's.
    async 'run-real-cookies-made'() {
      onRemove = (target) => { if (target === realCookies) throw refused('unlink', target); };
      await runSuite([{ name: 'a run makes the real identifier\'s cookie file and macOS refuses its removal', fn: async () => { mkdirSync(path.dirname(realCookies), { recursive: true }); writeFileSync(realCookies, 'CREATED BY THE RUN'); } }]);
    },
    // H13b: a locked screen at the start, in a suite that does not need it
    // unlocked.
    async 'run-locked-not-needed'() {
      fake.locked = true;
      await runSuite([{ name: 'a test that may run on a locked screen', fn: async () => { testData(dirs[0]); } }], { needUnlocked: false });
    },
    // H22, and the Delivery Manager's AT-H1: the screen locks during a run
    // that needs it unlocked.
    async 'run-locks-midway'() {
      await runSuite([{ name: 'a test during which the screen locks', fn: async () => { testData(dirs[0]); fake.locked = true; h.drive('cgwindows', 4242); } }, laterTest]);
    },
    // H26: a window on-screen the whole wait, but never the one the wait wants.
    async 'run-onscreen-unmatched'() {
      fake.windows = [HELPER, DOC_ON];
      await runSuite([{ name: 'a launch waits for two windows on screen', fn: async () => { testData(dirs[0]); await h.firstWindow(4242, (list) => list.filter((w) => w.onscreen).length >= 2 && list, 'two windows', 700); } }]);
    },
    // The Delivery Manager's AT-H2 (DISH-G-70 R1): on-screen, then lost
    // before the wait is met.
    async 'run-onscreen-then-lost'() {
      fake.windows = [HELPER, { ...DOC_ON, x: 230, y: 60 }, { ...DOC_ON, x: 260, y: 90 }];
      setTimeout(() => { fake.windows = [HELPER, { ...DOC_ON, onscreen: false, x: 230, y: 60 }]; }, 250);
      await runSuite([firstLaunch]);
    },
    // H28 (DISH-G-70 R2): a window of the document's size on another layer,
    // off-screen, is not the document window.
    async 'run-big-window-other-layer'() {
      fake.windows = [HELPER, { height: 747, layer: 25, onscreen: false, width: 980, x: 230, y: 60 }];
      await runSuite([firstLaunch]);
    },
    async 'run-own-folder-refused'() {
      onRemove = (target) => { if (target === dirs[0]) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer]);
    },
    async 'run-container-from-before'() {
      mkdirSync(container, { recursive: true });
      writeFileSync(marker(container), 'TEST DATA OF AN EARLIER RUN');
      await runSuite([{ name: 'a test that must not run', fn: async () => { throw new Error('the run started over an earlier run\'s container'); } }]);
    },
    async 'run-backup-refused'() {
      let moves = 0;
      onRename = (from) => { moves += 1; if (moves === 2) throw refused('rename', from); };
      await runSuite([{ name: 'a test that must not run', fn: async () => { throw new Error('the run started without its backup'); } }]);
    },
    // The lock screen (DISH-G-50): the suites that launch the app need an
    // unlocked Mac left alone with the display on.
    async 'run-locked'() {
      fake.locked = true;
      await runSuite([{ name: 'a test that must not run', fn: async () => { throw new Error('the run started on a locked screen'); } }]);
    },
    // A launch's window listed only off-screen for the whole first wait, as
    // on 26 October with the screen locked (e2e-run-1's listings: AppKit's
    // 500 by 500 helper and the 980 by 747 document window, both off-screen).
    async 'run-offscreen'() {
      fake.windows = [HELPER, { height: 747, layer: 0, onscreen: false, width: 980, x: 230, y: 60 }];
      await runSuite([firstLaunch, { name: 'a later test', fn: async () => { throw new Error('a test ran after the stop'); } }]);
    },
    // No document window at all, only AppKit's off-screen helpers: the app's
    // failure, never taken for a locked screen.
    async 'run-no-window'() {
      fake.windows = [HELPER, { height: 0, layer: 0, onscreen: false, width: 0, x: 0, y: 0 }];
      await runSuite([firstLaunch]);
    },
    async 'run-onscreen'() {
      fake.windows = [HELPER, DOC_ON];
      await runSuite([firstLaunch]);
    }
  };
  const HELPER = { height: 500, layer: 0, onscreen: false, width: 500, x: 0, y: 940 };
  const DOC_ON = { height: 744, layer: 0, onscreen: true, width: 980, x: 790, y: 324 };
  // A launch of the test copy: its container, and test data in the app's folders.
  const launchMakesContainer = { name: 'a launch of the test copy makes its container and writes into the app\'s folders', fn: async () => { testData(path.join(container, 'Data', 'Library', 'WebKit', 'WebsiteData')); testData(dirs[0]); } };
  const laterTest = { name: 'a later test', fn: async () => { throw new Error('a test ran after the stop'); } };
  // A launch's first wait, as e2e.mjs waits for its window, after writing
  // test data where the app would.
  const firstLaunch = {
    name: 'a launch waits for its first window',
    fn: async () => {
      testData(dirs[0]);
      const windows = await h.firstWindow(4242, (list) => list.filter((w) => w.layer === 0 && w.onscreen).length === 1 && list, 'the app window', 700);
      console.log('FIRST WINDOW ' + JSON.stringify(windows.filter((w) => w.onscreen)));
    }
  };
  // For the run-* cases: the test copy's container, test data written where
  // a launch would write it, macOS's refusal, and the suite's own call of run().
  const container = h.APP_ID === h.ID ? null : path.join(CONTAINERS(home), h.APP_ID);
  const testData = (dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(marker(dir), 'TEST DATA'); };
  const refused = (call, target, code = 'EPERM') => Object.assign(new Error(code + ': ' + (code === 'EACCES' ? 'permission denied' : 'operation not permitted') + ', ' + call + ' \'' + target + '\''), { code });
  const runSuite = (tests, { needUnlocked = true, after = null } = {}) => {
    mkdirSync(path.join(home, 'Downloads'), { recursive: true });
    return h.run(tests, { name: 'release', needUnlocked, ...(after ? { after } : {}) });
  };
  // An after() that takes a while, as the suites' do while the app quits.
  const slowAfter = async () => { console.log('IN AFTER'); await new Promise((r) => setTimeout(r, 3000)); console.log('AFTER DONE'); };
  try {
    await cases[which]();
    console.log('RESULT ok');
    process.exit(0);
  } catch (err) {
    console.log('RESULT fail: ' + String(err && err.message ? err.message : err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// The parent: a box per case, inside one temporary folder removed at the end.
// ---------------------------------------------------------------------------
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'plain-sight-harness-safety-'));

// A fake bundle under a test identifier, outside the fake home, for the
// harness to read as PLAIN_SIGHT_APP (only its Info.plist is read).
function fakeCopy(box, identifier) {
  const app = path.join(box, 'bundle', 'Plain Sight test copy.app');
  mkdirSync(path.join(app, 'Contents'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>' + identifier + '</string><key>CFBundleName</key><string>Plain Sight test copy</string></dict></plist>\n');
  return app;
}

function runCase(id, onOutput = () => {}, { app = null } = {}) {
  const box = path.join(ROOT, id);
  const home = path.join(box, 'home');
  const tmp = path.join(box, 'tmp');
  const evidence = path.join(box, 'evidence');
  for (const d of [home, tmp, evidence]) mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, TMPDIR: tmp, PLAIN_SIGHT_EVIDENCE: evidence, [BOX]: box };
  // Nothing of the shell that runs npm test reaches the harness's settings.
  for (const name of ['PLAIN_SIGHT_E2E_DOWNLOADS', 'PLAIN_SIGHT_APP', 'PLAIN_SIGHT_IDLE_MIN', 'PLAIN_SIGHT_ONLY', 'PLAIN_SIGHT_ALLOW_REAL_ID']) delete env[name];
  if (app) env.PLAIN_SIGHT_APP = fakeCopy(box, app);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', id], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const feed = (chunk) => { out += chunk; onOutput(out, child, box); };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  return new Promise((resolve) => child.on('exit', (code, signal) => {
    const line = out.split('\n').find((l) => l.startsWith('DIRS '));
    const dirs = line ? JSON.parse(line.slice(5)).map((rel) => path.join(home, rel)) : [];
    resolve({
      code, signal, out, dirs, home,
      intact: dirs.length > 0 && dirs.every((d) => existsSync(marker(d)) && readFileSync(marker(d), 'utf8') === real(home, d)),
      backups: existsSync(BACKUP_ROOT(home)) ? readdirSync(BACKUP_ROOT(home)) : [],
      tmpFiles: readdirSync(tmp),
      lock: existsSync(LOCK(home)),
      containers: existsSync(CONTAINERS(home)) ? readdirSync(CONTAINERS(home)) : []
    });
  }));
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ended = (r, code) => {
  assert.equal(r.signal, null, 'the child ended by itself, not by a signal; its output:\n' + r.out);
  assert.equal(r.code, code, 'the child ended with ' + code + '; its output:\n' + r.out);
};
const clean = (r) => {
  assert.ok(r.intact, 'every data folder holds what was there before the run; the child\'s output:\n' + r.out);
  assert.deepEqual(r.backups, [], 'no backup folder is left');
  assert.deepEqual(r.tmpFiles, [DRIVER], 'the harness compiled nothing and wrote nothing else into the temporary folder');
};

test('a restore before any backup changes nothing (QA-01 X1)', async () => {
  const r = await runCase('restore-before-backup');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/);
  clean(r);
});
test('a clear of the test data before any backup is refused and changes nothing (QA-01 X3)', async () => {
  const r = await runCase('clear-before-backup');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/);
  clean(r);
});
test('a restore asked for while the backup is incomplete is refused and names what to put back, decoded, and from where (QA-01 X2)', async () => {
  const r = await runCase('restore-while-moving');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/);
  clean(r);
});
test('a second restore after a complete one changes nothing (QA-01 C10)', async () => {
  const r = await runCase('restore-twice');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/);
  clean(r);
});
test('the signal handlers are installed before the app\'s data is moved aside, and the handler puts everything back and ends the run with 130 (QA-01 H5)', async () => {
  const r = await runCase('handlers-before-backup');
  ended(r, 130);
  assert.match(r.out, /HANDLERS DURING THE FIRST MOVE \[/, 'the counts were read during the first move');
  assert.doesNotMatch(r.out, /RESULT fail/, r.out);
  clean(r);
});
test('a signal during the move is taken after it: the backup finishes, everything is put back, and the run ends with 130 (QA-G-24)', async () => {
  let sent = false;
  const r = await runCase('signal-during-backup', (out, child, box) => {
    if (sent || !out.includes('MOVING 2')) return;
    sent = true;
    child.kill('SIGINT');
    writeFileSync(path.join(box, SIGNAL_SENT), '');
  });
  assert.ok(sent, 'the signal was sent while the second folder was being moved; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /BACKUP DONE/, 'the backup finished before the signal was taken; the child\'s output:\n' + r.out);
  clean(r);
});

// DM-243: release-run-1 (26 October 2026) ended with exit 6 and "could not
// clear the test data in .../Containers/com.pranavongole.plainsight.testcopy-
// 1793065378 (EPERM)", though every folder of the person's came back.
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
test('a test copy\'s container that macOS will not let the run remove is test data left behind: named, listed at the end by name, exit code 8, and the person\'s data is back (DM-243)', async () => {
  const r = await runCase('run-test-container-refused', undefined, { app: TEST_COPY });
  ended(r, 8);
  const container = path.join(CONTAINERS(r.home), TEST_COPY);
  assert.ok(r.out.includes('test data left behind: ' + container + ' (macOS refused to remove it; remove it by hand, see wave-g/probe/DESIGN.md, Leftovers)'), 'the leftover is named, with what to do; the child\'s output:\n' + r.out);
  assert.match(r.out, new RegExp('^Test containers on this Mac at the end of the run \\(names only, never opened\\): ' + esc(TEST_COPY) + '$', 'm'), 'the summary lists it by name');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m, 'a leftover is not counted as an error');
  assert.match(r.out, /^Exit code: 8 \(test data left behind; your own data is back\)$/m);
  assert.doesNotMatch(r.out, /Could not restore app data/, 'the person\'s data came back');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
  assert.ok(r.containers.includes(TEST_COPY), 'the container is left where it is: ' + JSON.stringify(r.containers));
});
test('the same refusal on a folder of the person\'s own app still ends the run with 6 and keeps that folder\'s data in the backup, named (DM-243)', async () => {
  const r = await runCase('run-own-folder-refused', undefined, { app: TEST_COPY });
  ended(r, 6);
  assert.ok(r.out.includes('Could not restore app data: could not clear the test data in ' + r.dirs[0] + ' (EPERM)'), 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /test data left behind/, 'a folder of the person\'s is never taken for test data');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m);
  assert.equal(r.backups.length, 1, 'what was in that folder before the run waits in the backup');
  for (const d of r.dirs.slice(1)) assert.equal(readFileSync(marker(d), 'utf8'), real(r.home, d), 'the other folders came back: ' + d);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a run on a test copy whose container is still there from an earlier run does not start: nothing is moved, and the refusal names the container and app:testcopy (DM-243)', async () => {
  const r = await runCase('run-container-from-before', undefined, { app: TEST_COPY });
  ended(r, 4);
  assert.match(r.out, new RegExp('^release: not started: the bundle under test, ' + esc(TEST_COPY) + ', has a container from an earlier run, .*npm run app:testcopy.*\\. Errors: 0$', 'm'), 'the child\'s output:\n' + r.out);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
  assert.equal(readFileSync(marker(path.join(CONTAINERS(r.home), TEST_COPY)), 'utf8'), 'TEST DATA OF AN EARLIER RUN', 'the container is left as it was');
});
test('a move aside that macOS refuses ends the run as not started, with every folder in its place and the lock released (DM-243)', async () => {
  const r = await runCase('run-backup-refused');
  ended(r, 4);
  assert.match(r.out, /^release: not started: could not move .+ aside \(EPERM\); everything was put back\. Errors: 0$/m, 'the child\'s output:\n' + r.out);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// The lock screen (DISH-G-50): e2e-run-1 and release-run-1 (26 October 2026)
// started with the screen locked, every window of the app was listed with
// onscreen false (888 listings and 211, none on-screen), and each wait for a
// window was counted as a failure.
test('a suite that needs an unlocked Mac does not start on a locked screen: exit code 4, the reason given, nothing moved (DISH-G-50)', async () => {
  const r = await runCase('run-locked');
  ended(r, 4);
  assert.match(r.out, /^release: not started: the screen is locked: these suites need an unlocked Mac left alone, display on\. Errors: 0$/m, 'the child\'s output:\n' + r.out);
  clean(r);
  assert.equal(r.lock, false, 'no lock was taken');
});
test('a launch whose window is listed only off-screen for the whole first wait stops the run as not run: exit code 3, nothing counted as failed, the data back (DISH-G-50)', async () => {
  const r = await runCase('run-offscreen');
  ended(r, 3);
  assert.match(r.out, /^stop - a launch waits for its first window \(every window is off-screen \(the screen locked or the display asleep during the run\)\)$/m, 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^skip - a later test \(not run: every window is off-screen /m, 'the tests after it are not run');
  assert.match(r.out, /^0 passed, 0 failed, 2 not run, 2 total\. Errors: 0$/m);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a launch with no document window at all, only AppKit\'s off-screen helpers, is still the app\'s failure, not a locked screen (DISH-G-50)', async () => {
  const r = await runCase('run-no-window');
  ended(r, 1);
  assert.match(r.out, /^FAIL - a launch waits for its first window$/m, 'the child\'s output:\n' + r.out);
  assert.match(r.out, /timed out after 700 ms waiting for the app window/, 'the wait\'s own timeout is the failure');
  assert.doesNotMatch(r.out, /every window is off-screen/);
  clean(r);
});
test('a launch whose document window is on-screen ends the first wait with the windows listed (DISH-G-50)', async () => {
  const r = await runCase('run-onscreen');
  ended(r, 0);
  assert.match(r.out, /^FIRST WINDOW \[\{"height":744,"layer":0,"onscreen":true,"width":980,"x":790,"y":324\}\]$/m, 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m);
  clean(r);
});

// DM-248: a Ctrl+C or a kill during the harness's own cleanup ended the run
// with 130 before the app's data was put back, so the data stayed in
// appdata-backup and the lock file stayed (the Delivery Manager's AT-H6 and
// AT-H7 showed it under this file's fake home). They are adopted here with
// the answer the fix sets: the signal waits for the restore and the lock
// release, is reported, and the run then ends with 130.
test('a Ctrl+C while the run\'s own cleanup waits for the app to quit waits for that cleanup: the data back, the lock released, the signal reported, exit code 130 (DM-248; the Delivery Manager\'s AT-H6)', async () => {
  let sent = false;
  const r = await runCase('run-signal-during-cleanup', (out, child) => {
    if (sent || !out.includes('IN AFTER')) return;
    sent = true;
    child.kill('SIGINT');
  });
  assert.ok(sent, 'the signal was sent while after() waited; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup went on to its end');
  assert.match(r.out, /^release: SIGINT came while the run puts the app's data back; the run ends with 130 once that is done$/m, 'the signal is reported');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a second Ctrl+C, after a first one during a test started the cleanup, is reported and not obeyed: the data back, the lock released, exit code 130 (DM-248; the Delivery Manager\'s AT-H7)', async () => {
  let first = false;
  let second = false;
  const r = await runCase('run-second-signal', (out, child) => {
    if (!first && out.includes('IN TEST')) { first = true; child.kill('SIGINT'); return; }
    if (first && !second && out.includes('IN AFTER')) { second = true; child.kill('SIGINT'); }
  });
  assert.ok(first && second, 'both signals were sent; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup went on to its end');
  assert.match(r.out, /^release: SIGINT came while the run puts the app's data back; the run ends with 130 once that is done$/m, 'the second signal is reported');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('SIGTERM during a test and then SIGHUP during the cleanup, as a watcher\'s kill and a closed terminal send them, wait for the cleanup as well, and no test starts after the first (DM-248)', async () => {
  let term = false;
  let hup = false;
  const r = await runCase('run-term-then-hup', (out, child) => {
    if (!term && out.includes('IN TEST')) { term = true; child.kill('SIGTERM'); return; }
    if (term && !hup && out.includes('IN AFTER')) { hup = true; child.kill('SIGHUP'); }
  });
  assert.ok(term && hup, 'both signals were sent; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup went on to its end');
  assert.match(r.out, /^release: SIGHUP came while the run puts the app's data back; the run ends with 130 once that is done$/m, 'the SIGHUP is reported');
  assert.doesNotMatch(r.out, /TEST AFTER THE SIGNAL/, 'no test starts once a signal has come');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// DM-247: three real-key tests (app.mjs) started from a first launch by
// clearing the test data mid-run, which on a sandboxed copy removes the
// copy's container; macOS refused that removal (EPERM) at the end of
// release-run-1, so those tests could not pass on a copy unattended (the
// Delivery Manager's AT-H5 showed it under this file's fake home). They now
// ask the harness's freshStart, which never clears a sandboxed bundle's
// container during the run and gives the next launch a fresh copy instead.
test('a test that needs a first launch of a sandboxed copy gets a fresh copy from the copy script, never a clear of the copy\'s container, and both containers are named at the end as test data left behind (DM-247)', async () => {
  const r = await runCase('run-fresh-start', undefined, { app: TEST_COPY });
  ended(r, 8);
  const line = r.out.split('\n').find((l) => l.startsWith('FRESH '));
  assert.ok(line, 'the test reached freshStart; the child\'s output:\n' + r.out);
  const fresh = JSON.parse(line.slice('FRESH '.length));
  const box = path.dirname(r.home);
  assert.deepEqual(fresh.asked, [{ source: path.join(box, 'bundle', 'Plain Sight test copy.app'), destination: path.join(box, 'evidence', 'fresh-copies', '1761000020000'), stamp: 1761000020000 }], 'makeTestCopy was asked once, for a copy of the bundle under test, into the run\'s evidence folder');
  assert.equal(fresh.made.identifier, 'com.pranavongole.plainsight.testcopy-1761000020000', 'the next launch opens the fresh copy');
  assert.deepEqual(fresh.removed, [], 'nothing was removed for the first launch');
  for (const id of [TEST_COPY, 'com.pranavongole.plainsight.testcopy-1761000020000']) assert.ok(r.out.includes('test data left behind: ' + path.join(CONTAINERS(r.home), id) + ' ('), id + ' is named as left behind; the child\'s output:\n' + r.out);
  const listed = r.out.split('\n').find((l) => l.startsWith('Test containers on this Mac at the end of the run'));
  assert.ok(listed && listed.includes(TEST_COPY) && listed.includes('com.pranavongole.plainsight.testcopy-1761000020000'), 'both are listed by name: ' + listed);
  assert.match(r.out, /^2 passed, 0 failed, 0 not run, 2 total\. Errors: 0$/m);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a fresh copy never takes an identifier whose folders are there already: it takes the next stamp and leaves that folder alone (DM-247)', async () => {
  const r = await runCase('run-fresh-start-taken', undefined, { app: TEST_COPY });
  ended(r, 0);
  const line = r.out.split('\n').find((l) => l.startsWith('FRESH '));
  assert.ok(line, 'the child\'s output:\n' + r.out);
  assert.equal(JSON.parse(line.slice('FRESH '.length)).made.identifier, 'com.pranavongole.plainsight.testcopy-1761000030001');
  assert.equal(readFileSync(marker(path.join(CONTAINERS(r.home), 'com.pranavongole.plainsight.testcopy-1761000030000')), 'utf8'), 'ANOTHER RUN\'S CONTAINER', 'the container that was there is untouched');
  clean(r);
});
test('a test that needs a first launch of an unsandboxed bundle still gets its folders cleared, and no copy (DM-247)', async () => {
  const r = await runCase('run-fresh-start-unsandboxed');
  ended(r, 0);
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m, 'the child\'s output:\n' + r.out);
  clean(r);
});

// QA-G-36 and DISH-G-70: guards of round 7 that no case above holds. QA-01's
// harness cases on 534f3cc (wave-g/qa/scripts/app/r7_harness_adv.mjs, H4 to
// H28, with its expectations), the Delivery Manager's AT-H1 to AT-H4
// (dm-appstore-534f3cc/adv/tests534/desktop/tests/dm-harness-adv-534.mjs)
// and DISH-G-70's breaks R1 to R7: each case below goes red on a break of
// harness.mjs that the cases above let through.
const PROBE = 'com.pranavongole.plainsight.sbprobe-1761000009';
test('a test copy\'s container that macOS refuses with EACCES is test data left behind as well: exit code 8 (QA-01 H4, DISH-G-70 R3)', async () => {
  const r = await runCase('run-test-container-eacces', undefined, { app: TEST_COPY });
  ended(r, 8);
  assert.ok(r.out.includes('test data left behind: ' + path.join(CONTAINERS(r.home), TEST_COPY) + ' (macOS refused to remove it;'), 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 8 \(test data left behind; your own data is back\)$/m);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a sandbox probe\'s container (sbprobe-) that macOS keeps is test data left behind too: exit code 8, listed by name (QA-01 H5, DISH-G-70 R6)', async () => {
  const r = await runCase('run-probe-container-refused', undefined, { app: PROBE });
  ended(r, 8);
  assert.ok(r.out.includes('test data left behind: ' + path.join(CONTAINERS(r.home), PROBE) + ' (macOS refused to remove it;'), 'the child\'s output:\n' + r.out);
  assert.match(r.out, new RegExp('^Test containers on this Mac at the end of the run \\(names only, never opened\\): ' + esc(PROBE) + '$', 'm'), 'the summary lists it by name; the child\'s output:\n' + r.out);
  clean(r);
});
test('a failed test with test data left behind ends with 1, not 8, and the leftover is still named (QA-01 H6, the Delivery Manager\'s AT-H4, DISH-G-70 R7)', async () => {
  const r = await runCase('run-leftover-and-failure', undefined, { app: TEST_COPY });
  ended(r, 1);
  assert.ok(r.out.includes('test data left behind: ' + path.join(CONTAINERS(r.home), TEST_COPY)), 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^1 passed, 1 failed, 0 not run, 2 total\. Errors: 1$/m);
  assert.match(r.out, /^Exit code: 1$/m);
  clean(r);
});
test('a stop with test data left behind ends with 3, not 8, and the leftover is still named (the Delivery Manager\'s AT-H3, QA-01 H7, DISH-G-70 R7)', async () => {
  const r = await runCase('run-leftover-and-stop', undefined, { app: TEST_COPY });
  ended(r, 3);
  assert.ok(r.out.includes('test data left behind: ' + path.join(CONTAINERS(r.home), TEST_COPY)), 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^skip - a later test \(not run: keyboard or mouse used during the run/m, 'the test after the stop is not run');
  assert.match(r.out, /^1 passed, 0 failed, 2 not run, 3 total\. Errors: 0$/m);
  assert.match(r.out, /^Exit code: 3$/m);
  clean(r);
});
test('a test copy\'s folder that was there before the run, which the run moved aside and macOS refuses on the way back, is no leftover: exit code 6, its earlier data kept in the backup (QA-01 H8b, DISH-G-70 R4)', async () => {
  const r = await runCase('run-copy-caches-kept', undefined, { app: TEST_COPY });
  ended(r, 6);
  const caches = path.join(r.home, 'Library', 'Caches', TEST_COPY);
  assert.ok(r.out.includes('Could not restore app data: could not clear the test data in ' + caches + ' (EPERM)'), 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /test data left behind/, 'what was there before the run is never taken for a leftover');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m);
  assert.equal(r.backups.length, 1, 'the backup is kept');
  const backup = path.join(BACKUP_ROOT(r.home), r.backups[0]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(backup, 'moved.json'), 'utf8')), [caches], 'moved.json lists the folder whose earlier data waits there');
  assert.equal(readFileSync(marker(path.join(backup, Buffer.from(caches).toString('base64url'))), 'utf8'), 'OLD TEST DATA OF AN EARLIER RUN', 'and that data is in the backup');
  assert.ok(r.intact, 'the person\'s folders came back');
  assert.equal(r.lock, false, 'the lock is released');
});
test('the real identifier\'s container, made by the run and refused on removal, is never test data left behind: exit code 6, loud (QA-01 H8c: the D-39 trap must not pass for a leftover)', async () => {
  const r = await runCase('run-real-container-made', undefined, { app: TEST_COPY });
  ended(r, 6);
  assert.ok(r.out.includes('Could not restore app data: could not clear the test data in ' + path.join(CONTAINERS(r.home), 'com.pranavongole.plainsight') + ' (EPERM)'), 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /test data left behind/);
  assert.doesNotMatch(r.out, /^Exit code: 8/m);
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m);
  assert.ok(r.intact, 'the person\'s folders came back');
  assert.equal(r.lock, false, 'the lock is released');
});
test('the real identifier\'s cookie file, made by the run and refused on removal, is never test data left behind either: a name that starts with the real identifier and a dot is not a test identifier (QA-01 H8d)', async () => {
  const r = await runCase('run-real-cookies-made', undefined, { app: TEST_COPY });
  ended(r, 6);
  assert.ok(r.out.includes('Could not restore app data: could not clear the test data in ' + path.join(r.home, 'Library', 'HTTPStorages', 'com.pranavongole.plainsight.binarycookies') + ' (EPERM)'), 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /test data left behind/);
  assert.doesNotMatch(r.out, /^Exit code: 8/m);
  assert.ok(r.intact, 'the person\'s folders came back');
});
test('a locked screen at the start does not keep a suite that does not need it unlocked from running: the run starts and passes (QA-01 H13b)', async () => {
  const r = await runCase('run-locked-not-needed');
  ended(r, 0);
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m, 'the child\'s output:\n' + r.out);
  clean(r);
});
test('the screen locking during a run that needs it unlocked stops the run: exit code 3, the later test not run, the data back, the lock released (QA-01 H22, the Delivery Manager\'s AT-H1, DM-246 HL1)', async () => {
  const r = await runCase('run-locks-midway');
  ended(r, 3);
  assert.match(r.out, /^stop - a test during which the screen locks \(the screen locked during the run\)$/m, 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^skip - a later test \(not run: the screen locked during the run\)$/m);
  assert.match(r.out, /^0 passed, 0 failed, 2 not run, 2 total\. Errors: 0$/m);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a window on-screen for the whole first wait that never meets it is the app\'s failure, not a locked screen: exit code 1 (QA-01 H26, DISH-G-70 R1)', async () => {
  const r = await runCase('run-onscreen-unmatched');
  ended(r, 1);
  assert.match(r.out, /^FAIL - a launch waits for two windows on screen$/m, 'the child\'s output:\n' + r.out);
  assert.match(r.out, /timed out after 700 ms waiting for two windows/, 'the wait\'s own timeout is the failure');
  assert.doesNotMatch(r.out, /every window is off-screen/);
  clean(r);
});
test('a window on-screen and then lost before the first wait is met is a failure as well, not a not-run stop (the Delivery Manager\'s AT-H2, DISH-G-70 R1)', async () => {
  const r = await runCase('run-onscreen-then-lost');
  ended(r, 1);
  assert.match(r.out, /^FAIL - a launch waits for its first window$/m, 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /every window is off-screen/);
  clean(r);
});
test('a window of the document\'s size on another layer, off-screen, is not the document window: the app\'s failure, exit code 1 (QA-01 H28, DISH-G-70 R2)', async () => {
  const r = await runCase('run-big-window-other-layer');
  ended(r, 1);
  assert.match(r.out, /^FAIL - a launch waits for its first window$/m, 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /every window is off-screen/);
  clean(r);
});

let passed = 0;
let failed = 0;
try {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log('ok   - ' + t.name);
    } catch (err) {
      failed += 1;
      console.log('FAIL - ' + t.name);
      console.log('       ' + String(err && err.message ? err.message : err).split('\n').join('\n       '));
    }
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
if (existsSync(ROOT)) {
  failed += 1;
  console.log('FAIL - the temporary folder with every fake home in it is removed at the end: ' + ROOT + ' is still there');
} else {
  passed += 1;
  console.log('ok   - the temporary folder with every fake home in it is removed at the end');
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length + 1} total. Errors: ${failed}`);
process.exit(failed ? 1 : 0);
