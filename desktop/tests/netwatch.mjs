// Watches the desktop app for network use while other tests drive it: every
// half second it lists the internet sockets of the app's own processes and of
// the WebKit networking process that works for the app (found by the app's
// web data it holds open), and at the end it asks nettop for any flow those
// processes had. Run it in the background around a test run:
//
//   node tests/netwatch.mjs <seconds> <report.json> [<app bundle>]
//
// release.mjs hands it the bundle it opens, and the watch reads that bundle's
// identifier and sandbox state with the launch guard's reader
// (launch-guard.mjs). Inside the App Sandbox WebKit keeps the app's web data
// in the bundle's container, ~/Library/Containers/<id>/Data/Library/WebKit,
// with nothing under the identifier (sbprobe2-run-1, 26 October 2026, test
// migrate), so the networking process of a sandboxed bundle is found by that
// container path; outside the sandbox by ~/Library/WebKit/<id>/, or
// plain-sight/ for a test build run as a bare executable. With no bundle
// named, the app's own identifier is used (DM-242).
//
// Exit code 0: no socket and no flow seen; 1: something was seen (see the
// report); 2: the app was never seen running, or the bundle named could not
// be read, so nothing was proven.

import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REAL_ID, bundleFacts } from './launch-guard.mjs';

// The open files that mark a WebKit networking process as the app's: the
// app's web data, in the container for a sandboxed bundle and under
// Library/WebKit otherwise.
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function webDataPattern(facts = null) {
  const id = literal(facts ? facts.identifier : REAL_ID);
  return facts && facts.sandboxed
    ? new RegExp('/Library/Containers/' + id + '/Data/Library/WebKit/')
    : new RegExp('/Library/WebKit/(' + id + '|plain-sight)/');
}

const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (err) { return String(err.stdout || ''); } };
// The names of the files a process holds open, as lsof -Fn lists them: the
// one call the tests answer with a text of their own.
export const openFiles = (pid) => run('lsof', ['-p', String(pid), '-Fn']);
// A networking process works for one app; the app's holds the app's web data
// open.
export const worksForTheApp = (pid, pattern, list = openFiles) => pattern.test(list(pid));

async function watch([seconds = '600', report = 'netwatch.json', bundle = null]) {
  let facts = null;
  if (bundle) {
    try {
      facts = bundleFacts(bundle);
    } catch (err) {
      const verdict = 'the bundle could not be read: ' + String(err && err.message ? err.message : err);
      writeFileSync(report, JSON.stringify({ appPids: [], networkPids: [], samples: 0, sockets: [], nettopLinesForOurPids: [], bundle, verdict }, null, 2));
      console.log('netwatch: ' + verdict);
      process.exit(2);
    }
  }
  const DATA = webDataPattern(facts);
  const deadline = Date.now() + Number(seconds) * 1000;
  // Which processes are the app: those named plain-sight, the release
  // bundle's executable and a test build's alike (by name, so a pgrep or a
  // shell that names the app's path in its arguments is not taken for it).
  // NETWATCH_APP, a pattern for the command line, replaces this only for the
  // positive control that shows this watch does see a process that uses the
  // network.
  const APP = process.env.NETWATCH_APP ? new RegExp(process.env.NETWATCH_APP) : null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const appPids = new Set();
  const networkPids = new Set();
  const sockets = [];
  let samples = 0;
  let stopped = false;

  // nettop logs every process's traffic once a second for the whole watch, so
  // a connection that opens and closes between two socket samples still
  // shows, and so do processes that ended before the watch did.
  const nettopLines = [];
  // Under a pseudo-terminal (script), so nettop writes each line at once
  // instead of holding them in a buffer that a stop would lose. No -t:
  // without it nettop monitors all interfaces, loopback and AWDL included.
  const nettop = spawn('script', ['-q', '/dev/null', 'nettop', '-P', '-L', '0', '-s', '1', '-x', '-J', 'bytes_in,bytes_out'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let partial = '';
  nettop.stdout.on('data', (chunk) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    for (const raw of lines) { const line = raw.replace(/\r$/, ''); if (/^[^,]*\.\d+,/.test(line)) nettopLines.push(line); }
  });
  process.on('SIGTERM', () => { stopped = true; });
  process.on('SIGINT', () => { stopped = true; });

  function refresh() {
    const found = APP ? run('pgrep', ['-fl', '.']) : run('pgrep', ['-x', 'plain-sight']);
    for (const line of found.split('\n')) {
      const [first, ...cmd] = line.trim().split(' ');
      const pid = Number(first);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && (!APP || APP.test(cmd.join(' ')))) appPids.add(pid);
    }
    for (const line of run('pgrep', ['-f', 'com.apple.WebKit.Networking']).split('\n')) {
      const pid = Number(line.trim());
      if (!pid || networkPids.has(pid)) continue;
      // One that does not hold the app's web data yet is checked again at
      // every sample, since a new launch's process opens it a moment after it
      // starts (DM-219).
      if (worksForTheApp(pid, DATA)) networkPids.add(pid);
    }
  }

  while (!stopped && Date.now() < deadline) {
    refresh();
    // Alive: signal 0 succeeds, or is refused only for lack of permission.
    const pids = [...appPids, ...networkPids].filter((p) => { try { process.kill(p, 0); return true; } catch (err) { return err.code === 'EPERM'; } });
    if (pids.length) {
      samples += 1;
      const out = run('lsof', ['-nP', '-i', '-a', '-p', pids.join(',')]).trim();
      if (out) sockets.push({ at: new Date().toISOString(), lsof: out });
    }
    await sleep(500);
  }

  nettop.kill('SIGTERM');
  // The logged lines of our processes (name.pid,bytes_in,bytes_out,): a
  // process that never had a flow is not listed, and a listed one shows its
  // bytes.
  const flows = nettopLines.filter((line) => [...appPids, ...networkPids].some((pid) => line.includes('.' + pid + ',')));

  const result = {
    appPids: [...appPids], networkPids: [...networkPids], samples, sockets, nettopLinesForOurPids: flows,
    // What the networking process was matched by, for the record.
    bundle: facts ? { app: bundle, identifier: facts.identifier, sandboxed: facts.sandboxed } : null, webData: String(DATA),
    // Any listed line counts: even with no bytes yet, it means a socket existed.
    verdict: !appPids.size ? 'the app was never seen running' : sockets.length || flows.length ? 'network use seen' : 'no network use seen'
  };
  writeFileSync(report, JSON.stringify(result, null, 2));
  console.log(`netwatch: ${result.verdict}; app pids ${result.appPids.join(' ') || 'none'}, WebKit networking pids ${result.networkPids.join(' ') || 'none'} (by ${result.webData}), ${samples} samples, ${sockets.length} with sockets, ${flows.length} nettop lines for these pids`);
  process.exit(!appPids.size ? 2 : result.verdict === 'no network use seen' ? 0 : 1);
}

const MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (MAIN) await watch(process.argv.slice(2));
