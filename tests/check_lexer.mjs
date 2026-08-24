import { parse } from '../src/parser.js';
import { checkProgram } from '../src/checker.js';
import fs from 'node:fs';

const src = fs.readFileSync('self/self_lexer.ab', 'utf8');
const prog = parse(src, 'self_lexer.ab');
console.log('parse OK:', prog.decls.length, 'decls');
const result = checkProgram(prog, 'self_lexer.ab');
console.log('errors:', result.errors.length);
for (const e of result.errors) {
  console.log(`  [${e.code}] ${e.message}`);
  if (e.span) {
    const lines = src.split('\n');
    const line = src.slice(0, e.span.start).split('\n').length - 1;
    console.log(`    at line ${line + 1}: ${JSON.stringify((lines[line] ?? '').trim().slice(0, 70))}`);
  }
}
console.log('warnings:', result.warnings.length);
for (const w of result.warnings) {
  console.log(`  [${w.code}] ${w.message}`);
}
