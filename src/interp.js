import {
  UNIT, mkArr, mkTblV, mkEnumV, someOf, noneOf, okOf, errOf,
  fmtValue, cloneCopy, makeMethodRunner, encodeKey, decodeKey,
  mkF, unF, isFloatV, isIntV,
} from './runtime.js';import { ArborError } from './diagnostics.js';
import * as nodeFs from 'node:fs';
import * as nodeChild from 'node:child_process';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_DEPTH = 2000;
const BUILTIN_GENERIC_TYPES = new Set(['Array', 'Map', 'Set', 'Table', 'Handle', 'Option', 'Result']);

class Env {
  constructor(parent) {
    this.parent = parent;
    this.vars = new Map();
  }
  lookup(name) {
    let e = this;
    while (e) {
      if (e.vars.has(name)) return e.vars.get(name);
      e = e.parent;
    }
    return undefined;
  }
  has(name) {
    return this.lookup(name) !== undefined;
  }
  define(name, slot) {
    this.vars.set(name, slot);
  }
  assign(name, value, span) {
    let e = this;
    while (e) {
      const slot = e.vars.get(name);
      if (slot) {
        if (!slot.mutable) {
          throw new ArborError({
            code: 'R0012',
            message: `runtime mutation of immutable binding \`${name}\``,
            span,
          });
        }
        slot.value = value;
        return;
      }
      e = e.parent;
    }
    throw new Error(`unbound name at runtime: ${name}`);
  }
}

class ReturnSig { constructor(value) { this.value = value; } }
class BreakSig {}
class ContinueSig {}

export class Interpreter {
  constructor(checkResult) {
    this.globals = new Env(null);
    this.checkResult = checkResult;
    this.taskQueue = [];
    this.depth = 0;
    this.regionStack = [];
    this.allocTotal = 0;
    this.output = [];
    this.runMethod = makeMethodRunner({
      invoke: (callee, args, span) => this.applyCallable(callee, args, span),
    });

    const g = this.globals;
    g.define('println', { mutable: true, value: { arb: 'bif', path: 'std.io.println' } });
    g.define('print', { mutable: true, value: { arb: 'bif', path: 'std.io.print' } });
    g.define('dbg', { mutable: true, value: { arb: 'bif', path: 'std.io.dbg' } });
    g.define('drop', { mutable: true, value: { arb: 'bif', path: 'drop' } });
    g.define('assert', { mutable: true, value: { arb: 'bif', path: 'assert' } });
    g.define('assert_eq', { mutable: true, value: { arb: 'bif', path: 'assert_eq' } });
    g.define('Some', { mutable: true, value: { arb: 'ctor', enumName: 'Option', variant: 'Some', arity: 1 } });
    g.define('None', { mutable: true, value: { arb: 'ctor', enumName: 'Option', variant: 'None', arity: 0 } });
    g.define('Ok', { mutable: true, value: { arb: 'ctor', enumName: 'Result', variant: 'Ok', arity: 1 } });
    g.define('Err', { mutable: true, value: { arb: 'ctor', enumName: 'Result', variant: 'Err', arity: 1 } });
    const bif = path => ({ arb: 'bif', path });
    const mod = (path, members) => ({ arb: 'module', path, members });
    g.define('std', {
      mutable: false,
      value: mod('std', {
        io: mod('std.io', {
          println: bif('std.io.println'),
          print: bif('std.io.print'),
          dbg: bif('std.io.dbg'),
          to_str: bif('std.io.to_str'),
        }),
        math: mod('std.math', {
          sqrt: bif('std.math.sqrt'),
          floor: bif('std.math.floor'),
          ceil: bif('std.math.ceil'),
          round: bif('std.math.round'),
          abs: bif('std.math.abs'),
          pow: bif('std.math.pow'),
          exp: bif('std.math.exp'),
          ln: bif('std.math.ln'),
          sin: bif('std.math.sin'),
          cos: bif('std.math.cos'),
          pi: { arb: 'const', value: Math.PI },
          e: { arb: 'const', value: Math.E },
        }),
        fs: mod('std.fs', {
          read_file: bif('std.fs.read_file'),
          write_file: bif('std.fs.write_file'),
        }),
        time: mod('std.time', {
          now_ms: bif('std.time.now_ms'),
        }),
        env: mod('std.env', {
          args: bif('std.env.args'),
        }),
        mem: mod('std.mem', {
          live: bif('std.mem.live'),
          allocs: bif('std.mem.allocs'),
        }),
      }),
    });

    const programScopeValues = checkResult.programScope.values;
    this.userFns = new Map();
    const moduleSyms = [];
    for (const [name, sym] of programScopeValues) {
      if (sym.symKind === 'userModule') moduleSyms.push([name, sym]);
      if (sym.symKind === 'fnDecl') {
        const fnVal = { arb: 'userfn', decl: sym.decl, env: g, name };
        this.userFns.set(name, fnVal);
        if (!name.includes('.')) g.define(name, { mutable: false, value: fnVal });
      } else if (sym.symKind === 'enumType') {
        const variants = new Map(sym.decl.variants.map(v => [v.name, v.tys.length]));
        g.define(name, { mutable: false, value: { arb: 'userenum', name: sym.decl.name, variants } });
        for (const v of sym.decl.variants) {
          if (!g.has(v.name)) {
            g.define(v.name, { mutable: false, value: { arb: 'ctor', enumName: sym.decl.name, variant: v.name, arity: v.tys.length } });
          }
        }
      } else if (sym.symKind === 'userVariant') {
        if (!g.has(name)) {
          g.define(name, { mutable: false, value: { arb: 'ctor', enumName: sym.enumDecl.name, variant: sym.variant.name, arity: sym.variant.tys.length } });
        }
      } else if (sym.symKind === 'constDecl') {
        let v = sym.value;
        if (typeof v === 'number' && !Number.isInteger(v)) v = mkF(v);
        g.define(name, { mutable: false, value: v });
      } else if (sym.symKind === 'bif') {
        g.define(name, { mutable: false, value: { arb: 'bif', path: sym._path ?? name } });
      } else if (sym.symKind === 'const') {
        g.define(name, { mutable: false, value: { arb: 'const', value: constValueOf(sym._path) } });
      } else if (sym.symKind === 'module') {
        g.define(name, { mutable: false, value: buildRuntimeModule(sym.name, sym.members) });
      }
    }

    for (const [name, sym] of moduleSyms) {
      const rtMembers = {};
      for (const [member, mangled] of sym.members) {
        const fnVal = this.userFns.get(mangled);
        if (fnVal) rtMembers[member] = fnVal;
      }
      g.define(name, { mutable: false, value: { arb: 'module', path: name, members: rtMembers } });
    }

    function buildRuntimeModule(path, members) {
      const out = {};
      for (const [k, v] of Object.entries(members)) {
        if (v && typeof v === 'object' && !('symKind' in v)) {
          out[k] = buildRuntimeModule(`${path}.${k}`, v);
        } else if (v?.symKind === 'bif') {
          out[k] = { arb: 'bif', path: v._path ?? `${path}.${k}` };
        } else if (v?.symKind === 'const') {
          out[k] = { arb: 'const', value: constValueOf(v._path ?? `${path}.${k}`) };
        }
      }
      return { arb: 'module', path, members: out };
    }

    function constValueOf(path) {
      switch (path) {
        case 'std.math.pi': return Math.PI;
        case 'std.math.e': return Math.E;
        default: return UNIT;
      }
    }

  }

  buildModule(path, spec) {
    void path; void spec;
    return { arb: 'module', path, members: {} };
  }

  write(text) {
    this.output.push(text);
    process.stdout.write(text);
  }

  run() {
    const mainFn = this.userFns.get('main');
    if (!mainFn) {
      throw new ArborError({ code: 'A0032', message: 'no main function to run' });
    }
    this.regionStack.push({ name: 'main', count: 0 });
    try {
      this.invokeUser(mainFn, [], null);
    } finally {
      this.regionStack.pop();
    }
    while (this.taskQueue.length) {
      const t = this.taskQueue.shift();
      this.regionStack.push({ name: `task`, count: 0 });
      try {
        this.execBlock(t.block, t.env);
      } finally {
        this.regionStack.pop();
      }
    }
  }

  alloc() {
    this.allocTotal++;
    const top = this.regionStack[this.regionStack.length - 1];
    if (top) top.count++;
  }

  memLive() {
    let n = 0;
    for (const r of this.regionStack) n += r.count;
    return n;
  }

  invokeUser(fnVal, argVals, span) {
    if (this.depth >= MAX_DEPTH) {
      throw new ArborError({ code: 'R0007', message: `call stack overflow (depth > ${MAX_DEPTH})`, span });
    }
    const d = fnVal.decl;
    const env = new Env(fnVal.env);
    d.params.forEach((p, i) => {
      env.define(p.name, { mutable: p.mode !== 'in', value: argVals[i] });
    });
    this.depth++;
    try {
      const v = this.execBlock(d.body, env);
      return v === undefined ? UNIT : v;
    } catch (sig) {
      if (sig instanceof ReturnSig) return sig.value ?? UNIT;
      throw sig;
    } finally {
      this.depth--;
    }
  }

  applyCallable(callee, args, span) {
    switch (callee.arb) {
      case 'userfn':
        return this.invokeUser(callee, args, span);
      case 'closure': {
        if (this.depth >= MAX_DEPTH) {
          throw new ArborError({ code: 'R0007', message: `call stack overflow (depth > ${MAX_DEPTH})`, span });
        }
        const env = new Env(callee.env);
        callee.params.forEach((name, i) => {
          env.define(name, { mutable: false, value: args[i] });
        });
        this.depth++;
        try {
          if (callee.isExpr) return this.evalExpr(callee.body, env);
          try {
            return this.execBlock(callee.body, env);
          } catch (sig) {
            if (sig instanceof ReturnSig) return sig.value ?? UNIT;
            throw sig;
          }
        } finally {
          this.depth--;
        }
      }
      case 'bif':
        return this.runBuiltin(callee.path, args, span);
      case 'ctor': {
        const n = args.length;
        if (n !== callee.arity) {
          throw new ArborError({ code: 'A0009', message: `${callee.enumName}.${callee.variant} expects ${callee.arity} payload(s), got ${n}`, span });
        }
        return mkEnumV(callee.enumName, callee.variant, args);
      }
      default:
        throw new ArborError({ code: 'A0029', message: `value of type \`${fmtValue(callee)}\` is not callable`, span });
    }
  }

  runBuiltin(path, args, span) {
    switch (path) {
      case 'std.io.println':
        this.write(`${fmtValue(args[0])}\n`);
        return UNIT;
      case 'std.io.print':
        this.write(fmtValue(args[0]));
        return UNIT;
      case 'std.io.dbg':
        this.write(`[dbg] ${fmtValue(args[0], true)}\n`);
        return UNIT;
      case 'std.io.to_str':
        return fmtValue(args[0]);
      case 'drop':
        return UNIT;
      case 'assert':
        if (args[0] !== true) {
          throw new ArborError({ code: 'R0050', message: 'assertion failed', span });
        }
        return UNIT;
      case 'assert_eq': {
        const [a, b] = args;
        const eq = typeof a === 'string' && typeof b === 'string' ? a === b
          : (a?.arb) === (b?.arb) && JSON.stringify(a) === JSON.stringify(b);
        if (!eq) {
          throw new ArborError({ code: 'R0051', message: `assert_eq failed: ${fmtValue(a, true)} != ${fmtValue(b, true)}`, span });
        }
        return UNIT;
      }
      case 'std.math.sqrt': return mkF(Math.sqrt(unF(args[0])));
      case 'std.math.floor': return mkF(Math.floor(unF(args[0])));
      case 'std.math.ceil': return mkF(Math.ceil(unF(args[0])));
      case 'std.math.round': return mkF(Math.round(unF(args[0])));
      case 'std.math.abs': return mkF(Math.abs(unF(args[0])));
      case 'std.math.pow': return mkF(Math.pow(unF(args[0]), unF(args[1])));
      case 'std.math.exp': return mkF(Math.exp(unF(args[0])));
      case 'std.math.ln': return mkF(Math.log(unF(args[0])));
      case 'std.math.sin': return mkF(Math.sin(unF(args[0])));
      case 'std.math.cos': return mkF(Math.cos(unF(args[0])));
      case 'std.fs.read_file': {
        try {
          const txt = nodeFs.readFileSync(String(args[0]), 'utf8');
          return okOf(txt);
        } catch (errAny) {
          return errOf(String(errAny.message ?? errAny));
        }
      }
      case 'std.fs.write_file': {
        try {
          nodeFs.writeFileSync(String(args[0]), String(args[1]));
          return okOf(String(args[1]).length);
        } catch (errAny) {
          return errOf(String(errAny.message ?? errAny));
        }
      }
      case 'std.time.now_ms':
        return Date.now();
      case 'std.env.args':
        return { arb: 'array', items: process.argv.slice(2).map(s => String(s)) };
      case 'std.fs.read_file': {
        try { return okOf(nodeFs.readFileSync(String(args[0]), 'utf8')); }
        catch (e2) { return errOf(String(e2.message ?? e2)); }
      }
      case 'std.process.exec': {
        try {
          const cmd = String(args[0]);
          const rest = args.slice(1).map(s => String(s));
          const outBuf = nodeChild.execFileSync(cmd, rest, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          return okOf(String(outBuf));
        } catch (e3) { return errOf(String(e3.message ?? e3)); }
      }
      case 'std.fs.write_file': {
        try { nodeFs.writeFileSync(String(args[0]), String(args[1])); return okOf(String(args[1]).length); }
        catch (e2) { return errOf(String(e2.message ?? e2)); }
      }
      case 'std.time.now_ms':
        return Date.now();
      case 'std.env.args':
        return { arb: 'array', items: process.argv.slice(2).map(s => String(s)) };
      case 'std.mem.live':
        return this.memLive();
      case 'std.mem.allocs':
        return this.allocTotal;
      default:
        throw new ArborError({ code: 'A0029', message: `unknown builtin ${path}`, span });
    }
  }

  execBlock(block, env) {
    const inner = new Env(env);
    let last = UNIT;
    for (const st of block.stmts) {
      last = this.execStmt(st, inner);
    }
    while (this.taskQueue.length && this.depth === 0) {
      const t = this.taskQueue.shift();
      this.execSpawned(t);
    }
    return last;

    function noop() {}
    void noop;
  }

  execSpawned(t) {
    const prevDepth = this.depth;
    void prevDepth;
    try {
      this.execBlock(t.block, t.env);
    } catch (sig) {
      if (!(sig instanceof ReturnSig)) throw sig;
    }
  }

  execStmt(st, env) {
    switch (st.k) {
      case 'let':
      case 'var': {
        const value = this.evalExpr(st.init, env);
        if (st.pat) {
          patternDefine(this, env, st.pat, value);
          return UNIT;
        }
        env.define(st.name, { mutable: st.k === 'var', value });
        return UNIT;
      }
      case 'expr':
        return this.evalExpr(st.e, env);
      case 'assign': {
        const value = this.evalExpr(st.value, env);
        this.assignPlace(st.target, value, env);
        return UNIT;
      }
      case 'while': {
        while (true) {
          const c = this.evalExpr(st.cond, env);
          if (c !== true) break;
          try {
            this.execBlock(st.body, env);
          } catch (sig) {
            if (sig instanceof BreakSig) break;
            if (!(sig instanceof ContinueSig)) throw sig;
          }
        }
        return UNIT;
      }
      case 'for': {
        const iter = this.evalExpr(st.iter, env);
        let elems;
        if (iter.arb === 'array') elems = iter.items.filter(x => x !== null && x?.arb !== '__hole__');
        else if (typeof iter === 'string') elems = [...iter];
        else if (iter.arb === 'set') elems = [...iter.s].map(decodeKey);
        else if (iter.arb === 'range') {
          elems = [];
          for (let v = iter.start; v < iter.end; v++) elems.push(v);
        }
        else throw new ArborError({ code: 'R0014', message: 'value is not iterable at runtime', span: st.span });
        for (const el of elems) {
          const inner = new Env(env);
          patternDefine(this, inner, st.pat, el);
          try {
            this.execBlock(st.body, inner);
          } catch (sig) {
            if (sig instanceof BreakSig) break;
            if (!(sig instanceof ContinueSig)) throw sig;
          }
        }
        return UNIT;
      }
      case 'return':
        throw new ReturnSig(st.value ? this.evalExpr(st.value, env) : UNIT);
      case 'break':
        throw new BreakSig();
      case 'continue':
        throw new ContinueSig();
      case 'region': {
        this.regionStack.push({ name: st.name, count: 0 });
        try {
          this.execBlock(st.body, env);
        } finally {
          this.regionStack.pop();
        }
        return UNIT;
      }
      case 'spawn': {
        const taskEnv = new Env(this.globals);
        for (const name of st.captures || []) {
          const slot = env.lookup(name);
          if (!slot) continue;
          taskEnv.define(name, { mutable: false, value: cloneCopy(slot.value) });
        }
        this.taskQueue.push({ block: st.body, env: taskEnv });
        return UNIT;
      }
      default:
        return UNIT;
    }
  }

  assignPlace(target, value, env) {
    switch (target.k) {
      case 'name':
        env.assign(target.ident, value, target.span);
        return;
      case 'index': {
        const obj = this.evalExpr(target.obj, env);
        const idx = this.evalExpr(target.idx, env);
        if (obj.arb !== 'array') {
          throw new ArborError({ code: 'R0002', message: 'only arrays support index assignment', span: target.span });
        }
        if (!Number.isInteger(idx)) {
          throw new ArborError({ code: 'R0002', message: 'index must be Int', span: target.span });
        }
        if (idx < 0 || idx >= obj.items.length) {
          throw new ArborError({ code: 'R0002', message: `index ${idx} out of bounds for length ${obj.items.length}`, span: target.span });
        }
        obj.items[idx] = value;
        return;
      }
      case 'field': {
        const obj = this.evalExpr(target.obj, env);
        if (obj.arb !== 'struct') {
          throw new ArborError({ code: 'R0015', message: 'field assignment needs a struct', span: target.span });
        }
        obj.fields.set(target.name, value);
        return;
      }
      default:
        throw new ArborError({ code: 'R0015', message: 'invalid assignment target', span: target.span });
    }
  }

  evalExpr(e, env) {
    switch (e.k) {
      case 'int':
        return e.v;
      case 'float':
        return mkF(e.v);
      case 'bool':
        return e.v;
      case 'unit':
        return UNIT;
      case 'str': {
        let out = '';
        for (const part of e.parts) {
          if (part.str !== undefined) out += part.str;
          else out += fmtValue(this.evalExpr(part.expr, env));
        }
        return out;
      }
      case 'name': {
        const slot = env.lookup(e.ident);
        if (!slot) {
          throw new ArborError({ code: 'A0001', message: `unresolved name \`${e.ident}\` at runtime`, span: e.span });
        }
        const v = slot.value;
        if (v?.arb === 'ctor' && v.arity === 0) {
          return mkEnumV(v.enumName, v.variant, []);
        }
        return v;
      }
      case 'unary': {
        const v = this.evalExpr(e.e, env);
        if (e.op === '-') {
          if (isFloatV(v)) return mkF(-v.v);
          checkNum(v, e.span);
          return guardInt(-v, e.span);
        }
        if (v !== true && v !== false) throw new ArborError({ code: 'R0016', message: "'not' needs a Bool", span: e.span });
        return !v;
      }
      case 'binary':
        return this.evalBinary(e, env);
      case 'call': {
        const args = e.args.map(a => this.evalExpr(a, env));
        if (e.callee.k === 'method') {
          return this.evalMethod(e.callee, env);
        }
        const callable = this.resolveCallableForCall(e.callee, env, e.span);
        if (callable) return this.applyCallable(callable, args, e.span);
        const calleeVal = this.evalExpr(e.callee, env);
        return this.applyCallable(calleeVal, args, e.span);
      }
      case 'method':
        return this.evalMethod(e, env);
      case 'index': {
        const obj = this.evalExpr(e.obj, env);
        const idx = this.evalExpr(e.idx, env);
        if (obj.arb === 'array') {
          if (!Number.isInteger(idx)) throw new ArborError({ code: 'R0002', message: 'index must be Int', span: e.span });
          if (idx < 0 || idx >= obj.items.length) {
            throw new ArborError({ code: 'R0002', message: `index ${idx} out of bounds for length ${obj.items.length}`, span: e.span });
          }
          const v = obj.items[idx];
          if (v === null || v?.arb === '__hole__') {
            throw new ArborError({ code: 'R0008', message: `slot ${idx} is a hole; use .get()`, span: e.span });
          }
          return v;
        }
        if (typeof obj === 'string') {
          const chars = [...obj];
          if (!Number.isInteger(idx) || idx < 0 || idx >= chars.length) {
            throw new ArborError({ code: 'R0002', message: `char index ${idx} out of bounds`, span: e.span });
          }
          return chars[idx];
        }
        throw new ArborError({ code: 'R0017', message: 'cannot index this value at runtime', span: e.span });
      }
      case 'field':
        return this.evalField(e, env);
      case 'try': {
        const v = this.evalExpr(e.e, env);
        if (v?.arb === 'enum' && v.name === 'Option') {
          if (v.variant === 'Some') return v.payload[0];
          throw new ReturnSig(noneOf());
        }
        if (v?.arb === 'enum' && v.name === 'Result') {
          if (v.variant === 'Ok') return v.payload[0];
          throw new ReturnSig(errOf(v.payload[0]));
        }
        throw new ArborError({ code: 'R0018', message: '`?` applied to a non-Option/Result value', span: e.span });
      }
      case 'structLit': {
        this.alloc();
        const fields = new Map();
        for (const f of e.fields) fields.set(f.name, this.evalExpr(f.value, env));
        return { arb: 'struct', name: e.name, fields };
      }
      case 'arrayLit': {
        this.alloc();
        return mkArr(e.items.map(x => this.evalExpr(x, env)));
      }
      case 'mapLit': {
        this.alloc();
        const m = new Map();
        for (const { key, value } of e.entries) {
          m.set(encodeKey(this.evalExpr(key, env)), this.evalExpr(value, env));
        }
        return { arb: 'map', m };
      }
      case 'tupleLit': {
        this.alloc();
        return { arb: 'tuple', items: e.items.map(x => this.evalExpr(x, env)) };
      }
      case 'closure':
        return { arb: 'closure', params: e.params.map(p => p.name), body: e.body, isExpr: e.isExpr, env, name: null };
      case 'match':
        return this.evalMatch(e, env);
      case 'if': {
        const c = this.evalExpr(e.cond, env);
        if (c !== true && c !== false) throw new ArborError({ code: 'R0016', message: 'if condition must be Bool', span: e.span });
        if (c) return this.execBlock(e.thenB, env);
        if (!e.elseB) return UNIT;
        return e.elseB.k === 'block' ? this.execBlock(e.elseB, env) : this.evalExpr(e.elseB, env);
      }
      case 'block':
        return this.execBlock(e, env);
      default:
        throw new ArborError({ code: 'R0019', message: `unsupported expression kind ${e.k}`, span: e.span });
    }
  }

  evalBinary(e, env) {
    const op = e.op;
    if (op === 'and') {
      if (this.evalExpr(e.l, env) !== true) return false;
      return this.evalExpr(e.r, env) === true;
    }
    if (op === 'or') {
      if (this.evalExpr(e.l, env) === true) return true;
      return this.evalExpr(e.r, env) === true;
    }
    const l = this.evalExpr(e.l, env);
    const r = this.evalExpr(e.r, env);
    const bothInt = isIntV(l) && isIntV(r);
    const bothFloat = isFloatV(l) && isFloatV(r);
    switch (op) {
      case '+':
        if (typeof l === 'string' && typeof r === 'string') return l + r;
        checkNum(l, e.span); checkNum(r, e.span); sameKind(l, r, e.span);
        return bothInt ? guardInt(l + r) : mkF(unF(l) + unF(r));
      case '-':
        checkNum(l, e.span); checkNum(r, e.span); sameKind(l, r, e.span);
        return bothInt ? guardInt(l - r) : mkF(unF(l) - unF(r));
      case '*':
        checkNum(l, e.span); checkNum(r, e.span); sameKind(l, r, e.span);
        return bothInt ? guardInt(l * r) : mkF(unF(l) * unF(r));
      case '/':
        checkNum(l, e.span); checkNum(r, e.span); sameKind(l, r, e.span);
        if (bothInt) {
          if (r === 0) throw new ArborError({ code: 'R0005', message: 'integer division by zero', span: e.span });
          return Math.trunc(l / r);
        }
        return mkF(unF(l) / unF(r));
      case '%':
        checkNum(l, e.span); checkNum(r, e.span); sameKind(l, r, e.span);
        if (Number.isInteger(l) && r === 0) {
          throw new ArborError({ code: 'R0005', message: 'integer modulo by zero', span: e.span });
        }
        return l % r;
      case '..': {
        checkNum(l, e.span); checkNum(r, e.span);
        if (!isIntV(l) || !isIntV(r)) {
          throw new ArborError({ code: 'R0016', message: 'range bounds must be Int', span: e.span });
        }
        return { arb: 'range', start: l, end: r };
      }
        return mkF(unF(l) % unF(r));
      case '==': return valuesEqual(l, r);
      case '!=': return !valuesEqual(l, r);
      case '<':
      case '<=':
      case '>':
      case '>=':
        if (typeof l === 'string' && typeof r === 'string') {
          if (op === '<') return l < r;
          if (op === '<=') return l <= r;
          if (op === '>') return l > r;
          return l >= r;
        }
        checkNum(l, e.span); checkNum(r, e.span);
        if (op === '<') return unF(l) < unF(r);
        if (op === '<=') return unF(l) <= unF(r);
        if (op === '>') return unF(l) > unF(r);
        return unF(l) >= unF(r);
      default:
        throw new ArborError({ code: 'R0020', message: `unknown operator ${op}`, span: e.span });
    }
  }

  resolveCallableForCall(calleeExpr, env, span) {
    if (calleeExpr.k === 'name') {
      const slot = env.lookup(calleeExpr.ident);
      return slot ? slot.value : null;
    }
    if (calleeExpr.k === 'method') {
      return this.resolveStaticOrModuleTarget(calleeExpr, env, span);
    }
    return null;
  }

  resolveStaticOrModuleTarget(e, env, _span) {
    if (e.obj.k === 'name') {
      const local = env.lookup(e.obj.ident);
      if (!local) {
        if (BUILTIN_GENERIC_TYPES.has(e.obj.ident) && e.name === 'new') {
          return { __staticCtor: e.obj.ident };
        }
        return null;
      }
      const v = local.value;
      if (v?.arb === 'userenum' && v.variants.has(e.name)) {
        return { arb: 'ctor', enumName: v.name, variant: e.name, arity: v.variants.get(e.name) };
      }
      if (v?.arb === 'module') {
        const member = v.members[e.name];
        if (!member) return null;
        if (member.arb === 'bif' || member.arb === 'userfn') return member;
        if (member.arb === 'const') return { __constValue: member.value };
        return null;
      }
      if (v?.arb === 'userenum') return null;
      return null;
    }
    const chain = walkModuleChainAST(e.obj);
    if (!chain) return null;
    const baseSlot = env.lookup(chain.base);
    if (!baseSlot || baseSlot.value?.arb !== 'module') return null;
    let cur = baseSlot.value;
    for (let i = 1; i < chain.parts.length; i++) {
      const next = cur.members[chain.parts[i]];
      if (!next || next.arb !== 'module') return null;
      cur = next;
    }
    const member = cur.members[e.name];
    if (!member) return null;
    if (member.arb === 'bif') return member;
    if (member.arb === 'userfn') return member;
    if (member.arb === 'const') return { __constValue: member.value };
    return null;
  }

  evalMethod(e, env) {
    if (e.userMethod) {
      const recv = this.evalExpr(e.obj, env);
      const args = e.args.map(a => this.evalExpr(a, env));
      const fnVal = this.userFns.get(e.userMethod.decl.name)
        ?? this.globals.lookup(e.userMethod.decl.name.split('.').join('.'))?.value;
      if (!fnVal) throw new ArborError({ code: 'A0001', message: `method ${e.userMethod.decl.name} not registered`, span: e.span });
      return this.invokeUser(fnVal, [recv, ...args], e.span);
    }
    const target = this.resolveStaticOrModuleTarget(e, env, e.span);
    if (target?.__staticCtor) {
      if (e.name !== 'new') {
        throw new ArborError({ code: 'A0030', message: `${target.__staticCtor} has no static ${e.name}()`, span: e.span });
      }
      if (e.args.length) {
        throw new ArborError({ code: 'A0009', message: `${target.__staticCtor}.new() takes no arguments`, span: e.span });
      }
      return this.constructContainer(target.__staticCtor, e.span);
    }
    if (target?.__constValue !== undefined || target?.arb === 'bif' || target?.arb === 'ctor' || target?.arb === 'userfn') {
      const args = e.args.map(a => this.evalExpr(a, env));
      if (target.__constValue !== undefined) return target.__constValue;
      return this.applyCallable(target, args, e.span);
    }
    const recv = this.evalExpr(e.obj, env);
    const args = e.args.map(a => this.evalExpr(a, env));
    return this.runMethod(recv, e.name, args, e.span);
  }

  constructContainer(typeName, span) {
    this.alloc();
    switch (typeName) {
      case 'Array': return mkArr([]);
      case 'Map': return { arb: 'map', m: new Map() };
      case 'Set': return { arb: 'set', s: new Set() };
      case 'Table': return mkTblV();
      default:
        throw new ArborError({ code: 'A0023', message: `${typeName} has no runtime constructor`, span });
    }
  }

  evalField(e, env) {
    const obj = this.evalExpr(e.obj, env);
    if (obj?.arb === 'tuple' && /^\d+$/.test(e.name)) {
      const idx = Number(e.name);
      if (idx < 0 || idx >= obj.items.length) {
        throw new ArborError({ code: 'A0002', message: `tuple index ${idx} out of range`, span: e.span });
      }
      return obj.items[idx];
    }
    if (obj?.arb === 'struct') {
      if (!obj.fields.has(e.name)) {
        throw new ArborError({ code: 'A0025', message: `struct \`${obj.name}\` has no field \`${e.name}\``, span: e.span });
      }
      return obj.fields.get(e.name);
    }
    if (obj?.arb === 'module') {
      const m = obj.members[e.name];
      if (!m) throw new ArborError({ code: 'A0019', message: `module has no member ${e.name}`, span: e.span });
      return m;
    }
    if (obj?.arb === 'userenum') {
      if (!obj.variants.has(e.name)) {
        throw new ArborError({ code: 'A0028', message: `enum \`${obj.name}\` has no variant \`${e.name}\``, span: e.span });
      }
      const arity = obj.variants.get(e.name);
      if (arity === 0) {
        this.alloc();
        return mkEnumV(obj.name, e.name, []);
      }
      return { arb: 'ctor', enumName: obj.name, variant: e.name, arity };
    }
    throw new ArborError({ code: 'R0021', message: `value has no field \`${e.name}\``, span: e.span });
  }

  evalMatch(e, env) {
    const scrutinee = this.evalExpr(e.scrutinee, env);
    for (const arm of e.arms) {
      const armEnv = new Env(env);
      if (patternMatch(arm.pattern, scrutinee, armEnv)) {
        if (arm.guard && this.evalExpr(arm.guard, armEnv) !== true) continue;
        return arm.body.k === 'block'
          ? this.execBlock(arm.body, armEnv)
          : this.evalExpr(arm.body, armEnv);
      }
    }
    throw new ArborError({ code: 'R0022', message: 'no match arm matched at runtime', span: e.span });
  }
}

function walkModuleChainAST(e) {
  const parts = [];
  let cur = e;
  while (cur && cur.k === 'field') {
    parts.unshift(cur.name);
    cur = cur.obj;
  }
  if (!cur || cur.k !== 'name') return null;
  parts.unshift(cur.ident);
  return { base: parts[0], parts };
}

function patternMatch(pat, val, env) {
  switch (pat.k) {
    case 'pwild': return true;
    case 'pbind':
      env.define(pat.name, { mutable: false, value: val });
      return true;
    case 'plit': {
      if (pat.kind === 'int') return isIntV(val) && val === pat.v;
      if (pat.kind === 'float') return isFloatV(val) && val.v === pat.v;
      if (pat.kind === 'str') return typeof val === 'string' && val === pat.v;
      if (pat.kind === 'bool') return val === pat.v;
      return false;
    }
    case 'ptuple': {
      if (val?.arb !== 'tuple' || val.items.length !== pat.items.length) return false;
      return pat.items.every((sub, i) => patternMatch(sub, val.items[i], env));
    }
    case 'pvariant': {
      if (val?.arb !== 'enum' || val.variant !== pat.name) return false;
      if (val.payload.length !== pat.subs.length) return false;
      return pat.subs.every((sub, i) => patternMatch(sub, val.payload[i], env));
    }
    default:
      return false;
  }
}

function patternDefine(interp, env, pat, val) {
  void interp;
  patternMatch(pat, val, env);
}

function checkNum(v, span) {
  if (!isIntV(v) && !isFloatV(v)) {
    throw new ArborError({ code: 'R0016', message: `expected a number, got \`${fmtValue(v)}\``, span });
  }
}

function sameKind(a, b, span) {
  if (isIntV(a) !== isIntV(b)) {
    throw new ArborError({ code: 'R0016', message: 'mixed Int/Float arithmetic at runtime', span });
  }
}

function guardInt(v, span) {
  void span;
  if (typeof v === 'number' && !Number.isSafeInteger(v)) {
    throw new ArborError({ code: 'R0004', message: `integer overflow: ${v}`, span });
  }
  return v;
}

function valuesEqual(a, b) {
  if (isFloatV(a) || isFloatV(b)) {
    return isFloatV(a) && isFloatV(b) && a.v === b.v;
  }
  return a === b;
}
