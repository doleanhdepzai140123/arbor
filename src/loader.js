import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseWithKnownStructs } from '../src/parser.js';

// Pre-scan a source text for `use "..."` file imports (text-level; the
// import grammar only appears at line starts in practice).
function scanUsePaths(src) {
  const out = [];
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\s*use\s+"([^"]+)"/);
    if (m) out.push(m[1]);
  }
  return out;
}

// Collect struct names across a set of sources so struct literals of
// imported types parse everywhere (see parser.parseWithKnownStructs).
function collectStructNames(src, set) {
  const re = /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) set.add(m[1]);
}

// Loads entry file + all `use "./x.ab"` imports (recursive, cycle-safe).
export function loadProgram(entryPath) {
  const abs = resolve(entryPath);

  // Phase A: gather all file texts following use-imports.
  const texts = new Map();   // absPath -> src
  const order = [];
  const loading = [];
  function gather(absPath) {
    if (texts.has(absPath)) return;
    if (!existsSync(absPath)) throw new Error(`imported file not found: ${absPath}`);
    loading.push(absPath);
    const src = readFileSync(absPath, 'utf8');
    texts.set(absPath, src);
    const dir = dirname(absPath);
    for (const rel of scanUsePaths(src)) {
      if (rel.startsWith('./')) gather(resolve(dir, rel));
    }
    loading.pop();
    order.push(absPath);
  }
  gather(abs);

  // Phase B: union of struct names across every file.
  const knownStructs = new Set();
  for (const src of texts.values()) collectStructNames(src, knownStructs);

  // Phase C: parse with the global struct-name set.
  const modules = new Map();   // stem -> { name, decls, members: Map(member -> mangled) }
  const declsByFile = new Map();

  function loadFile(absPath) {
    if (modules.has(absPath)) return modules.get(absPath).name;
    const stem = basename(absPath).replace(/\.ab$/, '');
    const safe = stem.replace(/[^A-Za-z0-9_]/g, '_');
    const members = new Map();
    const prog = parseWithKnownStructs(texts.get(absPath), absPath, knownStructs);

    const fileDecls = [];
    for (const d of prog.decls) {
      if (d.k === 'use' || d.k === 'useFile') continue;
      if (d.k === 'fn' && !d.name.includes('.')) {
        members.set(d.name, d.name);
        fileDecls.push(d);
        continue;
      }
      if (d.k === 'const') {
        members.set(d.name, d.name);
        fileDecls.push(d);
        continue;
      }
      // structs/enums/methods pass through unchanged
      fileDecls.push(d);
    }
    declsByFile.set(absPath, fileDecls);
    modules.set(absPath, { name: safe, decls: fileDecls, members });
    return safe;
  }

  for (const p of order) loadFile(p);

  // merged decls: imported module fns + entry decls
  const merged = [];
  const moduleRegistry = new Map();  // stem -> Map(member -> mangled)
  for (const p of order.slice(0)) {
    const mod = modules.get(p);
    if (p !== abs) moduleRegistry.set(mod.name, mod.members);
  }
  // imported files first (dependency order), entry last
  for (const p of order) {
    if (p === abs) continue;
    for (const d of modules.get(p).decls) merged.push(d);
  }
  const entryProg = parseWithKnownStructs(texts.get(abs), abs, knownStructs);
  for (const d of entryProg.decls) merged.push(d);

  return { decls: merged, modules: moduleRegistry, entryDir: dirname(abs), entryAbs: abs, entryProg };
}

function basename(p) { return p.split(/[\\/]/).pop(); }
