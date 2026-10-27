// Makes a copy of a built bundle under a test identifier, for the two suites
// that open a bundle (release.mjs and app.mjs) before Pranav's move into the
// sandboxed app (DM-240, ledger D-39). The copy:
// - is made with ditto into <destination>/Plain Sight test copy.app, where the
//   destination is the command line's first argument or a stamped folder
//   under the evidence folder (PLAIN_SIGHT_EVIDENCE, else
//   ~/cover-story-delivery/desktop/);
// - gets CFBundleIdentifier com.pranavongole.plainsight.testcopy-<unix stamp>
//   and CFBundleName (and CFBundleDisplayName, where the bundle has one)
//   "Plain Sight test copy", through plutil -replace, as
//   wave-f/sbprobe/make_probe.sh does, so macOS gives it a container of its
//   own and the Dock and Spotlight show it under a name that cannot be taken
//   for the app;
// - LOSES Contents/Resources/container-migration.plist: a copy that kept the
//   manifest would make macOS copy Pranav's real vault and data folder into
//   the test container at its first launch;
// - is signed again ad hoc with the hardened runtime and the entitlements read
//   back from the original's signature (codesign -d --entitlements - --xml
//   into a property list next to the copy), after the old _CodeSignature is
//   removed, and verified with codesign --verify --deep --strict;
// - is read back: the script ends with an error, and removes the copy, unless
//   the identifier is the test identifier, the name is the test name, the
//   manifest is gone, the entitlements are exactly the original's and the
//   launch guard (tests/launch-guard.mjs) lets it through.
// It prints the copy's path last, for PLAIN_SIGHT_APP=<path>. The original is
// never changed: a bundle sandboxed under the real identifier stays the D-39
// trap and is deleted once test:bundle has checked it. Nothing here opens
// either bundle.
//
// Run from desktop/ after `npm run app:build`:
//   npm run app:testcopy [-- <destination folder>]
// The plist rewriting is unit-tested on a fake bundle (launch-guard-tests.mjs);
// the signing, the verification and the read-back need a real bundle.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REAL_ID, bundleFacts, codesignEntitlements, refusal } from './launch-guard.mjs';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_NAME = 'Plain Sight test copy';
export const MANIFEST = 'Contents/Resources/container-migration.plist';
export const SIGNATURE = 'Contents/_CodeSignature';
export const testIdentifier = (stamp) => REAL_ID + '.testcopy-' + stamp;

const plutilHas = (file, key) => spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', file]).status === 0;
const plutilSet = (file, key, value) => execFileSync('plutil', ['-replace', key, '-string', value, file]);

// The copy before it is signed: ditto, the identifier and the name rewritten,
// the manifest and the old signature removed. Returns the copy's path. Never
// writes over anything at the destination.
export function copyUnsigned(source, destination, stamp) {
  if (!existsSync(path.join(source, 'Contents', 'Info.plist'))) throw new Error('no app bundle at ' + source + ' (npm run app:build makes one)');
  const copy = path.join(destination, TEST_NAME + '.app');
  if (existsSync(copy)) throw new Error(copy + ' exists already; remove it or name another destination');
  mkdirSync(destination, { recursive: true });
  execFileSync('ditto', [source, copy]);
  const info = path.join(copy, 'Contents', 'Info.plist');
  plutilSet(info, 'CFBundleIdentifier', testIdentifier(stamp));
  plutilSet(info, 'CFBundleName', TEST_NAME);
  if (plutilHas(info, 'CFBundleDisplayName')) plutilSet(info, 'CFBundleDisplayName', TEST_NAME);
  rmSync(path.join(copy, MANIFEST), { force: true });
  rmSync(path.join(copy, SIGNATURE), { recursive: true, force: true });
  return copy;
}

// Whether two signatures carry exactly the same entitlements: the same keys
// with the same values, in any order.
const canonical = (v) => (Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
    : JSON.stringify(v));
export const sameEntitlements = (a, b) => canonical(a) === canonical(b);

// Signs the copy ad hoc with the hardened runtime and the original's
// entitlements (none when the original's signature carries none) and
// verifies the result.
export function signCopy(copy, entitlementsXml, record) {
  const args = ['--force', '-s', '-', '--options', 'runtime'];
  if (entitlementsXml.trim()) {
    writeFileSync(record, entitlementsXml);
    args.push('--entitlements', record);
  }
  args.push(copy);
  execFileSync('codesign', args, { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', copy], { stdio: 'inherit' });
}

function main() {
  const source = process.env.PLAIN_SIGHT_APP || path.join(DESKTOP, 'src-tauri/target/release/bundle/macos/Plain Sight.app');
  const stamp = Math.floor(Date.now() / 1000);
  const destination = process.argv[2] || path.join(process.env.PLAIN_SIGHT_EVIDENCE || path.join(os.homedir(), 'cover-story-delivery', 'desktop'), 'testcopy-' + stamp);
  let copy = null;
  try {
    const original = bundleFacts(source);
    const xml = codesignEntitlements(source);
    copy = copyUnsigned(source, destination, stamp);
    signCopy(copy, xml, path.join(destination, 'entitlements-of-the-original.plist'));
    const made = bundleFacts(copy);
    const problems = [];
    if (made.identifier !== testIdentifier(stamp)) problems.push('the identifier is ' + made.identifier);
    if (made.name !== TEST_NAME) problems.push('the name is ' + made.name);
    if (existsSync(path.join(copy, MANIFEST))) problems.push('the migration manifest is still in the copy');
    if (!sameEntitlements(made.entitlements, original.entitlements)) problems.push('the entitlements differ from the original\'s: ' + JSON.stringify(made.entitlements) + ' against ' + JSON.stringify(original.entitlements));
    const why = refusal(made, {});
    if (why) problems.push('the launch guard would refuse the copy: ' + why);
    if (problems.length) throw new Error(problems.join('; '));
    console.log('copied ' + source);
    console.log('identifier ' + made.identifier + ', name ' + made.name + ', sandboxed ' + made.sandboxed + ', entitlements ' + (Object.keys(made.entitlements).sort().join(' ') || 'none') + ', migration manifest left out');
    console.log('the original is unchanged; a bundle sandboxed under the real identifier is the D-39 trap: delete it once test:bundle has checked it');
    console.log('run the suites on the copy from desktop/: PLAIN_SIGHT_APP=' + JSON.stringify(copy) + ' npm run test:release, then the same with test:app');
    console.log(copy);
  } catch (err) {
    console.log('testcopy: ' + (err && err.message ? err.message : err) + '. Errors: 1');
    if (copy && existsSync(copy)) {
      rmSync(copy, { recursive: true, force: true });
      console.log('the unfinished copy was removed: ' + copy);
    }
    process.exit(1);
  }
}

const MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (MAIN) main();
