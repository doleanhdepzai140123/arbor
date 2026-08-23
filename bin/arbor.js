#!/usr/bin/env node
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
const fs = { readFileSync, existsSync, statSync, writeFileSync };
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { parse } from '../src/parser.js';
import { checkProgram } from '../src/checker.js';
import { Interpreter } from '../src/interp.js';
import { tokenize } from '../src/lexer.js';
import { lowerToCSharp } from '../src/compiler/cs_backend.js';
import { loadProgram } from '../src/loader.js';
import { Fmt } from '../src/formatter.js';
import { ArborError, renderError } from '../src/diagnostics.js';

const VERSION = '0.2.0';
function findCsc() {
  if (process.env.ARBOR_CSC) return process.env.ARBOR_CSC;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
        'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
      ]
    : ['/usr/bin/csc', '/usr/bin/mcs', '/usr/local/bin/mcs', '/usr/bin/mono-csc'];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  const which = process.platform === 'win32' ? 'where' : 'which';
  for (const name of ['csc', 'mcs']) {
    try {
      const probe = execFileSync(which, [name], { encoding: 'utf8' });
      const first = probe.trim().split(/\r?\n/)[0];
      if (first) return first;
    } catch (_) { /* not found */ }
  }
  return null;
}

function usage() {
  console.log(`arbor ${VERSION} — the tree-shaped safe language

USAGE:
  arbor run <file.ab>      type-check and execute (reference VM)
  arbor build <file.ab>    compile to a native .exe via the C# back end
                           options: -o <out.exe>
  arbor check <file.ab>    type-check only (fast safety report)
  arbor fmt <file.ab>      print formatted source (--write to apply)
  arbor doc <file.ab>      print API documentation from /// comments
  arbor ast <file.ab>      dump the syntax tree
  arbor repl               interactive session
  arbor help               show this message`);
}

function pipeline(entryPath) {
  const loaded = loadProgram(entryPath);
  const file = entryPath;
  const src = fs.readFileSync(entryPath, 'utf8');
  const sources = new Map([[file, src]]);
  const prog = { ...loaded.entryProg, decls: loaded.decls, modules: loaded.modules };
  const result = checkProgram(prog, file);
  result.modules = loaded.modules;
  for (const w of result.warnings) {
    console.error(renderError(w, sources));
    console.error();
  }
  if (result.errors.length) {
    for (const e of result.errors) {
      console.error(renderError(e, sources));
      console.error();
    }
    process.exit(1);
  }
  return { prog, result, sources };
}

function loadSource(arg) {
  if (!arg) {
    console.error('error: missing file argument');
    process.exit(2);
  }
  if (!existsSync(arg) || !statSync(arg).isFile()) {
    console.error(`error: file not found: ${arg}`);
    process.exit(2);
  }
  return readFileSync(arg, 'utf8');
}

function runPipeline(_src, file, { execute }) {
  const { prog, result, sources } = pipeline(file);
  process.argv.splice(2, process.argv.length - 2, ...rest.slice(1));
  if (!execute) {
    console.log(`ok — ${file} passes ARBOR safety checks`);
    return;
  }
  const interp = new Interpreter(result);
  try {
    interp.run();
  } catch (e) {
    fail(e, sources);
  }
}

function fail(e, sources) {
  if (e instanceof ArborError) {
    console.error(renderError(e, sources));
    console.error();
    process.exit(1);
  }
  console.error('internal error:', e && e.stack ? e.stack : e);
  process.exit(70);
}

function buildNative(arg, rest) {
  const { prog, result } = pipeline(arg);
  const cs = lowerToCSharp(result, prog);
  const outIdx = rest.indexOf('-o');
  const outExe = outIdx >= 0 ? rest[outIdx + 1] : arg.replace(/\.ab$/, '.exe');
  const csFile = outExe.replace(/\.exe$/, '.cs');
  writeFileSync(csFile, cs);
  const csc = findCsc();
  if (!csc) {
    console.log(`emitted ${csFile} — no C# compiler found (set ARBOR_CSC or install mono/.NET), compile manually with any C# compiler`);
    return;
  }
  try {
    const winPath = (p) => p.replace(/\//g, '\\');
    execFileSync(csc, ['/nologo', '/optimize+', `/out:${winPath(outExe)}`, '/t:exe', winPath(csFile)], { stdio: 'inherit' });
  } catch (e) {
    console.error('csc failed:', e.message);
    process.exit(1);
  }
  console.log(`built ${outExe}`);
}

function dumpAst(prog) {
  console.log(JSON.stringify(prog, (k, v) => (k === 'span' ? undefined : v), 2));
}

function repl() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'arbor> ' });
  let buffer = '';
  console.log(`arbor ${VERSION} repl — expressions echo their value; Ctrl+C to exit`);
  rl.prompt();
  rl.on('line', line => {
    buffer += line + '\n';
    const trimmed = buffer.trim();
    if (!trimmed) { rl.prompt(); return; }
    const openBraces = (trimmed.match(/{/g) || []).length - (trimmed.match(/}/g) || []).length;
    if (openBraces > 0) { rl.prompt(); return; }
    tryRunRepl(trimmed);
    buffer = '';
    rl.prompt();
  });
}

function tryRunRepl(input) {
  const isDeclish = /(^|\n)\s*(fn|struct|enum|use)\b/.test(input);
  const lastLineIsExpr = (() => {
    const lines = input.split('\n').map(s => s.trim()).filter(Boolean);
    const last = lines[lines.length - 1] ?? '';
    return !/^[}\)]$/.test(last) && !/^(let|var|return|break|continue|region|spawn|while|for)\b/.test(last);
  })();
  let wrapped;
  if (isDeclish || !lastLineIsExpr) {
    wrapped = `fn main() -> Unit {\n${input}\n}`;
  } else {
    const lines = input.split('\n').map(s => s.trim()).filter(Boolean);
    const last = lines.pop();
    const prefixLines = lines;
    const prefix = prefixLines.length ? prefixLines.join('\n') + '\n' : '';
    wrapped = `fn main() -> Unit {\n${prefix}println(${last})\n}`;
  }
  const sources = new Map([['<repl>', wrapped]]);
  try {
    const prog = parse(wrapped, '<repl>');
    const result = checkProgram(prog, '<repl>');
    for (const e of result.errors) console.log(renderError(e, sources));
    if (result.errors.length === 0) {
      const interp = new Interpreter(result);
      interp.run();
    }
  } catch (e) {
    if (e instanceof ArborError) console.log(renderError(e, sources));
    else console.log('internal error:', e.message);
  }
}

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case 'run':
  case undefined:
    runPipeline(null, rest[0] ?? '<input>', { execute: true });
    break;
  case 'build':
    buildNative(rest[0], rest.slice(1));
    break;
  case 'check':
    runPipeline(null, rest[0] ?? '<input>', { execute: false });
    break;
  case 'ast': {
    const f = rest[0];
    const src = loadSource(f);
    try {
      dumpAst(parse(src, f ?? '<input>'));
    } catch (e) {
      fail(e, new Map([[f ?? '<input>', src]]));
    }
    break;
  }
  case 'repl':
    repl();
    break;
  case 'fmt': {
    const f = rest[0];
    const src = loadSource(f);
    try {
      const prog = parse(src, f ?? '<input>');
      const formatted = new Fmt().program(prog);
      if (rest.includes('--write')) writeFileSync(f, formatted);
      else process.stdout.write(formatted);
    } catch (e) {
      fail(e, new Map([[f ?? '<input>', src]]));
    }
    break;
  }
  case 'doc': {
    const f = rest[0];
    const src = loadSource(f);
    try {
      const prog = parse(src, f ?? '<input>');
      const out = ['# ARBOR API Documentation', ''];
      for (const d of prog.decls) {
        if (d.k === 'fn') {
          out.push(`## fn ${d.name}()`);
          if (d.docs) out.push('', d.docs.split('\n').map(l => l.trim()).join('  \n'));
          const sig = d.params.map(p => `${p.name}: ${p.ty?.name ?? ''}`).join(', ');
          out.push('', '```', `fn ${d.name}(${sig})${d.retTy ? ' -> ' + d.retTy.name : ''}`, '```', '');
        } else if (d.k === 'struct') {
          out.push(`## struct ${d.name}`, '', '```', `struct ${d.name} { ${d.fields.map(x => x.name + ': ' + (x.ty.name ?? '')).join(', ')} }`, '```', '');
        } else if (d.k === 'enum') {
          out.push(`## enum ${d.name}`, '', '```', `enum ${d.name} { ${d.variants.map(v => v.name).join(', ')} }`, '```', '');
        }
      }
      console.log(out.join('\n'));
    } catch (e) {
      fail(e, new Map([[f ?? '<input>', src]]));
    }
    break;
  }
  case 'lsp': {
    import('../src/lsp.js').then(({ Server }) => new Server().start());
    break;
  }
  case 'help':
  case '--help':
  case '-h':
    usage();
    break;
  case '--version':
  case '-v':
    console.log(VERSION);
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    usage();
    process.exit(2);
}
