// The launch guard for the two suites that open an app bundle, release.mjs
// and app.mjs, and the facts about the bundle they need (DM-240, ledger D-39).
//
// On this branch `npm run app:build` makes a bundle that is sandboxed under
// the app's real bundle identifier, com.pranavongole.plainsight. The first
// time such a bundle opens on a Mac, macOS creates the app's container and
// brings the app's data into it, once (the migration manifest in
// src-tauri). On Pranav's Mac, before his move into the sandboxed app, a test
// run would open it with his data moved aside by the harness: an empty
// container would be made, and macOS would not migrate his vault later
// (D-39). So each suite reads the bundle first, before the harness's run()
// moves anything aside: the identifier from Contents/Info.plist (through
// plutil) and the entitlements from the bundle's signature (codesign -d
// --entitlements - --xml), and refuses a bundle that carries
// com.apple.security.app-sandbox true under the real identifier.
// PLAIN_SIGHT_ALLOW_REAL_ID=1 lifts the refusal, for the deliberate run after
// the move. A sandboxed copy under a test identifier (tests/testcopy.mjs,
// `npm run app:testcopy`) passes, and so does an unsandboxed bundle under the
// real identifier (the app as Pranav runs it today). A path with no
// Info.plist, or a signature codesign cannot read, is refused too: nothing
// unknown is opened.
//
// The codesign call is one injectable function, so the unit tests
// (tests/launch-guard-tests.mjs) hand in a property list text and sign
// nothing.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const REAL_ID = 'com.pranavongole.plainsight';
export const SANDBOX = 'com.apple.security.app-sandbox';
export const OVERRIDE = 'PLAIN_SIGHT_ALLOW_REAL_ID';
// The exit code of a suite that refused its bundle, before any lock or backup.
export const REFUSED = 7;

// A property list as plutil reads it: a file, or a text on plutil's stdin.
// plutil's own complaint stays out of the console; the caller names the file.
const plistOf = (file) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const plistFromText = (xml) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));

// The entitlements in the bundle's signature, as codesign prints them: an XML
// property list, or nothing for a signature that carries none. An error names
// codesign's reason (an unsigned folder, no bundle at all).
export function codesignEntitlements(app) {
  const shown = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', app], { encoding: 'utf8' });
  if (shown.status !== 0) throw new Error('codesign could not read the signature of ' + app + ': ' + String(shown.stderr || '').trim());
  return shown.stdout;
}

// The bundle's identifier from its Info.plist, or null when there is no
// readable bundle at the path (the harness reads this at import; the suite's
// guard then gives its own message).
export function bundleIdentifier(app) {
  try {
    const id = plistOf(path.join(app, 'Contents', 'Info.plist')).CFBundleIdentifier;
    return typeof id === 'string' && id ? id : null;
  } catch { return null; }
}

// What the guard reads of a bundle: its identifier and name (Info.plist), the
// entitlements its signature carries, and whether they put it in the App
// Sandbox. Throws, with a plain reason, for anything that is not a readable
// signed bundle.
export function bundleFacts(app, { codesign = codesignEntitlements } = {}) {
  const info = path.join(app, 'Contents', 'Info.plist');
  if (!existsSync(info)) throw new Error('no app bundle at ' + app + ' (there is no Contents/Info.plist)');
  let plist;
  try { plist = plistOf(info); } catch (err) { throw new Error('plutil could not read ' + info + ': ' + String(err && err.stderr ? err.stderr : err).trim()); }
  const identifier = plist.CFBundleIdentifier;
  if (typeof identifier !== 'string' || !identifier) throw new Error(info + ' names no CFBundleIdentifier');
  const xml = String(codesign(app));
  const entitlements = xml.trim() ? plistFromText(xml) : {};
  return { app, identifier, name: String(plist.CFBundleName || ''), entitlements, sandboxed: entitlements[SANDBOX] === true };
}

// null when the bundle may be opened, else the reason it may not: a bundle
// sandboxed under the real identifier, unless the override is exactly "1".
export function refusal(facts, env = process.env) {
  if (!(facts.sandboxed && facts.identifier === REAL_ID)) return null;
  if (env[OVERRIDE] === '1') return null;
  return facts.app + ' is sandboxed under the real bundle identifier ' + REAL_ID + '. The first time such a bundle opens, macOS creates the app\'s real container and brings the app\'s data into it, once; with the data moved aside for a test run that would leave an empty container and block the later move (ledger D-39), so this suite does not open it. Make a copy under a test identifier with `npm run app:testcopy` in desktop/ (tests/testcopy.mjs) and run the suite with PLAIN_SIGHT_APP=<the copy it prints>. Only for the deliberate run after the move of the app\'s data, ' + OVERRIDE + '=1 lifts this refusal. Delete the real-identifier bundle once test:bundle has checked it.';
}

// The verdict on a path: its facts and null, or the reason it may not be
// opened (a refusal, or whatever kept the facts from being read).
export function verdict(app, { codesign, env } = {}) {
  try {
    const facts = bundleFacts(app, codesign ? { codesign } : {});
    return { facts, why: refusal(facts, env) };
  } catch (err) {
    return { facts: null, why: String(err && err.message ? err.message : err) };
  }
}

// What each suite calls before anything else, at module level, before the
// harness's run(): the bundle's facts, or the refusal printed with an Errors
// line and the process ended with exit code 7.
export function launchable(suite, app, options = {}) {
  const { facts, why } = verdict(app, options);
  if (why) {
    console.log(suite + ': not started: ' + why + ' Errors: 1');
    process.exit(REFUSED);
  }
  return facts;
}

// Where WebKit keeps the bundle's web data. Outside the sandbox, under the
// identifier in the home folder's Library/WebKit; inside it, in the app's
// container without the identifier (WebKit, WebsiteDataStoreCocoa.mm: the
// rule the container migration manifest in src-tauri follows, not yet seen
// in a launched sandboxed build).
export function webDataFolder(home, facts) {
  return facts.sandboxed
    ? path.join(home, 'Library', 'Containers', facts.identifier, 'Data', 'Library', 'WebKit', 'WebsiteData')
    : path.join(home, 'Library', 'WebKit', facts.identifier);
}
