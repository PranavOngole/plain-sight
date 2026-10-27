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
//   launch guard (tests/launch-guard.mjs) lets it through;
// - is removed, with the error naming the step, when the ditto or any step
//   after it fails, so a copy that still carries the real identifier is not
//   left behind (QA-G-32); when even that removal fails (a file macOS keeps,
//   such as one marked immutable with chflags uchg), the error keeps the
//   step's own reason, gives the removal's and names the path to remove by
//   hand. A path the script did not make is never removed: anything already
//   at the copy's path, a symbolic link included, even one that leads
//   nowhere, stops the script before the ditto (QA-G-34).
// It prints the copy's path last, for PLAIN_SIGHT_APP=<path>. The original is
// never changed: a bundle sandboxed under the real identifier stays the D-39
// trap and is deleted once test:bundle has checked it. Nothing here opens
// either bundle. The whole copy is one function, makeTestCopy, which the
// harness also calls for a fresh copy when a real-key test needs a first
// launch of a sandboxed bundle (harness.mjs, freshStart, DM-247).
//
// Run from desktop/ after `npm run app:build`:
//   npm run app:testcopy [-- <destination folder>]
// The plist rewriting and the read-back are unit-tested on fake bundles
// (launch-guard-tests.mjs), with the signing and the codesign reads handed
// in; the signing and the verification themselves need a real bundle.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REAL_ID, bundleFacts, codesignEntitlements, refusal } from './launch-guard.mjs';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_NAME = 'Plain Sight test copy';
export const MANIFEST = 'Contents/Resources/container-migration.plist';
export const SIGNATURE = 'Contents/_CodeSignature';
export const testIdentifier = (stamp) => REAL_ID + '.testcopy-' + stamp;

// plutil with its complaint kept for the error, and ditto: the two calls the
// tests hand in.
const plutilRun = (args) => execFileSync('plutil', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const dittoRun = (source, copy) => execFileSync('ditto', [source, copy]);
const reasonOf = (err) => String((err && err.stderr) || (err && err.message) || err).trim();

// What is at a path, without following a symbolic link: existsSync follows
// links, so a link that leads nowhere would pass for nothing there (QA-G-34).
const entryAt = (p) => { try { return lstatSync(p); } catch { return null; } };

// The copy before it is signed: ditto, the identifier and the name rewritten,
// the manifest and the old signature removed. Returns the copy's path, which
// is fixed first and must not exist, as a link either: nothing at the
// destination is ever written over or removed. On a failure of the ditto or
// any step after it, this call removes the copy it made and the error names
// the step, so no copy under the real identifier, sandboxed and signed as the
// original, is left behind (QA-G-32); when the removal itself fails, the
// error keeps the step's reason and names the copy to remove by hand.
export function copyUnsigned(source, destination, stamp, { plutil = plutilRun, ditto = dittoRun } = {}) {
  if (!existsSync(path.join(source, 'Contents', 'Info.plist'))) throw new Error('no app bundle at ' + source + ' (npm run app:build makes one)');
  const copy = path.join(destination, TEST_NAME + '.app');
  if (entryAt(copy)) throw new Error(copy + ' exists already; remove it or name another destination');
  mkdirSync(destination, { recursive: true });
  const info = path.join(copy, 'Contents', 'Info.plist');
  const has = (key) => { try { plutil(['-extract', key, 'raw', '-o', '-', info]); return true; } catch { return false; } };
  let step = 'copy ' + source + ' with ditto';
  try {
    ditto(source, copy);
    for (const [key, value] of [['CFBundleIdentifier', testIdentifier(stamp)], ['CFBundleName', TEST_NAME], ['CFBundleDisplayName', TEST_NAME]]) {
      if (key === 'CFBundleDisplayName' && !has(key)) continue;
      step = 'set ' + key + ' in ' + info;
      plutil(['-replace', key, '-string', value, info]);
    }
    step = 'remove the migration manifest from ' + copy;
    rmSync(path.join(copy, MANIFEST), { force: true });
    step = 'remove the old signature from ' + copy;
    rmSync(path.join(copy, SIGNATURE), { recursive: true, force: true });
  } catch (err) {
    const cause = 'could not ' + step + ' (' + reasonOf(err) + ')';
    const made = entryAt(copy);
    if (!made) throw new Error(cause + '; nothing was left at ' + copy);
    // Never a link: one at the path before the ditto stopped the call above,
    // so a link here is someone else's, and stays.
    if (made.isSymbolicLink()) throw new Error(cause + '; ' + copy + ' is a symbolic link this call did not make, left as it is');
    try {
      rmSync(copy, { recursive: true, force: true });
    } catch (removal) {
      throw new Error(cause + '; the unfinished copy could not be removed (' + reasonOf(removal) + '): remove it by hand: ' + copy);
    }
    throw new Error(cause + '; the unfinished copy, which may still carry the real identifier, was removed: ' + copy);
  }
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

// The whole copy, as the script makes it and as the harness makes a fresh one
// (DM-247): the original's facts and entitlements read, the copy made
// (copyUnsigned), signed and verified (signCopy) and read back. Unless the
// identifier is the test identifier, the name the test name, the manifest
// gone, the entitlements exactly the original's and the launch guard lets the
// copy through, the copy is removed and the error says so (in its removal
// field, as a line of its own). Returns the original's facts, the copy's and
// the copy's path. The reads and the signing can be handed in, so the
// read-back is tested on fake bundles.
export function makeTestCopy(source, destination, stamp, { readFacts = bundleFacts, readEntitlements = codesignEntitlements, copy = copyUnsigned, sign = signCopy } = {}) {
  const original = readFacts(source);
  const xml = readEntitlements(source);
  const made = copy(source, destination, stamp);
  try {
    sign(made, xml, path.join(destination, 'entitlements-of-the-original.plist'));
    const facts = readFacts(made);
    const problems = [];
    if (facts.identifier !== testIdentifier(stamp)) problems.push('the identifier is ' + facts.identifier);
    if (facts.name !== TEST_NAME) problems.push('the name is ' + facts.name);
    if (existsSync(path.join(made, MANIFEST))) problems.push('the migration manifest is still in the copy');
    if (!sameEntitlements(facts.entitlements, original.entitlements)) problems.push('the entitlements differ from the original\'s: ' + JSON.stringify(facts.entitlements) + ' against ' + JSON.stringify(original.entitlements));
    const why = refusal(facts, {});
    if (why) problems.push('the launch guard would refuse the copy: ' + why);
    if (problems.length) throw new Error(problems.join('; '));
    return { original, made: facts, copy: made };
  } catch (err) {
    let removal = 'the unfinished copy was removed: ' + made;
    try {
      rmSync(made, { recursive: true, force: true });
    } catch (failed) {
      removal = 'the unfinished copy could not be removed (' + reasonOf(failed) + '): remove it by hand: ' + made;
    }
    throw Object.assign(new Error(err && err.message ? err.message : String(err)), { removal });
  }
}

function main() {
  const source = process.env.PLAIN_SIGHT_APP || path.join(DESKTOP, 'src-tauri/target/release/bundle/macos/Plain Sight.app');
  const stamp = Math.floor(Date.now() / 1000);
  const destination = process.argv[2] || path.join(process.env.PLAIN_SIGHT_EVIDENCE || path.join(os.homedir(), 'cover-story-delivery', 'desktop'), 'testcopy-' + stamp);
  try {
    const { made, copy } = makeTestCopy(source, destination, stamp);
    console.log('copied ' + source);
    console.log('identifier ' + made.identifier + ', name ' + made.name + ', sandboxed ' + made.sandboxed + ', entitlements ' + (Object.keys(made.entitlements).sort().join(' ') || 'none') + ', migration manifest left out');
    console.log('the original is unchanged; a bundle sandboxed under the real identifier is the D-39 trap: delete it once test:bundle has checked it');
    console.log('run the suites on the copy from desktop/: PLAIN_SIGHT_APP=' + JSON.stringify(copy) + ' npm run test:release, then the same with test:app');
    console.log(copy);
  } catch (err) {
    console.log('testcopy: ' + (err && err.message ? err.message : err) + '. Errors: 1');
    if (err && err.removal) console.log(err.removal);
    process.exit(1);
  }
}

const MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (MAIN) main();
