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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLICATION_IDENTIFIER, CONFIG_NAME, ENTITLEMENTS_NAME, REPOSITORY, Refusal, TAURI, TEAM_IDENTIFIER, parseArgs, plan, write } from '../tools/appstore-config.mjs';

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
  const out = options.out || freshOut();
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

test('the command writes Entitlements.appstore.plist as an XML property list that plutil reads back: every entitlement of Entitlements.plist, plus com.apple.application-identifier (<team>.<identifier of tauri.conf.json>) and com.apple.developer.team-identifier (<team>), and nothing else', () => {
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
});

test('the entitlements are read from Entitlements.plist each time, so one added there later (com.apple.security.network.client) carries over, and the identifier and the minimum macOS come from tauri.conf.json', () => {
  const inputs = path.join(ROOT, 'inputs');
  mkdirSync(inputs);
  const entitlementsFile = path.join(inputs, 'Entitlements.plist');
  execFileSync('plutil', ['-convert', 'xml1', '-o', entitlementsFile, '-'], { input: JSON.stringify({ ...everyday, 'com.apple.security.network.client': true }) });
  const tauriConfFile = path.join(inputs, 'tauri.conf.json');
  writeFileSync(tauriConfFile, JSON.stringify({ identifier: 'com.example.later', bundle: { macOS: { minimumSystemVersion: '13.0' } } }));
  const out = freshOut();
  write(plan(parseArgs(args({ out }), { cwd: ROOT }), { entitlementsFile, tauriConfFile }));
  const read = plistOf(path.join(out, ENTITLEMENTS_NAME));
  assert.deepEqual(read, { ...everyday, 'com.apple.security.network.client': true, [APPLICATION_IDENTIFIER]: TEAM + '.com.example.later', [TEAM_IDENTIFIER]: TEAM });
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
  refusedRun('another team\'s identity', { identity: 'Apple Distribution: Test Person (ZYXWV98765)' }, /the identity must end with "\(ABCDE12345\)"/);
  refusedRun('no team in the identity', { identity: 'Apple Distribution: Test Person' }, /the identity must end with "\(ABCDE12345\)"/);
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

test('desktop/.gitignore keeps both files out of the repository, and desktop/package.json runs the command as npm run appstore:config', () => {
  const lines = readFileSync(path.join(DESKTOP, '.gitignore'), 'utf8').split('\n');
  for (const name of [CONFIG_NAME, ENTITLEMENTS_NAME]) assert.ok(lines.includes('src-tauri/' + name), 'desktop/.gitignore lists src-tauri/' + name);
  assert.equal(JSON.parse(readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).scripts['appstore:config'], 'node tools/appstore-config.mjs');
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
