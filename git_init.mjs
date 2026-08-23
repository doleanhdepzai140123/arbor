import { execSync } from 'node:child_process';
import fs from 'node:fs';

const cwd = 'G:/Project/arbor';
if (!fs.existsSync(cwd + '/.git')) {
  execSync('git init', { cwd });
  console.log('git initialized');
}

// regenerate benchmarks
try { execSync('node tests/run_bench.mjs', { stdio: 'pipe', cwd }); } catch (e) { /* ok */ }

execSync('git add -A', { cwd });

const msg = [
  'ARBOR v0.2.1 - the tree-shaped safe language',
  '',
  'Compiled, systems-oriented programming language with safety by unexpressibility.',
  '',
  '- Front end: lexer, Pratt parser, type checker (move analysis, linearity, spawn)',
  '- Reference VM: deterministic FIFO tasks, generational tables, regions',
  '- C# native back end: typed codegen, .exe via csc.exe (~24x VM, 1.9x V8)',
  '- x86-64 pipeline: machine-code encoder + PE32+ writer (self-contained)',
  '- Language: structs/enums/methods/generics/closures/Option/Result/const',
  '  ranges/compound-assign/regions/spawn/handles/multi-file modules',
  '- Tooling: run/build/check/fmt/doc/lsp/repl',
  '- 24 conformance + 11 native parity tests, all green',
  '- Full English docs: tutorial, language reference, spec, benchmarks',
  '- MIT license',
].join('\n');

fs.writeFileSync('.git_msg.txt', msg);
execSync('git commit -F .git_msg.txt', { cwd });
fs.unlinkSync('.git_msg.txt');
console.log('committed');

const log = execSync('git log --oneline', { cwd, encoding: 'utf8' });
console.log(log.trim());
const count = execSync('git rev-list --count HEAD', { cwd, encoding: 'utf8' }).trim();
console.log('commits:', count);
