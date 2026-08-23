import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from '../src/parser.js';

// Loads entry file + all `use "./x.ab"` imports (recursive, cycle-safe).
// Module functions are renamed `stem__name` and registered under a module
// namespace so `math.add(...)` resolves to `ab_math__add` downstream.
export function loadProgram(entryPath) {
  const abs = resolve(entryPath);
  const modules = new Map();   // stem -> { name, decls, members: Map(member -> mangled) }
  const order = [];
  const loading = new Set();

  function loadFile(absPath) {
    if (modules.has(absPath)) return modules.get(absPath).name;
    if (loading.has(absPath)) throw new Error(`circular import involving ${absPath}`);
    if (!existsSync(absPath)) throw new Error(`imported file not found: ${absPath}`);
    loading.add(absPath);

    const src = readFileSync(absPath, 'utf8');
    const prog = parse(src, absPath);
    const stem = basename(absPath).replace(/\.ab$/, '');
    const safe = stem.replace(/[^A-Za-z0-9_]/g, '_');
    const members = new Map();

    const decls = [];
    for (const d of prog.decls) {
      if (d.k === 'useFile') {
        const childAbs = resolve(dirname(absPath), d.path);
        loadFile(childAbs);
        continue; // child decls are already in the merged program
      }
      if (d.k === 'use') continue; // std imports are re-emitted untouched below
      if (d.k === 'fn' && !d.name.includes('.')) {
        const mangled = `${safe}__${d.name}`;
        members.set(d.name, mangled);
        decls.push({ ...d, name: mangled });
        continue;
      }
      if (d.k === 'const') {
        const mangled = `${safe}__${d.name}`;
        members.set(d.name, mangled);
        decls.push({ ...d, name: mangled });
        continue;
      }
      // structs/enums/methods: not exported in v0.2 (documented limitation)
      throw new Error(
        `module '${stem}': only top-level functions and constants are exported ` +
        `(found '${d.k} ${d.name ?? ''}') — declare types in the entry file`);
    }
    modules.set(absPath, { name: safe, decls, members });
    order.push(absPath);
    loading.delete(absPath);
    return safe;
  }

  const entrySrc = readFileSync(abs, 'utf8');
  const entryProg = parse(entrySrc, abs);
  const entryDir = dirname(abs);

  // collect file imports from entry (recursively from imported files too)
  const fileImports = [];   // { path, stem }
  const seenStems = new Set();
  function collectFrom(prog, baseDir) {
    for (const d of prog.decls) {
      if (d.k !== 'useFile') continue;
      const childAbs = resolve(baseDir, d.path);
      const rawStem = basename(childAbs).replace(/\.ab$/, '');
      const stem = (d.alias ?? rawStem).replace(/[^A-Za-z0-9_]/g, '_');
      loadFile(childAbs);
      if (!seenStems.has(stem)) { seenStems.add(stem); fileImports.push({ stem, abs: childAbs }); }
      const childProg = parse(readFileSync(childAbs, 'utf8'), childAbs);
      collectFrom(childProg, dirname(childAbs));
    }
  }
  collectFrom(entryProg, entryDir);

  // merged decls: imported module fns (renamed) + entry decls (std `use` kept)
  const merged = [];
  const moduleRegistry = new Map();  // stem -> Map(member -> mangled)
  for (const { stem, abs: childAbs } of fileImports) {
    const mod = modules.get(childAbs);
    moduleRegistry.set(stem, mod.members);
    for (const d of mod.decls) merged.push(d);
  }
  for (const d of entryProg.decls) merged.push(d);

  return { decls: merged, modules: moduleRegistry, entryDir, entryAbs: abs };
}

function basename(p) { return p.split(/[\\/]/).pop(); }
