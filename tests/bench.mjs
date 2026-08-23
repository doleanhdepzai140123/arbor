import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

let src = '';
for (let i = 0; i < 200; i++) {
  src += `
fn gen_${i}(a: Int, b: Int) -> Int {
  var acc = 0
  var k = 0
  while k < ${i} {
    acc = acc + a * k - b
    k = k + 1
  }
  if acc < 0 { -acc } else { acc }
}
`;
}
src += '\nfn main() {\n';
for (let i = 0; i < 200; i++) {
  src += `  println("gen_${i} = {gen_${i}(${i}, ${i + 1})}")\n`;
}
src += '}\n';

writeFileSync('tests/big.ab', src);
console.log(`generated ${(src.length / 1024).toFixed(0)} KB, ~${src.split('\n').length} lines`);

const t0 = performance.now();
execSync('node bin/arbor.js check tests/big.ab', { stdio: 'pipe' });
const t1 = performance.now();
console.log(`check time: ${(t1 - t0).toFixed(0)} ms`);
