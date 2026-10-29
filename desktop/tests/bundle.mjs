// Checks the built app itself, not its source (DR-06, DR-08): the bundle's
// files and size, its Info.plist, its signature and the entitlements in it,
// that it carries no test hook, and that the page files embedded in its binary
// are exactly index.html and the three covers, as they are in the repository.
//
// Run from desktop/ after `npm run app:build`:
//   node tests/bundle.mjs [path/to/Plain Sight.app]

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESKTOP, '..');
const APP = process.argv[2] || path.join(DESKTOP, 'src-tauri/target/release/bundle/macos/Plain Sight.app');
const BIN = path.join(APP, 'Contents/MacOS/plain-sight');
// .../target/release/bundle/macos/Plain Sight.app -> .../target/release/build
const BUILD = path.join(path.dirname(path.dirname(path.dirname(APP))), 'build');
const sha = (b) => createHash('sha256').update(b).digest('hex');

function files(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, rel + name + '/'));
    else out.push(rel + name);
  }
  return out.sort();
}

// Every element, attribute and text node, in order: two pages that give the
// same list are the same page to a browser.
function domNodes(html) {
  const d = new JSDOM(html).window.document;
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 1) {
      out.push('<' + n.nodeName + ' ' + [...n.attributes].map((a) => a.name + '=' + JSON.stringify(a.value)).sort().join(' '));
      n.childNodes.forEach(walk);
      out.push('</' + n.nodeName);
    } else if (n.nodeType === 3 || n.nodeType === 8) out.push(n.nodeType + JSON.stringify(n.nodeValue));
  };
  walk(d.documentElement);
  return out;
}

// A property list as plutil reads it.
const plist = (xml) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' }));

// Keys the built Info.plist must not hold (QA-G-26, B22): a bundle-level
// network allowance (NSAppTransportSecurity) would loosen the system's
// network rules for the app behind the entitlement check's back, the more
// so since the app carries the network client entitlement (28 October
// 2026) and its own code and the page's policy keep it off the network.
// Read through plutil from the
// built file, so a tampered copy of the bundle is caught; config.mjs holds
// the function to a scratch property list on every npm test.
export const FORBIDDEN_INFO_KEYS = ['NSAppTransportSecurity'];
export function forbiddenInfoKeys(plistPath) {
  return Object.keys(plist(readFileSync(plistPath))).filter((key) => FORBIDDEN_INFO_KEYS.includes(key));
}

// The tests below run only when this file is the program, so config.mjs can
// import the function above without running them.
const MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the bundle holds the shell and nothing else: Info.plist, the binary, the icon, the container migration manifest and the signature', () => {
  assert.deepEqual(files(APP), ['Contents/Info.plist', 'Contents/MacOS/plain-sight', 'Contents/Resources/container-migration.plist', 'Contents/Resources/icon.icns', 'Contents/_CodeSignature/CodeResources']);
});

test('the container migration manifest is the repository\'s, byte for byte (D-37)', () => {
  const bundled = readFileSync(path.join(APP, 'Contents/Resources/container-migration.plist'));
  assert.equal(sha(bundled), sha(readFileSync(path.join(DESKTOP, 'src-tauri/container-migration.plist'))));
});

test('the signature carries exactly the four entitlements of Entitlements.plist: the App Sandbox, the network client and no other network entitlement, no Downloads (D-37, D-49; the network client approved by Pranav on 28 October 2026)', () => {
  const shown = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', APP], { encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  const signed = plist(shown.stdout);
  assert.deepEqual(signed, plist(readFileSync(path.join(DESKTOP, 'src-tauri/Entitlements.plist'))));
  assert.deepEqual(Object.keys(signed).sort(), ['com.apple.security.app-sandbox', 'com.apple.security.files.bookmarks.app-scope', 'com.apple.security.files.user-selected.read-write', 'com.apple.security.network.client'], 'exactly four');
  assert.equal(signed['com.apple.security.app-sandbox'], true, 'sandboxed');
  assert.deepEqual(Object.keys(signed).filter((k) => k.startsWith('com.apple.security.network.')), ['com.apple.security.network.client'], 'the network client only, no network server');
  assert.equal(signed['com.apple.security.network.client'], true, 'the network client: without it the sandboxed probe page gave no answer in 31 seconds (26 October)');
  assert.equal(signed['com.apple.security.files.downloads.read-write'], undefined, 'no Downloads entitlement: Save without a folder goes through the save panel');
});

test('the app is small: well under 10 MB (DR-06)', () => {
  const bytes = files(APP).reduce((n, f) => n + statSync(path.join(APP, f)).size, 0);
  console.log('       size: ' + bytes + ' bytes in the bundle, ' + statSync(BIN).size + ' in the binary');
  assert.ok(bytes < 10 * 1024 * 1024);
});

test('Info.plist names the app, its identifier, its version, the macOS it needs, its App Store category, the export compliance answer and the copyright', () => {
  const read = (key) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', path.join(APP, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(read('CFBundleIdentifier'), 'com.pranavongole.plainsight');
  assert.equal(read('CFBundleName'), 'Plain Sight');
  assert.equal(read('CFBundleShortVersionString'), '1.0.0');
  assert.equal(read('LSMinimumSystemVersion'), '12.0', 'Apple Silicon only (D-47)');
  assert.equal(read('LSApplicationCategoryType'), 'public.app-category.productivity', 'the App Store category (D-37)');
  // From src-tauri/Info.plist, merged in by the bundler (D-46).
  assert.equal(read('ITSAppUsesNonExemptEncryption'), 'false', 'the export compliance answer');
  assert.equal(read('NSHumanReadableCopyright'), 'Copyright 2026 Pranav Ongole. MIT License.');
  assert.deepEqual(forbiddenInfoKeys(path.join(APP, 'Contents/Info.plist')), [], 'no NSAppTransportSecurity key (QA-G-26, B22)');
  assert.match(execFileSync('lipo', ['-archs', BIN], { encoding: 'utf8' }).trim(), /^arm64$/);
});

test('the whole bundle is sealed with an ad-hoc signature and the hardened runtime (DM-201)', () => {
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', APP], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
  const info = spawnSync('codesign', ['-dv', APP], { encoding: 'utf8' }).stderr;
  assert.match(info, /Identifier=com\.pranavongole\.plainsight/);
  assert.match(info, /flags=0x[0-9a-f]+\(adhoc,runtime\)/);
});

test('the crates the app is built from hold no network crate and no Tauri plugin (cargo tree, QA-C-05)', () => {
  // The resolved graph for the Mac build, build scripts included, so a crate
  // renamed in Cargo.toml or pulled in by another one is seen by its own name.
  const tree = execFileSync('cargo', ['tree', '--offline', '--target', 'aarch64-apple-darwin', '-e', 'normal,build', '--prefix', 'none',
    '--manifest-path', path.join(DESKTOP, 'src-tauri/Cargo.toml')], { encoding: 'utf8', env: { ...process.env, PATH: path.join(os.homedir(), '.cargo/bin') + ':' + process.env.PATH } });
  const crates = new Set(tree.split('\n').map((l) => l.trim().split(' ')[0]).filter(Boolean));
  assert.ok(crates.has('tauri') && crates.has('rfd') && crates.size > 100, 'the build graph was read: ' + crates.size + ' crates');
  for (const c of crates) {
    assert.ok(!/^(reqwest|hyper|ureq|isahc|curl|rustls|native-tls|openssl|tungstenite|websocket|h2|surf|attohttpc)([-_].*)?$/.test(c), 'no network crate: ' + c);
    assert.ok(!c.startsWith('tauri-plugin-'), 'no Tauri plugin: ' + c);
  }
});

test('the binary carries no test hook (the e2e feature is not in it)', () => {
  const bin = readFileSync(BIN);
  for (const marker of ['PLAIN_SIGHT_E2E', 'windowTitle', 'delegateResponds', 'windowRestorable', 'unknown quit']) assert.equal(bin.indexOf(marker), -1, marker);
});

test('the page files embedded in the binary are exactly index.html and the three covers (DR-08)', () => {
  const bin = readFileSync(BIN);
  const seen = new Map();   // asset hash name -> decompressed bytes, for assets whose compressed bytes are in the binary
  for (const dir of readdirSync(BUILD).filter((d) => d.startsWith('plain-sight-'))) {
    let names = [];
    try { names = readdirSync(path.join(BUILD, dir, 'out', 'tauri-codegen-assets')); } catch { continue; }
    for (const name of names) {
      if (seen.has(name)) continue;
      const compressed = readFileSync(path.join(BUILD, dir, 'out', 'tauri-codegen-assets', name));
      if (bin.indexOf(compressed) >= 0) seen.set(name, brotliDecompressSync(compressed));
    }
  }
  assert.equal(seen.size, 4, 'four embedded page files, found ' + seen.size);
  const embedded = [...seen.values()];
  for (const id of ['book', 'paper', 'work']) {
    const source = readFileSync(path.join(ROOT, 'covers', id + '.js'));
    assert.equal(embedded.filter((b) => sha(b) === sha(source)).length, 1, 'covers/' + id + '.js is embedded byte for byte');
  }
  const pages = embedded.filter((b) => b.toString('utf8', 0, 15).toLowerCase().startsWith('<!doctype html'));
  assert.equal(pages.length, 1, 'one page');
  assert.deepEqual(domNodes(pages[0].toString('utf8')), domNodes(readFileSync(path.join(ROOT, 'index.html'), 'utf8')), 'the embedded page is the repository page, node for node');
});

if (MAIN) {
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
}
