#!/usr/bin/env node
// Writes vercel.json from index.html: the security headers Vercel serves with the
// page, with a script policy that allows scripts from the page's own origin and its
// two inline scripts by hash, and nothing else. Run it after any change to index.html and commit vercel.json with
// it; the test suite fails when the two disagree. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function inlineScriptHashes(html) {
  const hashes = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc=/.test(m[1])) continue;
    hashes.push("'sha256-" + createHash('sha256').update(m[2], 'utf8').digest('base64') + "'");
  }
  return hashes;
}
export function headersFor(html) {
  const policy = [
    "default-src 'none'",
    "script-src 'self' " + inlineScriptHashes(html).join(' '),
    "style-src 'unsafe-inline'",
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
  return [
    { key: 'Content-Security-Policy', value: policy },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' }
  ];
}
export function vercelConfigFor(html) {
  return JSON.stringify({ headers: [{ source: '/(.*)', headers: headersFor(html) }] }, null, 2) + '\n';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const out = vercelConfigFor(html);
  const target = path.join(root, 'vercel.json');
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const count = inlineScriptHashes(html).length;
  if (process.argv.includes('--check')) {
    if (before === out) { console.log('vercel.json matches index.html: ' + count + ' inline script hash(es)'); process.exit(0); }
    console.log('vercel.json does not match index.html: run node tools/vercel-headers.mjs and commit the result');
    process.exit(1);
  }
  fs.writeFileSync(target, out);
  console.log((before === out ? 'vercel.json unchanged' : 'vercel.json written') + ': ' + count + ' inline script hash(es)');
}
