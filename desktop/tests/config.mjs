// Static checks of the desktop app's configuration: the promises the shell
// makes in its config files, checked on every `npm test` so an edit that
// breaks one fails at once instead of in a built app.
//
// Run from the repository root: node desktop/tests/config.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('the app runs in the App Sandbox with exactly its three entitlements, none for the network and none for Downloads (D-37, D-14, D-49)', () => {
  assert.equal(conf.bundle.macOS.entitlements, './Entitlements.plist');
  assert.notEqual(conf.bundle.macOS.hardenedRuntime, false, 'the hardened runtime stays on');
  assert.deepEqual(readPlist(read(TAURI, 'Entitlements.plist')), {
    'com.apple.security.app-sandbox': true,
    // The folder panel, the save panel (folder.rs) and the page's Open panel.
    // Save without a folder goes through the save panel, so no Downloads
    // entitlement is needed (D-49).
    'com.apple.security.files.user-selected.read-write': true,
    // The remembered folder is a security-scoped bookmark (bookmark.rs).
    'com.apple.security.files.bookmarks.app-scope': true
  });
});

test('the one bundled resource brings the vault and the app\'s data folder into the container at the first sandboxed launch (D-37; Apple\'s article says it copies them)', () => {
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
    assert.match(text, /^import \{ launchable, webDataFolder \} from '\.\/launch-guard\.mjs';$/m, file + ' takes the guard from launch-guard.mjs');
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

// The real-key save and folder tests (app.mjs) go to the test's own folder
// through the panel's Go-to box and press the panel's default button only
// after goTo, which cancels the panel when the panel does not show that
// folder; before, the default button was pressed either way, and a Go-to box
// that failed saved into the panel's start folder, the real Downloads or
// Documents folder (DM-239 d).
test('the real-key save and folder tests press a panel\'s default button only after the Go-to step that checks the panel shows the test\'s folder (DM-239 d)', () => {
  const text = read(path.join(DESKTOP, 'tests'), 'app.mjs');
  assert.match(text, /if \(!panelShowsFolder\(path\.basename\(folder\)\)\) \{\n    throw new Error\(/, 'goTo fails when the panel does not show the folder');
  for (const [panel, folder] of [['savePanelShown', 'SAVE_AS'], ['folderSheetShown', 'BUILD_TEST']]) {
    const at = text.indexOf('await inPanel(' + panel + ', async () => {');
    assert.ok(at >= 0, 'the ' + panel + ' flow');
    const body = text.slice(at, text.indexOf('});', at));
    assert.ok(body.indexOf('await goTo(' + folder + ');') >= 0, 'the ' + panel + ' flow goes to its own folder through goTo');
    assert.ok(body.indexOf('await goTo(' + folder + ');') < body.indexOf("keys.press('return')"), 'and presses the default button only after it');
    assert.equal(body.includes("press('cmd+shift+g')"), false, 'the Go-to keys are typed by goTo alone, which checks the panel');
  }
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
