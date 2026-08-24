// Self-hosting parity: the ARBOR-written lexer (self/self_lexer.ab) must
// produce the exact same token stream as the reference lexer (src/lexer.js).
//
//   node tests/self_hosted.mjs
//
// Two modes are compared against the reference:
//   1. VM mode        — self_lexer.ab executed by the reference interpreter
//   2. native mode    — lexdump.ab compiled to a standalone .exe via the C#
//                       back end (skipped when no C# compiler is available)
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tokenize } from '../src/lexer.js';

const SAMPLE = 'tests/selfhost_sample.ab';

function decodeRef(v) {
  if (Array.isArray(v)) return v.map(p => p.str ?? '').join('');
  return v;
}

function normRow(row) {
  const sp1 = row.indexOf(' ');
  const sp2 = row.lastIndexOf(' ');
  if (sp1 < 0 || sp2 <= sp1) return row;
  const kind = row.slice(0, sp1);
  let value = row.slice(sp1 + 1, sp2);
  const line = row.slice(sp2 + 1);
  if (kind === 'float' || kind === 'int') value = String(Number(value));
  return `${kind} ${value} ${line}`;
}

function refRows() {
  const src = readFileSync(SAMPLE, 'utf8');
  return tokenize(src, SAMPLE)
    .filter(t => t.kind !== 'eof')
    .map(t => {
      const line = src.slice(0, t.span.start).split('\n').length;
      const raw = t.kind === 'string' ? JSON.stringify(decodeRef(t.value)) : String(t.value);
      return normRow(`${t.kind} ${raw} ${line}`);
    });
}

function vmRows() {
  const out = execFileSync(process.execPath, ['bin/arbor.js', 'run', 'self/lexdump.ab', SAMPLE], {
    encoding: 'utf8',
  });
  return out.split(/\r?\n/).filter(Boolean).map(normRow);
}

function findCsc() {
  if (process.env.ARBOR_CSC) return process.env.ARBOR_CSC;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
        'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
      ]
    : ['/usr/bin/csc', '/usr/bin/mcs'];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function nativeRows(csc) {
  const win = p => p.replace(/\//g, '\\');
  const exe = win('tests/selfhost_lexdump.exe');
  const cs = exe.replace(/\.exe$/, '.cs');
  rmSync(exe, { force: true });
  execFileSync('node', ['bin/arbor.js', 'build', 'self/lexdump.ab', '-o', exe], { stdio: 'pipe' });
  execFileSync(csc, ['/nologo', '/optimize+', `/out:${exe}`, '/t:exe', cs], { stdio: 'pipe' });
  const out = execFileSync(exe, [win(SAMPLE)], { encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean).map(normRow);
}

function diff(a, b) {
  const rows = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) rows.push(`  row ${i + 1}: expected ${JSON.stringify(a[i] ?? '<missing>')} got ${JSON.stringify(b[i] ?? '<missing>')}`);
  return rows.join('\n');
}

let failures = 0;

const REF = refRows();
console.log(`reference lexer: ${REF.length} tokens over ${SAMPLE}`);

for (const [name, rows] of [['VM (self-hosted lexer)', vmRows()]]) {
  if (rows.length === REF.length && rows.every((r, i) => r === REF[i])) {
    console.log(`PASS ${name}: ${rows.length} tokens match the reference exactly`);
  } else {
    failures++;
    console.error(`FAIL ${name}\n${diff(REF, rows)}`);
  }
}

const csc = findCsc();
if (csc) {
  try {
    const rows = nativeRows(csc);
    if (rows.length === REF.length && rows.every((r, i) => r === REF[i])) {
      console.log(`PASS native .exe (self-hosted lexer compiled via C# back end): ${rows.length} tokens match`);
    } else {
      failures++;
      console.error(`FAIL native .exe\n${diff(REF, rows)}`);
    }
  } catch (e) {
    failures++;
    console.error(`FAIL native .exe: ${e.message}\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
} else {
  console.log('SKIP native .exe (no C# compiler found)');
}

if (failures > 0) {
  console.error(`\n${failures} self-hosting parity check(s) failed`);
  process.exit(1);
}
console.log('\nself-hosting parity: all checks green');
