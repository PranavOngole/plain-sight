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
import { OVERRIDE, REAL_ID, SANDBOX, bundleFacts, bundleIdentifier, refusal, verdict, webDataFolder } from './launch-guard.mjs';
import { MANIFEST, SIGNATURE, TEST_NAME, copyUnsigned, sameEntitlements, testIdentifier } from './testcopy.mjs';

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'plain-sight-launch-guard-'));

// An XML property list of a flat dictionary of strings and booleans.
const plist = (dict) => '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>'
  + Object.entries(dict).map(([k, v]) => '<key>' + k + '</key>' + (typeof v === 'boolean' ? (v ? '<true/>' : '<false/>') : '<string>' + v + '</string>')).join('')
  + '</dict></plist>\n';
// A fake bundle: an Info.plist with the identifier and name given, an empty
// executable, and (when asked) the migration manifest and an old signature.
function fakeBundle(tag, identifier, { manifest = false, signature = false, displayName = null } = {}) {
  const app = path.join(ROOT, tag + '.app');
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  const info = { CFBundleIdentifier: identifier, CFBundleName: 'Plain Sight', CFBundleExecutable: 'plain-sight' };
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
const codesignSaying = (xml) => () => xml;
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

test('the web data folder follows the bundle: the identifier under Library/WebKit outside the sandbox, the container inside it', () => {
  const home = '/Users/someone';
  assert.equal(webDataFolder(home, { identifier: REAL_ID, sandboxed: false }), path.join(home, 'Library/WebKit', REAL_ID));
  const id = testIdentifier(1761000000);
  assert.equal(webDataFolder(home, { identifier: id, sandboxed: true }), path.join(home, 'Library/Containers', id, 'Data/Library/WebKit/WebsiteData'));
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
