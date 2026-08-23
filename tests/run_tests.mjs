import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, 'cases');
const cli = join(here, '..', 'bin', 'arbor.js');

let pass = 0;
let fail = 0;
const failures = [];

for (const entry of readdirSync(casesDir).sort()) {
  if (!entry.endsWith('.ab')) continue;
  const file = join(casesDir, entry);
  const src = readFileSync(file, 'utf8');
  const isFail = entry.endsWith('.fail.ab');
  const res = spawnSync(process.execPath, [cli, 'run', file], { encoding: 'utf8' });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';

  if (isFail) {
    const codeFile = file.replace(/\.fail\.ab$/, '.fail.code');
    const wantCode = existsSync(codeFile) ? readFileSync(codeFile, 'utf8').trim() : null;
    if (res.status === 0) {
      fail++;
      failures.push(`${entry}: expected compile/runtime failure but program succeeded`);
      continue;
    }
    if (wantCode && !stderr.includes(`[${wantCode}]`) && !stdout.includes(`[${wantCode}]`)) {
      fail++;
      failures.push(`${entry}: expected error code [${wantCode}] in diagnostics:\n${stderr.slice(0, 600)}`);
      continue;
    }
    pass++;
    console.log(`PASS (rejects) ${entry}`);
  } else {
    const outFile = file.replace(/\.ab$/, '.out');
    const want = existsSync(outFile) ? readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n') : null;
    const got = stdout.replace(/\r\n/g, '\n');
    if (res.status !== 0) {
      fail++;
      failures.push(`${entry}: program failed:\n${stderr.slice(0, 800)}`);
      continue;
    }
    if (want !== null && got !== want) {
      fail++;
      failures.push(`${entry}: output mismatch\n--- want ---\n${want}\n--- got ---\n${got}`);
      continue;
    }
    pass++;
    console.log(`PASS ${entry}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.log(`\n[FAIL] ${f}`);
  process.exit(1);
}
