// Tests of the launch guard (launch-guard.mjs) and of the copy script's
// rewriting (testcopy.mjs), on fake bundles made in a temporary folder of
// this test's own, with the codesign answer handed in as a property list
// text (DM-240, ledger D-39). Nothing here is signed, opened or launched. The
// one real codesign call reads a system app's signature. What needs a real
// bundle, and is not run here: the copy's ad hoc signing and its
// verification; the read-back of the copy runs on fake bundles, with the
// signing and the codesign reads handed in (makeTestCopy).
//
// Run from the repository root: node desktop/tests/launch-guard-tests.mjs

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OVERRIDE, REAL_ID, SANDBOX, bundleFacts, bundleIdentifier, refusal, verdict, webDataFolder } from './launch-guard.mjs';
import { MANIFEST, SIGNATURE, TEST_NAME, copyUnsigned, sameEntitlements, testIdentifier } from './testcopy.mjs';

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'plain-sight-launch-guard-'));

// An XML property list of a flat dictionary of strings and booleans.
const plist = (dict) => '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>'
  + Object.entries(dict).map(([k, v]) => '<key>' + k + '</key>' + (typeof v === 'boolean' ? (v ? '<true/>' : '<false/>') : '<string>' + v + '</string>')).join('')
  + '</dict></plist>\n';
// A fake bundle: an Info.plist with the identifier and name given, an empty
// executable, and (when asked) the migration manifest and an old signature.
function fakeBundle(tag, identifier, { manifest = false, signature = false, displayName = null, name = 'Plain Sight' } = {}) {
  const app = path.join(ROOT, tag + '.app');
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  const info = { CFBundleIdentifier: identifier, CFBundleName: name, CFBundleExecutable: 'plain-sight' };
  if (displayName) info.CFBundleDisplayName = displayName;
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist(info));
  writeFileSync(path.join(app, 'Contents', 'MacOS', 'plain-sight'), '');
  writeFileSync(path.join(app, 'Contents', 'Resources', 'icon.icns'), '');
  if (manifest) writeFileSync(path.join(app, MANIFEST), plist({ Move: 'fake' }));
  if (signature) { mkdirSync(path.join(app, SIGNATURE)); writeFileSync(path.join(app, SIGNATURE, 'CodeResources'), ''); }
  return app;
}
const THREE = { [SANDBOX]: true, 'com.apple.security.files.user-selected.read-write': true, 'com.apple.security.files.bookmarks.app-scope': true };
const sandboxed = plist(THREE);
// The codesign answers the guard asks for: the signature's entitlements, and
// the identifier the signature carries (none named here unless given).
const codesignSaying = (xml, identifier = null) => (app, request) => (request === 'identifier' ? identifier : xml);
const read = (file, key) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }).trim();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('a bundle sandboxed under the real identifier is refused, with a message that names ledger D-39, the copy script and the override (DM-240)', () => {
  const app = fakeBundle('real-sandboxed', REAL_ID);
  const { facts, why } = verdict(app, { codesign: codesignSaying(sandboxed), env: {} });
  assert.deepEqual([facts.identifier, facts.name, facts.sandboxed, Object.keys(facts.entitlements).sort()], [REAL_ID, 'Plain Sight', true, Object.keys(THREE).sort()], 'the facts come from the plist and the signature');
  assert.equal(typeof why, 'string', 'refused');
  for (const word of ['D-39', REAL_ID, 'app:testcopy', 'PLAIN_SIGHT_APP', OVERRIDE + '=1', app]) assert.ok(why.includes(word), 'the refusal names ' + word + ': ' + why);
});

test('a bundle sandboxed under a test identifier is allowed', () => {
  const app = fakeBundle('test-sandboxed', testIdentifier(1761000000));
  const { facts, why } = verdict(app, { codesign: codesignSaying(sandboxed), env: {} });
  assert.equal(facts.sandboxed, true);
  assert.equal(why, null);
});

test('the real identifier without the sandbox is allowed: no entitlements at all, or the sandbox entitlement false', () => {
  const app = fakeBundle('real-plain', REAL_ID);
  const none = verdict(app, { codesign: codesignSaying(''), env: {} });
  assert.deepEqual([none.facts.sandboxed, none.facts.entitlements, none.why], [false, {}, null], 'a signature without entitlements, as the app Pranav runs today');
  const off = verdict(app, { codesign: codesignSaying(plist({ [SANDBOX]: false })), env: {} });
  assert.deepEqual([off.facts.sandboxed, off.why], [false, null]);
});

test('PLAIN_SIGHT_ALLOW_REAL_ID=1 lifts the refusal for the sandboxed real-identifier bundle, and only that exact value', () => {
  const app = fakeBundle('real-override', REAL_ID);
  const codesign = codesignSaying(sandboxed);
  assert.equal(verdict(app, { codesign, env: { [OVERRIDE]: '1' } }).why, null, 'the override allows it');
  for (const value of ['0', 'yes', 'true', '', ' 1']) assert.equal(typeof verdict(app, { codesign, env: { [OVERRIDE]: value } }).why, 'string', 'not lifted by ' + JSON.stringify(value));
  assert.equal(typeof verdict(app, { codesign, env: {} }).why, 'string', 'nor without the variable');
});

test('a path with no Info.plist is refused, naming the missing file, and a plist without an identifier too', () => {
  const missing = path.join(ROOT, 'nothing.app');
  const { facts, why } = verdict(missing, { codesign: codesignSaying(sandboxed), env: {} });
  assert.equal(facts, null);
  assert.match(why, /Info\.plist/, 'the refusal names the missing file: ' + why);
  assert.ok(why.includes(missing));
  assert.equal(bundleIdentifier(missing), null, 'the harness reads no identifier from it');
  const nameless = path.join(ROOT, 'nameless.app');
  mkdirSync(path.join(nameless, 'Contents'), { recursive: true });
  writeFileSync(path.join(nameless, 'Contents', 'Info.plist'), plist({ CFBundleName: 'Plain Sight' }));
  assert.match(verdict(nameless, { codesign: codesignSaying(sandboxed), env: {} }).why, /CFBundleIdentifier/);
  assert.throws(() => bundleFacts(missing, { codesign: codesignSaying('') }), /Info\.plist/);
});

test('the real codesign call: a sandboxed system app under its own identifier is allowed, and a folder codesign cannot read is refused', () => {
  const calculator = verdict('/System/Applications/Calculator.app', { env: {} });
  assert.equal(calculator.why, null);
  assert.equal(calculator.facts.identifier, 'com.apple.calculator');
  assert.equal(calculator.facts.sandboxed, true, 'Calculator runs in the App Sandbox');
  const unsigned = fakeBundle('unsigned', REAL_ID);
  const { facts, why } = verdict(unsigned, { env: {} });
  assert.equal(facts, null);
  assert.match(why, /codesign could not read/, why);
});

// QA-01's observations on the guard (its report, section 17.5, items 2 to 4):
// the identifier was compared as an exact string, read from Info.plist only,
// and only a boolean true was taken for the sandbox.
test('the real identifier is refused in any case and with spaces around it, and a longer identifier is not taken for it (QA-01 observation 2)', () => {
  for (const id of ['Com.PranavOngole.PlainSight', 'COM.PRANAVONGOLE.PLAINSIGHT', REAL_ID + ' ', ' ' + REAL_ID, '\t' + REAL_ID + '\n']) {
    const app = fakeBundle('variant-' + Buffer.from(id).toString('hex'), id);
    const { facts, why } = verdict(app, { codesign: codesignSaying(sandboxed), env: {} });
    assert.equal(facts.identifier, id, 'the plist holds ' + JSON.stringify(id));
    assert.equal(typeof why, 'string', JSON.stringify(id) + ', sandboxed, is refused');
  }
  assert.equal(verdict(fakeBundle('longer', REAL_ID + '.other'), { codesign: codesignSaying(sandboxed), env: {} }).why, null, 'com.pranavongole.plainsight.other is another app');
});

test('the signature\'s identifier counts too: a sandboxed bundle whose signature names the real identifier is refused whatever its Info.plist says (QA-01 observation 3)', () => {
  const id = testIdentifier(1761000005);
  const app = fakeBundle('signed-real', id);
  const facts = bundleFacts(app, { codesign: codesignSaying(sandboxed, REAL_ID) });
  assert.deepEqual([facts.identifier, facts.signatureIdentifier], [id, REAL_ID], 'the guard reads both identifiers');
  const why = refusal(facts, {});
  assert.equal(typeof why, 'string', 'refused');
  assert.match(why, /signature/, 'the refusal says where the real identifier is: ' + why);
  assert.equal(refusal(bundleFacts(app, { codesign: codesignSaying(sandboxed, ' Com.PranavOngole.PlainSight') }), {}) === null, false, 'in any case there too');
  assert.equal(refusal(bundleFacts(app, { codesign: codesignSaying(sandboxed, id) }), {}), null, 'a signature under the test identifier passes');
  assert.equal(refusal(bundleFacts(app, { codesign: codesignSaying('', REAL_ID) }), {}), null, 'without the sandbox the real identifier in the signature is the app as it runs today');
  assert.equal(bundleFacts('/System/Applications/Calculator.app').signatureIdentifier, 'com.apple.calculator', 'the real codesign call reads a signature\'s identifier');
});

test('any sandbox entitlement that is present and not false counts as sandboxed: the strings "true" and "false", the integer 1 (QA-01 observation 4)', () => {
  const app = fakeBundle('odd-sandbox', REAL_ID);
  for (const [label, value] of [['the string "true"', '<string>true</string>'], ['the integer 1', '<integer>1</integer>'], ['the string "false", which is not the boolean false', '<string>false</string>']]) {
    const xml = plist({}).replace('<dict></dict>', '<dict><key>' + SANDBOX + '</key>' + value + '</dict>');
    const facts = bundleFacts(app, { codesign: codesignSaying(xml) });
    assert.equal(facts.sandboxed, true, label + ' counts as sandboxed');
    assert.equal(typeof refusal(facts, {}), 'string', label + ': refused under the real identifier');
  }
  assert.equal(bundleFacts(app, { codesign: codesignSaying(plist({ [SANDBOX]: false })) }).sandboxed, false, 'the boolean false is no sandbox');
  assert.equal(bundleFacts(app, { codesign: codesignSaying(plist({ 'com.apple.security.files.bookmarks.app-scope': true })) }).sandboxed, false, 'no sandbox entitlement is no sandbox');
});

test('the web data folder follows the bundle: the identifier under Library/WebKit outside the sandbox, the container inside it', () => {
  const home = '/Users/someone';
  assert.equal(webDataFolder(home, { identifier: REAL_ID, sandboxed: false }), path.join(home, 'Library/WebKit', REAL_ID));
  const id = testIdentifier(1761000000);
  assert.equal(webDataFolder(home, { identifier: id, sandboxed: true }), path.join(home, 'Library/Containers', id, 'Data/Library/WebKit/WebsiteData'));
});

// DM-241: macOS titles the app menu with the bundle's name, so a copy made by
// the script shows "Plain Sight test copy" there while the items keep the
// binary's own words, "About Plain Sight", "Hide Plain Sight" and "Quit Plain
// Sight" (release-run-1, 26 October 2026, run.log line 59). The two suites
// that open a bundle expect the menu bar this gives for the bundle they open.
test('the suites expect the app menu under the bundle\'s own name: "Plain Sight test copy" on a copy the script made, "Plain Sight" on the app (DM-241)', async () => {
  const { appMenuTitle, menuBarOf } = await import('./launch-guard.mjs');
  assert.equal(typeof menuBarOf, 'function', 'launch-guard.mjs gives the suites the menu bar they expect for a bundle');
  const source = fakeBundle('menu-source', REAL_ID, { displayName: 'Plain Sight' });
  const copy = copyUnsigned(source, path.join(ROOT, 'menu-copy'), 1761000002);
  const facts = bundleFacts(copy, { codesign: codesignSaying(sandboxed) });
  assert.equal(facts.name, TEST_NAME, 'the copy carries the test name');
  assert.deepEqual(menuBarOf(facts), [TEST_NAME, 'File', 'Edit', 'View', 'Window', 'Help'], 'the copy\'s app menu is expected under its own name');
  assert.equal(appMenuTitle(facts), 'Plain Sight test copy', 'and the Quit and About items are looked for in that menu');
  assert.deepEqual(menuBarOf(bundleFacts(source, { codesign: codesignSaying('') })), ['Plain Sight', 'File', 'Edit', 'View', 'Window', 'Help'], 'the app\'s own bundle keeps "Plain Sight"');
  assert.deepEqual(menuBarOf(bundleFacts(fakeBundle('menu-renamed', REAL_ID, { name: 'Another Name' }), { codesign: codesignSaying('') }))[0], 'Another Name', 'the title is read from the bundle, not assumed');
});

// DM-242: the network watch (netwatch.mjs) tells which WebKit networking
// process works for the app by the app's web data that process holds open.
// Inside the sandbox WebKit keeps that data in the bundle's container, with
// nothing under the identifier (sbprobe2-run-1, 26 October 2026, test
// migrate), and the watch saw no networking process for the four sandboxed
// launches of release-run-1, when it knew only the unsandboxed paths. The
// lsof call is answered here by a text in its -Fn form, so nothing is
// watched; the watch is imported only once it is sure to start watching only
// when run as a script.
const TESTS = path.dirname(fileURLToPath(import.meta.url));
async function loadWatch() {
  assert.match(readFileSync(path.join(TESTS, 'netwatch.mjs'), 'utf8'), /^if \(MAIN\) /m, 'netwatch.mjs starts its watch only when it is run as a script, so its matching can be tested');
  return import('./netwatch.mjs');
}
const lsofNames = (...names) => 'p501\n' + names.map((name, i) => 'f' + i + '\nn' + name).join('\n') + '\n';
const NETWORKING = '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking';
const answering = (text) => (pid) => (pid === 501 ? text : '');

test('the network watch finds a sandboxed copy\'s WebKit networking process by the copy\'s container (DM-242)', async () => {
  const { webDataPattern, worksForTheApp } = await loadWatch();
  const id = testIdentifier(1793065378);
  const pattern = webDataPattern({ identifier: id, sandboxed: true });
  const ours = lsofNames('/', NETWORKING, '/Users/someone/Library/Containers/' + id + '/Data/Library/WebKit/WebsiteData/ResourceLoadStatistics/observations.db');
  assert.equal(worksForTheApp(501, pattern, answering(ours)), true, 'the copy\'s own networking process, by ' + pattern);
  assert.equal(worksForTheApp(502, pattern, answering(ours)), false, 'the lsof answer is the one for the process asked about');
  const real = webDataPattern({ identifier: REAL_ID, sandboxed: true });
  assert.equal(worksForTheApp(501, real, answering(lsofNames(NETWORKING, '/Users/someone/Library/Containers/' + REAL_ID + '/Data/Library/WebKit/WebsiteData/LocalStorage/localstorage.sqlite3'))), true, 'the sandboxed app itself, after the move, by its own container');
});

test('the network watch takes no other WebKit networking process for the app\'s: another app\'s container, another test copy\'s, the real app\'s, or the unsandboxed folder (DM-242)', async () => {
  const { webDataPattern, worksForTheApp } = await loadWatch();
  const id = testIdentifier(1793065378);
  const pattern = webDataPattern({ identifier: id, sandboxed: true });
  for (const other of [
    '/Users/someone/Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/observations.db',
    '/Users/someone/Library/Containers/' + testIdentifier(1793000000) + '/Data/Library/WebKit/WebsiteData/observations.db',
    '/Users/someone/Library/Containers/' + REAL_ID + '/Data/Library/WebKit/WebsiteData/observations.db',
    '/Users/someone/Library/WebKit/' + id + '/WebsiteData/observations.db'
  ]) assert.equal(worksForTheApp(501, pattern, answering(lsofNames('/', NETWORKING, other))), false, other + ' is not the copy\'s');
  const real = webDataPattern({ identifier: REAL_ID, sandboxed: true });
  assert.equal(worksForTheApp(501, real, answering(lsofNames(NETWORKING, '/Users/someone/Library/Containers/' + id + '/Data/Library/WebKit/WebsiteData/observations.db'))), false, 'a test copy\'s container is not the app\'s');
});

test('the network watch still finds the unsandboxed app\'s and a bare test build\'s networking process under Library/WebKit, with or without a bundle named (DM-242)', async () => {
  const { webDataPattern, worksForTheApp } = await loadWatch();
  for (const pattern of [webDataPattern({ identifier: REAL_ID, sandboxed: false }), webDataPattern()]) {
    for (const name of ['com.pranavongole.plainsight', 'plain-sight']) {
      assert.equal(worksForTheApp(501, pattern, answering(lsofNames('/', NETWORKING, '/Users/someone/Library/WebKit/' + name + '/WebsiteData/observations.db'))), true, name + ' by ' + pattern);
    }
    assert.equal(worksForTheApp(501, pattern, answering(lsofNames('/', NETWORKING, '/Users/someone/Library/WebKit/com.apple.Safari/WebsiteData/observations.db'))), false, 'another app\'s folder, by ' + pattern);
  }
  const copy = webDataPattern({ identifier: testIdentifier(1), sandboxed: false });
  assert.equal(worksForTheApp(501, copy, answering(lsofNames(NETWORKING, '/Users/someone/Library/WebKit/' + testIdentifier(1) + '/WebsiteData/observations.db'))), true, 'an unsandboxed bundle under another identifier, by its own folder');
});

test('release.mjs hands the network watch the bundle it opens, so the watch matches that bundle\'s web data (DM-242)', () => {
  const release = readFileSync(path.join(TESTS, 'release.mjs'), 'utf8');
  assert.match(release, /spawn\(process\.execPath, \[path\.join\(DESKTOP, 'tests', 'netwatch\.mjs'\), '600', report, APP\]/, 'the watch is started with the bundle under test');
});

// QA-01's watch cases on 534f3cc (wave-g/qa/scripts/app/r7_netwatch_adv.mjs,
// N17 to N17c and N21, with its expectations). N17 to N17c: the bundle's
// identifier is taken literally in the watch's pattern, regular-expression
// characters and dots included (DISH's breaks and QA-01's S39 removed the
// escape and every case above still passed).
test('the network watch takes the identifier literally: one with regular-expression characters matches only itself, and its dots match only dots (QA-01 N17 to N17c)', async () => {
  const { webDataPattern, worksForTheApp } = await loadWatch();
  const lsof = (...paths) => 'p4242\nfcwd\nn/\n' + paths.map((p, i) => 'f' + (i + 3) + '\nn' + p).join('\n') + '\n';
  const cont = (id) => '/Users/someone/Library/Containers/' + id + '/Data/Library/WebKit/WebsiteData/Default/salt/LocalStorage/localstorage.sqlite3';
  const works = (facts, text) => worksForTheApp(4242, webDataPattern(facts), () => text);
  const odd = { identifier: 'com.x(y)+z[1]*', sandboxed: true };
  assert.equal(works(odd, lsof(cont('com.x(y)+z[1]*'))), true, 'N17 an identifier with regular-expression characters matches itself');
  assert.equal(works(odd, lsof(cont('com.xyyz1'))), false, 'N17b nothing a loose pattern would match: com.xyyz1');
  assert.equal(works(odd, lsof(cont('comAx(y)+z[1]*'))), false, 'N17b nor comAx(y)+z[1]*');
  assert.equal(works({ identifier: 'com.a.b', sandboxed: true }, lsof(cont('comXaXb'))), false, 'N17c the dots of an identifier are literal');
});

// The watch run as a script, as release.mjs runs it, with stand-ins for the
// programs it lists processes with (pgrep, lsof, and nettop under script),
// first on its PATH: whatever the watch does, it can list no process of this
// Mac. codesign and plutil are the real ones.
function watchEnv({ codesign = null } = {}) {
  const bin = path.join(ROOT, 'watch-bin' + (codesign ? '-codesign' : ''));
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [['pgrep', 'exit 1'], ['lsof', 'exit 0'], ['script', 'exit 0'], ['nettop', 'exit 0'], ...(codesign ? [['codesign', codesign]] : [])]) {
    writeFileSync(path.join(bin, name), '#!/bin/sh\n' + body + '\n');
    chmodSync(path.join(bin, name), 0o755);
  }
  return { ...process.env, PATH: bin + ':' + process.env.PATH };
}
// N21: a bundle the watch cannot read ends it with exit code 2 and a report
// that says so, before any process is listed; with exit 0 the release suite
// would read the run as "no network use" (QA-01's S42).
test('the network watch given a path with no bundle, or a bundle codesign cannot read, ends with exit code 2 and a report saying so, before it lists any process (QA-01 N21)', () => {
  for (const [label, bundle] of [['a path with no bundle', path.join(ROOT, 'no-such-bundle.app')], ['an unsigned bundle', fakeBundle('watch-unsigned', testIdentifier(1761000010))]]) {
    const report = path.join(ROOT, 'netwatch-' + label.replace(/\W+/g, '-') + '.json');
    const r = spawnSync(process.execPath, [path.join(TESTS, 'netwatch.mjs'), '1', report, bundle], { encoding: 'utf8', env: watchEnv() });
    let written = null;
    try { written = JSON.parse(readFileSync(report, 'utf8')); } catch { written = null; }
    assert.equal(r.status, 2, label + ': exit code 2; output: ' + r.stdout + r.stderr);
    assert.match(r.stdout, /^netwatch: the bundle could not be read: /m, label + ': the watch says why');
    assert.ok(written && /^the bundle could not be read: /.test(written.verdict), label + ': the report says so: ' + JSON.stringify(written));
    assert.deepEqual([written.appPids, written.networkPids, written.samples], [[], [], 0], label + ': and lists no process');
  }
});

// DM-240: no test ran launchable() itself, so with its process.exit(REFUSED)
// removed the guard printed its refusal and returned, the suite went on to
// the backup and to `open -n` of the real-identifier bundle, and every suite
// passed (the Delivery Manager's GD1). Its AT-L1a to AT-L1c
// (dm-appstore-534f3cc/adv/tests534/desktop/tests/dm-guard-adv-534.mjs):
// launchable() in a process of its own, as the suites run it, with the
// codesign reader handed in, so nothing is signed. A refused bundle ends that
// process with exit code 7 before the line after the call runs; a test copy's
// facts are returned.
function launchIn(app, signatureId, entitlementsXml) {
  const code = 'import { launchable } from ' + JSON.stringify(pathToFileURL(path.join(TESTS, 'launch-guard.mjs')).href) + ';\n'
    + 'const facts = launchable("guardcheck", ' + JSON.stringify(app) + ', { codesign: (a, r) => (r === "identifier" ? ' + JSON.stringify(signatureId) + ' : ' + JSON.stringify(entitlementsXml) + ') });\n'
    + 'console.log("RETURNED " + JSON.stringify(facts && facts.identifier));';
  const env = { ...process.env };
  delete env[OVERRIDE];
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env });
}
test('launchable(), run as the suites run it, ends its process with exit code 7 and an Errors line on a bundle sandboxed under the real identifier or on no bundle at all, before the line after the call runs, and returns a test copy\'s facts (DM-240; the Delivery Manager\'s AT-L1a to AT-L1c)', () => {
  const real = launchIn(fakeBundle('launch-real', REAL_ID), REAL_ID, sandboxed);
  assert.equal(real.status, 7, 'AT-L1a: exit code 7; output: ' + real.stdout + real.stderr);
  assert.match(real.stdout, /^guardcheck: not started: .* is sandboxed under the real bundle identifier com\.pranavongole\.plainsight .*Errors: 1$/m, 'AT-L1a: the refusal and its Errors line');
  assert.equal(real.stdout.includes('RETURNED'), false, 'AT-L1a: the line after the call never ran, so a suite would not go on to open the bundle');
  const copy = launchIn(fakeBundle('launch-copy', testIdentifier(1761000015)), testIdentifier(1761000015), sandboxed);
  assert.equal(copy.status, 0, 'AT-L1b: a test copy lets the process go on: ' + copy.stdout + copy.stderr);
  assert.equal(copy.stdout.trim(), 'RETURNED "' + testIdentifier(1761000015) + '"', 'AT-L1b: and its facts are returned');
  const none = launchIn(path.join(ROOT, 'nothing here', 'Plain Sight.app'), REAL_ID, sandboxed);
  assert.equal(none.status, 7, 'AT-L1c: no bundle ends the process with 7 too: ' + none.stdout + none.stderr);
  assert.match(none.stdout, /not started: no app bundle at /, 'AT-L1c: the reason');
  assert.equal(none.stdout.includes('RETURNED'), false, 'AT-L1c: the line after the call never ran');
});

// DM-242: the watch's own wiring, watch(), runs only as a script, so with
// watch() matching the unsandboxed paths whatever bundle it is handed, every
// suite passed (the Delivery Manager's NW1). Its AT-N1: netwatch.mjs run as
// release.mjs runs it, for one second, on a fake bundle sandboxed under a
// test identifier (never opened), with a stand-in codesign on its PATH that
// answers the guard's two reads, so nothing is signed: the report records the
// bundle and that bundle's container pattern, and with the app never running
// the watch ends with exit code 2.
test('the network watch handed a sandboxed test copy matches that bundle\'s container and records the bundle, and with the app never running ends with exit code 2 (DM-242; the Delivery Manager\'s AT-N1)', () => {
  const id = testIdentifier(1761000016);
  const bundle = fakeBundle('watch-sandboxed', id);
  const entitlements = path.join(ROOT, 'watch-entitlements.plist');
  writeFileSync(entitlements, sandboxed);
  const codesign = 'case "$1" in\n  -dv) echo "Identifier=' + id + '" >&2; exit 0 ;;\n  -d) cat "' + entitlements + '"; exit 0 ;;\nesac\nexit 1';
  const report = path.join(ROOT, 'netwatch-sandboxed.json');
  const r = spawnSync(process.execPath, [path.join(TESTS, 'netwatch.mjs'), '1', report, bundle], { encoding: 'utf8', env: watchEnv({ codesign }) });
  assert.equal(r.status, 2, 'exit code 2; output: ' + r.stdout + r.stderr);
  const written = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(written.verdict, 'the app was never seen running', 'nothing was proven, and the report says so');
  assert.equal(written.webData, String(new RegExp('/Library/Containers/' + id.replace(/\./g, '\\.') + '/Data/Library/WebKit/')), 'the watch matched the bundle\'s container: ' + written.webData);
  assert.deepEqual(written.bundle, { app: bundle, identifier: id, sandboxed: true }, 'and recorded the bundle it was handed');
});

test('the copy script rewrites the identifier and the names, leaves the migration manifest and the old signature out, keeps the rest, and leaves the source as it was', () => {
  const source = fakeBundle('source', REAL_ID, { manifest: true, signature: true, displayName: 'Plain Sight' });
  const destination = path.join(ROOT, 'destination');
  const copy = copyUnsigned(source, destination, 1761000000);
  assert.equal(copy, path.join(destination, TEST_NAME + '.app'));
  assert.equal(read(path.join(copy, 'Contents/Info.plist'), 'CFBundleIdentifier'), REAL_ID + '.testcopy-1761000000');
  assert.equal(read(path.join(copy, 'Contents/Info.plist'), 'CFBundleName'), TEST_NAME);
  assert.equal(read(path.join(copy, 'Contents/Info.plist'), 'CFBundleDisplayName'), TEST_NAME);
  assert.equal(read(path.join(copy, 'Contents/Info.plist'), 'CFBundleExecutable'), 'plain-sight', 'the other keys stay');
  assert.equal(existsSync(path.join(copy, MANIFEST)), false, 'no migration manifest in the copy');
  assert.equal(existsSync(path.join(copy, SIGNATURE)), false, 'the old signature is gone');
  assert.ok(existsSync(path.join(copy, 'Contents/MacOS/plain-sight')) && existsSync(path.join(copy, 'Contents/Resources/icon.icns')), 'the executable and the icon are copied');
  assert.equal(read(path.join(source, 'Contents/Info.plist'), 'CFBundleIdentifier'), REAL_ID, 'the source keeps its identifier');
  assert.ok(existsSync(path.join(source, MANIFEST)) && existsSync(path.join(source, SIGNATURE, 'CodeResources')), 'the source keeps its manifest and signature');
  const facts = bundleFacts(copy, { codesign: codesignSaying(sandboxed) });
  assert.equal(refusal(facts, {}), null, 'the launch guard lets the copy through, sandboxed under its test identifier');
  assert.throws(() => copyUnsigned(source, destination, 1761000000), /exists already/, 'never writes over an earlier copy');
  assert.throws(() => copyUnsigned(path.join(ROOT, 'absent.app'), destination, 1), /no app bundle/, 'a missing source is named');
});

// QA-G-32: the copy script left a bundle named "Plain Sight test copy.app"
// under the real identifier, sandboxed and signed as the original, when it
// failed between the ditto and the rewrite of the identifier (QA-01 made
// Info.plist unwritable): the script's catch saw no copy path. A failure
// after the ditto now removes the copy this call made and names the step; a
// path the call did not make is never removed. plutil is handed in, failing
// at the identifier.
test('the copy script never leaves a copy under the real identifier: a step that fails after the ditto removes the copy it made and names the step, and a path it did not make is left alone (QA-G-32)', () => {
  const source = fakeBundle('source-failing', REAL_ID, { manifest: true, signature: true });
  const destination = path.join(ROOT, 'destination-failing');
  const copy = path.join(destination, TEST_NAME + '.app');
  const failing = (args) => {
    if (args[0] === '-replace' && args[1] === 'CFBundleIdentifier') throw Object.assign(new Error('Command failed: plutil ' + args.join(' ')), { stderr: 'Info.plist: (You don\'t have permission to save the file.)' });
    return execFileSync('plutil', args, { encoding: 'utf8' });
  };
  let message = null;
  try { copyUnsigned(source, destination, 1761000004, { plutil: failing }); } catch (err) { message = err.message; }
  assert.notEqual(message, null, 'the copy ends with an error when plutil cannot rewrite the identifier');
  assert.match(message, /CFBundleIdentifier/, 'the error names the step: ' + message);
  assert.match(message, /permission to save/, 'and plutil\'s reason: ' + message);
  assert.match(message, /removed/, 'and says the unfinished copy was removed: ' + message);
  assert.equal(existsSync(copy), false, 'no copy is left, so none under the real identifier');
  assert.equal(read(path.join(source, 'Contents/Info.plist'), 'CFBundleIdentifier'), REAL_ID, 'the source is as it was');
  mkdirSync(path.join(copy, 'Contents'), { recursive: true });
  writeFileSync(path.join(copy, 'Contents', 'kept'), 'made by someone else');
  assert.throws(() => copyUnsigned(source, destination, 1761000004, { plutil: failing }), /exists already/, 'an existing copy stops the script before the ditto');
  assert.equal(readFileSync(path.join(copy, 'Contents', 'kept'), 'utf8'), 'made by someone else', 'and a path the call did not make is left as it was');
});

// QA-G-32, the residual: when removing the unfinished copy failed too,
// rmSync's own error (ENOTEMPTY) replaced the step's, and the script could
// not say what had happened or what was left. QA-01's repro (r7_guard_adv.mjs
// E5): the source's Info.plist marked immutable (chflags uchg), which ditto
// carries into the copy, so plutil cannot rewrite the identifier and the
// removal cannot take that file. The error now keeps plutil's reason, gives
// the removal's and names the copy to remove by hand. The flags are cleared
// in the end, so the temporary folder can go.
test('when the unfinished copy cannot be removed either, the error keeps the step\'s own reason, gives the removal\'s and names the copy to remove by hand (QA-G-32)', () => {
  const source = fakeBundle('source-immutable', REAL_ID, { manifest: true });
  const destination = path.join(ROOT, 'destination-immutable');
  const copy = path.join(destination, TEST_NAME + '.app');
  execFileSync('chflags', ['uchg', path.join(source, 'Contents', 'Info.plist')]);
  try {
    let message = null;
    try { copyUnsigned(source, destination, 1761000006); } catch (err) { message = err.message; }
    assert.notEqual(message, null, 'the copy ends with an error');
    assert.ok(message.startsWith('could not set CFBundleIdentifier in ' + path.join(copy, 'Contents', 'Info.plist') + ' ('), 'the error names the step that failed first: ' + message);
    assert.match(message, /; the unfinished copy could not be removed \([^)]+\): remove it by hand: /, 'and says the removal failed, with its reason: ' + message);
    assert.ok(message.endsWith('remove it by hand: ' + copy), 'and names the copy to remove: ' + message);
    assert.equal(message.indexOf('ENOTEMPTY') > message.indexOf('could not be removed'), message.includes('ENOTEMPTY'), 'the removal\'s ENOTEMPTY, if any, is given as the removal\'s reason, not as the cause: ' + message);
    assert.equal(existsSync(path.join(copy, 'Contents', 'Info.plist')), true, 'what macOS kept is still there, as the error says');
    assert.equal(existsSync(path.join(copy, 'Contents', 'MacOS', 'plain-sight')), false, 'and nothing else of the copy: no executable to launch');
  } finally {
    execFileSync('chflags', ['-R', 'nouchg', source]);
    if (existsSync(destination)) execFileSync('chflags', ['-R', 'nouchg', destination]);
  }
});

// QA-G-34: existsSync follows links, so a symbolic link at the copy's path
// that leads nowhere passed the "exists already" check, the ditto failed and
// the cleanup removed the link: a path the script did not make (QA-01's
// r7_guard_adv.mjs E8c). The check reads the path itself (lstatSync), so the
// link stops the copy before the ditto and stays.
test('a symbolic link at the copy\'s path, even one that leads nowhere, stops the copy before the ditto and is left where it is (QA-G-34)', () => {
  const source = fakeBundle('source-dangling', REAL_ID);
  const destination = path.join(ROOT, 'destination-dangling');
  const copy = path.join(destination, TEST_NAME + '.app');
  mkdirSync(destination, { recursive: true });
  symlinkSync(path.join(ROOT, 'nowhere-target.app'), copy);
  assert.throws(() => copyUnsigned(source, destination, 1761000007), /exists already/, 'refused before the ditto');
  assert.equal(lstatSync(copy).isSymbolicLink(), true, 'the link is still there');
  assert.equal(readlinkSync(copy), path.join(ROOT, 'nowhere-target.app'), 'and still leads where it led');
  assert.equal(existsSync(path.join(ROOT, 'nowhere-target.app')), false, 'nothing was copied through it');
  // A link that appears at the path only during the copy is never removed
  // either: the cleanup reads the path itself too. ditto is handed in, and
  // fails after a link took the copy's place.
  const later = path.join(ROOT, 'destination-link-later');
  const linked = (from, to) => { symlinkSync(path.join(ROOT, 'elsewhere.app'), to); throw new Error('ditto: ' + to + ': File exists'); };
  let message = null;
  try { copyUnsigned(source, later, 1761000008, { ditto: linked }); } catch (err) { message = err.message; }
  assert.match(String(message), /^could not copy .* with ditto \(ditto: .*File exists\); .* is a symbolic link this call did not make, left as it is$/, 'the error says the link was left: ' + message);
  assert.equal(lstatSync(path.join(later, TEST_NAME + '.app')).isSymbolicLink(), true, 'the link is still there');
});

// DM-246 (b): the cleanup after a ditto that fails part way had no test (the
// Delivery Manager's CP1, the removal skipped for the ditto's own step,
// passed every suite). A file in the source that cannot be read makes the
// real ditto stop after it has begun the copy (QA-01's E7 in
// r7_guard_adv.mjs), leaving a partial copy that still has the source's
// Info.plist, the real identifier's.
test('a ditto that fails part way leaves no partial copy: the copy it began is removed, and the error names the ditto step and its reason (DM-246, CP1; QA-01 E7)', () => {
  const source = fakeBundle('source-unreadable', REAL_ID, { manifest: true });
  const unreadable = path.join(source, 'Contents', 'Resources', 'zz-unreadable.bin');
  writeFileSync(unreadable, 'not readable');
  chmodSync(unreadable, 0o000);
  const destination = path.join(ROOT, 'destination-unreadable');
  const copy = path.join(destination, TEST_NAME + '.app');
  try {
    let message = null;
    try { copyUnsigned(source, destination, 1761000011); } catch (err) { message = err.message; }
    assert.match(String(message), /^could not copy .+ with ditto \(ditto: .+zz-unreadable\.bin: Permission denied\); the unfinished copy, which may still carry the real identifier, was removed: /, 'the error names the ditto step and its reason: ' + message);
    assert.ok(String(message).endsWith(copy), 'and the copy it removed: ' + message);
    assert.equal(existsSync(copy), false, 'no partial copy is left, so none under the real identifier');
    assert.equal(read(path.join(source, 'Contents/Info.plist'), 'CFBundleIdentifier'), REAL_ID, 'the source is as it was');
  } finally {
    chmodSync(unreadable, 0o644);
  }
});

// DM-247: the copy script's whole flow is one function, makeTestCopy, which
// the harness also calls for a fresh copy when a real-key test needs a first
// launch of a sandboxed bundle. Its read-back, here with the signing and the
// codesign reads handed in: a copy that passes it is returned, signed once
// with the original's entitlements; one the launch guard would refuse is
// removed, and the error says why and that it was removed.
test('makeTestCopy makes, signs and reads back a copy under a test identifier, and removes a copy whose read-back fails, saying why (DM-247)', async () => {
  const { makeTestCopy } = await import('./testcopy.mjs');
  assert.equal(typeof makeTestCopy, 'function', 'testcopy.mjs gives the harness its whole copy as one function');
  const source = fakeBundle('source-make', REAL_ID, { manifest: true, signature: true });
  const signed = [];
  const sign = (copy, xml, record) => { signed.push({ copy, xml, record }); };
  const destination = path.join(ROOT, 'make-ok');
  const { original, made, copy } = makeTestCopy(source, destination, 1761000012, { readFacts: (app) => bundleFacts(app, { codesign: codesignSaying(sandboxed) }), readEntitlements: () => sandboxed, sign });
  assert.equal(copy, path.join(destination, TEST_NAME + '.app'));
  assert.deepEqual([original.identifier, made.identifier, made.name, made.sandboxed, made.app], [REAL_ID, testIdentifier(1761000012), TEST_NAME, true, copy], 'the copy is the test identifier\'s, sandboxed like the original');
  assert.deepEqual(signed, [{ copy, xml: sandboxed, record: path.join(destination, 'entitlements-of-the-original.plist') }], 'signed once, with the original\'s entitlements');
  assert.equal(existsSync(path.join(copy, MANIFEST)), false, 'without the migration manifest');
  const refusedAt = path.join(ROOT, 'make-refused');
  let failure = null;
  try {
    makeTestCopy(source, refusedAt, 1761000013, { readFacts: (app) => bundleFacts(app, { codesign: codesignSaying(sandboxed, app === source ? null : REAL_ID) }), readEntitlements: () => sandboxed, sign });
  } catch (err) { failure = err; }
  assert.ok(failure, 'a copy whose signature carries the real identifier is refused by the read-back');
  assert.match(failure.message, /the launch guard would refuse the copy: /, failure.message);
  assert.equal(failure.removal, 'the unfinished copy was removed: ' + path.join(refusedAt, TEST_NAME + '.app'));
  assert.equal(existsSync(path.join(refusedAt, TEST_NAME + '.app')), false, 'no copy is left');
});

test('the read-back compares the entitlements exactly: the same keys and values in any order pass, a missing, extra or changed one fails', () => {
  const reordered = { 'com.apple.security.files.bookmarks.app-scope': true, 'com.apple.security.files.user-selected.read-write': true, [SANDBOX]: true };
  assert.equal(sameEntitlements(THREE, reordered), true);
  assert.equal(sameEntitlements(THREE, { ...THREE, 'com.apple.security.network.client': true }), false, 'an extra entitlement');
  assert.equal(sameEntitlements(THREE, { [SANDBOX]: true, 'com.apple.security.files.user-selected.read-write': true }), false, 'a missing one');
  assert.equal(sameEntitlements(THREE, { ...THREE, [SANDBOX]: false }), false, 'a changed value');
  assert.equal(sameEntitlements({}, {}), true, 'none on both sides');
  assert.equal(sameEntitlements({ a: ['x', 'y'] }, { a: ['y', 'x'] }), false, 'an array keeps its order');
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
  try { execFileSync('chflags', ['-R', 'nouchg', ROOT]); } catch { /* nothing flagged is left */ }
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total. Errors: ${failed}`);
process.exit(failed ? 1 : 0);
