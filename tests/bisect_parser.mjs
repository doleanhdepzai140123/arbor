import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const target = process.argv[2];
const lo = parseInt(process.argv[3] ?? '0');
const hi = parseInt(process.argv[4] ?? '0');
const full = fs.readFileSync(target, 'utf8').split('\n');
const end = hi > 0 ? hi : full.length;
const lines = full.slice(0, end);
const cuts = [];
for (let i = 0; i < lines.length; i++) if (lines[i] === '}') cuts.push(i + 1);
function fails(n) {
  const head = lines.slice(0, n).join('\n') + '\n';
  fs.writeFileSync('self/bisect_tmp.ab', head);
  try {
    const r = execFileSync(process.execPath, ['bin/arbor.js', 'run', 'self/parse_test_harness.ab'], { stdio: 'pipe', encoding: 'utf8' });
    return null;
  } catch (e) {
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    const m = out.match(/parse error:[^\n]*/);
    return m ? m[0].slice(0, 80) : 'FAIL';
  } finally { fs.unlinkSync('self/bisect_tmp.ab'); }
}
let prev = null;
for (const c of cuts) {
  const r = fails(c);
  if (r !== null) {
    console.log(`first failing cut at line ${c}: ${r}`);
    console.log('context:');
    for (let k = Math.max(0, c - 6); k < Math.min(c + 4, lines.length); k++) console.log(`${k+1}: ${lines[k]}`);
    process.exit(0);
  }
  prev = c;
}
console.log(`all ${cuts.length} prefixes pass (last=${prev})`);
