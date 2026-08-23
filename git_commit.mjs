import { execSync } from 'node:child_process';
import fs from 'node:fs';

const cwd = 'G:/Project/arbor';
execSync('git config user.email "arbor@tree-shaped.dev"', { cwd });
execSync('git config user.name "ARBOR"', { cwd });

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
execSync('git add -A', { cwd });
execSync('git commit -F .git_msg.txt', { cwd });
fs.unlinkSync('.git_msg.txt');

console.log(execSync('git log --oneline', { cwd, encoding: 'utf8' }).trim());
const count = execSync('git ls-files --cached', { cwd, encoding: 'utf8' }).split('\n').filter(Boolean).length;
console.log('files tracked:', count);
