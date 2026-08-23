import { parseInterp } from './parser.js';
import {
  TyRange,
  TyInt, TyFloat, TyBool, TyStr, TyUnit, TyPoison,
  mkArray, mkMap, mkSet, mkTable, mkHandle, mkTuple,
  mkStruct, mkEnum, mkFn, freshVar, prune, fmt, isCopy, isNumeric, bindVar,
} from './types.js';
import { BUILTIN_TYPES, MODULES, PRELUDE_CTORS, PRELUDE_FNS, METHODS, methodKindOf } from './builtins.js';
import { ArborError } from './diagnostics.js';

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.values = new Map();
    this.types = new Map();
    this.locals = new Map();
  }
  lookupLocal(name) {
    let s = this;
    while (s) {
      if (s.locals.has(name)) return s.locals.get(name);
      s = s.parent;
    }
    return null;
  }
  lookupValue(name) {
    let s = this;
    while (s) {
      if (s.values.has(name)) return s.values.get(name);
      s = s.parent;
    }
    return null;
  }
  lookupType(name) {
    let s = this;
    while (s) {
      if (s.types.has(name)) return s.types.get(name);
      s = s.parent;
    }
    return null;
  }
}

function lev(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}

function similar(names, target) {
  let best = null;
  let bestD = 3;
  for (const n of names) {
    const d = lev(n, target);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

export function checkProgram(prog, file) {
  const errors = [];
  const warnings = [];

  const root = new Scope(null);
  for (const [name, def] of Object.entries(BUILTIN_TYPES)) {
    root.types.set(name, def);
    root.values.set(name, { symKind: 'builtinType', name, def });
  }
  for (const [name, ctor] of Object.entries(PRELUDE_CTORS)) root.values.set(name, ctor);
  for (const [name, bif] of Object.entries(PRELUDE_FNS)) root.values.set(name, bif);
  root.values.set('std', { symKind: 'module', name: 'std', members: MODULES.std });

  const programScope = new Scope(root);
  const structs = new Map();
  const enums = new Map();
  const consts = new Map();
  const fns = [];
  const structResolveStack = new Map();
  let hasMain = false;

  function evalConst(e, depth = 0) {
    if (depth > 32) return undefined;
    switch (e.k) {
      case 'int': return e.v;
      case 'float': return e.v;
      case 'bool': return e.v ? 1 : 0 === 1 ? true : false;
      case 'unary':
        if (e.op === '-') { const v = evalConst(e.e, depth + 1); return typeof v === 'number' ? -v : undefined; }
        return undefined;
      case 'binary': {
        const l = evalConst(e.l, depth + 1);
        const r = evalConst(e.r, depth + 1);
        if (typeof l !== 'number' || typeof r !== 'number') return undefined;
        switch (e.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': return r === 0 ? undefined : (Number.isInteger(l) && Number.isInteger(r) ? Math.trunc(l / r) : l / r);
          default: return undefined;
        }
      }
      case 'name': {
        const sym = programScope.values.get(e.ident);
        if (sym && sym.symKind === 'constDecl') return sym.value;
        return undefined;
      }
      case 'call': {
        const calleeName = e.callee.k === 'name' ? e.callee.ident : null;
        if (!calleeName) return undefined;
        const argVals = e.args.map(a => evalConst(a, depth + 1));
        const rt = BUILTIN_CONST_FNS[calleeName];
        if (!rt || argVals.some(v => typeof v !== 'number')) return undefined;
        return rt(argVals);
      }
      default: return undefined;
    }
  }

  function err(code, message, span, extra = {}) {
    const e = new ArborError({ code, message, span, ...extra });
    errors.push(e);
    return TyPoison;
  }

  function resolveType(tyAst, scope, tyEnv) {
    switch (tyAst.k) {
      case 'tyUnit': return TyUnit;
      case 'tyFn': {
        const params = tyAst.params.map(t => ({ mode: 'in', ty: resolveType(t, scope, tyEnv) }));
        const ret = tyAst.ret ? resolveType(tyAst.ret, scope, tyEnv) : TyUnit;
        return mkFn(params, ret);
      }
      case 'tyArray': return mkArray(resolveType(tyAst.elem, scope, tyEnv));
      case 'tyTuple': return mkTuple(tyAst.items.map(t => resolveType(t, scope, tyEnv)));
      case 'tyName': {
        if (tyEnv && tyEnv.has(tyAst.name)) return tyEnv.get(tyAst.name);
        const def = scope.lookupType(tyAst.name);
        if (!def) {
          return err('A0017', `unknown type '${tyAst.name}'`, tyAst.span, {
            hint: `builtin types: ${Object.keys(BUILTIN_TYPES).join(', ')}`,
          });
        }
        if (def.kind === '__userstruct__') {
          if (tyAst.args.length) return err('A0018', `struct '${tyAst.name}' is not generic`, tyAst.span);
          if (structResolveStack.has(tyAst.name)) return structResolveStack.get(tyAst.name);
          const partial = mkStruct(tyAst.name, new Map());
          structResolveStack.set(tyAst.name, partial);
          for (const f of def.userDecl.fields) {
            partial.fields.set(f.name, resolveType(f.ty, programScope, null));
          }
          structResolveStack.delete(tyAst.name);
          return partial;
        }
        if (def.kind === '__userenum__') {
          if (tyAst.args.length) return err('A0018', `enum '${tyAst.name}' is not generic`, tyAst.span);
          if (structResolveStack.has(tyAst.name)) return structResolveStack.get(tyAst.name);
          const partial = mkEnum(tyAst.name, new Map());
          structResolveStack.set(tyAst.name, partial);
          for (const v of def.userDecl.variants) {
            partial.variants.set(v.name, v.tys.map(t => resolveType(t, programScope, null)));
          }
          structResolveStack.delete(tyAst.name);
          return partial;
        }
        const args = tyAst.args.map(a => resolveType(a, scope, tyEnv));
        if (args.length !== def.arity) {
          return err('A0018', `type '${tyAst.name}' expects ${def.arity} type argument(s), got ${args.length}`, tyAst.span);
        }
        return def.build(args);
      }
      default:
        return TyPoison;
    }
  }

  // two-pass hoisting: types/constants first, then functions/methods
  if (prog.modules) {
    for (const [stem, members] of prog.modules) {
      programScope.values.set(stem, { symKind: 'userModule', name: stem, members });
    }
  }

  for (const hoistPass of ['types', 'fns'])
  for (const d of prog.decls) {
    if (hoistPass === 'types' && d.k === 'fn') continue;
    if (hoistPass === 'fns' && d.k !== 'fn') continue;
    switch (d.k) {
      case 'use': {
        const [head, ...rest] = d.segments;
        if (head !== 'std') {
          err('A0019', `unknown module '${head}' — only 'std' exists`, d.span);
          break;
        }
        let members = MODULES.std;
        let ok = true;
        let leafSym = null;
        for (let i = 0; i < rest.length; i++) {
          const seg = rest[i];
          const next = members?.[seg];
          if (!next || typeof next !== 'object') {
            err('A0019', `unknown module path 'std.${rest.join('.')}'`, d.span);
            ok = false;
            break;
          }
          if ('symKind' in next) {
            leafSym = { sym: next, path: ['std', ...rest.slice(0, i + 1)].join('.') };
            break;
          }
          members = next;
        }
        if (!ok) break;
        if (leafSym) {
          programScope.values.set(d.segments[d.segments.length - 1], leafSym.sym);
          break;
        }
        const modulePath = ['std', ...rest].join('.');
        if (d.names) {
          for (const n of d.names) {
            if (!(n in members)) {
              err('A0019', `module '${modulePath}' has no member '${n}'`, d.span);
              continue;
            }
            programScope.values.set(n, members[n]);
          }
        } else {
          programScope.values.set(rest[rest.length - 1] ?? head, {
            symKind: 'module',
            name: modulePath,
            members,
          });
        }
        break;
      }
      case 'struct':
        if (structs.has(d.name)) err('A0020', `duplicate struct '${d.name}'`, d.span);
        structs.set(d.name, d);
        programScope.types.set(d.name, { kind: '__userstruct__', arity: 0, userDecl: d });
        programScope.values.set(d.name, { symKind: 'struct', decl: d });
        break;
      case 'enum':
        if (enums.has(d.name)) err('A0020', `duplicate enum '${d.name}'`, d.span);
        enums.set(d.name, d);
        programScope.types.set(d.name, { kind: '__userenum__', arity: 0, userDecl: d });
        programScope.values.set(d.name, { symKind: 'enumType', decl: d });
        for (const v of d.variants) {
          if (!programScope.values.has(v.name)) {
            programScope.values.set(v.name, { symKind: 'userVariant', enumDecl: d, variant: v });
          }
        }
        break;
      case 'useFile':
        break;
      case 'fn': {
        if (d.name.includes('.')) {
          const [typeName] = d.name.split('.');
          if (!structs.has(typeName) && !enums.has(typeName)) {
            err('A0017', `method declared on unknown type '${typeName}'`, d.span);
            break;
          }
          if (d.params.length === 0 || d.params[0].name !== 'self') {
            err('A0035', `method '${d.name}' must declare its first parameter as self`, d.span);
            break;
          }
        }
        if (programScope.values.has(d.name)) err('A0020', `duplicate definition '${d.name}'`, d.span);
        programScope.values.set(d.name, { symKind: 'fnDecl', decl: d });
        fns.push(d);
        if (d.name === 'main') hasMain = true;
        break;
      }
      case 'const': {
        if (programScope.values.has(d.name)) err('A0020', `duplicate definition '${d.name}'`, d.span);
        const v = evalConst(d.value);
        if (v === undefined) {
          err('A0034', `const initializer must be a compile-time constant`, d.value.span, {
            hint: 'literals, negative literals and simple arithmetic of constants are supported',
          });
          programScope.values.set(d.name, { symKind: 'constDecl', decl: d, ty: TyInt, value: 0 });
          break;
        }
        const cty = typeof v === 'number' ? (Number.isInteger(v) ? TyInt : TyFloat)
          : typeof v === 'boolean' ? TyBool
            : typeof v === 'string' ? TyStr : TyInt;
        d.constValue = v;
        programScope.values.set(d.name, { symKind: 'constDecl', decl: d, ty: cty, value: v });
        break;
      }
    }
  }

  function fnSignature(decl, tyEnv) {
    const params = decl.params.map(p => ({ mode: p.mode, name: p.name, ty: resolveType(p.ty, programScope, tyEnv || null) }));
    const ret = decl.retTy ? resolveType(decl.retTy, programScope, tyEnv || null) : TyUnit;
    return { params, ret };
  }

  function makeFrame(scope, retTy, opts = {}) {
    return {
      scope,
      retTy,
      loopDepth: 0,
      spawnDepth: opts.spawnDepth || 0,
      allBindings: [],
      tyEnv: null,
    };
  }

  function declareLocal(frame, name, ty, { mutable = false, loan = false, span, isParam = false } = {}) {
    const p = prune(ty);
    const b = {
      name, ty: p, mutable, loan,
      moved: false, movedSpan: null,
      isHandle: p.k === 'handle',
      declSpan: span,
      isParam,
      used: false,
    };
    frame.scope.locals.set(name, b);
    frame.allBindings.push(b);
    return b;
  }

  function useBinding(frame, b, mode, span) {
    b.used = true;
    if (b.moved) {
      const e = new ArborError({
        code: 'A0002',
        message: `use of moved value \`${b.name}\` — ARBOR values are trees; a moved tree belongs to its new owner`,
        span,
        notes: ['the previous move happened at the highlighted location of the earlier operation'],
      });
      e.prevSpan = b.movedSpan;
      errors.push(e);
      return;
    }
    if (mode === 'consume') {
      if (isCopy(b.ty)) return;
      if (b.loan) {
        err('A0014', `cannot move out of \`${b.name}\`: it is a lend (a view into a collection you do not own)`, span, {
          hint: 'obtain an owned value first: .take(i), .clone(), or iterate a cloned list',
        });
        return;
      }
      b.moved = true;
      b.movedSpan = span;
    }
  }

  function checkPlace(frame, e, needMut) {
    switch (e.k) {
      case 'name': {
        const sym = frame.scope.lookupLocal(e.ident);
        if (!sym) return false;
        if (needMut && !sym.mutable) {
          err('A0004', `cannot mutate \`${e.ident}\`: it is bound with \`let\``, e.span, {
            hint: "declare it with 'var' to allow mutation",
          });
        }
        return true;
      }
      case 'index':
        checkPlace(frame, e.obj, needMut);
        return true;
      case 'field':
        checkPlace(frame, e.obj, needMut);
        return true;
      default:
        return false;
    }
  }

  function expectType(found, want, span, what) {
    const f = prune(found);
    const w = prune(want);
    if (f.k === 'poison' || w.k === 'poison') return found;
    if (!unifyTypes(f, w)) {
      return err('A0003', `type mismatch: ${what} is \`${fmt(f)}\`, expected \`${fmt(w)}\``, span);
    }
    return found;
  }

  function unifyTypes(a, b) {
    a = prune(a);
    b = prune(b);
    if (a === b) return true;
    if (a.k === 'poison' || b.k === 'poison') return true;
    if (a.k === 'tvar') return bindVar(a, b) !== undefined;
    if (b.k === 'tvar') return bindVar(b, a) !== undefined;
    if (a.k !== b.k) return false;
    switch (a.k) {
      case 'int': case 'float': case 'bool': case 'str': case 'unit': return true;
      case 'array': case 'set': case 'handle': case 'table':
        return unifyTypes(a.elem, b.elem);
      case 'map': return unifyTypes(a.key, b.key) && unifyTypes(a.val, b.val);
      case 'tuple':
        return a.items.length === b.items.length && a.items.every((x, i) => unifyTypes(x, b.items[i]));
      case 'struct': case 'enum': return a.name === b.name;
      case 'fn':
        return a.params.length === b.params.length
          && a.params.every((p, i) => unifyTypes(p.ty, b.params[i].ty))
          && unifyTypes(prune(a.ret), prune(b.ret));
      default: return false;
    }
  }

  function unifyOrErr(found, wantVar, span, what) {
    const w = prune(wantVar);
    if (w.k === 'poison' || prune(found).k === 'poison') return;
    if (!unifyTypes(found, wantVar)) {
      err('A0003', `type mismatch: ${what} is \`${fmt(found)}\`, expected \`${fmt(w)}\``, span);
    }
  }

  function compileParts(strNode) {
    if (strNode.partsCompiled) return;
    strNode.parts = strNode.parts.map(part => {
      if (part.str !== undefined) return part;
      const expr = parseInterp(part.exprSrc, part.file, part.baseOffset);
      return { expr };
    });
    strNode.partsCompiled = true;
  }

  function reportDroppedHandles(frame) {
    for (const b of frame.allBindings) {
      if (b.isHandle && !b.used && !b.isParam) {
        warnings.push(new ArborError({
          code: 'W0001',
          message: `handle \`${b.name}\` reaches end of scope unconsumed`,
          span: b.declSpan,
          hint: 'ARBOR handles are linear: pass it on, store it, or drop(h) explicitly to silence',
        }));
      }
    }
  }

  function knownNames() {
    const acc = [];
    for (const k of programScope.values.keys()) acc.push(k);
    for (const k of root.values.keys()) acc.push(k);
    return acc;
  }

  function tcBlock(block, frame) {
    frame.scope = new Scope(frame.scope);
    let last = TyUnit;
    for (const st of block.stmts) {
      last = tcStmt(st, frame);
    }
    frame.scope = frame.scope.parent;
    return last;
  }

  function tcStmt(st, frame) {
    switch (st.k) {
      case 'let':
      case 'var': {
        const declared = st.ty ? resolveType(st.ty, frame.scope, frame.tyEnv) : null;
        const initTy = tcExpr(st.init, frame, 'consume');
        if (st.pat) {
          if (declared) expectType(initTy, declared, st.span, 'destructured initializer');
          bindPatternInScope(frame, st.pat, declared ?? initTy, { loan: false });
          return TyUnit;
        }
        let finalTy;
        if (declared) {
          expectType(initTy, declared, st.span, `initializer of \`${st.name}\``);
          finalTy = declared;
        } else {
          finalTy = initTy;
          const p = prune(finalTy);
          if (p.k === 'tvar' || p.k === 'poison') {
            finalTy = err('A0003', `cannot infer the type of \`${st.name}\`; add an annotation`, st.span, {
              hint: 'for example: let xs: [Int] = []',
            });
          }
        }
        declareLocal(frame, st.name, finalTy, { mutable: st.k === 'var', span: st.span });
        try { st.varTy = prune(finalTy); if (st.pat) st.patTy = prune(finalTy); } catch (_) {}
        return TyUnit;
      }
      case 'expr':
        return tcExpr(st.e, frame, 'read');
      case 'assign': {
        checkPlace(frame, st.target, true);
        let tTy;
        let rebinding = null;
        if (st.target.k === 'name') {
          rebinding = frame.scope.lookupLocal(st.target.ident);
          tTy = rebinding ? rebinding.ty : TyPoison;
        } else {
          tTy = tcExpr(st.target, frame, 'read');
        }
        const vTy = tcExpr(st.value, frame, 'consume');
        expectType(vTy, tTy, st.span, 'assigned value');
        if (rebinding) {
          rebinding.moved = false;
          rebinding.movedSpan = null;
        }
        return TyUnit;
      }
      case 'while': {
        const cTy = tcExpr(st.cond, frame, 'read');
        expectType(cTy, TyBool, st.cond.span, 'while condition');
        frame.loopDepth++;
        tcBlock(st.body, frame);
        frame.loopDepth--;
        return TyUnit;
      }
      case 'for': {
        const iTy = prune(tcExpr(st.iter, frame, 'read'));
        let elemTy;
        if (iTy.k === 'array' || iTy.k === 'set') elemTy = iTy.elem;
        else if (iTy.k === 'str') elemTy = TyStr;
        else if (iTy.k === 'range') elemTy = TyInt;
        else if (iTy.k === 'poison') elemTy = TyPoison;
        else {
          err('A0022', `\`${fmt(iTy)}\` is not iterable`, st.iter.span, {
            hint: 'arrays, sets and strings are iterable; maps expose .keys()',
          });
          elemTy = TyPoison;
        }
        frame.scope = new Scope(frame.scope);
        const loan = !isCopy(elemTy);
        try { st.elemTy = prune(elemTy); } catch (_) {}
        bindPatternInScope(frame, st.pat, elemTy, { loan });
        frame.loopDepth++;
        tcBlock(st.body, frame);
        frame.loopDepth--;
        frame.scope = frame.scope.parent;
        return TyUnit;
      }
      case 'return': {
        if (frame.spawnDepth > 0) {
          err('A0007', '`return` cannot cross a spawn boundary', st.span, {
            hint: 'spawn bodies produce Unit; hand results to the parent through moved containers',
          });
        }
        if (st.value) {
          const vTy = tcExpr(st.value, frame, 'consume');
          expectType(vTy, frame.retTy, st.span, 'returned value');
        } else {
          expectType(TyUnit, frame.retTy, st.span, 'bare return');
        }
        return TyUnit;
      }
      case 'break':
      case 'continue': {
        if (frame.spawnDepth > 0 && frame.loopDepth === 0) {
          err('A0007', `\`${st.k}\` would escape the spawn body`, st.span);
        } else if (frame.loopDepth === 0) {
          err('A0008', `\`${st.k}\` outside of a loop`, st.span);
        }
        return TyUnit;
      }
      case 'region': {
        frame.scope = new Scope(frame.scope);
        tcBlock(st.body, frame);
        frame.scope = frame.scope.parent;
        return TyUnit;
      }
      case 'spawn': {
        const freeNames = collectFreeVars(st.body);
        const captures = [];
        for (const name of freeNames) {
          const local = frame.scope.lookupLocal(name);
          if (!local) continue;
          if (local.loan) {
            err('A0014', `cannot capture lend \`${name}\` inside spawn`, st.span, {
              hint: 'lends are views that die with their owning scope; clone() or take() what you need first',
            });
            continue;
          }
          if (local.moved) {
            err('A0002', `capture of moved value \`${name}\``, st.span, { notes: ['it was already moved earlier'] });
            continue;
          }
          if (!isCopy(local.ty)) {
            local.moved = true;
            local.movedSpan = st.span;
          }
          captures.push(name);
        }
        st.captures = captures;
        const innerScope = new Scope(programScope);
        for (const c of captures) {
          const src = frame.scope.lookupLocal(c);
          innerScope.locals.set(c, { ...src, moved: false });
        }
        const innerFrame = makeFrame(innerScope, TyUnit, { spawnDepth: frame.spawnDepth + 1 });
        innerFrame.tyEnv = frame.tyEnv;
        tcBlock(st.body, innerFrame);
        reportDroppedHandles(innerFrame);
        return TyUnit;
      }
      default:
        return TyUnit;
    }
  }

  function bindPatternInScope(frame, pat, ty, opts = {}) {
    switch (pat.k) {
      case 'pbind':
        declareLocal(frame, pat.name, ty, { mutable: false, loan: !!opts.loan, span: pat.span });
        return true;
      case 'pwild':
        return false;
      case 'ptuple': {
        const p = prune(ty);
        if (p.k !== 'tuple' || p.items.length !== pat.items.length) {
          err('A0003', `tuple pattern has ${pat.items.length} element(s), but type is \`${fmt(ty)}\``, pat.span);
          return false;
        }
        let any = false;
        pat.items.forEach((sub, i) => {
          if (bindPatternInScope(frame, sub, p.items[i], opts)) any = true;
        });
        return any;
      }
      default:
        return false;
    }
  }

  function collectFreeVars(block) {
    const bound = new Set();
    const free = new Set();
    visitPatternPats(bound);

    function visitPatternPats() {}

    function patternBinds(p, binds) {
      if (!p) return;
      if (p.k === 'pbind') binds.add(p.name);
      else if (p.k === 'ptuple') p.items.forEach(s => patternBinds(s, binds));
      else if (p.k === 'pvariant') p.subs.forEach(s => patternBinds(s, binds));
    }

    function visitStmt(st, binds) {
      switch (st.k) {
        case 'let': case 'var':
          visitExpr(st.init, binds);
          binds.add(st.name);
          break;
        case 'expr': visitExpr(st.e, binds); break;
        case 'assign':
          visitExpr(st.target, binds);
          visitExpr(st.value, binds);
          break;
        case 'while':
          visitExpr(st.cond, binds);
          visitBlock(st.body, binds);
          break;
        case 'for': {
          visitExpr(st.iter, binds);
          const inner = new Set(binds);
          patternBinds(st.pat, inner);
          visitBlock(st.body, inner);
          break;
        }
        case 'return':
          if (st.value) visitExpr(st.value, binds);
          break;
        case 'region': visitBlock(st.body, binds); break;
        case 'spawn': visitBlock(st.body, binds); break;
        default: break;
      }
    }

    function visitBlock(b, binds) {
      for (const st of b.stmts) visitStmt(st, binds);
    }

    function visitExpr(e, binds) {
      if (!e) return;
      switch (e.k) {
        case 'name':
          if (!binds.has(e.ident)) free.add(e.ident);
          break;
        case 'unary': visitExpr(e.e, binds); break;
        case 'binary':
          visitExpr(e.l, binds);
          visitExpr(e.r, binds);
          break;
        case 'call':
          visitExpr(e.callee, binds);
          e.args.forEach(a => visitExpr(a, binds));
          break;
        case 'index':
          visitExpr(e.obj, binds);
          visitExpr(e.idx, binds);
          break;
        case 'field': visitExpr(e.obj, binds); break;
        case 'method':
          visitExpr(e.obj, binds);
          e.args.forEach(a => visitExpr(a, binds));
          break;
        case 'try': visitExpr(e.e, binds); break;
        case 'structLit': e.fields.forEach(f => visitExpr(f.value, binds)); break;
        case 'arrayLit': e.items.forEach(x => visitExpr(x, binds)); break;
        case 'mapLit':
          e.entries.forEach(({ key, value }) => { visitExpr(key, binds); visitExpr(value, binds); });
          break;
        case 'tupleLit': e.items.forEach(x => visitExpr(x, binds)); break;
        case 'closure': {
          const inner = new Set(binds);
          e.params.forEach(p => inner.add(p.name));
          if (e.isExpr) visitExpr(e.body, inner);
          else visitBlock(e.body, inner);
          break;
        }
        case 'match': {
          visitExpr(e.scrutinee, binds);
          for (const arm of e.arms) {
            const inner = new Set(binds);
            patternBinds(arm.pattern, inner);
            if (arm.guard) visitExpr(arm.guard, inner);
            if (arm.body.k === 'block') visitBlock(arm.body, inner);
            else visitExpr(arm.body, inner);
          }
          break;
        }
        case 'if': {
          visitExpr(e.cond, binds);
          visitBlock(e.thenB, binds);
          if (e.elseB) {
            if (e.elseB.k === 'block') visitBlock(e.elseB, binds);
            else visitExpr(e.elseB, binds);
          }
          break;
        }
        case 'block': visitBlock(e, binds); break;
        case 'str': {
          compileParts(e);
          e.parts.forEach(part => { if (part.expr) visitExpr(part.expr, binds); });
          break;
        }
        default: break;
      }
    }

    visitBlock(block, bound);
    return [...free];
  }

  function fnValueType(decl) {
    if (!decl.typarams.length) {
      const sig = fnSignature(decl, null);
      return mkFn(sig.params.map(p => ({ mode: p.mode, ty: p.ty })), sig.ret);
    }
    const env = new Map(decl.typarams.map(t => [t, freshVar(t)]));
    const sig = fnSignature(decl, env);
    return mkFn(sig.params.map(p => ({ mode: p.mode, ty: p.ty })), sig.ret);
  }

  function tcExpr(e, frame, mode) {
    const t = tcExprInner(e, frame, mode);
    try { e.ty = prune(t); } catch (_) { /* stamping must never break checking */ }
    return t;
  }

  function tcExprInner(e, frame, mode) {
    switch (e.k) {
      case 'int': return TyInt;
      case 'float': return TyFloat;
      case 'bool': return TyBool;
      case 'unit': return TyUnit;
      case 'str': {
        compileParts(e);
        for (const part of e.parts) if (part.expr) tcExpr(part.expr, frame, 'read');
        return TyStr;
      }
      case 'name': {
        const local = frame.scope.lookupLocal(e.ident);
        if (local) {
          useBinding(frame, local, mode, e.span);
          return local.ty;
        }
        const sym = frame.scope.lookupValue(e.ident);
        if (!sym) {
          const sug = similar(knownNames(), e.ident);
          return err('A0001', `cannot find value \`${e.ident}\``, e.span,
            sug ? { hint: `did you mean \`${sug}\`?` } : undefined);
        }
        switch (sym.symKind) {
          case 'struct':
            return err('A0023', `\`${e.ident}\` is a struct type, not a value`, e.span, {
              hint: `construct it as ${e.ident} { field: value, ... }`,
            });
          case 'enumType':
          case 'ctor':
            return err('A0023', `\`${e.ident}\` is a type/constructor name, not a value`, e.span, {
              hint: 'construct values with Some(x), Ok(v) or Enum.Variant(payload)',
            });
          case 'fnDecl': return fnValueType(sym.decl);
          case 'userVariant': {
            if (sym.variant.tys.length !== 0) {
              return err('A0023', `variant \`${e.ident}\` needs ${sym.variant.tys.length} payload(s): ${e.ident}(...)`, e.span);
            }
            try { e.enumCtor = { name: sym.enumDecl.name, variant: sym.variant.name, arity: 0 }; } catch (_) {}
            const variants = new Map(
              sym.enumDecl.variants.map(v => [v.name, v.tys.map(t => resolveType(t, programScope, frame.tyEnv))])
            );
            return mkEnum(sym.enumDecl.name, variants);
          }
          case 'bif':
            return mkFn(
              sym.params.map(p => ({ mode: p.mode, ty: p.ty && p.ty.k === 'any' ? freshVar('X') : p.ty })),
              sym.ret
            );
          case 'module':
            return err('A0023', `\`${e.ident}\` is a module, not a value`, e.span, {
              hint: `access a member like ${e.ident}.something`,
            });
          case 'builtinType':
            return err('A0023', `\`${e.ident}\` is a type name, not a value`, e.span, {
              hint: `construct one with ${e.ident}.new()`,
            });
          case 'const': return sym.ty;
          case 'constDecl':
            try { e.constName = sym.name; e.constValue = sym.value; } catch (_) {}
            return sym.ty;
          default: return TyPoison;
        }
      }
      case 'unary': {
        const t = prune(tcExpr(e.e, frame, 'read'));
        if (e.op === '-') {
          if (!isNumeric(t) && t.k !== 'poison' && t.k !== 'tvar') {
            return err('A0003', `cannot negate \`${fmt(t)}\``, e.span, { hint: 'negation needs Int or Float' });
          }
          return t;
        }
        expectType(t, TyBool, e.span, "operand of 'not'");
        return TyBool;
      }
      case 'binary': return tcBinary(e, frame);
      case 'call': return tcCall(e, frame);
      case 'index': {
        const oT = prune(tcExpr(e.obj, frame, 'read'));
        const iTy = prune(tcExpr(e.idx, frame, 'read'));
        if (oT.k === 'array') {
          expectType(iTy, TyInt, e.idx.span, 'index');
          if (!isCopy(oT.elem)) {
            return err('A0014', `cannot move an element out of \`[${fmt(oT.elem)}]\` by plain indexing`, e.span, {
              hint: 'use .get(i) (gives Option) or .take(i) (removes and owns the element)',
            });
          }
          return oT.elem;
        }
        if (oT.k === 'str') {
          expectType(iTy, TyInt, e.idx.span, 'index');
          return TyStr;
        }
        if (oT.k === 'map') {
          expectType(iTy, oT.key, e.idx.span, 'map key');
          return err('A0024', 'Map lookup must go through .get(k), which returns an Option', e.span, {
            hint: 'match on the Option to handle the missing-key case explicitly',
          });
        }
        if (oT.k !== 'poison') err('A0003', `cannot index into \`${fmt(oT)}\``, e.span);
        return TyPoison;
      }
      case 'field': return tcField(e, frame);
      case 'method': return tcMethod(e, frame);
      case 'try': return tcTry(e, frame);
      case 'structLit': {
        const sym = frame.scope.lookupValue(e.name);
        if (!sym || sym.symKind !== 'struct') {
          return err('A0017', `unknown struct \`${e.name}\``, e.span);
        }
        const decl = sym.decl;
        try { e.fieldNames = decl.fields.map(f => f.name); } catch (_) {}
        const want = new Map(decl.fields.map(f => [f.name, resolveType(f.ty, programScope, frame.tyEnv)]));
        const seen = new Set();
        for (const f of e.fields) {
          if (!want.has(f.name)) {
            err('A0025', `struct \`${e.name}\` has no field \`${f.name}\``, f.value.span, {
              hint: `fields: ${[...want.keys()].join(', ')}`,
            });
            continue;
          }
          seen.add(f.name);
          const vT = tcExpr(f.value, frame, 'consume');
          expectType(vT, want.get(f.name), f.value.span, `field \`${f.name}\``);
        }
        const missing = [...want.keys()].filter(k => !seen.has(k));
        if (missing.length) {
          err('A0026', `missing field(s) in \`${e.name}\`: ${missing.join(', ')}`, e.span);
        }
        return mkStruct(e.name, want);
      }
      case 'arrayLit': {
        const elem = freshVar('E');
        for (const item of e.items) {
          const iTy = tcExpr(item, frame, 'consume');
          unifyOrErr(iTy, elem, item.span, 'array element');
        }
        void mode;
        return mkArray(elem);
      }
      case 'mapLit': {
        const kT = freshVar('K');
        const vT = freshVar('V');
        for (const { key, value } of e.entries) {
          const kk = tcExpr(key, frame, 'read');
          const vv = tcExpr(value, frame, 'consume');
          unifyOrErr(kk, kT, key.span, 'map key');
          unifyOrErr(vv, vT, value.span, 'map value');
        }
        return mkMap(kT, vT);
      }
      case 'tupleLit':
        return mkTuple(e.items.map(x => tcExpr(x, frame, 'consume')));
      case 'closure': {
        const params = e.params.map(p => ({
          mode: 'in',
          name: p.name,
          ty: p.ty ? resolveType(p.ty, frame.scope, frame.tyEnv) : freshVar(p.name),
        }));
        const innerFrame = makeFrame(new Scope(frame.scope), frame.retTy, { spawnDepth: frame.spawnDepth });
        innerFrame.tyEnv = frame.tyEnv;
        for (const p of params) declareLocal(innerFrame, p.name, p.ty, { mutable: false, span: e.span });
        const ret = e.isExpr ? tcExpr(e.body, innerFrame, 'consume') : tcBlock(e.body, innerFrame);
        reportDroppedHandles(innerFrame);
        return mkFn(params.map(p => ({ mode: p.mode, ty: p.ty })), ret);
      }
      case 'match': return tcMatch(e, frame);
      case 'if': return tcIf(e, frame);
      case 'block': return tcBlock(e, frame);
      default:
        return TyPoison;
    }
  }

  function tcBinary(e, frame) {
    const lt = prune(tcExpr(e.l, frame, 'read'));
    const rt = prune(tcExpr(e.r, frame, 'read'));
    const op = e.op;
    const unknownish = t => t.k === 'poison' || t.k === 'tvar';
    if (op === 'and' || op === 'or') {
      expectType(lt, TyBool, e.l.span, `left side of '${op}'`);
      expectType(rt, TyBool, e.r.span, `right side of '${op}'`);
      return TyBool;
    }
    if (op === '==' || op === '!=') {
      unifyOrErr(rt, lt, e.r.span, 'right operand');
      if (!unknownish(lt) && !isCopy(lt)) {
        err('A0027', `'${op}' needs a Copy type but found \`${fmt(lt)}\``, e.span, {
          hint: 'containers own their contents; compare sizes or elements instead',
        });
      }
      return TyBool;
    }
    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
      if (lt.k === 'str' && rt.k === 'str') return TyBool;
      if (!isNumeric(lt) || !isNumeric(rt)) {
        if (!unknownish(lt) && !unknownish(rt)) {
          err('A0003', `'${op}' needs two numbers (or two Str); got \`${fmt(lt)}\` and \`${fmt(rt)}\``, e.span);
        }
        return TyBool;
      }
      unifyOrErr(rt, lt, e.r.span, 'right operand');
      return TyBool;
    }
    if (op === '..') {
      expectType(lt, TyInt, e.l.span, 'range start');
      expectType(rt, TyInt, e.r.span, 'range end');
      return { k: 'range' };
    }
    if (op === '+' && lt.k === 'str' && rt.k === 'str') return TyStr;
    if (isNumeric(lt) && isNumeric(rt)) {
      if ((lt.k === 'float') !== (rt.k === 'float')) {
        return err('A0003', `mixed numeric types in \`${fmt(lt)} ${op} ${fmt(rt)}\``, e.span, {
          hint: 'convert explicitly with .to_float() or .to_int()',
        });
      }
      unifyOrErr(rt, lt, e.r.span, 'right operand');
      return lt.k === 'float' ? TyFloat : TyInt;
    }
    if (unknownish(lt) || unknownish(rt)) {
      unifyOrErr(rt, lt, e.r.span, 'right operand');
      return prune(lt);
    }
    err('A0003', `operator '${op}' cannot apply to \`${fmt(lt)}\` and \`${fmt(rt)}\``, e.span);
    return TyPoison;
  }

  function tcCall(e, frame) {
    const callee = e.callee;
    if (callee.k === 'name') {
      const local = frame.scope.lookupLocal(callee.ident);
      if (local) {
        const ft = prune(local.ty);
        if (ft.k === 'fn') {
          useBinding(frame, local, 'read', callee.span);
          try { e.callClosure = { params: ft.params.map(p => ({ mode: p.mode })), ret: prune(ft.ret) }; } catch (_) {}
          return checkArgsAgainst(ft.params, ft.ret, e.args, frame, e.span, `\`${callee.ident}\``);
        }
        return err('A0003', `\`${callee.ident}\` has type \`${fmt(ft)}\`, which is not callable`, e.span);
      }
      const sym = frame.scope.lookupValue(callee.ident);
      if (!sym) {
        const sug = similar(knownNames(), callee.ident);
        return err('A0001', `cannot find function \`${callee.ident}\``, callee.span,
          sug ? { hint: `did you mean \`${sug}\`?` } : undefined);
      }
      return callSymbol(sym, callee.ident, e.args, frame, e.span, e);
    }
    if (callee.k === 'field' && callee.obj.k === 'name') {
      const sym = frame.scope.lookupValue(callee.obj.ident);
      if (sym && sym.symKind === 'builtinType') {
        return builtinStaticCtor(sym, callee.name, e.args, frame, e.span);
      }
      if (sym && sym.symKind === 'module') {
        const member = sym.members[callee.name];
        if (!member) {
          return err('A0019', `module \`${callee.obj.ident}\` has no member \`${callee.name}\``, callee.span);
        }
        return callSymbol(member, `${callee.obj.ident}.${callee.name}`, e.args, frame, e.span, e);
      }
      if (sym && sym.symKind === 'enumType') {
        return constructUserVariant(sym.decl, callee.name, e.args, frame, e.span, e);
      }
    }
    const ft = prune(tcExpr(callee, frame, 'read'));
    if (ft.k === 'fn') {
      return checkArgsAgainst(ft.params, ft.ret, e.args, frame, e.span, 'closure');
    }
    return err('A0029', `value of type \`${fmt(ft)}\` is not callable`, e.span);
  }

  function builtinStaticCtor(sym, member, args, frame, span, tyArgs) {
    if (member !== 'new') {
      return err('A0030', `type \`${sym.name}\` has no static member \`${member}\``, span, {
        hint: `use ${sym.name}${sym.def.arity ? '[...]' : ''}.new()`,
      });
    }
    if (args.length !== 0) {
      return err('A0009', `${sym.name}.new() takes no arguments`, span);
    }
    const applied = (tyArgs || []).map(a => resolveType(a, programScope, frame.tyEnv));
    if (!tyArgs && sym.def.arity > 0) {
      switch (sym.def.kind) {
        case 'array': return mkArray(freshVar('E'));
        case 'map': return mkMap(freshVar('K'), freshVar('V'));
        case 'set': return mkSet(freshVar('S'));
        case 'table': return mkTable(freshVar('T'));
        default:
          return err('A0023', `\`${sym.name}\` has no constructor; write the type directly`, span);
      }
    }
    if (applied.length !== sym.def.arity) {
      return err('A0018', `type '${sym.name}' expects ${sym.def.arity} type argument(s), got ${applied.length}`, span);
    }
    return sym.def.build(applied);
  }

  function constructUserVariant(decl, variantName, args, frame, span, node) {
    if (node) {
      try { node.userVariant = { name: decl.name, variant: variantName }; } catch (_) {}
    }
    const variant = decl.variants.find(v => v.name === variantName);
    if (!variant) {
      return err('A0028', `enum \`${decl.name}\` has no variant \`${variantName}\``, span, {
        hint: `variants: ${decl.variants.map(v => v.name).join(', ')}`,
      });
    }
    const payloadTys = variant.tys.map(t => resolveType(t, programScope, frame.tyEnv));
    if (payloadTys.length !== args.length) {
      return err('A0009', `variant \`${decl.name}.${variantName}\` takes ${payloadTys.length} payload(s), got ${args.length}`, span);
    }
    args.forEach((arg, i) => {
      const aT = tcExpr(arg, frame, 'consume');
      expectType(aT, payloadTys[i], arg.span, `payload ${i + 1}`);
    });
    const variants = new Map(
      decl.variants.map(v => [v.name, v.tys.map(t => resolveType(t, programScope, frame.tyEnv))])
    );
    return mkEnum(decl.name, variants);
  }

  function callSymbol(sym, name, args, frame, span, node) {
    if (sym.symKind === 'userVariant') {
      return constructUserVariant(sym.enumDecl, sym.variant.name, args, frame, span, node);
    }
    if (sym.symKind === 'ctor') {
      const argTys = args.map(a => tcExpr(a, frame, 'consume'));
      if (argTys.length !== sym.arity) {
        return err('A0009', `variant ${sym.enumName}.${sym.variantName} expects ${sym.arity} payload(s), got ${argTys.length}`, span);
      }
      const vars = [];
      for (let i = 0; i < BUILTIN_TYPES[sym.enumName].arity; i++) vars.push(freshVar(`${sym.enumName}${i}`));
      const enumTy = BUILTIN_TYPES[sym.enumName].build(vars);
      const payloads = enumTy.variants.get(sym.variantName);
      argTys.forEach((aT, i) => expectType(aT, payloads[i], args[i].span, `payload ${i + 1}`));
      if (node) { try { node.ctor = { name: sym.enumName, variant: sym.variantName, arity: sym.arity }; } catch (_) {} }
      return enumTy;
    }
    if (sym.symKind === 'bif') {
      const params = sym.params.map(p => ({ mode: p.mode, ty: p.ty && p.ty.k === 'any' ? freshVar('X') : p.ty }));
      checkArgsAgainst(params, sym.ret, args, frame, span, `\`${name}\``);
      if (node) { try { node.bifPath = sym._path || name; } catch (_) {} }
      return sym.ret;
    }
    if (sym.symKind === 'const') {
      return err('A0023', `\`${name}\` is a constant, not a function`, span);
    }
    if (sym.symKind === 'fnDecl') {
      const decl = sym.decl;
      let tyEnv = null;
      if (decl.typarams.length) {
        tyEnv = new Map(decl.typarams.map(t => [t, freshVar(t)]));
      }
      const sig = fnSignature(decl, tyEnv);
      if (node) {
        try {
          e_callStamp(node, decl, sig);
        } catch (_) {}
      }
      return checkArgsAgainst(sig.params, sig.ret, args, frame, span, `\`${decl.name}\``);
    }
    if (sym.symKind === 'struct') {
      return err('A0023', `structs are constructed with braces: \`${name} { ... }\``, span);
    }
    return TyPoison;
  }

  function e_callStamp(node, decl, sig) {
    node.callDecl = decl;
    node.argModes = sig.params.map(p => ({ mode: p.mode, isFloat: false }));
  }

  function checkArgsAgainst(params, ret, args, frame, span, who) {
    if (params.length !== args.length) {
      err('A0009', `${who} expects ${params.length} argument(s), got ${args.length}`, span);
      args.forEach(a => tcExpr(a, frame, 'read'));
      return TyPoison;
    }
    params.forEach((p, i) => {
      const arg = args[i];
      if (p.mode === 'inout') {
        const okPlace = checkPlace(frame, arg, true);
        const aT = tcExpr(arg, frame, 'read');
        if (!okPlace && prune(aT).k !== 'poison') {
          err('A0004', 'an inout parameter needs a mutable place, not a temporary value', arg.span, {
            hint: 'pass a variable declared with var (or an index/field of one)',
          });
        }
        unifyOrErr(aT, p.ty, arg.span, `argument ${i + 1}`);
      } else if (p.mode === 'in') {
        const aT = tcExpr(arg, frame, 'read');
        unifyOrErr(aT, p.ty, arg.span, `argument ${i + 1}`);
      } else {
        const aT = tcExpr(arg, frame, 'consume');
        unifyOrErr(aT, p.ty, arg.span, `argument ${i + 1}`);
      }
    });
    return ret;
  }

  function tcField(e, frame) {
    if (/^\d+$/.test(e.name)) {
      const oT = prune(tcExpr(e.obj, frame, 'read'));
      try { e.objTy = oT; e.tupleIdx = Number(e.name); } catch (_) {}
      if (oT.k === 'tuple') {
        const idx = Number(e.name);
        if (idx < 0 || idx >= oT.items.length) {
          return err('A0002', `tuple index ${idx} out of range (has ${oT.items.length} element(s))`, e.span);
        }
        return oT.items[idx];
      }
      if (oT.k !== 'poison') {
        return err('A0003', `numeric field access needs a tuple, got \`${fmt(oT)}\``, e.span);
      }
      return TyPoison;
    }
    if (e.obj.k === 'name') {
      const sym = frame.scope.lookupValue(e.obj.ident);
      if (sym && sym.symKind === 'enumType') {
        const variant = sym.decl.variants.find(v => v.name === e.name);
        if (!variant) {
          return err('A0028', `enum \`${sym.decl.name}\` has no variant \`${e.name}\``, e.span, {
            hint: `variants: ${sym.decl.variants.map(v => v.name).join(', ')}`,
          });
        }
        if (variant.tys.length !== 0) {
          return err('A0009', `variant \`${e.name}\` takes ${variant.tys.length} payload(s) — call it like ${sym.decl.name}.${e.name}(...)`, e.span);
        }
        try { e.enumCtor = { name: sym.decl.name, variant: e.name, arity: 0 }; } catch (_) {}
        const variants = new Map(
          sym.decl.variants.map(v => [v.name, v.tys.map(t => resolveType(t, programScope, frame.tyEnv))])
        );
        return mkEnum(sym.decl.name, variants);
      }
    }
    const oT = prune(tcExpr(e.obj, frame, 'read'));
    try { e.objTy = oT; } catch (_) {}
    if (oT.k === 'struct') {
      if (!oT.fields.has(e.name)) {
        return err('A0025', `struct \`${oT.name}\` has no field \`${e.name}\``, e.span, {
          hint: `fields: ${[...oT.fields.keys()].join(', ')}`,
        });
      }
      try { e.fieldIdx = [...oT.fields.keys()].indexOf(e.name); } catch (_) {}
      return oT.fields.get(e.name);
    }
    if (oT.k === 'poison') return TyPoison;
    return err('A0003', `\`${fmt(oT)}\` has no fields`, e.span, {
      hint: 'only structs have fields; collections use methods like .len() and .get()',
    });
  }

  function resolveModuleChain(e) {
    const parts = [];
    let cur = e;
    while (cur && cur.k === 'field') {
      parts.unshift(cur.name);
      cur = cur.obj;
    }
    if (!cur || cur.k !== 'name') return null;
    parts.unshift(cur.ident);
    const baseSym = frameScopeLookupValue(cur.ident);
    if (!baseSym || baseSym.symKind !== 'module') return null;
    let members = baseSym.members;
    for (let i = 1; i < parts.length; i++) {
      const m = members[parts[i]];
      if (!m || typeof m !== 'object') return { missing: parts[i], members };
      if ('symKind' in m) return { missing: parts[i], members };
      members = m;
    }
    return { moduleName: parts.join('.'), lastSeg: parts[parts.length - 1], members };
  }

  function frameScopeLookupValue(name) {
    let s = programScope;
    while (s) {
      if (s.values.has(name)) return s.values.get(name);
      s = s.parent;
    }
    return null;
  }

  function tcMethod(e, frame) {
    if (e.obj.k === 'name') {
      const sym = frame.scope.lookupValue(e.obj.ident);
      if (sym && sym.symKind === 'builtinType') {
        try { e.staticCtor = { type: sym.name, def: sym.def }; } catch (_) {}
        return builtinStaticCtor(sym, e.name, e.args, frame, e.span, e.obj.tyArgs);
      }
      if (sym && sym.symKind === 'enumType') {
        return constructUserVariant(sym.decl, e.name, e.args, frame, e.span, e);
      }
    } else {
      const mod = resolveModuleChain(e.obj);
      if (mod) {
        if (mod.missing) {
          return err('A0019', `module path has no member \`${mod.missing}\``, e.span);
        }
        const member = mod.members[e.name];
        if (!member) {
          return err('A0019', `module \`${mod.moduleName}\` has no member \`${e.name}\``, e.span);
        }
        e.moduleCall = mod.moduleName;
        return callSymbol(member, `${mod.moduleName}.${e.name}`, e.args, frame, e.span, e);
      }
    }
    const recvTy = prune(tcExpr(e.obj, frame, 'read'));
    try { e.recvTy = recvTy; e.recvKind = methodKindOf(recvTy); } catch (_) {}

    // module functions: math.add(...)
    if (e.obj.k === 'name') {
      const modSym = frame.scope.lookupValue(e.obj.ident);
      if (modSym && modSym.symKind === 'userModule') {
        const mangled = modSym.members.get(e.name);
        if (!mangled) {
          return err('A0019', `module '${e.obj.ident}' has no function '${e.name}'`, e.span);
        }
        const declSym = programScope.values.get(mangled);
        const mdecl = declSym.decl;
        const msig = fnSignature(mdecl, null);
        if (msig.params.length !== e.args.length) {
          return err('A0009', `function '${e.name}' expects ${msig.params.length} argument(s), got ${e.args.length}`, e.span);
        }
        e.args.forEach((arg, i) => {
          const aT = tcExpr(arg, frame, msig.params[i].mode === 'own' ? 'consume' : 'read');
          unifyOrErr(aT, msig.params[i].ty, arg.span, `argument ${i + 1}`);
        });
        e.moduleFn = { decl: mdecl };
        try { e.methodRetTy = prune(msig.ret); } catch (_) {}
        return msig.ret;
      }
    }

    // user-defined methods take priority over builtins
    {
      const ownerName = recvTy && (recvTy.name || null);
      if (ownerName && programScope.values.has(`${ownerName}.${e.name}`)) {
        const mdecl = programScope.values.get(`${ownerName}.${e.name}`).decl;
        if (mdecl.typarams.length) {
          return err('A0017', 'generic methods are not supported yet', e.span);
        }
        const msig = fnSignature(mdecl, null);
        if (msig.params.length - 1 !== e.args.length) {
          return err('A0009', `method \`.\${e.name}()\` expects ${msig.params.length - 1} argument(s), got ${e.args.length}`, e.span);
        }
        e.userMethod = { decl: mdecl };
        e.args.forEach((arg, i) => {
          const aT = tcExpr(arg, frame, msig.params[i + 1].mode === 'own' ? 'consume' : 'read');
          unifyOrErr(aT, msig.params[i + 1].ty, arg.span, `argument ${i + 1}`);
        });
        e.methodRetTy = prune(msig.ret);
        return msig.ret;
      }
    }

    const kind = methodKindOf(recvTy);
    if (!kind) {
      return err('A0030', `type \`${fmt(recvTy)}\` has no method \`.${e.name}()\``, e.span);
    }
    const table = METHODS[kind];
    const entry = table[e.name];
    if (!entry) {
      return err('A0030', `\`${fmt(recvTy)}\` has no method \`.${e.name}()\``, e.span, {
        hint: `available: ${Object.keys(table).map(m => `.${m}()`).join(', ')}`,
      });
    }
    const sig = entry.sig(recvTy);
    if (sig.selfMode === 'inout') {
      const okPlace = checkPlace(frame, e.obj, true);
      if (!okPlace) {
        err('A0004', `\`.${e.name}()\` mutates its receiver, so the receiver must be a mutable place`, e.obj.span, {
          hint: "declare the receiver with 'var'",
        });
      }
    }
    if (sig.params.length !== e.args.length) {
      err('A0009', `.${e.name}() expects ${sig.params.length} argument(s), got ${e.args.length}`, e.span);
      e.args.forEach(a => tcExpr(a, frame, 'read'));
    } else {
      sig.params.forEach((p, i) => {
        const aT = tcExpr(e.args[i], frame, p.mode === 'own' ? 'consume' : 'read');
        unifyOrErr(aT, p.ty, e.args[i].span, `argument ${i + 1}`);
      });
    }
    e.trapOn = sig.trapOn || null;
    return sig.ret;
  }

  function tcTry(e, frame) {
    const t = prune(tcExpr(e.e, frame, 'read'));
    const ret = prune(frame.retTy);
    if (t.k === 'enum' && t.name === 'Option') {
      const inner = t.variants.get('Some')[0];
      if (!(ret.k === 'enum' && ret.name === 'Option')) {
        return err('A0031', '`?` propagates Option, but this function does not return Option', e.span, {
          hint: `declare the return type as Option[${fmt(inner)}]`,
        });
      }
      unifyOrErr(inner, ret.variants.get('Some')[0], e.span, '?-propagated payload');
      return inner;
    }
    if (t.k === 'enum' && t.name === 'Result') {
      const okTy = t.variants.get('Ok')[0];
      const errTy = t.variants.get('Err')[0];
      if (!(ret.k === 'enum' && ret.name === 'Result')) {
        return err('A0031', '`?` propagates Result, but this function does not return Result', e.span, {
          hint: `declare the return type as Result[${fmt(okTy)}, ${fmt(errTy)}]`,
        });
      }
      unifyOrErr(okTy, ret.variants.get('Ok')[0], e.span, '?-propagated Ok payload');
      unifyOrErr(errTy, ret.variants.get('Err')[0], e.span, '?-propagated Err payload');
      return okTy;
    }
    if (t.k !== 'poison') {
      return err('A0031', `\`?\` applies to Option or Result, not to \`${fmt(t)}\``, e.span);
    }
    return TyPoison;
  }

  function patternCheck(pat, ty, frame, stats) {
    const p = prune(ty);
    switch (pat.k) {
      case 'pwild': return;
      case 'pbind':
        declareLocal(frame, pat.name, p, { mutable: false, loan: false, span: pat.span });
        stats.boundCount++;
        return;
      case 'plit': {
        const kindMap = { int: 'int', float: 'float', str: 'str', bool: 'bool' };
        if (p.k !== kindMap[pat.kind]) {
          err('A0003', `pattern literal does not match scrutinee type \`${fmt(p)}\``, pat.span);
        }
        return;
      }
      case 'ptuple': {
        if (p.k !== 'tuple' || p.items.length !== pat.items.length) {
          err('A0003', `tuple pattern of ${pat.items.length} element(s) cannot match \`${fmt(p)}\``, pat.span);
          return;
        }
        pat.items.forEach((sub, i) => patternCheck(sub, p.items[i], frame, stats));
        return;
      }
      case 'pvariant': {
        if (p.k !== 'enum' || !p.variants.has(pat.name)) {
          err('A0028', `pattern \`${pat.name}\` is not a variant of \`${fmt(p)}\``, pat.span);
          return;
        }
        const payloads = p.variants.get(pat.name);
        if (payloads.length !== pat.subs.length) {
          err('A0009', `variant \`${pat.name}\` has ${payloads.length} payload(s), pattern binds ${pat.subs.length}`, pat.span);
          return;
        }
        pat.subs.forEach((sub, i) => patternCheck(sub, payloads[i], frame, stats));
        return;
      }
      default: return;
    }
  }

  function tcMatch(e, frame) {
    const scrutineeTy = prune(tcExpr(e.scrutinee, frame, 'read'));
    try { e.scrutineeTy = scrutineeTy; } catch (_) {}
    let resultTy = freshVar('M');
    const covered = new Set();
    let catchAll = false;

    for (const arm of e.arms) {
      frame.scope = new Scope(frame.scope);
      const stats = { boundCount: 0 };
      patternCheck(arm.pattern, scrutineeTy, frame, stats);
      if (arm.pattern.k === 'pbind' || arm.pattern.k === 'pwild') {
        if (!arm.guard) catchAll = true;
      } else if (arm.pattern.k === 'pvariant' && scrutineeTy.k === 'enum') {
        covered.add(arm.pattern.name);
      }
      if (arm.guard) {
        const gT = tcExpr(arm.guard, frame, 'read');
        expectType(gT, TyBool, arm.guard.span, 'match guard');
      }
      const bodyTy = arm.body.k === 'block'
        ? tcBlock(arm.body, frame)
        : tcExpr(arm.body, frame, 'consume');
      unifyOrErr(bodyTy, resultTy, arm.body.span ?? arm.body.span, 'match arm');
      frame.scope = frame.scope.parent;
    }

    if (!catchAll && scrutineeTy.k === 'enum') {
      const missing = [...scrutineeTy.variants.keys()].filter(v => !covered.has(v));
      if (missing.length) {
        err('A0016',
          `match on \`${fmt(scrutineeTy)}\` is not exhaustive — missing variant(s): ${missing.join(', ')}`,
          e.scrutinee.span,
          { hint: 'handle every variant explicitly, or add a catch-all `_ =>` arm' });
      }
    } else if (!catchAll && scrutineeTy.k !== 'poison' && scrutineeTy.k !== 'tvar') {
      err('A0016',
        `match on \`${fmt(scrutineeTy)}\` must include a catch-all \`_\` arm`,
        e.scrutinee.span,
        { hint: 'only enums can be checked for exhaustiveness; other types need a default arm' });
    }

    const namedPlace = e.scrutinee.k === 'name'
      ? frame.scope.lookupLocal(e.scrutinee.ident)
      : null;
    if (namedPlace && !isCopy(namedPlace.ty)) {
      useBinding(frame, namedPlace, 'consume', e.scrutinee.span);
    }

    return prune(resultTy);
  }

  function tcIf(e, frame) {
    const cT = tcExpr(e.cond, frame, 'read');
    expectType(cT, TyBool, e.cond.span, 'if condition');
    const thenTy = tcBlock(e.thenB, frame);
    if (!e.elseB) return TyUnit;
    const elseTy = e.elseB.k === 'block' ? tcBlock(e.elseB, frame) : tcIf(e.elseB, frame);
    const acc = freshVar('I');
    unifyOrErr(thenTy, acc, e.thenB.span, 'then branch');
    unifyOrErr(elseTy, acc, e.elseB.span ?? e.elseB.span, 'else branch');
    return prune(acc);
  }

  for (const d of fns) {
    const tyEnv = d.typarams.length ? new Map(d.typarams.map(t => [t, freshVar(t)])) : null;
    const sig = fnSignature(d, tyEnv);
    const frame = makeFrame(new Scope(programScope), sig.ret);
    frame.tyEnv = tyEnv;
    for (const p of d.params) {
      declareLocal(frame, p.name, resolveType(p.ty, programScope, tyEnv), {
        mutable: p.mode !== 'in',
        span: d.span,
        isParam: true,
      });
    }
    const bodyTy = tcBlock(d.body, frame);
    expectType(bodyTy, sig.ret, d.body.span, `result of \`${d.name}\``);
    reportDroppedHandles(frame);
  }

  if (!hasMain && errors.length === 0) {
    err('A0032', 'program has no entry point', null, {
      hint: 'add `fn main() { ... }`',
    });
  }

  return { errors, warnings, programScope, hasMain };
}
