// The test harness's own safety (harness.mjs), checked on every `npm test`
// against a fake home inside a temporary folder of this test's own, never the
// real one (QA-G-30): before any backup a restore or a clear changes nothing;
// a restore asked for while the backup is incomplete is refused and names
// what to put back; a second restore after a complete one changes nothing;
// and the signal handlers are installed before the app's data is moved
// aside, so a Ctrl+C or a kill during the move is taken after it and
// everything is put back (QA-G-24). The cases named run-* run the harness's
// run() itself, with tests of their own that launch nothing: a test copy's
// container that macOS will not let the run remove is test data left
// behind, exit code 8, while the same refusal on a folder of the person's own
// still ends with 6; a run on a copy whose container is still there, and a
// move aside that macOS refuses, do not start (DM-243). Every case runs in a
// child process whose HOME, TMPDIR and evidence folder lie inside that
// temporary folder, which is removed at the end. The driver never runs: a
// stand-in in the child answers run()'s questions to it (Accessibility, the
// screen's lock and idle time, the app's windows) and to pgrep (whether the
// app is open) from the case's own state, so no app is launched and nothing
// on the Mac is touched.
//
// Run from the repository root: node desktop/tests/harness-safety.mjs

import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'harness.mjs');
// The child's own folder, which its HOME and TMPDIR must lie inside.
const BOX = 'PLAIN_SIGHT_HARNESS_TEST_BOX';
// The parent writes this file in the box once it has sent the signal.
const SIGNAL_SENT = 'signal-sent';
// DM-249: the stand-in app the parent writes into its temporary folder, whose
// path each child is handed, and the file in the box where every stand-in
// records its pid.
const STANDIN = 'PLAIN_SIGHT_HARNESS_TEST_STANDIN';
const STANDIN_PIDS = 'standin-pids.txt';
// The late writer of the restore check's cases (round 10), written by the
// parent into its temporary folder.
const LATE = 'PLAIN_SIGHT_HARNESS_TEST_LATE';
// DM-269 (round 21): the file in the box where the child records the pid of
// each late writer it starts, so that the parent can end one by its pid.
const LATE_PIDS = 'late-pids.txt';
// The restore check's second look in a case that does not test the check:
// 100 ms instead of 3 s, set through the harness's test-only setter.
const RECHECK = 'PLAIN_SIGHT_HARNESS_TEST_RECHECK_MS';
// The pid holder of the reused pid's cases (round 12), written by the parent
// into its temporary folder.
const HOLDER_ENV = 'PLAIN_SIGHT_HARNESS_TEST_HOLDER';
// The harness compiles its driver at import unless the file for this source
// version exists. No case here runs the driver, so an empty file stands in
// for it, in the child's own temporary folder.
const DRIVER = 'plain-sight-drive-' + createHash('sha256').update(readFileSync(path.join(HERE, 'drive.swift'))).digest('hex').slice(0, 12);
const BACKUP_ROOT = (home) => path.join(home, 'cover-story-delivery', 'desktop', 'appdata-backup');
const LOCK = (home) => path.join(home, 'cover-story-delivery', 'desktop', '.gui-test.lock');
const CONTAINERS = (home) => path.join(home, 'Library', 'Containers');
const marker = (dir) => path.join(dir, 'marker');
const real = (home, dir) => 'REAL ' + path.relative(home, dir);
// A test copy's identifier, as testcopy.mjs makes one, and its data folders,
// which the run makes, never the person.
const TEST_COPY = 'com.pranavongole.plainsight.testcopy-1761000003';
// The clipboard file an earlier run left in an evidence folder used twice
// (QA-G-51 (b), round 18).
const STALE_CLIPBOARD = 'A CLIPBOARD FROM AN EARLIER RUN\n';
const isTestFolder = (dir) => /^com\.pranavongole\.plainsight\.(testcopy|sbprobe)-/.test(path.basename(dir));
// PO-R18-1 (round 19): the second temporary folder of the signal guard's
// proof case, outside every case's folder, and the file in a case's folder
// where the guard writes each signal it refused.
const OUTSIDE = 'PLAIN_SIGHT_HARNESS_TEST_OUTSIDE';
const REFUSALS = 'signal-refusals.txt';
// DM-269 (round 21): what the hostile-prints case aims its lines at, in
// JSON: the pids of the parent's own two stand-ins (one outside this run's
// folder, one inside it but in no case's folder) and their folders.
const TARGETS = 'PLAIN_SIGHT_HARNESS_TEST_TARGETS';

// DISH-G-103 (round 21): what the signal guard's proof case tries, aimed at
// its second stand-in alone (a clone of node under a name of its own, which
// is its process name): each of the four programs that can signal another
// process (kill and osascript by its pid, pkill -x and killall by its name),
// bare, by its path, through env and through xargs (which takes the target
// on its standard input), each in every form of FORMS. osascript's script
// builds its kill command from two halves, so that osascript is the only
// refused name in it.
const SIGNALLERS = (pid, name) => {
  const script = 'do shell script "/bin/ki" & "ll -TERM ' + pid + '"';
  return [
    ['kill', '/bin/kill', ['-TERM', pid], ['-TERM'], pid],
    ['pkill', '/usr/bin/pkill', ['-TERM', '-x', name], ['-TERM', '-x'], name],
    ['killall', '/usr/bin/killall', ['-TERM', name], ['-TERM'], name],
    ['osascript', '/usr/bin/osascript', ['-e', script], ['-e'], "'" + script + "'"]
  ].flatMap(([program, full, args, xargsArgs, input]) => [
    ['bare', program, args, ''],
    ['by its path', full, args, ''],
    ['through env', 'env', [program, ...args], ''],
    ['through xargs', 'xargs', [program, ...xargsArgs], input]
  ].map(([how, file, list, stdin]) => ({ program, what: program + ' ' + how, file, args: list, input: stdin })));
};
// The five forms the proof case starts each in: as a program (execFileSync,
// spawnSync) and in a shell's command (execSync, /bin/sh -c, and spawnSync
// with shell: true), the command written as a shell takes it (shellWord);
// formText is the text the guard reads in each.
const FORMS = ['execFileSync', 'spawnSync', 'execSync', '/bin/sh -c', 'spawnSync with shell: true'];
const shellWord = (word) => (/^[\w./-]+$/.test(word) ? word : "'" + word.replace(/'/g, "'\\''") + "'");
const commandLine = (t) => [t.file, ...t.args].map(shellWord).join(' ');
const formText = (form, t) => (form === 'execFileSync' || form === 'spawnSync' ? [t.file, ...t.args].join(' ') : form === '/bin/sh -c' ? '/bin/sh -c ' + commandLine(t) : commandLine(t));
// PO-R21-1 and QA-G-54 (round 22): command lines a shell runs, each aimed at
// the proof case's second stand-in alone. The four names quoted or escaped
// as a shell takes them ("kill", 'pkill', \killall, "/usr/bin/osascript"),
// and QA-01's shapes from r19_sigguard_adv.mjs (wave-g/qa/scripts/app) that
// got through the guard of 52a3914: /bin/kill alone, after true; and in
// parentheses, /usr/bin/pkill, /usr/bin/killall and /usr/bin/osascript in a
// shell's command, "kill" quoted, \kill, and nohup kill. Each is taken over
// as QA-01 wrote it but for its target, the second stand-in's pid or name in
// place of its own holder, and -TERM in place of -USR1, so that a signal that
// got through ends the stand-in. The proof case runs each line as a shell's
// command (execSync) and as a program's argument (/bin/sh -c), and nohup
// kill also as the program QA-01 ran (argv).
const QUOTED = (pid, name) => {
  const script = shellWord('do shell script "/bin/ki" & "ll -TERM ' + pid + '"');
  return [
    { what: '"kill", quoted (PO-R21-1; QA-01\'s sh-quoted-kill)', program: 'kill', line: '"kill" -TERM ' + pid },
    { what: '\'pkill\', quoted (PO-R21-1)', program: 'pkill', line: '\'pkill\' -TERM -x ' + name },
    { what: '\\killall, escaped (PO-R21-1)', program: 'killall', line: '\\killall -TERM ' + name },
    { what: '"/usr/bin/osascript", by its path and quoted (PO-R21-1)', program: 'osascript', line: '"/usr/bin/osascript" -e ' + script },
    { what: '/bin/kill alone (QA-01\'s sh-c-bin-kill)', program: 'kill', line: '/bin/kill -TERM ' + pid },
    { what: '/bin/kill after true; (QA-01\'s sh-chain-bin-kill)', program: 'kill', line: 'true; /bin/kill -TERM ' + pid },
    { what: '/bin/kill in parentheses (QA-01\'s sh-paren-bin-kill)', program: 'kill', line: '(/bin/kill -TERM ' + pid + ')' },
    { what: '/usr/bin/pkill (QA-01\'s sh-usr-bin-pkill)', program: 'pkill', line: '/usr/bin/pkill -TERM -x ' + name },
    { what: '/usr/bin/killall (QA-01\'s sh-usr-bin-killall)', program: 'killall', line: '/usr/bin/killall -TERM ' + name },
    { what: '/usr/bin/osascript (QA-01\'s sh-usr-bin-osascript)', program: 'osascript', line: '/usr/bin/osascript -e ' + script },
    { what: '\\kill, escaped (QA-01\'s sh-backslash-kill)', program: 'kill', line: '\\kill -TERM ' + pid },
    { what: 'nohup kill (QA-01\'s nohup-kill)', program: 'kill', line: 'nohup kill -TERM ' + pid, argv: ['/usr/bin/nohup', 'kill', '-TERM', pid] }
  ];
};
// The texts the guard reads for each of QUOTED's lines: the shell's command,
// the program /bin/sh with its arguments, and nohup kill as its program.
const quotedTexts = (t) => [t.line, '/bin/sh -c ' + t.line, ...(t.argv ? [t.argv.join(' ')] : [])];
// DM-270 (round 23): the commands the Delivery Manager got past the guard
// of 6eea2b7 with, and their kin, each aimed at the proof case's second
// stand-in alone: a node with NODE_OPTIONS emptied in a shell's command
// (its AG24), unset by /bin/sh, or taken out by env -u, and env -i (its
// AG23), each running process['ki'+'ll'] on the stand-in's pid, a name the
// word rule cannot see, so that only the new rule refuses it; ANSI-C
// quoting in a shell's command and in /bin/sh -c (its AG18, here with
// -TERM in place of its signal 0); and kill through exec and execFile, the
// two ways child_process starts a program that no other try takes. how is
// the way each is started, and evasionText the text the guard reads.
const EVASIONS = (pid, node) => {
  const code = "process['ki'+'ll'](" + pid + ', 15)';
  const viaNode = shellWord(node) + ' -e ' + shellWord(code);
  return [
    { what: 'NODE_OPTIONS emptied in a shell\'s command (the Delivery Manager\'s AG24)', reason: 'NODE_OPTIONS', how: 'execSync', line: 'NODE_OPTIONS= ' + viaNode },
    { what: 'NODE_OPTIONS unset by /bin/sh -c', reason: 'NODE_OPTIONS', how: '/bin/sh -c', line: 'unset NODE_OPTIONS; ' + viaNode },
    { what: 'env -u NODE_OPTIONS', reason: 'NODE_OPTIONS', how: 'execFileSync', argv: ['/usr/bin/env', '-u', 'NODE_OPTIONS', node, '-e', code] },
    { what: 'env -i (the Delivery Manager\'s AG23)', reason: 'env', how: 'execFileSync', argv: ['/usr/bin/env', '-i', node, '-e', code] },
    { what: 'ANSI-C quoting in a shell\'s command (the Delivery Manager\'s AG18)', reason: 'ansi', how: 'execSync', line: "$'\\x6b'ill -TERM " + pid },
    { what: 'ANSI-C quoting in /bin/sh -c', reason: 'ansi', how: '/bin/sh -c', line: "$'\\x6b'ill -TERM " + pid },
    { what: 'kill through exec', reason: 'kill', how: 'exec', line: 'kill -TERM ' + pid },
    { what: 'kill through execFile', reason: 'kill', how: 'execFile', argv: ['kill', '-TERM', String(pid)] }
  ];
};
const evasionText = (t) => (t.how === 'execSync' || t.how === 'exec' ? t.line : t.how === '/bin/sh -c' ? '/bin/sh -c ' + t.line : t.argv.join(' '));
// QA-G-55 and QA-G-56 (round 24): QA-01's routes from r22_wordrule_adv.mjs
// (wave-g/qa/scripts/app) that the guard of 6eea2b7 let reach its own
// outside process, and its string shell option (its W5), each aimed at the
// proof case's second stand-in alone, -TERM in place of its -USR1: the names
// in another case (the volume and the shell's lookup ignore case), a glob in
// the name, and ChildProcess.spawn called directly; with PKILL, KillAll and
// OSAScript, so that each of the four is tried in another case. how is the
// way each is started, and routeText the text the guard reads.
const ROUTES = (pid, name) => {
  const script = shellWord('do shell script "/bin/ki" & "ll -TERM ' + pid + '"');
  return [
    { what: '/bin/KILL, upper case (QA-01)', names: 'kill', how: 'execSync', line: '/bin/KILL -TERM ' + pid },
    { what: '/bin/Kill, mixed case (QA-01)', names: 'kill', how: 'execSync', line: '/bin/Kill -TERM ' + pid },
    { what: 'KILL looked up through PATH (QA-01)', names: 'kill', how: 'execSync', line: 'KILL -TERM ' + pid },
    { what: '/usr/bin/PKILL in /bin/sh -c', names: 'pkill', how: '/bin/sh -c', line: '/usr/bin/PKILL -TERM -x ' + name },
    { what: '/usr/bin/KillAll in /bin/sh -c', names: 'killall', how: '/bin/sh -c', line: '/usr/bin/KillAll -TERM ' + name },
    { what: '/usr/bin/OSAScript in /bin/sh -c', names: 'osascript', how: '/bin/sh -c', line: '/usr/bin/OSAScript -e ' + script },
    { what: '/bin/k?ll, a glob (QA-01)', names: 'kill', how: 'execSync', line: '/bin/k?ll -TERM ' + pid },
    { what: '/bin/[k]ill, a glob (QA-01)', names: 'kill', how: 'execSync', line: '/bin/[k]ill -TERM ' + pid },
    { what: '/bin/k*, a glob (QA-01)', names: 'kill and killall', how: 'execSync', line: '/bin/k* -TERM ' + pid },
    { what: 'ChildProcess.spawn called directly (QA-01)', names: 'kill', how: 'ChildProcess.spawn', argv: ['/bin/kill', 'kill', '-TERM', String(pid)] },
    { what: 'a string shell option, spawnSync(\'x\', [], { shell: \'/bin/kill\' }) (QA-01\'s W5)', names: 'kill', how: 'shell option', text: 'x /bin/kill' }
  ];
};
const routeText = (t) => (t.how === 'execSync' ? t.line : t.how === '/bin/sh -c' ? '/bin/sh -c ' + t.line : t.how === 'ChildProcess.spawn' ? t.argv.join(' ') : t.text);

// PO-R18-1 (round 19), DM-268 and DISH-G-103 (round 21): a child of this
// suite never signals a process outside its own case's folder, whatever the
// code it runs asks for. In round 18 a break of copiesOf that took any
// program named plain-sight made one case's end of the suites' copies signal
// another run's stand-ins (SIGTERM, then SIGKILL 5 s later), and a real Plain
// Sight running then would have been signalled as well. So the child
// installs this guard first, before its stand-ins and before it imports
// harness.mjs, app.mjs or e2e.mjs, and no change to those files can undo it
// (config.mjs pins where it stands). What it covers:
// - process.kill, through Node's process._kill, which process.kill calls for
//   every signal. Signal 0, which only asks whether a process exists, and a
//   signal to the child itself pass. Any other signal first reads the
//   target's program with /bin/ps, its folders resolved: a process gone,
//   ending (the flag E) or ended (the state Z) gets nothing and answers
//   ESRCH, as macOS would; a program under the case's folder (the folder
//   and a separator, so never a folder beside it whose name starts with the
//   case's) gets the signal; anything else, a process group included, gets
//   nothing and answers EPERM.
// - A child process's kill(), which goes through Node's handle and not
//   process._kill: the same rule, on its pid, unless Node has seen it end
//   (it then sends nothing); a refused one returns false.
// - kill, pkill, killall and osascript started through child_process, by
//   every one of its ways (execFileSync, execFile, spawnSync, spawn,
//   execSync, exec and fork), as a program or in a shell's command (shell:
//   true included): refused when any word of the command, as a shell reads
//   it, has one of the four as its last path segment. That takes in the
//   first word of every command, a path such as /usr/bin/pkill, and the
//   word after env, xargs, nohup, command, exec, sudo, time or any other
//   program that runs the next one. Nothing the children test runs them.
// - DM-270 (round 23): a command that would start node without this guard,
//   or spell a name the word rule cannot read: one that names NODE_OPTIONS
//   (sets or clears it, in a shell or through env), one that runs env with an
//   option (env -i, env - and env -u empty the environment or a part of it),
//   and one with ANSI-C quoting ($'...', which a shell decodes, so that
//   $'\x6b'ill is kill): each refused as a command, in the same ways.
// - DM-270: a worker thread, whose process (and its kill) is its own and
//   not wrapped here: a Worker is refused at its start.
// - QA-G-55 (round 24): names are compared without case (the volume and the
//   shell's lookup ignore it, so /bin/KILL runs kill); a word whose last
//   path segment, read as a shell glob, can match one of the four names
//   (k?ll, [k]ill, k*) is refused as if it named it; and every start is read
//   at ChildProcess.prototype.spawn too, the one place spawn, fork, exec and
//   execFile all go through, so that ChildProcess.spawn called directly is
//   read as well (spawnSync, execSync and execFileSync are read at their
//   own functions), and the environment it is given gets the guard's module.
// - Every node a case starts, by fork, spawn or a shell, at any depth, with
//   the environment it is given: it loads this same guard first, from the
//   module the guard writes into the case's folder from its own text at its
//   install, through NODE_OPTIONS, which the guard sets in the child's own
//   environment and adds to any environment a start is given.
// The guard stands on its own (round 22): everything it uses is a name its
// loader gives it (fs, path, os, childProcess, syncBuiltinESMExports and
// REFUSALS) or comes from process.getBuiltinModule, so a copy cut out of this
// file's text, as QA-01's r19_guard.mjs and the Delivery Manager's ag.mjs
// make one, is the same guard, its module included.
// Each refusal is printed with the pid and the program, or the command, and
// written to the case's refusals file, and runCase fails the case for it.
// What it does not cover (round 24, the Product Owner's D-59: the guard is a
// net for a mistaken edit of the test code, not a sandbox): what a program
// other than node does once it runs (a shell script file or a compiled
// program can signal by itself, unseen: only the command that starts it is
// read); a program under another name (a link to /bin/kill made with fs and
// run by its own name, QA-01's QA-G-55: the word rule reads names, not
// files); a node such a program starts with an emptied environment; a name
// built while a command runs (two variables, $CMD from the environment, eval
// of a variable, $(printf ...), base64, or a name built inside another
// language such as python's getattr); a command a shell or xargs reads on
// its standard input, or from a script file, which is data here; the
// moment between the guard's look at a
// target with ps and its send, in which a target that runs another program
// (exec) still gets the signal (QA-01 measured it; the parent's endCasePid
// has the same moment); and the driver, which never runs in a child (the
// stand-in answers every driver command, and its one answer that signals,
// the copy case's quit, goes through process.kill). The children start none
// of these to signal. A case that started a process outside its folder ends
// it through sendOwn, which is never handed to the code under test.
function installSignalGuard(box) {
  const own = fs.realpathSync(box);
  const runPs = childProcess.spawnSync;
  const send = process._kill;
  let refused = 0;
  let tried = 0;
  const refuse = (what) => {
    refused += 1;
    console.log('SIGNAL REFUSED ' + what);
    fs.appendFileSync(path.join(box, REFUSALS), what + '\n');
  };
  const programOf = (pid) => {
    const ps = runPs('/bin/ps', ['-ww', '-o', 'stat=', '-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
    const [, stat, program] = String(ps.stdout || '').replace(/\n+$/, '').match(/^\s*(\S+)\s+(.*)$/s) || [];
    return stat && !/[EZ]/.test(stat) ? program : null;
  };
  const resolved = (p) => { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; } };
  // Where a pid's program lies: null for a process gone, ending or ended;
  // otherwise the program, and whether it lies inside the case's folder.
  const placeOf = (pid) => { const program = programOf(pid); return program === null ? null : { program, inside: resolved(program).startsWith(own + path.sep) }; };
  process._kill = (pid, signal) => {
    if (signal === 0 || pid === process.pid) return send.call(process, pid, signal);
    tried += 1;
    if (!(pid > 0)) { refuse('signal ' + signal + ' to ' + pid + ', a process group'); return -1; }
    const place = placeOf(pid);
    if (place === null) return -3;   // ESRCH: gone, ending or ended
    if (place.inside) return send.call(process, pid, signal);
    refuse('signal ' + signal + ' to pid ' + pid + ' (' + place.program + '), outside the case\'s folder ' + box);
    return -1;   // EPERM
  };
  const killChild = childProcess.ChildProcess.prototype.kill;
  childProcess.ChildProcess.prototype.kill = function kill(signal = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null || !(this.pid > 0)) return killChild.call(this, signal);   // Node sends nothing to a child it has seen end
    tried += 1;
    const place = placeOf(this.pid);
    if (place === null) return false;
    if (place.inside) return killChild.call(this, signal);
    refuse('signal ' + signal + ' to its child ' + this.pid + ' (' + place.program + '), outside the case\'s folder ' + box);
    return false;
  };
  // A command's words as a shell reads them: its quotes and backslashes
  // taken out, split at blanks and at ; & | ( ) < > ` $ = { } , and the dot.
  const REFUSED = ['kill', 'pkill', 'killall', 'osascript'];
  // QA-G-55 (round 24): a last path segment that holds a glob character is
  // read as the shell would match it, against the four names.
  const globMatches = (glob, name) => {
    let pattern = '';
    for (let i = 0; i < glob.length; i += 1) {
      const end = glob[i] === '[' ? glob.indexOf(']', i + 2) : -1;
      if (glob[i] === '*') pattern += '.*';
      else if (glob[i] === '?') pattern += '.';
      else if (end > 0) { pattern += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end; }
      else pattern += glob[i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
    try { return new RegExp('^' + pattern + '$').test(name); } catch { return true; }
  };
  const named = (parts) => parts.flatMap((part) => String(part).replace(/['"\\]/g, '').split(/[\s;&|()<>`$={},.]+/)).map((word) => path.basename(word).toLowerCase()).flatMap((name) => (REFUSED.includes(name) ? [name] : /[*?[]/.test(name) ? REFUSED.filter((refused) => globMatches(name, refused)) : []));
  // DM-270 (round 23): a command that names NODE_OPTIONS, runs env with an
  // option, or uses ANSI-C quoting; why, or null.
  const evading = (parts) => {
    const text = parts.join(' ');
    const words = text.replace(/['"\\]/g, '').split(/[\s;&|()<>`$={},.]+/);
    if (text.includes("$'")) return "uses ANSI-C quoting ($'...'), which a shell decodes into names this guard cannot read";
    if (words.includes('NODE_OPTIONS')) return 'sets or clears NODE_OPTIONS, which would start node without this guard';
    if (words.some((word, i) => path.basename(word).toLowerCase() === 'env' && /^-/.test(words[i + 1] || ''))) return 'runs env with an option, which can empty the environment and NODE_OPTIONS with it';
    return null;
  };
  // Every node the case starts loads this guard first (DM-268): its own
  // module in the case's folder, written from this function's own text at
  // its install, before any start (a node the case starts finds it there and
  // writes nothing), and named in NODE_OPTIONS.
  const moduleFile = path.join(box, 'signal-guard.mjs');
  if (!fs.existsSync(moduleFile)) fs.writeFileSync(moduleFile, ["import childProcess from 'node:child_process';", "import fs from 'node:fs';", "import os from 'node:os';", "import path from 'node:path';", "import { syncBuiltinESMExports } from 'node:module';", 'const REFUSALS = ' + JSON.stringify(REFUSALS) + ';', installSignalGuard.toString(), 'installSignalGuard(' + JSON.stringify(box) + ');', ''].join('\n'));
  const preload = '--import=' + process.getBuiltinModule('node:url').pathToFileURL(moduleFile).href;
  const withPreload = (options) => (String(options || '').split(/\s+/).includes(preload) ? options : [options, preload].filter(Boolean).join(' '));
  process.env.NODE_OPTIONS = withPreload(process.env.NODE_OPTIONS);
  // Every way child_process starts a program, its arguments read: the
  // strings and lists it is given, and the options' shell, execPath and
  // execArgv; the options' environment gets the guard's module.
  const check = (parts) => {
    const names = named(parts);
    if (names.length) {
      const text = parts.join(' ');
      refuse('the command ' + JSON.stringify(text) + ' names ' + [...new Set(names)].join(' and ') + ': a child of this suite runs no kill, pkill, killall or osascript');
      throw Object.assign(new Error('refused by the safety suite\'s signal guard: ' + text), { code: 'EPERM' });
    }
    const evaded = evading(parts);
    if (evaded) {
      const text = parts.join(' ');
      refuse('the command ' + JSON.stringify(text) + ' ' + evaded + ': a child of this suite runs no such command');
      throw Object.assign(new Error('refused by the safety suite\'s signal guard: ' + text), { code: 'EPERM' });
    }
  };
  const guarded = (start) => function guarded(...args) {
    const options = args.find((a) => a && typeof a === 'object' && !Array.isArray(a)) || {};
    const parts = [...args.filter((a) => typeof a === 'string'), ...args.filter(Array.isArray).flat(), ...[options.shell, options.execPath].filter((x) => typeof x === 'string'), ...(Array.isArray(options.execArgv) ? options.execArgv : [])];
    check(parts);
    process.env.NODE_OPTIONS = withPreload(process.env.NODE_OPTIONS);
    return start.apply(this, args.map((a) => (a === options && options.env ? { ...options, env: { ...options.env, NODE_OPTIONS: withPreload(options.env.NODE_OPTIONS) } } : a)));
  };
  for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'execSync', 'exec', 'fork']) childProcess[name] = guarded(childProcess[name]);
  // QA-G-55 (round 24): the one place spawn, fork, exec and execFile all go
  // through, and ChildProcess.spawn called directly: its program and
  // arguments read, and the guard's module added to its environment.
  const spawnChild = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function spawn(options) {
    check([options && options.file, ...(options && Array.isArray(options.args) ? options.args : [])].filter((x) => typeof x === 'string'));
    if (!options || !Array.isArray(options.envPairs)) return spawnChild.call(this, options);
    const others = options.envPairs.filter((pair) => !String(pair).startsWith('NODE_OPTIONS='));
    const given = options.envPairs.find((pair) => String(pair).startsWith('NODE_OPTIONS='));
    return spawnChild.call(this, { ...options, envPairs: [...others, 'NODE_OPTIONS=' + withPreload(given ? String(given).slice('NODE_OPTIONS='.length) : '')] });
  };
  // DM-270 (round 23): a worker thread's process is its own, and its kill is
  // not wrapped here; a child of this suite starts none, so a Worker is
  // refused at its start.
  const threads = process.getBuiltinModule('node:worker_threads');
  threads.Worker = function Worker() {
    refuse('a worker thread, whose process.kill this guard cannot reach: a child of this suite starts none');
    throw Object.assign(new Error('refused by the safety suite\'s signal guard: a worker thread'), { code: 'EPERM' });
  };
  syncBuiltinESMExports();
  return {
    refusals: () => refused,
    tried: () => tried,
    sendOwn: (pid, signal) => send.call(process, pid, os.constants.signals[signal])
  };
}

// ---------------------------------------------------------------------------
// The child: one case against the harness, under the fake home.
// ---------------------------------------------------------------------------
if (process.argv[2] === '--child') {
  const which = process.argv[3];
  const box = process.env[BOX];
  const home = os.homedir();
  const inside = (p) => Boolean(box) && p.startsWith(box + path.sep);
  if (!inside(home) || home === os.userInfo().homedir || !inside(os.tmpdir())) {
    console.log('refusing: HOME ' + home + ' or TMPDIR ' + os.tmpdir() + ' is not inside the test folder ' + box);
    process.exit(2);
  }
  // PO-R18-1 (round 19): first, before the stand-ins and before any file
  // under test is imported (installSignalGuard says why and what it covers;
  // it also writes the guard's module, which every node the case starts
  // loads first, DM-268).
  const signalGuard = installSignalGuard(box);
  // DM-269 (round 21): every process a case starts and may signal or leave
  // running runs a program inside the case's folder: the pid holders, the
  // late writer and the stand-in app run node through a link in the box (the
  // stand-in app through STANDIN_NODE), and the shell that becomes sleep runs
  // sleep through a link there. So the parent, which ends a pid a case
  // printed or recorded only when ps shows it running a program there, can
  // end what a case left running, and the guard lets a case signal its own.
  // The programs a case only runs to their end (ps, pgrep, plutil,
  // /usr/bin/true) need neither. The proof case's two stand-ins, its
  // targets, run in its second folder, beside the case's.
  const programHere = (name, target) => {
    const file = path.join(box, 'programs', name);
    if (!existsSync(file)) { mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(target, file); }
    return file;
  };
  const nodeHere = programHere('node', process.execPath);
  process.env.STANDIN_NODE = nodeHere;
  writeFileSync(path.join(os.tmpdir(), DRIVER), '');
  // A hook around every move and every removal of a data folder, bound
  // before the harness loads its own imports of renameSync and rmSync.
  let onRename = null;
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (onRename) onRename(from, to); return rename(from, to); };
  let onRemove = null;
  const remove = fs.rmSync;
  fs.rmSync = (target, options) => { if (onRemove) onRemove(target); return remove(target, options); };
  // The stand-in for the driver and for pgrep: run() asks the driver whether
  // this program may use Accessibility, whether the screen is locked and how
  // long the Mac has been idle, and for the app's windows, e2e.mjs's
  // hidden-document test for the front app's pid, and pgrep whether the app
  // is open. It answers from `fake`, the case's state; every other program
  // runs as it is (plutil reads a fake bundle's Info.plist).
  const fake = { locked: false, idle: 600, windows: [], front: 4243, ps: null, logDriver: false, codesign: null, restoreRefused: false, saveRefused: false, quitByTerm: false, realDriver: false, psList: null };
  const started = Date.now();
  const exec = childProcess.execFileSync;
  childProcess.execFileSync = (file, args = [], options) => {
    if (path.basename(String(file)) === DRIVER) {
      // QA-G-53 (round 18): the case that gives the driver a big answer has
      // the driver's file be a script of its own, run as the harness runs
      // the driver, through the real execFileSync with the harness's options.
      if (fake.realDriver) return exec(file, args, options);
      const command = String(args[0]);
      // PO-R15-1 (round 16): the case that runs app.mjs logs every command,
      // and answers the clipboard's save and restore and the front app's.
      if (fake.logDriver) console.log('DRIVER ' + args.map(String).join(' '));
      // As the driver does, clip-save writes the clipboard into the file it is
      // given (here a stand-in text), and clip-restore answers ok, or refuses
      // in the case that has it refused (DISH-G-99, round 17).
      // A save the stand-in refuses writes nothing (QA-G-51 (b), round 18),
      // and the case with a copy running has its quit-app end the copy with
      // SIGTERM, as the driver's quit makes a copy quit.
      if (fake.logDriver && command === 'clip-save' && fake.saveRefused) return JSON.stringify({ ok: false, error: 'the stand-in could not save the clipboard' }) + '\n';
      if (fake.logDriver && command === 'clip-save') { writeFileSync(String(args[1]), 'STAND-IN CLIPBOARD\n'); return JSON.stringify({ ok: true, standIn: true }) + '\n'; }
      if (fake.quitByTerm && command === 'quit-app') { process.kill(Number(args[1]), 'SIGTERM'); return JSON.stringify({ ok: true, standIn: true }) + '\n'; }
      if (fake.logDriver && command === 'clip-restore') return JSON.stringify(fake.restoreRefused ? { ok: false, error: 'the stand-in does not put the clipboard back' } : { ok: true, standIn: true }) + '\n';
      if (fake.logDriver && command === 'front') return JSON.stringify({ ok: true, standIn: true }) + '\n';
      const answer = command === 'trusted' ? { ok: true, accessibility: true }
        : command === 'session' ? { ok: true, locked: fake.locked, idle: fake.idle + (Date.now() - started) / 1000 }
          : command === 'cgwindows' ? { ok: true, windows: fake.windows }
            : command === 'frontmost' ? { ok: true, pid: fake.front }
              : { ok: false, error: 'the stand-in has no answer for ' + command };
      return JSON.stringify(answer) + '\n';
    }
    // That case opens nothing: open, which would launch a bundle, is refused.
    if (fake.logDriver && file === 'open') throw new Error('the case that runs app.mjs opens nothing');
    // pgrep -f for a path inside this case's own folder is the real pgrep,
    // which finds only the case's own processes (round 13's copiesOf asked it;
    // since round 18 copiesOf reads ps's list of every process instead); any
    // other question, whether the app is open say, has no process here.
    if (file === 'pgrep' && args[0] === '-f' && String(args[1] || '').startsWith(box + path.sep)) return exec(file, args, options);
    if (file === 'pgrep') throw Object.assign(new Error('pgrep found no process'), { status: 1, stdout: '' });
    // ps's list of every process, as copiesOf reads it, for the case that
    // gives that list (fake.psList, PO-R18-2, round 19).
    if (file === 'ps' && fake.psList && args.includes('-axww')) return fake.psList;
    // ps, for a case that gives its answers by pid (fake.ps): the line, or
    // none for no such process, when ps exits with 1 (round 12).
    if (file === 'ps' && fake.ps) {
      const answer = fake.ps[Number(args[args.indexOf('-p') + 1])];
      if (answer === undefined) throw Object.assign(new Error('ps found no process'), { status: 1, stdout: '' });
      return answer + '\n';
    }
    return exec(file, args, options);
  };
  // codesign, for the case that runs app.mjs on a fake bundle: no
  // entitlements and a test identifier, as an unsandboxed test copy's
  // signature reads (launch-guard.mjs asks through spawnSync). In every
  // other case, and for every other program, the real one runs.
  const spawnPlain = childProcess.spawnSync;
  childProcess.spawnSync = (file, args = [], options) => {
    if (fake.codesign && file === 'codesign') return { pid: 0, output: [], status: 0, signal: null, stdout: '', stderr: 'Identifier=' + fake.codesign + '\n' };
    return spawnPlain(file, args, options);
  };
  syncBuiltinESMExports();
  const h = await import(pathToFileURL(HARNESS).href);
  if (process.env[RECHECK]) h.setRestoreRecheckForTests(Number(process.env[RECHECK]));
  // The person's own data folders hold their data before the run; a test
  // copy's folders do not exist yet: its launch makes them. Two cases leave
  // one place of the real identifier's empty, so that the run itself makes
  // it there (QA-01's H8c and H8d).
  const realContainer = path.join(home, 'Library', 'Containers', h.ID);
  const realCookies = path.join(home, 'Library', 'HTTPStorages', h.ID + '.binarycookies');
  const unseeded = { 'run-real-container-made': realContainer, 'run-real-cookies-made': realCookies }[which];
  const dirs = h.DATA_DIRS.filter((d) => !isTestFolder(d) && d !== unseeded);
  console.log('DIRS ' + JSON.stringify(dirs.map((d) => path.relative(home, d))));
  // A second run in the fake home of a case under way (QA-01's L6) seeds
  // nothing: the person's data is the first run's.
  if (which !== 'second-run') for (const d of dirs) { mkdirSync(d, { recursive: true }); writeFileSync(marker(d), real(home, d)); }
  const intact = () => dirs.forEach((d) => assert.equal(existsSync(marker(d)) ? readFileSync(marker(d), 'utf8') : null, real(home, d), 'the data in ' + d + ' is as it was'));
  const backups = () => (existsSync(BACKUP_ROOT(home)) ? readdirSync(BACKUP_ROOT(home)) : []);
  const cleanup = async () => { h.restoreAppData(); };
  const cases = {
    'restore-before-backup'() {
      h.restoreAppData();
      intact();
      assert.deepEqual(backups(), [], 'no backup folder');
    },
    // QA-G-40 K32 (QA-01's P2.3; the Delivery Manager's AT-H5b): two fresh
    // copies asked for in the same millisecond, before either is launched (so
    // no folder of the first exists yet), get two stamps: the second takes
    // the next one, from the stamp the first took.
    'fresh-start-twice'() {
      h.backupAppData();
      const asked = [];
      const makeCopy = (source, destination, stamp) => { asked.push(stamp); return { made: { app: path.join(destination, 'Plain Sight test copy.app'), identifier: 'com.pranavongole.plainsight.testcopy-' + stamp, sandboxed: true } }; };
      const facts = { app: '/nowhere/Plain Sight test copy.app', identifier: TEST_COPY, sandboxed: true };
      const first = h.freshStart(facts, { makeCopy, now: () => 1761000060000 });
      const second = h.freshStart(facts, { makeCopy, now: () => 1761000060000 });
      assert.deepEqual(asked, [1761000060000, 1761000060001], 'the second copy takes the next stamp: ' + JSON.stringify(asked));
      assert.notEqual(first.identifier, second.identifier, 'two identifiers, so two containers of their own');
      h.restoreAppData();
      intact();
      assert.deepEqual(backups(), [], 'no backup folder');
    },
    'clear-before-backup'() {
      assert.throws(() => h.clearTestData(), /not moved aside/, 'refused');
      intact();
    },
    // DISH-G-81 F2: freshStart makes a fresh copy only while the app's data
    // is moved aside, since the copy's folders join that backup's restore:
    // before the move aside and after the restore it throws, and the copy
    // script is never asked.
    'fresh-start-phases'() {
      const asked = [];
      const makeCopy = (source, destination, stamp) => { asked.push(stamp); return { made: { app: path.join(destination, 'Plain Sight test copy.app'), identifier: 'com.pranavongole.plainsight.testcopy-' + stamp, sandboxed: true } }; };
      const facts = { app: '/nowhere/Plain Sight test copy.app', identifier: TEST_COPY, sandboxed: true };
      assert.throws(() => h.freshStart(facts, { makeCopy, now: () => 1761000050000 }), /the app data is not moved aside \(untouched\), so no fresh copy is made/, 'refused before the move aside');
      h.backupAppData();
      h.restoreAppData();
      intact();
      assert.throws(() => h.freshStart(facts, { makeCopy, now: () => 1761000050000 }), /the app data is not moved aside \(restored\), so no fresh copy is made/, 'refused after the restore');
      assert.deepEqual(asked, [], 'the copy script was never asked');
      assert.equal(existsSync(path.join(process.env.PLAIN_SIGHT_EVIDENCE, 'fresh-copies')), false, 'and nothing was made in the evidence folder');
      assert.deepEqual(backups(), [], 'no backup folder');
    },
    'restore-while-moving'() {
      let moves = 0;
      let refusal = null;
      onRename = () => {
        moves += 1;
        if (moves !== 2) return;
        try { h.restoreAppData(); refusal = 'returned'; } catch (err) { refusal = err.message; }
      };
      h.backupAppData();
      onRename = null;
      assert.notEqual(refusal, null, 'the second move was reached');
      assert.match(refusal, /incomplete/, 'refused while the backup is incomplete: ' + refusal);
      assert.ok(refusal.includes('put back ' + dirs[0] + ' from ' + BACKUP_ROOT(home)) && refusal.includes('(listed in moved.json)'), 'the refusal names the folder moved so far, decoded, and where it waits: ' + refusal);
      assert.ok(!refusal.includes(dirs[1]), 'and not one not yet moved: ' + refusal);
      dirs.forEach((d) => assert.ok(!existsSync(d), 'the backup went on to the end: ' + d));
      h.restoreAppData();
      intact();
      assert.deepEqual(backups(), [], 'nothing left in the backup');
    },
    'restore-twice'() {
      h.backupAppData();
      dirs.forEach((d) => { mkdirSync(d, { recursive: true }); writeFileSync(marker(d), 'TEST DATA'); });
      h.restoreAppData();
      intact();
      h.restoreAppData();
      intact();
      assert.deepEqual(backups(), [], 'no backup folder');
    },
    async 'handlers-before-backup'() {
      let seen = null;
      onRename = () => { if (!seen) seen = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'].map((s) => process.listenerCount(s)); };
      h.watchSignalsThenBackup(cleanup);
      onRename = null;
      assert.notEqual(seen, null, 'a folder was moved');
      console.log('HANDLERS DURING THE FIRST MOVE ' + JSON.stringify(seen));
      assert.ok(seen.every((n) => n >= 1), 'each handler was installed before the first move: ' + JSON.stringify(seen));
      dirs.forEach((d) => assert.ok(!existsSync(d), 'moved aside: ' + d));
      // The handler's own path, run the way Node runs it between turns of
      // the event loop: the cleanup puts everything back and the run ends
      // with 130.
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 5000));
      console.log('THE HANDLER DID NOT END THE RUN');
      process.exit(9);
    },
    async 'signal-during-backup'() {
      // The parent sends SIGINT while the second folder is being moved: the
      // hook holds that move until the parent says the signal is on its way,
      // so the signal lands inside the backup, which Node can only queue.
      let moves = 0;
      onRename = () => {
        moves += 1;
        if (moves !== 2) return;
        console.log('MOVING 2');
        const sent = path.join(box, SIGNAL_SENT);
        const until = Date.now() + 15000;
        while (!existsSync(sent)) {
          if (Date.now() > until) { console.log('THE SIGNAL NEVER CAME'); process.exit(7); }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      };
      h.watchSignalsThenBackup(cleanup);
      onRename = null;
      console.log('BACKUP DONE');
      await new Promise((r) => setTimeout(r, 5000));
      console.log('THE HANDLER DID NOT END THE RUN');
      process.exit(9);
    },
    // DM-243: the run's own end. A test copy's launch makes its container
    // (here a folder in the fake home), macOS refuses its removal (here the
    // hook, as EPERM, which is what release-run-1 saw; its cause was not
    // shown), and run() ends the process itself.
    async 'run-test-container-refused'() {
      onRemove = (target) => { if (target === container) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer]);
    },
    // Eleven of QA-01's harness cases on 534f3cc (H4, H5, H6, H7, H8b, H8c,
    // H8d, H13b, H22, H26 and H28 of wave-g/qa/scripts/app/r7_harness_adv.mjs
    // with r7_harness_child.mjs), on this file's stand-in: QA-01
    // made macOS's refusals real (chflags uchg for EPERM, an ACL "deny delete"
    // for EACCES); here the hook answers with the same error codes. H4: the
    // container refused with EACCES.
    async 'run-test-container-eacces'() {
      onRemove = (target) => { if (target === container) throw refused('rmdir', target, 'EACCES'); };
      await runSuite([launchMakesContainer]);
    },
    // DM-247: a real-key test that needs a first launch of a sandboxed bundle
    // asks freshStart, which asks the copy script's makeTestCopy (a stand-in
    // here, recording what it was asked) for a fresh copy and clears nothing:
    // the bundle's own container keeps what its launch wrote. The fresh
    // copy's first launch makes its own container; at the run's end both
    // containers, which macOS keeps, are named as test data left behind.
    async 'run-fresh-start'() {
      const fresh = path.join(CONTAINERS(home), 'com.pranavongole.plainsight.testcopy-1761000020000');
      onRemove = (target) => { if (target === container || target === fresh) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer, {
        name: 'a test that needs a first launch gets a fresh copy, and nothing is cleared',
        fn: async () => {
          const removed = [];
          const atTheEnd = onRemove;
          onRemove = (target) => { removed.push(target); atTheEnd(target); };
          const asked = [];
          const made = h.freshStart({ app: process.env.PLAIN_SIGHT_APP, identifier: h.APP_ID, sandboxed: true }, {
            now: () => 1761000020000,
            makeCopy: (source, destination, stamp) => { asked.push({ source, destination, stamp }); return { made: { app: path.join(destination, 'Plain Sight test copy.app'), identifier: 'com.pranavongole.plainsight.testcopy-' + stamp, sandboxed: true } }; }
          });
          onRemove = atTheEnd;
          console.log('FRESH ' + JSON.stringify({ asked, made, removed }));
          assert.deepEqual(removed, [], 'nothing was removed for the first launch');
          assert.equal(readFileSync(marker(path.join(container, 'Data', 'Library', 'WebKit', 'WebsiteData')), 'utf8'), 'TEST DATA', 'the bundle\'s own container keeps what its launch wrote');
          testData(path.join(fresh, 'Data'));   // the fresh copy's first launch makes its container
        }
      }]);
    },
    // A fresh copy never takes an identifier whose folders exist already: the
    // next stamp is taken, and the folder that was there is left alone.
    async 'run-fresh-start-taken'() {
      const taken = path.join(CONTAINERS(home), 'com.pranavongole.plainsight.testcopy-1761000030000');
      mkdirSync(taken, { recursive: true });
      writeFileSync(marker(taken), 'ANOTHER RUN\'S CONTAINER');
      await runSuite([{
        name: 'a fresh copy skips an identifier that is taken',
        fn: async () => {
          const made = h.freshStart({ app: process.env.PLAIN_SIGHT_APP, identifier: h.APP_ID, sandboxed: true }, {
            now: () => 1761000030000,
            makeCopy: (source, destination, stamp) => ({ made: { app: path.join(destination, 'Plain Sight test copy.app'), identifier: 'com.pranavongole.plainsight.testcopy-' + stamp, sandboxed: true } })
          });
          console.log('FRESH ' + JSON.stringify({ made }));
        }
      }]);
    },
    // An unsandboxed bundle still gets its folders cleared, and no copy.
    async 'run-fresh-start-unsandboxed'() {
      await runSuite([{
        name: 'a test that needs a first launch of an unsandboxed bundle gets its folders cleared',
        fn: async () => {
          testData(dirs[0]);
          const facts = { app: '/nowhere/Plain Sight.app', identifier: h.ID, sandboxed: false };
          const made = h.freshStart(facts, { makeCopy: () => { throw new Error('no copy is made for an unsandboxed bundle'); } });
          assert.equal(made, facts, 'the next launch opens the same bundle');
          assert.equal(existsSync(marker(dirs[0])), false, 'its folders were cleared');
        }
      }]);
    },
    // DM-248: a signal while the run's own cleanup is under way, as the
    // suites' after() waits for the app to quit. The Delivery Manager's AT-H6
    // (one SIGINT then) and AT-H7 (a first SIGINT during a test, a second
    // while after() waits), dm-appstore-534f3cc/adv/tests534/desktop/tests/
    // dm-harness-adv-534.mjs, and a SIGTERM during a test, then a SIGHUP
    // during the cleanup, with a test after them that must not start.
    async 'run-signal-during-cleanup'() {
      await runSuite([{ name: 'a test that writes test data', fn: async () => { testData(dirs[0]); } }], { after: slowAfter });
    },
    async 'run-second-signal'() {
      await runSuite([{ name: 'a long test', fn: async () => { testData(dirs[0]); console.log('IN TEST'); await new Promise((r) => setTimeout(r, 6000)); } }], { after: slowAfter });
    },
    async 'run-term-then-hup'() {
      await runSuite([
        { name: 'a short test', fn: async () => { testData(dirs[0]); console.log('IN TEST'); await new Promise((r) => setTimeout(r, 1000)); } },
        { name: 'a test after the signal', fn: async () => { console.log('TEST AFTER THE SIGNAL'); } }
      ], { after: slowAfter });
    },
    // QA-01's observation 2 (its P3.8 in r8_infra_adv.mjs): SIGQUIT, which
    // Ctrl+backslash sends, was not handled, so it ended the run at once with
    // the data in appdata-backup and the lock left. It is handled as SIGINT is.
    async 'run-sigquit'() {
      await runSuite([
        { name: 'a test during which SIGQUIT comes', fn: async () => { testData(dirs[0]); console.log('IN TEST'); await new Promise((r) => setTimeout(r, 1000)); } },
        { name: 'a test after the signal', fn: async () => { console.log('TEST AFTER THE SIGNAL'); } }
      ]);
    },
    // PO-R8-1: the cleanup runs once and every caller waits for that one; no
    // case showed the once, so with each caller running a cleanup of its own
    // (`cleaning =` for `cleaning ||=`, the Product Owner's PO3-DM248) every
    // case passed. The Delivery Manager's AT-H9 (dm-harness-adv-a33.mjs): a
    // SIGINT while the run's own cleanup waits in after() makes no second
    // cleanup; here with a second SIGINT after the first, after() counting its
    // calls and every folder put back from the backup named.
    async 'run-cleanup-once'() {
      let calls = 0;
      onRename = (from, to) => { if (from.startsWith(BACKUP_ROOT(home) + path.sep)) console.log('PUT BACK ' + path.relative(home, to)); };
      await runSuite([{ name: 'a test that writes test data', fn: async () => { testData(dirs[0]); } }], {
        after: async () => { calls += 1; console.log('AFTER CALL ' + calls); console.log('IN AFTER'); await h.sleep(3000); console.log('AFTER DONE ' + calls); }
      });
    },
    // DM-249: after a signal, or once the run's own cleanup had begun, the
    // test that was running went on and could launch the app again, which
    // then outlived the run and ran over the restored folders (a launch of
    // this branch's build removes the 1.0.0 app's folder.txt). The Delivery
    // Manager's AT-H8b, AT-H8 and AT-H8c (dm-appstore-a3387d9/adv/tests/
    // desktop/tests/dm-harness-adv-a33.mjs), adopted with the answer the fix
    // sets. The app is a stand-in (the parent's STANDIN) started through the
    // harness's spawnApp, as e2e.mjs starts the test build, and the suite's
    // after() is e2e.mjs's own (stopCurrentApp). AT-H8b: the signal comes
    // while the test waits, and its next step launches the app again.
    async 'run-relaunch-waiting'() {
      await runSuite([{ name: 'a test that launches the app again after a wait', fn: async () => {
        await ready(launchApp());
        await h.sleep(300);
        console.log('WAITING');
        await h.sleep(400);
        launchApp();
        console.log('RELAUNCHED ' + current.pid);
        await h.sleep(4000);
      } }], { after: e2eAfter });
    },
    // AT-H8, e2e.mjs's own shape: the signal comes while the test waits in its
    // own stopApp() before it launches the app again.
    async 'run-relaunch-stopping'() {
      await runSuite([{ name: 'a test that restarts the app, as e2e.mjs does', fn: async () => {
        await ready(launchApp());
        await h.sleep(300);
        console.log('STOPPING');
        await h.stopApp(current);
        launchApp();
        console.log('RELAUNCHED ' + current.pid);
        await h.sleep(4000);
      } }], { after: e2eAfter });
    },
    // AT-H8c: the same, with the person's 1.0.0 folder choice (folder.txt) in
    // the real identifier's Application Support folder, which the run moves
    // aside and puts back.
    async 'run-relaunch-folder'() {
      writeFileSync(path.join(appSupport, 'folder.txt'), '/Users/someone/Notes');
      await runSuite([{ name: 'a test that restarts the app, as e2e.mjs does', fn: async () => {
        await ready(launchApp());
        await h.sleep(400);
        console.log('STOPPING');
        await h.stopApp(current);
        launchApp();
        console.log('RELAUNCHED ' + current.pid);
        await h.sleep(4000);
      } }], { after: e2eAfter });
    },
    // The refusal on its own: the test's next launch comes only once the
    // cleanup's after() has ended, so no after() could stop that app.
    async 'run-launch-after-signal'() {
      await runSuite([{ name: 'a test that launches the app once the cleanup has stopped it', fn: async () => {
        await ready(launchApp());
        console.log('IN TEST');
        await afterDone;
        try { launchApp(); } catch (err) { console.log('REFUSED ' + err.message); throw err; }
        console.log('LAUNCHED AGAIN ' + current.pid);
      } }], { after: e2eAfterThenSay });
    },
    // The same during the run's own cleanup, with no signal: a launch the test
    // left for later comes once that cleanup's after() has ended.
    async 'run-launch-in-own-cleanup'() {
      await runSuite([{ name: 'a test that leaves a launch for later', fn: async () => {
        await ready(launchApp());
        afterDone.then(() => {
          try { launchApp(); console.log('LAUNCHED AGAIN ' + current.pid); } catch (err) { console.log('REFUSED ' + err.message); }
        });
      } }], { after: e2eAfterThenSay });
    },
    // e2e.mjs's after() on its own: a copy started by a way the refusal does
    // not see (not spawnApp) while the cleanup stops the first is stopped too,
    // since after() stops the app that is current when each stop ends.
    async 'run-late-app-stopped'() {
      const signalCame = new Promise((resolve) => process.once('SIGINT', resolve));
      await runSuite([{ name: 'a test that starts another copy while the cleanup stops the first', fn: async () => {
        await ready(launchApp());
        console.log('IN TEST');
        await signalCame;
        await h.sleep(200);
        const child = spawn(process.env[STANDIN], [], { stdio: 'ignore', env: { ...process.env, ...standinEnv } });
        current = { child, pid: child.pid };
        console.log('STARTED ANOTHER ' + child.pid);
        await h.sleep(4000);
      } }], { after: e2eAfter });
    },
    // QA-01's E1 (wave-g/qa/scripts/app/r9_suite_adv.mjs, group E; QA-G-45):
    // e2e.mjs itself, its launch() and its after(), with this file's stand-in
    // for the driver and the stand-in app as the test build. Only its first
    // test runs. Its launch waits for a first window that never comes, or,
    // with the window shown at once, for the probe's answer, which the
    // stand-in never gives; the parent sends the signal once the app has
    // recorded its pid.
    async 'e2e-first-window-wait'() { await e2eSuite([]); },
    async 'e2e-probe-wait'() { await e2eSuite([HELPER, DOC_ON]); },
    // Round 11 (e2e-run-4's show step): e2e.mjs's own hidden-document test
    // under a fake of the test build's hook. The show leaves the page hidden,
    // as in e2e-run-4, or brings it back.
    async 'e2e-show-stays-hidden'() { await e2eHidden(false); },
    async 'e2e-show-returns'() { await e2eHidden(true); },
    // PO-R11-1 (round 12): the show leaves the page hidden, and a person
    // touches the Mac while the window's state is read at the timeout.
    async 'e2e-touch-at-evidence'() { await e2eHidden(false, true); },
    // DM-249's launched half, the restore check (round 10). The person's data
    // holds a nested file as well, which the run must leave as it was.
    async 'run-restore-clean'() {
      personFile(dirs[1], path.join('notes', 'today.txt'), 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that writes test data', fn: async () => { testData(dirs[0]); } }]);
    },
    async 'run-restore-late-change'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'change'); testData(dirs[0]); } }]);
    },
    // PO-R10-1 (round 11): late writers that keep the file's size. The
    // first rewrites it with other bytes of the same length, the second
    // writes the same bytes again, so only the modification time changes.
    async 'run-restore-late-same-size'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'same-size'); testData(dirs[0]); } }]);
    },
    async 'run-restore-late-same-bytes'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'same-bytes'); testData(dirs[0]); } }]);
    },
    // DM-257 (round 11): the Delivery Manager's AT-R3, AT-R4 and AT-R7 (its
    // delta of 46d6f62, adv/tests/desktop/tests/dm-harness-adv-46.mjs),
    // adopted, and a data folder that can no longer be listed after the
    // restore. The nested file is where WebKit keeps the vault record.
    async 'run-restore-late-nested'() {
      const rel = path.join('WebsiteData', 'LocalStorage', 'tauri_localhost_0.localstorage');
      personFile(dirs[0], rel, 'VAULT RECORD 0123456789');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], rel), 'same-size', dirs[0]); testData(dirs[0]); } }]);
    },
    async 'run-restore-late-new-file'() {
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[1], 'written-after-the-restore'), 'create'); testData(dirs[0]); } }]);
    },
    async 'run-restore-unlisted'() {
      const sealed = path.join(dirs[1], 'sealed');
      mkdirSync(sealed);
      writeFileSync(path.join(sealed, 'inside.txt'), 'x');
      chmodSync(sealed, 0o000);
      console.log('SEALED ' + sealed);
      await runSuite([{ name: 'a test that writes test data', fn: async () => { testData(dirs[0]); } }]);
    },
    async 'run-restore-unlistable-after'() {
      personFile(dirs[1], path.join('notes', 'today.txt'), 'THE PERSON\'S NOTES');
      console.log('SEALED ' + path.join(dirs[1], 'notes'));
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[1], 'notes'), 'seal', dirs[1]); testData(dirs[0]); } }]);
    },
    async 'run-restore-late-remove'() {
      writeFileSync(path.join(appSupport, 'folder.txt'), '/Users/someone/Notes');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(appSupport, 'folder.txt'), 'remove'); testData(dirs[0]); } }]);
    },
    async 'run-restore-late-change-signal'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test during which a signal comes', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'change'); testData(dirs[0]); console.log('IN TEST'); await h.sleep(5000); } }]);
    },
    // DISH-G-93 (round 12): the same late change, with the signal while the
    // run's own cleanup waits in after(), so the run ends by run()'s own line
    // for a signal that came during its cleanup.
    async 'run-late-change-in-after'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'change'); testData(dirs[0]); } }], { after: slowAfter });
    },
    // QA-G-46 (round 12): QA-01's restore check cases for its R2, R6, R7,
    // R15, R16 and R19 (wave-g/qa/scripts/app/r10_restore_adv.mjs, groups A,
    // L and P, with r10_restore_child.mjs and r10_writer.mjs), on this
    // file's late writer. A.size-mtime-kept: a file grown 1 s after the
    // restore, its modification time put back to the nanosecond.
    async 'run-late-grow-same-time'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      console.log('MTIME ' + fs.statSync(path.join(dirs[0], 'notes.txt'), { bigint: true }).mtimeNs);
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'grow-same-time'); testData(dirs[0]); } }]);
    },
    // A.remove-top: a whole data folder the run put back, removed 1 s later.
    async 'run-late-folder-removed'() {
      personFile(dirs[1], path.join('notes', 'today.txt'), 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(dirs[1], 'remove-folder', dirs[1]); testData(dirs[0]); } }]);
    },
    // A.hidden: a new hidden file, 1 s after the restore.
    async 'run-late-hidden-file'() {
      await runSuite([{ name: 'a test that leaves a late writer behind', fn: async () => { lateWriter(path.join(dirs[1], '.late-hidden'), 'create'); testData(dirs[0]); } }]);
    },
    // L7: a run the person stopped (3 on its own) whose data a late writer
    // then changed.
    async 'run-late-change-stopped'() {
      personFile(dirs[0], 'notes.txt', 'THE PERSON\'S NOTES');
      await runSuite([{ name: 'a test the person interrupts, with a late writer behind', fn: async () => { lateWriter(path.join(dirs[0], 'notes.txt'), 'change'); testData(dirs[0]); throw new h.UserActivity('keyboard or mouse used during the run (idle 0.0 s)'); } }]);
    },
    // L6: the parent starts a second run in this fake home half a second
    // after the restore, during the second look; the test holds a second, so
    // the parent sees the backup folder before it goes.
    async 'run-held-through-check'() {
      await runSuite([{ name: 'a test that takes a second', fn: async () => { testData(dirs[0]); await h.sleep(1000); } }]);
    },
    async 'second-run'() {
      await h.run([{ name: 'a second run', fn: async () => { console.log('SECOND RAN'); } }], { name: 'second', needUnlocked: false });
    },
    // P.source as behaviour: stopApp on an app that has already ended.
    async 'stop-ended-app'() {
      const gone = h.spawnApp('/usr/bin/true');
      if (gone.exitCode === null && gone.signalCode === null) await new Promise((resolve) => gone.once('exit', resolve));
      const t0 = Date.now();
      await h.stopApp({ child: gone, pid: gone.pid });
      console.log('STOPPED ' + gone.pid + ' after ' + (Date.now() - t0) + ' ms');
      await h.sleep(300);
    },
    // An app the run launched (spawnApp records it) that nothing stops: the
    // suite gives no after().
    async 'run-restore-live-app'() {
      await runSuite([{ name: 'a test that launches an app and leaves it running', fn: async () => {
        const child = h.spawnApp(process.env[STANDIN], { STANDIN_PIDS: standinEnv.STANDIN_PIDS });
        current = { child, pid: child.pid };
        await ready(current);
        console.log('LEFT RUNNING ' + child.pid);
      } }]);
    },
    // Round 12, the reused pid (Developer N's round 11 observation): macOS
    // hands an ended app's pid to another program. The app's child has ended
    // here (Node has seen it end) while another live program holds its pid:
    // the parent's pid holder, which stands for the program macOS gave the
    // pid to. The suite's end (stopCurrentApp) and its waits (alive, until)
    // must neither wait on nor signal it.
    async 'pid-reused-child'() {
      const gone = h.spawnApp('/usr/bin/true');
      if (gone.exitCode === null && gone.signalCode === null) await new Promise((resolve) => gone.once('exit', resolve));
      const holder = await pidHolder(nodeHere);
      await stopCurrentFor({ child: gone, pid: holder.pid });
      h.recordLaunch(holder.pid, '/usr/bin/true', gone);   // the launch's record, its pid now the holder's
      await waitsFor(holder.pid);
      await holderAfter(holder);
    },
    // The same for a copy recorded through LaunchServices, as app.mjs and
    // release.mjs record each copy (by its bundle): the pid holder runs node,
    // not the copy's executable.
    async 'pid-reused-copy'() {
      const holder = await pidHolder(nodeHere);
      h.recordLaunch(holder.pid, copyBundle);
      await stopCurrentFor({ pid: holder.pid });
      await waitsFor(holder.pid);
      await holderAfter(holder);
    },
    // DM-259 and QA-G-48 (round 13): ps fails while the restore check asks
    // about a recorded copy (the Delivery Manager's AT-P4, QA-01's
    // ps-broken-run): a stand-in ps first on PATH that ends with 2 and "ps:
    // fork: Resource temporarily unavailable", as ps does when the Mac can
    // start no process.
    async 'run-ps-broken'() {
      const bin = path.join(box, 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\necho "ps: fork: Resource temporarily unavailable" >&2\nexit 2\n');
      chmodSync(path.join(bin, 'ps'), 0o755);
      await runSuite([{ name: 'a test that records a copy, after which ps breaks', fn: async () => {
        testData(dirs[0]);
        h.recordLaunch(7001, copyBundle);
        process.env.PATH = bin + path.delimiter + process.env.PATH;
      } }]);
    },
    // QA-G-48 (round 13): a restore check that fails for a reason no fake
    // home can make once ps's own failure is caught: a stand-in check
    // (setRestoreCheckForTests) that throws, standing for any other fault.
    async 'run-check-fails'() {
      h.setRestoreCheckForTests(async () => { throw new Error('a stand-in restore check that fails'); });
      await runSuite([{ name: 'a test that passes', fn: async () => {} }]);
    },
    // QA-G-53 (round 18), QA-01's run-check-throws-null (r15_pid_adv.mjs): a
    // restore check that throws null, so that reporting its failure throws
    // too (failureOf reads null's stderr), and only the cleanup's finally can
    // release the lock. No real code throws null.
    async 'run-check-throws-null'() {
      h.setRestoreCheckForTests(() => { throw null; });
      await runSuite([{ name: 'a test that passes', fn: async () => {} }]);
    },
    // Round 13 item 4 (the Product Owner's decision on DISH I-21): the end of
    // the suites that open bundles (endCopies), with a copy the run never
    // recorded (a program at the bundle's executable, which ignores SIGTERM)
    // and a bystander whose arguments merely hold that path (node, with the
    // path as an argument). The driver's quit-app has no answer here, so the
    // copy is ended by the SIGKILL 5 s later.
    async 'end-copies'() {
      const copy = await pidHolder(copyExecutable(), 'stays', 'COPY');
      const bystander = await pidHolder(nodeHere, 'stays', 'BYSTANDER', [copyExecutable()]);
      console.log('COPIES ' + JSON.stringify(h.copiesOf(copyBundle)) + ' of ' + JSON.stringify([copy.pid, bystander.pid]));
      const asked = [];
      const t0 = Date.now();
      await h.endCopies([copyBundle], (pid) => { asked.push(pid); throw new Error('the stand-in driver has no quit-app'); });
      console.log('QUIT ASKED ' + JSON.stringify(asked) + ' in ' + (Date.now() - t0) + ' ms');
      await h.sleep(300);
      for (const [name, holder] of [['COPY', copy], ['BYSTANDER', bystander]]) {
        console.log(name + ' AFTER ' + JSON.stringify({ signals: existsSync(holder.file) ? readFileSync(holder.file, 'utf8').trim() : '', stillRuns: holder.p.exitCode === null && holder.p.signalCode === null }));
      }
    },
    // PO-R13-2 (round 14, the Product Owner's break PO3-COPIES-PS-FAIL): the
    // same end while ps fails, with a bystander whose arguments hold the
    // bundle's executable path: a stand-in ps first on PATH ends with 2 and
    // "ps: fork: Resource temporarily unavailable", as ps does when the Mac
    // can start no process.
    async 'end-copies-ps-broken'() {
      const bystander = await pidHolder(nodeHere, 'stays', 'BYSTANDER', [copyExecutable()]);
      const bin = path.join(box, 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\necho "ps: fork: Resource temporarily unavailable" >&2\nexit 2\n');
      chmodSync(path.join(bin, 'ps'), 0o755);
      process.env.PATH = bin + path.delimiter + process.env.PATH;
      console.log('COPIES ' + JSON.stringify(h.copiesOf(copyBundle)) + ' of ' + JSON.stringify([bystander.pid]));
      const asked = [];
      const t0 = Date.now();
      await h.endCopies([copyBundle], (pid) => { asked.push(pid); throw new Error('the stand-in driver has no quit-app'); });
      console.log('QUIT ASKED ' + JSON.stringify(asked) + ' in ' + (Date.now() - t0) + ' ms');
      await h.sleep(300);
      console.log('BYSTANDER AFTER ' + JSON.stringify({ signals: existsSync(bystander.file) ? readFileSync(bystander.file, 'utf8').trim() : '', stillRuns: bystander.p.exitCode === null && bystander.p.signalCode === null }));
    },
    // PO-R14-2 (round 15, the Product Owner's break PO3-NO-GRACE): the end of
    // the suites that open bundles (endCopies) lets a copy quit through its
    // page before any SIGKILL: an unrecorded copy (a program at the bundle's
    // executable) that ends about 1 s after the quit request, here a SIGTERM
    // through its child standing in for the driver's quit-app. The holder
    // records the signals it gets; a SIGKILL shows as its signalCode.
    async 'end-copies-grace'() {
      const copy = await pidHolder(copyExecutable(), 'quits-in-1s', 'COPY');
      const asked = [];
      const t0 = Date.now();
      await h.endCopies([copyBundle], (pid) => { asked.push(pid); if (pid === copy.pid) copy.p.kill('SIGTERM'); });
      console.log('QUIT ASKED ' + JSON.stringify(asked) + ' in ' + (Date.now() - t0) + ' ms');
      await h.until(() => copy.p.exitCode !== null || copy.p.signalCode !== null, 'the copy to be reaped', 3000).catch(() => {});
      console.log('COPY AFTER ' + JSON.stringify({ signals: existsSync(copy.file) ? readFileSync(copy.file, 'utf8').trim() : '', exitCode: copy.p.exitCode, signalCode: copy.p.signalCode }));
    },
    // PO-R15-1 (round 16): app.mjs itself, its run() under the fake home with
    // the stand-in driver, which logs every command. PLAIN_SIGHT_ONLY matches
    // no test, so no test runs and nothing is launched, and the log shows
    // what the suite's before() and after() ask of the driver. run() ends the
    // child.
    async 'app-suite-clipboard'() {
      fake.logDriver = true;
      fake.codesign = TEST_COPY;
      process.env.PLAIN_SIGHT_ONLY = '^no test has this name$';
      mkdirSync(path.join(home, 'Downloads'), { recursive: true });   // as runSuite makes it: the run marks what Downloads holds
      await import(pathToFileURL(path.join(HERE, 'app.mjs')).href);
    },
    // DISH-G-99 (round 17): the same run with the clipboard's restore refused
    // by the stand-in driver.
    async 'app-suite-clipboard-refused'() {
      fake.logDriver = true;
      fake.codesign = TEST_COPY;
      fake.restoreRefused = true;
      process.env.PLAIN_SIGHT_ONLY = '^no test has this name$';
      mkdirSync(path.join(home, 'Downloads'), { recursive: true });
      await import(pathToFileURL(path.join(HERE, 'app.mjs')).href);
    },
    // QA-G-51 (b) (round 18), QA-01's C4: the save refused by the stand-in
    // driver, and an older clipboard file in the evidence folder, as when a
    // folder is used twice.
    async 'app-suite-clipboard-save-failed'() {
      fake.logDriver = true;
      fake.codesign = TEST_COPY;
      fake.saveRefused = true;
      writeFileSync(path.join(process.env.PLAIN_SIGHT_EVIDENCE, 'clipboard.plist'), STALE_CLIPBOARD);
      process.env.PLAIN_SIGHT_ONLY = '^no test has this name$';
      mkdirSync(path.join(home, 'Downloads'), { recursive: true });
      await import(pathToFileURL(path.join(HERE, 'app.mjs')).href);
    },
    // QA-G-51 (a) (round 18), QA-01's C0: the same run with a copy running
    // from the bundle under test (a program at its executable, which quits on
    // SIGTERM), which after() must end before the clipboard goes back.
    async 'app-suite-clipboard-copy'() {
      fake.logDriver = true;
      fake.codesign = TEST_COPY;
      fake.quitByTerm = true;
      const exe = path.join(process.env.PLAIN_SIGHT_APP, 'Contents', 'MacOS', 'plain-sight');
      mkdirSync(path.dirname(exe), { recursive: true });
      fs.symlinkSync(process.execPath, exe);
      await pidHolder(exe, 'quits', 'COPY');
      process.env.PLAIN_SIGHT_ONLY = '^no test has this name$';
      mkdirSync(path.join(home, 'Downloads'), { recursive: true });
      await import(pathToFileURL(path.join(HERE, 'app.mjs')).href);
    },
    // QA-G-52 (round 18), QA-01's copies-regex (r15_pid_adv.mjs): a copy
    // running as the executable of a bundle whose path holds characters a
    // regular expression reads, ( [ + and *.
    async 'copies-regex'() {
      const found = {};
      for (const name of ['Plain Sight (1).app', 'Plain Sight [x].app', 'Plain+Sight.app', 'Plain Sight (unbalanced.app', 'Plain Sight*.app']) {
        const bundle = path.join(box, 'rx', name);
        const exe = path.join(bundle, 'Contents', 'MacOS', 'plain-sight');
        mkdirSync(path.dirname(exe), { recursive: true });
        fs.symlinkSync(process.execPath, exe);
        const copy = await pidHolder(exe, 'quits', 'COPY');
        try { found[name] = h.copiesOf(bundle).includes(copy.pid); } catch (err) { found[name] = 'threw ' + String(err.message).split('\n')[0]; }
        copy.p.kill('SIGKILL');
      }
      console.log('REGEX ' + JSON.stringify(found));
    },
    // PO-R18-2 (round 19): copiesOf's rule that a process ending (the flag E)
    // or ended (the state Z) is no copy, which no case held: the Product
    // Owner's PO3-COPIES-ENDING, the E and Z test dropped, passed every
    // suite. macOS's ps shows such a process without its program, an ended
    // one as "<defunct>" and an ending one by its short name in parentheses,
    // so the exact comparison alone already leaves it out. First a real copy
    // that has ended and is not reaped (a link to node at the copy's
    // executable, started by a shell that then becomes sleep, through a link
    // to it in the box, and never reaps it). Then a stand-in listing that gives the copy's program on a
    // running line, an ending line and an ended line, under pids no process
    // can hold: only the running one is a copy, and the end of the suites'
    // copies asks it alone (its quit takes it off the list) and signals
    // nothing.
    async 'copies-ending'() {
      const exe = copyExecutable();
      const sleepHere = programHere('sleep', '/bin/sleep');
      const shell = spawn('/bin/sh', ['-c', '"$0" -e "process.exit(0)" & exec "$1" 5', exe, sleepHere], { stdio: 'ignore' });
      const zombieOf = () => {
        if (h.programOf(shell.pid) !== sleepHere) return null;
        const rows = childProcess.execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean);
        const row = rows.find((m) => Number(m[2]) === shell.pid && /^Z/.test(m[3]));
        return row ? { pid: Number(row[1]), stat: row[3], program: row[4] } : null;
      };
      const zombie = await h.until(zombieOf, 'the copy to end, not reaped', 5000);
      let tried = signalGuard.tried();
      const askedReal = [];
      await h.endCopies([copyBundle], (pid) => askedReal.push(pid));
      console.log('ZOMBIE ' + JSON.stringify({ ...zombie, found: h.copiesOf(copyBundle).includes(zombie.pid), asked: askedReal, signals: signalGuard.tried() - tried }));
      shell.kill('SIGKILL');
      const rows = [[2000000101, 'S', exe], [2000000102, 'SE', exe], [2000000103, 'Z', exe], [2000000104, 'S', '/usr/libexec/another-program']];
      const listing = (left) => left.map(([pid, stat, program]) => String(pid).padStart(11) + ' ' + stat.padEnd(4) + ' ' + program).join('\n') + '\n';
      let left = rows;
      fake.psList = listing(left);
      console.log('LISTED ' + JSON.stringify(h.copiesOf(copyBundle)));
      const asked = [];
      tried = signalGuard.tried();
      await h.endCopies([copyBundle], (pid) => { asked.push(pid); left = left.filter((row) => row[0] !== pid); fake.psList = listing(left); });
      console.log('ASKED ' + JSON.stringify(asked) + ' SIGNALS ' + (signalGuard.tried() - tried));
      fake.psList = null;
      // QA-G-56 W9 (round 24, QA-01's sigguard-adv): the counter these SIGNALS
      // lines read moves for every process.kill tried, so their 0 is not
      // vacuous: one signal to a holder of the case, inside its folder.
      const holder = await pidHolder(nodeHere, 'quits');
      tried = signalGuard.tried();
      process.kill(holder.pid, 'SIGTERM');
      console.log('POSITIVE CONTROL TRIED ' + (signalGuard.tried() - tried));
    },
    // DM-269 (round 21): the hostile prints, each aimed at the parent's own
    // stand-ins alone (TARGETS): the Delivery Manager's recorder lines
    // (ap.mjs: "HOLDER 4242 /", "BYSTANDER 4242 .", and an OUTSIDE line that
    // names the program ps shows) with the far stand-in's pid in place of
    // 4242, a file outside the run's folder, a file in the case's folder
    // with the pid of a process outside it, the pid of a process in the run's
    // folder but in no case's folder, a SECOND line, and both pids in the
    // case's stand-in and late-writer pid files. The case signals nothing.
    // QA-G-56 (round 24, QA-01's parent-adv, credited): the pid of the
    // parent's third stand-in, started through a folder of the case that is
    // a link out of the run's folder (its P9), and a stand-in of the case's
    // own that has ended and is not reaped (its P4): a node started by a
    // shell that then becomes sleep and never waits for it, so ps shows it
    // in the state Z, as <defunct>; the parent finds nothing to end in it.
    async 'hostile-prints'() {
      const { outsider, neighbour, linker, far, near } = JSON.parse(process.env[TARGETS]);
      const zombieFile = path.join(box, 'zombie-pid');
      const sleepHere = programHere('sleep', '/bin/sleep');
      spawn('/bin/sh', ['-c', '"$0" -e "process.exit(0)" & echo $! > "$1"; exec "$2" 10', nodeHere, zombieFile, sleepHere], { stdio: 'ignore' });
      const zombie = await h.until(() => {
        const pid = existsSync(zombieFile) ? Number(readFileSync(zombieFile, 'utf8').trim()) : 0;
        const stat = pid > 0 ? String(childProcess.spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '').trim() : '';
        return /^Z/.test(stat) ? { pid, stat } : null;
      }, 'the case\'s stand-in to end, not reaped', 5000);
      console.log('ZOMBIE ' + zombie.pid + ' ' + zombie.stat);
      for (const line of [
        'HOLDER ' + outsider + ' /',
        'BYSTANDER ' + outsider + ' .',
        'COPY ' + outsider + ' ' + path.join(far, 'holder-1-signals'),
        'OTHER ' + outsider + ' ' + path.join(box, 'holder-2-signals'),
        'HOLDER ' + neighbour + ' ' + path.join(box, 'holder-3-signals'),
        'HOLDER ' + linker + ' ' + path.join(box, 'holder-4-signals'),
        'HOLDER ' + zombie.pid + ' ' + path.join(box, 'holder-5-signals'),
        'OUTSIDE ' + outsider + ' ' + path.join(far, 'stand-in'),
        'SECOND ' + neighbour + ' stand-in ' + path.join(near, 'stand-in')
      ]) console.log(line);
      writeFileSync(path.join(box, STANDIN_PIDS), outsider + '\n' + neighbour + '\n');
      writeFileSync(path.join(box, LATE_PIDS), outsider + '\n');
    },
    // QA-G-56 W10 (round 24, QA-01's sigguard-adv): a signal to a process
    // group, aimed at a group of the case's own (a sleep of the case started
    // as a group of its own, inside its folder), never at the group the case
    // runs in: refused, written, so that the case fails, and nothing reaches
    // the group.
    async 'group-kill'() {
      const sleepHere = programHere('sleep', '/bin/sleep');
      const group = spawn(sleepHere, ['30'], { stdio: 'ignore', detached: true });
      await h.until(() => h.programOf(group.pid) === sleepHere, 'the group to run', 5000);
      try { process.kill(-group.pid, 'SIGTERM'); console.log('GROUP SENT'); } catch (err) { console.log('GROUP REFUSED AS ' + err.code); }
      await h.sleep(200);
      console.log('GROUP STILL RUNS ' + (group.exitCode === null && group.signalCode === null));
      group.kill('SIGKILL');
    },
    // PO-R18-1 (round 19): the signal guard's own proof. A stand-in outside
    // the case's folder: a link to /bin/sleep named plain-sight in a second
    // temporary folder the parent made, never a real bundle, started by the
    // case. (B) The end of the case's own copies, with none running, signals
    // nothing, whatever runs outside; a copiesOf widened to any program named
    // plain-sight would return the stand-in here, and the guard would refuse.
    // (A) The end of the outside bundle's copies, which finds the stand-in
    // as a widened copiesOf would: its quit and the SIGKILL 5 s later are
    // refused. (C) A signal straight to it: refused. (D) PO-R19-1 (round 20)
    // and DISH-G-103 (round 21): kill, pkill, killall and osascript, each
    // bare, by its path, through env and through xargs, each as a program
    // (execFileSync, spawnSync) and in a shell's command (execSync, /bin/sh
    // -c, spawnSync with shell: true), 80 tries (SIGNALLERS and FORMS), all
    // aimed at a second stand-in outside the folder and at nothing else: a
    // clone of node under a name of its own, which is its process name (a
    // link takes its target's name, and a copy of /bin/sleep is killed by
    // macOS), so that pkill -x and killall name it alone, while kill and
    // osascript's script take its pid. Each try is refused. (D2) PO-R21-1
    // and QA-G-54 (round 22): the four names quoted or escaped, and QA-01's
    // shapes that got through at 52a3914 (QUOTED), 25 tries, each refused.
    // (F) DM-270 (round 23): a worker thread, and the commands of EVASIONS
    // (NODE_OPTIONS set or cleared, env with an option, ANSI-C quoting, and
    // kill through exec and execFile), nine tries, each refused. (G) QA-G-55
    // and QA-G-56 W5 (round 24): QA-01's routes (ROUTES: names in another
    // case, globs, ChildProcess.spawn called directly, a string shell
    // option), eleven tries, each refused.
    // (E) DM-268
    // (round 21): the first stand-in's own kill() (a child of the case), and
    // a node the case starts by fork, by spawn, by spawn with an environment
    // of its own and by a shell's command (round 23), each of which loads the
    // guard first and tries
    // process.kill on the second stand-in: each refused, in its own process
    // for the nodes. The stand-ins' folder lies beside the case's, its name
    // the case's with -outside after it, so that a folder check without its
    // separator would take it for the case's own. Both stand-ins must still
    // run after all five parts; the case then ends them itself, by their
    // pids, through sendOwn.
    async 'signal-guard'() {
      const bundle = path.join(process.env[OUTSIDE], 'Plain Sight.app');
      const exe = path.join(bundle, 'Contents', 'MacOS', 'plain-sight');
      mkdirSync(path.dirname(exe), { recursive: true });
      fs.symlinkSync('/bin/sleep', exe);
      const stand = spawn(exe, ['60'], { stdio: 'ignore' });
      await h.until(() => h.programOf(stand.pid) === exe, 'the outside stand-in to run', 5000);
      console.log('OUTSIDE ' + stand.pid + ' ' + exe);
      const ownReal = fs.realpathSync(box);
      const outsideReal = fs.realpathSync(process.env[OUTSIDE]);
      console.log('BESIDE ' + (outsideReal.startsWith(ownReal) && !outsideReal.startsWith(ownReal + path.sep)));
      const quit = (pid) => process.kill(pid, 'SIGTERM');
      let before = signalGuard.refusals();
      await h.endCopies([copyBundle], quit);
      console.log('PART B REFUSALS ' + (signalGuard.refusals() - before));
      before = signalGuard.refusals();
      const t0 = Date.now();
      await h.endCopies([bundle], quit);
      console.log('PART A REFUSALS ' + (signalGuard.refusals() - before) + ' in ' + (Date.now() - t0) + ' ms');
      before = signalGuard.refusals();
      const triedBefore = signalGuard.tried();
      try { process.kill(stand.pid, 'SIGTERM'); } catch (err) { console.log('REFUSED AS ' + err.code); }
      console.log('PART C REFUSALS ' + (signalGuard.refusals() - before));
      console.log('PART C TRIED ' + (signalGuard.tried() - triedBefore));
      const name = 'psg' + Math.random().toString(16).slice(2, 10);
      const clone = path.join(process.env[OUTSIDE], name);
      fs.copyFileSync(process.execPath, clone, fs.constants.COPYFILE_FICLONE);
      const second = spawn(clone, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      await h.until(() => h.programOf(second.pid) === clone, 'the second stand-in to run', 10000);
      console.log('SECOND ' + second.pid + ' ' + name + ' ' + clone);
      const io = (t) => ({ stdio: ['pipe', 'ignore', 'ignore'], input: t.input });
      const started = {
        execFileSync: (t) => childProcess.execFileSync(t.file, t.args, io(t)),
        spawnSync: (t) => { const run = childProcess.spawnSync(t.file, t.args, io(t)); if (run.error) throw run.error; },
        execSync: (t) => childProcess.execSync(commandLine(t), io(t)),
        '/bin/sh -c': (t) => childProcess.execFileSync('/bin/sh', ['-c', commandLine(t)], io(t)),
        'spawnSync with shell: true': (t) => { const run = childProcess.spawnSync(commandLine(t), { shell: true, ...io(t) }); if (run.error) throw run.error; }
      };
      const ran = [];
      before = signalGuard.refusals();
      for (const t of SIGNALLERS(String(second.pid), name)) {
        for (const form of FORMS) {
          try {
            started[form](t);
            ran.push(t.what + ', ' + form);
          } catch (err) {
            if (!(err && err.code === 'EPERM' && String(err.message).startsWith('refused by the safety suite\'s signal guard: '))) ran.push(t.what + ', ' + form + ': ' + String(err && err.message).split('\n')[0]);
          }
        }
      }
      console.log('PART D REFUSALS ' + (signalGuard.refusals() - before));
      console.log('PART D RAN ' + JSON.stringify(ran));
      const ranQuoted = [];
      before = signalGuard.refusals();
      for (const t of QUOTED(String(second.pid), name)) {
        const starts = [['execSync', () => childProcess.execSync(t.line, io(t))], ['/bin/sh -c', () => childProcess.execFileSync('/bin/sh', ['-c', t.line], io(t))]];
        if (t.argv) starts.push(['as its program', () => childProcess.execFileSync(t.argv[0], t.argv.slice(1), io(t))]);
        for (const [form, start] of starts) {
          try {
            start();
            ranQuoted.push(t.what + ', ' + form);
          } catch (err) {
            if (!(err && err.code === 'EPERM' && String(err.message).startsWith('refused by the safety suite\'s signal guard: '))) ranQuoted.push(t.what + ', ' + form + ': ' + String(err && err.message).split('\n')[0]);
          }
        }
      }
      console.log('PART D2 REFUSALS ' + (signalGuard.refusals() - before));
      console.log('PART D2 RAN ' + JSON.stringify(ranQuoted));
      const ranEvading = [];
      const refusedHere = (err) => err && err.code === 'EPERM' && String(err.message).startsWith('refused by the safety suite\'s signal guard: ');
      before = signalGuard.refusals();
      try {
        new (process.getBuiltinModule('node:worker_threads').Worker)("process['ki'+'ll'](" + second.pid + ', 15)', { eval: true });
        ranEvading.push('a worker thread');
      } catch (err) {
        if (!refusedHere(err)) ranEvading.push('a worker thread: ' + String(err && err.message).split('\n')[0]);
      }
      for (const t of EVASIONS(String(second.pid), nodeHere)) {
        const start = {
          execSync: () => childProcess.execSync(t.line, io(t)),
          '/bin/sh -c': () => childProcess.execFileSync('/bin/sh', ['-c', t.line], io(t)),
          execFileSync: () => childProcess.execFileSync(t.argv[0], t.argv.slice(1), io(t)),
          exec: () => childProcess.exec(t.line, () => {}),
          execFile: () => childProcess.execFile(t.argv[0], t.argv.slice(1), () => {})
        }[t.how];
        try {
          start();
          ranEvading.push(t.what);
        } catch (err) {
          if (!refusedHere(err)) ranEvading.push(t.what + ': ' + String(err && err.message).split('\n')[0]);
        }
      }
      console.log('PART F REFUSALS ' + (signalGuard.refusals() - before));
      console.log('PART F RAN ' + JSON.stringify(ranEvading));
      const ranRoutes = [];
      before = signalGuard.refusals();
      for (const t of ROUTES(String(second.pid), name)) {
        const start = {
          execSync: () => childProcess.execSync(t.line, io(t)),
          '/bin/sh -c': () => childProcess.execFileSync('/bin/sh', ['-c', t.line], io(t)),
          'ChildProcess.spawn': () => { const cp = new childProcess.ChildProcess(); cp.spawn({ file: t.argv[0], args: t.argv.slice(1), envPairs: Object.entries(process.env).map(([k, v]) => k + '=' + v), stdio: 'ignore' }); },
          'shell option': () => { const run = childProcess.spawnSync('x', [], { shell: '/bin/kill', stdio: 'ignore' }); if (run.error) throw run.error; }
        }[t.how];
        try {
          start();
          ranRoutes.push(t.what);
        } catch (err) {
          if (!refusedHere(err)) ranRoutes.push(t.what + ': ' + String(err && err.message).split('\n')[0]);
        }
      }
      console.log('PART G REFUSALS ' + (signalGuard.refusals() - before));
      console.log('PART G RAN ' + JSON.stringify(ranRoutes));
      const refusalFile = path.join(box, REFUSALS);
      const written = () => (existsSync(refusalFile) ? readFileSync(refusalFile, 'utf8').split('\n').filter(Boolean).length : 0);
      const probe = path.join(box, 'probe.mjs');
      writeFileSync(probe, "try { process.kill(Number(process.argv[2]), 'SIGTERM'); console.log('PROBE SENT'); } catch (err) { console.log('PROBE REFUSED AS ' + err.code); }\n");
      before = written();
      console.log('PART E KILL ' + stand.kill('SIGTERM'));
      const lastLine = (p) => new Promise((resolve) => { let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', () => resolve(out.trim().split('\n').pop())); });
      for (const [how, start] of [
        ['fork', () => childProcess.fork(probe, [String(second.pid)], { silent: true, execPath: nodeHere })],
        ['spawn', () => spawn(nodeHere, [probe, String(second.pid)], { stdio: ['ignore', 'pipe', 'ignore'] })],
        ['spawn with an environment of its own', () => spawn(nodeHere, [probe, String(second.pid)], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH } })],
        ['a shell\'s command', () => spawn(shellWord(nodeHere) + ' ' + shellWord(probe) + ' ' + second.pid, { shell: true, stdio: ['ignore', 'pipe', 'ignore'] })],
        // Round 24: the two places that give a start's own environment the
        // guard's module, each tried alone. spawnSync goes through only the
        // seven functions' wrappers, and ChildProcess.spawn called directly,
        // with environment pairs of its own, only through
        // ChildProcess.prototype.spawn.
        ['spawnSync with an environment of its own', () => ({ sync: childProcess.spawnSync(nodeHere, [probe, String(second.pid)], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH }, encoding: 'utf8' }) })],
        ['ChildProcess.spawn with environment pairs of its own', () => { const cp = new childProcess.ChildProcess(); cp.spawn({ file: nodeHere, args: [nodeHere, probe, String(second.pid)], envPairs: ['PATH=' + process.env.PATH], stdio: ['ignore', 'pipe', 'ignore'] }); return cp; }]
      ]) { const started = start(); console.log('PART E NODE ' + how + ': ' + (started.sync ? String(started.sync.stdout || '').trim().split('\n').pop() : await lastLine(started))); }
      console.log('PART E REFUSALS ' + (written() - before));
      await h.sleep(300);
      console.log('OUTSIDE STILL RUNS ' + (stand.exitCode === null && stand.signalCode === null));
      console.log('SECOND STILL RUNS ' + (second.exitCode === null && second.signalCode === null));
      for (const [label, standIn] of [['OUTSIDE', stand], ['SECOND', second]]) {
        try { signalGuard.sendOwn(standIn.pid, 'SIGTERM'); } catch { /* it has ended */ }
        await h.until(() => standIn.exitCode !== null || standIn.signalCode !== null, 'the stand-in to end', 3000).catch(() => {});
        console.log(label + ' ENDED ' + JSON.stringify([standIn.exitCode, standIn.signalCode]));
      }
    },
    // QA-G-52 (round 18), QA-01's copies-bystanders (r15_pid_adv.mjs): the
    // copy, with another Plain Sight (another bundle's plain-sight, as the
    // person's own app is), a helper beside the copy's executable and a
    // bystander whose arguments hold that executable's path, all running.
    async 'copies-others'() {
      const copy = await pidHolder(copyExecutable(), 'quits', 'COPY');
      const other = await pidHolder(otherCopyExecutable(), 'quits', 'OTHER');
      const helperExe = copyExecutable() + '-helper';
      if (!existsSync(helperExe)) fs.symlinkSync(process.execPath, helperExe);
      const helper = await pidHolder(helperExe, 'quits', 'OTHER');
      const bystander = await pidHolder(nodeHere, 'quits', 'BYSTANDER', [copyExecutable()]);
      console.log('OTHERS ' + JSON.stringify({ found: h.copiesOf(copyBundle), copy: copy.pid, other: other.pid, helper: helper.pid, bystander: bystander.pid }));
      for (const x of [copy, other, helper, bystander]) x.p.kill('SIGKILL');
    },
    // QA-G-52 (round 18), QA-01's copies-linked: a copy started through a
    // linked folder and one started through the real folder, the bundle named
    // by either spelling.
    async 'copies-linked'() {
      const realDir = path.join(box, 'real-folder');
      const linkDir = path.join(box, 'linked-folder');
      mkdirSync(realDir, { recursive: true });
      fs.symlinkSync(realDir, linkDir);
      const exeOf = (bundle) => path.join(bundle, 'Contents', 'MacOS', 'plain-sight');
      const realBundle = path.join(realDir, 'Plain Sight test copy.app');
      const linkBundle = path.join(linkDir, 'Plain Sight test copy.app');
      mkdirSync(path.dirname(exeOf(realBundle)), { recursive: true });
      fs.symlinkSync(process.execPath, exeOf(realBundle));
      const viaLink = await pidHolder(exeOf(linkBundle), 'quits', 'COPY');
      const viaReal = await pidHolder(exeOf(realBundle), 'quits', 'COPY');
      console.log('LINKED ' + JSON.stringify({ link: viaLink.pid, real: viaReal.pid, byLink: h.copiesOf(linkBundle), byReal: h.copiesOf(realBundle) }));
      for (const copy of [viaLink, viaReal]) copy.p.kill('SIGKILL');
    },
    // QA-G-53 (round 18), QA-01's endcopies-quit-throws (r15_pid_adv.mjs):
    // two copies of one bundle, the quit request failing for the first; the
    // first ignores SIGTERM, the second quits on it.
    async 'end-copies-two'() {
      const one = await pidHolder(copyExecutable(), 'stays', 'COPY');
      const two = await pidHolder(copyExecutable(), 'quits', 'COPY');
      const asked = [];
      await h.endCopies([copyBundle], (pid) => { asked.push(pid); if (pid === one.pid) throw new Error('driver: no such app'); process.kill(pid, 'SIGTERM'); });
      await h.sleep(300);
      const log = readFileSync(path.join(process.env.PLAIN_SIGHT_EVIDENCE, 'run.log'), 'utf8');
      console.log('TWO ' + JSON.stringify({ asked, one: one.pid, two: two.pid, oneEnded: [one.p.exitCode, one.p.signalCode], twoEnded: [two.p.exitCode, two.p.signalCode], twoSignals: existsSync(two.file) ? readFileSync(two.file, 'utf8').trim() : '', noted: /quit-app \d+: driver: no such app/.test(log) }));
    },
    // QA-G-53 (round 18), QA-01's driveraw-big: a driver answer of 3,000,000
    // bytes, as a tree read of a panel that lists many files can be, three
    // times Node's 1 MB default output buffer.
    async 'driveraw-big'() {
      const driver = path.join(os.tmpdir(), DRIVER);
      writeFileSync(driver, '#!/bin/sh\nprintf \'{"ok":true,"big":"\'\nhead -c 3000000 /dev/zero | tr \'\\0\' x\nprintf \'"}\\n\'\n');
      chmodSync(driver, 0o755);
      fake.realDriver = true;
      let read;
      try { const x = h.driveRaw('tree', 1, 5); read = { ok: x.ok, length: (x.big || '').length }; } catch (err) { read = { ok: false, length: 0, error: String(err.message).slice(0, 120) }; }
      console.log('BIG ' + JSON.stringify(read));
    },
    // Round 13 item 2: a copy recorded through a linked folder (as /tmp and
    // /var lead to /private), whose process runs from the real folder.
    async 'copy-through-link'() {
      const real = path.join(box, 'real-place');
      const exe = path.join(real, 'Plain Sight test copy.app', 'Contents', 'MacOS', 'plain-sight');
      mkdirSync(path.dirname(exe), { recursive: true });
      fs.symlinkSync(process.execPath, exe);
      fs.symlinkSync(real, path.join(box, 'linked-place'));
      const copy = await pidHolder(exe, 'quits', 'COPY');
      h.recordLaunch(copy.pid, path.join(box, 'linked-place', 'Plain Sight test copy.app'));
      console.log('ALIVE ' + h.alive(copy.pid));
      await stopCurrentFor({ pid: copy.pid });
      await holderAfter(copy);
    },
    // DISH's DN4 (round 17): a recorded copy whose bundle folder is gone by
    // the time the run stops it (the copy moved or removed while it runs).
    // realpathSync of a folder that is gone fails, and realPathOf then gives
    // the path as given, which ps still shows as the copy's program. The
    // bundle is made at the box's real path (a temporary folder can sit
    // behind a link, /var to /private/var), so the path the launch recorded
    // and the one ps shows agree with no link to resolve.
    async 'copy-folder-gone'() {
      const real = path.join(fs.realpathSync(box), 'gone-place');
      const bundle = path.join(real, 'Plain Sight test copy.app');
      const exe = path.join(bundle, 'Contents', 'MacOS', 'plain-sight');
      mkdirSync(path.dirname(exe), { recursive: true });
      fs.symlinkSync(process.execPath, exe);
      const copy = await pidHolder(exe, 'quits', 'COPY');
      h.recordLaunch(copy.pid, bundle);
      fs.rmSync(real, { recursive: true, force: true });
      console.log('FOLDER GONE ' + !existsSync(real));
      console.log('ALIVE ' + h.alive(copy.pid));
      await stopCurrentFor({ pid: copy.pid });
      await holderAfter(copy);
    },
    // PO-R12-1 (round 13): the same, with the pid held by another Plain Sight,
    // a program at another bundle's .../Contents/MacOS/plain-sight.
    async 'pid-reused-other-copy'() {
      const holder = await pidHolder(otherCopyExecutable(), 'stays', 'OTHER');
      h.recordLaunch(holder.pid, copyBundle);
      await stopCurrentFor({ pid: holder.pid });
      await waitsFor(holder.pid);
      await holderAfter(holder);
    },
    // QA-G-49 (round 13): QA-01's other names for the program that holds the
    // pid (wave-g/qa/scripts/app/r12_pid_adv.mjs with r12_pid_child.mjs): a
    // helper beside the copy's executable (its path starts with the copy's),
    // a bundle named as the copy's with .bak after it, and the copy's whole
    // path again under another folder (it ends with the copy's).
    async 'pid-reused-helper'() { await heldBy(path.join(copyBundle, 'Contents', 'MacOS', 'plain-sight-helper')); },
    async 'pid-reused-bak'() { await heldBy(path.join(copyBundle + '.bak', 'Contents', 'MacOS', 'plain-sight')); },
    async 'pid-reused-nested'() { await heldBy(path.join(box, 'nested') + path.join(copyBundle, 'Contents', 'MacOS', 'plain-sight')); },
    // What ps can answer for a recorded copy's pid, given here: the copy's
    // executable; the flag E with only the short name, as ps showed a copy
    // ending just after a SIGTERM; the state Z; another program; no process.
    async 'ps-states'() {
      const exe = path.join(copyBundle, 'Contents', 'MacOS', 'plain-sight');
      fake.ps = { 7001: 'S    ' + exe, 7002: '?E   (node)', 7003: 'Z    <defunct>', 7004: 'S    /usr/libexec/another-program' };
      for (const pid of [7001, 7002, 7003, 7004, 7005]) { h.recordLaunch(pid, copyBundle); console.log('ALIVE ' + pid + ' ' + h.alive(pid)); }
      await h.sleep(300);
    },
    // A copy that still runs the copy's executable, recorded the same way, is
    // stopped: the SIGTERM reaches it by its pid.
    async 'copy-stopped'() {
      const copy = await pidHolder(copyExecutable(), 'quits');
      h.recordLaunch(copy.pid, copyBundle);
      await stopCurrentFor({ pid: copy.pid });
      await holderAfter(copy);
    },
    // The restore check (QA-01's observation 9): a recorded copy whose pid
    // another program holds at the run's end is no app still running; a copy
    // still running is one.
    async 'run-copy-pid-reused'() {
      await runSuite([{ name: 'a test that records a copy whose pid another program holds', fn: async () => {
        testData(dirs[0]);
        const holder = await pidHolder(nodeHere);
        h.recordLaunch(holder.pid, copyBundle);
        console.log('ALIVE ' + h.alive(holder.pid));   // the rule's note, made well before the run ends
      } }]);
    },
    async 'run-copy-left-running'() {
      await runSuite([{ name: 'a test that leaves a copy running', fn: async () => {
        testData(dirs[0]);
        const copy = await pidHolder(copyExecutable(), 'quits');
        h.recordLaunch(copy.pid, copyBundle);
      } }]);
    },
    // A file of the person's that no one may read (mode 000).
    async 'run-restore-unreadable'() {
      personFile(dirs[1], 'locked.txt', 'NOT FOR THE HARNESS', 0o000);
      await runSuite([{ name: 'a test that writes test data', fn: async () => { testData(dirs[0]); } }]);
    },
    async 'run-unkillable-ignore'() { await unkillable('ignore'); },
    async 'run-unkillable-frozen'() { await unkillable('frozen'); },
    // H5: a sandbox probe's container (the bundle under test carries an
    // sbprobe- identifier), refused like a test copy's.
    async 'run-probe-container-refused'() {
      onRemove = (target) => { if (target === container) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer]);
    },
    // H6: a failed test and a leftover.
    async 'run-leftover-and-failure'() {
      onRemove = (target) => { if (target === container) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer, { name: 'a test that fails', fn: async () => { throw new Error('an assertion failed'); } }]);
    },
    // The Delivery Manager's AT-H3 (dm-appstore-534f3cc/adv, QA-01's H7): a
    // stop and a leftover.
    async 'run-leftover-and-stop'() {
      onRemove = (target) => { if (target === container) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer, { name: 'a test the person interrupts', fn: async () => { throw new h.UserActivity('keyboard or mouse used during the run (idle 0.0 s)'); } }, laterTest]);
    },
    // H8b: a test copy's folder that was there before the run, which the run
    // moved aside, is made again and refused on the way back.
    async 'run-copy-caches-kept'() {
      const caches = path.join(home, 'Library', 'Caches', h.APP_ID);
      mkdirSync(caches, { recursive: true });
      writeFileSync(marker(caches), 'OLD TEST DATA OF AN EARLIER RUN');
      onRemove = (target) => { if (target === caches) throw refused('rmdir', target); };
      await runSuite([{ name: 'the test copy\'s Caches folder is made again and macOS refuses its removal', fn: async () => { testData(caches); } }]);
    },
    // H8c: the real identifier's container, not there before the run, made by
    // the run (the D-39 trap) and refused on removal.
    async 'run-real-container-made'() {
      onRemove = (target) => { if (target === realContainer) throw refused('rmdir', target); };
      await runSuite([{ name: 'a run makes the real identifier\'s container and macOS refuses its removal', fn: async () => { testData(path.join(realContainer, 'Data')); } }]);
    },
    // H8d: the real identifier's cookie file, likewise: a name that starts
    // with the real identifier and a dot is not a test identifier's.
    async 'run-real-cookies-made'() {
      onRemove = (target) => { if (target === realCookies) throw refused('unlink', target); };
      await runSuite([{ name: 'a run makes the real identifier\'s cookie file and macOS refuses its removal', fn: async () => { mkdirSync(path.dirname(realCookies), { recursive: true }); writeFileSync(realCookies, 'CREATED BY THE RUN'); } }]);
    },
    // H13b: a locked screen at the start, in a suite that does not need it
    // unlocked.
    async 'run-locked-not-needed'() {
      fake.locked = true;
      await runSuite([{ name: 'a test that may run on a locked screen', fn: async () => { testData(dirs[0]); } }], { needUnlocked: false });
    },
    // H22, and the Delivery Manager's AT-H1: the screen locks during a run
    // that needs it unlocked.
    async 'run-locks-midway'() {
      await runSuite([{ name: 'a test during which the screen locks', fn: async () => { testData(dirs[0]); fake.locked = true; h.drive('cgwindows', 4242); } }, laterTest]);
    },
    // H26: a window on-screen the whole wait, but never the one the wait wants.
    async 'run-onscreen-unmatched'() {
      fake.windows = [HELPER, DOC_ON];
      await runSuite([{ name: 'a launch waits for two windows on screen', fn: async () => { testData(dirs[0]); await h.firstWindow(4242, (list) => list.filter((w) => w.onscreen).length >= 2 && list, 'two windows', 700); } }]);
    },
    // The Delivery Manager's AT-H2 (DISH-G-70 R1): on-screen, then lost
    // before the wait is met.
    async 'run-onscreen-then-lost'() {
      fake.windows = [HELPER, { ...DOC_ON, x: 230, y: 60 }, { ...DOC_ON, x: 260, y: 90 }];
      setTimeout(() => { fake.windows = [HELPER, { ...DOC_ON, onscreen: false, x: 230, y: 60 }]; }, 250);
      await runSuite([firstLaunch]);
    },
    // H28 (DISH-G-70 R2): a window of the document's size on another layer,
    // off-screen, is not the document window.
    async 'run-big-window-other-layer'() {
      fake.windows = [HELPER, { height: 747, layer: 25, onscreen: false, width: 980, x: 230, y: 60 }];
      await runSuite([firstLaunch]);
    },
    async 'run-own-folder-refused'() {
      onRemove = (target) => { if (target === dirs[0]) throw refused('rmdir', target); };
      await runSuite([launchMakesContainer]);
    },
    async 'run-container-from-before'() {
      mkdirSync(container, { recursive: true });
      writeFileSync(marker(container), 'TEST DATA OF AN EARLIER RUN');
      await runSuite([{ name: 'a test that must not run', fn: async () => { throw new Error('the run started over an earlier run\'s container'); } }]);
    },
    async 'run-backup-refused'() {
      let moves = 0;
      onRename = (from) => { moves += 1; if (moves === 2) throw refused('rename', from); };
      await runSuite([{ name: 'a test that must not run', fn: async () => { throw new Error('the run started without its backup'); } }]);
    },
    // The lock screen (DISH-G-50): the suites that launch the app need an
    // unlocked Mac left alone with the display on.
    async 'run-locked'() {
      fake.locked = true;
      await runSuite([{ name: 'a test that must not run', fn: async () => { throw new Error('the run started on a locked screen'); } }]);
    },
    // A launch's window listed only off-screen for the whole first wait, as
    // on 26 October with the screen locked (e2e-run-1's listings: AppKit's
    // 500 by 500 helper and the 980 by 747 document window, both off-screen).
    async 'run-offscreen'() {
      fake.windows = [HELPER, { height: 747, layer: 0, onscreen: false, width: 980, x: 230, y: 60 }];
      await runSuite([firstLaunch, { name: 'a later test', fn: async () => { throw new Error('a test ran after the stop'); } }]);
    },
    // No document window at all, only AppKit's off-screen helpers: the app's
    // failure, never taken for a locked screen.
    async 'run-no-window'() {
      fake.windows = [HELPER, { height: 0, layer: 0, onscreen: false, width: 0, x: 0, y: 0 }];
      await runSuite([firstLaunch]);
    },
    async 'run-onscreen'() {
      fake.windows = [HELPER, DOC_ON];
      await runSuite([firstLaunch]);
    }
  };
  const HELPER = { height: 500, layer: 0, onscreen: false, width: 500, x: 0, y: 940 };
  const DOC_ON = { height: 744, layer: 0, onscreen: true, width: 980, x: 790, y: 324 };
  // A launch of the test copy: its container, and test data in the app's folders.
  const launchMakesContainer = { name: 'a launch of the test copy makes its container and writes into the app\'s folders', fn: async () => { testData(path.join(container, 'Data', 'Library', 'WebKit', 'WebsiteData')); testData(dirs[0]); } };
  const laterTest = { name: 'a later test', fn: async () => { throw new Error('a test ran after the stop'); } };
  // A launch's first wait, as e2e.mjs waits for its window, after writing
  // test data where the app would.
  const firstLaunch = {
    name: 'a launch waits for its first window',
    fn: async () => {
      testData(dirs[0]);
      const windows = await h.firstWindow(4242, (list) => list.filter((w) => w.layer === 0 && w.onscreen).length === 1 && list, 'the app window', 700);
      console.log('FIRST WINDOW ' + JSON.stringify(windows.filter((w) => w.onscreen)));
    }
  };
  // For the run-* cases: the test copy's container, test data written where
  // a launch would write it, macOS's refusal, and the suite's own call of run().
  const container = h.APP_ID === h.ID ? null : path.join(CONTAINERS(home), h.APP_ID);
  const testData = (dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(marker(dir), 'TEST DATA'); };
  const refused = (call, target, code = 'EPERM') => Object.assign(new Error(code + ': ' + (code === 'EACCES' ? 'permission denied' : 'operation not permitted') + ', ' + call + ' \'' + target + '\''), { code });
  const runSuite = (tests, { needUnlocked = true, after = null } = {}) => {
    mkdirSync(path.join(home, 'Downloads'), { recursive: true });
    return h.run(tests, { name: 'release', needUnlocked, ...(after ? { after } : {}) });
  };
  // An after() that takes a while, as the suites' do while the app quits.
  // It says whether the run's lock is still held as it starts (QA-G-40).
  const slowAfter = async () => { console.log('IN AFTER'); console.log('LOCK HELD ' + existsSync(LOCK(home))); await new Promise((r) => setTimeout(r, 3000)); console.log('AFTER DONE'); };
  // DM-249: the stand-in app (the parent's STANDIN), started through the
  // harness's spawnApp as e2e.mjs starts the test build. `current` is the app
  // a test launched last, as e2e.mjs's `app` is, and e2eAfter is e2e.mjs's
  // after(); afterDone settles once a case's after() has ended.
  const appSupport = path.join(home, 'Library', 'Application Support', h.ID);
  const standinEnv = { STANDIN_PIDS: path.join(box, STANDIN_PIDS), STANDIN_WEBDATA: path.join(home, 'Library', 'WebKit', 'plain-sight'), STANDIN_APPDATA: appSupport };
  let current = null;
  const launchApp = () => { const child = h.spawnApp(process.env[STANDIN], standinEnv); current = { child, pid: child.pid }; return current; };
  const recorded = () => (existsSync(standinEnv.STANDIN_PIDS) ? readFileSync(standinEnv.STANDIN_PIDS, 'utf8').split('\n') : []);
  const ready = async (app) => { await h.until(() => recorded().includes(String(app.pid)), 'the stand-in app to start', 10000); return app; };
  const e2eAfter = () => h.stopCurrentApp(() => current);
  let afterEnded = null;
  const afterDone = new Promise((resolve) => { afterEnded = resolve; });
  const e2eAfterThenSay = async () => { await e2eAfter(); console.log('AFTER DONE'); afterEnded(); };
  // QA-01's E1: e2e.mjs run as it is, its app the stand-in. The child refuses
  // unless the app e2e.mjs would launch is that stand-in, in this file's own
  // temporary folder, so no test build is ever started.
  // DM-249's launched half (round 10): a file of the person's, written into a
  // data folder before the run; and a late writer (the parent's LATE script),
  // started by a test and never recorded as an app (its pid goes into
  // late-pids.txt for the parent's end, DM-269), which waits until the
  // marker of the target's data folder (the folder the target is in, or the
  // one named) holds the person's own words again, that is until the
  // restore, then acts on the target 1 s later.
  const personFile = (dir, rel, text, mode = 0o644) => { const file = path.join(dir, rel); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, mode); };
  const lateWriter = (target, action, folder = path.dirname(target)) => {
    const writer = spawn(nodeHere, [process.env[LATE], marker(folder), real(home, folder), target, action], { stdio: 'ignore', detached: true });
    fs.appendFileSync(path.join(box, LATE_PIDS), writer.pid + '\n');
    writer.unref();
  };
  // Round 12, the reused pid: a pid holder (the parent's script) started
  // under the program given, ready once it can take signals; it prints its
  // pid and the file it records signals in, by which the parent ends it. A
  // copy's executable is <bundle>/Contents/MacOS/plain-sight, as
  // LaunchServices starts it; here a link to node, so ps names the process
  // by that path. stopCurrentFor races stopCurrentApp against 6 s, and its
  // current() answers at most five times, so a stop that loops cannot hold
  // the case; waitsFor is the suites' check and wait on an app's pid.
  let holders = 0;
  const copyBundle = path.join(box, 'copy', 'Plain Sight test copy.app');
  const copyExecutable = () => {
    const exe = path.join(copyBundle, 'Contents', 'MacOS', 'plain-sight');
    if (!existsSync(exe)) { mkdirSync(path.dirname(exe), { recursive: true }); fs.symlinkSync(process.execPath, exe); }
    return exe;
  };
  // PO-R12-1 (round 13): another Plain Sight, such as the person's own app
  // in /Applications or another test copy, is a program at another bundle's
  // .../Contents/MacOS/plain-sight; here a link to node at such a path.
  const otherCopyExecutable = () => {
    const exe = path.join(box, 'other', 'Plain Sight.app', 'Contents', 'MacOS', 'plain-sight');
    if (!existsSync(exe)) { mkdirSync(path.dirname(exe), { recursive: true }); fs.symlinkSync(process.execPath, exe); }
    return exe;
  };
  // QA-G-49: a recorded copy whose pid a program at `exe` (a link to node
  // made there) holds.
  const heldBy = async (exe) => {
    mkdirSync(path.dirname(exe), { recursive: true });
    if (!existsSync(exe)) fs.symlinkSync(process.execPath, exe);
    const holder = await pidHolder(exe, 'stays', 'OTHER');
    h.recordLaunch(holder.pid, copyBundle);
    await stopCurrentFor({ pid: holder.pid });
    await waitsFor(holder.pid);
    await holderAfter(holder);
  };
  const pidHolder = async (program, mode = 'stays', label = program === nodeHere ? 'HOLDER' : 'COPY', extra = []) => {
    holders += 1;
    const file = path.join(box, 'holder-' + holders + '-signals');
    const p = spawn(program, [process.env[HOLDER_ENV], file, mode, ...extra], { stdio: 'ignore' });
    console.log(label + ' ' + p.pid + ' ' + file);
    await h.until(() => existsSync(file + '.ready'), 'the pid holder to take signals', 10000);
    return { p, pid: p.pid, file };
  };
  const stopCurrentFor = async (app) => {
    let asked = 0;
    const t0 = Date.now();
    const how = await Promise.race([
      h.stopCurrentApp(() => (asked++ < 5 ? app : null)).then(() => 'returned', (err) => 'threw ' + err.message),
      h.sleep(6000).then(() => 'still waiting')
    ]);
    console.log('STOP CURRENT ' + how + ' after ' + (Date.now() - t0) + ' ms; current() asked ' + asked + ' time(s)');
  };
  const waitsFor = async (pid) => {
    console.log('ALIVE ' + h.alive(pid));
    const t0 = Date.now();
    const how = await h.until(() => !h.alive(pid), 'the app to end', 3000).then(() => 'returned', (err) => 'threw ' + err.message);
    console.log('WAIT ' + how + ' after ' + (Date.now() - t0) + ' ms');
  };
  const holderAfter = async (holder) => {
    await h.sleep(300);
    console.log('SIGNALS ' + ((existsSync(holder.file) ? readFileSync(holder.file, 'utf8').trim() : '') || 'none'));
    console.log('STILL RUNS ' + (holder.p.exitCode === null && holder.p.signalCode === null));
  };
  // QA-G-44 (N6): QA-01's L5 (r9_launch_adv.mjs with r9_launch_child.mjs,
  // case unkillable): an app that ignores SIGTERM, or freezes itself on it,
  // so only stopApp's SIGKILL after its 8 s wait ends it. The test tries to
  // launch again while the cleanup waits, and after() is e2e.mjs's own.
  const unkillable = (mode) => runSuite([{ name: 'an app that will not quit on SIGTERM', fn: async () => {
    const child = h.spawnApp(process.env[STANDIN], { ...standinEnv, STANDIN_MODE: mode });
    current = { child, pid: child.pid };
    await ready(current);
    console.log('IN TEST');
    await h.sleep(1500);
    try { launchApp(); console.log('RELAUNCHED ' + current.pid); } catch (err) { console.log('REFUSED ' + err.constructor.name); }
    await h.sleep(15000);
  } }], { after: async () => { console.log('IN AFTER'); const t0 = Date.now(); await e2eAfter(); console.log('AFTER DONE after ' + (Date.now() - t0) + ' ms'); } });
  const e2eSuite = async (windows) => {
    fake.windows = windows;
    mkdirSync(path.join(home, 'Downloads'), { recursive: true });
    Object.assign(process.env, standinEnv, { PLAIN_SIGHT_E2E_APP: process.env[STANDIN], PLAIN_SIGHT_ONLY: '^first launch: ' });
    if (!process.env.PLAIN_SIGHT_E2E_APP || !process.env.PLAIN_SIGHT_E2E_APP.startsWith(path.dirname(box) + path.sep)) {
      console.log('refusing: e2e.mjs would launch ' + process.env.PLAIN_SIGHT_E2E_APP + ', not the stand-in');
      process.exit(2);
    }
    await import(pathToFileURL(path.join(HERE, 'e2e.mjs')).href);
  };
  // Round 11: e2e.mjs run as it is, its hidden-document test only, with a
  // fake of the test build's hook (src-tauri/src/e2e.rs) answering in the
  // probe folder: the page's visibility, the window actions and windowState.
  // The test launches nothing; the child refuses as e2eSuite does unless the
  // app e2e.mjs would launch is the stand-in.
  const e2eHidden = async (showBringsItBack, touchAtTimeout = false) => {
    const probe = path.join(h.EVIDENCE, 'probe');
    let visibility = 'visible';
    let windowStates = 0;
    const answerFor = (req) => {
      if (req.eval === 'document.visibilityState') return { ok: true, value: visibility };
      if (req.window === 'minimize' || req.window === 'hide') { visibility = 'hidden'; return { ok: true }; }
      if (req.window === 'unminimize' || (req.window === 'show' && showBringsItBack)) { visibility = 'visible'; return { ok: true }; }
      if (req.window === 'show') return { ok: true };
      if (req.windowState === true) {
        // PO-R11-1: the second read of the window's state is the timeout's; a
        // person touches the Mac as it is given, so the driver's next look at
        // the session finds the Mac just used.
        windowStates += 1;
        if (touchAtTimeout && windowStates === 2) fake.idle = -(Date.now() - started) / 1000;
        return { ok: true, value: { fakeHook: true, occlusionVisible: visibility === 'visible', appActive: visibility === 'visible', appHidden: false } };
      }
      return { ok: false, error: 'the fake hook has no answer for ' + JSON.stringify(req) };
    };
    setInterval(() => {
      const request = path.join(probe, 'request.json');
      if (!existsSync(request)) return;
      const req = JSON.parse(readFileSync(request, 'utf8'));
      rmSync(request);
      const tmp = path.join(probe, 'response-' + req.id + '.tmp');
      writeFileSync(tmp, JSON.stringify(answerFor(req)));
      fs.renameSync(tmp, path.join(probe, 'response-' + req.id + '.json'));
    }, 20).unref();
    mkdirSync(path.join(home, 'Downloads'), { recursive: true });
    Object.assign(process.env, standinEnv, { PLAIN_SIGHT_E2E_APP: process.env[STANDIN], PLAIN_SIGHT_ONLY: '^a minimized window and a hidden app give the page a hidden document' });
    if (!process.env.PLAIN_SIGHT_E2E_APP || !process.env.PLAIN_SIGHT_E2E_APP.startsWith(path.dirname(box) + path.sep)) {
      console.log('refusing: e2e.mjs would launch ' + process.env.PLAIN_SIGHT_E2E_APP + ', not the stand-in');
      process.exit(2);
    }
    await import(pathToFileURL(path.join(HERE, 'e2e.mjs')).href);
  };
  try {
    await cases[which]();
    console.log('RESULT ok');
    process.exit(0);
  } catch (err) {
    console.log('RESULT fail: ' + String(err && err.message ? err.message : err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// The parent: a box per case, inside one temporary folder removed at the end.
// ---------------------------------------------------------------------------
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'plain-sight-harness-safety-'));

// DM-249: a stand-in for the app, written into the temporary folder (the
// Delivery Manager's adv/standin-app.mjs and standin-app-folder.mjs in one).
// It records its pid once it can take a SIGTERM (a SIGTERM while node still
// starts would end it at once, so the cases wait for that record), ends 1 s
// after its first SIGTERM (the app's quit takes about a second), writes a file into STANDIN_WEBDATA 1.5 s after it starts
// (as the test build writes its web data), and removes folder.txt from
// STANDIN_APPDATA 150 ms after it starts, as every launch of this branch's
// build does (folder.rs, Folder::with, through Folder::load). It writes
// nothing to its output, so a closed pipe cannot end it, and it ends by
// itself after 20 s. With STANDIN_MODE ignore it ignores SIGTERM, and with
// frozen it stops itself (SIGSTOP) on it, so only a SIGKILL ends it (QA-01's
// r9_standin.mjs modes, QA-G-44). It runs node through the link in the
// case's own folder that the child names in STANDIN_NODE, so that ps shows
// it there and the parent may end it (DM-269).
const STANDIN_APP = path.join(ROOT, 'standin-app.mjs');
const STANDIN_EXE = path.join(ROOT, 'standin-app');
writeFileSync(STANDIN_APP, [
  "import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  "const env = process.env;",
  "let quitting = false;",
  "process.on('SIGTERM', () => { if (env.STANDIN_MODE === 'ignore') return; if (env.STANDIN_MODE === 'frozen') { process.kill(process.pid, 'SIGSTOP'); return; } if (quitting) return; quitting = true; setTimeout(() => process.exit(0), 1000); });",
  "process.on('SIGINT', () => {});",
  "process.on('SIGHUP', () => {});",
  "appendFileSync(env.STANDIN_PIDS, process.pid + '\\n');",
  "if (env.STANDIN_APPDATA) setTimeout(() => { try { rmSync(path.join(env.STANDIN_APPDATA, 'folder.txt'), { force: true }); } catch {} }, 150);",
  "if (env.STANDIN_WEBDATA) setTimeout(() => { try { mkdirSync(env.STANDIN_WEBDATA, { recursive: true }); writeFileSync(path.join(env.STANDIN_WEBDATA, 'written-by-' + process.pid), 'WRITTEN BY THE TEST APP'); } catch {} }, 1500);",
  "setTimeout(() => process.exit(0), 20000);"
].join('\n') + '\n');
const shellQuoted = (p) => "'" + p.replace(/'/g, "'\\''") + "'";
writeFileSync(STANDIN_EXE, '#!/bin/sh\nexec "${STANDIN_NODE:?}" ' + shellQuoted(STANDIN_APP) + '\n');
chmodSync(STANDIN_EXE, 0o755);

// The late writer of the restore check's cases (round 10): waits until a
// file holds the given text (the person's marker, back after the restore),
// then 1 s later changes the target or removes it; it ends by itself after
// 30 s if the text never comes. A change appends to the target; same-size
// rewrites it with as many bytes, every one an x, and same-bytes writes its
// own bytes again, which changes only its modification time (PO-R10-1);
// create makes a new file there, and seal takes every permission from a
// folder, so that no one may list it (DM-257); grow-same-time appends to the
// target and puts its modification time back to the nanosecond (cp -p to a
// reference beside this script, then touch -r, as QA-01's writer does), and
// remove-folder removes a whole folder (QA-G-46).
const LATE_WRITER = path.join(ROOT, 'late-writer.mjs');
writeFileSync(LATE_WRITER, [
  "import { execFileSync } from 'node:child_process';",
  "import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  "const [watch, expect, target, action] = process.argv.slice(2);",
  "const started = Date.now();",
  "const look = setInterval(() => {",
  "  let now = null;",
  "  try { now = readFileSync(watch, 'utf8'); } catch { now = null; }",
  "  if (now === expect) {",
  "    clearInterval(look);",
  "    setTimeout(() => {",
  "      if (action === 'remove') rmSync(target, { force: true });",
  "      else if (action === 'same-size') writeFileSync(target, Buffer.alloc(readFileSync(target).length, 'x'));",
  "      else if (action === 'same-bytes') writeFileSync(target, readFileSync(target));",
  "      else if (action === 'create') { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, 'MADE AFTER THE RESTORE'); }",
  "      else if (action === 'seal') chmodSync(target, 0o000);",
  "      else if (action === 'grow-same-time') { const ref = path.join(path.dirname(process.argv[1]), 'time-ref-' + process.pid); execFileSync('cp', ['-p', target, ref]); appendFileSync(target, ' MORE'); execFileSync('touch', ['-r', ref, target]); rmSync(ref); }",
  "      else if (action === 'remove-folder') rmSync(target, { recursive: true, force: true });",
  "      else appendFileSync(target, ' CHANGED LATE');",
  "    }, 1000);",
  "  } else if (Date.now() - started > 30000) clearInterval(look);",
  "}, 20);"
].join('\n') + '\n');

// The pid holder of the reused pid's cases (round 12): a program that holds a
// pid, standing for the one macOS gives an ended app's pid to. It records
// each SIGTERM, SIGINT, SIGHUP and SIGQUIT it gets in the file it is given
// (ending on none of them, so each stays on record), says it can take them
// in that file's .ready, and ends by itself after 30 s; with "quits" it ends
// on its first SIGTERM, as a copy of the app does.
const HOLDER = path.join(ROOT, 'pid-holder.mjs');
writeFileSync(HOLDER, [
  "import { appendFileSync, writeFileSync } from 'node:fs';",
  "const [file, mode] = process.argv.slice(2);",
  "for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) process.on(s, () => { appendFileSync(file, s + ' '); if (s === 'SIGTERM' && mode === 'quits') process.exit(0); if (s === 'SIGTERM' && mode === 'quits-in-1s') setTimeout(() => process.exit(0), 1000); });",
  "writeFileSync(file + '.ready', String(process.pid));",
  "setTimeout(() => process.exit(0), 30000);"
].join('\n') + '\n');

// A fake bundle under a test identifier, outside the fake home, for the
// harness to read as PLAIN_SIGHT_APP (only its Info.plist is read).
function fakeCopy(box, identifier) {
  const app = path.join(box, 'bundle', 'Plain Sight test copy.app');
  mkdirSync(path.join(app, 'Contents'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>' + identifier + '</string><key>CFBundleName</key><string>Plain Sight test copy</string></dict></plist>\n');
  return app;
}

// DM-269 (round 21): the parent's rule for ending what a case started.
// Until round 20 the parent ended a case's processes by what its child
// printed, unguarded: pkill -9 -f with a printed file (a child that printed
// "HOLDER 4242 /" made it run pkill -9 -f /, which ends every process whose
// command line holds a slash), and SIGKILL to a printed pid once ps showed
// the printed program there (the Delivery Manager's recorder, ap.mjs). Now
// the parent runs no pkill or killall at all and ends a process only by its
// pid: a child it started itself and holds, or a pid a case printed or
// wrote into a file in its box, and that one only when ps shows it running
// a program whose resolved path lies (a) under this run's temporary folder
// and (b) under one of that case's own folders (its box, or the second
// folder the proof case gets). Anything else is refused, printed as PARENT
// REFUSED, and fails the run. Every place the parent signals:
// - endHolders: the pid holders a case printed (its HOLDER, COPY, OTHER and
//   BYSTANDER lines), through endCasePid;
// - endOutsideStandIns: the proof case's stand-ins (its OUTSIDE and SECOND
//   lines), through endCasePid, in the case's second folder alone;
// - standinsAfter: the stand-in apps a case recorded in standin-pids.txt,
//   through endCasePid;
// - endLeftovers, for every case at the end of the run: all three, and the
//   late writers in late-pids.txt, through endCasePid (in place of the
//   pkill -9 -f of the stand-in's, the late writer's and the pid holder's
//   scripts);
// - runCase's watchdog, the signal tests and secondRun: child.kill and
//   c.kill on the child the parent itself started, through Node, which
//   sends nothing to a child it has seen end;
// - isAlive: signal 0, which sends nothing and only asks whether a pid is in
//   use;
// - the hostile-prints test: standIn.kill on the two stand-ins it started
//   itself.
const parentRefusals = [];
const parentSent = [];
const ranCases = [];
let sayParent = (line) => console.log(line);
const refuseParent = (what) => { parentRefusals.push(what); sayParent('PARENT REFUSED ' + what); };
const realOrAsGiven = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const liesIn = (file, dir) => path.join(realOrAsGiven(path.dirname(file)), path.basename(file)).startsWith(realOrAsGiven(dir) + path.sep);
function endCasePid(pid, folders, what) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) { refuseParent(what + ': ' + pid + ' is no pid a case can have started'); return; }
  const ps = childProcess.spawnSync('/bin/ps', ['-ww', '-o', 'stat=', '-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
  const [, stat, program] = String(ps.stdout || '').replace(/\n+$/, '').match(/^\s*(\S+)\s+(.*)$/s) || [];
  if (!stat || /[EZ]/.test(stat)) return;   // gone, ending or ended: nothing to end
  if (liesIn(program, ROOT) && folders.some((dir) => liesIn(program, dir))) {
    parentSent.push(pid);
    try { process.kill(pid, 'SIGKILL'); } catch { /* it has ended */ }
    return;
  }
  refuseParent(what + ': pid ' + pid + ' runs ' + program + ', not a program in ' + folders.join(' or ') + ' inside this run\'s folder ' + ROOT);
}

// Every case ends within its watchdog (120 s, or what it names): one that
// hangs is ended with SIGKILL and fails, so a regression fails instead of
// holding the suite (QA-G-44).
// A signal the case's guard refused fails the case: the promise is rejected
// with the refusals, unless the case is the guard's own proof (refusals).
// outside gives the case a second folder (PO-R18-1, round 19): true makes
// one beside the case's own folder, inside this run's folder (so that the
// parent may end what runs there, DM-269), named as the case's with
// -outside after it (so that a folder check without its separator would
// take it for the case's own, DM-268); a path names the folder itself (the
// hostile-prints test's, outside this run's folder). targets is the
// hostile-prints case's TARGETS. Each case's result is kept for
// endLeftovers at the end of the run.
function runCase(id, onOutput = () => {}, { app = null, tag = id, recheck = 100, watchdog = 120000, outside = false, refusals = false, targets = null } = {}) {
  const box = path.join(ROOT, tag);
  const home = path.join(box, 'home');
  const tmp = path.join(box, 'tmp');
  const evidence = path.join(box, 'evidence');
  for (const d of [home, tmp, evidence]) mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, TMPDIR: tmp, PLAIN_SIGHT_EVIDENCE: evidence, [BOX]: box, [STANDIN]: STANDIN_EXE, [LATE]: LATE_WRITER, [HOLDER_ENV]: HOLDER };
  // Nothing of the shell that runs npm test reaches the harness's settings.
  for (const name of ['PLAIN_SIGHT_E2E_DOWNLOADS', 'PLAIN_SIGHT_APP', 'PLAIN_SIGHT_IDLE_MIN', 'PLAIN_SIGHT_ONLY', 'PLAIN_SIGHT_ALLOW_REAL_ID', 'PLAIN_SIGHT_SAFETY_ONLY', OUTSIDE, TARGETS, 'STANDIN_NODE']) delete env[name];
  if (app) env.PLAIN_SIGHT_APP = fakeCopy(box, app);
  if (recheck !== null) env[RECHECK] = String(recheck);
  const outsideDir = typeof outside === 'string' ? outside : outside ? box + '-outside' : null;
  if (outside === true) mkdirSync(outsideDir, { recursive: true });
  if (outsideDir) env[OUTSIDE] = outsideDir;
  if (targets) env[TARGETS] = JSON.stringify(targets);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', id], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const timer = setTimeout(() => { out += '\nWATCHDOG: the case ran for ' + watchdog + ' ms and was ended with SIGKILL\n'; child.kill('SIGKILL'); }, watchdog);
  const feed = (chunk) => { out += chunk; onOutput(out, child, box); };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  return new Promise((resolve, reject) => child.on('exit', (code, signal) => {
    clearTimeout(timer);
    const line = out.split('\n').find((l) => l.startsWith('DIRS '));
    const dirs = line ? JSON.parse(line.slice(5)).map((rel) => path.join(home, rel)) : [];
    const refusalFile = path.join(box, REFUSALS);
    const refused = existsSync(refusalFile) ? readFileSync(refusalFile, 'utf8').split('\n').filter(Boolean) : [];
    const result = {
      code, signal, out, dirs, home, box, outsideDir, refused,
      intact: dirs.length > 0 && dirs.every((d) => existsSync(marker(d)) && readFileSync(marker(d), 'utf8') === real(home, d)),
      backups: existsSync(BACKUP_ROOT(home)) ? readdirSync(BACKUP_ROOT(home)) : [],
      tmpFiles: readdirSync(tmp),
      lock: existsSync(LOCK(home)),
      containers: existsSync(CONTAINERS(home)) ? readdirSync(CONTAINERS(home)) : []
    };
    ranCases.push(result);
    if (refused.length && !refusals) {
      reject(new Error('the case tried to signal a process outside its own folder, and the guard refused: ' + refused.join('; ') + '\nthe child\'s output:\n' + out));
      return;
    }
    resolve(result);
  }));
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ended = (r, code) => {
  assert.equal(r.signal, null, 'the child ended by itself, not by a signal; its output:\n' + r.out);
  assert.equal(r.code, code, 'the child ended with ' + code + '; its output:\n' + r.out);
};
const clean = (r) => {
  assert.ok(r.intact, 'every data folder holds what was there before the run; the child\'s output:\n' + r.out);
  assert.deepEqual(r.backups, [], 'no backup folder is left');
  assert.deepEqual(r.tmpFiles, [DRIVER], 'the harness compiled nothing and wrote nothing else into the temporary folder');
};

test('a restore before any backup changes nothing (QA-01 X1)', async () => {
  const r = await runCase('restore-before-backup');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/);
  clean(r);
});
test('a clear of the test data before any backup is refused and changes nothing (QA-01 X3)', async () => {
  const r = await runCase('clear-before-backup');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/);
  clean(r);
});
test('freshStart makes no fresh copy before the app\'s data is moved aside or after it is put back: it throws, and the copy script is never asked (DISH-G-81 F2)', async () => {
  const r = await runCase('fresh-start-phases');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/, 'the child\'s output:\n' + r.out);
  clean(r);
});
test('two fresh copies asked for in the same millisecond, before either is launched, get two stamps and two identifiers (QA-G-40 K32; QA-01\'s P2.3, the Delivery Manager\'s AT-H5b)', async () => {
  const r = await runCase('fresh-start-twice');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/, 'the child\'s output:\n' + r.out);
  clean(r);
});
test('a restore asked for while the backup is incomplete is refused and names what to put back, decoded, and from where (QA-01 X2)', async () => {
  const r = await runCase('restore-while-moving');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/);
  clean(r);
});
test('a second restore after a complete one changes nothing (QA-01 C10)', async () => {
  const r = await runCase('restore-twice');
  ended(r, 0);
  assert.match(r.out, /RESULT ok/);
  clean(r);
});
test('the signal handlers are installed before the app\'s data is moved aside, and the handler puts everything back and ends the run with 130 (QA-01 H5)', async () => {
  const r = await runCase('handlers-before-backup');
  ended(r, 130);
  assert.match(r.out, /HANDLERS DURING THE FIRST MOVE \[/, 'the counts were read during the first move');
  assert.doesNotMatch(r.out, /RESULT fail/, r.out);
  clean(r);
});
test('a signal during the move is taken after it: the backup finishes, everything is put back, and the run ends with 130 (QA-G-24)', async () => {
  let sent = false;
  const r = await runCase('signal-during-backup', (out, child, box) => {
    if (sent || !out.includes('MOVING 2')) return;
    sent = true;
    child.kill('SIGINT');
    writeFileSync(path.join(box, SIGNAL_SENT), '');
  });
  assert.ok(sent, 'the signal was sent while the second folder was being moved; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /BACKUP DONE/, 'the backup finished before the signal was taken; the child\'s output:\n' + r.out);
  clean(r);
});

// DM-243: release-run-1 (26 October 2026) ended with exit 6 and "could not
// clear the test data in .../Containers/com.pranavongole.plainsight.testcopy-
// 1793065378 (EPERM)", though every folder of the person's came back.
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
test('a test copy\'s container that macOS will not let the run remove is test data left behind: named, listed at the end by name, exit code 8, and the person\'s data is back (DM-243)', async () => {
  const r = await runCase('run-test-container-refused', undefined, { app: TEST_COPY });
  ended(r, 8);
  const container = path.join(CONTAINERS(r.home), TEST_COPY);
  assert.ok(r.out.includes('test data left behind: ' + container + ' (macOS refused to remove it; remove it by hand, see wave-g/probe/DESIGN.md, Leftovers)'), 'the leftover is named, with what to do; the child\'s output:\n' + r.out);
  assert.match(r.out, new RegExp('^Test containers on this Mac at the end of the run \\(names only, never opened\\): ' + esc(TEST_COPY) + '$', 'm'), 'the summary lists it by name');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m, 'a leftover is not counted as an error');
  assert.match(r.out, /^Exit code: 8 \(test data left behind; your own data is back\)$/m);
  assert.doesNotMatch(r.out, /Could not restore app data/, 'the person\'s data came back');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
  assert.ok(r.containers.includes(TEST_COPY), 'the container is left where it is: ' + JSON.stringify(r.containers));
});
test('the same refusal on a folder of the person\'s own app still ends the run with 6 and keeps that folder\'s data in the backup, named (DM-243)', async () => {
  const r = await runCase('run-own-folder-refused', undefined, { app: TEST_COPY });
  ended(r, 6);
  assert.ok(r.out.includes('Could not restore app data: could not clear the test data in ' + r.dirs[0] + ' (EPERM)'), 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /test data left behind/, 'a folder of the person\'s is never taken for test data');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m);
  assert.equal(r.backups.length, 1, 'what was in that folder before the run waits in the backup');
  for (const d of r.dirs.slice(1)) assert.equal(readFileSync(marker(d), 'utf8'), real(r.home, d), 'the other folders came back: ' + d);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a run on a test copy whose container is still there from an earlier run does not start: nothing is moved, and the refusal names the container and app:testcopy (DM-243)', async () => {
  const r = await runCase('run-container-from-before', undefined, { app: TEST_COPY });
  ended(r, 4);
  assert.match(r.out, new RegExp('^release: not started: the bundle under test, ' + esc(TEST_COPY) + ', has a container from an earlier run, .*npm run app:testcopy.*\\. Errors: 0$', 'm'), 'the child\'s output:\n' + r.out);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
  assert.equal(readFileSync(marker(path.join(CONTAINERS(r.home), TEST_COPY)), 'utf8'), 'TEST DATA OF AN EARLIER RUN', 'the container is left as it was');
});
test('a move aside that macOS refuses ends the run as not started, with every folder in its place and the lock released (DM-243)', async () => {
  const r = await runCase('run-backup-refused');
  ended(r, 4);
  assert.match(r.out, /^release: not started: could not move .+ aside \(EPERM\); everything was put back\. Errors: 0$/m, 'the child\'s output:\n' + r.out);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// The lock screen (DISH-G-50): e2e-run-1 and release-run-1 (26 October 2026)
// started with the screen locked, every window of the app was listed with
// onscreen false (888 listings and 211, none on-screen), and each wait for a
// window was counted as a failure.
test('a suite that needs an unlocked Mac does not start on a locked screen: exit code 4, the reason given, nothing moved (DISH-G-50)', async () => {
  const r = await runCase('run-locked');
  ended(r, 4);
  assert.match(r.out, /^release: not started: the screen is locked: these suites need an unlocked Mac left alone, display on\. Errors: 0$/m, 'the child\'s output:\n' + r.out);
  clean(r);
  assert.equal(r.lock, false, 'no lock was taken');
});
test('a launch whose window is listed only off-screen for the whole first wait stops the run as not run: exit code 3, nothing counted as failed, the data back (DISH-G-50)', async () => {
  const r = await runCase('run-offscreen');
  ended(r, 3);
  assert.match(r.out, /^stop - a launch waits for its first window \(every window is off-screen \(the screen locked or the display asleep during the run\)\)$/m, 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^skip - a later test \(not run: every window is off-screen /m, 'the tests after it are not run');
  assert.match(r.out, /^0 passed, 0 failed, 2 not run, 2 total\. Errors: 0$/m);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a launch with no document window at all, only AppKit\'s off-screen helpers, is still the app\'s failure, not a locked screen (DISH-G-50)', async () => {
  const r = await runCase('run-no-window');
  ended(r, 1);
  assert.match(r.out, /^FAIL - a launch waits for its first window$/m, 'the child\'s output:\n' + r.out);
  assert.match(r.out, /timed out after 700 ms waiting for the app window/, 'the wait\'s own timeout is the failure');
  assert.doesNotMatch(r.out, /every window is off-screen/);
  clean(r);
});
test('a launch whose document window is on-screen ends the first wait with the windows listed (DISH-G-50)', async () => {
  const r = await runCase('run-onscreen');
  ended(r, 0);
  assert.match(r.out, /^FIRST WINDOW \[\{"height":744,"layer":0,"onscreen":true,"width":980,"x":790,"y":324\}\]$/m, 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m);
  clean(r);
});

// DM-248: a Ctrl+C or a kill during the harness's own cleanup ended the run
// with 130 before the app's data was put back, so the data stayed in
// appdata-backup and the lock file stayed (the Delivery Manager's AT-H6 and
// AT-H7 showed it under this file's fake home). They are adopted here with
// the answer the fix sets: the signal waits for the restore and the lock
// release, is reported, and the run then ends with 130. In each, after() runs
// and ends once, with the run's lock still held as it starts (QA-G-40: QA-01's
// K43, each caller with a cleanup of its own, and K41, the lock dropped before
// after(); its P3.2a and P3.2c).
const onceWithTheLock = (r) => {
  const lines = r.out.split('\n');
  assert.equal(lines.filter((l) => l === 'IN AFTER').length, 1, 'after() ran once; the child\'s output:\n' + r.out);
  assert.equal(lines.filter((l) => l === 'AFTER DONE').length, 1, 'and ended once');
  assert.deepEqual(lines.filter((l) => l.startsWith('LOCK HELD ')), ['LOCK HELD true'], 'the run\'s lock was held when after() started');
};
test('a Ctrl+C while the run\'s own cleanup waits for the app to quit waits for that cleanup: the data back, the lock released, the signal reported, exit code 130 (DM-248; the Delivery Manager\'s AT-H6)', async () => {
  let sent = false;
  const r = await runCase('run-signal-during-cleanup', (out, child) => {
    if (sent || !out.includes('IN AFTER')) return;
    sent = true;
    child.kill('SIGINT');
  });
  assert.ok(sent, 'the signal was sent while after() waited; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup went on to its end');
  assert.match(r.out, /^release: SIGINT came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was$/m, 'the signal is reported');
  onceWithTheLock(r);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a second Ctrl+C, after a first one during a test started the cleanup, is reported and not obeyed: the data back, the lock released, exit code 130 (DM-248; the Delivery Manager\'s AT-H7)', async () => {
  let first = false;
  let second = false;
  const r = await runCase('run-second-signal', (out, child) => {
    if (!first && out.includes('IN TEST')) { first = true; child.kill('SIGINT'); return; }
    if (first && !second && out.includes('IN AFTER')) { second = true; child.kill('SIGINT'); }
  });
  assert.ok(first && second, 'both signals were sent; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup went on to its end');
  assert.match(r.out, /^release: SIGINT came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was$/m, 'the second signal is reported');
  onceWithTheLock(r);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('SIGTERM during a test and then SIGHUP during the cleanup, as a watcher\'s kill and a closed terminal send them, wait for the cleanup as well, and no test starts after the first (DM-248)', async () => {
  let term = false;
  let hup = false;
  const r = await runCase('run-term-then-hup', (out, child) => {
    if (!term && out.includes('IN TEST')) { term = true; child.kill('SIGTERM'); return; }
    if (term && !hup && out.includes('IN AFTER')) { hup = true; child.kill('SIGHUP'); }
  });
  assert.ok(term && hup, 'both signals were sent; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup went on to its end');
  assert.match(r.out, /^release: SIGHUP came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was$/m, 'the SIGHUP is reported');
  onceWithTheLock(r);
  assert.doesNotMatch(r.out, /TEST AFTER THE SIGNAL/, 'no test starts once a signal has come');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// PO-R8-1: the cleanup runs once. The Delivery Manager's AT-H9, adopted, with
// a second signal: with each caller running its own cleanup (PO3-DM248) the
// data still came back and every case above passed, but after() ran twice.
test('the cleanup runs once: a Ctrl+C while the run\'s own cleanup waits in after(), then a second one, start no cleanup of their own: after() is called once, every folder is put back once, both signals are reported and deferred, exit code 130 (PO-R8-1; the Delivery Manager\'s AT-H9)', async () => {
  const deferred = "release: SIGINT came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was";
  let first = false;
  let second = false;
  const r = await runCase('run-cleanup-once', (out, child) => {
    if (!first && out.includes('IN AFTER')) { first = true; child.kill('SIGINT'); return; }
    if (first && !second && out.split('\n').includes(deferred)) { second = true; child.kill('SIGINT'); }
  });
  assert.ok(first && second, 'both signals were sent while after() waited; the child\'s output:\n' + r.out);
  ended(r, 130);
  const lines = r.out.split('\n');
  assert.deepEqual(lines.filter((l) => /^AFTER CALL \d+$/.test(l)), ['AFTER CALL 1'], 'after() was called once; the child\'s output:\n' + r.out);
  assert.deepEqual(lines.filter((l) => /^AFTER DONE \d+$/.test(l)), ['AFTER DONE 1'], 'and went on to its end once');
  const putBack = lines.filter((l) => l.startsWith('PUT BACK ')).map((l) => l.slice('PUT BACK '.length)).sort();
  assert.deepEqual(putBack, r.dirs.map((d) => path.relative(r.home, d)).sort(), 'every folder was put back from the backup, once');
  assert.equal(lines.filter((l) => l === deferred).length, 2, 'both signals were reported and deferred');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// QA-01's observation 2 (its P3.8): a SIGQUIT during a test, as Ctrl+backslash
// sends it, ended the run by the signal itself, with the data aside and the
// lock left; it is handled now, as a Ctrl+C is.
test('a SIGQUIT (Ctrl+backslash) during a test is handled as a Ctrl+C is: the data back, the lock released, no later test, exit code 130 (QA-01\'s observation 2 and P3.8)', async () => {
  let sent = false;
  const r = await runCase('run-sigquit', (out, child) => { if (!sent && out.includes('IN TEST')) { sent = true; child.kill('SIGQUIT'); } });
  assert.ok(sent, 'the signal was sent during the test; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.doesNotMatch(r.out, /TEST AFTER THE SIGNAL/, 'no test starts after it');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// DM-249: after a Ctrl+C or a kill during a test, the test went on while the
// harness put everything back, and nothing stopped it from launching the app
// again: the Delivery Manager saw an app outlive the run and write into the
// restored folders, and remove the person's restored folder.txt, in 10 of 10
// runs each (AT-H8 and AT-H8c; AT-H8b is deterministic). They are adopted
// here with the answer the fix sets, AT-H8 and AT-H8c in three runs each, side
// by side (one lost run is enough to show the race, and the old harness lost
// 10 of 10): the relaunch is refused and no app outlives the run. Three more
// cases hold each part of the fix on its own, since either part alone hides
// the other's absence in AT-H8b: the refusal after a signal, the refusal
// during the run's own cleanup, and e2e.mjs's after() stopping a copy started
// by a way the refusal does not see.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// What became of the stand-ins a case started: the pids they recorded, those
// still running just after the run ended, and the files one wrote into the
// restored web data folder after it; then each is ended through endCasePid
// (DM-269), so none outlives the case.
async function standinsAfter(r) {
  await pause(400);   // a stand-in started at the very end records its pid once node is up
  const file = path.join(r.box, STANDIN_PIDS);
  const pids = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  const running = pids.filter((pid) => pid > 1 && isAlive(pid));
  await pause(1800);   // a stand-in writes 1.5 s after it starts
  const web = path.join(r.home, 'Library', 'WebKit', 'plain-sight');
  const wrote = existsSync(web) ? readdirSync(web).filter((name) => name.startsWith('written-by-')) : [];
  for (const pid of pids) endCasePid(pid, [r.box], 'the stand-in app\'s pid ' + pid + ' in ' + file);
  return { pids, running, wrote };
}
const refusedFor = (signal) => new RegExp('was not launched: the run is ending \\(' + (signal ? signal + ' came' : 'its cleanup has begun') + '\\), so nothing may start again \\(DM-249\\)');
test('a Ctrl+C while a test waits, whose next step launches the app again, leaves no app running after the run: the relaunch is refused and the test stops as not run, exit code 130, the data back (DM-249; the Delivery Manager\'s AT-H8b, with the answer the fix sets)', async () => {
  let sent = false;
  const r = await runCase('run-relaunch-waiting', (out, child) => { if (!sent && out.includes('WAITING')) { sent = true; child.kill('SIGINT'); } });
  const s = await standinsAfter(r);
  assert.ok(sent, 'the signal was sent while the test waited; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.ok(r.out.includes('stop - a test that launches the app again after a wait ('), 'the test stopped as not run; the child\'s output:\n' + r.out);
  assert.match(r.out, refusedFor('SIGINT'), 'the relaunch was refused, naming the signal');
  assert.doesNotMatch(r.out, /^RELAUNCHED /m, 'no app was launched again');
  assert.equal(s.pids.length, 1, 'one app was started, before the signal: ' + JSON.stringify(s.pids));
  assert.deepEqual(s.running, [], 'no app outlives the run');
  assert.deepEqual(s.wrote, [], 'nothing was written into the restored web data folder after the run');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a Ctrl+C while a test stops the app before launching it again (e2e.mjs\'s own shape) leaves no app running after the run, in each of three runs: exit code 130, the data back, nothing written after the run (DM-249; the Delivery Manager\'s AT-H8, with the answer the fix sets)', async () => {
  const runs = await Promise.all([1, 2, 3].map(async (n) => {
    let sent = false;
    const r = await runCase('run-relaunch-stopping', (out, child) => { if (!sent && out.includes('STOPPING')) { sent = true; child.kill('SIGINT'); } }, { tag: 'run-relaunch-stopping-' + n });
    return { n, sent, r, s: await standinsAfter(r) };
  }));
  for (const { n, sent, r, s } of runs) {
    assert.ok(sent, 'run ' + n + ': the signal was sent while the test stopped the app; the child\'s output:\n' + r.out);
    ended(r, 130);
    assert.doesNotMatch(r.out, /^RELAUNCHED /m, 'run ' + n + ': no app was launched again; the child\'s output:\n' + r.out);
    assert.equal(s.pids.length, 1, 'run ' + n + ': one app was started, before the signal: ' + JSON.stringify(s.pids));
    assert.deepEqual(s.running, [], 'run ' + n + ': no app outlives the run');
    assert.deepEqual(s.wrote, [], 'run ' + n + ': nothing was written into the restored web data folder after the run');
    clean(r);
    assert.equal(r.lock, false, 'run ' + n + ': the lock is released');
  }
});
test('a Ctrl+C while a test restarts the app leaves the person\'s 1.0.0 folder choice, folder.txt, in place a few seconds after the run, in each of three runs: no app outlives the run to remove it (DM-249; the Delivery Manager\'s AT-H8c, with the answer the fix sets)', async () => {
  const runs = await Promise.all([1, 2, 3].map(async (n) => {
    let sent = false;
    const r = await runCase('run-relaunch-folder', (out, child) => { if (!sent && out.includes('STOPPING')) { sent = true; child.kill('SIGINT'); } }, { tag: 'run-relaunch-folder-' + n });
    const folderTxt = path.join(r.home, 'Library', 'Application Support', 'com.pranavongole.plainsight', 'folder.txt');
    const atExit = existsSync(folderTxt);
    const s = await standinsAfter(r);
    return { n, sent, r, s, atExit, later: existsSync(folderTxt) ? readFileSync(folderTxt, 'utf8') : null };
  }));
  for (const { n, sent, r, s, atExit, later } of runs) {
    assert.ok(sent, 'run ' + n + ': the signal was sent while the test stopped the app; the child\'s output:\n' + r.out);
    ended(r, 130);
    assert.equal(atExit, true, 'run ' + n + ': folder.txt is back when the run ends');
    assert.equal(later, '/Users/someone/Notes', 'run ' + n + ': and still there, as it was, a few seconds later');
    assert.doesNotMatch(r.out, /^RELAUNCHED /m, 'run ' + n + ': no app was launched again; the child\'s output:\n' + r.out);
    assert.equal(s.pids.length, 1, 'run ' + n + ': one app was started, before the signal: ' + JSON.stringify(s.pids));
    assert.deepEqual(s.running, [], 'run ' + n + ': no app outlives the run');
    clean(r);
  }
});
test('a launch that a test asks for once the cleanup after a signal has stopped the app is refused, so no app is left that after() cannot stop: the test stops as not run, exit code 130 (DM-249)', async () => {
  let sent = false;
  const r = await runCase('run-launch-after-signal', (out, child) => { if (!sent && out.includes('IN TEST')) { sent = true; child.kill('SIGINT'); } });
  const s = await standinsAfter(r);
  assert.ok(sent, 'the signal was sent during the test; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup\'s after() ended first');
  assert.ok(r.out.split('\n').some((line) => line.startsWith('REFUSED ') && refusedFor('SIGINT').test(line)), 'the launch was refused, naming the signal; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /^LAUNCHED AGAIN /m, 'no app was launched again');
  assert.equal(s.pids.length, 1, 'one app was started, before the signal: ' + JSON.stringify(s.pids));
  assert.deepEqual(s.running, [], 'no app outlives the run');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a launch asked for during the run\'s own cleanup, with no signal at all, is refused too, so no app outlives a run that ends by its own count (DM-249)', async () => {
  const r = await runCase('run-launch-in-own-cleanup');
  const s = await standinsAfter(r);
  ended(r, 0);
  assert.ok(r.out.split('\n').some((line) => line.startsWith('REFUSED ') && refusedFor(null).test(line)), 'the launch was refused, naming the cleanup; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /^LAUNCHED AGAIN /m, 'no app was launched again');
  assert.equal(s.pids.length, 1, 'one app was started, by the test: ' + JSON.stringify(s.pids));
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m);
  assert.deepEqual(s.running, [], 'no app outlives the run');
  clean(r);
});
test('e2e.mjs\'s after() stops the app that is current when each stop ends: a copy started by a way the refusal does not see, while the cleanup stops the first, is stopped too, exit code 130 (DM-249)', async () => {
  let sent = false;
  const r = await runCase('run-late-app-stopped', (out, child) => { if (!sent && out.includes('IN TEST')) { sent = true; child.kill('SIGINT'); } });
  const s = await standinsAfter(r);
  assert.ok(sent, 'the signal was sent during the test; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^STARTED ANOTHER \d+$/m, 'the second copy was started while the cleanup stopped the first; the child\'s output:\n' + r.out);
  assert.equal(s.pids.length, 2, 'two copies were started: ' + JSON.stringify(s.pids));
  assert.deepEqual(s.running, [], 'neither outlives the run');
  clean(r);
});

// DISH-G-85 and QA-G-45 (N12): QA-01's E1 (r9_suite_adv.mjs, group E),
// adopted: e2e.mjs's own launch() and after(), in six variants that send the
// signal once the app has recorded its pid: SIGINT, SIGQUIT and SIGHUP 300 ms
// into the wait for the first window, SIGTERM 1.5 s into it, SIGINT at once,
// and SIGINT 300 ms into the wait for the probe's answer. With app set only
// after the window wait (QA-01's N12) or after both waits (DISH's N17), the
// app was outside after()'s sight and outlived the run.
test('e2e.mjs\'s own launch() records the app before its waits, so a signal during the wait for the first window or for the probe stops it: exit code 130, the app ended, nothing written after the run, the data back, in each of six variants (DISH-G-85, QA-G-45; QA-01\'s E1)', async () => {
  const variants = [
    ['e2e-first-window-wait', 'SIGINT', 300], ['e2e-first-window-wait', 'SIGQUIT', 300], ['e2e-first-window-wait', 'SIGHUP', 300],
    ['e2e-first-window-wait', 'SIGTERM', 1500], ['e2e-first-window-wait', 'SIGINT', 0], ['e2e-probe-wait', 'SIGINT', 300]
  ];
  const runs = await Promise.all(variants.map(async ([id, signal, delay], n) => {
    let sent = false;
    let poll = null;
    const r = await runCase(id, (out, child, box) => {
      if (poll) return;
      poll = setInterval(() => {
        const file = path.join(box, STANDIN_PIDS);
        if (sent || !existsSync(file) || !readFileSync(file, 'utf8').trim()) return;
        sent = true;
        clearInterval(poll);
        setTimeout(() => child.kill(signal), delay);
      }, 20);
    }, { tag: 'e2e-' + n });
    clearInterval(poll);
    return { what: id + ', ' + signal + ' ' + delay + ' ms after the pid', sent, r, s: await standinsAfter(r) };
  }));
  for (const { what, sent, r, s } of runs) {
    assert.ok(sent, what + ': the signal was sent once the app had recorded its pid; the child\'s output:\n' + r.out);
    ended(r, 130);
    assert.equal(s.pids.length, 1, what + ': one app was started: ' + JSON.stringify(s.pids));
    assert.deepEqual(s.running, [], what + ': after() stopped it, so no app outlives the run');
    assert.deepEqual(s.wrote, [], what + ': nothing was written into the restored web data folder after the run');
    clean(r);
    assert.equal(r.lock, false, what + ': the lock is released');
  }
});

// Round 11, e2e-run-4's show step: in e2e-run-4 (a92087a, 28 October 2026)
// the hidden-document test's page stayed hidden for the whole 5 s wait after
// the hook's show, and run.log said nothing of the window. Here e2e.mjs's own
// test runs under a fake of the hook: when the show leaves the page hidden,
// the test fails with that timeout, never passes, and run.log holds the
// window's state at the timeout (the hook's windowState and the driver's
// front app); when the show brings the page back, it passes. Both runs hold
// the record made with the page visible, before the minimize.
const HIDDEN_TEST = 'a minimized window and a hidden app give the page a hidden document, which is what starts its ten-minute wipe';
const runLog = (tag) => readFileSync(path.join(ROOT, tag, 'evidence', 'run.log'), 'utf8');
const BEFORE_RECORD = ' window state with the page visible, before the minimize (evidence only, never a pass): hook {"fakeHook":true,"occlusionVisible":true,"appActive":true,"appHidden":false}; front app {"pid":4243,"thisApp":false}; driver could not be read: ';
test('e2e.mjs\'s hidden-document test, its show leaving the page hidden as in e2e-run-4: it fails with the 5 s timeout, is never counted as passed, and run.log holds the window\'s state at the timeout and before the minimize (round 11, e2e-run-4\'s show step)', async () => {
  const r = await runCase('e2e-show-stays-hidden');
  ended(r, 1);
  assert.ok(r.out.split('\n').includes('FAIL - ' + HIDDEN_TEST), 'the test fails; the child\'s output:\n' + r.out);
  assert.match(r.out, /^ {7}Error: timed out after 5000 ms waiting for a visible page after show$/m, 'with the timeout of its show step');
  assert.match(r.out, /^0 passed, 1 failed, 0 not run, 1 total\. Errors: 1$/m, 'counted as failed, not as passed or not run');
  const log = runLog('e2e-show-stays-hidden');
  assert.match(log, / probe \{"window":"show"\} -> \{"ok":true\}$/m, 'the test asked the hook for its show; run.log:\n' + log);
  const at = log.split('\n').filter((l) => l.includes(' window state at the timeout waiting for a visible page after show (evidence only, never a pass): '));
  assert.equal(at.length, 1, 'one record at the timeout; run.log:\n' + log);
  assert.ok(at[0].includes(' hook {"fakeHook":true,"occlusionVisible":false,"appActive":false,"appHidden":false}; front app {"pid":4243,"thisApp":false}; driver could not be read: '), 'the hook\'s window state and the front app: ' + at[0]);
  assert.ok(log.includes(BEFORE_RECORD), 'and the record before the minimize; run.log:\n' + log);
  assert.ok(log.indexOf(at[0]) > log.lastIndexOf(' probe {"window":"show"}'), 'the record at the timeout comes after the show');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('e2e.mjs\'s hidden-document test, its show bringing the page back: it passes, with the record before the minimize and none at a timeout (round 11, the control)', async () => {
  const r = await runCase('e2e-show-returns');
  ended(r, 0);
  assert.ok(r.out.split('\n').includes('ok   - ' + HIDDEN_TEST), 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m);
  const log = runLog('e2e-show-returns');
  assert.ok(log.includes(BEFORE_RECORD), 'the record before the minimize; run.log:\n' + log);
  assert.ok(!log.includes(' window state at the timeout '), 'no record at a timeout; run.log:\n' + log);
  clean(r);
});
// PO-R11-1 (round 12): the Product Owner's break PO2-TOUCH-EVID took the
// rethrow out of windowEvidence's read helper and every case passed, so
// nothing held that a person at the keyboard still stops the run while the
// window's state is read: the touch would have been noted as a part not read
// and the test counted as failed. The stays-hidden show again, with the
// driver's stand-in finding the Mac just used once the hook has given the
// timeout's window state.
test('a person who touches the Mac while e2e.mjs reads the window\'s state at the hidden-document test\'s timeout stops the run as a touch: exit code 3, the test not counted as failed, the data back and the restore check clean (PO-R11-1)', async () => {
  const r = await runCase('e2e-touch-at-evidence');
  ended(r, 3);
  assert.ok(r.out.split('\n').some((l) => l.startsWith('stop - ' + HIDDEN_TEST + ' (keyboard or mouse used during the run (idle ')), 'the test stopped for the touch; the child\'s output:\n' + r.out);
  assert.ok(!r.out.split('\n').includes('FAIL - ' + HIDDEN_TEST), 'and was not counted as failed');
  assert.match(r.out, /^0 passed, 0 failed, 1 not run, 1 total\. Errors: 0$/m);
  assert.match(r.out, /^Exit code: 3$/m);
  assert.match(r.out, checkedLine, 'the restore check is clean');
  const log = runLog('e2e-touch-at-evidence');
  assert.equal(log.split('\n').filter((l) => l.includes(' probe {"windowState":true} -> ')).length, 2, 'the window\'s state was read before the minimize and at the timeout; run.log:\n' + log);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// DM-249's launched half (round 10). The Delivery Manager's check of a
// launched run is a deliberate end-to-end run that gets kill -INT while a
// test waits in stopApp() before a relaunch, then: the refusal line, exit
// code 130, no app left, appdata-backup empty, no lock, and the person's
// folder.txt as it was. The Product Owner must never read the person's data,
// so the harness checks the restore itself (checkRestore): it lists every
// folder it moves aside (every file's path, size and modification time and
// every folder's path; nothing is opened; a folder it cannot list then is
// named in the clean line and not checked),
// lists them again after the restore, at once and 3 s later, and looks for a
// launched app still running. These cases hold each part, under the fake home.
const restoredLine = (n) => new RegExp('^restore check: ' + n + ' folders as they were \\(names, and sizes and times of files; checked twice, 3 s apart\\)$', 'm');
test('the Delivery Manager\'s launched check, here under the fake home: stopApp() notes "stopping pid <n>" in run.log first, a SIGINT sent on that line refuses the relaunch, and the run ends with 130, no app left, the backup empty, the lock released, folder.txt as it was and the restore check clean (DM-249)', async () => {
  let sent = 0;
  let poll = null;
  const r = await runCase('run-relaunch-folder', (out, child, box) => {
    if (poll) return;
    poll = setInterval(() => {
      const log = path.join(box, 'evidence', 'run.log');
      const m = existsSync(log) && readFileSync(log, 'utf8').match(/ stopping pid (\d+)$/m);
      if (!m || sent) return;
      sent = Number(m[1]);
      clearInterval(poll);
      child.kill('SIGINT');
    }, 20);
  }, { tag: 'run-driver-protocol', recheck: null });
  clearInterval(poll);
  const folderTxt = path.join(r.home, 'Library', 'Application Support', 'com.pranavongole.plainsight', 'folder.txt');
  const later = existsSync(folderTxt) ? readFileSync(folderTxt, 'utf8') : null;
  const s = await standinsAfter(r);
  assert.ok(sent > 0, 'run.log named the pid being stopped and the signal was sent on that line; the child\'s output:\n' + r.out);
  assert.deepEqual(s.pids, [sent], 'the pid run.log named is the app the test started, the only one');
  ended(r, 130);
  assert.ok(r.out.split('\n').some((line) => line.startsWith('stop - a test that restarts the app, as e2e.mjs does (') && refusedFor('SIGINT').test(line)), 'the refusal line; the child\'s output:\n' + r.out);
  assert.deepEqual(s.running, [], 'no app is left');
  assert.equal(later, '/Users/someone/Notes', 'folder.txt is as it was');
  assert.match(r.out, restoredLine(r.dirs.length), 'the restore check is clean');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('the restore check: a run that puts the person\'s data back as it was says so in one line before its summary, with the number of folders it moved aside (DM-249)', async () => {
  const r = await runCase('run-restore-clean', undefined, { recheck: null });
  ended(r, 0);
  const lines = r.out.split('\n');
  const at = lines.findIndex((l) => restoredLine(r.dirs.length).test(l));
  assert.ok(at >= 0, 'the clean line, with ' + r.dirs.length + ' folders; the child\'s output:\n' + r.out);
  assert.ok(at < lines.findIndex((l) => /^\d+ passed, \d+ failed, /.test(l)), 'before the summary');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m);
  assert.equal(readFileSync(path.join(r.dirs[1], 'notes', 'today.txt'), 'utf8'), 'THE PERSON\'S NOTES', 'the nested file is back');
  clean(r);
});
test('a file of the person\'s changed 1 s after the restore, by a writer the run never launched, is caught by the second look 3 s later: exit code 6, its path named (DM-249)', async () => {
  const r = await runCase('run-restore-late-change', undefined, { recheck: null });
  ended(r, 6);
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(path.join(r.dirs[0], 'notes.txt')) + ' \\(changed\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /as they were \(names/, 'no clean line');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.deepEqual(r.backups, [], 'the data was put back, then changed: no backup is left');
  assert.equal(r.lock, false, 'the lock is released');
});
// PO-R10-1 (round 11): the Product Owner's break PO1-RESTORE, the listing
// without modification times (st.size + ' bytes'), passed every case here,
// since each late change grew the file. A late writer that rewrites a file at
// the same size, or writes the same bytes again, changes only what the
// listing's time holds, and the check exists to catch a late writer.
const lateSameSize = async (id, check) => {
  const r = await runCase(id, undefined, { recheck: null });
  ended(r, 6);
  const notes = path.join(r.dirs[0], 'notes.txt');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(notes) + ' \\(changed\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /as they were \(names/, 'no clean line');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.deepEqual(r.backups, [], 'the data was put back, then changed: no backup is left');
  assert.equal(r.lock, false, 'the lock is released');
  check(notes);
};
test('a file of the person\'s rewritten 1 s after the restore with other bytes of the same length is caught by the second look: exit code 6, its path named (changed) (PO-R10-1)', async () => {
  await lateSameSize('run-restore-late-same-size', (notes) => {
    assert.equal(readFileSync(notes, 'utf8'), 'x'.repeat('THE PERSON\'S NOTES'.length), 'the writer kept the size and changed the bytes');
  });
});
test('a file of the person\'s written again 1 s after the restore with the same bytes, only its modification time new, is caught too: exit code 6, its path named (changed) (PO-R10-1)', async () => {
  await lateSameSize('run-restore-late-same-bytes', (notes) => {
    assert.equal(readFileSync(notes, 'utf8'), 'THE PERSON\'S NOTES', 'the bytes are as they were');
    const st = fs.statSync(notes);
    assert.ok(st.mtimeMs - st.birthtimeMs >= 900, 'and the file was written again after the restore: modified ' + Math.round(st.mtimeMs - st.birthtimeMs) + ' ms after it was made');
  });
});
// DM-257 (round 11): four parts of the restore check passed all 53 safety
// cases when broken (the Delivery Manager's RC1, RC2, RC3 and RC7, its
// delta of 46d6f62). RC1, the time comparison, is held by PO-R10-1's two
// cases above. The walk into subfolders, the report of new entries and the
// naming of a folder not listed when moved aside are held here by its
// AT-R3, AT-R4 and AT-R7, adopted (adv/tests/desktop/tests/
// dm-harness-adv-46.mjs), and a data folder that can no longer be listed
// after the restore, which no case reached either, by a fourth.
const unseal = (r) => { const sealed = (r.out.match(/^SEALED (.*)$/m) || [])[1]; if (sealed && existsSync(sealed)) chmodSync(sealed, 0o755); };
test('a file of the person\'s two folders deep, where WebKit keeps the vault record, rewritten at the same size 1 s after the restore is caught: exit code 6, the nested path named (changed) (DM-257; the Delivery Manager\'s AT-R3)', async () => {
  const r = await runCase('run-restore-late-nested', undefined, { recheck: null });
  ended(r, 6);
  const nested = path.join(r.dirs[0], 'WebsiteData', 'LocalStorage', 'tauri_localhost_0.localstorage');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(nested) + ' \\(changed\\)', 'm'), 'the nested path is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(readFileSync(nested, 'utf8'), 'x'.repeat('VAULT RECORD 0123456789'.length), 'the writer kept the size and changed the bytes');
});
test('a new file written into a folder the run put back, 1 s after the restore, is caught: exit code 6, its path named (new) (DM-257; the Delivery Manager\'s AT-R4)', async () => {
  const r = await runCase('run-restore-late-new-file', undefined, { recheck: null });
  ended(r, 6);
  const made = path.join(r.dirs[1], 'written-after-the-restore');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(made) + ' \\(new\\)', 'm'), 'the new path is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.ok(existsSync(made), 'the writer made the file after the restore');
});
test('a data folder that holds a folder no one may list (mode 000) cannot be listed when it is moved aside: the clean line counts one folder fewer and names it as not checked (EACCES), exit code 0 (DM-257; the Delivery Manager\'s AT-R7)', async () => {
  const r = await runCase('run-restore-unlisted', undefined, { recheck: null });
  try {
    ended(r, 0);
    const line = r.out.split('\n').find((l) => l.startsWith('restore check')) || '';
    assert.equal(line, 'restore check: ' + (r.dirs.length - 1) + ' folders as they were (names, and sizes and times of files; checked twice, 3 s apart); not listed when moved aside, so not checked: ' + r.dirs[1] + ' (EACCES)', 'the child\'s output:\n' + r.out);
  } finally {
    unseal(r);
  }
});
test('a data folder that can no longer be listed after the restore (a folder in it sealed, mode 000, 1 s after the restore) is named: exit code 6, "could not be listed after the restore: EACCES" (DM-257)', async () => {
  const r = await runCase('run-restore-unlistable-after', undefined, { recheck: null });
  try {
    ended(r, 6);
    assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(r.dirs[1]) + ' \\(could not be listed after the restore: EACCES\\)', 'm'), 'the folder is named; the child\'s output:\n' + r.out);
    assert.match(r.out, /^Exit code: 6$/m);
  } finally {
    unseal(r);
  }
});
test('the person\'s folder.txt removed 1 s after the restore, as a launch of this branch\'s build removes it, is caught: exit code 6, its path named (DM-249, the shape of the Delivery Manager\'s AT-H8c)', async () => {
  const r = await runCase('run-restore-late-remove', undefined, { recheck: null });
  ended(r, 6);
  const folderTxt = path.join(r.home, 'Library', 'Application Support', 'com.pranavongole.plainsight', 'folder.txt');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(folderTxt) + ' \\(gone\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(r.lock, false, 'the lock is released');
});
test('the check runs on a signal\'s cleanup too: a late change after a Ctrl+C during a test ends the run with 6, not 130, its path named (DM-249)', async () => {
  let sent = false;
  const r = await runCase('run-restore-late-change-signal', (out, child) => { if (!sent && out.includes('IN TEST')) { sent = true; child.kill('SIGINT'); } }, { recheck: null });
  assert.ok(sent, 'the signal was sent during the test; the child\'s output:\n' + r.out);
  ended(r, 6);
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(path.join(r.dirs[0], 'notes.txt')) + ' \\(changed\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.deepEqual(r.backups, [], 'no backup is left');
  assert.equal(r.lock, false, 'the lock is released');
});
// DISH-G-93 (round 12): a signal that comes while the run's own cleanup waits
// in after() is reported and waits for that cleanup, and the run then ends by
// run()'s own line, `if (signalled) process.exit(restored ? 130 : 6)`. No case
// sent a signal there with the data not back as it was, so DISH's H9 (that
// line made exit 130) passed every case: a late change to the person's data
// would have ended the run with 130, the signal's code, and read as clean.
test('a SIGINT while the run\'s own cleanup waits in after(), with a file of the person\'s changed 1 s after the restore, ends the run with 6, not 130: the changed path named in the restore check\'s line, no clean line (DISH-G-93)', async () => {
  let sent = false;
  const r = await runCase('run-late-change-in-after', (out, child) => { if (!sent && out.includes('IN AFTER')) { sent = true; child.kill('SIGINT'); } }, { recheck: null });
  assert.ok(sent, 'the signal was sent while after() waited; the child\'s output:\n' + r.out);
  ended(r, 6);
  assert.match(r.out, /^release: SIGINT came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was$/m, 'the signal is reported, in words that hold for this run, which ends with 6 (round 13)');
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup went on to its end');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(path.join(r.dirs[0], 'notes.txt')) + ' \\(changed\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /as they were \(names/, 'no clean line');
  assert.deepEqual(r.backups, [], 'the data was put back, then changed: no backup is left');
  assert.equal(r.lock, false, 'the lock is released');
});

// QA-G-46 (round 12): twelve of QA-01's breaks of the restore check (R1, R2,
// R3, R5, R6, R7, R8, R14, R15, R16, R18 and R19 of its r10_mutate_new.py)
// passed every candidate suite at 46d6f62. On 4c5cc55 round 11's cases turn
// R1, R3, R5 and R8 red, and on this round's code DISH-G-93's case above
// turns R14 red; the cases below, adopted from its r10_restore_adv.mjs
// (groups A, L and P), hold the size (R2), a data folder gone after the
// restore (R6), hidden entries (R7), the lock through the second look (R15),
// the note for an app already ended (R16) and exit 6 over 3 (R19).
test('a file of the person\'s grown 1 s after the restore, its modification time put back to the nanosecond, is caught by its size: exit code 6, its path named (changed) (QA-G-46, R2; QA-01\'s A.size-mtime-kept)', async () => {
  const r = await runCase('run-late-grow-same-time', undefined, { recheck: null });
  ended(r, 6);
  const notes = path.join(r.dirs[0], 'notes.txt');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(notes) + ' \\(changed\\)', 'm'), 'the path is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(readFileSync(notes, 'utf8'), 'THE PERSON\'S NOTES MORE', 'the writer grew the file');
  assert.equal(String(fs.statSync(notes, { bigint: true }).mtimeNs), (r.out.match(/^MTIME (\d+)$/m) || [])[1], 'and put its modification time back to the nanosecond, so only its size differs');
});
test('a data folder the run put back, removed whole 1 s after the restore, is caught: exit code 6, the folder named (gone) (QA-G-46, R6; QA-01\'s A.remove-top)', async () => {
  const r = await runCase('run-late-folder-removed', undefined, { recheck: null });
  ended(r, 6);
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(r.dirs[1]) + ' \\(gone\\)', 'm'), 'the folder is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(existsSync(r.dirs[1]), false, 'the writer removed it');
});
test('a hidden file written into a folder the run put back, 1 s after the restore, is caught: exit code 6, its path named (new) (QA-G-46, R7; QA-01\'s A.hidden)', async () => {
  const r = await runCase('run-late-hidden-file', undefined, { recheck: null });
  ended(r, 6);
  const hidden = path.join(r.dirs[1], '.late-hidden');
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(hidden) + ' \\(new\\)', 'm'), 'the hidden path is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  assert.ok(existsSync(hidden), 'the writer made it');
});
test('a run the person stopped, whose data a late writer changed 1 s after the restore, ends with 6, not 3: the person\'s data first, the path named and the stop reported (QA-G-46, R19; QA-01\'s L7)', async () => {
  const r = await runCase('run-late-change-stopped', undefined, { recheck: null });
  ended(r, 6);
  assert.ok(r.out.split('\n').includes('stop - a test the person interrupts, with a late writer behind (keyboard or mouse used during the run (idle 0.0 s))'), 'the stop is reported; the child\'s output:\n' + r.out);
  assert.match(r.out, new RegExp('^restore check: not as it was before the run: (.*; )?' + esc(path.join(r.dirs[0], 'notes.txt')) + ' \\(changed\\)', 'm'), 'the path is named');
  assert.match(r.out, /^0 passed, 0 failed, 1 not run, 1 total\. Errors: 1$/m);
  assert.match(r.out, /^Exit code: 6$/m);
});
// QA-01's L6: a second run in the fake home of a case under way, which seeds
// nothing and only asks run() to start, with an evidence folder of its own.
const secondRun = (box) => new Promise((resolve) => {
  const env = { ...process.env, HOME: path.join(box, 'home'), TMPDIR: path.join(box, 'tmp'), PLAIN_SIGHT_EVIDENCE: path.join(box, 'evidence-second'), [BOX]: box };
  for (const name of ['PLAIN_SIGHT_E2E_DOWNLOADS', 'PLAIN_SIGHT_APP', 'PLAIN_SIGHT_IDLE_MIN', 'PLAIN_SIGHT_ONLY', 'PLAIN_SIGHT_ALLOW_REAL_ID']) delete env[name];
  const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', 'second-run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => c.kill('SIGKILL'), 60000);
  c.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
});
test('the run holds its lock through the restore check\'s second look: a second run started half a second after the restore is refused with exit code 5, and the first ends clean (QA-G-46, R15; QA-01\'s L6)', async () => {
  let second = null;
  let poll = null;
  const r = await runCase('run-held-through-check', (out, child, box) => {
    if (poll) return;
    let seen = false;
    poll = setInterval(() => {
      const there = existsSync(BACKUP_ROOT(path.join(box, 'home')));
      if (there) seen = true;
      if (!seen || there) return;
      clearInterval(poll);
      setTimeout(() => { second = secondRun(box); }, 500);
    }, 10);
  }, { recheck: null });
  clearInterval(poll);
  assert.ok(second, 'the second run was started after the restore; the child\'s output:\n' + r.out);
  const s = await second;
  ended(r, 0);
  assert.match(r.out, restoredLine(r.dirs.length), 'the first run\'s check is clean; its output:\n' + r.out);
  assert.equal(s.code, 5, 'the second run ended with 5; its output:\n' + s.out);
  assert.match(s.out, /^second: not started: another GUI test run holds /m, 'refused for the lock');
  assert.doesNotMatch(s.out, /SECOND RAN/, 'its test never ran');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released at the end');
});
test('stopApp notes "stopping pid <n>" for an app that has already ended too, so a driver\'s signal still lands where a test stops its app (QA-G-46, R16; QA-01\'s P.source, as behaviour)', async () => {
  const r = await runCase('stop-ended-app');
  ended(r, 0);
  const [, pid, ms] = r.out.match(/^STOPPED (\d+) after (\d+) ms$/m) || [];
  assert.ok(pid, 'stopApp returned; the child\'s output:\n' + r.out);
  assert.ok(Number(ms) < 1000, 'at once: ' + ms + ' ms');
  const log = runLog('stop-ended-app');
  assert.ok(log.includes(' stopping pid ' + pid + '\n'), 'run.log names the pid; run.log:\n' + log);
});
test('an app the run launched and nothing stopped is named by its pid after the restore: exit code 6 (DM-249)', async () => {
  const r = await runCase('run-restore-live-app', undefined, { recheck: null });
  const s = await standinsAfter(r);
  ended(r, 6);
  const pid = Number((r.out.match(/^LEFT RUNNING (\d+)$/m) || [])[1]);
  assert.ok(pid > 0 && s.pids.includes(pid), 'the test left an app running; the child\'s output:\n' + r.out);
  assert.ok(r.out.split('\n').includes('restore check: still running, though this run launched it: pid ' + pid + ' (' + STANDIN_EXE + ')'), 'it is named; the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 6$/m);
  clean(r);
});

// Round 12, the reused pid (Developer N's round 11 observation, a data-safety
// path by the Product Owner's rating): stopCurrentApp waited while
// process.kill(pid, 0) answered, and stopApp signalled through child.kill,
// which sends nothing once Node has seen the child end; macOS hands pids out
// again, out of order, so an app whose pid another program had taken held the
// cleanup, with the person's data aside and the lock held, for as long as
// that program lived (19,772 ms in round 11's check). A copy recorded through
// LaunchServices was judged by its pid alone as well, so a pid another
// program had taken read as a copy still running, a false exit 6 (QA-01's
// observation 9). The pid holder stands for the program macOS gave the pid
// to; each case ends it by its pid, through endCasePid (DM-269, round 21;
// until round 20 by the file it records signals in, with pkill -9 -f).
const holdersOf = (r) => [...r.out.matchAll(/^(HOLDER|COPY|OTHER|BYSTANDER) (\d+) (\S+)$/gm)].map((m) => ({ kind: m[1], pid: Number(m[2]), file: m[3] }));
const endHolders = (r) => { for (const { kind, pid, file } of holdersOf(r)) endCasePid(pid, [r.box], 'the line "' + kind + ' ' + pid + ' ' + file + '"'); };
// DM-269 (round 21): the proof case's stand-ins (its OUTSIDE and SECOND
// lines), which the case ends itself: one still running once the case has
// ended is ended by its pid, through endCasePid, in the case's second folder
// alone; a case without that folder has none, and such a line from it is
// refused.
const endOutsideStandIns = (r) => {
  for (const m of r.out.matchAll(/^(?:OUTSIDE (\d+) .+|SECOND (\d+) \S+ .+)$/gm)) {
    const pid = Number(m[1] || m[2]);
    if (r.outsideDir) endCasePid(pid, [r.outsideDir], 'the line "' + m[0] + '"');
    else refuseParent('the line "' + m[0] + '": the case has no second folder');
  }
};
// DM-269: what a case may have left running, at the end of the run: its pid
// holders, its proof stand-ins, and the pids in its stand-in and late-writer
// pid files, each through endCasePid.
const endLeftovers = (r) => {
  endHolders(r);
  endOutsideStandIns(r);
  for (const name of [STANDIN_PIDS, LATE_PIDS]) {
    const file = path.join(r.box, name);
    for (const pid of existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []) endCasePid(Number(pid), [r.box], 'the pid ' + pid + ' in ' + file);
  }
};
const stopCurrentLine = (r) => (r.out.match(/^STOP CURRENT (.*) after (\d+) ms; current\(\) asked (\d+) time\(s\)$/m) || []).slice(1);
const otherProgramNote = (pid) => ' pid ' + pid + ' now runs another program: not stopped';
const neitherWaitedOnNorSignalled = (r, tag, holder) => {
  const [how, ms] = stopCurrentLine(r);
  assert.equal(how, 'returned', 'stopCurrentApp returned; the child\'s output:\n' + r.out);
  assert.ok(Number(ms) < 2000, 'within 2 s: ' + ms + ' ms');
  const log = runLog(tag);
  assert.ok(log.includes(otherProgramNote(holder.pid) + '\n'), 'run.log says the pid now runs another program; run.log:\n' + log);
  assert.ok(!log.includes(' stopping pid ' + holder.pid + '\n'), 'no stop was tried on that pid; run.log:\n' + log);
  assert.match(r.out, /^ALIVE false$/m, 'alive() does not take the other program for the app');
  const wait = r.out.match(/^WAIT (\S+) after (\d+) ms$/m) || [];
  assert.ok(wait[1] === 'returned' && Number(wait[2]) < 1000, 'a wait for the app to end ends at once: ' + wait[0]);
  assert.match(r.out, /^SIGNALS none$/m, 'the other program got no signal');
  assert.match(r.out, /^STILL RUNS true$/m, 'and still runs');
};
test('an app whose child has ended while another program holds its pid is neither waited on nor signalled: stopCurrentApp returns within 2 s, a wait for the app ends at once, the other program gets no signal and still runs, and run.log says the pid now runs another program (round 12, the reused pid)', async () => {
  const r = await runCase('pid-reused-child', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [holder] = holdersOf(r);
    assert.ok(holder && holder.kind === 'HOLDER', 'the pid holder started; the child\'s output:\n' + r.out);
    neitherWaitedOnNorSignalled(r, 'pid-reused-child', holder);
  } finally {
    endHolders(r);
  }
});
test('the same for a copy recorded through LaunchServices, as app.mjs and release.mjs record one: a pid that now runs another program than the copy\'s executable is neither waited on nor signalled (round 12, the reused pid)', async () => {
  const r = await runCase('pid-reused-copy', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [holder] = holdersOf(r);
    assert.ok(holder && holder.kind === 'HOLDER', 'the pid holder started; the child\'s output:\n' + r.out);
    neitherWaitedOnNorSignalled(r, 'pid-reused-copy', holder);
  } finally {
    endHolders(r);
  }
});
// PO-R12-1 (round 13): the Product Owner's PO4-EXE-SUFFIX, a copy taken to
// be any program whose path ends in /plain-sight, passed every case: no pid
// holder was another Plain Sight, such as the person's own app in
// /Applications or another test copy, which must never be taken for the
// run's copy and signalled.
test('another Plain Sight holding a recorded copy\'s pid (a program at another bundle\'s .../Contents/MacOS/plain-sight) is neither waited on nor signalled: stopCurrentApp returns within 2 s, the holder gets no signal and still runs, and run.log says the pid now runs another program (PO-R12-1)', async () => {
  const r = await runCase('pid-reused-other-copy', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [holder] = holdersOf(r);
    assert.ok(holder && holder.kind === 'OTHER', 'the other Plain Sight started; the child\'s output:\n' + r.out);
    neitherWaitedOnNorSignalled(r, 'pid-reused-other-copy', holder);
  } finally {
    endHolders(r);
  }
});
// QA-G-49 (round 13): QA-01's breaks of the comparison, a copy taken to be
// any program whose path ends in /plain-sight (its P1, the Product Owner's
// PO4-EXE-SUFFIX), starts with the copy's executable (P2) or contains it
// (P3), each need a holder whose program is not the copy's but shares part
// of its path; the case above is P1's first.
for (const [id, what] of [
  ['pid-reused-helper', 'a helper beside the copy\'s executable (.../Contents/MacOS/plain-sight-helper, a path that starts with the copy\'s)'],
  ['pid-reused-bak', 'a bundle named as the copy\'s with .bak after it (.../Plain Sight test copy.app.bak/Contents/MacOS/plain-sight)'],
  ['pid-reused-nested', 'the copy\'s whole executable path again under another folder (a path that ends with the copy\'s)']
]) {
  test('a recorded copy\'s pid held by ' + what + ' is neither waited on nor signalled, and run.log says the pid now runs another program (QA-G-49)', async () => {
    const r = await runCase(id, undefined, { watchdog: 40000 });
    try {
      ended(r, 0);
      const [holder] = holdersOf(r);
      assert.ok(holder && holder.kind === 'OTHER', 'the holder started; the child\'s output:\n' + r.out);
      neitherWaitedOnNorSignalled(r, id, holder);
    } finally {
      endHolders(r);
    }
  });
}
// DM-259 and QA-G-48 (round 13): the restore check asked ps about a recorded
// copy outside any try, so a ps that failed ended the run with exit code 1,
// a stack, no restore line, no summary and the lock left behind (the data
// was back). A failure now names the pid and counts as not as it was.
test('a ps that fails while the restore check asks about a recorded copy is a reported outcome: the pid named "(could not be checked: ps failed: ...)", exit code 6, the summary printed and the lock released (DM-259, QA-G-48)', async () => {
  const r = await runCase('run-ps-broken', undefined, { watchdog: 40000 });
  ended(r, 6);
  const bundle = path.join(ROOT, 'run-ps-broken', 'copy', 'Plain Sight test copy.app');
  assert.ok(r.out.split('\n').includes('restore check: could not tell whether an app this run launched still runs: pid 7001 (' + bundle + '; could not be checked: ps failed: fork: Resource temporarily unavailable)'), 'the pid is named with the reason; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /as they were \(names/, 'no clean line');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m, 'the summary is printed');
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(r.lock, false, 'the lock is released');
  clean(r);
});
// QA-G-48 (round 13): QA-01 asked for the whole restore check inside a
// try/catch and the lock's release in a finally. Once ps's own failure is
// caught, nothing a fake home can make throws in the check, so a stand-in
// check that throws stands for any other fault. Two tests read the same case:
// the first holds the catch; the second holds the finally on its own, since
// with the catch removed only the finally releases the lock.
test('a restore check that fails for any reason is a reported outcome: "restore check: could not finish, ..." with the reason, exit code 6, the summary printed and the lock released (QA-G-48)', async () => {
  const r = await runCase('run-check-fails', undefined, { watchdog: 40000 });
  ended(r, 6);
  assert.ok(r.out.split('\n').includes('restore check: could not finish, so the app\'s data is not known to be back as it was: a stand-in restore check that fails'), 'the failure is named with its reason; the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /as they were \(names/, 'no clean line');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m, 'the summary is printed');
  assert.match(r.out, /^Exit code: 6$/m);
  assert.equal(r.lock, false, 'the lock is released');
  clean(r);
});
test('the run\'s lock is released in a finally: after a restore check that fails, no lock is left, whether or not the failure is caught on the way (QA-G-48)', async () => {
  const r = await runCase('run-check-fails', undefined, { watchdog: 40000 });
  assert.equal(r.lock, false, 'the lock is released; the child\'s output:\n' + r.out);
});
// QA-G-53 (round 18), QA-01's break Q4: with the lock's release moved from the
// cleanup's finally to its normal path, the case above still released it,
// since the failure it makes is caught. Here reporting the failure throws as
// well, so only the finally can release the lock.
test('the run\'s lock is released by the cleanup\'s finally even when reporting a failed restore check throws (a check that throws null), and the data is back (QA-G-53, QA-01\'s Q4)', async () => {
  const r = await runCase('run-check-throws-null', undefined, { watchdog: 40000 });
  assert.equal(r.signal, null, 'the child ended by itself, not by a signal; its output:\n' + r.out);
  assert.equal(r.lock, false, 'the lock is released; the child\'s output:\n' + r.out);
  assert.ok(r.intact, 'every data folder holds what was there before the run');
  assert.deepEqual(r.backups, [], 'no backup folder is left');
});
// Round 13 item 4 (the Product Owner's decision of 28 October on DISH I-21):
// the release and real-key suites' after() ended every pgrep -f match of a
// bundle's executable, recorded or not, so a bystander whose arguments merely
// held that path would have been asked to quit and, 5 s later, killed. Both
// now hand their bundles to the harness's endCopies, which takes a process
// for a copy only when ps names the bundle's executable as its program.
test('the suites\' end (endCopies) ends a copy the run never recorded, whose program is the bundle\'s executable, and never touches a bystander whose arguments merely hold that path (round 13, item 4; DISH I-21)', async () => {
  const r = await runCase('end-copies', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const holders = holdersOf(r);
    const copy = holders.find((x) => x.kind === 'COPY');
    const bystander = holders.find((x) => x.kind === 'BYSTANDER');
    assert.ok(copy && bystander, 'both started; the child\'s output:\n' + r.out);
    assert.ok(r.out.includes('COPIES ' + JSON.stringify([copy.pid]) + ' of '), 'copiesOf finds the copy alone; the child\'s output:\n' + r.out);
    assert.match(r.out, new RegExp('^QUIT ASKED \\[' + copy.pid + '\\] in \\d+ ms$', 'm'), 'only the copy is asked to quit');
    assert.match(r.out, /^COPY AFTER \{"signals":"","stillRuns":false\}$/m, 'the copy was ended (by the SIGKILL, which it cannot record)');
    assert.match(r.out, /^BYSTANDER AFTER \{"signals":"","stillRuns":true\}$/m, 'the bystander got no signal and still runs');
  } finally {
    endHolders(r);
  }
});
// PO-R13-2 (round 14): copiesOf takes a pgrep -f match for a copy only when
// ps names the bundle's executable as its program, and a ps that fails counts
// as not a copy. No test held that: the Product Owner's PO3-COPIES-PS-FAIL,
// a ps failure taken for a copy, passed every suite at a85b90f, and with it
// endCopies would ask a bystander to quit and kill it 5 s later.
test('the suites\' end (endCopies) while ps fails never takes a bystander whose arguments hold the bundle\'s executable for a copy: it is neither asked to quit nor signalled, still runs, and the end goes on at once (PO-R13-2)', async () => {
  const r = await runCase('end-copies-ps-broken', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const bystander = holdersOf(r).find((x) => x.kind === 'BYSTANDER');
    assert.ok(bystander, 'the bystander started; the child\'s output:\n' + r.out);
    assert.ok(r.out.includes('COPIES [] of [' + bystander.pid + ']'), 'copiesOf takes no copy while ps fails; the child\'s output:\n' + r.out);
    const asked = r.out.match(/^QUIT ASKED (\[[^\]]*\]) in (\d+) ms$/m);
    assert.ok(asked && asked[1] === '[]', 'nothing is asked to quit; the child\'s output:\n' + r.out);
    assert.ok(Number(asked[2]) < 4000, 'and the end goes on at once, with no 5 s wait for a copy to end');
    assert.match(r.out, /^BYSTANDER AFTER \{"signals":"","stillRuns":true\}$/m, 'the bystander got no signal and still runs');
  } finally {
    endHolders(r);
  }
});
// PO-R14-2 (round 15): the suites' end must let a copy quit through its
// page, the quit request and then up to 5 s, before any SIGKILL. The Product
// Owner's PO3-NO-GRACE, endCopies' wait made 0, passed every suite at
// 5dcf726: a copy that quits a moment after the request would have been
// killed.
test('the suites\' end (endCopies) gives a copy time to quit: an unrecorded copy that ends about 1 s after the quit request ends by its own quit, with no SIGKILL, and the end waits for it (PO-R14-2)', async () => {
  const r = await runCase('end-copies-grace', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const copy = holdersOf(r).find((x) => x.kind === 'COPY');
    assert.ok(copy, 'the copy started; the child\'s output:\n' + r.out);
    const asked = r.out.match(/^QUIT ASKED (\[[^\]]*\]) in (\d+) ms$/m);
    assert.ok(asked && asked[1] === '[' + copy.pid + ']', 'the copy is asked to quit once; the child\'s output:\n' + r.out);
    assert.match(r.out, /^COPY AFTER \{"signals":"SIGTERM","exitCode":0,"signalCode":null\}$/m, 'it ended by its own quit after the request: no SIGKILL');
    assert.ok(Number(asked[2]) >= 900 && Number(asked[2]) < 5000, 'and the end waited for it, about 1 s, not the whole 5 s; took ' + asked[2] + ' ms');
  } finally {
    endHolders(r);
  }
});
// QA-G-53 (round 18), QA-01's break Q18: endCopies asked the first copy
// only and passed every suite, since each case above has one copy. Two copies
// of one bundle, the quit failing for the first (QA-01's
// endcopies-quit-throws).
test('the suites\' end (endCopies) asks every copy of a bundle to quit: with two, a quit that fails for one is noted, the other is still asked and quits, and the first is ended by the SIGKILL 5 s later (QA-G-53, QA-01\'s Q18)', async () => {
  const r = await runCase('end-copies-two', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const got = JSON.parse((r.out.match(/^TWO (.*)$/m) || [])[1] || '{}');
    const byPid = (a, b) => a - b;
    assert.deepEqual([...(got.asked || [])].sort(byPid), [got.one, got.two].sort(byPid), 'both copies are asked to quit; the child\'s output:\n' + r.out);
    assert.equal(got.noted, true, 'the quit that failed is noted in run.log');
    assert.deepEqual(got.twoEnded, [0, null], 'the second ends by its own quit');
    assert.equal(got.twoSignals, 'SIGTERM', 'after the one quit request');
    assert.deepEqual(got.oneEnded, [null, 'SIGKILL'], 'the first is ended by the SIGKILL');
  } finally {
    endHolders(r);
  }
});
// PO-R18-2 (round 19): copiesOf takes no process that is ending (the flag
// E) or has ended (the state Z) for a copy; the Product Owner's
// PO3-COPIES-ENDING, that test dropped, passed every suite at 1173115.
test('copiesOf takes no process that is ending or has ended for a copy, and the end of the suites\' copies neither asks nor signals one: a real copy ended and not reaped, and a listing that gives the copy\'s program with the flag E and the state Z (PO-R18-2)', async () => {
  const r = await runCase('copies-ending', undefined, { watchdog: 40000 });
  ended(r, 0);
  const z = JSON.parse((r.out.match(/^ZOMBIE (.*)$/m) || [])[1] || '{}');
  assert.ok(/^Z/.test(z.stat || '') && z.found === false && JSON.stringify(z.asked) === '[]' && z.signals === 0, 'a real copy that has ended and is not reaped is no copy, and nothing asks or signals it: ' + JSON.stringify(z) + '; the child\'s output:\n' + r.out);
  assert.match(r.out, /^LISTED \[2000000101\]$/m, 'of the listing, only the running copy is a copy, not the ending or the ended one');
  assert.match(r.out, /^ASKED \[2000000101\] SIGNALS 0$/m, 'and the end of the suites\' copies asks it alone and signals nothing');
  assert.match(r.out, /^POSITIVE CONTROL TRIED 1$/m, 'the counter those SIGNALS lines read moves for a process.kill tried, so their 0 means nothing was tried (QA-G-56 W9); the child\'s output:\n' + r.out);
});
// PO-R18-1 (round 19): every child of this suite runs under the signal
// guard (installSignalGuard). Its proof: a stand-in outside the case's folder
// that the end of the suites' copies would find, as a widened copiesOf
// would; nothing reaches it, each refusal is printed and written with the
// pid and the program, and the case reports them; the stand-in is then ended
// by the case itself. A refusal the case does not expect fails it. Round 21
// (DISH-G-103, DM-268): the 80 tries of SIGNALLERS and FORMS, a child
// process's kill(), the nodes a case starts, and the stand-ins' folder
// beside the case's.
test('a child of the safety suite signals nothing outside its own folder: the end of the suites\' copies, a signal straight to a stand-in outside it, a child process\'s kill(), kill, pkill, killall and osascript (bare, by their path, through env and through xargs, each as a program and in a shell\'s command, shell: true included; quoted or escaped, and QA-01\'s shapes, through exec and execFile too; in another case, by a glob, through ChildProcess.spawn called directly and as a string shell option), a worker thread, a command that sets or clears NODE_OPTIONS, runs env with an option or uses ANSI-C quoting, and a node the case starts by fork or spawn are refused and reported with the pid and the program or the command; the stand-ins, in a folder beside the case\'s whose name starts with the case\'s, still run, and the case then ends them itself (PO-R18-1, PO-R19-1, DM-268, DISH-G-103, PO-R21-1, QA-G-54, DM-270, QA-G-55, QA-G-56)', async () => {
  const r = await runCase('signal-guard', undefined, { outside: true, refusals: true, watchdog: 60000 });
  ended(r, 0);
  const [, pid, exe] = r.out.match(/^OUTSIDE (\d+) (.+)$/m) || [];
  assert.ok(pid && exe && exe.endsWith(path.join('Plain Sight.app', 'Contents', 'MacOS', 'plain-sight')) && exe.startsWith(r.box + '-outside' + path.sep), 'the stand-in runs outside the case\'s folder, in the folder beside it whose name starts with the case\'s; the child\'s output:\n' + r.out);
  assert.match(r.out, /^PART B REFUSALS 0$/m, 'the end of the case\'s own copies, none running, signals nothing, whatever runs outside; the child\'s output:\n' + r.out);
  assert.match(r.out, /^PART A REFUSALS 2 in \d+ ms$/m, 'the end of the outside bundle\'s copies: its quit and the SIGKILL 5 s later, both refused');
  assert.match(r.out, /^PART C REFUSALS 1$/m, 'a signal straight to the stand-in, refused');
  assert.match(r.out, /^PART C TRIED 1$/m, 'and counted as tried, refused or not (QA-G-56 W9)');
  assert.match(r.out, /^BESIDE true$/m, 'the stand-ins\' folder lies beside the case\'s and its name starts with the case\'s, so a folder check without its separator would take it for the case\'s own');
  const [, pid2, name, clone] = r.out.match(/^SECOND (\d+) (psg[0-9a-f]+) (.+)$/m) || [];
  assert.ok(pid2 && name && clone, 'the second stand-in, a clone of node under a name of its own, runs outside the folder; the child\'s output:\n' + r.out);
  const tries = SIGNALLERS(pid2, name);
  assert.equal(tries.length * FORMS.length, 80, 'four programs, four ways each, five forms each');
  assert.match(r.out, /^PART D REFUSALS 80$/m, 'kill, pkill, killall and osascript, bare, by their path, through env and through xargs, each as a program and in a shell\'s command, each refused; the child\'s output:\n' + r.out);
  assert.match(r.out, /^PART D RAN \[\]$/m, 'none of the 80 ran');
  const quoted = QUOTED(pid2, name).flatMap((t) => quotedTexts(t).map((text) => ({ text, program: t.program })));
  assert.equal(quoted.length, 25, 'twelve command lines, each as a shell\'s command and as /bin/sh\'s argument, and nohup kill as its program');
  assert.match(r.out, /^PART D2 REFUSALS 25$/m, 'the four names quoted or escaped, and QA-01\'s shapes, each refused (PO-R21-1, QA-G-54); the child\'s output:\n' + r.out);
  assert.match(r.out, /^PART D2 RAN \[\]$/m, 'none of the 25 ran');
  const evasions = EVASIONS(pid2, path.join(r.box, 'programs', 'node'));
  assert.equal(evasions.length + 1, 9, 'a worker thread and eight commands');
  assert.match(r.out, /^PART F REFUSALS 9$/m, 'a worker thread, NODE_OPTIONS set or cleared, env with an option, ANSI-C quoting, and kill through exec and execFile, each refused (DM-270); the child\'s output:\n' + r.out);
  assert.match(r.out, /^PART F RAN \[\]$/m, 'none of the nine ran');
  const routes = ROUTES(pid2, name);
  assert.equal(routes.length, 11, 'six names in another case, three globs, ChildProcess.spawn and a string shell option');
  assert.match(r.out, /^PART G REFUSALS 11$/m, 'QA-01\'s routes and its string shell option, each refused (QA-G-55, QA-G-56 W5); the child\'s output:\n' + r.out);
  assert.match(r.out, /^PART G RAN \[\]$/m, 'none of the eleven ran');
  const why = {
    NODE_OPTIONS: 'sets or clears NODE_OPTIONS, which would start node without this guard: a child of this suite runs no such command',
    env: 'runs env with an option, which can empty the environment and NODE_OPTIONS with it: a child of this suite runs no such command',
    ansi: "uses ANSI-C quoting ($'...'), which a shell decodes into names this guard cannot read: a child of this suite runs no such command",
    kill: 'names kill: a child of this suite runs no kill, pkill, killall or osascript'
  };
  assert.match(r.out, /^PART E KILL false$/m, 'the outside stand-in\'s own kill(), refused');
  for (const how of ['fork', 'spawn', 'spawn with an environment of its own', 'a shell\'s command', 'spawnSync with an environment of its own', 'ChildProcess.spawn with environment pairs of its own']) assert.ok(r.out.split('\n').includes('PART E NODE ' + how + ': PROBE REFUSED AS EPERM'), 'a node the case starts by ' + how + ' loads the guard first, and its process.kill is refused; the child\'s output:\n' + r.out);
  assert.match(r.out, /^PART E REFUSALS 7$/m, 'seven refusals written: the kill() and one in each of the six nodes');
  assert.match(r.out, /^OUTSIDE STILL RUNS true$/m, 'nothing reached the stand-in');
  assert.match(r.out, /^SECOND STILL RUNS true$/m, 'nor the second stand-in');
  assert.match(r.out, /^OUTSIDE ENDED \[null,"SIGTERM"\]$/m, 'the case then ended it itself, by its pid');
  assert.match(r.out, /^SECOND ENDED \[null,"SIGTERM"\]$/m, 'and the second one');
  const box = path.join(ROOT, 'signal-guard');
  const to = (signal) => 'signal ' + signal + ' to pid ' + pid + ' (' + exe + '), outside the case\'s folder ' + box;
  const command = (t, form) => 'the command ' + JSON.stringify(formText(form, t)) + ' names ' + t.program + ': a child of this suite runs no kill, pkill, killall or osascript';
  const inNode = 'signal 15 to pid ' + pid2 + ' (' + clone + '), outside the case\'s folder ' + box;
  assert.deepEqual(r.refused, [to(15), to(9), to(15), ...tries.flatMap((t) => FORMS.map((form) => command(t, form))), ...quoted.map(({ text, program }) => 'the command ' + JSON.stringify(text) + ' names ' + program + ': a child of this suite runs no kill, pkill, killall or osascript'), 'a worker thread, whose process.kill this guard cannot reach: a child of this suite starts none', ...evasions.map((t) => 'the command ' + JSON.stringify(evasionText(t)) + ' ' + why[t.reason]), ...routes.map((t) => 'the command ' + JSON.stringify(routeText(t)) + ' names ' + t.names + ': a child of this suite runs no kill, pkill, killall or osascript'), 'signal SIGTERM to its child ' + pid + ' (' + exe + '), outside the case\'s folder ' + box, inNode, inNode, inNode, inNode, inNode, inNode], 'each refusal written with the pid and the program, or the command, which names only the second stand-in');
  assert.deepEqual(r.out.split('\n').filter((l) => l.startsWith('SIGNAL REFUSED ')), r.refused.slice(0, -6).map((x) => 'SIGNAL REFUSED ' + x), 'and printed (the six nodes print theirs in their own output)');
});
test('a signal the guard refuses fails the case that sent it, unless the case expects it (PO-R18-1)', async () => {
  await assert.rejects(runCase('signal-guard', undefined, { outside: true, tag: 'signal-guard-unexpected', watchdog: 60000 }), /^Error: the case tried to signal a process outside its own folder, and the guard refused: signal 15 to pid \d+ /);
});
// QA-G-56 W10 (round 24, QA-01's sigguard-adv, credited): a signal to a
// process group is refused and written, so the case that sent it fails, and
// the group gets nothing. QA-01's W10, the group check removed, sent nothing
// either (ps knows no process by a negative pid), but recorded nothing, so
// no case failed.
test('a signal to a process group, a group of the case\'s own, is refused and written, so the case that sent it fails, and nothing reaches the group (QA-G-56 W10)', async () => {
  let error = null;
  try { await runCase('group-kill', undefined, { watchdog: 30000 }); } catch (err) { error = err; }
  assert.ok(error, 'the case failed for the signal it sent to a process group');
  assert.match(String(error.message), /^the case tried to signal a process outside its own folder, and the guard refused: signal 15 to -\d+, a process group/, 'refused as a signal to a process group');
  assert.match(String(error.message), /^GROUP REFUSED AS EPERM$/m, 'the case was answered EPERM');
  assert.match(String(error.message), /^GROUP STILL RUNS true$/m, 'and the group still ran');
});
// DM-269 (round 21): the parent's rule (endCasePid), fed hostile prints by
// the case hostile-prints. The parent starts two stand-ins of its own, links
// to /bin/sleep named stand-in: one in a folder outside this run's folder,
// given to the case as its second folder, so that only the rule's first
// half (this run's folder) refuses the OUTSIDE line; and one inside this
// run's folder but in no case's folder, so that only the second half (the
// case's own folders) refuses it, in a folder beside the case's whose name
// starts with the case's, so that a folder check without its separator
// would take it for the case's own. Every line and pid file of the case names
// one of the two and nothing else, so a broken rule can reach only these.
// Every way the parent ends a case's processes is run on the case
// (endLeftovers, which takes in endHolders and endOutsideStandIns, and
// standinsAfter): nothing is sent, each line and pid is refused and printed,
// both stand-ins still run, and the parent then ends them itself. The
// refusals it expects do not fail the run.
test('the parent ends a pid a case printed only when ps shows it running a program inside that case\'s own folder in this run\'s folder: "HOLDER <pid> /", "BYSTANDER <pid> .", a file outside the run\'s folder, a file in the case\'s folder with the pid of a process outside it, the pid of a process in the run\'s folder but not the case\'s, OUTSIDE and SECOND lines and the pid files are each refused and printed, and nothing is sent (DM-269)', async () => {
  const far = mkdtempSync(path.join(os.tmpdir(), 'hs-far-'));
  const near = path.join(ROOT, 'hostile-prints-beside');
  mkdirSync(near, { recursive: true });
  const own = [];
  const refusedBefore = parentRefusals.length;
  const sentBefore = parentSent.length;
  const printed = [];
  const say = sayParent;
  const programOf = (pid) => String(childProcess.spawnSync('/bin/ps', ['-ww', '-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '').trim();
  // QA-G-56 P9: a folder of the case that is a link out of the run's folder.
  const caseBox = path.join(ROOT, 'hostile-prints');
  const linkOut = path.join(caseBox, 'linkout');
  try {
    for (const dir of [far, near]) {
      fs.symlinkSync('/bin/sleep', path.join(dir, 'stand-in'));
      own.push(spawn(path.join(dir, 'stand-in'), ['60'], { stdio: 'ignore' }));
    }
    mkdirSync(caseBox, { recursive: true });
    fs.symlinkSync(far, linkOut);
    own.push(spawn(path.join(linkOut, 'stand-in'), ['60'], { stdio: 'ignore' }));
    const [outsider, neighbour, linker] = own;
    for (const [standIn, dir] of [[outsider, far], [neighbour, near], [linker, linkOut]]) {
      for (let i = 0; i < 100 && programOf(standIn.pid) !== path.join(dir, 'stand-in'); i += 1) await pause(50);
      assert.equal(programOf(standIn.pid), path.join(dir, 'stand-in'), 'the parent\'s own stand-in runs in ' + dir);
    }
    sayParent = (line) => printed.push(line);
    const r = await runCase('hostile-prints', undefined, { outside: far, targets: { outsider: outsider.pid, neighbour: neighbour.pid, linker: linker.pid, far, near } });
    assert.match(r.out, /^ZOMBIE \d+ Z/m, 'the case\'s own stand-in had ended and was not reaped (state Z) when the parent read its line (QA-G-56 P4); the child\'s output:\n' + r.out);
    ended(r, 0);
    endLeftovers(r);
    await standinsAfter(r);
    sayParent = say;
    await pause(300);
    const got = parentRefusals.slice(refusedBefore);
    const pids = path.join(r.box, STANDIN_PIDS);
    assert.deepEqual(got.map((x) => x.slice(0, x.indexOf(': pid '))), [
      'the line "HOLDER ' + outsider.pid + ' /"',
      'the line "BYSTANDER ' + outsider.pid + ' ."',
      'the line "COPY ' + outsider.pid + ' ' + path.join(far, 'holder-1-signals') + '"',
      'the line "OTHER ' + outsider.pid + ' ' + path.join(r.box, 'holder-2-signals') + '"',
      'the line "HOLDER ' + neighbour.pid + ' ' + path.join(r.box, 'holder-3-signals') + '"',
      'the line "HOLDER ' + linker.pid + ' ' + path.join(r.box, 'holder-4-signals') + '"',
      'the line "OUTSIDE ' + outsider.pid + ' ' + path.join(far, 'stand-in') + '"',
      'the line "SECOND ' + neighbour.pid + ' stand-in ' + path.join(near, 'stand-in') + '"',
      'the pid ' + outsider.pid + ' in ' + pids,
      'the pid ' + neighbour.pid + ' in ' + pids,
      'the pid ' + outsider.pid + ' in ' + path.join(r.box, LATE_PIDS),
      'the stand-in app\'s pid ' + outsider.pid + ' in ' + pids,
      'the stand-in app\'s pid ' + neighbour.pid + ' in ' + pids
    ], 'each line and each pid refused, in order; the refusals:\n' + got.join('\n'));
    assert.ok(got.every((x) => x.includes(': pid ' + outsider.pid + ' runs ' + path.join(far, 'stand-in') + ', ') || x.includes(': pid ' + neighbour.pid + ' runs ' + path.join(near, 'stand-in') + ', ') || x.includes(': pid ' + linker.pid + ' runs ' + path.join(linkOut, 'stand-in') + ', ')), 'each refusal names the pid and the program ps shows; the refusals:\n' + got.join('\n'));
    assert.deepEqual(printed, got.map((x) => 'PARENT REFUSED ' + x), 'and each is printed');
    assert.equal(parentSent.length, sentBefore, 'nothing was sent');
    assert.deepEqual(own.map((standIn) => [standIn.exitCode, standIn.signalCode]), [[null, null], [null, null], [null, null]], 'the three stand-ins still run');
  } finally {
    sayParent = say;
    const at = ranCases.findIndex((c) => c.box === path.join(ROOT, 'hostile-prints'));
    if (at >= 0) ranCases.splice(at, 1);
    parentRefusals.splice(refusedBefore);
    for (const standIn of own) standIn.kill('SIGKILL');
    rmSync(far, { recursive: true, force: true });
  }
});
// QA-G-52 (round 18): copiesOf asked pgrep -f with the bundle's executable,
// which pgrep reads as a regular expression: a running copy whose bundle path
// held ( [ + or * was not found, and ( alone made pgrep fail; nor was a copy
// started through a linked folder found by the real folder's spelling. It now
// reads ps's list of every process and compares each program exactly.
test('copiesOf finds a running copy whatever its bundle path holds: QA-01\'s five names with ( [ + and * (QA-G-52)', async () => {
  const r = await runCase('copies-regex', undefined, { watchdog: 60000 });
  try {
    ended(r, 0);
    const got = JSON.parse((r.out.match(/^REGEX (.*)$/m) || [])[1] || '{}');
    assert.deepEqual(got, { 'Plain Sight (1).app': true, 'Plain Sight [x].app': true, 'Plain+Sight.app': true, 'Plain Sight (unbalanced.app': true, 'Plain Sight*.app': true }, 'each copy is found; the child\'s output:\n' + r.out);
  } finally {
    endHolders(r);
  }
});
test('copiesOf takes the bundle\'s own executable alone: another Plain Sight, a helper beside the executable and a bystander whose arguments hold its path are no copies (QA-G-52, QA-01\'s copies-bystanders)', async () => {
  const r = await runCase('copies-others', undefined, { watchdog: 60000 });
  try {
    ended(r, 0);
    const got = JSON.parse((r.out.match(/^OTHERS (.*)$/m) || [])[1] || '{}');
    assert.ok(got.copy > 0, 'the copy started; the child\'s output:\n' + r.out);
    assert.deepEqual(got.found, [got.copy], 'the copy alone is found; the child\'s output:\n' + r.out);
  } finally {
    endHolders(r);
  }
});
test('copiesOf finds a copy started through a linked folder, and one started through the real folder, whichever spelling names the bundle (QA-G-52, QA-01\'s copies-linked)', async () => {
  const r = await runCase('copies-linked', undefined, { watchdog: 60000 });
  try {
    ended(r, 0);
    const got = JSON.parse((r.out.match(/^LINKED (.*)$/m) || [])[1] || '{}');
    const byPid = (a, b) => a - b;
    const both = [got.link, got.real].sort(byPid);
    assert.deepEqual([...(got.byLink || [])].sort(byPid), both, 'named through the link, both copies are found; the child\'s output:\n' + r.out);
    assert.deepEqual([...(got.byReal || [])].sort(byPid), both, 'named through the real folder, both are found');
  } finally {
    endHolders(r);
  }
});
// QA-G-53 (round 18), QA-01's break Q23: driveRaw's 64 MB output buffer
// taken back to Node's 1 MB default passed every suite, since the stand-in
// driver here answers in-process. QA-01's driveraw-big: the driver a script
// that prints 3,000,000 bytes, run through the real execFileSync.
test('driveRaw takes a driver answer of 3,000,000 bytes, as a tree read of a panel that lists many files can be, more than Node\'s 1 MB default output buffer (QA-G-53, QA-01\'s Q23)', async () => {
  const r = await runCase('driveraw-big', undefined, { watchdog: 40000 });
  ended(r, 0);
  assert.match(r.out, /^BIG \{"ok":true,"length":3000000\}$/m, 'the answer is read whole; the child\'s output:\n' + r.out.slice(0, 2000));
});
// PO-R15-1 (round 16): the round 15 pin on the real-key suite's clipboard
// save read the call's text, which a condition in front of it keeps; the
// Product Owner's PO3-SAVE-SKIPPED, if (false) in front, passed every suite.
// This case runs app.mjs itself under the fake home with the stand-in driver
// and no test to run, and reads what its before() and after() asked of the
// driver, in order.
test('the real-key suite saves the person\'s clipboard in before() and puts it back in after(), after the copies\' end and before the front app, as the stand-in driver sees it when app.mjs runs under the fake home with no test to run (PO-R15-1)', async () => {
  const r = await runCase('app-suite-clipboard', undefined, { app: TEST_COPY, watchdog: 60000 });
  ended(r, 0);
  const file = path.join(ROOT, 'app-suite-clipboard', 'evidence', 'clipboard.plist');
  const calls = r.out.split('\n').filter((l) => l.startsWith('DRIVER ')).map((l) => l.slice('DRIVER '.length));
  assert.deepEqual(calls.filter((c) => /^(frontmost|front |clip-)/.test(c)), ['frontmost', 'clip-save ' + file, 'clip-restore ' + file, 'front 4243'], 'before(): the front app, then the clipboard saved; after(): the clipboard put back, then the front app; the child\'s output:\n' + r.out);
  assert.equal(calls.some((c) => /^(quit-app|key|type|press|click|menu|focus)\b/.test(c)), false, 'nothing else was asked of the app: no test ran');
  assert.match(r.out, /^0 passed, 0 failed, 0 not run, 0 total\. Errors: 0$/m, 'the run had no test to run');
  assert.equal(existsSync(file), false, 'the file that held the person\'s clipboard is removed once the clipboard is back (DISH-G-99)');
  assert.ok(runLog('app-suite-clipboard').split('\n').some((l) => l.endsWith(' clipboard file removed')), 'and run.log says so');
  assert.equal(r.lock, false, 'the lock is released');
  clean(r);
});
// DISH-G-99 (round 17): the file holds the person's whole clipboard, every
// item and type. Once the clipboard is back it is removed; when the driver
// could not put it back, the file is the person's only copy, so it is kept
// and the run says where, in run.log and in its output.
test('when the clipboard cannot be put back, the file that holds the person\'s clipboard is kept and the run says where, in run.log and in its output (DISH-G-99)', async () => {
  const r = await runCase('app-suite-clipboard-refused', undefined, { app: TEST_COPY, watchdog: 60000 });
  ended(r, 0);
  const file = path.join(ROOT, 'app-suite-clipboard-refused', 'evidence', 'clipboard.plist');
  const line = 'the clipboard could not be put back: the person\'s clipboard is kept in ' + file;
  assert.ok(r.out.split('\n').includes(line), 'the output says where; the child\'s output:\n' + r.out);
  const log = runLog('app-suite-clipboard-refused');
  assert.ok(log.split('\n').some((l) => l.endsWith(' ' + line)), 'and run.log too');
  assert.equal(log.includes('clipboard file removed'), false, 'nothing says it was removed');
  assert.equal(readFileSync(file, 'utf8'), 'STAND-IN CLIPBOARD\n', 'the file is kept as it was');
  assert.equal(r.lock, false, 'the lock is released');
  clean(r);
});
// QA-G-51 (b) (round 18): when the clipboard's save does not answer ok, an
// older clipboard file in an evidence folder used twice must never be put
// back over the person's clipboard (QA-01's C4: it was). The run says the
// save failed, in run.log and its output, and leaves the clipboard and that
// file alone.
test('when the clipboard cannot be saved, the run says so in run.log and its output and puts nothing back: no clip-restore, and an older clipboard file in the evidence folder is left as it was (QA-G-51 (b), QA-01\'s C4)', async () => {
  const r = await runCase('app-suite-clipboard-save-failed', undefined, { app: TEST_COPY, watchdog: 60000 });
  ended(r, 0);
  const file = path.join(ROOT, 'app-suite-clipboard-save-failed', 'evidence', 'clipboard.plist');
  const calls = r.out.split('\n').filter((l) => l.startsWith('DRIVER ')).map((l) => l.slice('DRIVER '.length));
  assert.deepEqual(calls.filter((c) => /^(frontmost|front |clip-)/.test(c)), ['frontmost', 'clip-save ' + file, 'front 4243'], 'the save is asked for, and nothing is put back; the child\'s output:\n' + r.out);
  const line = 'the clipboard could not be saved, so this run will not put it back: {"ok":false,"error":"the stand-in could not save the clipboard"}';
  assert.ok(r.out.split('\n').includes(line), 'the output says so; the child\'s output:\n' + r.out);
  const log = runLog('app-suite-clipboard-save-failed');
  assert.ok(log.split('\n').some((l) => l.endsWith(' ' + line)), 'and run.log too');
  assert.equal(/clipboard put back|clipboard file removed/.test(log), false, 'nothing says it was put back or removed');
  assert.equal(readFileSync(file, 'utf8'), STALE_CLIPBOARD, 'the older file is left as it was');
  assert.equal(r.lock, false, 'the lock is released');
  clean(r);
});
// QA-G-51 (a) (round 18), QA-01's C0: the order with a copy up, which
// QA-01 ran with app.mjs in a fake home of its own: the copy is quit before
// the clipboard goes back, the front app comes back last, and the file goes.
test('with a copy running at the end, the real-key suite quits it before it puts the clipboard back, then brings the front app back, and the clipboard file is removed (QA-G-51 (a), QA-01\'s C0)', async () => {
  const r = await runCase('app-suite-clipboard-copy', undefined, { app: TEST_COPY, watchdog: 60000 });
  try {
    ended(r, 0);
    const copy = holdersOf(r).find((x) => x.kind === 'COPY');
    assert.ok(copy, 'the copy started; the child\'s output:\n' + r.out);
    const file = path.join(ROOT, 'app-suite-clipboard-copy', 'evidence', 'clipboard.plist');
    const calls = r.out.split('\n').filter((l) => l.startsWith('DRIVER ')).map((l) => l.slice('DRIVER '.length));
    assert.deepEqual(calls.filter((c) => /^(frontmost|front |clip-|quit-app )/.test(c)), ['frontmost', 'clip-save ' + file, 'quit-app ' + copy.pid, 'clip-restore ' + file, 'front 4243'], 'the save, the copy\'s quit, the put-back after it, then the front app; the child\'s output:\n' + r.out);
    assert.equal(readFileSync(copy.file, 'utf8').trim(), 'SIGTERM', 'the copy ended by its quit');
    assert.equal(existsSync(file), false, 'the clipboard file is removed once the clipboard is back');
    assert.equal(r.lock, false, 'the lock is released');
    clean(r);
  } finally {
    endHolders(r);
  }
});
// Round 13 item 2 (Developer N's round 12 observation): pgrep -f, which
// finds the copies, matches a path anywhere in the arguments, while the rule
// compared ps's name with the recorded path exactly, so a copy recorded
// through a linked folder would have been taken for another program.
test('a copy recorded through a linked folder, whose process runs from the real folder, is still the copy: alive, stopped by its SIGTERM, and never noted as another program (round 13, item 2)', async () => {
  const r = await runCase('copy-through-link', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [copy] = holdersOf(r);
    assert.ok(copy && copy.kind === 'COPY', 'the copy started; the child\'s output:\n' + r.out);
    assert.match(r.out, /^ALIVE true$/m, 'alive() takes it for the copy; the child\'s output:\n' + r.out);
    const [how, ms] = stopCurrentLine(r);
    assert.equal(how, 'returned', 'stopCurrentApp returned');
    assert.ok(Number(ms) < 3000, 'within 3 s: ' + ms + ' ms');
    assert.match(r.out, /^SIGNALS SIGTERM$/m, 'the copy got one SIGTERM');
    assert.match(r.out, /^STILL RUNS false$/m, 'and ended');
    assert.ok(!runLog('copy-through-link').includes(otherProgramNote(copy.pid)), 'it was never taken for another program');
  } finally {
    endHolders(r);
  }
});
// DISH's DN4 (round 17): realPathOf's fallback for a folder that is gone was
// held by no test: DN4, the fallback giving an empty path, passed every
// suite. Without it a copy whose bundle was moved or removed while it runs
// would be taken for another program and left running.
test('a recorded copy whose bundle folder is gone by the time the run stops it is still the copy: alive, stopped by its SIGTERM, and never noted as another program (DISH DN4, round 17)', async () => {
  const r = await runCase('copy-folder-gone', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [copy] = holdersOf(r);
    assert.ok(copy && copy.kind === 'COPY', 'the copy started; the child\'s output:\n' + r.out);
    assert.match(r.out, /^FOLDER GONE true$/m, 'the bundle folder is gone before the run asks about the copy');
    assert.match(r.out, /^ALIVE true$/m, 'alive() still takes it for the copy; the child\'s output:\n' + r.out);
    const [how, ms] = stopCurrentLine(r);
    assert.equal(how, 'returned', 'stopCurrentApp returned');
    assert.ok(Number(ms) < 3000, 'within 3 s: ' + ms + ' ms');
    assert.match(r.out, /^SIGNALS SIGTERM$/m, 'the copy got one SIGTERM');
    assert.match(r.out, /^STILL RUNS false$/m, 'and ended');
    assert.ok(!runLog('copy-folder-gone').includes(otherProgramNote(copy.pid)), 'it was never taken for another program');
  } finally {
    endHolders(r);
  }
});
test('a copy recorded through LaunchServices that still runs the copy\'s executable is stopped by its pid: stopCurrentApp sends it SIGTERM, it ends, and stopCurrentApp returns (round 12, the reused pid; the rule\'s other side)', async () => {
  const r = await runCase('copy-stopped', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [copy] = holdersOf(r);
    assert.ok(copy && copy.kind === 'COPY', 'the copy started; the child\'s output:\n' + r.out);
    const [how, ms] = stopCurrentLine(r);
    assert.equal(how, 'returned', 'stopCurrentApp returned; the child\'s output:\n' + r.out);
    assert.ok(Number(ms) < 3000, 'within 3 s: ' + ms + ' ms');
    assert.match(r.out, /^SIGNALS SIGTERM$/m, 'the copy got one SIGTERM');
    assert.match(r.out, /^STILL RUNS false$/m, 'and ended');
    const log = runLog('copy-stopped');
    assert.ok(log.includes(' stopping pid ' + copy.pid + '\n'), 'stopApp noted the stop; run.log:\n' + log);
    assert.ok(!log.includes(otherProgramNote(copy.pid)), 'the copy was never taken for another program; run.log:\n' + log);
  } finally {
    endHolders(r);
  }
});
// ps's answers, from the child's stand-in for ps: an ending copy was taken
// for another program at first (614610b; the copy-stopped case's control in
// round 12's break B2).
test('a recorded copy\'s pid counts as the copy only while ps names the copy\'s executable: a process ending (the flag E, its short name only) or ended (the state Z) counts as ended, not as another program, and only another program is noted (round 12, the reused pid)', async () => {
  const r = await runCase('ps-states');
  ended(r, 0);
  assert.deepEqual(r.out.split('\n').filter((l) => l.startsWith('ALIVE ')), ['ALIVE 7001 true', 'ALIVE 7002 false', 'ALIVE 7003 false', 'ALIVE 7004 false', 'ALIVE 7005 false'], 'the child\'s output:\n' + r.out);
  const log = runLog('ps-states');
  assert.deepEqual(log.split('\n').filter((l) => l.includes(' now runs another program')).map((l) => l.slice(25)), ['pid 7004 now runs another program: not stopped'], 'only the other program is noted; run.log:\n' + log);
});
const checkedLine = /^restore check: \d+ folders as they were \(names, and sizes and times of files; checked twice, [\d.]+ s apart\)$/m;
test('the restore check does not name a recorded copy whose pid another program holds at the run\'s end as still running: exit code 0, the clean line, and run.log says the pid now runs another program (round 12; QA-01\'s observation 9)', async () => {
  const r = await runCase('run-copy-pid-reused', undefined, { watchdog: 40000 });
  try {
    ended(r, 0);
    const [holder] = holdersOf(r);
    assert.ok(holder, 'the pid holder started; the child\'s output:\n' + r.out);
    assert.match(r.out, checkedLine, 'the clean line; the child\'s output:\n' + r.out);
    assert.doesNotMatch(r.out, /still running, though this run launched it/, 'no app named as still running');
    assert.match(r.out, /^Exit code: 0$/m);
    assert.ok(runLog('run-copy-pid-reused').includes(otherProgramNote(holder.pid) + '\n'), 'run.log says the pid now runs another program');
    assert.ok(isAlive(holder.pid), 'the other program still runs');
    clean(r);
  } finally {
    endHolders(r);
  }
});
test('a recorded copy that still runs the copy\'s executable at the run\'s end is named by its pid: exit code 6 (round 12; the rule\'s other side)', async () => {
  const r = await runCase('run-copy-left-running', undefined, { watchdog: 40000 });
  try {
    ended(r, 6);
    const [copy] = holdersOf(r);
    assert.ok(copy && copy.kind === 'COPY', 'the copy started; the child\'s output:\n' + r.out);
    const bundle = path.join(ROOT, 'run-copy-left-running', 'copy', 'Plain Sight test copy.app');
    assert.ok(r.out.split('\n').includes('restore check: still running, though this run launched it: pid ' + copy.pid + ' (' + bundle + ')'), 'it is named; the child\'s output:\n' + r.out);
    assert.match(r.out, /^Exit code: 6$/m);
    clean(r);
  } finally {
    endHolders(r);
  }
});
test('the listing never opens a file: a file of the person\'s that no one may read (mode 000) leaves the check clean, and listData reads names, kinds, sizes and times only (DM-249)', async () => {
  const r = await runCase('run-restore-unreadable', undefined, { recheck: null });
  ended(r, 0);
  assert.match(r.out, restoredLine(r.dirs.length), 'the check is clean; the child\'s output:\n' + r.out);
  const src = readFileSync(HARNESS, 'utf8');
  const start = src.indexOf('export function listData(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(start >= 0 && body.includes('lstatSync(p, { bigint: true })') && body.includes('readdirSync(p)'), 'listData lists with lstat and readdir');
  assert.equal(/readFile|openSync|createReadStream|readSync|\bopen\(|\bfs\./.test(body), false, 'and calls nothing that opens a file');
  clean(r);
});

// QA-G-44 (QA-01's section 20). N6: stopApp() without its SIGKILL fallback
// passed every suite; stopCurrentApp loops on it, so an app that ignores
// SIGTERM or freezes would hold the cleanup, and the person's data with it,
// forever. QA-01's L5 cases, adopted, each bounded by a 40 s watchdog so a
// regression fails instead of hanging the suite.
test('an app that ignores SIGTERM, or freezes on it, is ended by stopApp\'s SIGKILL after its 8 s wait: the cleanup ends inside 12 s, the relaunch is refused, exit code 130, no app left, the data back, the lock released (QA-G-44; QA-01\'s L5)', async () => {
  const runs = await Promise.all(['ignore', 'frozen'].map(async (mode) => {
    let sent = false;
    const r = await runCase('run-unkillable-' + mode, (out, child) => { if (!sent && out.includes('IN TEST')) { sent = true; setTimeout(() => child.kill('SIGINT'), 300); } }, { watchdog: 40000 });
    return { mode, sent, r, s: await standinsAfter(r) };
  }));
  for (const { mode, sent, r, s } of runs) {
    assert.ok(sent, mode + ': the signal was sent during the test; the child\'s output:\n' + r.out);
    ended(r, 130);
    const took = Number((r.out.match(/^AFTER DONE after (\d+) ms$/m) || [])[1]);
    assert.ok(took >= 7500 && took < 12000, mode + ': after() waited stopApp\'s 8 s and then ended the app: ' + took + ' ms; the child\'s output:\n' + r.out);
    assert.match(r.out, /^REFUSED RunEnding$/m, mode + ': the relaunch during that wait was refused');
    assert.doesNotMatch(r.out, /^RELAUNCHED /m, mode + ': no app was launched again');
    assert.deepEqual(s.running, [], mode + ': no app is left');
    clean(r);
    assert.equal(r.lock, false, mode + ': the lock is released');
  }
});
// N10: a SIGQUIT during the cleanup obeyed at once passed every suite, since
// the SIGQUIT case above sends it only during a test. QA-01's P3.2 with
// SIGQUIT (r9_infra_adv.mjs), adopted: one while after() waits.
test('a SIGQUIT while the run\'s own cleanup waits in after() waits for that cleanup as a SIGINT does: reported by name, after() once with the lock held, the data back, the lock released, exit code 130 (QA-G-44; QA-01\'s P3.2 with SIGQUIT)', async () => {
  let sent = false;
  const t0 = Date.now();
  const r = await runCase('run-signal-during-cleanup', (out, child) => { if (!sent && out.includes('IN AFTER')) { sent = true; child.kill('SIGQUIT'); } }, { tag: 'run-sigquit-during-cleanup' });
  assert.ok(sent, 'the signal was sent while after() waited; the child\'s output:\n' + r.out);
  ended(r, 130);
  assert.match(r.out, /^AFTER DONE$/m, 'the cleanup went on to its end');
  assert.match(r.out, /^release: SIGQUIT came while the run puts the app's data back; the run ends once that is done, with 130, or 6 if the app's data is not back as it was$/m, 'the SIGQUIT is reported by name');
  onceWithTheLock(r);
  assert.ok(Date.now() - t0 > 3000, 'the run lived until the cleanup was done (after() holds 3 s)');
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});

// DM-247: three real-key tests (app.mjs) started from a first launch by
// clearing the test data mid-run, which on a sandboxed copy removes the
// copy's container; macOS refused that removal (EPERM) at the end of
// release-run-1, so those tests could not pass on a copy unattended (the
// Delivery Manager's AT-H5 showed it under this file's fake home). They now
// ask the harness's freshStart, which never clears a sandboxed bundle's
// container during the run and gives the next launch a fresh copy instead.
test('a test that needs a first launch of a sandboxed copy gets a fresh copy from the copy script, never a clear of the copy\'s container, and both containers are named at the end as test data left behind (DM-247)', async () => {
  const r = await runCase('run-fresh-start', undefined, { app: TEST_COPY });
  ended(r, 8);
  const line = r.out.split('\n').find((l) => l.startsWith('FRESH '));
  assert.ok(line, 'the test reached freshStart; the child\'s output:\n' + r.out);
  const fresh = JSON.parse(line.slice('FRESH '.length));
  const box = path.dirname(r.home);
  assert.deepEqual(fresh.asked, [{ source: path.join(box, 'bundle', 'Plain Sight test copy.app'), destination: path.join(box, 'evidence', 'fresh-copies', '1761000020000'), stamp: 1761000020000 }], 'makeTestCopy was asked once, for a copy of the bundle under test, into the run\'s evidence folder');
  assert.equal(fresh.made.identifier, 'com.pranavongole.plainsight.testcopy-1761000020000', 'the next launch opens the fresh copy');
  assert.deepEqual(fresh.removed, [], 'nothing was removed for the first launch');
  for (const id of [TEST_COPY, 'com.pranavongole.plainsight.testcopy-1761000020000']) assert.ok(r.out.includes('test data left behind: ' + path.join(CONTAINERS(r.home), id) + ' ('), id + ' is named as left behind; the child\'s output:\n' + r.out);
  const listed = r.out.split('\n').find((l) => l.startsWith('Test containers on this Mac at the end of the run'));
  assert.ok(listed && listed.includes(TEST_COPY) && listed.includes('com.pranavongole.plainsight.testcopy-1761000020000'), 'both are listed by name: ' + listed);
  assert.match(r.out, /^2 passed, 0 failed, 0 not run, 2 total\. Errors: 0$/m);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a fresh copy never takes an identifier whose folders are there already: it takes the next stamp and leaves that folder alone (DM-247)', async () => {
  const r = await runCase('run-fresh-start-taken', undefined, { app: TEST_COPY });
  ended(r, 0);
  const line = r.out.split('\n').find((l) => l.startsWith('FRESH '));
  assert.ok(line, 'the child\'s output:\n' + r.out);
  assert.equal(JSON.parse(line.slice('FRESH '.length)).made.identifier, 'com.pranavongole.plainsight.testcopy-1761000030001');
  assert.equal(readFileSync(marker(path.join(CONTAINERS(r.home), 'com.pranavongole.plainsight.testcopy-1761000030000')), 'utf8'), 'ANOTHER RUN\'S CONTAINER', 'the container that was there is untouched');
  clean(r);
});
test('a test that needs a first launch of an unsandboxed bundle still gets its folders cleared, and no copy (DM-247)', async () => {
  const r = await runCase('run-fresh-start-unsandboxed');
  ended(r, 0);
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m, 'the child\'s output:\n' + r.out);
  clean(r);
});

// QA-G-36 and DISH-G-70: guards of round 7 that no case above holds. Eleven
// of QA-01's harness cases on 534f3cc (wave-g/qa/scripts/app/r7_harness_adv.mjs:
// H4, H5, H6, H7, H8b, H8c, H8d, H13b, H22, H26 and H28, with its
// expectations), the Delivery Manager's AT-H1 to AT-H4
// (dm-appstore-534f3cc/adv/tests534/desktop/tests/dm-harness-adv-534.mjs)
// and DISH-G-70's breaks R1 to R7: each case below goes red on a break of
// harness.mjs that the cases above let through.
const PROBE = 'com.pranavongole.plainsight.sbprobe-1761000009';
test('a test copy\'s container that macOS refuses with EACCES is test data left behind as well: exit code 8 (QA-01 H4, DISH-G-70 R3)', async () => {
  const r = await runCase('run-test-container-eacces', undefined, { app: TEST_COPY });
  ended(r, 8);
  assert.ok(r.out.includes('test data left behind: ' + path.join(CONTAINERS(r.home), TEST_COPY) + ' (macOS refused to remove it;'), 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^Exit code: 8 \(test data left behind; your own data is back\)$/m);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a sandbox probe\'s container (sbprobe-) that macOS keeps is test data left behind too: exit code 8, listed by name (QA-01 H5, DISH-G-70 R6)', async () => {
  const r = await runCase('run-probe-container-refused', undefined, { app: PROBE });
  ended(r, 8);
  assert.ok(r.out.includes('test data left behind: ' + path.join(CONTAINERS(r.home), PROBE) + ' (macOS refused to remove it;'), 'the child\'s output:\n' + r.out);
  assert.match(r.out, new RegExp('^Test containers on this Mac at the end of the run \\(names only, never opened\\): ' + esc(PROBE) + '$', 'm'), 'the summary lists it by name; the child\'s output:\n' + r.out);
  clean(r);
});
test('a failed test with test data left behind ends with 1, not 8, and the leftover is still named (QA-01 H6, the Delivery Manager\'s AT-H4, DISH-G-70 R7)', async () => {
  const r = await runCase('run-leftover-and-failure', undefined, { app: TEST_COPY });
  ended(r, 1);
  assert.ok(r.out.includes('test data left behind: ' + path.join(CONTAINERS(r.home), TEST_COPY)), 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^1 passed, 1 failed, 0 not run, 2 total\. Errors: 1$/m);
  assert.match(r.out, /^Exit code: 1$/m);
  clean(r);
});
test('a stop with test data left behind ends with 3, not 8, and the leftover is still named (the Delivery Manager\'s AT-H3, QA-01 H7, DISH-G-70 R7)', async () => {
  const r = await runCase('run-leftover-and-stop', undefined, { app: TEST_COPY });
  ended(r, 3);
  assert.ok(r.out.includes('test data left behind: ' + path.join(CONTAINERS(r.home), TEST_COPY)), 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^skip - a later test \(not run: keyboard or mouse used during the run/m, 'the test after the stop is not run');
  assert.match(r.out, /^1 passed, 0 failed, 2 not run, 3 total\. Errors: 0$/m);
  assert.match(r.out, /^Exit code: 3$/m);
  clean(r);
});
test('a test copy\'s folder that was there before the run, which the run moved aside and macOS refuses on the way back, is no leftover: exit code 6, its earlier data kept in the backup (QA-01 H8b, DISH-G-70 R4)', async () => {
  const r = await runCase('run-copy-caches-kept', undefined, { app: TEST_COPY });
  ended(r, 6);
  const caches = path.join(r.home, 'Library', 'Caches', TEST_COPY);
  assert.ok(r.out.includes('Could not restore app data: could not clear the test data in ' + caches + ' (EPERM)'), 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /test data left behind/, 'what was there before the run is never taken for a leftover');
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m);
  assert.equal(r.backups.length, 1, 'the backup is kept');
  const backup = path.join(BACKUP_ROOT(r.home), r.backups[0]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(backup, 'moved.json'), 'utf8')), [caches], 'moved.json lists the folder whose earlier data waits there');
  assert.equal(readFileSync(marker(path.join(backup, Buffer.from(caches).toString('base64url'))), 'utf8'), 'OLD TEST DATA OF AN EARLIER RUN', 'and that data is in the backup');
  assert.ok(r.intact, 'the person\'s folders came back');
  assert.equal(r.lock, false, 'the lock is released');
});
test('the real identifier\'s container, made by the run and refused on removal, is never test data left behind: exit code 6, loud (QA-01 H8c: the D-39 trap must not pass for a leftover)', async () => {
  const r = await runCase('run-real-container-made', undefined, { app: TEST_COPY });
  ended(r, 6);
  assert.ok(r.out.includes('Could not restore app data: could not clear the test data in ' + path.join(CONTAINERS(r.home), 'com.pranavongole.plainsight') + ' (EPERM)'), 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /test data left behind/);
  assert.doesNotMatch(r.out, /^Exit code: 8/m);
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 1$/m);
  assert.ok(r.intact, 'the person\'s folders came back');
  assert.equal(r.lock, false, 'the lock is released');
});
test('the real identifier\'s cookie file, made by the run and refused on removal, is never test data left behind either: a name that starts with the real identifier and a dot is not a test identifier (QA-01 H8d)', async () => {
  const r = await runCase('run-real-cookies-made', undefined, { app: TEST_COPY });
  ended(r, 6);
  assert.ok(r.out.includes('Could not restore app data: could not clear the test data in ' + path.join(r.home, 'Library', 'HTTPStorages', 'com.pranavongole.plainsight.binarycookies') + ' (EPERM)'), 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /test data left behind/);
  assert.doesNotMatch(r.out, /^Exit code: 8/m);
  assert.ok(r.intact, 'the person\'s folders came back');
});
test('a locked screen at the start does not keep a suite that does not need it unlocked from running: the run starts and passes (QA-01 H13b)', async () => {
  const r = await runCase('run-locked-not-needed');
  ended(r, 0);
  assert.match(r.out, /^1 passed, 0 failed, 0 not run, 1 total\. Errors: 0$/m, 'the child\'s output:\n' + r.out);
  clean(r);
});
test('the screen locking during a run that needs it unlocked stops the run: exit code 3, the later test not run, the data back, the lock released (QA-01 H22, the Delivery Manager\'s AT-H1, DM-246 HL1)', async () => {
  const r = await runCase('run-locks-midway');
  ended(r, 3);
  assert.match(r.out, /^stop - a test during which the screen locks \(the screen locked during the run\)$/m, 'the child\'s output:\n' + r.out);
  assert.match(r.out, /^skip - a later test \(not run: the screen locked during the run\)$/m);
  assert.match(r.out, /^0 passed, 0 failed, 2 not run, 2 total\. Errors: 0$/m);
  clean(r);
  assert.equal(r.lock, false, 'the lock is released');
});
test('a window on-screen for the whole first wait that never meets it is the app\'s failure, not a locked screen: exit code 1 (QA-01 H26, DISH-G-70 R1)', async () => {
  const r = await runCase('run-onscreen-unmatched');
  ended(r, 1);
  assert.match(r.out, /^FAIL - a launch waits for two windows on screen$/m, 'the child\'s output:\n' + r.out);
  assert.match(r.out, /timed out after 700 ms waiting for two windows/, 'the wait\'s own timeout is the failure');
  assert.doesNotMatch(r.out, /every window is off-screen/);
  clean(r);
});
test('a window on-screen and then lost before the first wait is met is a failure as well, not a not-run stop (the Delivery Manager\'s AT-H2, DISH-G-70 R1)', async () => {
  const r = await runCase('run-onscreen-then-lost');
  ended(r, 1);
  assert.match(r.out, /^FAIL - a launch waits for its first window$/m, 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /every window is off-screen/);
  clean(r);
});
test('a window of the document\'s size on another layer, off-screen, is not the document window: the app\'s failure, exit code 1 (QA-01 H28, DISH-G-70 R2)', async () => {
  const r = await runCase('run-big-window-other-layer');
  ended(r, 1);
  assert.match(r.out, /^FAIL - a launch waits for its first window$/m, 'the child\'s output:\n' + r.out);
  assert.doesNotMatch(r.out, /every window is off-screen/);
  clean(r);
});

// The tests whose names match PLAIN_SIGHT_SAFETY_ONLY, a regular expression,
// and no other, for a break that must run alone (PO-R18-1, round 19); the
// output says so before the first test and after the summary, so a part is
// never taken for the whole suite.
const ONLY = process.env.PLAIN_SIGHT_SAFETY_ONLY ? new RegExp(process.env.PLAIN_SIGHT_SAFETY_ONLY) : null;
const chosen = ONLY ? tests.filter((t) => ONLY.test(t.name)) : tests;
const partOnly = ONLY ? 'only the ' + chosen.length + ' of ' + tests.length + ' tests whose names match PLAIN_SIGHT_SAFETY_ONLY=' + process.env.PLAIN_SIGHT_SAFETY_ONLY : '';
if (ONLY) console.log(partOnly);
let passed = 0;
let failed = 0;
try {
  for (const t of chosen) {
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
} finally {
  // Any process a case left running (a stand-in app, a late writer, a pid
  // holder or the proof case's stand-ins), ended by its pid under the
  // parent's rule (endLeftovers, DM-269); until round 20 this was a
  // pkill -9 -f of each script's path.
  for (const r of ranCases) endLeftovers(r);
  rmSync(ROOT, { recursive: true, force: true });
}
if (existsSync(ROOT)) {
  failed += 1;
  console.log('FAIL - the temporary folder with every fake home in it is removed at the end: ' + ROOT + ' is still there');
} else {
  passed += 1;
  console.log('ok   - the temporary folder with every fake home in it is removed at the end');
}
// DM-269 (round 21): a pid the parent refused to end fails the run.
if (parentRefusals.length) {
  failed += 1;
  console.log('FAIL - the parent ended only what the cases started inside their own folders: it refused ' + parentRefusals.length + ': ' + parentRefusals.join('; '));
} else {
  passed += 1;
  console.log('ok   - the parent ended only what the cases started inside their own folders, and refused nothing');
}
console.log(`\n${passed} passed, ${failed} failed, ${chosen.length + 2} total. Errors: ${failed}`);
if (ONLY) console.log(partOnly);
process.exit(failed ? 1 : 0);
