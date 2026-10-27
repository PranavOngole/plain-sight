// Tests of the launch guard (launch-guard.mjs) and of the copy script's
// rewriting (testcopy.mjs), on fake bundles made in a temporary folder of
// this test's own, with the codesign answer handed in as a property list
// text (DM-240, ledger D-39). Nothing here is signed, opened or launched. The
// one real codesign call reads a system app's signature. What needs a real
// bundle, and is not run here: the copy's ad hoc signing, its verification
// and the read-back of the signed copy (the script's own last step).
//
// Run from the repository root: node desktop/tests/launch-guard-tests.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total. Errors: ${failed}`);
process.exit(failed ? 1 : 0);
