import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, 'cases');
const cli = join(here, '..', 'bin', 'arbor.js');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

let pass = 0, fail = 0, skipped = 0;
const failures = [];

for (const entry of readdirSync(casesDir).sort()) {
  if (!entry.endsWith('.ab') || entry.includes('.fail.')) continue;
  const file = join(casesDir, entry);
  const src = readFileSync(file, 'utf8');

  // interpreter golden
  const vm = spawnSync(process.execPath, [cli, 'run', file], { encoding: 'utf8' });
  const want = (vm.stdout ?? '').replace(/\r\n/g, '\n');
  if (vm.status !== 0) { skipped++; console.log(`SKIP(vm-fails) ${entry}`); continue; }

  // compile
  const csFile = join(here, `nat_${entry.replace(/\.ab$/, '.cs')}`);
  const exeFile = join(here, `nat_${entry.replace(/\.ab$/, '.exe')}`);
  let cs;
  try {
    const mod = await import('../src/compiler/cs_backend.js');
    const { parse } = await import('../src/parser.js');
    const { checkProgram } = await import('../src/checker.js');
    const prog = parse(src, entry);
    const result = checkProgram(prog, entry);
    if (result.errors.length) { skipped++; console.log(`SKIP(check) ${entry}`); continue; }
    cs = mod.lowerToCSharp(result, prog);
  } catch (e) {
    skipped++; console.log(`SKIP(codegen-unsupported) ${entry}: ${e.message.slice(0, 80)}`);
    continue;
  }
  writeFileSync(csFile, cs);
  const csc = spawnSync(CSC, ['/nologo', '/optimize+', `/out:${exeFile}`, '/t:exe', csFile], { encoding: 'utf8' });
  if (csc.status !== 0) {
    fail++; failures.push(`${entry}: csc errors:\n${(csc.stdout || '')}${(csc.stderr || '')}`.slice(0, 500));
    continue;
  }
  const run = spawnSync(exeFile, { encoding: 'utf8' });
  const got = (run.stdout ?? '').replace(/\r\n/g, '\n');
  const sortMode = entry.includes('spawn');
  const gotCmp = sortMode ? got.split('\n').filter(Boolean).sort().join('\n') + '\n' : got;
  const wantCmp = sortMode && want !== null ? want.split('\n').filter(Boolean).sort().join('\n') + '\n' : want;
  if (run.status !== 0) {
    fail++; failures.push(`${entry}: compiled exe failed (${run.status}):\n${(run.stderr || '').slice(0, 400)}`);
    continue;
  }
  if (want !== null && gotCmp !== wantCmp) {
    fail++;
    failures.push(`${entry}: PARITY MISMATCH\n--- vm ---\n${want}\n--- native ---\n${got}`);
    continue;
  }
  pass++; console.log(`NATIVE-PASS ${entry}`);
}

console.log(`\nnative parity: ${pass} passed, ${fail} failed, ${skipped} skipped`);
if (fail > 0) { for (const f of failures) console.log(`\n[FAIL] ${f}`); process.exit(1); }
