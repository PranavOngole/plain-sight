// Writes the two configuration files of the App Store build from the three
// values the Apple Developer Program gives (APPSTORE.md, step 6): the team
// id, the Apple Distribution signing identity and the provisioning profile.
//
// Run from desktop/:
//   npm run appstore:config -- --team <TEAMID> --identity "Apple Distribution: <name> (<TEAMID>)" --profile <path> [--build <n>] [--force]
//
// Into src-tauri/, next to tauri.conf.json (or into --out <folder>, which the
// tests use), it writes:
// - tauri.appstore.conf.json, which `npx tauri build --config` merges over
//   tauri.conf.json for the store build: the signing identity, the minimum
//   macOS of the everyday build (12.0), the App Store entitlements file, the
//   profile copied into the app as Contents/embedded.provisionprofile under
//   its absolute path, and with --build the build number
//   (bundle.macOS.bundleVersion);
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
// does not exist or that is not a file; a build number that is not a whole
// number from 1; an output folder that does not exist; an output file that
// exists already (unless --force) or that is no plain file; and anything it
// cannot read. The two files are written under temporary names and then
// renamed into place. No dependency: the property lists go through macOS's
// plutil. Tested by tests/appstore-config-tests.mjs.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const USAGE = 'npm run appstore:config -- --team <TEAMID> --identity "Apple Distribution: <name> (<TEAMID>)" --profile <path> [--build <n>] [--force]';

// A refusal: the command stops with this message and writes nothing.
export class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

// The command line: --team, --identity and --profile, each once; --build and
// --out at most once; --force alone. Paths are taken from the current folder.
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
  return {
    team: values.team,
    identity: values.identity,
    profile: path.resolve(cwd, values.profile),
    build: Object.hasOwn(values, 'build') ? values.build : null,
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
  if (!identity.endsWith(' (' + team + ')')) refuse('the identity must end with "(' + team + ')", the team id given: ' + JSON.stringify(identity));
  if (!identity.slice(IDENTITY_PREFIX.length, identity.length - (team.length + 3)).trim()) refuse('the identity names no one between "' + IDENTITY_PREFIX + '" and "(' + team + ')": ' + JSON.stringify(identity));
  if (/[\u0000-\u001f\u007f]/.test(identity)) refuse('the identity holds a control character: ' + JSON.stringify(identity));
  if (!path.basename(profile).endsWith(PROFILE_EXTENSION)) refuse('the profile must be the ' + PROFILE_EXTENSION + ' file downloaded in step 4: ' + profile);
  const repositoryReal = realOrNull(repository) || repository;
  const profileReal = realOrNull(profile);
  if (inside(profile, repository) || inside(profile, repositoryReal) || (profileReal && (inside(profileReal, repository) || inside(profileReal, repositoryReal)))) refuse('the profile lies inside the repository (' + repository + '); keep it outside, as step 4 says: ' + profile);
  if (!existsSync(profile)) refuse('there is no profile at ' + profile);
  if (!statSync(profile).isFile()) refuse('the profile is not a file: ' + profile);
  if (build !== null && !/^[1-9][0-9]*$/.test(build)) refuse('the build number must be a whole number from 1, such as 1 or 2: ' + JSON.stringify(build));
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
  const macOS = { signingIdentity: identity, minimumSystemVersion: minimum, entitlements: './' + ENTITLEMENTS_NAME, files: { 'embedded.provisionprofile': profile } };
  if (build !== null) macOS.bundleVersion = build;
  const storeEntitlements = { ...entitlements, [APPLICATION_IDENTIFIER]: team + '.' + identifier, [TEAM_IDENTIFIER]: team };
  let plist;
  try {
    plist = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(storeEntitlements), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) { refuse('plutil could not write the entitlements (' + String((err && err.stderr) || err.message).trim() + ')'); }
  return { files: [[configPath, JSON.stringify({ bundle: { macOS } }, null, 2) + '\n'], [entitlementsPath, plist]] };
}

// Writes the two files, each under a temporary name first and then renamed
// into place, so a failed write leaves neither half done.
export function write({ files }) {
  const temporary = files.map(([target, text]) => [target + '.tmp-' + process.pid, target, text]);
  try {
    for (const [tmp, , text] of temporary) writeFileSync(tmp, text, { flag: 'wx' });
    for (const [tmp, target] of temporary) renameSync(tmp, target);
  } finally {
    for (const [tmp] of temporary) rmSync(tmp, { force: true });
  }
  return files.map(([target]) => target);
}

function main() {
  try {
    const written = write(plan(parseArgs(process.argv.slice(2))));
    for (const target of written) console.log('written: ' + target);
    console.log('Both hold this Mac\'s path to the profile and the team\'s identifiers and are not committed (desktop/.gitignore). Build with: npx tauri build --bundles app --config src-tauri/' + CONFIG_NAME);
  } catch (err) {
    // A refusal names what to change; any other error (a write the disk
    // refused, say) is reported as plainly, and its temporary files are gone.
    console.log('appstore-config: ' + (err instanceof Refusal ? 'not written: ' : 'failed: ') + (err && err.message ? err.message : err) + '. Errors: 1');
    process.exit(1);
  }
}

const MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (MAIN) main();
