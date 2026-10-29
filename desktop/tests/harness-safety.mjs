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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// DM-249: the stand-in app the parent writes into its temporary folder, whose
// path each child is handed, and the file in the box where every stand-in
// records its pid.
const STANDIN = 'PLAIN_SIGHT_HARNESS_TEST_STANDIN';
const STANDIN_PIDS = 'standin-pids.txt';
// The late writer of the restore check's cases (round 10), written by the
// parent into its temporary folder.
const LATE = 'PLAIN_SIGHT_HARNESS_TEST_LATE';
// The restore check's second look in a case that does not test the check:
// 100 ms instead of 3 s, set through the harness's test-only setter.
const RECHECK = 'PLAIN_SIGHT_HARNESS_TEST_RECHECK_MS';
// The pid holder of the reused pid's cases (round 12), written by the parent
// into its temporary folder.
const HOLDER_ENV = 'PLAIN_SIGHT_HARNESS_TEST_HOLDER';
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
  // long the Mac has been idle, and for the app's windows, e2e.mjs's
  // hidden-document test for the front app's pid, and pgrep whether the app
  // is open. It answers from `fake`, the case's state; every other program
  // runs as it is (plutil reads a fake bundle's Info.plist).
  const fake = { locked: false, idle: 600, windows: [], front: 4243, ps: null };
  const started = Date.now();
  const exec = childProcess.execFileSync;
  childProcess.execFileSync = (file, args = [], options) => {
    if (path.basename(String(file)) === DRIVER) {
      const command = String(args[0]);
      const answer = command === 'trusted' ? { ok: true, accessibility: true }
        : command === 'session' ? { ok: true, locked: fake.locked, idle: fake.idle + (Date.now() - started) / 1000 }
          : command === 'cgwindows' ? { ok: true, windows: fake.windows }
            : command === 'frontmost' ? { ok: true, pid: fake.front }
              : { ok: false, error: 'the stand-in has no answer for ' + command };
      return JSON.stringify(answer) + '\n';
    }
    // pgrep -f for a path inside this case's own folder (round 13's copiesOf)
    // is the real pgrep, which finds only the case's own processes; any other
    // question, whether the app is open say, has no process here.
    if (file === 'pgrep' && args[0] === '-f' && String(args[1] || '').startsWith(box + path.sep)) return exec(file, args, options);
    if (file === 'pgrep') throw Object.assign(new Error('pgrep found no process'), { status: 1, stdout: '' });
    // ps, for a case that gives its answers by pid (fake.ps): the line, or
    // none for no such process, when ps exits with 1 (round 12).
    if (file === 'ps' && fake.ps) {
      const answer = fake.ps[Number(args[args.indexOf('-p') + 1])];
      if (answer === undefined) throw Object.assign(new Error('ps found no process'), { status: 1, stdout: '' });
      return answer + '\n';
    }
    return exec(file, args, options);
  };
  syncBuiltinESMExports();
  const h = await import(pathToFileURL(HARNESS).href);
  if (process.env[RECHECK]) h.setRestoreRecheckForTests(Number(process.env[RECHECK]));
  // The person's own data folders hold their data before the run; a test
  // copy's folders do not exist yet: its launch makes them. Two cases leave
  // one place of the real identifier's empty, so that the run itself makes
  // it there (QA-01's H8c and H8d).
  const realContainer = path.join(home, 'Library', 'Containers', h.ID);
  const realCookies = path.join(home, 'Library', 'HTTPStorages', h.ID + '.binarycookies');
  const unseeded = { 'run-real-container-made': realContainer, 'run-real-cookies-made': realCookies }[which];
  const dirs = h.DATA_DIRS.filter((d) => !isTestFolder(d) && d !== unseeded);
  console.log('DIRS ' + JSON.stringify(dirs.map((d) => path.relative(home, d))));
  // A second run in the fake home of a case under way (QA-01's L6) seeds
  // nothing: the person's data is the first run's.
  if (which !== 'second-run') for (const d of dirs) { mkdirSync(d, { recursive: true }); writeFileSync(marker(d), real(home, d)); }
  const intact = () => dirs.forEach((d) => assert.equal(existsSync(marker(d)) ? readFileSync(marker(d), 'utf8') : null, real(home, d), 'the data in ' + d + ' is as it was'));
  const backups = () => (existsSync(BACKUP_ROOT(home)) ? readdirSync(BACKUP_ROOT(home)) : []);
  const cleanup = async () => { h.restoreAppData(); };
  const cases = {
    'restore-before-backup'() {
      h.restoreAppData();
      intact();
      assert.deepEqual(backups(), [], 'no backup folder');
    },
    // QA-G-40 K32 (QA-01's P2.3; the Delivery Manager's AT-H5b): two fresh
    // copies asked for in the same millisecond, before either is launched (so
    // no folder of the first exists yet), get two stamps: the second takes
    // the next one, from the stamp the first took.
    'fresh-start-twice'() {
      h.backupAppData();
      const asked = [];
      const makeCopy = (source, destination, stamp) => { asked.push(stamp); return { made: { app: path.join(destination, 'Plain Sight test copy.app'), identifier: 'com.pranavongole.plainsight.testcopy-' + stamp, sandboxed: true } }; };
      const facts = { app: '/nowhere/Plain Sight test copy.app', identifier: TEST_COPY, sandboxed: true };
      const first = h.freshStart(facts, { makeCopy, now: () => 1761000060000 });
      const second = h.freshStart(facts, { makeCopy, now: () => 1761000060000 });
      assert.deepEqual(asked, [1761000060000, 1761000060001], 'the second copy takes the next stamp: ' + JSON.stringify(asked));
      assert.notEqual(first.identifier, second.identifier, 'two identifiers, so two containers of their own');
      h.restoreAppData();
      intact();
      assert.deepEqual(backups(), [], 'no backup folder');
    },
    'clear-before-backup'() {
      assert.throws(() => h.clearTestData(), /not moved aside/, 'refused');
      intact();
    },
    // DISH-G-81 F2: freshStart makes a fresh copy only while the app's data
    // is moved aside, since the copy's folders join that backup's restore:
    // before the move aside and after the restore it throws, and the copy
    // script is never asked.
    'fresh-start-phases'() {
      const asked = [];
      const makeCopy = (source, destination, stamp) => { asked.push(stamp); return { made: { app: path.join(destination, 'Plain Sight test copy.app'), identifier: 'com.pranavongole.plainsight.testcopy-' + stamp, sandboxed: true } }; };
      const facts = { app: '/nowhere/Plain Sight test copy.app', identifier: TEST_COPY, sandboxed: true };
      assert.throws(() => h.freshStart(facts, { makeCopy, now: () => 1761000050000 }), /the app data is not moved aside \(untouched\), so no fresh copy is made/, 'refused before the move aside');
      h.backupAppData();
      h.restoreAppData();
      intact();
      assert.throws(() => h.freshStart(facts, { makeCopy, now: () => 1761000050000 }), /the app data is not moved aside \(restored\), so no fresh copy is made/, 'refused after the restore');
      assert.deepEqual(asked, [], 'the copy script was never asked');
      assert.equal(existsSync(path.join(process.env.PLAIN_SIGHT_EVIDENCE, 'fresh-copies')), false, 'and nothing was made in the evidence folder');
      assert.deepEqual(backups(), [], 'no backup folder');
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
      onRename = () => { if (!seen) seen = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'].map((s) => process.listenerCount(s)); };
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
    // (here a folder in the fake home), macOS refuses its removal (here the
    // hook, as EPERM, which is what release-run-1 saw; its cause was not
    // shown), and run() ends the process itself.
    async 'run-test-container-refused'() {
      onRemove = (target) => { if (target === container) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer]);
    },
    // Eleven of QA-01's harness cases on 534f3cc (H4, H5, H6, H7, H8b, H8c,
    // H8d, H13b, H22, H26 and H28 of wave-g/qa/scripts/app/r7_harness_adv.mjs
    // with r7_harness_child.mjs), on this file's stand-in: QA-01
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
    // QA-01's observation 2 (its P3.8 in r8_infra_adv.mjs): SIGQUIT, which
    // Ctrl+backslash sends, was not handled, so it ended the run at once with
    // the data in appdata-backup and the lock left. It is handled as SIGINT is.
    async 'run-sigquit'() {
      await runSuite([
        { name: 'a test during which SIGQUIT comes', fn: async () => { testData(dirs[0]); console.log('IN TEST'); await new Promise((r) => setTimeout(r, 1000)); } },
        { name: 'a test after the signal', fn: async () => { console.log('TEST AFTER THE SIGNAL'); } }
      ]);
    },
    // PO-R8-1: the cleanup runs once and every caller waits for that one; no
    // case showed the once, so with each caller running a cleanup of its own
    // (`cleaning =` for `cleaning ||=`, the Product Owner's PO3-DM248) every
    // case passed. The Delivery Manager's AT-H9 (dm-harness-adv-a33.mjs): a
    // SIGINT while the run's own cleanup waits in after() makes no second
    // cleanup; here with a second SIGINT after the first, after() counting its
    // calls and every folder put back from the backup named.
    async 'run-cleanup-once'() {
      let calls = 0;
      onRename = (from, to) => { if (from.startsWith(BACKUP_ROOT(home) + path.sep)) console.log('PUT BACK ' + path.relative(home, to)); };
      await runSuite([{ name: 'a test that writes test data', fn: async () => { testData(dirs[0]); } }], {
        after: async () => { calls += 1; console.log('AFTER CALL ' + calls); console.log('IN AFTER'); await h.sleep(3000); console.log('AFTER DONE ' + calls); }
      });
    },
    // DM-249: after a signal, or once the run's own cleanup had begun, the
    // test that was running went on and could launch the app again, which
    // then outlived the run and ran over the restored folders (a launch of
    // this branch's build removes the 1.0.0 app's folder.txt). The Delivery
    // Manager's AT-H8b, AT-H8 and AT-H8c (dm-appstore-a3387d9/adv/tests/
    // desktop/tests/dm-harness-adv-a33.mjs), adopted with the answer the fix
    // sets. The app is a stand-in (the parent's STANDIN) started through the
    // harness's spawnApp, as e2e.mjs starts the test build, and the suite's
    // after() is e2e.mjs's own (stopCurrentApp). AT-H8b: the signal comes
    // while the test waits, and its next step launches the app again.
    async 'run-relaunch-waiting'() {
      await runSuite([{ name: 'a test that launches the app again after a wait', fn: async () => {
        await ready(launchApp());
        await h.sleep(300);
        console.log('WAITING');
        await h.sleep(400);
        launchApp();
        console.log('RELAUNCHED ' + current.pid);
        await h.sleep(4000);
      } }], { after: e2eAfter });
    },
    // AT-H8, e2e.mjs's own shape: the signal comes while the test waits in its
    // own stopApp() before it launches the app again.
    async 'run-relaunch-stopping'() {
      await runSuite([{ name: 'a test that restarts the app, as e2e.mjs does', fn: async () => {
        await ready(launchApp());
        await h.sleep(300);
        console.log('STOPPING');
        await h.stopApp(current);
        launchApp();
        console.log('RELAUNCHED ' + current.pid);
        await h.sleep(4000);
      } }], { after: e2eAfter });
    },
    // AT-H8c: the same, with the person's 1.0.0 folder choice (folder.txt) in
    // the real identifier's Application Support folder, which the run moves
    // aside and puts back.
    async 'run-relaunch-folder'() {
      writeFileSync(path.join(appSupport, 'folder.txt'), '/Users/someone/Notes');
      await runSuite([{ name: 'a test that restarts the app, as e2e.mjs does', fn: async () => {
        await ready(launchApp());
        await h.sleep(400);
        console.log('STOPPING');
        await h.stopApp(current);
        launchApp();
        console.log('RELAUNCHED ' + current.pid);
        await h.sleep(4000);
      } }], { after: e2eAfter });
    },
    // The refusal on its own: the test's next launch comes only once the
    // cleanup's after() has ended, so no after() could stop that app.
    async 'run-launch-after-signal'() {
      await runSuite([{ name: 'a test that launches the app once the cleanup has stopped it', fn: async () => {
        await ready(launchApp());
        console.log('IN TEST');
        await afterDone;
        try { launchApp(); } catch (err) { console.log('REFUSED ' + err.message); throw err; }
        console.log('LAUNCHED AGAIN ' + current.pid);
      } }], { after: e2eAfterThenSay });
    },
    // The same during the run's own cleanup, with no signal: a launch the test
    // left for later comes once that cleanup's after() has ended.
    async 'run-launch-in-own-cleanup'() {
      await runSuite([{ name: 'a test that leaves a launch for later', fn: async () => {
        await ready(launchApp());
        afterDone.then(() => {
          try { launchApp(); console.log('LAUNCHED AGAIN ' + current.pid); } catch (err) { console.log('REFUSED ' + err.message); }
        });
      } }], { after: e2eAfterThenSay });
    },
    // e2e.mjs's after() on its own: a copy started by a way the refusal does
    // not see (not spawnApp) while the cleanup stops the first is stopped too,
    // since after() stops the app that is current when each stop ends.
    async 'run-late-app-stopped'() {
      const signalCame = new Promise((resolve) => process.once('SIGINT', resolve));
      await runSuite([{ name: 'a test that starts another copy while the cleanup stops the first', fn: async () => {
        await ready(launchApp());
        console.log('IN TEST');
        await signalCame;
        await h.sleep(200);
        const child = spawn(process.env[STANDIN], [], { stdio: 'ignore', env: { ...process.env, ...standinEnv } });
        current = { child, pid: child.pid };
        console.log('STARTED ANOTHER ' + child.pid);
        await h.sleep(4000);
      } }], { after: e2eAfter });
    },
    // QA-01's E1 (wave-g/qa/scripts/app/r9_suite_adv.mjs, group E; QA-G-45):
    // e2e.mjs itself, its launch() and its after(), with this file's stand-in
    // for the driver and the stand-in app as the test build. Only its first
    // test runs. Its launch waits for a first window that never comes, or,
    // with the window shown at once, for the probe's answer, which the
    // stand-in never gives; the parent sends the signal once the app has
    // recorded its pid.
    async 'e2e-first-window-wait'() { await e2eSuite([]); },
    async 'e2e-probe-wait'() { await e2eSuite([HELPER, DOC_ON]); },
    // Round 11 (e2e-run-4's show step): e2e.mjs's own hidden-document test
    // under a fake of the test build's hook. The show leaves the page hidden,
    // as in e2e-run-4, or brings it back.
    async 'e2e-show-stays-hidden'() { await e2eHidden(false); },
    async 'e2e-show-returns'() { await e2eHidden(true); },
    // PO-R11-1 (round 12): the show leaves the page hidden, and a person
    // touches the Mac while the window's state is read at the timeout.
    async 'e2e-touch-at-evidence'() { await e2eHidden(false, true); },
    // DM-249's launched half, the restore check (round 10). The person's data
    // holds a nested file as well, which the run must leave as it was.
    async 'run-restore-clean'() {
      personFile(dirs[1], path.join('notes', 'today.txt'), 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that writes test data', fn: async () => { testData(dirs[0]); } }]);
    },
    async 'run-restore-late-change'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'change'); testData(dirs[0]); } }]);
    },
    // PO-R10-1 (round 11): late writers that keep the file's size. The
    // first rewrites it with other bytes of the same length, the second
    // writes the same bytes again, so only the modification time changes.
    async 'run-restore-late-same-size'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'same-size'); testData(dirs[0]); } }]);
    },
    async 'run-restore-late-same-bytes'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'same-bytes'); testData(dirs[0]); } }]);
    },
    // DM-257 (round 11): the Delivery Manager's AT-R3, AT-R4 and AT-R7 (its
    // delta of 46d6f62, adv/tests/desktop/tests/dm-harness-adv-46.mjs),
    // adopted, and a data folder that can no longer be listed after the
    // restore. The nested file is where WebKit keeps the vault record.
    async 'run-restore-late-nested'() {
      const rel = path.join('WebsiteData', 'LocalStorage', 'tauri_localhost_0.localstorage');
      personFile(dirs[0], rel, 'VAULT RECORD 0123456789');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], rel), 'same-size', dirs[0]); testData(dirs[0]); } }]);
    },
    async 'run-restore-late-new-file'() {
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[1], 'written-after-the-restore'), 'create'); testData(dirs[0]); } }]);
    },
    async 'run-restore-unlisted'() {
      const sealed = path.join(dirs[1], 'sealed');
      mkdirSync(sealed);
      writeFileSync(path.join(sealed, 'inside.txt'), 'x');
      chmodSync(sealed, 0o000);
      console.log('SEALED ' + sealed);
      await runSuite([{ name: 'a test that writes test data', fn: async () => { testData(dirs[0]); } }]);
    },
    async 'run-restore-unlistable-after'() {
      personFile(dirs[1], path.join('notes', 'today.txt'), 'THE PERSON\'S NOTES');
      console.log('SEALED ' + path.join(dirs[1], 'notes'));
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[1], 'notes'), 'seal', dirs[1]); testData(dirs[0]); } }]);
    },
    async 'run-restore-late-remove'() {
      writeFileSync(path.join(appSupport, 'folder.txt'), '/Users/someone/Notes');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(appSupport, 'folder.txt'), 'remove'); testData(dirs[0]); } }]);
    },
    async 'run-restore-late-change-signal'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test during which a signal comes', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'change'); testData(dirs[0]); console.log('IN TEST'); await h.sleep(5000); } }]);
    },
    // DISH-G-93 (round 12): the same late change, with the signal while the
    // run's own cleanup waits in after(), so the run ends by run()'s own line
    // for a signal that came during its cleanup.
    async 'run-late-change-in-after'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'change'); testData(dirs[0]); } }], { after: slowAfter });
    },
    // QA-G-46 (round 12): QA-01's restore check cases for its R2, R6, R7,
    // R15, R16 and R19 (wave-g/qa/scripts/app/r10_restore_adv.mjs, groups A,
    // L and P, with r10_restore_child.mjs and r10_writer.mjs), on this
    // file's late writer. A.size-mtime-kept: a file grown 1 s after the
    // restore, its modification time put back to the nanosecond.
    async 'run-late-grow-same-time'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      console.log('MTIME ' + fs.statSync(path.join(dirs[0], 'notes.txt'), { bigint: true }).mtimeNs);
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'grow-same-time'); testData(dirs[0]); } }]);
    },
    // A.remove-top: a whole data folder the run put back, removed 1 s later.
    async 'run-late-folder-removed'() {
      personFile(dirs[1], path.join('notes', 'today.txt'), 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(dirs[1], 'remove-folder', dirs[1]); testData(dirs[0]); } }]);
    },
    // A.hidden: a new hidden file, 1 s after the restore.
    async 'run-late-hidden-file'() {
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[1], '.late-hidden'), 'create'); testData(dirs[0]); } }]);
    },
    // L7: a run the person stopped (3 on its own) whose data a late writer
    // then changed.
    async 'run-late-change-stopped'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test the person interrupts, with a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'change'); testData(dirs[0]); throw new h.UserActivity('keyboard or mouse used during the run (idle 0.0 s)'); } }]);
    },
    // L6: the parent starts a second run in this fake home half a second
    // after the restore, during the second look; the test holds a second, so
    // the parent sees the backup folder before it goes.
    async 'run-held-through-check'() {
      await runSuite([{ name: 'a test that takes a second', fn: async () => { testData(dirs[0]); await h.sleep(1000); } }]);
    },
    async 'second-run'() {
      await h.run([{ name: 'a second run', fn: async () => { console.log('SECOND RAN'); } }], { name: 'second', needUnlocked: false });
    },
    // P.source as behaviour: stopApp on an app that has already ended.
    async 'stop-ended-app'() {
      const gone = h.spawnApp('/usr/bin/true');
      if (gone.exitCode === null && gone.signalCode === null) await new Promise((resolve) => gone.once('exit', resolve));
      const t0 = Date.now();
      await h.stopApp({ child: gone, pid: gone.pid });
      console.log('STOPPED ' + gone.pid + ' after ' + (Date.now() - t0) + ' ms');
      await h.sleep(300);
    },
    // An app the run launched (spawnApp records it) that nothing stops: the
    // suite gives no after().
    async 'run-restore-live-app'() {
      await runSuite([{ name: 'a test that launches an app and leaves it running', fn: async () => {
        const child = h.spawnApp(process.env[STANDIN], { STANDIN_PIDS: standinEnv.STANDIN_PIDS });
        current = { child, pid: child.pid };
        await ready(current);
        console.log('LEFT RUNNING ' + child.pid);
      } }]);
    },
    // Round 12, the reused pid (Developer N's round 11 observation): macOS
    // hands an ended app's pid to another program. The app's child has ended
    // here (Node has seen it end) while another live program holds its pid:
    // the parent's pid holder, which stands for the program macOS gave the
    // pid to. The suite's end (stopCurrentApp) and its waits (alive, until)
    // must neither wait on nor signal it.
    async 'pid-reused-child'() {
      const gone = h.spawnApp('/usr/bin/true');
      if (gone.exitCode === null && gone.signalCode === null) await new Promise((resolve) => gone.once('exit', resolve));
      const holder = await pidHolder(process.execPath);
      await stopCurrentFor({ child: gone, pid: holder.pid });
      h.recordLaunch(holder.pid, '/usr/bin/true', gone);   // the launch's record, its pid now the holder's
      await waitsFor(holder.pid);
      await holderAfter(holder);
    },
    // The same for a copy recorded through LaunchServices, as app.mjs and
    // release.mjs record each copy (by its bundle): the pid holder runs node,
    // not the copy's executable.
    async 'pid-reused-copy'() {
      const holder = await pidHolder(process.execPath);
      h.recordLaunch(holder.pid, copyBundle);
      await stopCurrentFor({ pid: holder.pid });
      await waitsFor(holder.pid);
      await holderAfter(holder);
    },
    // DM-259 and QA-G-48 (round 13): ps fails while the restore check asks
    // about a recorded copy (the Delivery Manager's AT-P4, QA-01's
    // ps-broken-run): a stand-in ps first on PATH that ends with 2 and "ps:
    // fork: Resource temporarily unavailable", as ps does when the Mac can
    // start no process.
    async 'run-ps-broken'() {
      const bin = path.join(box, 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\necho "ps: fork: Resource temporarily unavailable" >&2\nexit 2\n');
      chmodSync(path.join(bin, 'ps'), 0o755);
      await runSuite([{ name: 'a test that records a copy, after which ps breaks', fn: async () => {
        testData(dirs[0]);
        h.recordLaunch(7001, copyBundle);
        process.env.PATH = bin + path.delimiter + process.env.PATH;
      } }]);
    },
    // QA-G-48 (round 13): a restore check that fails for a reason no fake
    // home can make once ps's own failure is caught: a stand-in check
    // (setRestoreCheckForTests) that throws, standing for any other fault.
    async 'run-check-fails'() {
      h.setRestoreCheckForTests(async () => { throw new Error('a stand-in restore check that fails'); });
      await runSuite([{ name: 'a test that passes', fn: async () => {} }]);
    },
    // Round 13 item 4 (the Product Owner's decision on DISH I-21): the end of
    // the suites that open bundles (endCopies), with a copy the run never
    // recorded (a program at the bundle's executable, which ignores SIGTERM)
    // and a bystander whose arguments merely hold that path (node, with the
    // path as an argument). The driver's quit-app has no answer here, so the
    // copy is ended by the SIGKILL 5 s later.
    async 'end-copies'() {
      const copy = await pidHolder(copyExecutable(), 'stays', 'COPY');
      const bystander = await pidHolder(process.execPath, 'stays', 'BYSTANDER', [copyExecutable()]);
      console.log('COPIES ' + JSON.stringify(h.copiesOf(copyBundle)) + ' of ' + JSON.stringify([copy.pid, bystander.pid]));
      const asked = [];
      const t0 = Date.now();
      await h.endCopies([copyBundle], (pid) => { asked.push(pid); throw new Error('the stand-in driver has no quit-app'); });
      console.log('QUIT ASKED ' + JSON.stringify(asked) + ' in ' + (Date.now() - t0) + ' ms');
      await h.sleep(300);
      for (const [name, holder] of [['COPY', copy], ['BYSTANDER', bystander]]) {
        console.log(name + ' AFTER ' + JSON.stringify({ signals: existsSync(holder.file) ? readFileSync(holder.file, 'utf8').trim() : '', stillRuns: holder.p.exitCode === null && holder.p.signalCode === null }));
      }
    },
    // Round 13 item 2: a copy recorded through a linked folder (as /tmp and
    // /var lead to /private), whose process runs from the real folder.
    async 'copy-through-link'() {
      const real = path.join(box, 'real-place');
      const exe = path.join(real, 'Plain Sight test copy.app', 'Contents', 'MacOS', 'plain-sight');
      mkdirSync(path.dirname(exe), { recursive: true });
      fs.symlinkSync(process.execPath, exe);
      fs.symlinkSync(real, path.join(box, 'linked-place'));
      const copy = await pidHolder(exe, 'quits', 'COPY');
      h.recordLaunch(copy.pid, path.join(box, 'linked-place', 'Plain Sight test copy.app'));
      console.log('ALIVE ' + h.alive(copy.pid));
      await stopCurrentFor({ pid: copy.pid });
      await holderAfter(copy);
    },
    // PO-R12-1 (round 13): the same, with the pid held by another Plain Sight,
    // a program at another bundle's .../Contents/MacOS/plain-sight.
    async 'pid-reused-other-copy'() {
      const holder = await pidHolder(otherCopyExecutable(), 'stays', 'OTHER');
      h.recordLaunch(holder.pid, copyBundle);
      await stopCurrentFor({ pid: holder.pid });
      await waitsFor(holder.pid);
      await holderAfter(holder);
    },
    // QA-G-49 (round 13): QA-01's other names for the program that holds the
    // pid (wave-g/qa/scripts/app/r12_pid_adv.mjs with r12_pid_child.mjs): a
    // helper beside the copy's executable (its path starts with the copy's),
    // a bundle named as the copy's with .bak after it, and the copy's whole
    // path again under another folder (it ends with the copy's).
    async 'pid-reused-helper'() { await heldBy(path.join(copyBundle, 'Contents', 'MacOS', 'plain-sight-helper')); },
    async 'pid-reused-bak'() { await heldBy(path.join(copyBundle + '.bak', 'Contents', 'MacOS', 'plain-sight')); },
    async 'pid-reused-nested'() { await heldBy(path.join(box, 'nested') + path.join(copyBundle, 'Contents', 'MacOS', 'plain-sight')); },
    // What ps can answer for a recorded copy's pid, given here: the copy's
    // executable; the flag E with only the short name, as ps showed a copy
    // ending just after a SIGTERM; the state Z; another program; no process.
    async 'ps-states'() {
      const exe = path.join(copyBundle, 'Contents', 'MacOS', 'plain-sight');
      fake.ps = { 7001: 'S    ' + exe, 7002: '?E   (node)', 7003: 'Z    <defunct>', 7004: 'S    /usr/libexec/another-program' };
      for (const pid of [7001, 7002, 7003, 7004, 7005]) { h.recordLaunch(pid, copyBundle); console.log('ALIVE ' + pid + ' ' + h.alive(pid)); }
      await h.sleep(300);
    },
    // A copy that still runs the copy's executable, recorded the same way, is
    // stopped: the SIGTERM reaches it by its pid.
    async 'copy-stopped'() {
      const copy = await pidHolder(copyExecutable(), 'quits');
      h.recordLaunch(copy.pid, copyBundle);
      await stopCurrentFor({ pid: copy.pid });
      await holderAfter(copy);
    },
    // The restore check (QA-01's observation 9): a recorded copy whose pid
    // another program holds at the run's end is no app still running; a copy
    // still running is one.
    async 'run-copy-pid-reused'() {
      await runSuite([{ name: 'a test that records a copy whose pid another program holds', fn: async () => {
        testData(dirs[0]);
        const holder = await pidHolder(process.execPath);
        h.recordLaunch(holder.pid, copyBundle);
        console.log('ALIVE ' + h.alive(holder.pid));   // the rule's note, made well before the run ends
      } }]);
    },
    async 'run-copy-left-running'() {
      await runSuite([{ name: 'a test that leaves a copy running', fn: async () => {
        testData(dirs[0]);
        const copy = await pidHolder(copyExecutable(), 'quits');
        h.recordLaunch(copy.pid, copyBundle);
      } }]);
    },
    // A file of the person's that no one may read (mode 000).
    async 'run-restore-unreadable'() {
      personFile(dirs[1], 'locked.txt', 'NOT FOR THE HARNESS', 0o000);
      await runSuite([{ name: 'a test that writes test data', fn: async () => { testData(dirs[0]); } }]);
    },
    async 'run-unkillable-ignore'() { await unkillable('ignore'); },
    async 'run-unkillable-frozen'() { await unkillable('frozen'); },
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
  // It says whether the run's lock is still held as it starts (QA-G-40).
  const slowAfter = async () => { console.log('IN AFTER'); console.log('LOCK HELD ' + existsSync(LOCK(home))); await new Promise((r) => setTimeout(r, 3000)); console.log('AFTER DONE'); };
  // DM-249: the stand-in app (the parent's STANDIN), started through the
  // harness's spawnApp as e2e.mjs starts the test build. `current` is the app
  // a test launched last, as e2e.mjs's `app` is, and e2eAfter is e2e.mjs's
  // after(); afterDone settles once a case's after() has ended.
  const appSupport = path.join(home, 'Library', 'Application Support', h.ID);
  const standinEnv = { STANDIN_PIDS: path.join(box, STANDIN_PIDS), STANDIN_WEBDATA: path.join(home, 'Library', 'WebKit', 'plain-sight'), STANDIN_APPDATA: appSupport };
  let current = null;
  const launchApp = () => { const child = h.spawnApp(process.env[STANDIN], standinEnv); current = { child, pid: child.pid }; return current; };
  const recorded = () => (existsSync(standinEnv.STANDIN_PIDS) ? readFileSync(standinEnv.STANDIN_PIDS, 'utf8').split('\n') : []);
  const ready = async (app) => { await h.until(() => recorded().includes(String(app.pid)), 'the stand-in app to start', 10000); return app; };
  const e2eAfter = () => h.stopCurrentApp(() => current);
  let afterEnded = null;
  const afterDone = new Promise((resolve) => { afterEnded = resolve; });
  const e2eAfterThenSay = async () => { await e2eAfter(); console.log('AFTER DONE'); afterEnded(); };
  // QA-01's E1: e2e.mjs run as it is, its app the stand-in. The child refuses
  // unless the app e2e.mjs would launch is that stand-in, in this file's own
  // temporary folder, so no test build is ever started.
  // DM-249's launched half (round 10): a file of the person's, written into a
  // data folder before the run; and a late writer (the parent's LATE script),
  // started by a test and never recorded as an app, which waits until the
  // marker of the target's data folder (the folder the target is in, or the
  // one named) holds the person's own words again, that is until the
  // restore, then acts on the target 1 s later.
  const personFile = (dir, rel, text, mode = 0o644) => { const file = path.join(dir, rel); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, mode); };
  const lateWriter = (target, action, folder = path.dirname(target)) => {
    spawn(process.execPath, [process.env[LATE], marker(folder), real(home, folder), target, action], { stdio: 'ignore', detached: true }).unref();
  };
  // Round 12, the reused pid: a pid holder (the parent's script) started
  // under the program given, ready once it can take signals; it prints its
  // pid and the file it records signals in, by which the parent ends it. A
  // copy's executable is <bundle>/Contents/MacOS/plain-sight, as
  // LaunchServices starts it; here a link to node, so ps names the process
  // by that path. stopCurrentFor races stopCurrentApp against 6 s, and its
  // current() answers at most five times, so a stop that loops cannot hold
  // the case; waitsFor is the suites' check and wait on an app's pid.
  let holders = 0;
  const copyBundle = path.join(box, 'copy', 'Plain Sight test copy.app');
  const copyExecutable = () => {
    const exe = path.join(copyBundle, 'Contents', 'MacOS', 'plain-sight');
    if (!existsSync(exe)) { mkdirSync(path.dirname(exe), { recursive: true }); fs.symlinkSync(process.execPath, exe); }
    return exe;
  };
  // PO-R12-1 (round 13): another Plain Sight, such as the person's own app
  // in /Applications or another test copy, is a program at another bundle's
  // .../Contents/MacOS/plain-sight; here a link to node at such a path.
  const otherCopyExecutable = () => {
    const exe = path.join(box, 'other', 'Plain Sight.app', 'Contents', 'MacOS', 'plain-sight');
    if (!existsSync(exe)) { mkdirSync(path.dirname(exe), { recursive: true }); fs.symlinkSync(process.execPath, exe); }
    return exe;
  };
  // QA-G-49: a recorded copy whose pid a program at `exe` (a link to node
  // made there) holds.
  const heldBy = async (exe) => {
    mkdirSync(path.dirname(exe), { recursive: true });
    if (!existsSync(exe)) fs.symlinkSync(process.execPath, exe);
    const holder = await pidHolder(exe, 'stays', 'OTHER');
    h.recordLaunch(holder.pid, copyBundle);
    await stopCurrentFor({ pid: holder.pid });
    await waitsFor(holder.pid);
    await holderAfter(holder);
  };
  const pidHolder = async (program, mode = 'stays', label = program === process.execPath ? 'HOLDER' : 'COPY', extra = []) => {
    holders += 1;
    const file = path.join(box, 'holder-' + holders + '-signals');
    const p = spawn(program, [process.env[HOLDER_ENV], file, mode, ...extra], { stdio: 'ignore' });
    console.log(label + ' ' + p.pid + ' ' + file);
    await h.until(() => existsSync(file + '.ready'), 'the pid holder to take signals', 10000);
    return { p, pid: p.pid, file };
  };
  const stopCurrentFor = async (app) => {
    let asked = 0;
    const t0 = Date.now();
    const how = await Promise.race([
      h.stopCurrentApp(() => (asked++ < 5 ? app : null)).then(() => 'returned', (err) => 'threw ' + err.message),
      h.sleep(6000).then(() => 'still waiting')
    ]);
    console.log('STOP CURRENT ' + how + ' after ' + (Date.now() - t0) + ' ms; current() asked ' + asked + ' time(s)');
  };
  const waitsFor = async (pid) => {
    console.log('ALIVE ' + h.alive(pid));
    const t0 = Date.now();
    const how = await h.until(() => !h.alive(pid), 'the app to end', 3000).then(() => 'returned', (err) => 'threw ' + err.message);
    console.log('WAIT ' + how + ' after ' + (Date.now() - t0) + ' ms');
  };
  const holderAfter = async (holder) => {
    await h.sleep(300);
    console.log('SIGNALS ' + ((existsSync(holder.file) ? readFileSync(holder.file, 'utf8').trim() : '') || 'none'));
    console.log('STILL RUNS ' + (holder.p.exitCode === null && holder.p.signalCode === null));
  };
  // QA-G-44 (N6): QA-01's L5 (r9_launch_adv.mjs with r9_launch_child.mjs,
  // case unkillable): an app that ignores SIGTERM, or freezes itself on it,
  // so only stopApp's SIGKILL after its 8 s wait ends it. The test tries to
  // launch again while the cleanup waits, and after() is e2e.mjs's own.
  const unkillable = (mode) => runSuite([{ name: 'an app that will not quit on SIGTERM', fn: async () => {
    const child = h.spawnApp(process.env[STANDIN], { ...standinEnv, STANDIN_MODE: mode });
    current = { child, pid: child.pid };
    await ready(current);
    console.log('IN TEST');
    await h.sleep(1500);
    try { launchApp(); console.log('RELAUNCHED ' + current.pid); } catch (err) { console.log('REFUSED ' + err.constructor.name); }
    await h.sleep(15000);
  } }], { after: async () => { console.log('IN AFTER'); const t0 = Date.now(); await e2eAfter(); console.log('AFTER DONE after ' + (Date.now() - t0) + ' ms'); } });
  const e2eSuite = async (windows) => {
    fake.windows = windows;
    mkdirSync(path.join(home, 'Downloads'), { recursive: true });
    Object.assign(process.env, standinEnv, { PLAIN_SIGHT_E2E_APP: process.env[STANDIN], PLAIN_SIGHT_ONLY: '^first launch: ' });
    if (!process.env.PLAIN_SIGHT_E2E_APP || !process.env.PLAIN_SIGHT_E2E_APP.startsWith(path.dirname(box) + path.sep)) {
      console.log('refusing: e2e.mjs would launch ' + process.env.PLAIN_SIGHT_E2E_APP + ', not the stand-in');
      process.exit(2);
    }
    await import(pathToFileURL(path.join(HERE, 'e2e.mjs')).href);
  };
  // Round 11: e2e.mjs run as it is, its hidden-document test only, with a
  // fake of the test build's hook (src-tauri/src/e2e.rs) answering in the
  // probe folder: the page's visibility, the window actions and windowState.
  // The test launches nothing; the child refuses as e2eSuite does unless the
  // app e2e.mjs would launch is the stand-in.
  const e2eHidden = async (showBringsItBack, touchAtTimeout = false) => {
    const probe = path.join(h.EVIDENCE, 'probe');
    let visibility = 'visible';
    let windowStates = 0;
    const answerFor = (req) => {
      if (req.eval === 'document.visibilityState') return { ok: true, value: visibility };
      if (req.window === 'minimize' || req.window === 'hide') { visibility = 'hidden'; return { ok: true }; }
      if (req.window === 'unminimize' || (req.window === 'show' && showBringsItBack)) { visibility = 'visible'; return { ok: true }; }
      if (req.window === 'show') return { ok: true };
      if (req.windowState === true) {
        // PO-R11-1: the second read of the window's state is the timeout's; a
        // person touches the Mac as it is given, so the driver's next look at
        // the session finds the Mac just used.
        windowStates += 1;
        if (touchAtTimeout && windowStates === 2) fake.idle = -(Date.now() - started) / 1000;
        return { ok: true, value: { fakeHook: true, occlusionVisible: visibility === 'visible', appActive: visibility === 'visible', appHidden: false } };
      }
      return { ok: false, error: 'the fake hook has no answer for ' + JSON.stringify(req) };
    };
    setInterval(() => {
      const request = path.join(probe, 'request.json');
      if (!existsSync(request)) return;
      const req = JSON.parse(readFileSync(request, 'utf8'));
      rmSync(request);
      const tmp = path.join(probe, 'response-' + req.id + '.tmp');
      writeFileSync(tmp, JSON.stringify(answerFor(req)));
      fs.renameSync(tmp, path.join(probe, 'response-' + req.id + '.json'));
    }, 20).unref();
    mkdirSync(path.join(home, 'Downloads'), { recursive: true });
    Object.assign(process.env, standinEnv, { PLAIN_SIGHT_E2E_APP: process.env[STANDIN], PLAIN_SIGHT_ONLY: '^a minimized window and a hidden app give the page a hidden document' });
    if (!process.env.PLAIN_SIGHT_E2E_APP || !process.env.PLAIN_SIGHT_E2E_APP.startsWith(path.dirname(box) + path.sep)) {
      console.log('refusing: e2e.mjs would launch ' + process.env.PLAIN_SIGHT_E2E_APP + ', not the stand-in');
      process.exit(2);
    }
    await import(pathToFileURL(path.join(HERE, 'e2e.mjs')).href);
  };
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

// DM-249: a stand-in for the app, written into the temporary folder (the
// Delivery Manager's adv/standin-app.mjs and standin-app-folder.mjs in one).
// It records its pid once it can take a SIGTERM (a SIGTERM while node still
// starts would end it at once, so the cases wait for that record), ends 1 s
// after its first SIGTERM (the app's quit takes about a second), writes a file into STANDIN_WEBDATA 1.5 s after it starts
// (as the test build writes its web data), and removes folder.txt from
// STANDIN_APPDATA 150 ms after it starts, as every launch of this branch's
// build does (folder.rs, Folder::with, through Folder::load). It writes
// nothing to its output, so a closed pipe cannot end it, and it ends by
// itself after 20 s. With STANDIN_MODE ignore it ignores SIGTERM, and with
// frozen it stops itself (SIGSTOP) on it, so only a SIGKILL ends it (QA-01's
// r9_standin.mjs modes, QA-G-44).
const STANDIN_APP = path.join(ROOT, 'standin-app.mjs');
const STANDIN_EXE = path.join(ROOT, 'standin-app');
writeFileSync(STANDIN_APP, [
  "import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  "const env = process.env;",
  "let quitting = false;",
  "process.on('SIGTERM', () => { if (env.STANDIN_MODE === 'ignore') return; if (env.STANDIN_MODE === 'frozen') { process.kill(process.pid, 'SIGSTOP'); return; } if (quitting) return; quitting = true; setTimeout(() => process.exit(0), 1000); });",
  "process.on('SIGINT', () => {});",
  "process.on('SIGHUP', () => {});",
  "appendFileSync(env.STANDIN_PIDS, process.pid + '\\n');",
  "if (env.STANDIN_APPDATA) setTimeout(() => { try { rmSync(path.join(env.STANDIN_APPDATA, 'folder.txt'), { force: true }); } catch {} }, 150);",
  "if (env.STANDIN_WEBDATA) setTimeout(() => { try { mkdirSync(env.STANDIN_WEBDATA, { recursive: true }); writeFileSync(path.join(env.STANDIN_WEBDATA, 'written-by-' + process.pid), 'WRITTEN BY THE TEST APP'); } catch {} }, 1500);",
  "setTimeout(() => process.exit(0), 20000);"
].join('\n') + '\n');
const shellQuoted = (p) => "'" + p.replace(/'/g, "'\\''") + "'";
writeFileSync(STANDIN_EXE, '#!/bin/sh\nexec ' + shellQuoted(process.execPath) + ' ' + shellQuoted(STANDIN_APP) + '\n');
chmodSync(STANDIN_EXE, 0o755);

// The late writer of the restore check's cases (round 10): waits until a
// file holds the given text (the person's marker, back after the restore),
// then 1 s later changes the target or removes it; it ends by itself after
// 30 s if the text never comes. A change appends to the target; same-size
// rewrites it with as many bytes, every one an x, and same-bytes writes its
// own bytes again, which changes only its modification time (PO-R10-1);
// create makes a new file there, and seal takes every permission from a
// folder, so that no one may list it (DM-257); grow-same-time appends to the
// target and puts its modification time back to the nanosecond (cp -p to a
// reference beside this script, then touch -r, as QA-01's writer does), and
// remove-folder removes a whole folder (QA-G-46).
const LATE_WRITER = path.join(ROOT, 'late-writer.mjs');
writeFileSync(LATE_WRITER, [
  "import { execFileSync } from 'node:child_process';",
  "import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  "const [watch, expect, target, action] = process.argv.slice(2);",
  "const started = Date.now();",
  "const look = setInterval(() => {",
  "  let now = null;",
  "  try { now = readFileSync(watch, 'utf8'); } catch { now = null; }",
  "  if (now === expect) {",
  "    clearInterval(look);",
  "    setTimeout(() => {",
  "      if (action === 'remove') rmSync(target, { force: true });",
  "      else if (action === 'same-size') writeFileSync(target, Buffer.alloc(readFileSync(target).length, 'x'));",
  "      else if (action === 'same-bytes') writeFileSync(target, readFileSync(target));",
  "      else if (action === 'create') { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, 'MADE AFTER THE RESTORE'); }",
  "      else if (action === 'seal') chmodSync(target, 0o000);",
  "      else if (action === 'grow-same-time') { const ref = path.join(path.dirname(process.argv[1]), 'time-ref-' + process.pid); execFileSync('cp', ['-p', target, ref]); appendFileSync(target, ' MORE'); execFileSync('touch', ['-r', ref, target]); rmSync(ref); }",
  "      else if (action === 'remove-folder') rmSync(target, { recursive: true, force: true });",
  "      else appendFileSync(target, ' CHANGED LATE');",
  "    }, 1000);",
  "  } else if (Date.now() - started > 30000) clearInterval(look);",
  "}, 20);"
].join('\n') + '\n');

// The pid holder of the reused pid's cases (round 12): a program that holds a
// pid, standing for the one macOS gives an ended app's pid to. It records
// each SIGTERM, SIGINT, SIGHUP and SIGQUIT it gets in the file it is given
// (ending on none of them, so each stays on record), says it can take them
// in that file's .ready, and ends by itself after 30 s; with "quits" it ends
// on its first SIGTERM, as a copy of the app does.
const HOLDER = path.join(ROOT, 'pid-holder.mjs');
writeFileSync(HOLDER, [
  "import { appendFileSync, writeFileSync } from 'node:fs';",
  "const [file, mode] = process.argv.slice(2);",
  "for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) process.on(s, () => { appendFileSync(file, s + ' '); if (s === 'SIGTERM' && mode === 'quits') process.exit(0); });",
  "writeFileSync(file + '.ready', String(process.pid));",
  "setTimeout(() => process.exit(0), 30000);"
].join('\n') + '\n');

// A fake bundle under a test identifier, outside the fake home, for the
// harness to read as PLAIN_SIGHT_APP (only its Info.plist is read).
function fakeCopy(box, identifier) {
  const app = path.join(box, 'bundle', 'Plain Sight test copy.app');
  mkdirSync(path.join(app, 'Contents'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>' + identifier + '</string><key>CFBundleName</key><string>Plain Sight test copy</string></dict></plist>\n');
  return app;
}

// Every case ends within its watchdog (120 s, or what it names): one that
// hangs is ended with SIGKILL and fails, so a regression fails instead of
// holding the suite (QA-G-44).
function runCase(id, onOutput = () => {}, { app = null, tag = id, recheck = 100, watchdog = 120000 } = {}) {
  const box = path.join(ROOT, tag);
  const home = path.join(box, 'home');
  const tmp = path.join(box, 'tmp');
  const evidence = path.join(box, 'evidence');
  for (const d of [home, tmp, evidence]) mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, TMPDIR: tmp, PLAIN_SIGHT_EVIDENCE: evidence, [BOX]: box, [STANDIN]: STANDIN_EXE, [LATE]: LATE_WRITER, [HOLDER_ENV]: HOLDER };
  // Nothing of the shell that runs npm test reaches the harness's settings.
  for (const name of ['PLAIN_SIGHT_E2E_DOWNLOADS', 'PLAIN_SIGHT_APP', 'PLAIN_SIGHT_IDLE_MIN', 'PLAIN_SIGHT_ONLY', 'PLAIN_SIGHT_ALLOW_REAL_ID']) delete env[name];
  if (app) env.PLAIN_SIGHT_APP = fakeCopy(box, app);
  if (recheck !== null) env[RECHECK] = String(recheck);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', id], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const timer = setTimeout(() => { out += '\nWATCHDOG: the case ran for ' + watchdog + ' ms and was ended with SIGKILL\n'; child.kill('SIGKILL'); }, watchdog);
  const feed = (chunk) => { out += chunk; onOutput(out, child, box); };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  return new Promise((resolve) => child.on('exit', (code, signal) => {
    clearTimeout(timer);
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
test('freshStart makes no fresh copy before the app\'s data is moved aside or after it is put back: it throws, and the copy script is never asked (DISH-G-81 F2)', async () => {
  const r = await runCase('fresh-start-phases');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/, 'the child\'s output:\n' + r.out);
  clean(r);
});
test('two fresh copies asked for in the same millisecond, before either is launched, get two stamps and two identifiers (QA-G-40 K32; QA-01\'s P2.3, the Delivery Manager\'s AT-H5b)', async () => {
  const r = await runCase('fresh-start-twice');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/, 'the child\'s output:\n' + r.out);
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
// release, is reported, and the run then ends with 130. In each, after() runs
// and ends once, with the run's lock still held as it starts (QA-G-40: QA-01's
// K43, each caller with a cleanup of its own, and K41, the lock dropped before
// after(); its P3.2a and P3.2c).
const onceWithTheLock = (r) => {
  const lines = r.out.split('\n');
  assert.equal(lines.filter((l) => l === 'IN AFTER').length, 1, 'after() ran once; the child\'s output:\n' + r.out);
  assert.equal(lines.filter((l) => l === 'AFTER DONE').length, 1, 'and ended once');
  assert.deepEqual(lines.filter((l) => l.startsWith('LOCK HELD ')), ['LOCK HELD true'], 'the run\'s lock was held when after() started');
};
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
  assert.match(r.out, /^release: SIGINT came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was$/m, 'the signal is reported');
  onceWithTheLock(r);
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
  assert.match(r.out, /^release: SIGINT came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was$/m, 'the second signal is reported');
  onceWithTheLock(r);
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
  assert.match(r.out, /^release: SIGHUP came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was$/m, 'the SIGHUP is reported');
  onceWithTheLock(r);
  assert.doesNotMatch(r.out, /TEST AFTER THE SIGNAL/, 'no test starts once a signal has come');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// PO-R8-1: the cleanup runs once. The Delivery Manager's AT-H9, adopted, with
// a second signal: with each caller running its own cleanup (PO3-DM248) the
// data still came back and every case above passed, but after() ran twice.
test('the cleanup runs once: a Ctrl+C while the run\'s own cleanup waits in after(), then a second one, start no cleanup of their own: after() is called once, every folder is put back once, both signals are reported and deferred, exit code 130 (PO-R8-1; the Delivery Manager\'s AT-H9)', async () => {
  const deferred = "release: SIGINT came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was";
  let first = false;
  let second = false;
  const r = await runCase('run-cleanup-once', (out, child) => {
    if (!first && out.includes('IN AFTER')) { first = true; child.kill('SIGINT'); return; }
    if (first && !second && out.split('\n').includes(deferred)) { second = true; child.kill('SIGINT'); }
  });
  assert.ok(first && second, 'both signals were sent while after() waited; the child\'s output:\n' + r.out);
  ended(r, 130);
  const lines = r.out.split('\n');
  assert.deepEqual(lines.filter((l) => /^AFTER CALL \d+$/.test(l)), ['AFTER CALL 1'], 'after() was called once; the child\'s output:\n' + r.out);
  assert.deepEqual(lines.filter((l) => /^AFTER DONE \d+$/.test(l)), ['AFTER DONE 1'], 'and went on to its end once');
  const putBack = lines.filter((l) => l.startsWith('PUT BACK ')).map((l) => l.slice('PUT BACK '.length)).sort();
  assert.deepEqual(putBack, r.dirs.map((d) => path.relative(r.home, d)).sort(), 'every folder was put back from the backup, once');
  assert.equal(lines.filter((l) => l === deferred).length, 2, 'both signals were reported and deferred');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// QA-01's observation 2 (its P3.8): a SIGQUIT during a test, as Ctrl+backslash
// sends it, ended the run by the signal itself, with the data aside and the
// lock left; it is handled now, as a Ctrl+C is.
test('a SIGQUIT (Ctrl+backslash) during a test is handled as a Ctrl+C is: the data back, the lock released, no later test, exit code 130 (QA-01\'s observation 2 and P3.8)', async () => {
  let sent = false;
  const r = await runCase('run-sigquit', (out, child) => { if (!sent && out.includes('IN TEST')) { sent = true; child.kill('SIGQUIT'); } });
  assert.ok(sent, 'the signal was sent during the test; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.doesNotMatch(r.out, /TEST AFTER THE SIGNAL/, 'no test starts after it');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// DM-249: after a Ctrl+C or a kill during a test, the test went on while the
// harness put everything back, and nothing stopped it from launching the app
// again: the Delivery Manager saw an app outlive the run and write into the
// restored folders, and remove the person's restored folder.txt, in 10 of 10
// runs each (AT-H8 and AT-H8c; AT-H8b is deterministic). They are adopted
// here with the answer the fix sets, AT-H8 and AT-H8c in three runs each, side
// by side (one lost run is enough to show the race, and the old harness lost
// 10 of 10): the relaunch is refused and no app outlives the run. Three more
// cases hold each part of the fix on its own, since either part alone hides
// the other's absence in AT-H8b: the refusal after a signal, the refusal
// during the run's own cleanup, and e2e.mjs's after() stopping a copy started
// by a way the refusal does not see.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// What became of the stand-ins a case started: the pids they recorded, those
// still running just after the run ended, and the files one wrote into the
// restored web data folder after it; then each is ended, so none outlives
// the case.
async function standinsAfter(r) {
  await pause(400);   // a stand-in started at the very end records its pid once node is up
  const file = path.join(path.dirname(r.home), STANDIN_PIDS);
  const pids = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(Number).filter((p) => p > 0) : [];
  const running = pids.filter(isAlive);
  await pause(1800);   // a stand-in writes 1.5 s after it starts
  const web = path.join(r.home, 'Library', 'WebKit', 'plain-sight');
  const wrote = existsSync(web) ? readdirSync(web).filter((name) => name.startsWith('written-by-')) : [];
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* it has ended */ } }
  return { pids, running, wrote };
}
const refusedFor = (signal) => new RegExp('was not launched: the run is ending \\(' + (signal ? signal + ' came' : 'its cleanup has begun') + '\\), so nothing may start again \\(DM-249\\)');
test('a Ctrl+C while a test waits, whose next step launches the app again, leaves no app running after the run: the relaunch is refused and the test stops as not run, exit code 130, the data back (DM-249; the Delivery Manager\'s AT-H8b, with the answer the fix sets)', async () => {
  let sent = false;
  const r = await runCase('run-relaunch-waiting', (out, child) => { if (!sent && out.includes('WAITING')) { sent = true; child.kill('SIGINT'); } });
  const s = await standinsAfter(r);
  assert.ok(sent, 'the signal was sent while the test waited; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.ok(r.out.includes('stop - a test that launches the app again after a wait ('), 'the test stopped as not run; the child\'s output:\n' + r.out);
  assert.match(r.out, refusedFor('SIGINT'), 'the relaunch was refused, naming the signal');
  assert.doesNotMatch(r.out, /^RELAUNCHED /m, 'no app was launched again');
  assert.equal(s.pids.length, 1, 'one app was started, before the signal: ' + JSON.stringify(s.pids));
  assert.deepEqual(s.running, [], 'no app outlives the run');
  assert.deepEqual(s.wrote, [], 'nothing was written into the restored web data folder after the run');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a Ctrl+C while a test stops the app before launching it again (e2e.mjs\'s own shape) leaves no app running after the run, in each of three runs: exit code 130, the data back, nothing written after the run (DM-249; the Delivery Manager\'s AT-H8, with the answer the fix sets)', async () => {
  const runs = await Promise.all([1, 2, 3].map(async (n) => {
    let sent = false;
    const r = await runCase('run-relaunch-stopping', (out, child) => { if (!sent && out.includes('STOPPING')) { sent = true; child.kill('SIGINT'); } }, { tag: 'run-relaunch-stopping-' + n });
    return { n, sent, r, s: await standinsAfter(r) };
  }));
  for (const { n, sent, r, s } of runs) {
    assert.ok(sent, 'run ' + n + ': the signal was sent while the test stopped the app; the child\'s output:\n' + r.out);
    ended(r, 130);
    assert.doesNotMatch(r.out, /^RELAUNCHED /m, 'run ' + n + ': no app was launched again; the child\'s output:\n' + r.out);
    assert.equal(s.pids.length, 1, 'run ' + n + ': one app was started, before the signal: ' + JSON.stringify(s.pids));
    assert.deepEqual(s.running, [], 'run ' + n + ': no app outlives the run');
    assert.deepEqual(s.wrote, [], 'run ' + n + ': nothing was written into the restored web data folder after the run');
    clean(r);
    assert.equal(r.lock, false, 'run ' + n + ': the lock is released');
  }
});
test('a Ctrl+C while a test restarts the app leaves the person\'s 1.0.0 folder choice, folder.txt, in place a few seconds after the run, in each of three runs: no app outlives the run to remove it (DM-249; the Delivery Manager\'s AT-H8c, with the answer the fix sets)', async () => {
  const runs = await Promise.all([1, 2, 3].map(async (n) => {
    let sent = false;
    const r = await runCase('run-relaunch-folder', (out, child) => { if (!sent && out.includes('STOPPING')) { sent = true; child.kill('SIGINT'); } }, { tag: 'run-relaunch-folder-' + n });
    const folderTxt = path.join(r.home, 'Library', 'Application Support', 'com.pranavongole.plainsight', 'folder.txt');
    const atExit = existsSync(folderTxt);
    const s = await standinsAfter(r);
    return { n, sent, r, s, atExit, later: existsSync(folderTxt) ? readFileSync(folderTxt, 'utf8') : null };
  }));
  for (const { n, sent, r, s, atExit, later } of runs) {
    assert.ok(sent, 'run ' + n + ': the signal was sent while the test stopped the app; the child\'s output:\n' + r.out);
    ended(r, 130);
    assert.equal(atExit, true, 'run ' + n + ': folder.txt is back when the run ends');
    assert.equal(later, '/Users/someone/Notes', 'run ' + n + ': and still there, as it was, a few seconds later');
    assert.doesNotMatch(r.out, /^RELAUNCHED /m, 'run ' + n + ': no app was launched again; the child\'s output:\n' + r.out);
    assert.equal(s.pids.length, 1, 'run ' + n + ': one app was started, before the signal: ' + JSON.stringify(s.pids));
    assert.deepEqual(s.running, [], 'run ' + n + ': no app outlives the run');
    clean(r);
  }
});
test('a launch that a test asks for once the cleanup after a signal has stopped the app is refused, so no app is left that after() cannot stop: the test stops as not run, exit code 130 (DM-249)', async () => {
  let sent = false;
  const r = await runCase('run-launch-after-signal', (out, child) => { if (!sent && out.includes('IN TEST')) { sent = true; child.kill('SIGINT'); } });
  const s = await standinsAfter(r);
  assert.ok(sent, 'the signal was sent during the test; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup\'s after() ended first');
  assert.ok(r.out.split('\n').some((line) => line.startsWith('REFUSED ') && refusedFor('SIGINT').test(line)), 'the launch was refused, naming the signal; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /^LAUNCHED AGAIN /m, 'no app was launched again');
  assert.equal(s.pids.length, 1, 'one app was started, before the signal: ' + JSON.stringify(s.pids));
  assert.deepEqual(s.running, [], 'no app outlives the run');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a launch asked for during the run\'s own cleanup, with no signal at all, is refused too, so no app outlives a run that ends by its own count (DM-249)', async () => {
  const r = await runCase('run-launch-in-own-cleanup');
  const s = await standinsAfter(r);
  ended(r, 0);
  assert.ok(r.out.split('\n').some((line) => line.startsWith('REFUSED ') && refusedFor(null).test(line)), 'the launch was refused, naming the cleanup; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /^LAUNCHED AGAIN /m, 'no app was launched again');
  assert.equal(s.pids.length, 1, 'one app was started, by the test: ' + JSON.stringify(s.pids));
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m);
  assert.deepEqual(s.running, [], 'no app outlives the run');
  clean(r);
});
test('e2e.mjs\'s after() stops the app that is current when each stop ends: a copy started by a way the refusal does not see, while the cleanup stops the first, is stopped too, exit code 130 (DM-249)', async () => {
  let sent = false;
  const r = await runCase('run-late-app-stopped', (out, child) => { if (!sent && out.includes('IN TEST')) { sent = true; child.kill('SIGINT'); } });
  const s = await standinsAfter(r);
  assert.ok(sent, 'the signal was sent during the test; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^STARTED ANOTHER \d+$/m, 'the second copy was started while the cleanup stopped the first; the child\'s output:\n' + r.out);
  assert.equal(s.pids.length, 2, 'two copies were started: ' + JSON.stringify(s.pids));
  assert.deepEqual(s.running, [], 'neither outlives the run');
  clean(r);
});

// DISH-G-85 and QA-G-45 (N12): QA-01's E1 (r9_suite_adv.mjs, group E),
// adopted: e2e.mjs's own launch() and after(), in six variants that send the
// signal once the app has recorded its pid: SIGINT, SIGQUIT and SIGHUP 300 ms
// into the wait for the first window, SIGTERM 1.5 s into it, SIGINT at once,
// and SIGINT 300 ms into the wait for the probe's answer. With app set only
// after the window wait (QA-01's N12) or after both waits (DISH's N17), the
// app was outside after()'s sight and outlived the run.
test('e2e.mjs\'s own launch() records the app before its waits, so a signal during the wait for the first window or for the probe stops it: exit code 130, the app ended, nothing written after the run, the data back, in each of six variants (DISH-G-85, QA-G-45; QA-01\'s E1)', async () => {
  const variants = [
    ['e2e-first-window-wait', 'SIGINT', 300], ['e2e-first-window-wait', 'SIGQUIT', 300], ['e2e-first-window-wait', 'SIGHUP', 300],
    ['e2e-first-window-wait', 'SIGTERM', 1500], ['e2e-first-window-wait', 'SIGINT', 0], ['e2e-probe-wait', 'SIGINT', 300]
  ];
  const runs = await Promise.all(variants.map(async ([id, signal, delay], n) => {
    let sent = false;
    let poll = null;
    const r = await runCase(id, (out, child, box) => {
      if (poll) return;
      poll = setInterval(() => {
        const file = path.join(box, STANDIN_PIDS);
        if (sent || !existsSync(file) || !readFileSync(file, 'utf8').trim()) return;
        sent = true;
        clearInterval(poll);
        setTimeout(() => child.kill(signal), delay);
      }, 20);
    }, { tag: 'e2e-' + n });
    clearInterval(poll);
    return { what: id + ', ' + signal + ' ' + delay + ' ms after the pid', sent, r, s: await standinsAfter(r) };
  }));
  for (const { what, sent, r, s } of runs) {
    assert.ok(sent, what + ': the signal was sent once the app had recorded its pid; the child\'s output:\n' + r.out);
    ended(r, 130);
    assert.equal(s.pids.length, 1, what + ': one app was started: ' + JSON.stringify(s.pids));
    assert.deepEqual(s.running, [], what + ': after() stopped it, so no app outlives the run');
    assert.deepEqual(s.wrote, [], what + ': nothing was written into the restored web data folder after the run');
    clean(r);
    assert.equal(r.lock, false, what + ': the lock is released');
  }
});

// Round 11, e2e-run-4's show step: in e2e-run-4 (a92087a, 28 October 2026)
// the hidden-document test's page stayed hidden for the whole 5 s wait after
// the hook's show, and run.log said nothing of the window. Here e2e.mjs's own
// test runs under a fake of the hook: when the show leaves the page hidden,
// the test fails with that timeout, never passes, and run.log holds the
// window's state at the timeout (the hook's windowState and the driver's
// front app); when the show brings the page back, it passes. Both runs hold
// the record made with the page visible, before the minimize.
const HIDDEN_TEST = 'a minimized window and a hidden app give the page a hidden document, which is what starts its ten-minute wipe';
const runLog = (tag) => readFileSync(path.join(ROOT, tag, 'evidence', 'run.log'), 'utf8');
const BEFORE_RECORD = ' window state with the page visible, before the minimize (evidence only, never a pass): hook {"fakeHook":true,"occlusionVisible":true,"appActive":true,"appHidden":false}; front app {"pid":4243,"thisApp":false}; driver could not be read: ';
test('e2e.mjs\'s hidden-document test, its show leaving the page hidden as in e2e-run-4: it fails with the 5 s timeout, is never counted as passed, and run.log holds the window\'s state at the timeout and before the minimize (round 11, e2e-run-4\'s show step)', async () => {
  const r = await runCase('e2e-show-stays-hidden');
  ended(r, 1);
  assert.ok(r.out.split('\n').includes('FAIL - ' + HIDDEN_TEST), 'the test fails; the child\'s output:\n' + r.out);
  assert.match(r.out, /^ {7}Error: timed out after 5000 ms waiting for a visible page after show$/m, 'with the timeout of its show step');
  assert.match(r.out, /^0 passed, 1 failed, 0 not run, 1 total\. Errors: 1$/m, 'counted as failed, not as passed or not run');
  const log = runLog('e2e-show-stays-hidden');
  assert.match(log, / probe \{"window":"show"\} -> \{"ok":true\}$/m, 'the test asked the hook for its show; run.log:\n' + log);
  const at = log.split('\n').filter((l) => l.includes(' window state at the timeout waiting for a visible page after show (evidence only, never a pass): '));
  assert.equal(at.length, 1, 'one record at the timeout; run.log:\n' + log);
  assert.ok(at[0].includes(' hook {"fakeHook":true,"occlusionVisible":false,"appActive":false,"appHidden":false}; front app {"pid":4243,"thisApp":false}; driver could not be read: '), 'the hook\'s window state and the front app: ' + at[0]);
  assert.ok(log.includes(BEFORE_RECORD), 'and the record before the minimize; run.log:\n' + log);
  assert.ok(log.indexOf(at[0]) > log.lastIndexOf(' probe {"window":"show"}'), 'the record at the timeout comes after the show');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('e2e.mjs\'s hidden-document test, its show bringing the page back: it passes, with the record before the minimize and none at a timeout (round 11, the control)', async () => {
  const r = await runCase('e2e-show-returns');
  ended(r, 0);
  assert.ok(r.out.split('\n').includes('ok   - ' + HIDDEN_TEST), 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m);
  const log = runLog('e2e-show-returns');
  assert.ok(log.includes(BEFORE_RECORD), 'the record before the minimize; run.log:\n' + log);
  assert.ok(!log.includes(' window state at the timeout '), 'no record at a timeout; run.log:\n' + log);
  clean(r);
});
// PO-R11-1 (round 12): the Product Owner's break PO2-TOUCH-EVID took the
// rethrow out of windowEvidence's read helper and every case passed, so
// nothing held that a person at the keyboard still stops the run while the
// window's state is read: the touch would have been noted as a part not read
// and the test counted as failed. The stays-hidden show again, with the
// driver's stand-in finding the Mac just used once the hook has given the
// timeout's window state.
test('a person who touches the Mac while e2e.mjs reads the window\'s state at the hidden-document test\'s timeout stops the run as a touch: exit code 3, the test not counted as failed, the data back and the restore check clean (PO-R11-1)', async () => {
  const r = await runCase('e2e-touch-at-evidence');
  ended(r, 3);
  assert.ok(r.out.split('\n').some((l) => l.startsWith('stop - ' + HIDDEN_TEST + ' (keyboard or mouse used during the run (idle ')), 'the test stopped for the touch; the child\'s output:\n' + r.out);
  assert.ok(!r.out.split('\n').includes('FAIL - ' + HIDDEN_TEST), 'and was not counted as failed');
  assert.match(r.out, /^0 passed, 0 failed, 1 not run, 1 total\. Errors: 0$/m);
  assert.match(r.out, /^Exit code: 3$/m);
  assert.match(r.out, checkedLine, 'the restore check is clean');
  const log = runLog('e2e-touch-at-evidence');
  assert.equal(log.split('\n').filter((l) => l.includes(' probe {"windowState":true} -> ')).length, 2, 'the window\'s state was read before the minimize and at the timeout; run.log:\n' + log);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// DM-249's launched half (round 10). The Delivery Manager's check of a
// launched run is a deliberate end-to-end run that gets kill -INT while a
// test waits in stopApp() before a relaunch, then: the refusal line, exit
// code 130, no app left, appdata-backup empty, no lock, and the person's
// folder.txt as it was. The Product Owner must never read the person's data,
// so the harness checks the restore itself (checkRestore): it lists every
// folder it moves aside (every file's path, size and modification time and
// every folder's path; nothing is opened; a folder it cannot list then is
// named in the clean line and not checked),
// lists them again after the restore, at once and 3 s later, and looks for a
// launched app still running. These cases hold each part, under the fake home.
const restoredLine = (n) => new RegExp('^restore check: ' + n + ' folders as they were \\(names, sizes and times; checked twice, 3 s apart\\)$', 'm');
test('the Delivery Manager\'s launched check, here under the fake home: stopApp() notes "stopping pid <n>" in run.log first, a SIGINT sent on that line refuses the relaunch, and the run ends with 130, no app left, the backup empty, the lock released, folder.txt as it was and the restore check clean (DM-249)', async () => {
  let sent = 0;
  let poll = null;
  const r = await runCase('run-relaunch-folder', (out, child, box) => {
    if (poll) return;
    poll = setInterval(() => {
      const log = path.join(box, 'evidence', 'run.log');
      const m = existsSync(log) && readFileSync(log, 'utf8').match(/ stopping pid (\d+)$/m);
      if (!m || sent) return;
      sent = Number(m[1]);
      clearInterval(poll);
      child.kill('SIGINT');
    }, 20);
  }, { tag: 'run-driver-protocol', recheck: null });
  clearInterval(poll);
  const folderTxt = path.join(r.home, 'Library', 'Application Support', 'com.pranavongole.plainsight', 'folder.txt');
  const later = existsSync(folderTxt) ? readFileSync(folderTxt, 'utf8') : null;
  const s = await standinsAfter(r);
  assert.ok(sent > 0, 'run.log named the pid being stopped and the signal was sent on that line; the child\'s output:\n' + r.out);
  assert.deepEqual(s.pids, [sent], 'the pid run.log named is the app the test started, the only one');
  ended(r, 130);
  assert.ok(r.out.split('\n').some((line) => line.startsWith('stop - a test that restarts the app, as e2e.mjs does (') && refusedFor('SIGINT').test(line)), 'the refusal line; the child\'s output:\n' + r.out);
  assert.deepEqual(s.running, [], 'no app is left');
  assert.equal(later, '/Users/someone/Notes', 'folder.txt is as it was');
  assert.match(r.out, restoredLine(r.dirs.length), 'the restore check is clean');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('the restore check: a run that puts the person\'s data back as it was says so in one line before its summary, with the number of folders it moved aside (DM-249)', async () => {
  const r = await runCase('run-restore-clean', undefined, { recheck: null });
  ended(r, 0);
  const lines = r.out.split('\n');
  const at = lines.findIndex((l) => restoredLine(r.dirs.length).test(l));
  assert.ok(at >= 0, 'the clean line, with ' + r.dirs.length + ' folders; the child\'s output:\n' + r.out);
  assert.ok(at < lines.findIndex((l) => /^\d+ passed, \d+ failed, /.test(l)), 'before the summary');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m);
  assert.equal(readFileSync(path.join(r.dirs[1], 'notes', 'today.txt'), 'utf8'), 'THE PERSON\'S NOTES', 'the nested file is back');
  clean(r);
});
test('a file of the person\'s changed 1 s after the restore, by a writer the run never launched, is caught by the second look 3 s later: exit code 6, its path named (DM-249)', async () => {
  const r = await runCase('run-restore-late-change', undefined, { recheck: null });
  ended(r, 6);
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(path.join(r.dirs[0], 'notes.txt')) + ' \\(changed\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /as they were \(names/, 'no clean line');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.deepEqual(r.backups, [], 'the data was put back, then changed: no backup is left');
  assert.equal(r.lock, false, 'the lock is released');
});
// PO-R10-1 (round 11): the Product Owner's break PO1-RESTORE, the listing
// without modification times (st.size + ' bytes'), passed every case here,
// since each late change grew the file. A late writer that rewrites a file at
// the same size, or writes the same bytes again, changes only what the
// listing's time holds, and the check exists to catch a late writer.
const lateSameSize = async (id, check) => {
  const r = await runCase(id, undefined, { recheck: null });
  ended(r, 6);
  const notes = path.join(r.dirs[0], 'notes.txt');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(notes) + ' \\(changed\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /as they were \(names/, 'no clean line');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.deepEqual(r.backups, [], 'the data was put back, then changed: no backup is left');
  assert.equal(r.lock, false, 'the lock is released');
  check(notes);
};
test('a file of the person\'s rewritten 1 s after the restore with other bytes of the same length is caught by the second look: exit code 6, its path named (changed) (PO-R10-1)', async () => {
  await lateSameSize('run-restore-late-same-size', (notes) => {
    assert.equal(readFileSync(notes, 'utf8'), 'x'.repeat('THE PERSON\'S NOTES'.length), 'the writer kept the size and changed the bytes');
  });
});
test('a file of the person\'s written again 1 s after the restore with the same bytes, only its modification time new, is caught too: exit code 6, its path named (changed) (PO-R10-1)', async () => {
  await lateSameSize('run-restore-late-same-bytes', (notes) => {
    assert.equal(readFileSync(notes, 'utf8'), 'THE PERSON\'S NOTES', 'the bytes are as they were');
    const st = fs.statSync(notes);
    assert.ok(st.mtimeMs - st.birthtimeMs >= 900, 'and the file was written again after the restore: modified ' + Math.round(st.mtimeMs - st.birthtimeMs) + ' ms after it was made');
  });
});
// DM-257 (round 11): four parts of the restore check passed all 53 safety
// cases when broken (the Delivery Manager's RC1, RC2, RC3 and RC7, its
// delta of 46d6f62). RC1, the time comparison, is held by PO-R10-1's two
// cases above. The walk into subfolders, the report of new entries and the
// naming of a folder not listed when moved aside are held here by its
// AT-R3, AT-R4 and AT-R7, adopted (adv/tests/desktop/tests/
// dm-harness-adv-46.mjs), and a data folder that can no longer be listed
// after the restore, which no case reached either, by a fourth.
const unseal = (r) => { const sealed = (r.out.match(/^SEALED (.*)$/m) || [])[1]; if (sealed && existsSync(sealed)) chmodSync(sealed, 0o755); };
test('a file of the person\'s two folders deep, where WebKit keeps the vault record, rewritten at the same size 1 s after the restore is caught: exit code 6, the nested path named (changed) (DM-257; the Delivery Manager\'s AT-R3)', async () => {
  const r = await runCase('run-restore-late-nested', undefined, { recheck: null });
  ended(r, 6);
  const nested = path.join(r.dirs[0], 'WebsiteData', 'LocalStorage', 'tauri_localhost_0.localstorage');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(nested) + ' \\(changed\\)', 'm'), 'the nested path is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(readFileSync(nested, 'utf8'), 'x'.repeat('VAULT RECORD 0123456789'.length), 'the writer kept the size and changed the bytes');
});
test('a new file written into a folder the run put back, 1 s after the restore, is caught: exit code 6, its path named (new) (DM-257; the Delivery Manager\'s AT-R4)', async () => {
  const r = await runCase('run-restore-late-new-file', undefined, { recheck: null });
  ended(r, 6);
  const made = path.join(r.dirs[1], 'written-after-the-restore');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(made) + ' \\(new\\)', 'm'), 'the new path is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.ok(existsSync(made), 'the writer made the file after the restore');
});
test('a data folder that holds a folder no one may list (mode 000) cannot be listed when it is moved aside: the clean line counts one folder fewer and names it as not checked (EACCES), exit code 0 (DM-257; the Delivery Manager\'s AT-R7)', async () => {
  const r = await runCase('run-restore-unlisted', undefined, { recheck: null });
  try {
    ended(r, 0);
    const line = r.out.split('\n').find((l) => l.startsWith('restore check')) || '';
    assert.equal(line, 'restore check: ' + (r.dirs.length - 1) + ' folders as they were (names, sizes and times; checked twice, 3 s apart); not listed when moved aside, so not checked: ' + r.dirs[1] + ' (EACCES)', 'the child\'s output:\n' + r.out);
  } finally {
    unseal(r);
  }
});
test('a data folder that can no longer be listed after the restore (a folder in it sealed, mode 000, 1 s after the restore) is named: exit code 6, "could not be listed after the restore: EACCES" (DM-257)', async () => {
  const r = await runCase('run-restore-unlistable-after', undefined, { recheck: null });
  try {
    ended(r, 6);
    assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(r.dirs[1]) + ' \\(could not be listed after the restore: EACCES\\)', 'm'), 'the folder is named; the child\'s output:\n' + r.out);
    assert.match(r.out, /^Exit code: 6$/m);
  } finally {
    unseal(r);
  }
});
test('the person\'s folder.txt removed 1 s after the restore, as a launch of this branch\'s build removes it, is caught: exit code 6, its path named (DM-249, the shape of the Delivery Manager\'s AT-H8c)', async () => {
  const r = await runCase('run-restore-late-remove', undefined, { recheck: null });
  ended(r, 6);
  const folderTxt = path.join(r.home, 'Library', 'Application Support', 'com.pranavongole.plainsight', 'folder.txt');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(folderTxt) + ' \\(gone\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(r.lock, false, 'the lock is released');
});
test('the check runs on a signal\'s cleanup too: a late change after a Ctrl+C during a test ends the run with 6, not 130, its path named (DM-249)', async () => {
  let sent = false;
  const r = await runCase('run-restore-late-change-signal', (out, child) => { if (!sent && out.includes('IN TEST')) { sent = true; child.kill('SIGINT'); } }, { recheck: null });
  assert.ok(sent, 'the signal was sent during the test; the child\'s output:\n' + r.out);
  ended(r, 6);
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(path.join(r.dirs[0], 'notes.txt')) + ' \\(changed\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.deepEqual(r.backups, [], 'no backup is left');
  assert.equal(r.lock, false, 'the lock is released');
});
// DISH-G-93 (round 12): a signal that comes while the run's own cleanup waits
// in after() is reported and waits for that cleanup, and the run then ends by
// run()'s own line, `if (signalled) process.exit(restored ? 130 : 6)`. No case
// sent a signal there with the data not back as it was, so DISH's H9 (that
// line made exit 130) passed every case: a late change to the person's data
// would have ended the run with 130, the signal's code, and read as clean.
test('a SIGINT while the run\'s own cleanup waits in after(), with a file of the person\'s changed 1 s after the restore, ends the run with 6, not 130: the changed path named in the restore check\'s line, no clean line (DISH-G-93)', async () => {
  let sent = false;
  const r = await runCase('run-late-change-in-after', (out, child) => { if (!sent && out.includes('IN AFTER')) { sent = true; child.kill('SIGINT'); } }, { recheck: null });
  assert.ok(sent, 'the signal was sent while after() waited; the child\'s output:\n' + r.out);
  ended(r, 6);
  assert.match(r.out, /^release: SIGINT came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was$/m, 'the signal is reported, in words that hold for this run, which ends with 6 (round 13)');
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup went on to its end');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(path.join(r.dirs[0], 'notes.txt')) + ' \\(changed\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /as they were \(names/, 'no clean line');
  assert.deepEqual(r.backups, [], 'the data was put back, then changed: no backup is left');
  assert.equal(r.lock, false, 'the lock is released');
});

// QA-G-46 (round 12): twelve of QA-01's breaks of the restore check (R1, R2,
// R3, R5, R6, R7, R8, R14, R15, R16, R18 and R19 of its r10_mutate_new.py)
// passed every candidate suite at 46d6f62. On 4c5cc55 round 11's cases turn
// R1, R3, R5 and R8 red, and on this round's code DISH-G-93's case above
// turns R14 red; the cases below, adopted from its r10_restore_adv.mjs
// (groups A, L and P), hold the size (R2), a data folder gone after the
// restore (R6), hidden entries (R7), the lock through the second look (R15),
// the note for an app already ended (R16) and exit 6 over 3 (R19).
test('a file of the person\'s grown 1 s after the restore, its modification time put back to the nanosecond, is caught by its size: exit code 6, its path named (changed) (QA-G-46, R2; QA-01\'s A.size-mtime-kept)', async () => {
  const r = await runCase('run-late-grow-same-time', undefined, { recheck: null });
  ended(r, 6);
  const notes = path.join(r.dirs[0], 'notes.txt');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(notes) + ' \\(changed\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(readFileSync(notes, 'utf8'), 'THE PERSON\'S NOTES MORE', 'the writer grew the file');
  assert.equal(String(fs.statSync(notes, { bigint: true }).mtimeNs), (r.out.match(/^MTIME (\d+)$/m) || [])[1], 'and put its modification time back to the nanosecond, so only its size differs');
});
test('a data folder the run put back, removed whole 1 s after the restore, is caught: exit code 6, the folder named (gone) (QA-G-46, R6; QA-01\'s A.remove-top)', async () => {
  const r = await runCase('run-late-folder-removed', undefined, { recheck: null });
  ended(r, 6);
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(r.dirs[1]) + ' \\(gone\\)', 'm'), 'the folder is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(existsSync(r.dirs[1]), false, 'the writer removed it');
});
test('a hidden file written into a folder the run put back, 1 s after the restore, is caught: exit code 6, its path named (new) (QA-G-46, R7; QA-01\'s A.hidden)', async () => {
  const r = await runCase('run-late-hidden-file', undefined, { recheck: null });
  ended(r, 6);
  const hidden = path.join(r.dirs[1], '.late-hidden');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(hidden) + ' \\(new\\)', 'm'), 'the hidden path is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.ok(existsSync(hidden), 'the writer made it');
});
test('a run the person stopped, whose data a late writer changed 1 s after the restore, ends with 6, not 3: the person\'s data first, the path named and the stop reported (QA-G-46, R19; QA-01\'s L7)', async () => {
  const r = await runCase('run-late-change-stopped', undefined, { recheck: null });
  ended(r, 6);
  assert.ok(r.out.split('\n').includes('stop - a test the person interrupts, with a late writer behind (keyboard or mouse used during the run (idle 0.0 s))'), 'the stop is reported; the child\'s output:\n' + r.out);
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(path.join(r.dirs[0], 'notes.txt')) + ' \\(changed\\)', 'm'), 'the path is named');
  assert.match(r.out, /^0 passed, 0 failed, 1 not run, 1 total\. Errors: 1$/m);
  assert.match(r.out, /^Exit code: 6$/m);
});
// QA-01's L6: a second run in the fake home of a case under way, which seeds
// nothing and only asks run() to start, with an evidence folder of its own.
const secondRun = (box) => new Promise((resolve) => {
  const env = { ...process.env, HOME: path.join(box, 'home'), TMPDIR: path.join(box, 'tmp'), PLAIN_SIGHT_EVIDENCE: path.join(box, 'evidence-second'), [BOX]: box };
  for (const name of ['PLAIN_SIGHT_E2E_DOWNLOADS', 'PLAIN_SIGHT_APP', 'PLAIN_SIGHT_IDLE_MIN', 'PLAIN_SIGHT_ONLY', 'PLAIN_SIGHT_ALLOW_REAL_ID']) delete env[name];
  const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', 'second-run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => c.kill('SIGKILL'), 60000);
  c.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
});
test('the run holds its lock through the restore check\'s second look: a second run started half a second after the restore is refused with exit code 5, and the first ends clean (QA-G-46, R15; QA-01\'s L6)', async () => {
  let second = null;
  let poll = null;
  const r = await runCase('run-held-through-check', (out, child, box) => {
    if (poll) return;
    let seen = false;
    poll = setInterval(() => {
      const there = existsSync(BACKUP_ROOT(path.join(box, 'home')));
      if (there) seen = true;
      if (!seen || there) return;
      clearInterval(poll);
      setTimeout(() => { second = secondRun(box); }, 500);
    }, 10);
  }, { recheck: null });
  clearInterval(poll);
  assert.ok(second, 'the second run was started after the restore; the child\'s output:\n' + r.out);
  const s = await second;
  ended(r, 0);
  assert.match(r.out, restoredLine(r.dirs.length), 'the first run\'s check is clean; its output:\n' + r.out);
  assert.equal(s.code, 5, 'the second run ended with 5; its output:\n' + s.out);
  assert.match(s.out, /^second: not started: another GUI test run holds /m, 'refused for the lock');
  assert.doesNotMatch(s.out, /SECOND RAN/, 'its test never ran');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released at the end');
});
test('stopApp notes "stopping pid <n>" for an app that has already ended too, so a driver\'s signal still lands where a test stops its app (QA-G-46, R16; QA-01\'s P.source, as behaviour)', async () => {
  const r = await runCase('stop-ended-app');
  ended(r, 0);
  const [, pid, ms] = r.out.match(/^STOPPED (\d+) after (\d+) ms$/m) || [];
  assert.ok(pid, 'stopApp returned; the child\'s output:\n' + r.out);
  assert.ok(Number(ms) < 1000, 'at once: ' + ms + ' ms');
  const log = runLog('stop-ended-app');
  assert.ok(log.includes(' stopping pid ' + pid + '\n'), 'run.log names the pid; run.log:\n' + log);
});
test('an app the run launched and nothing stopped is named by its pid after the restore: exit code 6 (DM-249)', async () => {
  const r = await runCase('run-restore-live-app', undefined, { recheck: null });
  const s = await standinsAfter(r);
  ended(r, 6);
  const pid = Number((r.out.match(/^LEFT RUNNING (\d+)$/m) || [])[1]);
  assert.ok(pid > 0 && s.pids.includes(pid), 'the test left an app running; the child\'s output:\n' + r.out);
  assert.ok(r.out.split('\n').includes('restore check: still running, though this run launched it: pid ' + pid + ' (' + STANDIN_EXE + ')'), 'it is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  clean(r);
});

// Round 12, the reused pid (Developer N's round 11 observation, a data-safety
// path by the Product Owner's rating): stopCurrentApp waited while
// process.kill(pid, 0) answered, and stopApp signalled through child.kill,
// which sends nothing once Node has seen the child end; macOS hands pids out
// again, out of order, so an app whose pid another program had taken held the
// cleanup, with the person's data aside and the lock held, for as long as
// that program lived (19,772 ms in round 11's check). A copy recorded through
// LaunchServices was judged by its pid alone as well, so a pid another
// program had taken read as a copy still running, a false exit 6 (QA-01's
// observation 9). The pid holder stands for the program macOS gave the pid
// to; each case ends it by the file it records signals in.
const holdersOf = (r) => [...r.out.matchAll(/^(HOLDER|COPY|OTHER|BYSTANDER) (\d+) (\S+)$/gm)].map((m) => ({ kind: m[1], pid: Number(m[2]), file: m[3] }));
const endHolders = (r) => { for (const { file } of holdersOf(r)) { try { childProcess.execFileSync('pkill', ['-9', '-f', file]); } catch { /* it has ended */ } } };
const stopCurrentLine = (r) => (r.out.match(/^STOP CURRENT (.*) after (\d+) ms; current\(\) asked (\d+) time\(s\)$/m) || []).slice(1);
const otherProgramNote = (pid) => ' pid ' + pid + ' now runs another program: not stopped';
const neitherWaitedOnNorSignalled = (r, tag, holder) => {
  const [how, ms] = stopCurrentLine(r);
  assert.equal(how, 'returned', 'stopCurrentApp returned; the child\'s output:\n' + r.out);
  assert.ok(Number(ms) < 2000, 'within 2 s: ' + ms + ' ms');
  const log = runLog(tag);
  assert.ok(log.includes(otherProgramNote(holder.pid) + '\n'), 'run.log says the pid now runs another program; run.log:\n' + log);
  assert.ok(!log.includes(' stopping pid ' + holder.pid + '\n'), 'no stop was tried on that pid; run.log:\n' + log);
  assert.match(r.out, /^ALIVE false$/m, 'alive() does not take the other program for the app');
  const wait = r.out.match(/^WAIT (\S+) after (\d+) ms$/m) || [];
  assert.ok(wait[1] === 'returned' && Number(wait[2]) < 1000, 'a wait for the app to end ends at once: ' + wait[0]);
  assert.match(r.out, /^SIGNALS none$/m, 'the other program got no signal');
  assert.match(r.out, /^STILL RUNS true$/m, 'and still runs');
};
test('an app whose child has ended while another program holds its pid is neither waited on nor signalled: stopCurrentApp returns within 2 s, a wait for the app ends at once, the other program gets no signal and still runs, and run.log says the pid now runs another program (round 12, the reused pid)', async () => {
  const r = await runCase('pid-reused-child', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [holder] = holdersOf(r);
    assert.ok(holder && holder.kind === 'HOLDER', 'the pid holder started; the child\'s output:\n' + r.out);
    neitherWaitedOnNorSignalled(r, 'pid-reused-child', holder);
  } finally {
    endHolders(r);
  }
});
test('the same for a copy recorded through LaunchServices, as app.mjs and release.mjs record one: a pid that now runs another program than the copy\'s executable is neither waited on nor signalled (round 12, the reused pid)', async () => {
  const r = await runCase('pid-reused-copy', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [holder] = holdersOf(r);
    assert.ok(holder && holder.kind === 'HOLDER', 'the pid holder started; the child\'s output:\n' + r.out);
    neitherWaitedOnNorSignalled(r, 'pid-reused-copy', holder);
  } finally {
    endHolders(r);
  }
});
// PO-R12-1 (round 13): the Product Owner's PO4-EXE-SUFFIX, a copy taken to
// be any program whose path ends in /plain-sight, passed every case: no pid
// holder was another Plain Sight, such as the person's own app in
// /Applications or another test copy, which must never be taken for the
// run's copy and signalled.
test('another Plain Sight holding a recorded copy\'s pid (a program at another bundle\'s .../Contents/MacOS/plain-sight) is neither waited on nor signalled: stopCurrentApp returns within 2 s, the holder gets no signal and still runs, and run.log says the pid now runs another program (PO-R12-1)', async () => {
  const r = await runCase('pid-reused-other-copy', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [holder] = holdersOf(r);
    assert.ok(holder && holder.kind === 'OTHER', 'the other Plain Sight started; the child\'s output:\n' + r.out);
    neitherWaitedOnNorSignalled(r, 'pid-reused-other-copy', holder);
  } finally {
    endHolders(r);
  }
});
// QA-G-49 (round 13): QA-01's breaks of the comparison, a copy taken to be
// any program whose path ends in /plain-sight (its P1, the Product Owner's
// PO4-EXE-SUFFIX), starts with the copy's executable (P2) or contains it
// (P3), each need a holder whose program is not the copy's but shares part
// of its path; the case above is P1's first.
for (const [id, what] of [
  ['pid-reused-helper', 'a helper beside the copy\'s executable (.../Contents/MacOS/plain-sight-helper, a path that starts with the copy\'s)'],
  ['pid-reused-bak', 'a bundle named as the copy\'s with .bak after it (.../Plain Sight test copy.app.bak/Contents/MacOS/plain-sight)'],
  ['pid-reused-nested', 'the copy\'s whole executable path again under another folder (a path that ends with the copy\'s)']
]) {
  test('a recorded copy\'s pid held by ' + what + ' is neither waited on nor signalled, and run.log says the pid now runs another program (QA-G-49)', async () => {
    const r = await runCase(id, undefined, { watchdog: 40000 });
    try {
      ended(r, 0);
      const [holder] = holdersOf(r);
      assert.ok(holder && holder.kind === 'OTHER', 'the holder started; the child\'s output:\n' + r.out);
      neitherWaitedOnNorSignalled(r, id, holder);
    } finally {
      endHolders(r);
    }
  });
}
// DM-259 and QA-G-48 (round 13): the restore check asked ps about a recorded
// copy outside any try, so a ps that failed ended the run with exit code 1,
// a stack, no restore line, no summary and the lock left behind (the data
// was back). A failure now names the pid and counts as not as it was.
test('a ps that fails while the restore check asks about a recorded copy is a reported outcome: the pid named "(could not be checked: ps failed: ...)", exit code 6, the summary printed and the lock released (DM-259, QA-G-48)', async () => {
  const r = await runCase('run-ps-broken', undefined, { watchdog: 40000 });
  ended(r, 6);
  const bundle = path.join(ROOT, 'run-ps-broken', 'copy', 'Plain Sight test copy.app');
  assert.ok(r.out.split('\n').includes('restore check: could not tell whether an app this run launched still runs: pid 7001 (' + bundle + '; could not be checked: ps failed: fork: Resource temporarily unavailable)'), 'the pid is named with the reason; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /as they were \(names/, 'no clean line');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m, 'the summary is printed');
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(r.lock, false, 'the lock is released');
  clean(r);
});
// QA-G-48 (round 13): QA-01 asked for the whole restore check inside a
// try/catch and the lock's release in a finally. Once ps's own failure is
// caught, nothing a fake home can make throws in the check, so a stand-in
// check that throws stands for any other fault. Two tests read the same case:
// the first holds the catch; the second holds the finally on its own, since
// with the catch removed only the finally releases the lock.
test('a restore check that fails for any reason is a reported outcome: "restore check: could not finish, ..." with the reason, exit code 6, the summary printed and the lock released (QA-G-48)', async () => {
  const r = await runCase('run-check-fails', undefined, { watchdog: 40000 });
  ended(r, 6);
  assert.ok(r.out.split('\n').includes('restore check: could not finish, so the app\'s data is not known to be back as it was: a stand-in restore check that fails'), 'the failure is named with its reason; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /as they were \(names/, 'no clean line');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m, 'the summary is printed');
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(r.lock, false, 'the lock is released');
  clean(r);
});
test('the run\'s lock is released in a finally: after a restore check that fails, no lock is left, whether or not the failure is caught on the way (QA-G-48)', async () => {
  const r = await runCase('run-check-fails', undefined, { watchdog: 40000 });
  assert.equal(r.lock, false, 'the lock is released; the child\'s output:\n' + r.out);
});
// Round 13 item 4 (the Product Owner's decision of 28 October on DISH I-21):
// the release and real-key suites' after() ended every pgrep -f match of a
// bundle's executable, recorded or not, so a bystander whose arguments merely
// held that path would have been asked to quit and, 5 s later, killed. Both
// now hand their bundles to the harness's endCopies, which takes a process
// for a copy only when ps names the bundle's executable as its program.
test('the suites\' end (endCopies) ends a copy the run never recorded, whose program is the bundle\'s executable, and never touches a bystander whose arguments merely hold that path (round 13, item 4; DISH I-21)', async () => {
  const r = await runCase('end-copies', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const holders = holdersOf(r);
    const copy = holders.find((x) => x.kind === 'COPY');
    const bystander = holders.find((x) => x.kind === 'BYSTANDER');
    assert.ok(copy && bystander, 'both started; the child\'s output:\n' + r.out);
    assert.ok(r.out.includes('COPIES ' + JSON.stringify([copy.pid]) + ' of '), 'copiesOf finds the copy alone; the child\'s output:\n' + r.out);
    assert.match(r.out, new RegExp('^QUIT ASKED \\[' + copy.pid + '\\] in \\d+ ms$', 'm'), 'only the copy is asked to quit');
    assert.match(r.out, /^COPY AFTER \{"signals":"","stillRuns":false\}$/m, 'the copy was ended (by the SIGKILL, which it cannot record)');
    assert.match(r.out, /^BYSTANDER AFTER \{"signals":"","stillRuns":true\}$/m, 'the bystander got no signal and still runs');
  } finally {
    endHolders(r);
  }
});
// Round 13 item 2 (Developer N's round 12 observation): pgrep -f, which
// finds the copies, matches a path anywhere in the arguments, while the rule
// compared ps's name with the recorded path exactly, so a copy recorded
// through a linked folder would have been taken for another program.
test('a copy recorded through a linked folder, whose process runs from the real folder, is still the copy: alive, stopped by its SIGTERM, and never noted as another program (round 13, item 2)', async () => {
  const r = await runCase('copy-through-link', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [copy] = holdersOf(r);
    assert.ok(copy && copy.kind === 'COPY', 'the copy started; the child\'s output:\n' + r.out);
    assert.match(r.out, /^ALIVE true$/m, 'alive() takes it for the copy; the child\'s output:\n' + r.out);
    const [how, ms] = stopCurrentLine(r);
    assert.equal(how, 'returned', 'stopCurrentApp returned');
    assert.ok(Number(ms) < 3000, 'within 3 s: ' + ms + ' ms');
    assert.match(r.out, /^SIGNALS SIGTERM$/m, 'the copy got one SIGTERM');
    assert.match(r.out, /^STILL RUNS false$/m, 'and ended');
    assert.ok(!runLog('copy-through-link').includes(otherProgramNote(copy.pid)), 'it was never taken for another program');
  } finally {
    endHolders(r);
  }
});
test('a copy recorded through LaunchServices that still runs the copy\'s executable is stopped by its pid: stopCurrentApp sends it SIGTERM, it ends, and stopCurrentApp returns (round 12, the reused pid; the rule\'s other side)', async () => {
  const r = await runCase('copy-stopped', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [copy] = holdersOf(r);
    assert.ok(copy && copy.kind === 'COPY', 'the copy started; the child\'s output:\n' + r.out);
    const [how, ms] = stopCurrentLine(r);
    assert.equal(how, 'returned', 'stopCurrentApp returned; the child\'s output:\n' + r.out);
    assert.ok(Number(ms) < 3000, 'within 3 s: ' + ms + ' ms');
    assert.match(r.out, /^SIGNALS SIGTERM$/m, 'the copy got one SIGTERM');
    assert.match(r.out, /^STILL RUNS false$/m, 'and ended');
    const log = runLog('copy-stopped');
    assert.ok(log.includes(' stopping pid ' + copy.pid + '\n'), 'stopApp noted the stop; run.log:\n' + log);
    assert.ok(!log.includes(otherProgramNote(copy.pid)), 'the copy was never taken for another program; run.log:\n' + log);
  } finally {
    endHolders(r);
  }
});
// ps's answers, from the child's stand-in for ps: an ending copy was taken
// for another program at first (614610b; the copy-stopped case's control in
// round 12's break B2).
test('a recorded copy\'s pid counts as the copy only while ps names the copy\'s executable: a process ending (the flag E, its short name only) or ended (the state Z) counts as ended, not as another program, and only another program is noted (round 12, the reused pid)', async () => {
  const r = await runCase('ps-states');
  ended(r, 0);
  assert.deepEqual(r.out.split('\n').filter((l) => l.startsWith('ALIVE ')), ['ALIVE 7001 true', 'ALIVE 7002 false', 'ALIVE 7003 false', 'ALIVE 7004 false', 'ALIVE 7005 false'], 'the child\'s output:\n' + r.out);
  const log = runLog('ps-states');
  assert.deepEqual(log.split('\n').filter((l) => l.includes(' now runs another program')).map((l) => l.slice(25)), ['pid 7004 now runs another program: not stopped'], 'only the other program is noted; run.log:\n' + log);
});
const checkedLine = /^restore check: \d+ folders as they were \(names, sizes and times; checked twice, [\d.]+ s apart\)$/m;
test('the restore check does not name a recorded copy whose pid another program holds at the run\'s end as still running: exit code 0, the clean line, and run.log says the pid now runs another program (round 12; QA-01\'s observation 9)', async () => {
  const r = await runCase('run-copy-pid-reused', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [holder] = holdersOf(r);
    assert.ok(holder, 'the pid holder started; the child\'s output:\n' + r.out);
    assert.match(r.out, checkedLine, 'the clean line; the child\'s output:\n' + r.out);
    assert.doesNotMatch(r.out, /still running, though this run launched it/, 'no app named as still running');
    assert.match(r.out, /^Exit code: 0$/m);
    assert.ok(runLog('run-copy-pid-reused').includes(otherProgramNote(holder.pid) + '\n'), 'run.log says the pid now runs another program');
    assert.ok(isAlive(holder.pid), 'the other program still runs');
    clean(r);
  } finally {
    endHolders(r);
  }
});
test('a recorded copy that still runs the copy\'s executable at the run\'s end is named by its pid: exit code 6 (round 12; the rule\'s other side)', async () => {
  const r = await runCase('run-copy-left-running', undefined, { watchdog: 40000 });
  try {
    ended(r, 6);
    const [copy] = holdersOf(r);
    assert.ok(copy && copy.kind === 'COPY', 'the copy started; the child\'s output:\n' + r.out);
    const bundle = path.join(ROOT, 'run-copy-left-running', 'copy', 'Plain Sight test copy.app');
    assert.ok(r.out.split('\n').includes('restore check: still running, though this run launched it: pid ' + copy.pid + ' (' + bundle + ')'), 'it is named; the child\'s output:\n' + r.out);
    assert.match(r.out, /^Exit code: 6$/m);
    clean(r);
  } finally {
    endHolders(r);
  }
});
test('the listing never opens a file: a file of the person\'s that no one may read (mode 000) leaves the check clean, and listData reads names, kinds, sizes and times only (DM-249)', async () => {
  const r = await runCase('run-restore-unreadable', undefined, { recheck: null });
  ended(r, 0);
  assert.match(r.out, restoredLine(r.dirs.length), 'the check is clean; the child\'s output:\n' + r.out);
  const src = readFileSync(HARNESS, 'utf8');
  const start = src.indexOf('export function listData(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(start >= 0 && body.includes('lstatSync(p, { bigint: true })') && body.includes('readdirSync(p)'), 'listData lists with lstat and readdir');
  assert.equal(/readFile|openSync|createReadStream|readSync|\bopen\(|\bfs\./.test(body), false, 'and calls nothing that opens a file');
  clean(r);
});

// QA-G-44 (QA-01's section 20). N6: stopApp() without its SIGKILL fallback
// passed every suite; stopCurrentApp loops on it, so an app that ignores
// SIGTERM or freezes would hold the cleanup, and the person's data with it,
// forever. QA-01's L5 cases, adopted, each bounded by a 40 s watchdog so a
// regression fails instead of hanging the suite.
test('an app that ignores SIGTERM, or freezes on it, is ended by stopApp\'s SIGKILL after its 8 s wait: the cleanup ends inside 12 s, the relaunch is refused, exit code 130, no app left, the data back, the lock released (QA-G-44; QA-01\'s L5)', async () => {
  const runs = await Promise.all(['ignore', 'frozen'].map(async (mode) => {
    let sent = false;
    const r = await runCase('run-unkillable-' + mode, (out, child) => { if (!sent && out.includes('IN TEST')) { sent = true; setTimeout(() => child.kill('SIGINT'), 300); } }, { watchdog: 40000 });
    return { mode, sent, r, s: await standinsAfter(r) };
  }));
  for (const { mode, sent, r, s } of runs) {
    assert.ok(sent, mode + ': the signal was sent during the test; the child\'s output:\n' + r.out);
    ended(r, 130);
    const took = Number((r.out.match(/^AFTER DONE after (\d+) ms$/m) || [])[1]);
    assert.ok(took >= 7500 && took < 12000, mode + ': after() waited stopApp\'s 8 s and then ended the app: ' + took + ' ms; the child\'s output:\n' + r.out);
    assert.match(r.out, /^REFUSED RunEnding$/m, mode + ': the relaunch during that wait was refused');
    assert.doesNotMatch(r.out, /^RELAUNCHED /m, mode + ': no app was launched again');
    assert.deepEqual(s.running, [], mode + ': no app is left');
    clean(r);
    assert.equal(r.lock, false, mode + ': the lock is released');
  }
});
// N10: a SIGQUIT during the cleanup obeyed at once passed every suite, since
// the SIGQUIT case above sends it only during a test. QA-01's P3.2 with
// SIGQUIT (r9_infra_adv.mjs), adopted: one while after() waits.
test('a SIGQUIT while the run\'s own cleanup waits in after() waits for that cleanup as a SIGINT does: reported by name, after() once with the lock held, the data back, the lock released, exit code 130 (QA-G-44; QA-01\'s P3.2 with SIGQUIT)', async () => {
  let sent = false;
  const t0 = Date.now();
  const r = await runCase('run-signal-during-cleanup', (out, child) => { if (!sent && out.includes('IN AFTER')) { sent = true; child.kill('SIGQUIT'); } }, { tag: 'run-sigquit-during-cleanup' });
  assert.ok(sent, 'the signal was sent while after() waited; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup went on to its end');
  assert.match(r.out, /^release: SIGQUIT came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was$/m, 'the SIGQUIT is reported by name');
  onceWithTheLock(r);
  assert.ok(Date.now() - t0 > 3000, 'the run lived until the cleanup was done (after() holds 3 s)');
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

// QA-G-36 and DISH-G-70: guards of round 7 that no case above holds. Eleven
// of QA-01's harness cases on 534f3cc (wave-g/qa/scripts/app/r7_harness_adv.mjs:
// H4, H5, H6, H7, H8b, H8c, H8d, H13b, H22, H26 and H28, with its
// expectations), the Delivery Manager's AT-H1 to AT-H4
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
  // Any stand-in still running, found by its own script's path in this run's
  // temporary folder, which nothing else runs (DM-249).
  try { childProcess.execFileSync('pkill', ['-9', '-f', STANDIN_APP]); } catch { /* none left */ }
  try { childProcess.execFileSync('pkill', ['-9', '-f', LATE_WRITER]); } catch { /* none left */ }
  try { childProcess.execFileSync('pkill', ['-9', '-f', HOLDER]); } catch { /* none left */ }
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
