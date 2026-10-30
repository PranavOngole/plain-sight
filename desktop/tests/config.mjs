// Static checks of the desktop app's configuration: the promises the shell
// makes in its config files, checked on every `npm test` so an edit that
// breaks one fails at once instead of in a built app.
//
// Run from the repository root: node desktop/tests/config.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESKTOP, '..');
const TAURI = path.join(DESKTOP, 'src-tauri');
const read = (...p) => readFileSync(path.join(...p), 'utf8');
const conf = JSON.parse(read(TAURI, 'tauri.conf.json'));
const cargo = read(TAURI, 'Cargo.toml');

// The [section] of a TOML file as key = value text, or null.
function tomlSection(text, name) {
  const start = text.indexOf('[' + name + ']\n');
  if (start < 0) return null;
  const rest = text.slice(start + name.length + 3);
  const end = rest.search(/^\[/m);
  return end < 0 ? rest : rest.slice(0, end);
}

// A strict reader for the three small property lists the shell ships,
// Entitlements.plist, container-migration.plist and Info.plist: a dict,
// arrays, strings, true and false only. Anything else, a comment or a key
// given twice included, is refused, so nothing in them can go unread.
function readPlist(text) {
  const header = /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*<plist version="1\.0">/;
  assert.match(text, header, 'a property list');
  const tokens = text.replace(header, '').match(/<[^>]*>|[^<]+/g).filter((t) => t.trim());
  let i = 0;
  const value = () => {
    const t = tokens[i++];
    if (t === '<true/>') return true;
    if (t === '<false/>') return false;
    if (t === '<string>') {
      const s = tokens[i] === '</string>' ? '' : tokens[i++];
      assert.equal(tokens[i++], '</string>', 'a string ends');
      return s;
    }
    if (t === '<array>') {
      const items = [];
      while (tokens[i] !== '</array>') items.push(value());
      i += 1;
      return items;
    }
    if (t === '<dict>') {
      const dict = {};
      while (tokens[i] !== '</dict>') {
        assert.equal(tokens[i++], '<key>', 'a dict holds keys');
        const key = tokens[i++];
        assert.equal(tokens[i++], '</key>', 'a key ends');
        assert.ok(!Object.hasOwn(dict, key), 'no key twice: ' + key);
        dict[key] = value();
      }
      i += 1;
      return dict;
    }
    throw new Error('not allowed in the property list: ' + t);
  };
  const root = value();
  assert.deepEqual(tokens.slice(i), ['</plist>'], 'nothing after the property list');
  return root;
}

// The app's own commands, from build.rs.
function declaredCommands() {
  const m = read(TAURI, 'build.rs').match(/\.commands\(&\[([^\]]*)\]\)/);
  assert.ok(m, 'build.rs declares the app commands with AppManifest::commands');
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the release profile builds the smallest app (DR-06)', () => {
  const profile = tomlSection(cargo, 'profile.release');
  assert.ok(profile, 'Cargo.toml has a [profile.release] section');
  for (const line of ['codegen-units = 1', 'lto = true', 'opt-level = "s"', 'panic = "abort"', 'strip = true']) {
    assert.ok(profile.split('\n').map((l) => l.trim()).includes(line), 'the release profile has ' + line);
  }
});

test('the shell serves exactly the page\'s own content security policy and adds nothing to it (DR-04)', () => {
  const meta = read(ROOT, 'index.html').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(meta, 'index.html carries its policy');
  assert.equal(conf.app.security.csp, meta[1]);
  assert.equal(conf.app.security.dangerousDisableAssetCspModification, true, 'no nonces or hashes added');
  assert.equal(conf.app.security.freezePrototype, true);
  assert.equal(conf.app.withGlobalTauri, false);
  assert.equal(conf.build.devUrl, undefined, 'no development server: dev serves the copied files like the release');
});

test('no updater, no telemetry plugin, no remote content in the config (DR-04)', () => {
  assert.equal(conf.plugins, undefined, 'no plugin configuration at all');
  assert.notEqual(conf.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(conf.app.windows, [], 'the window is built in Rust with its handlers');
  assert.match(conf.build.frontendDist, /^\.\.\/frontend$/, 'the app serves the copied page, not a URL');
});

test('the capability grants only the app\'s own commands to the main window, on the app\'s own origin (D-10)', () => {
  const files = readdirSync(path.join(TAURI, 'capabilities'));
  assert.deepEqual(files, ['main.json'], 'one capability file');
  const cap = JSON.parse(read(TAURI, 'capabilities', 'main.json'));
  assert.deepEqual(cap.windows, ['main']);
  assert.equal(cap.local, true);
  assert.equal(cap.remote, undefined, 'no remote origin');
  const granted = cap.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
  for (const p of granted) assert.match(p, /^allow-[a-z-]+$/, 'only app command permissions, no core: or plugin permission: ' + p);
  assert.deepEqual(granted.map((p) => p.slice('allow-'.length).replace(/-/g, '_')).sort(), declaredCommands(), 'every declared command is granted and nothing else');
});

// Every dependency name in Cargo.toml, in any of the ways TOML can write one:
// a "name = ..." line under a dependencies table, or a [*.dependencies.name] table.
function dependencyNames() {
  const names = [];
  let inDeps = false;
  for (const raw of cargo.split('\n')) {
    const line = raw.trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      const table = header[1].replace(/'[^']*'/g, '');
      const named = table.match(/dependencies\.([A-Za-z0-9_-]+)$/);
      if (named) { names.push(named[1]); inDeps = false; } else inDeps = /(^|\.)(build-|dev-)?dependencies$/.test(table);
      continue;
    }
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (inDeps && entry) names.push(entry[1]);
  }
  return names;
}

// Every line inside a dependencies table of Cargo.toml, [dependencies] and
// [x.dependencies.name] alike.
function dependencyLines() {
  const lines = [];
  let inDeps = false;
  for (const raw of cargo.split('\n')) {
    const line = raw.trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) { inDeps = /(^|\.)(build-|dev-)?dependencies(\.|$)/.test(header[1].replace(/'[^']*'/g, '')); continue; }
    if (inDeps && line && !line.startsWith('#')) lines.push(line);
  }
  return lines;
}

test('the shell links no network crate and no Tauri plugin beyond the folder picker (DR-04, DR-06)', () => {
  const deps = dependencyNames();
  assert.ok(deps.includes('tauri') && deps.includes('rfd'), 'the dependency list was read: ' + deps.join(', '));
  for (const d of deps) {
    assert.ok(!/^(reqwest|hyper|ureq|isahc|curl|rustls|native-tls|openssl|tungstenite|websocket|h2|surf|attohttpc)([-_].*)?$/.test(d), 'no network crate: ' + d);
    assert.ok(!d.startsWith('tauri-plugin-'), 'no Tauri plugin: ' + d);
  }
});

test('every crate comes from crates.io under its own name: no renamed, git, path or patched dependency (QA-C-05)', () => {
  // A renamed dependency (name = { package = "reqwest" }) would slip past the
  // name check above; a git, path or patched source would bypass the pinned
  // registry versions. The bundle check reads the resolved build graph too.
  const source = /(^|[{,])\s*(package|git|path|registry|branch|rev|tag)\s*=/;
  for (const line of dependencyLines()) assert.ok(!source.test(line), 'no renamed or non-registry dependency: ' + line);
  assert.ok(!/^\[(patch|replace)([.\]])/m.test(cargo), 'no [patch] or [replace] section');
  const lock = read(TAURI, 'Cargo.lock');
  const sources = [...lock.matchAll(/^source = "([^"]+)"$/gm)].map((m) => m[1]);
  assert.ok(sources.length > 100, 'the lock file was read: ' + sources.length + ' sources');
  for (const src of new Set(sources)) assert.equal(src, 'registry+https://github.com/rust-lang/crates.io-index', 'every locked crate is from crates.io');
});

test('Tauri is pinned and built without extra features; the test hook is never on by default (DM-205)', () => {
  const tauri = cargo.match(/^tauri = \{ version = "([^"]+)", features = \[([^\]]*)\] \}$/m);
  assert.ok(tauri, 'the tauri dependency line has its expected shape');
  assert.match(tauri[1], /^=\d+\.\d+\.\d+$/, 'tauri is pinned to one version');
  assert.equal(tauri[2].trim(), '', 'no tauri features (no devtools, no asset protocol)');
  for (const crate of ['tauri-build', 'rfd']) assert.match(cargo, new RegExp('^' + crate + ' = \\{ version = "=\\d', 'm'), crate + ' is pinned');
  const features = tomlSection(cargo, 'features') || '';
  assert.ok(!/^default\s*=/m.test(features), 'no default features: the e2e hook is built only when asked for');
});

test('no remote access to the app\'s commands, no asset protocol, the app and nothing stranger as targets (DM-205)', () => {
  assert.equal(conf.app.security.dangerousRemoteDomainIpcAccess, undefined);
  assert.ok(!conf.app.security.assetProtocol || conf.app.security.assetProtocol.enable !== true, 'no asset protocol');
  assert.ok(conf.bundle.targets.includes('app') && conf.bundle.targets.every((t) => t === 'app' || t === 'dmg'), 'targets: ' + conf.bundle.targets);
  // Tauri's rule for a build that is Apple Silicon only (Tauri, App Store
  // guide, Build): 12.0, not 11.0 (D-47).
  assert.equal(conf.bundle.macOS.minimumSystemVersion, '12.0', 'the minimum macOS of an Apple Silicon only store build');
  for (const key of ['resources', 'externalBin', 'fileAssociations']) assert.equal(conf.bundle[key], undefined, 'nothing else bundled: bundle.' + key);
  assert.equal(conf.bundle.macOS.frameworks, undefined, 'no extra frameworks');
});

test('src-tauri/Info.plist, which Tauri merges into the app\'s, holds exactly the export compliance answer and the copyright line (D-46)', () => {
  // The CLI finds the file by its place next to tauri.conf.json (tauri-cli
  // 2.12.3, src/interface/rust.rs, "Info.plist"); nothing names it here.
  assert.equal(conf.bundle.macOS.infoPlist, undefined, 'the file is found by its place, not named in the config');
  assert.ok(readdirSync(TAURI).includes('Info.plist'), 'src-tauri/Info.plist exists');
  assert.deepEqual(readPlist(read(TAURI, 'Info.plist')), {
    // The app encrypts only through the system's WebCrypto; approved by Pranav on 21 October 2026 (D-46).
    ITSAppUsesNonExemptEncryption: false,
    NSHumanReadableCopyright: 'Copyright 2026 Pranav Ongole. MIT License.'
  });
});

test('the app runs in the App Sandbox with exactly its four entitlements, the network client among them and none for Downloads (D-37, D-14, D-49; the network client approved by Pranav on 28 October 2026)', () => {
  assert.equal(conf.bundle.macOS.entitlements, './Entitlements.plist');
  assert.notEqual(conf.bundle.macOS.hardenedRuntime, false, 'the hardened runtime stays on');
  const entitlements = readPlist(read(TAURI, 'Entitlements.plist'));
  assert.deepEqual(entitlements, {
    'com.apple.security.app-sandbox': true,
    // The folder panel, the save panel (folder.rs) and the page's Open panel.
    // Save without a folder goes through the save panel, so no Downloads
    // entitlement is needed (D-49).
    'com.apple.security.files.user-selected.read-write': true,
    // The remembered folder is a security-scoped bookmark (bookmark.rs).
    'com.apple.security.files.bookmarks.app-scope': true,
    // In the probe of 26 October 2026 the sandboxed page gave no answer in
    // 31 seconds without it (sbprobe-run-1) and answered in 2.5 seconds with
    // it, the one difference between the two probe builds. The app has no
    // network code, the page's policy allows no request, and the network
    // watch is the check.
    'com.apple.security.network.client': true
  });
  assert.equal(Object.keys(entitlements).length, 4, 'exactly four');
});

test('the one bundled resource brings the vault and the app\'s data folder into the container at the first sandboxed launch (D-37; macOS moved them in a probe build on 26 October 2026, though Apple\'s article says it copies them)', () => {
  assert.deepEqual(conf.bundle.macOS.files, { 'Resources/container-migration.plist': './container-migration.plist' }, 'one file, in Contents/Resources');
  const id = conf.identifier;
  assert.deepEqual(readPlist(read(TAURI, 'container-migration.plist')), {
    Move: [
      // WebKit keeps a sandboxed app's web data, the vault included, in
      // Library/WebKit/WebsiteData, without the bundle identifier it uses
      // outside the sandbox (WebKit, WebsiteDataStoreCocoa.mm), so the
      // folder moves to that place in the container.
      ['${Library}/WebKit/' + id + '/WebsiteData', '${Library}/WebKit/WebsiteData'],
      // The app's data folder keeps its place, under the container.
      '${ApplicationSupport}/' + id
    ]
  });
});

test('the App Store lists the app under Productivity (D-37)', () => {
  assert.equal(conf.bundle.category, 'Productivity');
});

test('the e2e build copies the page first, so it never embeds an old page (DM-205)', () => {
  const pkg = JSON.parse(read(DESKTOP, 'package.json'));
  assert.match(pkg.scripts['build:e2e'], /^npm run copy && cargo build --release --features e2e /);
});

test('the bundle is sealed with an ad-hoc signature until a Developer ID exists (DR-07, DM-201)', () => {
  // Without it only the binary carries the linker's signature and a downloaded
  // copy can be reported as damaged instead of unverified.
  assert.equal(conf.bundle.macOS && conf.bundle.macOS.signingIdentity, '-');
});

test('no GUI test writes into ~/Documents or ~/Downloads: the test build takes PLAIN_SIGHT_E2E_DOWNLOADS, named under the evidence directory (Mac_PS_010)', () => {
  const tests = path.join(DESKTOP, 'tests');
  const harness = read(tests, 'harness.mjs');
  assert.match(harness, /^export const DOWNLOADS = process\.env\.PLAIN_SIGHT_E2E_DOWNLOADS \|\| path\.join\(HOME, 'Downloads'\);$/m, 'the harness follows the variable');
  const e2e = read(tests, 'e2e.mjs');
  const env = e2e.indexOf("import './e2e-downloads.mjs';");
  assert.ok(env >= 0 && env < e2e.indexOf("from './harness.mjs';"), 'e2e.mjs names the folder before the harness loads');
  assert.match(read(tests, 'e2e-downloads.mjs'), /PLAIN_SIGHT_E2E_DOWNLOADS \|\|= path\.join\(process\.env\.PLAIN_SIGHT_EVIDENCE, /, 'the folder is under the evidence directory');
  assert.match(e2e, /PLAIN_SIGHT_E2E_DOWNLOADS: DOWNLOADS/, 'every launch hands the app the folder');
  for (const file of ['app.mjs', 'e2e.mjs']) {
    const text = read(tests, file);
    assert.equal(/join\((HOME|os\.homedir\(\)), '(Documents|Downloads)'/.test(text), false, file + ' names no folder of the real home');
  }
  assert.match(e2e, /PLAIN_SIGHT_E2E_SAVE_AS: DOWNLOADS/, 'every e2e launch names the save panel\'s stand-in');
});

test('every PLAIN_SIGHT_E2E_* read in the Rust sources exists in the test build only (QA-G-26, F5)', () => {
  // The line before each read is its cfg, or the whole module is (e2e.rs,
  // declared under the cfg in main.rs). Comments are not reads.
  const src = path.join(TAURI, 'src');
  assert.match(read(src, 'main.rs'), /^#\[cfg\(feature = "e2e"\)\]\nmod e2e;$/m, 'e2e.rs is a module of the test build only');
  const reads = [];
  for (const file of readdirSync(src).filter((f) => f.endsWith('.rs')).sort()) {
    const rs = read(src, file).split('\n');
    rs.forEach((line, at) => {
      for (const m of line.replace(/\/\/.*$/, '').matchAll(/"(PLAIN_SIGHT_E2E_[A-Z_]+)"/g)) {
        reads.push(file + ':' + m[1]);
        if (file === 'e2e.rs') continue;
        assert.equal((rs[at - 1] || '').trim(), '#[cfg(feature = "e2e")]', file + ' line ' + (at + 1) + ': ' + m[1] + ' is read only in the e2e build');
      }
    });
  }
  for (const known of ['e2e.rs:PLAIN_SIGHT_E2E_DIR', 'folder.rs:PLAIN_SIGHT_E2E_DOWNLOADS', 'folder.rs:PLAIN_SIGHT_E2E_PICK', 'folder.rs:PLAIN_SIGHT_E2E_SAVE_AS']) {
    assert.ok(reads.includes(known), 'the scan saw ' + known + ' among ' + reads.join(', '));
  }
});

test('the bundle check refuses a built Info.plist that holds NSAppTransportSecurity (QA-G-26, B22)', async () => {
  // bundle.mjs reads the built file through this function; held here to a
  // scratch property list, since a bundle is not built on every npm test.
  const { FORBIDDEN_INFO_KEYS, forbiddenInfoKeys } = await import('./bundle.mjs');
  assert.deepEqual(FORBIDDEN_INFO_KEYS, ['NSAppTransportSecurity']);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'plain-sight-plist-'));
  try {
    const file = path.join(dir, 'Info.plist');
    const shipped = read(TAURI, 'Info.plist');
    writeFileSync(file, shipped);
    assert.deepEqual(forbiddenInfoKeys(file), [], 'the shipped keys pass');
    writeFileSync(file, shipped.replace('</dict>', '<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict></dict>'));
    assert.deepEqual(forbiddenInfoKeys(file), ['NSAppTransportSecurity'], 'the added key is named');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The launch guard's wiring (DM-240, ledger D-39): the guard itself is tested
// on fake bundles in launch-guard-tests.mjs; here, that both suites that open
// a bundle run it at module level, before any launch and before the
// harness's run() (so before any data is moved aside), that the harness
// moves a test copy's data aside with the app's own, and that the copy script
// and the guard's tests are wired in.
test('both suites that open a bundle run the launch guard before any launch and before run(), the harness moves the test copy\'s data aside too, and the copy script is wired in (DM-240, D-39)', async () => {
  const tests = path.join(DESKTOP, 'tests');
  for (const file of ['release.mjs', 'app.mjs']) {
    const text = read(tests, file);
    const imported = text.match(/^import \{ ([A-Za-z, ]+) \} from '\.\/launch-guard\.mjs';$/m);
    assert.ok(imported && ['launchable', 'webDataFolder'].every((name) => imported[1].split(', ').includes(name)), file + ' takes the guard and the web data folder from launch-guard.mjs');
    const guard = text.indexOf("const BUNDLE = launchable('");
    const open = text.indexOf("execFileSync('open'");
    const started = text.indexOf('await run(tests');
    assert.ok(guard >= 0, file + ' runs the guard');
    assert.ok(open > guard && started > guard, file + ' runs the guard before it opens the bundle and before run()');
    assert.equal(/Library\/WebKit\/com\.pranavongole\.plainsight|Library\/WebKit', ID\)/.test(text), false, file + ' takes the web data folder from the bundle, not from the real identifier');
  }
  const harness = read(tests, 'harness.mjs');
  assert.match(harness, /^export const APP_ID = \(process\.env\.PLAIN_SIGHT_APP && bundleIdentifier\(process\.env\.PLAIN_SIGHT_APP\)\) \|\| ID;$/m, 'the harness reads the bundle under test');
  assert.match(harness, /\.\.\.\(APP_ID === ID \? \[\] : dataFoldersOf\(APP_ID\)\)/, 'and moves its data folders aside with the app\'s own');
  assert.equal(JSON.parse(read(DESKTOP, 'package.json')).scripts['app:testcopy'], 'node tests/testcopy.mjs', 'the copy script has its npm script');
  assert.match(JSON.parse(read(ROOT, 'package.json')).scripts.test, /node desktop\/tests\/launch-guard-tests\.mjs/, 'the guard\'s tests run in npm test');
  const { MANIFEST, TEST_NAME, testIdentifier } = await import('./testcopy.mjs');
  const { REAL_ID } = await import('./launch-guard.mjs');
  assert.equal(MANIFEST, 'Contents/Resources/container-migration.plist', 'the copy loses the migration manifest');
  assert.ok(testIdentifier(1).startsWith(REAL_ID + '.testcopy-') && testIdentifier(1) !== REAL_ID, 'the copy gets a test identifier of its own');
  assert.notEqual(TEST_NAME, 'Plain Sight', 'and a name of its own');
});

// QA-G-35: the wiring check above finds the guard by the start of its line
// only, so a suite that passed PLAIN_SIGHT_ALLOW_REAL_ID=1 on every run
// (QA-01's R1c and R1c2, the Delivery Manager's GD2) passed npm test and
// would reopen the D-39 trap. Each suite calls the guard exactly once, with
// its own name and APP and nothing else, and no line of code in either names
// the override or reads or sets the environment beyond PLAIN_SIGHT_APP
// (comment lines, which explain the override, are left out of the check).
test('each suite that opens a bundle calls the launch guard exactly as launchable(<suite>, APP), and no code in either names the override or touches the environment beyond reading PLAIN_SIGHT_APP (QA-G-35, D-39)', () => {
  const tests = path.join(DESKTOP, 'tests');
  for (const [file, suite] of [['release.mjs', 'release'], ['app.mjs', 'app']]) {
    const code = read(tests, file).split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    const calls = [...code.matchAll(/launchable\(([^)]*)\)/g)].map((m) => m[0]);
    assert.deepEqual(calls, ["launchable('" + suite + "', APP)"], file + ' calls the guard once, with its own name and APP only');
    assert.match(code, new RegExp("^const BUNDLE = launchable\\('" + suite + "', APP\\);$", 'm'), file + ' keeps the facts the guard returns');
    for (const word of ['PLAIN_SIGHT_ALLOW_REAL_ID', 'OVERRIDE']) assert.equal(code.includes(word), false, file + ' names ' + word + ' in its code');
    const env = [...code.matchAll(/process\.env\b(\.\w+)?/g)].map((m) => m[0]);
    assert.deepEqual([...new Set(env)], ['process.env.PLAIN_SIGHT_APP'], file + ' reads only PLAIN_SIGHT_APP from the environment and sets nothing in it: ' + JSON.stringify(env));
  }
});

// QA-G-38: the pin above covers release.mjs and app.mjs, not the modules they
// import: with harness.mjs setting PLAIN_SIGHT_ALLOW_REAL_ID (QA-01's K20)
// every suite passed, and a suite that imports the harness and then asks the
// guard about a bundle sandboxed under the real identifier was let through
// (QA-01's D0d, adopted in launch-guard-tests.mjs): the D-39 trap with npm
// test green. QA-01's D0c and D0b (wave-g/qa/scripts/app/r8_guard_adv.mjs),
// adopted: no other file of desktop/tests names the override in code, and
// importing harness.mjs, testcopy.mjs or launch-guard.mjs in a process of its
// own, with the override unset, leaves it unset.
test('no other module of desktop/tests names the override in code, and importing the harness, the copy script or the guard leaves it unset (QA-G-38; QA-01\'s D0b and D0c)', () => {
  const tests = path.join(DESKTOP, 'tests');
  const allowed = new Set(['launch-guard.mjs', 'launch-guard-tests.mjs', 'config.mjs', 'harness-safety.mjs']);
  const code = (file) => read(tests, file).split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  const naming = readdirSync(tests).filter((file) => file.endsWith('.mjs') && !allowed.has(file) && /PLAIN_SIGHT_ALLOW_REAL_ID|\bOVERRIDE\b/.test(code(file)));
  assert.deepEqual(naming, [], 'no file but the guard, its tests, this file and the safety suite names the override in code: ' + JSON.stringify(naming));
  // Each import in a process of its own, as a suite's imports run, under a
  // temporary home and evidence folder. The harness compiles its driver at
  // import unless a file of that name is in the temporary folder, so an empty
  // one stands in for it: nothing is compiled or run.
  const box = mkdtempSync(path.join(os.tmpdir(), 'plain-sight-config-override-'));
  try {
    writeFileSync(path.join(box, 'plain-sight-drive-' + createHash('sha256').update(readFileSync(path.join(tests, 'drive.swift'))).digest('hex').slice(0, 12)), '');
    const env = { ...process.env, HOME: box, TMPDIR: box, PLAIN_SIGHT_EVIDENCE: box };
    for (const name of ['PLAIN_SIGHT_ALLOW_REAL_ID', 'PLAIN_SIGHT_APP']) delete env[name];
    for (const file of ['harness.mjs', 'testcopy.mjs', 'launch-guard.mjs']) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(' + JSON.stringify(pathToFileURL(path.join(tests, file)).href) + '); console.log("OVERRIDE AFTER THE IMPORT " + JSON.stringify(process.env.PLAIN_SIGHT_ALLOW_REAL_ID ?? null));'], { encoding: 'utf8', env });
      assert.equal(r.status, 0, file + ' imports in a process of its own: ' + r.stdout + r.stderr);
      assert.match(r.stdout, /^OVERRIDE AFTER THE IMPORT null$/m, 'importing ' + file + ' leaves the override unset: ' + r.stdout);
    }
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

// DM-247: three real-key tests started from a first launch by clearing the
// test data mid-run, which on a sandboxed copy removes the copy's container,
// and macOS refused that removal (EPERM, release-run-1). app.mjs clears
// nothing itself now: a test that needs a first launch asks the harness's
// freshStart (harness-safety.mjs runs it), which clears only an unsandboxed
// bundle's folders and gives a sandboxed one a fresh copy; every launch
// opens the bundle it returned, and the vault's record is looked for in that
// bundle's web data.
test('the real-key suite never clears a sandboxed copy\'s data mid-run: each test that needs a first launch asks freshStart for the bundle to open, and every launch opens it (DM-247)', () => {
  const text = read(path.join(DESKTOP, 'tests'), 'app.mjs');
  assert.equal(/\bclearTestData\b/.test(text), false, 'app.mjs neither imports nor calls clearTestData');
  assert.match(text, /^async function firstLaunchAgain\(\) \{\n  await quitIfRunning\(\);\n  current = freshStart\(BUNDLE\);\n  if \(!opened\.includes\(current\.app\)\) opened\.push\(current\.app\);\n\}$/m, 'a first launch again is a fresh start of the bundle under test');
  for (const title of ['the system folder picker opens from the folder button', 'Cmd+Q with text on the page asks', 'the vault in the release app keeps the text']) {
    const at = text.indexOf("test('" + title);
    assert.ok(at >= 0, 'app.mjs has the test ' + JSON.stringify(title));
    assert.ok(text.slice(at, text.indexOf('\n});', at)).includes(", async () => {\n  await firstLaunchAgain();\n  await launch();\n"), JSON.stringify(title) + ' starts from freshStart, then launches');
  }
  assert.equal([...text.matchAll(/firstLaunchAgain\(\)/g)].length, 4, 'the three tests and the definition, nothing else');
  const start = text.indexOf('async function launch(');
  const launcher = text.slice(start, text.indexOf('\n}\n', start));
  assert.ok(launcher.includes("execFileSync('open', ['-n', current.app]);"), 'every launch opens the bundle freshStart returned');
  assert.equal(/execFileSync\('open', \['-n', APP\]\)/.test(text), false, 'none opens APP itself');
  assert.match(text, /^  const dir = webDataFolder\(HOME, current\);$/m, 'the vault\'s record is looked for in the launched bundle\'s web data');
});

// DISH-G-81 G7: app.mjs's instances() finds the running copies of every
// bundle the run opened, the bundle under test and each fresh copy (DM-247).
// Looking in the bundle under test only, a launch of a fresh copy would never
// find its process and its copies would never be ended; only a GUI run would
// show that, so the loop is pinned here.
test('the real-key suite looks for running copies in every bundle the run opened, so a fresh copy\'s process is found and ended (DM-247, DISH-G-81 G7)', () => {
  const text = read(path.join(DESKTOP, 'tests'), 'app.mjs');
  assert.match(text, /^const opened = \[BUNDLE\.app\];$/m, 'the run starts with the bundle under test');
  const start = text.indexOf('function instances() {');
  assert.ok(start >= 0, 'app.mjs has instances()');
  const body = text.slice(start, text.indexOf('\n}\n', start));
  assert.ok(body.includes('opened.flatMap((bundle) => copiesOf(bundle))'), 'instances() looks in every bundle the run opened, for a process whose program is that bundle\'s own executable (the harness\'s copiesOf, round 13)');
});

// DM-241: macOS titles the app menu with the bundle's name, which is "Plain
// Sight test copy" on the copy the two suites run on, while the items keep
// the app's own words ("About Plain Sight", "Quit Plain Sight"). So neither
// suite may name the app menu "Plain Sight" itself: both take the title from
// the bundle they open (launch-guard.mjs, appMenuTitle and menuBarOf).
test('the suites that open a bundle take the app menu\'s title from that bundle and name no "Plain Sight" menu of their own (DM-241)', () => {
  const tests = path.join(DESKTOP, 'tests');
  for (const file of ['release.mjs', 'app.mjs']) {
    const text = read(tests, file);
    const literal = text.split('\n').findIndex((line) => /(['"`])Plain Sight\1/.test(line));
    assert.equal(literal, -1, file + ' line ' + (literal + 1) + ' names the app menu "Plain Sight" itself: ' + (text.split('\n')[literal] || '').trim());
    assert.match(text, /^const APP_MENU = appMenuTitle\(BUNDLE\);$/m, file + ' reads the app menu\'s title from the bundle');
    assert.match(text, /menuBarOf\(BUNDLE\)/, file + ' expects the menu bar of the bundle it opened');
    const calls = [...text.matchAll(/drive\('menu', app\.pid, ([^,]+), '(About|Hide|Quit) Plain Sight'\)/g)];
    assert.ok(calls.length > 0, file + ' presses an item of the app menu');
    for (const call of calls) assert.equal(call[1], 'APP_MENU', file + ': ' + call[0] + ' looks for the item in the bundle\'s own app menu');
  }
});

// The lock screen (DISH-G-50): on 26 October, with the screen locked, the
// end-to-end and release suites listed no on-screen window (e2e-run-1, 888
// listings; release-run-1, 211) and counted each wait as a failure. The three
// suites that launch the app ask run() for an unlocked screen, so a locked
// one is refused before anything moves, and wait for a launch's first window
// through the harness's firstWindow, which stops the run as not run when the
// window is listed only off-screen (harness-safety.mjs runs both).
test('the three suites that launch the app refuse a locked screen and wait for a launch\'s first window through firstWindow (DISH-G-50)', () => {
  const tests = path.join(DESKTOP, 'tests');
  for (const [file, launcher] of [['e2e.mjs', 'async function launch('], ['release.mjs', 'async function open('], ['app.mjs', 'async function launch(']]) {
    const text = read(tests, file);
    const at = text.indexOf('await run(tests, {');
    assert.ok(at >= 0, file + ' calls run()');
    assert.match(text.slice(at, text.indexOf('});', at)), /\n  needUnlocked: true,\n/, file + ' asks run() for an unlocked screen');
    const imported = text.match(/^import \{([^}]*)\} from '\.\/harness\.mjs';$/m);
    assert.ok(imported && imported[1].split(',').map((s) => s.trim()).includes('firstWindow'), file + ' imports firstWindow from the harness');
    const start = text.indexOf(launcher);
    assert.ok(start >= 0, file + ' has its launch function');
    const body = text.slice(start, text.indexOf('\n}\n', start));
    assert.match(body, /\n  await firstWindow\(pid, /, file + ' waits for the launch\'s first window through firstWindow');
    assert.equal(/until\(\(\) => [^\n]*(documentWindows|cgwindows)/.test(body), false, file + ' has no window wait of its own left in the launch');
  }
});

// DM-249: after a Ctrl+C or a kill during a test, that test went on while the
// harness put everything back, and a launch it made then outlived the run
// (the Delivery Manager's AT-H8 to AT-H8c). harness-safety.mjs runs the
// harness's refusal (spawnApp) and e2e.mjs's after() (stopCurrentApp); the two
// suites that open a bundle launch and end it through LaunchServices, which
// only a GUI run reaches, so their parts are pinned here: the refusal comes
// with no wait between it and the open, a launch under way is marked until
// its copy is recorded, and after() waits for that mark before it ends the
// copies.
test('no suite launches the app once the run is ending, and each suite\'s end stops a copy launched late (DM-249)', () => {
  const tests = path.join(DESKTOP, 'tests');
  const e2e = read(tests, 'e2e.mjs');
  assert.ok(e2e.includes('\n  after: () => stopCurrentApp(() => app)\n});'), 'e2e.mjs\'s after() stops the app that is current when each stop ends');
  assert.equal(/\bspawn\(|execFileSync\('open'/.test(e2e), false, 'e2e.mjs launches the app only through spawnApp, which refuses once the run is ending');
  for (const [file, launcher, bundle] of [['app.mjs', 'async function launch(', 'current.app'], ['release.mjs', 'async function open(', 'APP']]) {
    const text = read(tests, file);
    const start = text.indexOf(launcher);
    assert.ok(start >= 0, file + ' has its launch function');
    const body = text.slice(start, text.indexOf('\n}\n', start));
    const open = body.indexOf("execFileSync('open'");
    const refusal = body.lastIndexOf("refuseLaunchWhileEnding('the release app');", open);
    assert.ok(refusal >= 0 && open > refusal, file + ': the launch refuses before it opens the bundle once the run is ending');
    assert.equal(/\bawait\b/.test(body.slice(refusal, open)), false, file + ': with no wait between the refusal and the open');
    assert.ok(body.includes("  launching = true;\n  let pid = 0;\n  try {\n    execFileSync('open', ['-n', " + bundle + "]);\n    pid = await until(() => instances().find((p) => !launched.includes(p)) || 0, 'the app process', 15000);\n    launched.push(pid);\n    recordLaunch(pid, " + bundle + ");\n  } finally {\n    launching = false;\n  }\n"), file + ': a launch under way is marked until its copy is recorded, here and with the harness for its restore check');
    assert.equal([...text.matchAll(/execFileSync\('open'/g)].length, 1, file + ' opens the bundle in one place only');
    const end = text.slice(text.indexOf('await run(tests, {'));
    // Round 15: app.mjs's after() holds these two lines in a try, whose
    // finally puts the clipboard back (PO-R14-1), so they may sit deeper.
    assert.ok(end.includes("  after: async () => {\n") && /\n +await until\(\(\) => !launching, 'a launch under way to record its copy', 16000\)\.catch\(\(\) => \{\}\);\n +await endCopies\(/.test(end), file + ': after() waits for a launch under way before it ends the copies');
  }
});

// DISH-G-85 and QA-G-45 (N12): e2e.mjs's after() sees the app a test
// launched only because launch() sets app right after spawnApp, before the
// launch's first wait. With the assignment after the window wait (QA-01's
// N12) or after both waits (DISH's N17), a signal during that wait left the
// new app outside after()'s sight, running over the restored data, and every
// suite passed. Only a GUI run reaches it, so the order is pinned here;
// harness-safety.mjs runs e2e.mjs's own launch() under its stand-ins
// (QA-01's E1).
test('e2e.mjs sets the app its after() stops right after spawnApp, before the launch\'s first wait (DISH-G-85; QA-G-45, QA-01\'s N12; DM-249)', () => {
  const e2e = read(path.join(DESKTOP, 'tests'), 'e2e.mjs');
  const start = e2e.indexOf('async function launch(');
  assert.ok(start >= 0, 'e2e.mjs has launch()');
  const body = e2e.slice(start, e2e.indexOf('\n}\n', start));
  assert.ok(body.includes("  const child = spawnApp(EXE, { PLAIN_SIGHT_E2E_DIR: PROBE, PLAIN_SIGHT_E2E_DOWNLOADS: DOWNLOADS, PLAIN_SIGHT_E2E_SAVE_AS: DOWNLOADS, ...env });\n  const pid = child.pid;\n  app = { child, pid };\n  await firstWindow("), 'launch() sets app right after spawnApp and before its first wait');
  assert.ok(body.indexOf('  app = { child, pid };\n') >= 0 && body.indexOf('  app = { child, pid };\n') < body.indexOf('await '), 'the assignment comes before the first await of launch()');
  assert.equal([...body.matchAll(/\bapp = /g)].length, 1, 'launch() sets app in one place only');
});

// DM-249's launched half (round 10): the harness's restore check looks again
// 3 s after the restore, to catch a late writer. Only its own safety suite may
// shorten that, for the cases that do not test the check.
test('the restore check waits 3 s before its second look, and no test file but the harness\'s safety suite shortens it (DM-249)', () => {
  const tests = path.join(DESKTOP, 'tests');
  assert.match(read(tests, 'harness.mjs'), /^export const RESTORE_RECHECK_MS = 3000;$/m, 'the second look comes 3 s after the restore');
  const naming = readdirSync(tests).filter((f) => f.endsWith('.mjs') && read(tests, f).includes('setRestoreRecheckForTests')).sort();
  assert.deepEqual(naming, ['config.mjs', 'harness-safety.mjs', 'harness.mjs'], 'named only by the harness, its safety suite and this check');
});

// QA-G-48 (round 13): the safety suite gives the run a restore check that
// fails (setRestoreCheckForTests), to show that any failure of the check is
// reported and leaves no lock behind. No other test file may replace the
// check.
test('no test file but the harness\'s safety suite replaces the restore check with a stand-in (QA-G-48)', () => {
  const tests = path.join(DESKTOP, 'tests');
  const naming = readdirSync(tests).filter((f) => f.endsWith('.mjs') && read(tests, f).includes('setRestoreCheckForTests')).sort();
  assert.deepEqual(naming, ['config.mjs', 'harness-safety.mjs', 'harness.mjs'], 'named only by the harness, its safety suite and this check');
});

// DISH I-14 and QA-01's observation 6 (its T4): a launch whose wait for its
// pid timed out never recorded its copy, and after() ended only the copies it
// had recorded, so such a copy outlived the run. Both suites' after() now end
// every copy running from a bundle the run opened, recorded or not; only a GUI
// run reaches that code, so it is pinned here.
test('the release and real-key suites\' after() ends every copy running from a bundle the run opened, recorded or not (DISH I-14; QA-01\'s observation 6)', () => {
  const tests = path.join(DESKTOP, 'tests');
  for (const file of ['app.mjs', 'release.mjs']) {
    const text = read(tests, file);
    const end = text.slice(text.indexOf('await run(tests, {'));
    const start = end.indexOf('  after: async () => {\n');
    assert.ok(start >= 0, file + ' has an after()');
    const after = end.slice(start, end.indexOf('\n  }\n', start));
    // Since round 13 after() hands every bundle the run opened to the
    // harness's endCopies, which asks each copy to quit and ends any copy
    // still running 5 s later; harness-safety.mjs runs it under a fake home.
    assert.ok(after.includes('    await endCopies(' + (file === 'app.mjs' ? 'opened' : '[APP]') + ', '), file + ': after() ends every copy running from a bundle the run opened, through endCopies');
    assert.equal(/launched\.includes/.test(after), false, file + ': whether the run recorded it or not');
  }
});

// QA-G-45 (N13): e2e.mjs could start the app another way and pass the pins
// above: QA-01's N13 started it through execFile from a dynamic import of
// node:child_process, so spawnApp's refusal was skipped, and every suite
// passed. The rule, read from the file: node:child_process is named once,
// for execFileSync, which runs textutil, chmod and plutil only; no dynamic
// import and no require; and the test build's path goes to spawnApp (and to
// path.basename, for names), nowhere else.
test('e2e.mjs starts the app only through spawnApp: execFileSync is all it takes from node:child_process and runs only textutil, chmod and plutil, there is no dynamic import or require, and the test build\'s path goes only to spawnApp (QA-G-45, QA-01\'s N13; DM-249)', () => {
  const e2e = read(path.join(DESKTOP, 'tests'), 'e2e.mjs');
  const code = e2e.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.equal([...code.matchAll(/child_process/g)].length, 1, 'node:child_process is named once');
  assert.ok(code.includes("\nimport { execFileSync } from 'node:child_process';\n"), 'and only execFileSync is taken from it');
  assert.equal(/\bimport\s*\(|\brequire\s*\(/.test(code), false, 'no dynamic import and no require');
  const named = [...code.matchAll(/\bexecFileSync\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.equal([...code.matchAll(/\bexecFileSync\b/g)].length, named.length + 1, 'every execFileSync call names its program');
  assert.deepEqual([...new Set(named)].sort(), ['chmod', 'plutil', 'textutil'], 'execFileSync runs textutil, chmod and plutil only');
  const rest = code.replace(/^const EXE = .*$/m, '').replace(/\bspawnApp\(EXE, /g, '').replace(/\bpath\.basename\(EXE\)/g, '');
  assert.equal(/\bEXE\b/.test(rest), false, 'the test build\'s path goes only to spawnApp and path.basename');
  assert.equal([...code.matchAll(/\bspawnApp\(EXE, /g)].length, 1, 'and to spawnApp in one place');
});

// The real-key open, save and folder tests (app.mjs) go to the test's own
// folder through goTo, which fails (and inPanel cancels the panel) unless the
// panel shows that folder, and press the panel's own button only after it,
// through Accessibility; before, a Go-to box that failed left the default
// button to act on the panel's start folder, the real Downloads or Documents
// folder (DM-239 d). Round 14: the buttons are Accessibility presses, never
// Return, which the robot's Go to Folder step sends only to that sheet.
test('the real-key open, save and folder tests press a panel\'s own button, through Accessibility, only after the Go to Folder step that reads back the panel shows the test\'s folder (DM-239 d, round 14)', () => {
  const text = read(path.join(DESKTOP, 'tests'), 'app.mjs');
  for (const [panel, go, button] of [
    ['openPanelShown', 'await goTo(file, path.dirname(file));', "await pressPanelButton('Open');"],
    ['savePanelShown', 'await goTo(SAVE_AS);', "await pressPanelButton('Save');"],
    ['folderSheetShown', 'await goTo(BUILD_TEST);', "await pressPanelButton('Open', 'Choose');"]
  ]) {
    const at = text.indexOf('await inPanel(' + panel + ', async () => {');
    assert.ok(at >= 0, 'the ' + panel + ' flow');
    const body = text.slice(at, text.indexOf('});', at));
    assert.ok(body.indexOf(go) >= 0, 'the ' + panel + ' flow goes to its own folder through goTo');
    assert.ok(body.indexOf(button) > body.indexOf(go), 'and presses the panel\'s own button after it, through Accessibility');
    assert.equal(/keys\.press\('(return|enter|cmd\+shift\+g)'\)|drive\('type'|keys\.type\(/.test(body), false, 'the flow sends no Return and types nothing into the panel: goTo alone sends the Go to Folder keys');
  }
  const press = text.slice(text.indexOf('async function pressPanelButton('), text.indexOf('\n}\n', text.indexOf('async function pressPanelButton(')));
  assert.ok(press.includes("driveRaw('panel-button', app.pid, title)"), 'a panel\'s button is pressed through the driver\'s panel-button, an Accessibility press');
});

// DM-263 (round 14): the real-key Open test pressed the open panel's Open
// without checking what the panel had selected, so a remembered selection
// (a personal .sight file, say) could have been opened and tried with the
// test's passwords. Every panel's own button is now pressed only after
// mustShowOwnFolder, which fails unless the panel shows the test's own folder
// by its location menu and that folder holds exactly what the test put there:
// the open test's file alone, or nothing for the save and folder panels. The
// driver reads no selection, so the open test's file sits alone in a folder
// of its own, where Open can open nothing else. Only a GUI run reaches
// app.mjs, so the checks are pinned here.
test('the real-key open, save and folder tests press a panel\'s button only when the panel shows the test\'s own folder, holding the test\'s file alone for Open and nothing for Save and the folder panel (DM-263, round 14)', () => {
  const text = read(path.join(DESKTOP, 'tests'), 'app.mjs');
  for (const [panel, check, button] of [
    ['openPanelShown', 'mustShowOwnFolder(path.dirname(file), [path.basename(file)]);', "await pressPanelButton('Open');"],
    ['savePanelShown', 'mustShowOwnFolder(SAVE_AS, []);', "await pressPanelButton('Save');"],
    ['folderSheetShown', 'mustShowOwnFolder(BUILD_TEST, []);', "await pressPanelButton('Open', 'Choose');"]
  ]) {
    const at = text.indexOf('await inPanel(' + panel + ', async () => {');
    assert.ok(at >= 0, 'the ' + panel + ' flow');
    const body = text.slice(at, text.indexOf('});', at));
    const go = body.indexOf('await goTo(');
    assert.ok(go >= 0 && body.indexOf(check) > go, 'the ' + panel + ' flow checks the panel shows the test\'s own folder after goTo');
    assert.ok(body.indexOf(button) > body.indexOf(check), 'and only then presses the panel\'s button');
  }
  const start = text.indexOf('function mustShowOwnFolder(folder, holds) {');
  assert.ok(start >= 0, 'app.mjs has mustShowOwnFolder');
  const body = text.slice(start, text.indexOf('\n}\n', start));
  assert.ok(body.includes('const shown = panelFolders();\n  if (!shown.includes(name)) {\n    throw new Error('), 'it fails unless the panel\'s location menu names the test\'s own folder');
  assert.ok(body.includes('const held = readdirSync(folder).sort();\n  if (JSON.stringify(held) !== JSON.stringify(holds)) {\n    throw new Error('), 'and unless that folder holds exactly what the test put there');
  assert.match(text, /^const OPEN_FROM = path\.join\(EVIDENCE, 'folders', 'Opened from the panel'\);$/m, 'the open test\'s file has a folder of its own under the evidence directory');
  assert.ok(text.includes('  mkdirSync(OPEN_FROM, { recursive: true });\n  const file = path.join(OPEN_FROM, OPEN_NAME);\n'), 'and sightFile writes it there');
});

// Super Stealth (web 1.5.0, BR-46): Cmd+Shift+H and Ctrl+Shift+H open the
// intro, and in the app they reach the page only while no menu item takes
// them first (round 16). menu.rs gives accelerators of its own to Quit,
// Open... and Save... only; its predefined items take the keys muda 0.20.0
// gives them on macOS (src/items/predefined.rs, `accelerator`), none of them
// Shift+H: Hide Cmd+H and Hide Others Cmd+Option+H. app-run-1's read of the
// menu bar (29 October) shows the same.
test('no app menu item takes Shift+H, so Cmd+Shift+H and Ctrl+Shift+H reach the page and open the intro (Super Stealth, web 1.5.0)', () => {
  const menu = read(path.join(DESKTOP, 'src-tauri', 'src'), 'menu.rs');
  const calls = menu.split(/(?<!Predefined)MenuItem::with_id\(/).slice(1).map((chunk) => chunk.slice(0, chunk.indexOf(')?')).trim());
  assert.equal(calls.length, 4, 'menu.rs makes four items of its own: Quit, Open..., Save... and Help');
  for (const call of calls) assert.match(call, /(Some\("[^"]+"\)|None(::<&str>)?),?$/, 'each ends with its accelerator or None: ' + call);
  const own = calls.map((call) => (call.match(/Some\("([^"]+)"\),?$/) || [])[1]).filter(Boolean).sort();
  assert.deepEqual(own, ['CmdOrCtrl+O', 'CmdOrCtrl+Q', 'CmdOrCtrl+S'], 'menu.rs gives its own accelerators to Quit, Open... and Save... only; Help has none');
  const KEYS = {
    about: null, services: null, separator: null, show_all: null, maximize: null,
    hide: 'Cmd+H', hide_others: 'Cmd+Option+H', minimize: 'Cmd+M', fullscreen: 'Ctrl+Cmd+F', close_window: 'Cmd+W',
    undo: 'Cmd+Z', redo: 'Shift+Cmd+Z', cut: 'Cmd+X', copy: 'Cmd+C', paste: 'Cmd+V', select_all: 'Cmd+A'
  };
  const used = [...new Set([...menu.matchAll(/PredefinedMenuItem::([a-z_]+)\(/g)].map((m) => m[1]))].sort();
  for (const item of used) assert.ok(Object.hasOwn(KEYS, item), 'a predefined item whose key this test knows: ' + item);
  const keys = [...own, ...used.map((item) => KEYS[item]).filter(Boolean)];
  assert.deepEqual(keys.filter((k) => /\bShift\b/.test(k) && /\+H$/.test(k)), [], 'no item takes Shift+H; the keys: ' + keys.join(', '));
  assert.deepEqual(keys.filter((k) => /\+H$/.test(k)).sort(), ['Cmd+H', 'Cmd+Option+H'], 'the two items with H: Hide and Hide Others');
  // PO-R16-1 (round 17): an item made another way (MenuItemBuilder, a
  // CheckMenuItem, a later set_accelerator) is held too. Every string literal
  // in menu.rs that reads as an accelerator is one of the three above; every
  // .accelerator( or set_accelerator( call takes such a literal, or None; and
  // no accelerator is built in code (Accelerator::new, Modifiers, Code),
  // which this test could not read.
  const ACCEL = /^((CmdOrCtrl|CommandOrControl|CmdOrControl|Cmd|Command|Super|Meta|Ctrl|Control|Alt|Option|Shift)\+)+[A-Za-z0-9]+$/i;
  const accelerators = [...menu.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\s+/g, '')).filter((s) => ACCEL.test(s));
  assert.deepEqual(accelerators.filter((s) => /(^|\+)shift\+/i.test(s) && /\+(key)?h$/i.test(s)), [], 'no string in menu.rs reads as a Shift+H accelerator; the accelerator strings: ' + accelerators.join(', '));
  assert.deepEqual([...accelerators].sort(), ['CmdOrCtrl+O', 'CmdOrCtrl+Q', 'CmdOrCtrl+S'], 'the only accelerator strings in menu.rs are the three own ones');
  for (const m of menu.matchAll(/(?:\.accelerator|set_accelerator)\s*\(\s*([^)]*)\)/g)) {
    assert.match(m[1].trim(), /^((Some\(\s*)?"[^"]*"|None\b)/, 'an accelerator given in a call is a string this test reads: ' + m[0]);
  }
  assert.equal(/Accelerator::new|Modifiers::|Code::Key/.test(menu), false, 'no accelerator is built in code, which this test could not read');
});

// PO-R14-1 (round 15): the real-key suite writes markers and paths to the
// person's clipboard (pbcopy) and saves the clipboard first, so losing the
// restore would leave the clipboard holding test text; the Product Owner's
// PO1-NO-CLIP-RESTORE, the restore removed, passed every suite. Pinned: the
// save in before(), which the harness runs before the first test; the
// restore in after(), after endCopies, before the front app, in a finally;
// and the harness's cleanup, which calls after() and which both the signal
// handler and the run's own end reach.
test('the real-key suite saves the person\'s clipboard before its first test and puts it back in after(), after endCopies and before the front app, in a finally that the harness reaches on every path that ends a run (PO-R14-1, round 15)', () => {
  const text = read(path.join(DESKTOP, 'tests'), 'app.mjs');
  assert.match(text, /^const CLIPBOARD = path\.join\(EVIDENCE, 'clipboard\.plist'\);$/m, 'the clipboard is kept in the evidence folder');
  const hooks = text.slice(text.indexOf('await run(tests, {'));
  const before = hooks.slice(hooks.indexOf('  before: () => {'), hooks.indexOf('  after: async () => {'));
  assert.ok(before.includes("driveRaw('clip-save', CLIPBOARD)"), 'before() saves the clipboard');
  const after = hooks.slice(hooks.indexOf('  after: async () => {'));
  const ends = after.indexOf('await endCopies(opened, ');
  const fin = after.indexOf('} finally {');
  const restore = after.indexOf("driveRaw('clip-restore', CLIPBOARD)");
  const front = after.indexOf("driveRaw('front', frontBefore)");
  assert.ok(ends >= 0, 'after() ends the copies');
  assert.ok(fin > ends && restore > fin, 'and then puts the clipboard back, in a finally');
  assert.ok(front > restore, 'before the front app comes back');
  assert.equal([...text.matchAll(/driveRaw\('clip-(save|restore)', /g)].length, 2, 'the clipboard is saved and put back in these two places only');
  const harness = read(path.join(DESKTOP, 'tests'), 'harness.mjs');
  assert.ok(harness.includes('      try { await after(); } catch (err) { note(\'after: \' + err.message); }\n'), 'the harness\'s cleanup calls after()');
  assert.ok(harness.includes('      cleanup().then((back) => process.exit(back === false ? 6 : 130), () => process.exit(130));\n'), 'a signal ends the run through that cleanup');
  assert.ok(harness.includes('    await before();\n    for (const t of tests) {\n'), 'before() runs before the first test');
  assert.ok(harness.includes('  } finally {\n    await cleanup();\n  }\n'), 'and every other end of the run, a stop and a refused launch among them, goes through that cleanup');
});

// DISH-G-101 (round 17): the real-key and release suites' guards were
// pinned by their text (includes, and indexOf for their order), which a
// condition put in front of a statement keeps: DISH put if (false) in front of
// goTo's paste, the three own-folder checks and the clipboard's put-back, and
// config stayed green. Each guarded statement is now held as a statement of
// its own: it occurs once in its file, nothing but indentation stands before
// it on its line, and the line before it (blank and comment lines aside) ends
// a statement or opens or closes a block. So `if (false) statement`, `false &&
// statement` and an `if (false)` line above it are each refused, and the case
// checks that of the pin itself.
function statementPinned(text, statement) {
  const lines = text.split('\n');
  const at = lines.flatMap((line, i) => (line.includes(statement) ? [i] : []));
  if (at.length !== 1 || !lines[at[0]].trimStart().startsWith(statement)) return false;
  for (let i = at[0] - 1; i >= 0; i--) {
    const before = lines[i].replace(/\/\/.*$/, '').trim();
    if (before) return /[;{}]$/.test(before);
  }
  return true;
}
const GUARDED = [
  ['app.mjs', "await keys.press('cmd+v');", "goTo's paste (DISH's DD1)"],
  ['app.mjs', 'await until(() => goToField() !== null, ', "goTo's read-back of the Go to Folder sheet"],
  ['app.mjs', 'await until(() => (goToField() || {}).value === target, ', "goTo's read-back of the path in the sheet's field"],
  ['app.mjs', 'await until(() => goToField() === null && panelFolders().includes(name), ', "goTo's read-back of the folder the panel shows"],
  ['app.mjs', 'mustShowOwnFolder(path.dirname(file), [path.basename(file)]);', "the Open flow's own-folder check (DISH's DD5, DM-263)"],
  ['app.mjs', 'mustShowOwnFolder(SAVE_AS, []);', "the Save flow's own-folder check (DISH's DD2)"],
  ['app.mjs', 'mustShowOwnFolder(BUILD_TEST, []);', "the folder flow's own-folder check (DISH's DD6)"],
  ['app.mjs', "note('clipboard saved: ' + JSON.stringify(driveRaw('clip-save', CLIPBOARD)));", "before()'s clipboard save (PO-R15-1)"],
  ['app.mjs', "await endCopies(opened, (pid) => driveRaw('quit-app', pid));", "after()'s end of the copies (DISH's DD4)"],
  ['app.mjs', "const back = driveRaw('clip-restore', CLIPBOARD);", "after()'s clipboard put-back (DISH's DD3, DM-265)"],
  ['app.mjs', 'rmSync(CLIPBOARD, { force: true });', "the clipboard file's removal once the clipboard is back (DISH-G-99)"],
  ['app.mjs', 'return [...new Set(opened.flatMap((bundle) => copiesOf(bundle)))];', 'instances(): the copies of every bundle the run opened'],
  ['release.mjs', 'return copiesOf(APP);', "instances(): the copies of the release app (DISH's DN5)"],
  ['release.mjs', "await endCopies([APP], (pid) => drive('quit-app', pid));", "after()'s end of the copies"]
];
test('the real-key and release suites\' guards stand as statements of their own, so no condition can skip one, and the pin refuses each with a condition in front of it or an if (false) line above it (DISH-G-101; PO-R15-1, DM-265)', () => {
  const tests = path.join(DESKTOP, 'tests');
  for (const [file, statement, what] of GUARDED) {
    const text = read(tests, file);
    assert.ok(statementPinned(text, statement), file + ', ' + what + ': ' + JSON.stringify(statement) + ' stands on a line of its own, once, after a line that ends a statement or a block');
    const lines = text.split('\n');
    const i = lines.findIndex((line) => line.includes(statement));
    for (const lead of ['if (false) ', 'false && ', 'false || ', 'false ? 0 : ']) {
      const changed = [...lines];
      changed[i] = changed[i].replace(statement, lead + statement);
      assert.equal(statementPinned(changed.join('\n'), statement), false, 'the pin refuses ' + JSON.stringify(lead + statement));
    }
    const above = [...lines];
    above.splice(i, 0, lines[i].match(/^\s*/)[0] + 'if (false)');
    assert.equal(statementPinned(above.join('\n'), statement), false, 'and an if (false) line above ' + JSON.stringify(statement));
    const twice = [...lines];
    twice.splice(i, 0, lines[i]);
    assert.equal(statementPinned(twice.join('\n'), statement), false, 'and ' + JSON.stringify(statement) + ' twice over');
  }
});

// PO-R13-1, the robot's route to a panel (round 14, the Delivery Manager's
// preference): macOS draws the panels in their own process and the driver
// posts keys only to the app's, so a typed path never reaches a panel. goTo
// puts the path on the clipboard, opens the Go to Folder sheet with
// Cmd+Shift+G, pastes with Cmd+V (the app's Paste, as Cmd+C reached the save
// panel's field through the app's Copy in app-run-1) and goes with Return,
// reading each step back through Accessibility before the next, and sends
// Return only while the sheet's own field holds the path. Only a GUI run
// reaches app.mjs, so the order is pinned here.
test('the real-key Go to Folder step goes by the clipboard, reading each step back through Accessibility before the next, and types no path (PO-R13-1, round 14)', () => {
  const text = read(path.join(DESKTOP, 'tests'), 'app.mjs');
  const start = text.indexOf('async function goTo(target, folder = target) {');
  assert.ok(start >= 0, 'app.mjs has goTo');
  const body = text.slice(start, text.indexOf('\n}\n', start));
  let at = -1;
  for (const step of [
    "execFileSync('pbcopy', [], { input: target });",
    "await keys.press('cmd+shift+g');",
    'await until(() => goToField() !== null, ',
    "await keys.press('cmd+v');",
    'await until(() => (goToField() || {}).value === target, ',
    "await keys.press('return');",
    'await until(() => goToField() === null && panelFolders().includes(name), '
  ]) {
    const next = body.indexOf(step);
    assert.ok(next > at, 'goTo\'s steps in this order: ' + step);
    at = next;
  }
  assert.equal([...body.matchAll(/keys\.press\('return'\)/g)].length, 1, 'goTo sends Return once, after the sheet\'s field is seen holding the path');
  assert.equal(/drive\('type'|keys\.type\(/.test(body), false, 'goTo types no path');
  assert.ok(body.includes("if (sheetUp) await keys.press('escape');"), 'a failed step closes a Go to Folder sheet left up before inPanel cancels the panel');
  assert.match(text, /^const GO_TO_TITLE = 'Go to Folder';$/m, 'the sheet is the one titled "Go to Folder"');
  assert.match(text, /^const GO_TO_FIELD = 'Enter a Path';$/m, 'its field is the one labelled "Enter a Path"');
  const field = text.slice(text.indexOf('function goToField() {'), text.indexOf('\n}\n', text.indexOf('function goToField() {')));
  assert.ok(field.includes('const sheet = nodes.find((n) => n.title === GO_TO_TITLE);') && field.includes('[n.title, n.description].includes(GO_TO_FIELD)'), 'goToField reads only the sheet\'s own field');
  assert.equal(/drive\('type', app\.pid, (file|folder|target)/.test(text), false, 'app.mjs types no path anywhere');
});

// Round 13, item 5: e2e.mjs's forced-end test ended the app with
// process.kill(app.pid, 'SIGKILL'); macOS hands an ended app's pid to another
// program, so a kill by the pid can reach that program. The app is e2e.mjs's
// child, and child.kill sends nothing once Node has seen it end. Only a GUI
// run reaches the test, so it is pinned here.
test('e2e.mjs signals the app it launched only through its child, never by its pid: its forced-end test sends SIGKILL with app.child.kill (round 13, item 5)', () => {
  const e2e = read(path.join(DESKTOP, 'tests'), 'e2e.mjs');
  const code = e2e.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(code.includes("\n  app.child.kill('SIGKILL');   // through Node, which sends nothing to a child it has seen end; never by the pid (round 13)\n  await until(() => !alive(app.pid), 'the app to be gone', 8000);\n"), 'the forced end goes through the child');
  assert.equal(/process\.kill\(/.test(code), false, 'and e2e.mjs calls process.kill nowhere');
});

// PO-R13-1 (round 13): in app-run-1 (29 October, the sandboxed test copy)
// the Save test's check for a second window wider than 400 never saw the save
// panel, which came up 370 by 210; the wait sat before inPanel, so nothing
// cancelled the panel, and it blocked every later test. Only a GUI run
// reaches app.mjs, so the shape is pinned here: the save panel is any second
// on-screen window at the normal level, the Save test waits for it inside
// inPanel, and a failed panel step presses Cancel through Accessibility at
// least once and notes each try, whatever the test's own check says.
test('a failed panel step in the real-key suite cancels the panel through Accessibility and notes each try, and the Save test waits for its panel, of any size, inside that guard (PO-R13-1)', () => {
  const text = read(path.join(DESKTOP, 'tests'), 'app.mjs');
  const start = text.indexOf('async function inPanel(isOpen, steps) {');
  assert.ok(start >= 0, 'app.mjs has inPanel');
  const body = text.slice(start, text.indexOf('\n}\n', start));
  assert.ok(body.includes("    for (let i = 0; i < 4; i++) {\n      const shown = isOpen();\n      const cancel = driveRaw('panel-button', app.pid, 'Cancel');\n      note('a panel step failed; cancel try ' + (i + 1) + "), 'inPanel presses Cancel through Accessibility on every try, the first whatever isOpen() says, and notes it');
  assert.ok(body.includes('      if (!cancel.ok && !shown) break;\n'), 'and stops only when there is no Cancel to press and the test sees no panel');
  assert.match(text, /^const savePanelShown = \(\) => drive\('cgwindows', app\.pid\)\.windows\.filter\(\(x\) => x\.onscreen && x\.layer === 0\)\.length >= 2;$/m, 'the save panel is any second on-screen window at the normal level');
  const at = text.indexOf('await inPanel(savePanelShown, async () => {');
  assert.ok(at >= 0 && text.slice(at, at + 200).includes("\n    await until(savePanelShown, 'the save panel on screen', 10000);\n"), 'the Save test waits for its panel inside inPanel');
  assert.equal(/\n  await until\(savePanelShown, 'the save panel on screen'/.test(text), false, 'and not before it');
});

// e2e-run-4's show step (round 11): in e2e-run-4 (a92087a, 28 October 2026)
// the hidden-document test's page stayed hidden for the whole 5 s wait after
// the hook's show, which was AppHandle::show, an unhide alone (tao 0.37.1's
// show_application). The hook's show now unhides the app and then asks
// macOS to make it the active app, as a click on its Dock icon does, both on
// the main thread in that order, and answers after them; and the test's
// waits for the page's visibility record the window's state on a timeout
// (the hook's windowState, the driver's front app) and still fail. Read
// from the files, since only a launched test build runs them;
// harness-safety.mjs runs the test's timeout path under a fake of the hook.
test('the e2e hook\'s show unhides the app and then activates it, as a Dock click does, and the hidden-document test records the window\'s state on a timeout and still fails (e2e-run-4\'s show step)', () => {
  const code = read(TAURI, 'src', 'e2e.rs').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.equal(/\bapp\.show\(\)/.test(code), false, 'the hook does not show the app through AppHandle::show, an unhide alone');
  const arm = code.indexOf('} else if req["window"].as_str() == Some("show") {');
  const others = code.indexOf('} else if let Some(action) = req["window"].as_str() {');
  assert.ok(arm >= 0 && arm < others, 'show has its own branch, before the other window actions');
  assert.ok(code.slice(arm, code.indexOf('} else if', arm + 1)).includes([
    '            on_main_run_loop(move || {',
    '                let Some(mtm) = MainThreadMarker::new() else {',
    '                    return;',
    '                };',
    '                unhide_and_activate(&NSApplication::sharedApplication(mtm));',
    '                respond(&answer, json!({ "ok": true }));',
    '            });'
  ].join('\n')), 'show unhides and activates the app on the main thread, then answers');
  const fn = code.indexOf('\nfn unhide_and_activate(ns_app: &NSApplication) {\n');
  assert.ok(fn >= 0, 'unhide_and_activate is there');
  assert.equal(code.slice(fn, code.indexOf('\n}\n', fn) + 3), [
    '',
    'fn unhide_and_activate(ns_app: &NSApplication) {',
    '    ns_app.unhide(None);',
    '    if ns_app.respondsToSelector(sel!(activate)) {',
    '        ns_app.activate();',
    '    } else {',
    '        #[allow(deprecated)]',
    '        ns_app.activateIgnoringOtherApps(true);',
    '    }',
    '}',
    ''
  ].join('\n'), 'it unhides the app, then asks for activation: activate() from macOS 14, activateIgnoringOtherApps: before');
  const state = code.slice(code.indexOf('} else if req["windowState"].as_bool() == Some(true) {'), others);
  for (const want of ['ns_window.occlusionState()', '"occlusionVisible": occlusion.contains(NSWindowOcclusionState::Visible),', '"appActive": ns_app.isActive(),', '"appHidden": ns_app.isHidden(),']) {
    assert.ok(state.includes(want), 'windowState answers ' + want);
  }
  const e2e = read(path.join(DESKTOP, 'tests'), 'e2e.mjs');
  const wait = e2e.indexOf('\nasync function waitForVisibility(want, what) {\n');
  assert.equal(e2e.slice(wait, e2e.indexOf('\n}\n', wait) + 3), [
    '',
    'async function waitForVisibility(want, what) {',
    '  try {',
    '    await until(async () => (await js(`document.visibilityState`)) === want, what, 5000);',
    '  } catch (err) {',
    '    if (err instanceof UserActivity) throw err;',
    '    await windowEvidence(\'at the timeout waiting for \' + what);',
    '    throw err;',
    '  }',
    '}',
    ''
  ].join('\n'), 'a wait for the page\'s visibility gives it 5 s, records the window\'s state on a timeout, then throws the timeout');
  const evidence = e2e.slice(e2e.indexOf('\nasync function windowEvidence(when) {\n'), wait);
  for (const want of ["await read('hook', () => ask({ windowState: true }));", "drive('frontmost').pid", "note('window state ' + when + ' (evidence only, never a pass): ' + parts.join('; '));"]) {
    assert.ok(evidence.includes(want), 'windowEvidence: ' + want);
  }
  const at = e2e.indexOf("test('a minimized window and a hidden app give the page a hidden document");
  const body = e2e.slice(at, e2e.indexOf('\n});\n', at));
  assert.ok(at > wait && body.includes("for (const [away, back] of [['minimize', 'unminimize'], ['hide', 'show']]) {"), 'the test hides the app and shows it again through the hook');
  assert.equal([...body.matchAll(/await waitForVisibility\('(hidden|visible)', /g)].map((m) => m[1]).join(), 'hidden,visible', 'both of its waits go through waitForVisibility');
  assert.equal(/\buntil\(/.test(body), false, 'and no wait of the test goes around it');
});

// PO-R11-1 (round 12): the Product Owner's PO2-TOUCH-EVID took the rethrow
// out of windowEvidence's read helper and every suite passed. Pinned here as
// well as run in harness-safety.mjs: a person's touch during the evidence
// read stops the run, and only another error is noted as a part not read.
test('e2e.mjs\'s window evidence lets a person\'s touch stop the run: its read helper rethrows UserActivity before it notes a part it could not read (PO-R11-1)', () => {
  const e2e = read(path.join(DESKTOP, 'tests'), 'e2e.mjs');
  const start = e2e.indexOf('\nasync function windowEvidence(when) {\n');
  assert.ok(start >= 0, 'e2e.mjs has windowEvidence()');
  const body = e2e.slice(start, e2e.indexOf('\n}\n', start));
  assert.ok(body.includes("    } catch (err) {\n      if (err instanceof UserActivity) throw err;\n      parts.push(label + ' could not be read: ' + err.message);\n    }\n"), 'the read helper rethrows a touch before it notes a part as not read');
});

test('the web deployment allowlist is unchanged (DR-10)', () => {
  const lines = read(ROOT, '.vercelignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, ['*', '!index.html', '!covers', '!covers/**', '!vercel.json']);
});

let passed = 0;
let failed = 0;
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
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total. Errors: ${failed}`);
process.exit(failed ? 1 : 0);
