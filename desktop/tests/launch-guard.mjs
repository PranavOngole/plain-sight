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
// plutil) and from the bundle's signature (codesign -dv, its Identifier=
// line), and the entitlements from the signature (codesign -d
// --entitlements - --xml), and refuses a sandboxed bundle (the entitlement
// com.apple.security.app-sandbox present with any value but false) when
// either identifier is the real one, in any case and with spaces around it
// (QA-01's observations 2 to 4 on 867d639).
// PLAIN_SIGHT_ALLOW_REAL_ID=1 lifts the refusal, for the deliberate run after
// the move. A sandboxed copy under a test identifier (tests/testcopy.mjs,
// `npm run app:testcopy`) passes, and so does an unsandboxed bundle under the
// real identifier (the app as Pranav runs it today). A path with no
// Info.plist, or a signature codesign cannot read, is refused too: nothing
// unknown is opened.
//
// The codesign calls go through one injectable function (codesignRead,
// asked for the entitlements or the identifier), so the unit tests
// (tests/launch-guard-tests.mjs) hand in a property list text and an
// identifier and sign nothing.

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

// The identifier the bundle's signature carries, from the Identifier= line
// codesign -dv prints (on stderr). A bundle can name a test identifier in its
// Info.plist and carry the real one in its signature; which of the two names
// the container then is not known here, so the guard refuses either (QA-01
// observation 3).
export function codesignIdentifier(app) {
  const shown = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' });
  if (shown.status !== 0) throw new Error('codesign could not read the signature of ' + app + ': ' + String(shown.stderr || '').trim());
  const line = String(shown.stderr || '').split('\n').find((l) => l.startsWith('Identifier='));
  if (!line) throw new Error('codesign named no identifier in the signature of ' + app);
  return line.slice('Identifier='.length);
}

// The one codesign function the tests replace: what the signature holds,
// its entitlements or its identifier.
export const codesignRead = (app, request) => (request === 'identifier' ? codesignIdentifier(app) : codesignEntitlements(app));

// The real identifier in any case and with spaces around it, so a variant
// such as Com.PranavOngole.PlainSight is refused like the real one (QA-01
// observation 2; whether macOS would give such a bundle the real container
// is not known here).
const isRealId = (id) => typeof id === 'string' && id.trim().toLowerCase() === REAL_ID;

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
// identifier and the entitlements its signature carries, and whether they
// put it in the App Sandbox: the sandbox entitlement present with any value
// but false, so a string "true" or an integer 1 counts too (QA-01
// observation 4). Throws, with a plain reason, for anything that is not a
// readable signed bundle.
export function bundleFacts(app, { codesign = codesignRead } = {}) {
  const info = path.join(app, 'Contents', 'Info.plist');
  if (!existsSync(info)) throw new Error('no app bundle at ' + app + ' (there is no Contents/Info.plist)');
  let plist;
  try { plist = plistOf(info); } catch (err) { throw new Error('plutil could not read ' + info + ': ' + String(err && err.stderr ? err.stderr : err).trim()); }
  const identifier = plist.CFBundleIdentifier;
  if (typeof identifier !== 'string' || !identifier) throw new Error(info + ' names no CFBundleIdentifier');
  const xml = String(codesign(app, 'entitlements'));
  const entitlements = xml.trim() ? plistFromText(xml) : {};
  const signed = codesign(app, 'identifier');
  return {
    app, identifier, signatureIdentifier: typeof signed === 'string' ? signed : null, name: String(plist.CFBundleName || ''), entitlements,
    sandboxed: Object.hasOwn(entitlements, SANDBOX) && entitlements[SANDBOX] !== false
  };
}

// The app menu's title as macOS shows it: the bundle's CFBundleName. On a
// copy made by testcopy.mjs that is "Plain Sight test copy", while the
// menu's items keep the app's own words, "About Plain Sight", "Hide Plain
// Sight" and "Quit Plain Sight" (release-run-1, 26 October 2026, run.log
// line 59). So the two suites take the title from the bundle they open
// (DM-241).
export const appMenuTitle = (facts) => facts.name;
// The menu bar the two suites expect of that bundle, Apple's menu left out.
export const menuBarOf = (facts) => [appMenuTitle(facts), 'File', 'Edit', 'View', 'Window', 'Help'];

// null when the bundle may be opened, else the reason it may not: a bundle
// sandboxed under the real identifier, in its Info.plist or its signature,
// unless the override is exactly "1".
export function refusal(facts, env = process.env) {
  if (!facts.sandboxed) return null;
  const under = [['Info.plist', facts.identifier], ['signature', facts.signatureIdentifier]].filter(([, id]) => isRealId(id));
  if (!under.length) return null;
  if (env[OVERRIDE] === '1') return null;
  return facts.app + ' is sandboxed under the real bundle identifier ' + REAL_ID + ' (' + under.map(([where, id]) => where + ' ' + JSON.stringify(id)).join(', ') + '). The first time such a bundle opens, macOS creates the app\'s real container and brings the app\'s data into it, once; with the data moved aside for a test run that would leave an empty container and block the later move (ledger D-39), so this suite does not open it. Make a copy under a test identifier with `npm run app:testcopy` in desktop/ (tests/testcopy.mjs) and run the suite with PLAIN_SIGHT_APP=<the copy it prints>. Only for the deliberate run after the move of the app\'s data, ' + OVERRIDE + '=1 lifts this refusal. Delete the real-identifier bundle once test:bundle has checked it.';
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
// rule the container migration manifest in src-tauri follows; seen in a
// launched sandboxed probe build on 26 October (sbprobe2-run-1, test
// migrate)).
export function webDataFolder(home, facts) {
  return facts.sandboxed
    ? path.join(home, 'Library', 'Containers', facts.identifier, 'Data', 'Library', 'WebKit', 'WebsiteData')
    : path.join(home, 'Library', 'WebKit', facts.identifier);
}
