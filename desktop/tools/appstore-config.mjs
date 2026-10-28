// Writes the two configuration files of the App Store build from the three
// values the Apple Developer Program gives (APPSTORE.md, step 6): the team
// id, the Apple Distribution signing identity and the provisioning profile.
//
// Run from desktop/:
//   npm run appstore:config -- --team <TEAMID> --identity "Apple Distribution: <name> (<TEAMID>)" --profile <path> --build <n> [--force]
//
// Into src-tauri/, next to tauri.conf.json (or into --out <folder>, which the
// tests use), it writes:
// - tauri.appstore.conf.json, which `npx tauri build --config` merges over
//   tauri.conf.json for the store build: the signing identity, the minimum
//   macOS of the everyday build (12.0), the App Store entitlements file, the
//   profile copied into the app as Contents/embedded.provisionprofile under
//   its absolute path, and the build number given with --build
//   (bundle.macOS.bundleVersion): 1 for the first store build and a higher
//   number for every later upload (DM-252);
// - Entitlements.appstore.plist: every entitlement of Entitlements.plist,
//   read from that file each time (so one added there later carries over),
//   plus com.apple.application-identifier (<TEAMID>.<the identifier in
//   tauri.conf.json>) and com.apple.developer.team-identifier (<TEAMID>),
//   which tie the app to the profile.
// Both hold a path on this Mac and the team's identifiers, so
// desktop/.gitignore keeps them out of the repository. Everything is checked
// before anything is written, and the command refuses, with a plain message,
// exit code 1 and nothing written: a team id that is not ten upper-case
// letters or digits; an identity that is not "Apple Distribution: <name>
// (<TEAMID>)"; a profile whose name does not end in .provisionprofile, that
// lies inside the repository (as given or once its links are followed), that
// does not exist or that is not a file; no build number, or one that is not
// a whole number from 1; an output folder that does not exist; an output
// file that exists already (unless --force) or that is no plain file; and
// anything it cannot read. The two files are written under temporary names
// and then renamed into place as one step: when the second cannot be put in
// place, the first is put back as it was (DM-253). No dependency: the
// property lists go through macOS's plutil. Tested by
// tests/appstore-config-tests.mjs.

import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY = path.resolve(DESKTOP, '..');
export const TAURI = path.join(DESKTOP, 'src-tauri');
export const CONFIG_NAME = 'tauri.appstore.conf.json';
export const ENTITLEMENTS_NAME = 'Entitlements.appstore.plist';
export const APPLICATION_IDENTIFIER = 'com.apple.application-identifier';
export const TEAM_IDENTIFIER = 'com.apple.developer.team-identifier';
const IDENTITY_PREFIX = 'Apple Distribution: ';
const PROFILE_EXTENSION = '.provisionprofile';
const USAGE = 'npm run appstore:config -- --team <TEAMID> --identity "Apple Distribution: <name> (<TEAMID>)" --profile <path> --build <n> [--force]';

// A refusal: the command stops with this message and writes nothing.
export class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

// The command line: --team, --identity, --profile and --build, each once;
// --out at most once; --force alone. Paths are taken from the current folder.
// The build number has no default (DM-252): a store build without one takes
// its CFBundleVersion from the version, 1.0.0 (Tauri's App Store guide, Build
// and upload), which Apple reads as the same build as 1 (CFBundleVersion:
// "missing integers in the format are interpreted as zeros"), so a first
// re-upload with --build 1 would repeat the first upload's build.
export function parseArgs(argv, { cwd = process.cwd() } = {}) {
  const values = {};
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') { force = true; continue; }
    if (!['--team', '--identity', '--profile', '--build', '--out'].includes(arg)) refuse('unknown argument ' + JSON.stringify(arg) + '; usage: ' + USAGE);
    if (i + 1 >= argv.length) refuse(arg + ' needs a value; usage: ' + USAGE);
    const key = arg.slice(2);
    if (Object.hasOwn(values, key)) refuse(arg + ' is given twice');
    i += 1;
    values[key] = argv[i];
  }
  for (const key of ['team', 'identity', 'profile']) if (!values[key]) refuse('--' + key + ' is missing; usage: ' + USAGE);
  if (!Object.hasOwn(values, 'build')) refuse('--build is missing: give --build 1 for the first store build and a higher number for every later upload (without it the build would carry the version, 1.0.0, which Apple counts as the same build as 1); usage: ' + USAGE);
  return {
    team: values.team,
    identity: values.identity,
    profile: path.resolve(cwd, values.profile),
    build: values.build,
    out: Object.hasOwn(values, 'out') ? path.resolve(cwd, values.out) : TAURI,
    force
  };
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const realOrNull = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const entryAt = (p) => { try { return lstatSync(p); } catch { return null; } };
const plistJson = (file) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

// Every check, then the two files' contents; nothing is written here.
export function plan(options, { entitlementsFile = path.join(TAURI, 'Entitlements.plist'), tauriConfFile = path.join(TAURI, 'tauri.conf.json'), repository = REPOSITORY } = {}) {
  const { team, identity, profile, build, out, force } = options;
  if (!/^[A-Z0-9]{10}$/.test(team)) refuse('the team id must be ten upper-case letters or digits, as Membership details shows it: ' + JSON.stringify(team));
  if (!identity.startsWith(IDENTITY_PREFIX)) refuse('the identity must start with "' + IDENTITY_PREFIX + '", as security find-identity -v lists the Apple Distribution certificate: ' + JSON.stringify(identity));
  if (!identity.endsWith(' (' + team + ')')) refuse('the identity must end with " (' + team + ')", a space and the team id given, in brackets: ' + JSON.stringify(identity));
  if (!identity.slice(IDENTITY_PREFIX.length, identity.length - (team.length + 3)).trim()) refuse('the identity names no one between "' + IDENTITY_PREFIX + '" and "(' + team + ')": ' + JSON.stringify(identity));
  if (/[\u0000-\u001f\u007f]/.test(identity)) refuse('the identity holds a control character: ' + JSON.stringify(identity));
  if (!path.basename(profile).endsWith(PROFILE_EXTENSION)) refuse('the profile must be the ' + PROFILE_EXTENSION + ' file downloaded in step 4: ' + profile);
  const repositoryReal = realOrNull(repository) || repository;
  const profileReal = realOrNull(profile);
  if (inside(profile, repository) || inside(profile, repositoryReal) || (profileReal && (inside(profileReal, repository) || inside(profileReal, repositoryReal)))) refuse('the profile lies inside the repository (' + repository + '); keep it outside, as step 4 says: ' + profile);
  if (!existsSync(profile)) refuse('there is no profile at ' + profile);
  if (!statSync(profile).isFile()) refuse('the profile is not a file: ' + profile);
  if (typeof build !== 'string' || !/^[1-9][0-9]*$/.test(build)) refuse('the build number must be a whole number from 1, such as 1 or 2: ' + JSON.stringify(build));
  const outEntry = existsSync(out) ? statSync(out) : null;
  if (!outEntry || !outEntry.isDirectory()) refuse('there is no folder at ' + out);
  const configPath = path.join(out, CONFIG_NAME);
  const entitlementsPath = path.join(out, ENTITLEMENTS_NAME);
  for (const target of [configPath, entitlementsPath]) {
    const entry = entryAt(target);
    if (entry && !entry.isFile()) refuse(target + ' is there and is no plain file (a link or a folder); remove it first');
    if (entry && !force) refuse(target + ' exists already; pass --force to replace it');
  }
  let conf;
  try { conf = JSON.parse(readFileSync(tauriConfFile, 'utf8')); } catch (err) { refuse('could not read ' + tauriConfFile + ' (' + (err.code || err.message) + ')'); }
  const identifier = conf.identifier;
  if (typeof identifier !== 'string' || !identifier) refuse(tauriConfFile + ' names no identifier');
  const minimum = conf.bundle && conf.bundle.macOS && conf.bundle.macOS.minimumSystemVersion;
  if (typeof minimum !== 'string' || !minimum) refuse(tauriConfFile + ' names no bundle.macOS.minimumSystemVersion');
  let entitlements;
  try { entitlements = plistJson(entitlementsFile); } catch (err) { refuse('could not read ' + entitlementsFile + ' as a property list (' + String((err && err.stderr) || err.message).trim() + ')'); }
  if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)) refuse(entitlementsFile + ' holds no dictionary of entitlements');
  for (const key of [APPLICATION_IDENTIFIER, TEAM_IDENTIFIER]) if (Object.hasOwn(entitlements, key)) refuse(entitlementsFile + ' already holds ' + key + ', which only the App Store entitlements may hold');
  const macOS = { signingIdentity: identity, minimumSystemVersion: minimum, entitlements: './' + ENTITLEMENTS_NAME, files: { 'embedded.provisionprofile': profile }, bundleVersion: build };
  const storeEntitlements = { ...entitlements, [APPLICATION_IDENTIFIER]: team + '.' + identifier, [TEAM_IDENTIFIER]: team };
  let plist;
  try {
    plist = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(storeEntitlements), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) { refuse('plutil could not write the entitlements (' + String((err && err.stderr) || err.message).trim() + ')'); }
  return { files: [[configPath, JSON.stringify({ bundle: { macOS } }, null, 2) + '\n'], [entitlementsPath, plist]] };
}

// Writes the two files as one step (DM-253). Each is written under a
// temporary name first, made anew (the exclusive flag, so nothing already at
// that name is followed), and then renamed into place, the configuration
// first. Before that first rename, an earlier configuration at its place (one
// --force replaces) is kept under a second name, a hard link to the same
// file. If the second rename then fails (an earlier entitlements file that
// macOS will not let the command replace, say), the first file is put back as
// it was: that earlier file, or no file when there was none. So a failed
// write leaves neither half done, and the refusal says what is back. The
// temporary files, and an earlier file kept and no longer needed, are
// removed at the end. rename, link and unlink are handed in, so a test can
// make one fail.
export function write({ files }, { rename = renameSync, link = linkSync, unlink = unlinkSync } = {}) {
  const steps = files.map(([target, text]) => ({ target, text, tmp: target + '.tmp-' + process.pid, earlier: target + '.earlier-' + process.pid, kept: false, stranded: false }));
  const placed = [];
  try {
    for (const s of steps) writeFileSync(s.tmp, s.text, { flag: 'wx' });
    // Only a file placed before another can need putting back.
    for (const s of steps.slice(0, -1)) {
      if (!entryAt(s.target)) continue;
      try { link(s.target, s.earlier); } catch (err) { refuse('could not keep the earlier ' + s.target + ' to put it back should the write fail (' + reason(err) + ')'); }
      s.kept = true;
    }
    for (const s of steps) {
      try { rename(s.tmp, s.target); } catch (err) {
        if (!placed.length) throw err;
        throw putBack(placed, s, err, { rename, unlink });
      }
      placed.push(s);
    }
  } finally {
    for (const s of steps) {
      rmSync(s.tmp, { force: true });
      if (s.kept && !s.stranded) rmSync(s.earlier, { force: true });
    }
  }
  return files.map(([target]) => target);
}

const reason = (err) => (err && err.message) || String(err);
// After a rename failed, each file already placed is put back, the last
// first: the earlier file kept for it, or none. Returns the refusal that says
// so, or, when a file cannot be put back, an error that says where its
// earlier file waits (that file is then kept, never removed).
function putBack(placed, failed, err, { rename, unlink }) {
  const back = [];
  const problems = [];
  for (const p of [...placed].reverse()) {
    try {
      if (p.kept) { rename(p.earlier, p.target); back.push(p.target + ' is back as it was'); } else { unlink(p.target); back.push(p.target + ' was removed again'); }
    } catch (undoErr) {
      p.stranded = p.kept;
      problems.push(p.kept ? 'could not put the earlier ' + p.target + ' back (' + reason(undoErr) + '): it is at ' + p.earlier + '; move it back by hand' : 'could not remove the new ' + p.target + ' again (' + reason(undoErr) + '): remove it by hand');
    }
  }
  const first = 'could not put ' + failed.target + ' in place (' + reason(err) + ')';
  return problems.length ? new Error(first + ', and ' + problems.join('; ')) : new Refusal(first + '; ' + back.join('; '));
}

// The one line a run that fails prints: a refusal ("not written:", with what
// to change) or any other error ("failed:"), and the error count.
export const failureLine = (err) => 'appstore-config: ' + (err instanceof Refusal ? 'not written: ' : 'failed: ') + (err && err.message ? err.message : err) + '. Errors: 1';

function main() {
  try {
    const written = write(plan(parseArgs(process.argv.slice(2))));
    for (const target of written) console.log('written: ' + target);
    console.log('Both hold this Mac\'s path to the profile and the team\'s identifiers and are not committed (desktop/.gitignore). Build with: npx tauri build --bundles app --config src-tauri/' + CONFIG_NAME + '. Before every later upload, run this again with a higher --build and --force.');
  } catch (err) {
    // A refusal names what to change; any other error (a write the disk
    // refused, say) is reported as plainly, and its temporary files are gone.
    console.log(failureLine(err));
    process.exit(1);
  }
}

// Started as the command, however the path to it was typed: Node takes the
// module at its real path (through a link to the script, a linked folder, or
// /tmp, which macOS links to /private/tmp), so both are compared as real
// paths. Before, such a start ran nothing and ended with exit code 0
// (QA-G-41).
const realOrAsGiven = (p) => { try { return realpathSync(p); } catch { return p; } };
const MAIN = Boolean(process.argv[1]) && realOrAsGiven(path.resolve(process.argv[1])) === realOrAsGiven(fileURLToPath(import.meta.url));
if (MAIN) main();
