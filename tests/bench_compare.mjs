import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const t1 = performance.now();
spawnSync(process.execPath, ['bin/arbor.js', 'build', 'tests/bench_native.ab', '-o', 'tests/bench_native.exe'], { stdio: 'pipe' });
const buildTime = performance.now() - t1;

const runs = [];
for (let k = 0; k < 3; k++) {
  const t2 = performance.now();
  const exe = spawnSync('tests/bench_native.exe', { encoding: 'utf8' });
  runs.push(performance.now() - t2);
  if (k === 0) console.log('native out:', exe.stdout.trim().replace(/\n/g, ' | '));
}
const best = Math.min(...runs);
console.log('NATIVE best:', best.toFixed(0), 'ms  (build', buildTime.toFixed(0) + 'ms )');

const tv = performance.now();
const vm = spawnSync(process.execPath, ['bin/arbor.js', 'run', 'tests/bench_native.ab'], { encoding: 'utf8' });
const vmT = performance.now() - tv;
console.log('VM     :', vmT.toFixed(0), 'ms |', vm.stdout.trim().replace(/\n/g, ' | '));
console.log('SPEEDUP:', (vmT / best).toFixed(1) + 'x');
