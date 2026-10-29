// Tests of the App Store configuration command (tools/appstore-config.mjs,
// APPSTORE.md step 6), with a fake team id and a fake profile in a temporary
// folder of this test's own. Every run of the command writes only into a
// temporary --out folder, never into the repository, and the last test checks
// that src-tauri/ is as it was before the suite. The property list is read
// back with plutil -convert json. Nothing is signed or built.
//
// Run from the repository root: node desktop/tests/appstore-config-tests.mjs

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLICATION_IDENTIFIER, CONFIG_NAME, ENTITLEMENTS_NAME, REPOSITORY, Refusal, TAURI, TEAM_IDENTIFIER, failureLine, parseArgs, plan, write } from '../tools/appstore-config.mjs';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(DESKTOP, 'tools', 'appstore-config.mjs');
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'plain-sight-appstore-config-'));
const TEAM = 'ABCDE12345';
const IDENTITY = 'Apple Distribution: Test Person (' + TEAM + ')';
const PROFILES = path.join(ROOT, 'profiles');
const PROFILE = path.join(PROFILES, 'Plain Sight App Store.provisionprofile');
mkdirSync(PROFILES, { recursive: true });
writeFileSync(PROFILE, 'a stand-in for the profile from step 4; the command never reads it\n');
const plistOf = (file) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
const everyday = plistOf(path.join(TAURI, 'Entitlements.plist'));
const conf = JSON.parse(readFileSync(path.join(TAURI, 'tauri.conf.json'), 'utf8'));
// src-tauri/ as it is before any run: each name, and each file's sha256.
const tauriState = () => readdirSync(TAURI).sort().map((name) => {
  const p = path.join(TAURI, name);
  return name + (lstatSync(p).isFile() ? ' ' + createHash('sha256').update(readFileSync(p)).digest('hex') : ' (not a file)');
});
const TAURI_BEFORE = tauriState();

let outs = 0;
const freshOut = () => { outs += 1; const out = path.join(ROOT, 'out-' + outs); mkdirSync(out); return out; };
const listing = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : null);
// Every run gives --build, which the command requires (DM-252): 1 unless a
// case names another number, or none when the case omits it.
const args = ({ team = TEAM, identity = IDENTITY, profile = PROFILE, out, build = '1', extra = [], omit = null }) => {
  const a = [];
  if (omit !== 'team') a.push('--team', team);
  if (omit !== 'identity') a.push('--identity', identity);
  if (omit !== 'profile') a.push('--profile', profile);
  a.push('--out', out);
  if (omit !== 'build') a.push('--build', build);
  return [...a, ...extra];
};
const run = (argv) => spawnSync(process.execPath, [TOOL, ...argv], { encoding: 'utf8', cwd: ROOT });
// One refusal: exit code 1, one plain line naming the reason, nothing written.
function refusedRun(label, options, reason) {
  const out = options.out ?? freshOut();   // an empty --out is a case of its own
  const before = listing(out);
  const r = run(args({ ...options, out }));
  assert.equal(r.status, 1, label + ': exit code 1; output: ' + r.stdout + r.stderr);
  assert.equal(r.stderr, '', label + ': nothing on stderr');
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, label + ': one line: ' + r.stdout);
  assert.match(lines[0], /^appstore-config: not written: .*\. Errors: 1$/, label + ': a plain refusal: ' + lines[0]);
  assert.match(lines[0], reason, label + ': it names the reason: ' + lines[0]);
  assert.deepEqual(listing(out), before, label + ': nothing was written');
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the command writes tauri.appstore.conf.json as APPSTORE.md step 6 shows it: the identity, the everyday minimum macOS (12.0), the App Store entitlements file, the profile under its absolute path and the build number', () => {
  const out = freshOut();
  const r = run(args({ out }));
  assert.equal(r.status, 0, 'exit code 0; output: ' + r.stdout + r.stderr);
  assert.deepEqual(listing(out), [CONFIG_NAME, ENTITLEMENTS_NAME].sort(), 'exactly the two files');
  assert.equal(readFileSync(path.join(out, CONFIG_NAME), 'utf8'), '{\n  "bundle": {\n    "macOS": {\n      "signingIdentity": "Apple Distribution: Test Person (ABCDE12345)",\n      "minimumSystemVersion": "12.0",\n      "entitlements": "./Entitlements.appstore.plist",\n      "files": {\n        "embedded.provisionprofile": ' + JSON.stringify(PROFILE) + '\n      },\n      "bundleVersion": "1"\n    }\n  }\n}\n');
  assert.equal(conf.bundle.macOS.minimumSystemVersion, '12.0', 'the everyday minimum, which the store build repeats');
  // The block in APPSTORE.md step 6: the same keys in the same order, and the same fixed values.
  const doc = readFileSync(path.join(DESKTOP, 'APPSTORE.md'), 'utf8');
  const block = doc.match(/\n   ```json\n([\s\S]*?)\n   ```\n/);
  assert.ok(block, 'APPSTORE.md shows the file in step 6');
  const shown = JSON.parse(block[1]).bundle.macOS;
  const written = JSON.parse(readFileSync(path.join(out, CONFIG_NAME), 'utf8')).bundle.macOS;
  assert.deepEqual(Object.keys(written), Object.keys(shown), 'the keys APPSTORE.md shows, in its order');
  assert.deepEqual(Object.keys(written.files), Object.keys(shown.files));
  assert.deepEqual([written.minimumSystemVersion, written.entitlements], [shown.minimumSystemVersion, shown.entitlements]);
  assert.equal(path.isAbsolute(written.files['embedded.provisionprofile']), true, 'the profile under its absolute path');
  assert.deepEqual(r.stdout.split('\n').filter((l) => l.startsWith('written: ')), ['written: ' + path.join(out, CONFIG_NAME), 'written: ' + path.join(out, ENTITLEMENTS_NAME)]);
});

test('the command writes Entitlements.appstore.plist as an XML property list that plutil reads back: every entitlement of Entitlements.plist (four, the network client among them), plus com.apple.application-identifier (<team>.<identifier of tauri.conf.json>) and com.apple.developer.team-identifier (<team>), six in all and nothing else', () => {
  const out = freshOut();
  assert.equal(run(args({ out })).status, 0);
  const file = path.join(out, ENTITLEMENTS_NAME);
  execFileSync('plutil', ['-lint', file], { stdio: 'ignore' });
  assert.ok(readFileSync(file, 'utf8').startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'), 'an XML property list');
  const read = plistOf(file);
  assert.deepEqual(read, { ...everyday, [APPLICATION_IDENTIFIER]: TEAM + '.' + conf.identifier, [TEAM_IDENTIFIER]: TEAM });
  assert.equal(read['com.apple.application-identifier'], 'ABCDE12345.com.pranavongole.plainsight');
  assert.equal(read['com.apple.developer.team-identifier'], 'ABCDE12345');
  assert.deepEqual(Object.keys(read).sort(), [...Object.keys(everyday), 'com.apple.application-identifier', 'com.apple.developer.team-identifier'].sort(), 'the keys of Entitlements.plist plus the two');
  assert.equal(Object.keys(read).length, Object.keys(everyday).length + 2);
  assert.equal(read['com.apple.security.network.client'], true, 'the network client carries over');
  assert.equal(Object.keys(read).length, 6, 'six in all, as APPSTORE.md steps 6 and 9 say: the four of Entitlements.plist and the two');
});

test('the entitlements are read from Entitlements.plist each time, so one added there later (a stand-in, com.apple.security.print, which the app does not carry) carries over, and the identifier and the minimum macOS come from tauri.conf.json', () => {
  const inputs = path.join(ROOT, 'inputs');
  mkdirSync(inputs);
  const entitlementsFile = path.join(inputs, 'Entitlements.plist');
  assert.equal(everyday['com.apple.security.print'], undefined, 'the stand-in is not one of the app\'s own');
  execFileSync('plutil', ['-convert', 'xml1', '-o', entitlementsFile, '-'], { input: JSON.stringify({ ...everyday, 'com.apple.security.print': true }) });
  const tauriConfFile = path.join(inputs, 'tauri.conf.json');
  writeFileSync(tauriConfFile, JSON.stringify({ identifier: 'com.example.later', bundle: { macOS: { minimumSystemVersion: '13.0' } } }));
  const out = freshOut();
  write(plan(parseArgs(args({ out }), { cwd: ROOT }), { entitlementsFile, tauriConfFile }));
  const read = plistOf(path.join(out, ENTITLEMENTS_NAME));
  assert.deepEqual(read, { ...everyday, 'com.apple.security.print': true, [APPLICATION_IDENTIFIER]: TEAM + '.com.example.later', [TEAM_IDENTIFIER]: TEAM });
  assert.equal(JSON.parse(readFileSync(path.join(out, CONFIG_NAME), 'utf8')).bundle.macOS.minimumSystemVersion, '13.0');
});

test('--build sets bundle.macOS.bundleVersion to the number given', () => {
  const out = freshOut();
  const r = run(args({ out, build: '7' }));
  assert.equal(r.status, 0, 'output: ' + r.stdout + r.stderr);
  const macOS = JSON.parse(readFileSync(path.join(out, CONFIG_NAME), 'utf8')).bundle.macOS;
  assert.equal(macOS.bundleVersion, '7');
  assert.deepEqual(Object.keys(macOS), ['signingIdentity', 'minimumSystemVersion', 'entitlements', 'files', 'bundleVersion']);
});

test('with no --out the files go into src-tauri/, next to tauri.conf.json (read from the arguments; nothing is written)', () => {
  assert.equal(parseArgs(['--team', TEAM, '--identity', IDENTITY, '--profile', PROFILE, '--build', '1']).out, path.join(DESKTOP, 'src-tauri'));
  assert.equal(TAURI, path.join(DESKTOP, 'src-tauri'));
});

test('a team id that is not ten upper-case letters or digits is refused, and nothing is written', () => {
  const reason = /the team id must be ten upper-case letters or digits/;
  refusedRun('nine characters', { team: 'ABCDE1234', identity: 'Apple Distribution: Test Person (ABCDE1234)' }, reason);
  refusedRun('eleven characters', { team: 'ABCDE123456', identity: 'Apple Distribution: Test Person (ABCDE123456)' }, reason);
  refusedRun('lower-case letters', { team: 'abcde12345', identity: 'Apple Distribution: Test Person (abcde12345)' }, reason);
  refusedRun('a dash', { team: 'ABCDE-1234', identity: 'Apple Distribution: Test Person (ABCDE-1234)' }, reason);
  refusedRun('no team id', { omit: 'team' }, /--team is missing/);
});

test('an identity that is not "Apple Distribution: <name> (<TEAMID>)" is refused, and nothing is written', () => {
  refusedRun('a Developer ID identity', { identity: 'Developer ID Application: Test Person (ABCDE12345)' }, /the identity must start with "Apple Distribution: "/);
  refusedRun('another team\'s identity', { identity: 'Apple Distribution: Test Person (ZYXWV98765)' }, /the identity must end with " \(ABCDE12345\)"/);
  refusedRun('no team in the identity', { identity: 'Apple Distribution: Test Person' }, /the identity must end with " \(ABCDE12345\)"/);
  refusedRun('no name in the identity', { identity: 'Apple Distribution:  (ABCDE12345)' }, /the identity names no one/);
  refusedRun('a line break in the identity', { identity: 'Apple Distribution: Test\nPerson (ABCDE12345)' }, /the identity holds a control character/);
});

test('a profile that does not end in .provisionprofile, lies inside the repository, does not exist or is not a file is refused, and nothing is written', () => {
  const mobile = path.join(PROFILES, 'Plain Sight App Store.mobileprovision');
  writeFileSync(mobile, 'not the right kind of file\n');
  refusedRun('another extension', { profile: mobile }, /the profile must be the \.provisionprofile file downloaded in step 4/);
  const inRepository = path.join(REPOSITORY, 'desktop', 'Plain Sight App Store.provisionprofile');
  refusedRun('a profile inside the repository', { profile: inRepository }, /the profile lies inside the repository/);
  assert.equal(existsSync(inRepository), false, 'and no file was made there');
  const linkIn = path.join(PROFILES, 'linked.provisionprofile');
  symlinkSync(path.join(REPOSITORY, 'README.md'), linkIn);
  refusedRun('a link outside that leads inside the repository', { profile: linkIn }, /the profile lies inside the repository/);
  refusedRun('a profile that does not exist', { profile: path.join(PROFILES, 'missing.provisionprofile') }, /there is no profile at /);
  const folder = path.join(PROFILES, 'folder.provisionprofile');
  mkdirSync(folder);
  refusedRun('a folder', { profile: folder }, /the profile is not a file/);
});

test('a build number that is not a whole number from 1, an output folder that does not exist, and arguments the command does not take are refused, and nothing is written', () => {
  refusedRun('a build number with a dot', { build: '1.2' }, /the build number must be a whole number from 1/);
  refusedRun('a build number of 0', { build: '0' }, /the build number must be a whole number from 1/);
  const missing = path.join(ROOT, 'no-such-folder');
  refusedRun('an output folder that does not exist', { out: missing }, /there is no folder at /);
  assert.equal(existsSync(missing), false, 'and it was not made');
  refusedRun('an unknown argument', { extra: ['--teamid', TEAM] }, /unknown argument "--teamid"/);
  refusedRun('the team given twice', { extra: ['--team', TEAM] }, /--team is given twice/);
  refusedRun('an argument with no value', { omit: 'build', extra: ['--build'] }, /--build needs a value/);
});

// DM-252: with no --build, a first store build carried CFBundleVersion 1.0.0,
// which Tauri takes from the version (Tauri's App Store guide, Build and
// upload), and Apple reads "1" as 1.0.0 (CFBundleVersion: "missing integers
// in the format are interpreted as zeros"), so APPSTORE.md's "for example 1,
// then 2" gave the first re-upload the first upload's build again. The
// command now takes no build without a number, and plan() refuses one that a
// caller did not give.
test('a run without --build is refused and writes nothing: the refusal says to give --build 1 for the first store build and a higher number for every later upload; plan() refuses a missing build number as well (DM-252)', () => {
  refusedRun('no --build', { omit: 'build' }, /^appstore-config: not written: --build is missing: give --build 1 for the first store build and a higher number for every later upload /);
  const out = freshOut();
  for (const build of [null, undefined]) {
    assert.throws(() => write(plan({ ...parseArgs(args({ out }), { cwd: ROOT }), build })), (err) => err instanceof Refusal && /^the build number must be a whole number from 1, such as 1 or 2: /.test(err.message), 'plan() refuses a build number of ' + build);
  }
  assert.deepEqual(listing(out), [], 'nothing was written');
});

test('output files that exist already are refused and kept as they were unless --force replaces them, and an output that is a link or a folder is refused even with --force', () => {
  const out = freshOut();
  writeFileSync(path.join(out, CONFIG_NAME), 'EARLIER\n');
  refusedRun('the configuration there already', { out }, /tauri\.appstore\.conf\.json exists already; pass --force to replace it/);
  assert.equal(readFileSync(path.join(out, CONFIG_NAME), 'utf8'), 'EARLIER\n', 'kept as it was');
  const other = freshOut();
  writeFileSync(path.join(other, ENTITLEMENTS_NAME), 'EARLIER\n');
  refusedRun('the entitlements there already', { out: other }, /Entitlements\.appstore\.plist exists already; pass --force to replace it/);
  const forced = run(args({ out, extra: ['--force'] }));
  assert.equal(forced.status, 0, '--force replaces it: ' + forced.stdout + forced.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(out, CONFIG_NAME), 'utf8')).bundle.macOS.signingIdentity, IDENTITY);
  assert.deepEqual(listing(out), [CONFIG_NAME, ENTITLEMENTS_NAME].sort(), 'and no temporary file is left');
  const linked = freshOut();
  const elsewhere = path.join(ROOT, 'elsewhere.json');
  writeFileSync(elsewhere, 'ELSEWHERE\n');
  symlinkSync(elsewhere, path.join(linked, CONFIG_NAME));
  refusedRun('a link at the output', { out: linked, extra: ['--force'] }, /is there and is no plain file \(a link or a folder\); remove it first/);
  assert.equal(readFileSync(elsewhere, 'utf8'), 'ELSEWHERE\n', 'what the link leads to is untouched');
  const foldered = freshOut();
  mkdirSync(path.join(foldered, ENTITLEMENTS_NAME));
  refusedRun('a folder at the output', { out: foldered, extra: ['--force'] }, /is there and is no plain file/);
});

test('a write that the disk refuses ends with exit code 1 and a plain message, and leaves no file and no temporary file', () => {
  const out = freshOut();
  chmodSync(out, 0o500);
  try {
    const r = run(args({ out }));
    assert.equal(r.status, 1, 'exit code 1: ' + r.stdout + r.stderr);
    assert.match(r.stdout.trim(), /^appstore-config: failed: EACCES: .*\. Errors: 1$/, 'a plain message: ' + r.stdout);
    assert.deepEqual(listing(out), [], 'nothing is left');
  } finally {
    chmodSync(out, 0o755);
  }
});

// DM-253 (the Delivery Manager's delta of a92087a; DISH confirmed it; QA-01's
// QA-G-42): write() renamed the two temporary files one after the other, so
// when the second rename failed the new configuration was already in place
// beside the earlier entitlements, against the comment that a failed write
// leaves neither half done. A store build from that pair would take one run's
// identity and profile with another run's entitlements.
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const earlierPair = (out) => {
  const config = path.join(out, CONFIG_NAME);
  const entitlements = path.join(out, ENTITLEMENTS_NAME);
  writeFileSync(config, 'EARLIER CONFIG\n');
  writeFileSync(entitlements, 'EARLIER ENTITLEMENTS\n');
  chmodSync(config, 0o600);
  const then = new Date('2026-10-01T12:00:00Z');
  utimesSync(config, then, then);
  return { config, entitlements };
};
const fileFacts = (file) => { const s = statSync(file); return { ino: s.ino, mode: s.mode, size: s.size, mtimeMs: s.mtimeMs, text: readFileSync(file, 'utf8') }; };
// A rename that macOS refuses on the calls named (EPERM, as it refused the
// Delivery Manager's S10); every other call is the real one.
const renameFailing = (...failing) => {
  let calls = 0;
  return (from, to) => {
    calls += 1;
    if (failing.includes(calls)) throw Object.assign(new Error("EPERM: operation not permitted, rename '" + from + "' -> '" + to + "'"), { code: 'EPERM' });
    return renameSync(from, to);
  };
};
const refusedRename = (target) => "EPERM: operation not permitted, rename '" + target + '.tmp-' + process.pid + "' -> '" + target + "'";
test('when the second rename fails, write() puts the first file back as it was (the earlier file --force was replacing, the same file with its mode, size and time, or no file when there was none), removes its temporary files and refuses, saying what is back (DM-253)', () => {
  const out = freshOut();
  const { config, entitlements } = earlierPair(out);
  const before = fileFacts(config);
  const planned = plan(parseArgs(args({ out, extra: ['--force'] }), { cwd: ROOT }));
  let err = null;
  try { write(planned, { rename: renameFailing(2) }); } catch (e) { err = e; }
  assert.ok(err instanceof Refusal, 'a refusal: ' + (err && err.stack));
  assert.equal(err.message, 'could not put ' + entitlements + ' in place (' + refusedRename(entitlements) + '); ' + config + ' is back as it was');
  assert.deepEqual(fileFacts(config), before, 'the earlier configuration is back: the same file, with its mode, size, time and text');
  assert.equal(readFileSync(entitlements, 'utf8'), 'EARLIER ENTITLEMENTS\n', 'the earlier entitlements were never replaced');
  assert.deepEqual(listing(out), [CONFIG_NAME, ENTITLEMENTS_NAME].sort(), 'no temporary file and no kept copy is left');
  const none = freshOut();
  const fresh = plan(parseArgs(args({ out: none }), { cwd: ROOT }));
  err = null;
  try { write(fresh, { rename: renameFailing(2) }); } catch (e) { err = e; }
  assert.ok(err instanceof Refusal, 'a refusal: ' + (err && err.stack));
  assert.equal(err.message, 'could not put ' + path.join(none, ENTITLEMENTS_NAME) + ' in place (' + refusedRename(path.join(none, ENTITLEMENTS_NAME)) + '); ' + path.join(none, CONFIG_NAME) + ' was removed again');
  assert.deepEqual(listing(none), [], 'with no earlier file, nothing is left');
});

// The Delivery Manager's S10 and QA-01's C8.1 (wave-g/qa/scripts/app/
// r9_config_adv.mjs), adopted with the answer the fix sets: an earlier pair
// of another team, whose Entitlements.appstore.plist macOS will not let the
// command replace (chflags uchg), so every check passes (both are plain files
// and --force is given) and the second rename is refused.
test('a run with --force over an earlier pair whose entitlements macOS will not let it replace (chflags uchg) refuses with exit 1 and one plain line, and both earlier files are as they were, with no temporary file (DM-253; the Delivery Manager\'s S10, QA-01\'s C8.1, QA-G-42)', () => {
  const out = freshOut();
  assert.equal(run(args({ out })).status, 0, 'an earlier pair');
  const config = path.join(out, CONFIG_NAME);
  const entitlements = path.join(out, ENTITLEMENTS_NAME);
  const before = [readFileSync(config, 'utf8'), readFileSync(entitlements, 'utf8')];
  execFileSync('chflags', ['uchg', entitlements]);
  let r;
  try {
    r = run(args({ out, team: 'ZYXWV98765', identity: 'Apple Distribution: Other Person (ZYXWV98765)', build: '9', extra: ['--force'] }));
  } finally {
    execFileSync('chflags', ['nouchg', entitlements]);
  }
  assert.equal(r.status, 1, 'exit code 1: ' + r.stdout + r.stderr);
  assert.equal(r.stderr, '', 'nothing on stderr');
  assert.match(r.stdout, new RegExp('^appstore-config: not written: could not put ' + esc(entitlements) + ' in place \\(EPERM: operation not permitted, rename \'' + esc(entitlements) + '\\.tmp-\\d+\' -> \'' + esc(entitlements) + '\'\\); ' + esc(config) + ' is back as it was\\. Errors: 1\\n$'), 'one plain line that says the configuration is back: ' + r.stdout);
  assert.deepEqual([readFileSync(config, 'utf8'), readFileSync(entitlements, 'utf8')], before, 'neither earlier file changed');
  assert.deepEqual(listing(out), [CONFIG_NAME, ENTITLEMENTS_NAME].sort(), 'no temporary file and no kept copy is left');
});

// DISH's repro (dish_r9_delta/write_probe): write() handed a second target
// that has become a non-empty folder, which no rename can replace.
test('a second target that has become a non-empty folder: write() refuses, the first file is back as it was and the folder is untouched (DM-253, DISH\'s repro)', () => {
  const out = freshOut();
  const config = path.join(out, CONFIG_NAME);
  writeFileSync(config, 'OLD CONFIG\n');
  const folder = path.join(out, ENTITLEMENTS_NAME);
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'keep'), 'x');
  let err = null;
  try { write({ files: [[config, 'NEW CONFIG\n'], [folder, 'NEW PLIST\n']] }); } catch (e) { err = e; }
  assert.ok(err instanceof Refusal && err.message.endsWith('; ' + config + ' is back as it was'), 'a refusal that says the configuration is back: ' + (err && err.stack));
  assert.equal(readFileSync(config, 'utf8'), 'OLD CONFIG\n', 'the first file is as it was');
  assert.deepEqual(readdirSync(folder), ['keep'], 'the folder is untouched');
  assert.deepEqual(listing(out), [CONFIG_NAME, ENTITLEMENTS_NAME].sort(), 'no temporary file is left');
});

test('when the first file cannot be put back either, the error says so and where its earlier file waits, and that file is kept there; a new file that cannot be removed again is named (DM-253)', () => {
  const out = freshOut();
  const { config, entitlements } = earlierPair(out);
  const planned = plan(parseArgs(args({ out, extra: ['--force'] }), { cwd: ROOT }));
  const kept = config + '.earlier-' + process.pid;
  let err = null;
  try { write(planned, { rename: renameFailing(2, 3) }); } catch (e) { err = e; }
  assert.ok(err && !(err instanceof Refusal), 'an error, not a refusal, since a file changed: ' + (err && err.stack));
  assert.equal(err.message, 'could not put ' + entitlements + ' in place (' + refusedRename(entitlements) + "), and could not put the earlier " + config + " back (EPERM: operation not permitted, rename '" + kept + "' -> '" + config + "'): it is at " + kept + '; move it back by hand');
  assert.equal(readFileSync(kept, 'utf8'), 'EARLIER CONFIG\n', 'the earlier configuration waits there');
  assert.deepEqual(listing(out), [CONFIG_NAME, ENTITLEMENTS_NAME, path.basename(kept)].sort(), 'no temporary file is left');
  const none = freshOut();
  const fresh = plan(parseArgs(args({ out: none }), { cwd: ROOT }));
  const unlinkRefused = (p) => { throw Object.assign(new Error("EPERM: operation not permitted, unlink '" + p + "'"), { code: 'EPERM' }); };
  err = null;
  try { write(fresh, { rename: renameFailing(2), unlink: unlinkRefused }); } catch (e) { err = e; }
  const made = path.join(none, CONFIG_NAME);
  assert.ok(err && !(err instanceof Refusal), 'an error, not a refusal: ' + (err && err.stack));
  assert.ok(err.message.endsWith(", and could not remove the new " + made + " again (EPERM: operation not permitted, unlink '" + made + "'): remove it by hand"), err.message);
  assert.deepEqual(listing(none), [CONFIG_NAME], 'the new configuration is named and left; no temporary file');
});

// DM-254 (the Delivery Manager's delta of a92087a) and DISH-G-84: nine guards
// of the command that no case held, each broken and every case still green.
// One case each; the Delivery Manager's S9, S11, S10 and S15 and QA-01's C8.2
// for the first four, DISH's N2 to N6 through plan()'s entitlementsFile and
// tauriConfFile options for the other five.
test('a link placed at a temporary name is not followed: write() fails with EEXIST, the file the link leads to is unchanged, and nothing is left (DM-254 SC1; the Delivery Manager\'s S9)', () => {
  const out = freshOut();
  const victim = path.join(ROOT, 'victim.txt');
  writeFileSync(victim, 'VICTIM UNCHANGED\n');
  const planned = plan(parseArgs(args({ out }), { cwd: ROOT }));
  symlinkSync(victim, path.join(out, CONFIG_NAME) + '.tmp-' + process.pid);
  assert.throws(() => write(planned), (err) => err.code === 'EEXIST', 'the temporary file is made anew, never through what is at its name');
  assert.equal(readFileSync(victim, 'utf8'), 'VICTIM UNCHANGED\n', 'the file the link leads to is unchanged');
  assert.deepEqual(listing(out), [], 'the link and every temporary name are gone, and no output file exists');
});

test('a build number with a line break or leading zeros is refused as a whole, and nothing is written; a long whole number is written as given (DM-254 SC2; the Delivery Manager\'s S11)', () => {
  const reason = /the build number must be a whole number from 1, such as 1 or 2: /;
  refusedRun('a line break inside', { build: '7\n8' }, reason);
  refusedRun('a line break at the end', { build: '7\n' }, reason);
  refusedRun('leading zeros', { build: '007' }, reason);
  const out = freshOut();
  const r = run(args({ out, build: '1234567890123456789012345' }));
  assert.equal(r.status, 0, 'output: ' + r.stdout + r.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(out, CONFIG_NAME), 'utf8')).bundle.macOS.bundleVersion, '1234567890123456789012345');
});

// QA-01's C8.2 (r9_config_adv.mjs; its break A4, QA-G-43): the earlier
// configuration immutable (chflags uchg), so the command can neither keep it
// aside nor replace it, and every temporary file must still go.
test('a write that fails once its temporary files exist removes them: nothing changes and no temporary file is left, when the first rename fails and when the earlier configuration cannot be kept aside (DM-254 SC6; the Delivery Manager\'s S10, QA-01\'s C8.2 and its break A4)', () => {
  const out = freshOut();
  const planned = plan(parseArgs(args({ out }), { cwd: ROOT }));
  assert.throws(() => write(planned, { rename: renameFailing(1) }), /^Error: EPERM: operation not permitted, rename /);
  assert.deepEqual(listing(out), [], 'nothing is written and no temporary file is left');
  const pair = freshOut();
  assert.equal(run(args({ out: pair })).status, 0, 'an earlier pair');
  const config = path.join(pair, CONFIG_NAME);
  const before = [readFileSync(config, 'utf8'), readFileSync(path.join(pair, ENTITLEMENTS_NAME), 'utf8')];
  execFileSync('chflags', ['uchg', config]);
  let r;
  try {
    r = run(args({ out: pair, team: 'ZYXWV98765', identity: 'Apple Distribution: Other Person (ZYXWV98765)', extra: ['--force'] }));
  } finally {
    execFileSync('chflags', ['nouchg', config]);
  }
  assert.equal(r.status, 1, 'exit code 1: ' + r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp('^appstore-config: not written: could not keep the earlier ' + esc(config) + ' to put it back should the write fail \\(EPERM: operation not permitted, link .*\\)\\. Errors: 1\\n$'), 'one plain line: ' + r.stdout);
  assert.deepEqual([readFileSync(config, 'utf8'), readFileSync(path.join(pair, ENTITLEMENTS_NAME), 'utf8')], before, 'neither earlier file changed');
  assert.deepEqual(listing(pair), [CONFIG_NAME, ENTITLEMENTS_NAME].sort(), 'no temporary file is left');
});

test('an identity with no space before "(<TEAMID>)" is refused, and nothing is written (DM-254 SC9; the Delivery Manager\'s S15)', () => {
  refusedRun('no space before the team id', { identity: 'Apple Distribution: Test Person(' + TEAM + ')' }, /the identity must end with " \(ABCDE12345\)", a space and the team id given, in brackets: /);
});

// Input files of the command's own, for plan()'s options: an Entitlements.plist
// written by plutil from the value given (an object, or a list), and a
// tauri.conf.json from the value given (an object, a text, or no file).
let inputSets = 0;
function inputFiles({ entitlements = everyday, conf: c = { identifier: 'com.example.app', bundle: { macOS: { minimumSystemVersion: '12.0' } } }, confText } = {}) {
  inputSets += 1;
  const dir = path.join(ROOT, 'input-files-' + inputSets);
  mkdirSync(dir);
  const entitlementsFile = path.join(dir, 'Entitlements.plist');
  execFileSync('plutil', ['-convert', 'xml1', '-o', entitlementsFile, '-'], { input: JSON.stringify(entitlements) });
  const tauriConfFile = path.join(dir, 'tauri.conf.json');
  if (confText !== null) writeFileSync(tauriConfFile, confText === undefined ? JSON.stringify(c) : confText);
  return { entitlementsFile, tauriConfFile };
}
// One refusal of plan(): a Refusal, which the command prints as "not written",
// naming the reason, with nothing written.
function refusedPlan(label, files, reason) {
  const out = freshOut();
  let err = null;
  try { write(plan(parseArgs(args({ out }), { cwd: ROOT }), files)); } catch (e) { err = e; }
  assert.ok(err, label + ': refused');
  assert.match(failureLine(err), /^appstore-config: not written: .*\. Errors: 1$/, label + ': a refusal, which the command prints as "not written": ' + failureLine(err));
  assert.match(err.message, reason, label + ': it names the reason: ' + err.message);
  assert.deepEqual(listing(out), [], label + ': nothing was written');
}

test('an Entitlements.plist that already holds com.apple.application-identifier or com.apple.developer.team-identifier is refused, and nothing is written (DISH-G-84, its N2)', () => {
  for (const key of [APPLICATION_IDENTIFIER, TEAM_IDENTIFIER]) {
    refusedPlan('it holds ' + key, inputFiles({ entitlements: { ...everyday, [key]: 'ZYXWV98765' } }), new RegExp('already holds ' + esc(key) + ', which only the App Store entitlements may hold$'));
  }
});

test('a tauri.conf.json without an identifier, or with an empty one, is refused, and nothing is written (DISH-G-84, its N3)', () => {
  refusedPlan('no identifier', inputFiles({ conf: { bundle: { macOS: { minimumSystemVersion: '12.0' } } } }), /tauri\.conf\.json names no identifier$/);
  refusedPlan('an empty identifier', inputFiles({ conf: { identifier: '', bundle: { macOS: { minimumSystemVersion: '12.0' } } } }), /tauri\.conf\.json names no identifier$/);
});

test('a tauri.conf.json without bundle.macOS.minimumSystemVersion is refused, and nothing is written (DISH-G-84, its N4)', () => {
  refusedPlan('no bundle', inputFiles({ conf: { identifier: 'com.example.app' } }), /tauri\.conf\.json names no bundle\.macOS\.minimumSystemVersion$/);
  refusedPlan('no minimum', inputFiles({ conf: { identifier: 'com.example.app', bundle: { macOS: {} } } }), /tauri\.conf\.json names no bundle\.macOS\.minimumSystemVersion$/);
});

test('an Entitlements.plist that holds a list, not a dictionary, is refused, and nothing is written (DISH-G-84, its N5)', () => {
  refusedPlan('a list', inputFiles({ entitlements: ['com.apple.security.app-sandbox'] }), /Entitlements\.plist holds no dictionary of entitlements$/);
});

test('a tauri.conf.json that cannot be read, missing or not JSON, is refused, and nothing is written (DISH-G-84, its N6)', () => {
  refusedPlan('missing', inputFiles({ confText: null }), /^could not read .*tauri\.conf\.json \(ENOENT\)$/);
  refusedPlan('not JSON', inputFiles({ confText: '{ "identifier": ' }), /^could not read .*tauri\.conf\.json \(/);
});

// QA-G-41 (QA-01's C10.2 to C10.4, wave-g/qa/scripts/app/r9_config_adv.mjs):
// started by a path that is not the physical one, the command ran nothing and
// ended with exit code 0. Its main-module check compared the path as typed
// with the real path Node takes the module at: a link to the script, a
// linked folder, or /tmp, which macOS links to /private/tmp.
test('started through a link to the script, a linked folder or a /tmp path, the command runs and writes as when started by its real path (QA-G-41; QA-01\'s C10.2 to C10.4)', () => {
  const ran = (tool, label) => {
    const out = freshOut();
    const r = spawnSync(process.execPath, [tool, ...args({ out })], { encoding: 'utf8', cwd: ROOT });
    assert.equal(r.status, 0, label + ': exit code 0: ' + r.stdout + r.stderr);
    assert.match(r.stdout, /^written: /m, label + ': it says what it wrote: ' + r.stdout);
    assert.deepEqual(listing(out), [CONFIG_NAME, ENTITLEMENTS_NAME].sort(), label + ': and wrote both files');
  };
  const linkedTool = path.join(ROOT, 'linked-tool.mjs');
  symlinkSync(TOOL, linkedTool);
  ran(linkedTool, 'C10.2, a link to the script');
  const linkedDesktop = path.join(ROOT, 'linked-desktop');
  symlinkSync(DESKTOP, linkedDesktop);
  ran(path.join(linkedDesktop, 'tools', 'appstore-config.mjs'), 'C10.3, a path through a linked folder');
  assert.equal(realpathSync('/tmp'), '/private/tmp', 'this Mac links /tmp to /private/tmp');
  const copy = mkdtempSync('/private/tmp/plain-sight-appstore-config-');
  try {
    for (const [from, to] of [[TOOL, 'desktop/tools/appstore-config.mjs'], [path.join(TAURI, 'tauri.conf.json'), 'desktop/src-tauri/tauri.conf.json'], [path.join(TAURI, 'Entitlements.plist'), 'desktop/src-tauri/Entitlements.plist']]) {
      mkdirSync(path.dirname(path.join(copy, to)), { recursive: true });
      writeFileSync(path.join(copy, to), readFileSync(from));
    }
    ran(path.join(copy.replace(/^\/private\/tmp\//, '/tmp/'), 'desktop', 'tools', 'appstore-config.mjs'), 'C10.4, a copy started by its /tmp path');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

// QA-G-43 (QA-01's section 20): two more breaks of the command passed every
// case. A2, the control-character check narrowed to the line break: QA-01's
// C2 tab, DEL, carriage return and escape; A3, inside() as a bare prefix
// test: its C6.14, a profile beside the repository in a folder whose name
// begins with the repository folder's name. And its observation 1: --out
// inside the repository wrote the team id and the profile's path where git
// would track them, and --out "" wrote into the current folder.
test('an identity with a tab, DEL, a carriage return or an escape in it is refused, and nothing is written (QA-G-43; QA-01\'s C2 and its break A2)', () => {
  const reason = /the identity holds a control character/;
  refusedRun('a tab', { identity: 'Apple Distribution: a\tb (ABCDE12345)' }, reason);
  refusedRun('DEL', { identity: 'Apple Distribution: a\u007fb (ABCDE12345)' }, reason);
  refusedRun('a carriage return', { identity: 'Apple Distribution: a\rb (ABCDE12345)' }, reason);
  refusedRun('an escape', { identity: 'Apple Distribution: a\u001bb (ABCDE12345)' }, reason);
});

test('a profile beside the repository, in a folder whose name begins with the repository folder\'s name, is outside it and accepted; one inside is refused (QA-G-43; QA-01\'s C6.14 and its break A3)', () => {
  const repository = path.join(ROOT, 'fake-repo');
  const sibling = path.join(ROOT, 'fake-repo-keys');
  for (const dir of [repository, sibling]) mkdirSync(dir);
  const beside = path.join(sibling, 'beside.provisionprofile');
  const within = path.join(repository, 'within.provisionprofile');
  for (const file of [beside, within]) writeFileSync(file, 'a stand-in for the profile\n');
  const out = freshOut();
  write(plan(parseArgs(args({ out, profile: beside }), { cwd: ROOT }), { repository }));
  assert.deepEqual(listing(out), [CONFIG_NAME, ENTITLEMENTS_NAME].sort(), 'the profile beside it is accepted');
  assert.throws(() => plan(parseArgs(args({ out: freshOut(), profile: within }), { cwd: ROOT }), { repository }), /^Error: the profile lies inside the repository/, 'the one inside it is refused');
});

test('an output folder inside the repository other than src-tauri/, and an empty --out, are refused, and nothing is written; src-tauri/ stays allowed and the default (QA-01\'s observation 1, QA-G-43)', () => {
  // A copy of the command in a fake repository inside this test's folder, as
  // QA-01's C7.12 runs it, so no run, even one with this guard broken, writes
  // into the real repository.
  const fake = path.join(ROOT, 'fake-repository');
  const copied = [[TOOL, 'desktop/tools/appstore-config.mjs'], [path.join(TAURI, 'tauri.conf.json'), 'desktop/src-tauri/tauri.conf.json'], [path.join(TAURI, 'Entitlements.plist'), 'desktop/src-tauri/Entitlements.plist']];
  for (const [from, to] of copied) {
    mkdirSync(path.dirname(path.join(fake, to)), { recursive: true });
    writeFileSync(path.join(fake, to), readFileSync(from));
  }
  const tool = path.join(fake, 'desktop', 'tools', 'appstore-config.mjs');
  const tracked = path.join(fake, 'desktop', 'tracked');
  mkdirSync(tracked);
  const reason = /^appstore-config: not written: the output folder lies inside the repository, where git would keep the team id and the profile's path; /;
  for (const [label, out] of [['a folder of the repository', tracked], ['the repository itself', fake]]) {
    const before = listing(out);
    const r = spawnSync(process.execPath, [tool, ...args({ out })], { encoding: 'utf8', cwd: ROOT });
    assert.equal(r.status, 1, label + ': exit code 1: ' + r.stdout + r.stderr);
    assert.match(r.stdout, reason, label + ': ' + r.stdout);
    assert.deepEqual(listing(out), before, label + ': nothing was written');
  }
  const store = path.join(fake, 'desktop', 'src-tauri');
  const allowed = spawnSync(process.execPath, [tool, ...args({ out: store })], { encoding: 'utf8', cwd: ROOT });
  assert.equal(allowed.status, 0, 'its src-tauri/ is allowed: ' + allowed.stdout + allowed.stderr);
  assert.deepEqual(listing(store), [CONFIG_NAME, ENTITLEMENTS_NAME, 'Entitlements.plist', 'tauri.conf.json'].sort(), 'and written');
  refusedRun('an empty --out', { out: '' }, /^appstore-config: not written: --out is empty; /);
  assert.equal(parseArgs(['--team', TEAM, '--identity', IDENTITY, '--profile', PROFILE, '--build', '1']).out, TAURI, 'src-tauri/ is the default');
});

test('desktop/.gitignore keeps both files out of the repository, and desktop/package.json runs the command as npm run appstore:config', () => {
  const lines = readFileSync(path.join(DESKTOP, '.gitignore'), 'utf8').split('\n');
  for (const name of [CONFIG_NAME, ENTITLEMENTS_NAME]) assert.ok(lines.includes('src-tauri/' + name), 'desktop/.gitignore lists src-tauri/' + name);
  assert.equal(JSON.parse(readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).scripts['appstore:config'], 'node tools/appstore-config.mjs');
});

// DM-258 and QA-G-47: what a failed or killed run leaves beside the two
// files, <name>.earlier-<pid> (a put-back that failed too) and
// <name>.tmp-<pid> (a kill between the renames), holds the same team id and
// profile path, so desktop/.gitignore keeps those names out as well. The check
// runs in a git repository of its own holding a copy of desktop/.gitignore,
// so it runs the same on an export with no .git (QA-01's C12.11d), with git's
// system file and the person's own config and ignore files kept out of it.
test('desktop/.gitignore keeps the command\'s leftovers out as well: in a git repository of its own holding a copy of it, git check-ignore ignores both files and their .earlier-<pid> and .tmp-<pid> names, and not the everyday files; the files write() leaves between its renames and after a failed put-back are listed by no git status (DM-258, QA-G-47; QA-01\'s C12.11d)', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'plain-sight-gitignore-'));
  try {
    const env = { ...process.env, HOME: repo, XDG_CONFIG_HOME: path.join(repo, 'no-config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_CEILING_DIRECTORIES']) delete env[name];
    const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env });
    const init = git('init', '-q');
    assert.equal(init.status, 0, 'git init: ' + init.stderr);
    const tauri = path.join(repo, 'desktop', 'src-tauri');
    mkdirSync(tauri, { recursive: true });
    writeFileSync(path.join(repo, 'desktop', '.gitignore'), readFileSync(path.join(DESKTOP, '.gitignore')));
    const ignored = (name) => {
      const r = git('check-ignore', '-q', 'desktop/src-tauri/' + name);
      assert.ok(r.status === 0 || r.status === 1, 'git check-ignore answered for ' + name + ': ' + r.status + ' ' + r.stderr);
      return r.status === 0;
    };
    for (const file of [CONFIG_NAME, ENTITLEMENTS_NAME]) {
      for (const name of [file, file + '.earlier-' + process.pid, file + '.tmp-' + process.pid, file + '.earlier-12345', file + '.tmp-12345']) {
        assert.equal(ignored(name), true, 'git ignores src-tauri/' + name);
      }
    }
    for (const name of ['tauri.conf.json', 'Entitlements.plist', 'Info.plist', 'container-migration.plist']) {
      assert.equal(ignored(name), false, 'git does not ignore the everyday src-tauri/' + name);
    }
    // The names the command itself leaves, from its own write() into that
    // repository: seen from inside the second rename (what a kill there
    // leaves, QA-01's C12.11), then after a put-back that failed too (the
    // Delivery Manager's S18).
    const listed = () => git('status', '--porcelain', '--untracked-files=all').stdout.split('\n').filter(Boolean);
    const { config } = earlierPair(tauri);
    const planned = plan(parseArgs(args({ out: tauri, extra: ['--force'] }), { cwd: ROOT }));
    const failing = renameFailing(2, 3);
    let calls = 0;
    let between = null;
    const rename = (from, to) => {
      calls += 1;
      if (calls === 2) between = { files: readdirSync(tauri).sort(), listed: listed() };
      return failing(from, to);
    };
    let err = null;
    try { write(planned, { rename }); } catch (e) { err = e; }
    assert.ok(err && err.message.endsWith('; move it back by hand'), 'the put-back failed too: ' + (err && err.message));
    const kept = path.basename(config) + '.earlier-' + process.pid;
    assert.deepEqual(between.files, [CONFIG_NAME, kept, ENTITLEMENTS_NAME, ENTITLEMENTS_NAME + '.tmp-' + process.pid].sort(), 'between the renames: the new configuration, the earlier one kept, the earlier entitlements and the new ones under their temporary name');
    assert.deepEqual(between.listed, ['?? desktop/.gitignore'], 'between the renames git lists none of them');
    assert.deepEqual(readdirSync(tauri).sort(), [CONFIG_NAME, kept, ENTITLEMENTS_NAME].sort(), 'after the failed put-back the earlier configuration waits under its kept name');
    assert.deepEqual(listed(), ['?? desktop/.gitignore'], 'after the failed put-back git lists none of them');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('no run of the command wrote into the repository: src-tauri/ is as it was before the suite', () => {
  assert.deepEqual(tauriState(), TAURI_BEFORE);
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
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total. Errors: ${failed}`);
process.exit(failed ? 1 : 0);
