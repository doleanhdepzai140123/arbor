import { prune } from '../types.js';

export function lowerToCSharp(checkResult, program, opts = {}) {
  const g = new CsGen(checkResult, program, opts);
  return g.generate();
}

class CsGen {
  constructor(check, program, opts) {
    this.check = check;
    this.program = program;
    this.opts = opts;
    this.out = [];
    this.ind = 1;
    this.tmp = 0;
    this.shadowStack = [];
    this.enums = new Map();
    this.taskSeq = 0;
    this.varTys = new Map();
    this.fnRetTy = null;
    this.paramTys = new Map();
    this.fnSigMap = new Map();
    this.constTys = new Map();
    for (const [, sym] of check.programScope.values) {
      if (sym.symKind === 'enumType') this.enums.set(sym.decl.name, sym.decl);
      if (sym.symKind === 'constDecl') {
        const cs = this.primCs(sym.ty);
        if (cs) this.constTys.set(sym.name, cs);
      }
      if (sym.symKind === 'fnDecl') {
        const ps = sym.decl.params.map(p => this.primCs(this.resolveTy(p.ty, null)));
        const rt = sym.decl.retTy ? this.primCs(this.resolveTy(sym.decl.retTy, null)) : null;
        this.fnSigMap.set(sym.decl.name, { ps, ret: rt });
      }
    }
  }

  w(s) { this.out.push('            ' + s + '\n'); }
  fresh(p = 't') { return `${p}${this.tmp++}`; }
  sh(name) {
    for (let i = this.shadowStack.length - 1; i >= 0; i--) {
      if (this.shadowStack[i][name]) return this.shadowStack[i][name];
    }
    return name;
  }

  collected = null;

  primCs(t) {
    if (!t) return null;
    switch (t.k) {
      case 'int': return 'long';
      case 'float': return 'double';
      case 'bool': return 'bool';
      case 'str': return 'string';
      default: return null;
    }
  }

  resolveTy(tyAst, tyEnv) {
    switch (tyAst.k) {
      case 'tyUnit': return { k: 'unit' };
      case 'tyFn': return { k: 'fn' };
      case 'tyArray': return { k: 'array', elem: this.resolveTy(tyAst.elem, tyEnv) };
      case 'tyTuple': return { k: 'tuple', items: tyAst.items.map(t => this.resolveTy(t, tyEnv)) };
      case 'tyName': {
        if (tyEnv && tyEnv.has(tyAst.name)) return tyEnv.get(tyAst.name);
        const k = tyAst.name.toLowerCase();
        if (['int', 'float', 'bool', 'str', 'unit'].includes(k)) return { k };
        if (['array', 'map', 'set', 'table', 'handle'].includes(k)) {
          const args = tyAst.args.map(a => this.resolveTy(a, tyEnv));
          if (k === 'map') return { k, key: args[0], val: args[1], elem: args[0] };
          return { k, elem: args[0], val: args[1], key: args[0] };
        }
        if (k === 'option' || k === 'result') {
          const args = tyAst.args.map(a => this.resolveTy(a, tyEnv));
          return { k, args };
        }
        return { k: 'struct', name: tyAst.name };
      }
      default: return { k: 'unit' };
    }
  }

  boxIf(code, ty) { return ty ? `(object)(${code})` : code; }

  convTo(code, from, to) {
    if (from === to) return from ? `(${to})(${code})` : code;
    if (!to && !from) return code;
    if (!to) return this.boxIf(code, from);
    if (!from) {
      if (to === 'long') return `RT.AsLong(${code})`;
      if (to === 'double') return `RT.AsDoubleE(${code})`;
      if (to === 'bool') return `RT.Truthy(${code})`;
      return `((string)(${code} ?? ""))`;
    }
    if (from === 'long' && to === 'double') return `(double)(${code})`;
    if (from === 'double' && to === 'long') return `RT.FloatToIntRaw(${code})`;
    return code;
  }

  generate() {
    this.collected = [];
    const fns = this.program.decls.filter(d => d.k === 'fn');
    const parts = [PRELUDE, 'public static class Generated', '{'];

    for (const cd of this.program.decls.filter(d => d.k === 'const' && d.constValue !== undefined)) {
      const v = cd.constValue;
      if (typeof v === 'number') {
        parts.push(Number.isInteger(v)
          ? `    public static readonly long ${Cs.id(cd.name)} = ${v}L;`
          : `    public static readonly double ${Cs.id(cd.name)} = ${v}D;`);
      } else if (typeof v === 'boolean') {
        parts.push(`    public static readonly bool ${Cs.id(cd.name)} = ${v ? 'true' : 'false'};`);
      } else if (typeof v === 'string') {
        parts.push(`    public static readonly string ${Cs.id(cd.name)} = ${Cs.str(v)};`);
      }
    }
    if (this.program.decls.some(d => d.k === 'const')) parts.push('');

    for (const d of fns) {
      const mangled = d.name.includes('.')
        ? `ab_${d.name.split('.')[0]}_${d.name.split('.')[1]}`
        : `ab_${d.name}`;
      this.varTys = new Map();
      this.paramTys = new Map();
      const resolved = d.params.map(p => ({ name: p.name, t: this.resolveTy(p.ty, null) }));
      const retT = d.retTy ? this.resolveTy(d.retTy, null) : { k: 'unit' };
      const retPrim = this.primCs(retT);
      const allPrimParams = resolved.every(p => this.primCs(p.t));
      const typedSig = allPrimParams && retPrim !== null;
      this.fnRetTy = typedSig ? retPrim : null;
      const params = resolved.map(p => {
        const cs = this.primCs(p.t);
        if (cs) this.varTys.set(Cs.id(p.name), cs);
        this.paramTys.set(p.name, cs);
        return cs ? `${cs} ${Cs.id(p.name)}` : `object ${Cs.id(p.name)}`;
      }).join(', ');
      this.ind = 1;
      this.out = [];
      const last = d.body.stmts[d.body.stmts.length - 1];
      // a trailing expression, match or if produces the function's value
      const lastIsValue = !!(last && (last.k === 'expr' || last.k === 'match' || last.k === 'if'));
      for (let i = 0; i < d.body.stmts.length - (lastIsValue ? 1 : 0); i++) {
        this.genStmt(d.body.stmts[i]);
      }
      let tail = 'return RT.UNIT;';
      if (lastIsValue) {
        const rv = this.genExpr(last.k === 'expr' ? last.e : last);
        tail = this.fnRetTy
          ? `return ${this.convTo(rv, this.lastTy, this.fnRetTy)};`
          : `return ${this.boxIf(rv, this.lastTy)};`;
      }
      const head = typedSig
        ? `    public static ${retPrim} ${mangled}(${params})`
        : `    public static object ${mangled}(${params})`;
      parts.push(head);
      parts.push('    {');
      for (const line of this.out.join('').split('\n')) {
        if (line.trim().length) parts.push('        ' + line);
      }
      parts.push('        ' + tail);
      parts.push('    }');
      parts.push('');
    }
    parts.push('}');
    parts.push(MAIN_ENTRY);
    return parts.join('\n');
  }

  genStmt(st) {
    switch (st.k) {
      case 'let':
      case 'var': {
        const init = this.genExpr(st.init);
        const ity = this.inferTyE(st.init);
        if (st.pat) {
          this.w(`object __tup = ${init};`);
          this.destructure(st.pat, '__tup');
          break;
        }
        const nm = Cs.id(st.name);
        if (ity) {
          this.varTys.set(nm, ity);
          this.w(`${ity} ${nm} = ${this.convTo(init, this.lastTy, ity)};`);
        } else {
          this.varTys.delete(nm);
          this.w(`object ${nm} = ${init};`);
        }
        break;
      }
      case 'assign':
        this.assignTarget(st.target, this.genExpr(st.value));
        break;
      case 'expr': {
        const k = st.e.k;
        const val = this.genExpr(st.e);
        if (k !== 'match' && k !== 'if' && k !== 'block') this.w(`${val};`);
        break;
      }
      case 'return':
        this.w(`return ${st.value ? this.genExpr(st.value) : 'RT.UNIT'};`);
        break;
      case 'break': this.w(`break;`); break;
      case 'continue': this.w(`continue;`); break;
      case 'while': {
        this.w(`while (${this.truthy(this.genExpr(st.cond))})`);
        this.w(`{`);
        this.ind++;
        this.genBlockRaw(st.body);
        this.ind--;
        this.w(`}`);
        break;
      }
      case 'for': {
        const iter = this.genExpr(st.iter);
        this.w(`{`);
        this.ind++;
        this.w(`var __it = (System.Collections.Generic.List<object>)RT.Iterate(${iter});`);
        const bindName = Cs.id(this.patBind(st.pat));
        const elemCs = this.primCs(st.elemTy);
        const typedBind = elemCs && st.pat.k === 'pbind';
        if (typedBind) {
          this.w(`${elemCs} ${bindName} = default(${elemCs});`);
          this.w(`foreach (object __e in __it) {`);
          this.ind++;
          this.w(`${bindName} = ${this.convTo('__e', null, elemCs)};`);
        } else {
          this.w(`foreach (object ${bindName} in __it) {`);
          this.ind++;
        }
        this.genBlockRaw(st.body);
        this.ind--;
        this.w(`}`);
        if (typedBind) this.varTys.delete(bindName);
        this.ind--;
        this.w(`}`);
        break;
      }
      case 'region': {
        this.w(`RT.RegionEnter();`);
        this.genBlockRaw(st.body);
        this.w(`RT.RegionExit();`);
        break;
      }
      case 'spawn': {
        const caps = st.captures || [];
        this.w(`{`);
        this.ind++;
        caps.forEach((n, i) => {
          this.w(`object __cap${i} = RT.CloneVal(${Cs.id(this.sh(n))});`);
        });
        const args = caps.map((_, i) => `__cap${i}`).join(', ');
        this.w(`RT.Spawn(() => {`);
        this.ind++;
        const shadow = new Map();
        caps.forEach((n, i) => shadow.set(n, `__cap${i}`));
        this.shadowStack.push(shadow);
        this.genBlockRaw(st.body);
        this.shadowStack.pop();
        this.ind--;
        this.w(`});`);
        this.ind--;
        this.w(`}`);
        break;
      }
      default: break;
    }
  }

  destructure(pat, ref) {
    if (pat.k !== 'ptuple') return;
    pat.items.forEach((sub, i) => {
      if (sub.k === 'pbind') {
        this.w(`object ${sub.name} = ((AbTuple)${ref}).Items[${i}];`);
      } else if (sub.k === 'ptuple') {
        const nested = this.fresh('nt');
        this.w(`object[] ${nested} = ((AbTuple)((AbTuple)${ref}).Items[${i}]).Items;`);
        this.destructure(sub, nested);
      }
    });
  }

  patBind(pat) { return pat.k === 'pbind' ? pat.name : '_p'; }

  truthy(expr) { return `RT.Truthy(${expr})`; }

  genBlockRaw(b) {
    for (const s of b.stmts) this.genStmt(s);
  }

  assignTarget(t, v) {
    switch (t.k) {
      case 'name': this.w(`${Cs.id(this.sh(t.ident))} = ${v};`); break;
      case 'index': this.w(`RT.ArrSet(${this.genExpr(t.obj)}, ${this.genExpr(t.idx)}, ${v});`); break;
      case 'field':
        if (/^\d+$/.test(t.name)) this.w(`RT.TupSet(${this.genExpr(t.obj)}, ${t.name}, ${v});`);
        else this.w(`RT.StructSet(${this.genExpr(t.obj)}, "${t.name}", ${v});`);
        break;
      default: break;
    }
  }

  strLit(e) {
    const segs = [];
    for (const p of e.parts) {
      if (p.str !== undefined) segs.push({ lit: p.str });
      else segs.push({ expr: p.expr });
    }
    if (segs.length === 0) return 'RT.STR_EMPTY';
    if (segs.length === 1 && segs[0].lit !== undefined) {
      return `RT.Lit(${Cs.str(segs[0].lit)})`;
    }
    const args = segs.map(s =>
      s.lit !== undefined ? RT_lit(s.lit) : `RT.Fmt(${this.genExpr(s.expr)})`
    ).join(', ');
    return `RT.StrJoin(${args})`;

    function RT_lit(x) { return `RT.Lit(${Cs.str(x)})`; }
  }

  genExpr(e) {
    this.lastTy = null;
    return this.genExprCase(e);
  }

  genExprCase(e) {
    switch (e.k) {
      case 'int':
        this.lastTy = 'long';
        return `${e.v}L`;
      case 'float':
        this.lastTy = 'double';
        return `${e.v}D`;
      case 'bool':
        this.lastTy = 'bool';
        return e.v ? 'true' : 'false';
      case 'unit':
        this.lastTy = null;
        return `RT.UNIT`;
      case 'str':
        this.lastTy = 'string';
        return this.strLit(e);
      case 'name': {
        if (e.enumCtor) { this.lastTy = null; return `RT.Enum(${Cs.str(e.enumCtor.name)}, ${Cs.str(e.enumCtor.variant)}, new object[0])`; }
        if (this.constTys.has(e.ident)) { this.lastTy = this.constTys.get(e.ident); return `Generated.${Cs.id(e.ident)}`; }
        this.lastTy = this.varTys.get(this.sh(e.ident)) ?? this.paramTys.get(this.sh(e.ident)) ?? null;
        return Cs.id(this.sh(e.ident));
      }
      case 'unary': {
        const v = this.genExpr(e.e);
        const t = this.inferTyE(e.e);
        if (e.op === '-') {
          if (t === 'long') { this.lastTy = 'long'; return `RT.LNeg(${v})`; }
          if (t === 'double') { this.lastTy = 'double'; return `(-(${v}))`; }
          this.lastTy = null;
          return `RT.Neg(${v})`;
        }
        if (t === 'bool') { this.lastTy = 'bool'; return `(!(${v}))`; }
        this.lastTy = 'bool';
        return `RT.Not(${v})`;
      }
      case 'binary': return this.genBinary(e);
      case 'call': return this.genCall(e);
      case 'method': return this.genMethod(e);
      case 'index': {
        const o = this.genExpr(e.obj), i = this.genExpr(e.idx);
        const objTy = this.inferTyE(e.obj);
        if (objTy === 'string') {
          this.lastTy = 'string';
          return `RT.StrIdx(${o}, ${i})`;
        }
        // plain indexing yields the element directly (bounds-checked),
        // matching the reference VM — Option-wrapped access is `.get(i)`
        this.lastTy = null;
        return `RT.ArrGet(${o}, ${i})`;
      }
      case 'field': {
        // zero-payload enum variant used as a value: Shape.Point
        if (e.enumCtor) {
          this.lastTy = null;
          return `RT.Enum(${Cs.str(e.enumCtor.name)}, ${Cs.str(e.enumCtor.variant)}, new object[] { })`;
        }
        const r = this.genExpr(e.obj);
        if (/^\d+$/.test(e.name)) { this.lastTy = null; return `RT.TupGet(${r}, ${e.name})`; }
        this.lastTy = e.fieldPrim ?? null;
        return `RT.StructGet(${r}, "${e.name}")`;
      }
      case 'try': {
        const sv = this.genExpr(e.e);
        const pv = this.fresh('tryv');
        this.w(`object ${pv};`);
        this.w(`{`);
        this.ind++;
        this.w(`AbEnum __e = ${sv} as AbEnum;`);
        this.w(`if (__e == null || (__e.Variant != "Some" && __e.Variant != "Ok")) { return (object)(__e ?? RT.NoneO()); }`);
        this.w(`${pv} = __e.Payload[0];`);
        this.ind--;
        this.w(`}`);
        this.lastTy = null;
        return pv;
      }
      case 'structLit': {
        const fields = e.fields.map(f => `{ "${f.name}", ${this.genExpr(f.value)} }`).join(', ');
        return `RT.Struct("${e.name}", new Dictionary<string, object> { ${fields} })`;
      }
      case 'arrayLit': {
        const items = e.items.map(x => this.genExpr(x)).join(', ');
        return `RT.ArrLit(new object[] { ${items} })`;
      }
      case 'mapLit': {
        const entries = e.entries.map(en => `new KeyValuePair<object, object>(${this.genExpr(en.key)}, ${this.genExpr(en.value)})`).join(', ');
        return `RT.MapLit(new[] { ${entries} })`;
      }
      case 'tupleLit': {
        const items = e.items.map(x => this.genExpr(x)).join(', ');
        return `RT.Tuple(new object[] { ${items} })`;
      }
      case 'closure': {
        const paramNames = e.params.map(p => p.name);
        const savedOut = this.out, savedInd = this.ind;
        this.out = []; this.ind = 1;
        for (let i = 0; i < paramNames.length; i++) {
          this.w(`object ${paramNames[i]} = args[${i}];`);
        }
        if (e.isExpr) {
          const r = this.genExpr(e.body);
          this.w(`return ${r};`);
        } else {
          const stmts = e.body.stmts;
          const last = stmts[stmts.length - 1];
          const n = stmts.length - (last && last.k === 'expr' ? 1 : 0);
          for (let i = 0; i < n; i++) this.genStmt(stmts[i]);
          if (last && last.k === 'expr') this.w(`return ${this.genExpr(last.e)};`);
          else this.w(`return RT.UNIT;`);
        }
        const body = this.out.join('').replace(/\n/g, ' ').trim();
        this.out = savedOut; this.ind = savedInd;
        return `RT.Closure(new string[] {}, (AbFn)((object[] args) => { ${body} }))`;
      }
      case 'match': { const r = this.genMatch(e); this.lastTy = null; return r; }
      case 'if': { const r = this.genIf(e); this.lastTy = null; return r; }
      case 'block': {
        this.w(`{`);
        this.ind++;
        this.genBlockRaw(e);
        this.ind--;
        this.w(`}`);
        return `RT.UNIT`;
      }
      default: return `RT.UNIT`;
    }
  }

  inferTyE(e) {
    if (!e) return null;
    const t = e.ty ? prune(e.ty) : null;
    return this.primCs(t);
  }

  genBinary(e) {
    const lt = this.inferTyE(e.l);
    const rt = this.inferTyE(e.r);
    if (e.op === 'and' || e.op === 'or') {
      if (lt === 'bool' && rt === 'bool') {
        const l = this.genExpr(e.l), r = this.genExpr(e.r);
        this.lastTy = 'bool';
        return e.op === 'and' ? `((${l}) && (${r}))` : `((${l}) || (${r}))`;
      }
      const l0 = this.genExpr(e.l), r0 = this.genExpr(e.r);
      this.lastTy = 'bool';
      return e.op === 'and'
        ? `(RT.Truthy(${l0}) ? ${r0} : (object)false)`
        : `(RT.Truthy(${l0}) ? (object)true : ${r0})`;
    }
    // match guards run against boxed pattern bindings — never use raw C#
    // operators there even when the checker stamped static types
    const numericSame = !this.forceObj && ((lt === 'long' && rt === 'long') || (lt === 'double' && rt === 'double'));
    const l = this.genExpr(e.l);
    const r = this.genExpr(e.r);

    if (numericSame) {
      switch (e.op) {
        case '+': this.lastTy = lt; return lt === 'long' ? `RT.LAdd(${l}, ${r})` : `((${l}) + (${r}))`;
        case '-': this.lastTy = lt; return lt === 'long' ? `RT.LSub(${l}, ${r})` : `((${l}) - (${r}))`;
        case '*': this.lastTy = lt; return lt === 'long' ? `RT.LMul(${l}, ${r})` : `((${l}) * (${r}))`;
        case '/':
          this.lastTy = lt;
          return lt === 'long' ? `RT.LDiv(${l}, ${r})` : `((${l}) / (${r}))`;
        case '%':
          this.lastTy = lt;
          return lt === 'long' ? `RT.LRem(${l}, ${r})` : `((${l}) % (${r}))`;
        case '<': case '<=': case '>': case '>=':
          this.lastTy = 'bool';
          return `((${l}) ${e.op} (${r}))`;
        case '==': this.lastTy = 'bool'; return `((${l}) == (${r}))`;
        case '!=': this.lastTy = 'bool'; return `((${l}) != (${r}))`;
        case '..': this.lastTy = null; return `RT.RangeL(${l}, ${r})`;
        default: break;
      }
    }
    if (lt === 'string' && rt === 'string' && e.op === '+') {
      this.lastTy = 'string';
      return `((${l}) + (${r}))`;
    }
    if ((lt === 'string' && rt === 'string') && (e.op === '==' || e.op === '!=')) {
      this.lastTy = 'bool';
      return e.op === '==' ? `string.Equals(${l}, ${r})` : `!string.Equals(${l}, ${r})`;
    }
    if ((lt === 'string' && rt === 'string') && (e.op === '<' || e.op === '<=' || e.op === '>' || e.op === '>=')) {
      this.lastTy = 'bool';
      const cmp = `string.Compare(${l}, ${r})`;
      if (e.op === '<') return `((${cmp}) < 0)`;
      if (e.op === '<=') return `((${cmp}) <= 0)`;
      if (e.op === '>') return `((${cmp}) > 0)`;
      return `((${cmp}) >= 0)`;
    }
    const op = { '==': 'Eq', '!=': 'Ne', '<': 'Lt', '<=': 'Le', '>': 'Gt', '>=': 'Ge', '+': 'Add', '-': 'Sub', '*': 'Mul', '/': 'Div', '%': 'Rem', '..': 'RangeOf' }[e.op];
    this.lastTy = null;
    return `RT.${op}(${l}, ${r})`;
  }

  genCall(e) {
    if (e.bifPath) return this.genBif(e);
    const info = e.userVariant || (e.enumCtor ? { name: e.enumCtor.name, variant: e.enumCtor.variant } : null) || (e.ctor ? { name: e.ctor.enumName ?? e.ctor.name, variant: e.ctor.variantName ?? e.ctor.variant } : null);
    if (info) {
      const args = e.args.map(a => this.genExpr(a));
      return `RT.Enum(${Cs.str(info.name)}, ${Cs.str(info.variant)}, new object[] { ${args.join(', ')} })`;
    }
    if (e.callDecl) {
      const sig = this.fnSigMap.get(e.callDecl.name);
      const args = e.args.map((a, i) => {
        const code = this.genExpr(a);
        if (!sig) return code;
        const want = sig.ps[i] ?? null;
        return this.convTo(code, this.inferTyE(a), want);
      });
      this.lastTy = sig ? sig.ret : null;
      return `ab_${e.callDecl.name}(${args.join(', ')})`;
    }
    const callee = this.genExpr(e.callee);
    const args = e.args.map(a => this.genExpr(a));
    return `RT.CallClosure(${callee}, new object[] { ${args.join(', ')} })`;
  }

  static BIF_TY = {
    'std.math.sqrt': 'double', 'std.math.floor': 'double', 'std.math.ceil': 'double', 'std.math.round': 'double',
    'std.math.abs': 'double', 'std.math.exp': 'double', 'std.math.ln': 'double', 'std.math.sin': 'double', 'std.math.cos': 'double',
    'std.mem.live': 'long', 'std.mem.allocs': 'long', 'std.io.to_str': 'string',
  };

  genBif(e) {
    const vals = e.args.map(a => this.genExpr(a));
    this.lastTy = CsGen.BIF_TY?.[e.bifPath] ?? null;
    switch (e.bifPath) {
      case 'std.io.println': return `RT.Println(${vals[0] ?? 'RT.UNIT'})`;
      case 'std.io.print': return `RT.Print(${vals[0] ?? 'RT.UNIT'})`;
      case 'std.io.dbg': return `RT.Dbg(${vals[0] ?? 'RT.UNIT'})`;
      case 'drop': return `RT.Drop(${vals[0] ?? 'RT.UNIT'})`;
      case 'assert': return `RT.Assert(RT.Truthy(${vals[0]}))`;
      case 'assert_eq': return `RT.AssertEq(${vals[0]}, ${vals[1]})`;
      case 'std.math.sqrt': return `RT.FMath(${vals[0]}, Math.Sqrt)`;
      case 'std.math.floor': return `RT.FMath(${vals[0]}, Math.Floor)`;
      case 'std.math.ceil': return `RT.FMath(${vals[0]}, Math.Ceiling)`;
      case 'std.math.round': return `RT.FMath(${vals[0]}, Math.Round)`;
      case 'std.math.abs': return `RT.FMath(${vals[0]}, Math.Abs)`;
      case 'std.math.exp': return `RT.FMath(${vals[0]}, Math.Exp)`;
      case 'std.math.ln': return `RT.FMath(${vals[0]}, Math.Log)`;
      case 'std.math.sin': return `RT.FMath(${vals[0]}, Math.Sin)`;
      case 'std.math.cos': return `RT.FMath(${vals[0]}, Math.Cos)`;
      case 'std.math.pow': return `RT.Pow(${vals[0]}, ${vals[1]})`;
      case 'std.fs.read_file': return `RT.ReadFile(${vals[0]})`;
      case 'std.fs.write_file': return `RT.WriteFile(${vals[0]}, ${vals[1]})`;
      case 'std.time.now_ms': return `RT.NowMs()`;
      case 'std.env.args': return `RT.CliArgs()`;
      case 'std.fs.read_file': return `RT.ReadFile(${vals[0]})`;
      case 'std.fs.write_file': return `RT.WriteFile(${vals[0]}, ${vals[1]})`;
      case 'std.time.now_ms': return `RT.NowMs()`;
      case 'std.env.args': return `RT.CliArgs()`;
      case 'std.process.exec': return `RT.Exec(${vals[0]}, ${vals[1]})`;
      case 'std.mem.live': return `RT.MemLive()`;
      case 'std.mem.allocs': return `RT.MemAllocs()`;
      default: return `RT.UNIT`;
    }
  }

  static METHOD_TY = {
    'int:len': 'long', 'int:abs': 'long', 'str:len': 'long',
    'array:len': 'long', 'map:len': 'long', 'set:len': 'long', 'table:len': 'long',
    'float:sqrt': 'double', 'float:abs': 'double', 'float:floor': 'double', 'float:ceil': 'double', 'float:round': 'double',
    'bool:is_empty': 'bool', 'array:is_empty': 'bool', 'map:is_empty': 'bool', 'set:is_empty': 'bool', 'table:is_empty': 'bool',
    'array:contains': 'bool', 'map:contains_key': 'bool', 'set:contains': 'bool', 'table:alive': 'bool',
    'option:is_some': 'bool', 'option:is_none': 'bool', 'result:is_ok': 'bool', 'result:is_err': 'bool',
    'int:to_float': 'double',
    'int:to_str': 'string', 'float:to_str': 'string', 'bool:to_str': 'string',
    'str:upper': 'string', 'str:lower': 'string', 'str:trim': 'string',
    'map:keys': null,
  };

  genMethod(e) {
    const r = this.genMethodCase(e);
    this.lastTy = (e.staticCtor || e.moduleCall) ? null
      : (CsGen.METHOD_TY[e.recvKind + ':' + e.name] ?? null);
    if (e.staticCtor && e.staticCtor.type === 'Table') this.lastTy = null;
    return r;
  }

  genMethodCase(e) {
    if (e.bifPath) return this.genBif(e);
    // qualified enum-variant constructor: Shape.Circle(4), Point-style via type name
    if (e.userVariant || e.enumCtor) {
      const info = e.userVariant ?? e.enumCtor;
      const args = (e.args ?? []).map(a => this.genExpr(a));
      this.lastTy = null;
      return `RT.Enum(${Cs.str(info.name)}, ${Cs.str(info.variant)}, new object[] { ${args.join(', ')} })`;
    }
    if (e.moduleFn) {
      const decl = e.moduleFn.decl;
      const mangled = 'ab_' + decl.name;
      const argCodes = e.args.map(a => this.genExpr(a));
      const sig = this.fnSigMap.get(decl.name);
      const conv = argCodes.map((code, i) =>
        this.convTo(code, this.inferTyE(e.args[i]), sig ? (sig.ps[i] ?? null) : null));
      this.lastTy = sig ? sig.ret : null;
      return `${mangled}(${conv.join(', ')})`;
    }
    if (e.userMethod) {
      const decl = e.userMethod.decl;
      const mangled = 'ab_' + decl.name.replace('.', '_');
      const argCodes = e.args.map(a => this.genExpr(a));
      const recvCode = this.genExpr(e.obj);
      const sig = { ps: decl.params.map(p => this.primCs(this.resolveTy(p.ty, null))) };
      const all = [recvCode, ...argCodes];
      const conv = all.map((code, i) => this.convTo(code, i === 0 ? this.inferTyE(e.obj) : this.inferTyE(e.args[i - 1]), sig.ps[i] ?? null));
      this.lastTy = e.methodRetTy ?? null;
      return `${mangled}(${conv.join(', ')})`;
    }
    if (e.staticCtor) {
      switch (e.staticCtor.type) {
        case 'Array': return `RT.ArrLit(new object[0])`;
        case 'Map': return `RT.MapLit(new KeyValuePair<object, object>[0])`;
        case 'Set': return `RT.SetLit(new object[0])`;
        case 'Table': return `RT.TableNew()`;
        default: this.lastTy = null; return `RT.UNIT`;
      }
    }
    const recv = this.genExpr(e.obj);
    const A = () => e.args.map(a => this.genExpr(a));
    const m = e.name;
    switch (e.recvKind) {
      case 'int':
        if (m === 'to_float') return `RT.IntToFloat(${recv})`;
        if (m === 'abs') return `RT.IAbs(${recv})`;
        if (m === 'to_str') return `RT.ToStrAny(${recv})`;
        break;
      case 'float':
        if (m === 'to_int') return `RT.FloatToInt(${recv})`;
        if (m === 'sqrt') return `RT.FMath(${recv}, Math.Sqrt)`;
        if (m === 'abs') return `RT.FMath(${recv}, Math.Abs)`;
        if (m === 'floor') return `RT.FMath(${recv}, Math.Floor)`;
        if (m === 'ceil') return `RT.FMath(${recv}, Math.Ceiling)`;
        if (m === 'round') return `RT.FMath(${recv}, Math.Round)`;
        if (m === 'to_str') return `RT.ToStrAny(${recv})`;
        break;
      case 'str':
        if (m === 'len') return `RT.StrLen(${recv})`;
        if (m === 'upper') return `RT.StrUpper(${recv})`;
        if (m === 'lower') return `RT.StrLower(${recv})`;
        if (m === 'trim') return `RT.StrTrim(${recv})`;
        if (m === 'contains') return `RT.StrContains(${recv}, ${A()[0]})`;
        if (m === 'split') return `RT.StrSplit(${recv}, ${A()[0]})`;
        if (m === 'chars') return `RT.StrChars(${recv})`;
        if (m === 'repeat') return `RT.StrRepeat(${recv}, ${A()[0]})`;
        if (m === 'to_int') return `RT.StrToInt(${recv})`;
        if (m === 'starts_with') return `RT.StrStartsWith(${recv}, ${A()[0]})`;
        if (m === 'ends_with') return `RT.StrEndsWith(${recv}, ${A()[0]})`;
        if (m === 'replace') return `RT.StrReplace(${recv}, ${A()[0]}, ${A()[1]})`;
        break;
      case 'bool':
        if (m === 'to_str') return `RT.ToStrAny(${recv})`;
        break;
      case 'array':
        switch (m) {
          case 'len': return `RT.ArrLen(${recv})`;
          case 'push': return `RT.ArrPush(${recv}, ${A()[0]})`;
          case 'pop': return `RT.ArrPop(${recv})`;
          case 'get': return `RT.ArrGetOpt(${recv}, ${A()[0]})`;
          case 'set': return `RT.ArrSetIdx(${recv}, ${A()[0]}, ${A()[1]})`;
          case 'take': return `RT.ArrTake(${recv}, ${A()[0]})`;
          case 'clone': return `RT.ArrClone(${recv})`;
          case 'reverse': return `RT.ArrReverse(${recv})`;
          case 'contains': return `RT.ArrContains(${recv}, ${A()[0]})`;
          case 'is_empty': return `RT.ArrIsEmpty(${recv})`;
          case 'first': return `RT.ArrFirst(${recv})`;
          case 'last': return `RT.ArrLast(${recv})`;
          case 'sort_by': return `RT.ArrSortBy(${recv}, ${A()[0]})`;
          break;
        }
        break;
      case 'map':
        switch (m) {
          case 'len': return `RT.MapLen(${recv})`;
          case 'insert': return `RT.MapInsert(${recv}, ${A()[0]}, ${A()[1]})`;
          case 'get': return `RT.MapGet(${recv}, ${A()[0]})`;
          case 'remove': return `RT.MapRemove(${recv}, ${A()[0]})`;
          case 'keys': return `RT.MapKeys(${recv})`;
          case 'contains_key': return `RT.MapContainsKey(${recv}, ${A()[0]})`;
          case 'is_empty': return `RT.MapIsEmpty(${recv})`;
          break;
        }
        break;
      case 'set':
        switch (m) {
          case 'len': return `RT.SetLen(${recv})`;
          case 'insert': return `RT.SetInsert(${recv}, ${A()[0]})`;
          case 'remove': return `RT.SetRemove(${recv}, ${A()[0]})`;
          case 'contains': return `RT.SetContains(${recv}, ${A()[0]})`;
          case 'to_array': return `RT.SetToArray(${recv})`;
          break;
        }
        break;
      case 'table':
        switch (m) {
          case 'insert': return `RT.TableInsert(${recv}, ${A()[0]})`;
          case 'get': return `RT.TableGet(${recv}, ${A()[0]})`;
          case 'set': return `RT.TableSet(${recv}, ${A()[0]}, ${A()[1]})`;
          case 'remove': return `RT.TableRemove(${recv}, ${A()[0]})`;
          case 'alive': return `RT.TableAlive(${recv}, ${A()[0]})`;
          case 'len': return `RT.TableLen(${recv})`;
          case 'is_empty': return `RT.TableIsEmpty(${recv})`;
          break;
        }
        break;
      case 'option': case 'result':
        switch (m) {
          case 'unwrap': return `RT.Unwrap(${recv}, "${(e.trapOn && e.trapOn.msg) || 'unwrap failed'}")`;
          case 'expect': return `RT.Expect(${recv}, ${A()[0]})`;
          case 'is_some': return `RT.IsSome(${recv})`;
          case 'is_none': return `RT.IsNone(${recv})`;
          case 'is_ok': return `RT.IsOk(${recv})`;
          case 'is_err': return `RT.IsErr(${recv})`;
          case 'unwrap_or': return `RT.UnwrapOr(${recv}, ${A()[0]})`;
          break;
        }
        break;
      default: break;
    }
    return `RT.UNIT`;
  }

  genIf(e) {
    const v = this.fresh('ifv');
    const hasElse = !!e.elseB;
    if (!hasElse) {
      this.w(`if (${this.truthy(this.genExpr(e.cond))})`);
      this.w(`{`);
      this.ind++;
      this.genBranchStmts(e.thenB);
      this.ind--;
      this.w(`}`);
      this.lastTy = null;
      return `RT.UNIT`;
    }
    // typed branch merging: use checker's stamped type for the result variable
    // (disabled: causes CS0266 in else-if chains — needs deeper fix)
    this.w(`object ${v} = RT.UNIT;`);
    this.w(`if (${this.truthy(this.genExpr(e.cond))})`);
    this.w(`{`);
    this.ind++;
    this.genBranchValue(e.thenB, v);
    this.ind--;
    this.w(`}`);
    this.w(`else`);
    this.w(`{`);
    this.ind++;
    if (e.elseB.k === 'block') this.genBranchValue(e.elseB, v);
    else this.w(`${v} = ${this.genIf(e.elseB)};`);
    this.ind--;
    this.w(`}`);
    this.lastTy = null;
    return v;
  }

  genBranchStmts(b) {
    const last = b.stmts[b.stmts.length - 1];
    const n = b.stmts.length - (last && last.k === 'expr' ? 1 : 0);
    for (let i = 0; i < n; i++) this.genStmt(b.stmts[i]);
    if (last && last.k === 'expr') this.w(`${this.genExpr(last.e)};`);
  }

  genBranchValue(b, target) {
    const last = b.stmts[b.stmts.length - 1];
    const n = b.stmts.length - (last && last.k === 'expr' ? 1 : 0);
    for (let i = 0; i < n; i++) this.genStmt(b.stmts[i]);
    if (last && last.k === 'expr') this.w(`${target} = ${this.genExpr(last.e)};`);
    else this.w(`${target} = RT.UNIT;`);
  }

  genMatch(e) {
    const v = this.fresh('mv');
    const scrut = this.genExpr(e.scrutinee);
    const st = e.scrutineeTy ? prune(e.scrutineeTy) : null;
    this.w(`object ${v} = RT.UNIT;`);
    this.w(`{`);
    this.ind++;
    const __uid = this.fresh('u');
    const sV = '__scrut' + __uid;
    const dV = '__done' + __uid;
    this.w(`object ${sV} = ${scrut};`);
    this.w(`bool ${dV} = false;`);

    for (let i = 0; i < e.arms.length; i++) {
      const arm = e.arms[i];
      const conds = [];
      const binds = [];
      this.patternCond(arm.pattern, sV, conds, binds, st);
      const cond = conds.length ? conds.join(' && ') : `(!${dV})`;
      this.w(`if (!${dV} && (${cond}))`);
      this.w(`{`);
      this.ind++;
      // bind pattern variables first so guards can reference them
      for (const b of binds) this.w(b);
      // pattern bindings are runtime objects even when the checker knows
      // their static types — emit the whole arm in RT-helper domain
      const savedForce = this.forceObj;
      this.forceObj = true;
      if (arm.guard) {
        // a failing guard must leave the arm unmatched for later arms
        const g = this.genExpr(arm.guard);
        this.w(`if (${this.truthy(g)})`);
        this.w(`{`);
        this.ind++;
        this.w(`${dV} = true;`);
        this.genArmBody(arm, v);
        this.ind--;
        this.w(`}`);
      } else {
        this.w(`${dV} = true;`);
        this.genArmBody(arm, v);
      }
      this.forceObj = savedForce;
      this.ind--;
      this.w(`}`);
    }
    this.ind--;
    this.w(`}`);
    return v;
  }

  genArmBody(arm, target) {
    if (arm.body.k === 'block') this.genBranchValue(arm.body, target);
    else this.w(`${target} = ${this.genExpr(arm.body)};`);
  }

  patternCond(pat, ref, conds, binds, scrutTy) {
    switch (pat.k) {
      case 'pwild': return;
      case 'pbind':
        binds.push(`object ${pat.name} = ${ref};`);
        return;
      case 'plit': {
        if (pat.kind === 'str') conds.push(`((string)${ref} == ${Cs.str(pat.v)})`);
        else if (pat.kind === 'bool') conds.push(`((${ref}) as bool? == ${pat.v ? 'true' : 'false'})`);
        else if (pat.kind === 'int') conds.push(`(((long)${ref}) == ${pat.v}L)`);
        else conds.push(`(((double)${ref}) == ${pat.v})`);
        return;
      }
      case 'ptuple': {
        conds.push(`(${ref} is AbTuple)`);
        pat.items.forEach((sub, i) => {
          const elemRef = `((AbTuple)${ref}).Items[${i}]`;
          this.patternCond(sub, elemRef, conds, binds, null);
        });
        return;
      }
      case 'pvariant': {
        conds.push(`(${ref} is AbEnum && ((AbEnum)${ref}).Variant == "${pat.name}")`);
        pat.subs.forEach((sub, i) => {
          this.patternCond(sub, `((AbEnum)${ref}).Payload[${i}]`, conds, binds, null);
        });
        return;
      }
      default: return;
    }
  }
}

class Cs {
  static RESERVED = new Set(['base','this','new','class','struct','enum','int','uint','long','ulong','double','float','bool','string','object','var','params','ref','out','in','is','as','lock','checked','unchecked','delegate','event','internal','namespace','operator','override','private','protected','public','readonly','sbyte','sealed','short','sizeof','stackalloc','static','switch','throw','try','typeof','unchecked','unsafe','ushort','using','virtual','void','volatile','while']);
  static id(n) { return Cs.RESERVED.has(n) ? '@' + n : n; }
  static str(s) {
    let out = '"';
    for (const ch of s) {
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\r') out += '\\r';
      else out += ch;
    }
    return out + '"';
  }
}

const PRELUDE = String.raw`
// ARBOR v0.2 — generated C# (native back end via csc)
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using System.Text;

public sealed class AbRange { public long Start; public long End; }
public sealed class AbHole { public static readonly AbHole Instance = new AbHole(); private AbHole() {} }
public sealed class AbUnit { public static readonly AbUnit Instance = new AbUnit(); private AbUnit() {} }

public sealed class AbArr { public List<object> Items = new List<object>(); }
public sealed class AbMap { public Dictionary<string, object> M = new Dictionary<string, object>(); public List<object> Keys = new List<object>(); public List<object> RawKeys = new List<object>(); }
public sealed class AbSet { public HashSet<string> S = new HashSet<string>(); public List<object> Items = new List<object>(); }
public sealed class AbSlot { public ulong Gen; public object Val; }
public sealed class AbTable { public List<AbSlot> Slots = new List<AbSlot>(); public long Live; }
public sealed class AbHandle { public AbTable Tbl; public long Idx; public ulong Gen; }
public sealed class AbStruct { public string Type; public Dictionary<string, object> Fields; }
public sealed class AbEnum { public string EType; public string Variant; public object[] Payload;
    public object TryPayload { get { return Variant == "Some" || Variant == "Ok" ? Payload[0] : this; } } }
public sealed class AbTuple { public object[] Items; }
public delegate object AbFn(object[] args);
public sealed class AbClosure { public string[] Names; public AbFn Fn; }

public static class RT {
    static RT() {
        System.Threading.Thread.CurrentThread.CurrentCulture = System.Globalization.CultureInfo.InvariantCulture;
        System.Threading.Thread.CurrentThread.CurrentUICulture = System.Globalization.CultureInfo.InvariantCulture;
    }
    public static readonly object UNIT = AbUnit.Instance;

    public static long AllocTotal = 0;
    public static List<long> RegionStack = new List<long>();
    public static Queue<Action> Tasks = new Queue<Action>();

    public static void Bump() { AllocTotal++; }
    public static long MemLive() { return RegionStack.Count > 0 ? AllocTotal - RegionStack[RegionStack.Count - 1] : 0; }
    public static long MemAllocs() { return AllocTotal; }
    public static void RegionEnter() { RegionStack.Add(AllocTotal); }
    public static void RegionExit() { if (RegionStack.Count > 0) RegionStack.RemoveAt(RegionStack.Count - 1); }

    public static object Spawn(Action a) { Tasks.Enqueue(a); return UNIT; }

    static readonly object TaskLock = new object();
    public static void DrainAll() {
        // wave-parallel: every task in a wave runs concurrently via Task.Run;
        // tasks spawned during a wave join the next wave.
        while (true) {
            Action[] wave;
            lock (TaskLock) {
                if (Tasks.Count == 0) break;
                wave = Tasks.ToArray();
                Tasks.Clear();
            }
            if (wave.Length == 1) { wave[0](); continue; }
            var ts = new Task[wave.Length];
            for (int i = 0; i < wave.Length; i++) {
                var act = wave[i];
                ts[i] = Task.Run(() => act());
            }
            Task.WaitAll(ts);
        }
    }

    public static object ReadFile(object pathO) {
        try { return OkO(File.ReadAllText(AsStr(pathO))); }
        catch (Exception e) { return ErrO(e.Message); }
    }
    public static object WriteFile(object pathO, object contentsO) {
        try { File.WriteAllText(AsStr(pathO), AsStr(contentsO)); return OkO((object)(long)AsStr(contentsO).Length); }
        catch (Exception e) { return ErrO(e.Message); }
    }
    public static object Exec(object cmdO, object argvO) {
        try {
            var psi = new System.Diagnostics.ProcessStartInfo();
            psi.FileName = AsStr(cmdO);
            psi.Arguments = "";
            var av = (AbArr)argvO;
            foreach (object a in av.Items) {
                string s = AsStr(a);
                string q = ((char)34).ToString();
                string bs = ((char)92).ToString();
                psi.Arguments += (psi.Arguments.Length == 0 ? "" : " ") + q + s.Replace(q, bs + q) + q;
            }
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            var p = System.Diagnostics.Process.Start(psi);
            string so = p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            if (p.ExitCode != 0) return ErrO("exit " + p.ExitCode + ": " + p.StandardError.ReadToEnd());
            return OkO(so);
        } catch (Exception e) { return ErrO(e.Message); }
    }
    public static object NowMs() { return (object)(long)(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); }
    public static object CliArgs() {
        Bump();
        var a = new AbArr();
        var argv = Environment.GetCommandLineArgs();
        for (int i = 1; i < argv.Length; i++) a.Items.Add(argv[i]);
        return a;
    }

    public static void Trap(string code, string msg) {
        Console.Error.WriteLine("error[" + code + "]: " + msg);
        Console.Error.WriteLine(Environment.StackTrace);
        Environment.Exit(1);
    }

    public static object UNITV() { return UNIT; }
    public static bool Truthy(object v) { return v is bool && (bool)v; }
    public static bool IsNoneLike(object v) { return v is AbEnum && (((AbEnum)v).Variant == "None" || ((AbEnum)v).Variant == "Err"); }
    public static object TryPayloadOf(AbEnum e) { return e.TryPayload; }
    public static object TryOf(object v) {
        var en = v as AbEnum;
        if (en != null && (en.Variant == "Some" || en.Variant == "Ok")) return en.Payload[0];
        return v;
    }

    public static string Escape(string s) {
        var sb = new StringBuilder("\"");
        foreach (char c in s) {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\t') sb.Append("\\t");
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }

    public static string FmtDouble(double d) {
        if (Double.IsNaN(d)) return "NaN";
        if (Double.IsPositiveInfinity(d)) return "+inf";
        if (Double.IsNegativeInfinity(d)) return "-inf";
        if (d == Math.Truncate(d) && Math.Abs(d) < 1e15) return d.ToString("0.0###############");
        var s = d.ToString("R");
        return s.Contains(".") || s.Contains("E") || s.Contains("e") ? s : s + ".0";
    }

    public static string Fmt(object v) { return FmtDbg(v, false); }

    public static string FmtDbg(object v, bool dbg) {
        if (v == null || v is AbUnit) return "()";
        if (v is AbHole) return "<hole>";
        if (v is long) return ((long)v).ToString();
        if (v is double) return FmtDouble((double)v);
        if (v is bool) return (bool)v ? "true" : "false";
        if (v is string) return dbg ? Escape((string)v) : (string)v;
        var arr = v as AbArr; if (arr != null) {
            var parts = new List<string>();
            foreach (var x in arr.Items) if (!(x is AbHole)) parts.Add(FmtDbg(x, true));
            return "[" + string.Join(", ", parts) + "]";
        }
        var map = v as AbMap; if (map != null) {
            var parts = new List<string>();
            for (int i = 0; i < map.Keys.Count; i++)
                parts.Add(FmtDbg(map.Keys[i], true) + ": " + FmtDbg(map.M[Key(map.RawKeys[i])], true));
            return "{" + string.Join(", ", parts) + "}";
        }
        var set = v as AbSet; if (set != null) {
            var parts = new List<string>();
            foreach (var x in set.Items) parts.Add(FmtDbg(x, true));
            return "#{" + string.Join(", ", parts) + "}";
        }
        var tbl = v as AbTable; if (tbl != null) return "<Table (" + tbl.Live + " live)>";
        var hnd = v as AbHandle; if (hnd != null) return "#h";
        var tup = v as AbTuple; if (tup != null) {
            var parts = new List<string>();
            foreach (var x in tup.Items) parts.Add(FmtDbg(x, true));
            return "(" + string.Join(", ", parts) + ")";
        }
        var st = v as AbStruct; if (st != null) {
            var parts = new List<string>();
            foreach (var kv in st.Fields) parts.Add(kv.Key + ": " + FmtDbg(kv.Value, true));
            return st.Type + " { " + string.Join(", ", parts) + " }";
        }
        var en = v as AbEnum; if (en != null) {
            if (en.Payload.Length == 0) return en.Variant;
            var parts = new List<string>();
            foreach (var x in en.Payload) parts.Add(FmtDbg(x, true));
            return en.Variant + "(" + string.Join(", ", parts) + ")";
        }
        return "<value>";
    }

    public static object Println(object v) { Console.WriteLine(Fmt(v)); return UNIT; }
    public static object Print(object v) { Console.Write(Fmt(v)); return UNIT; }
    public static object Dbg(object v) { Console.WriteLine("[dbg] " + FmtDbg(v, true)); return UNIT; }
    public static object Drop(object v) { return UNIT; }

    public static string Lit(string s) { return s; }
    public static string STR_EMPTY = "";
    public static object StrJoin(params object[] parts) {
        var sb = new StringBuilder();
        foreach (var p in parts) sb.Append(Fmt(p));
        return sb.ToString();
    }
    public static object ToStrAny(object v) { return Fmt(v); }

    public static object CloneVal(object v) {
        if (v == null || v is long || v is double || v is bool || v is string || v is AbUnit || v is AbHole) return v;
        var t = v as AbTuple; if (t != null) {
            var n = new object[t.Items.Length];
            for (int i = 0; i < t.Items.Length; i++) n[i] = CloneVal(t.Items[i]);
            return new AbTuple { Items = n };
        }
        var st = v as AbStruct; if (st != null) {
            var d = new Dictionary<string, object>();
            foreach (var kv in st.Fields) d[kv.Key] = CloneVal(kv.Value);
            return new AbStruct { Type = st.Type, Fields = d };
        }
        var en = v as AbEnum; if (en != null) {
            var p = new object[en.Payload.Length];
            for (int i = 0; i < en.Payload.Length; i++) p[i] = CloneVal(en.Payload[i]);
            return new AbEnum { EType = en.EType, Variant = en.Variant, Payload = p };
        }
        return v;
    }

    public static long AsLong(object v, string ctx) {
        if (v is long) return (long)v;
        Trap("R0016", "expected an integer in " + ctx);
        return 0;
    }
    public static double AsDouble(object v) { return v is double ? (double)v : System.Convert.ToDouble(v); }
    public static string AsStr(object v) { return (string)v; }

    public static object Neg(object v) {
        if (v is long) return (object)-(long)v;
        return (object)-AsDouble(v);
    }
    public static object Not(object v) { return (object)!Truthy(v); }

    static void Mixed(object a, object b) { Trap("R0016", "mixed numeric types"); }
    static void BothNumeric(object a, object b) {
        bool an = a is long || a is double, bn = b is long || b is double;
        if (!an || !bn) Trap("R0016", "operator needs numbers");
        if ((a is long) != (b is long) && !(a is string)) Mixed(a, b);
    }

    public static object Add(object a, object b) {
        if (a is string && b is string) return (string)a + (string)b;
        BothNumeric(a, b);
        if (a is long) { checked { return (object)((long)a + (long)b); } }
        return (object)(AsDouble(a) + AsDouble(b));
    }
    public static object Sub(object a, object b) {
        BothNumeric(a, b);
        if (a is long) { checked { return (object)((long)a - (long)b); } }
        return (object)(AsDouble(a) - AsDouble(b));
    }
    public static object Mul(object a, object b) {
        BothNumeric(a, b);
        if (a is long) { checked { return (object)((long)a * (long)b); } }
        return (object)(AsDouble(a) * AsDouble(b));
    }
    public static object Div(object a, object b) {
        BothNumeric(a, b);
        if (a is long) {
            if ((long)b == 0) Trap("R0005", "integer division by zero");
            return (object)((long)a / (long)b);
        }
        return (object)(AsDouble(a) / AsDouble(b));
    }
    public static object Rem(object a, object b) {
        BothNumeric(a, b);
        if (a is long) {
            if ((long)b == 0) Trap("R0005", "integer modulo by zero");
            return (object)((long)a % (long)b);
        }
        return (object)(AsDouble(a) % AsDouble(b));
    }

    public static bool ValuesEqual(object a, object b) {
        if (a is long && b is long) return (long)a == (long)b;
        if (a is double && b is double) return (double)a == (double)b;
        if (a is bool && b is bool) return (bool)a == (bool)b;
        if (a is string && b is string) return (string)a == (string)b;
        return ReferenceEquals(a, b);
    }
    public static object Eq(object a, object b) { return (object)ValuesEqual(a, b); }
    public static object Ne(object a, object b) { return (object)!ValuesEqual(a, b); }
    public static object Lt(object a, object b) { return (object)(Cmp(a, b) < 0); }
    public static object Le(object a, object b) { return (object)(Cmp(a, b) <= 0); }
    public static object Gt(object a, object b) { return (object)(Cmp(a, b) > 0); }
    public static object Ge(object a, object b) { return (object)(Cmp(a, b) >= 0); }
    static int Cmp(object a, object b) {
        if (a is string && b is string) return string.Compare((string)a, (string)b);
        BothNumeric(a, b);
        double da = AsDouble(a), db = AsDouble(b);
        return da < db ? -1 : da > db ? 1 : 0;
    }

    public static object CallClosure(object c, object[] args) {
        var cl = c as AbClosure;
        if (cl == null) Trap("A0029", "value is not callable");
        return cl.Fn(args);
    }

    public static object Assert(bool ok) { if (!ok) Trap("R0050", "assertion failed"); return UNIT; }
    public static object AssertEq(object a, object b) {
        if (!ValuesEqual(a, b)) Trap("R0051", "assert_eq failed: " + FmtDbg(a, true) + " != " + FmtDbg(b, true));
        return UNIT;
    }

    public static object FMath(object v, Func<double, double> f) { return (object)f(AsDouble(v)); }
    public static object Pow(object a, object b) { return (object)Math.Pow(AsDouble(a), AsDouble(b)); }
    public static object IntToFloat(object v) { return (object)(double)AsLong(v, "to_float"); }
    public static object FloatToInt(object v) { return (object)((long)Math.Truncate(AsDouble(v))); }
    public static object IAbs(object v) { return (object)Math.Abs((long)v); }

    public static object Iterate(object v) {
        var outList = new List<object>();
        var arr = v as AbArr; if (arr != null) { foreach (var x in arr.Items) if (!(x is AbHole)) outList.Add(x); return outList; }
        if (v is string) { foreach (char c in (string)v) outList.Add(c.ToString()); return outList; }
        var set = v as AbSet; if (set != null) { foreach (var x in set.Items) outList.Add(x); return outList; }
        var rng = v as AbRange; if (rng != null) { for (long i = rng.Start; i < rng.End; i++) outList.Add((object)i); return outList; }
        Trap("R0014", "value is not iterable");
        return outList;
    }

    public static object ArrLit(object[] items) {
        Bump();
        var a = new AbArr();
        foreach (var x in items) a.Items.Add(x);
        return a;
    }
    public static long ArrLen(object o) { var a = (AbArr)o; long n = 0; foreach (var x in a.Items) if (!(x is AbHole)) n++; return n; }
    public static object ArrPush(object o, object v) { ((AbArr)o).Items.Add(v); return UNIT; }
    public static object ArrPop(object o) {
        var a = (AbArr)o;
        while (a.Items.Count > 0 && a.Items[a.Items.Count - 1] is AbHole) a.Items.RemoveAt(a.Items.Count - 1);
        if (a.Items.Count == 0) return NoneO();
        var v = a.Items[a.Items.Count - 1]; a.Items.RemoveAt(a.Items.Count - 1);
        return SomeO(v);
    }
    public static object ArrGetOpt(object o, object idx) {
        var a = (AbArr)o; long i = AsLong(idx, "index");
        if (i < 0 || i >= a.Items.Count || a.Items[(int)i] is AbHole) return NoneO();
        return SomeO(a.Items[(int)i]);
    }
    public static object ArrGet(object o, object idx) {
        var a = (AbArr)o; long i = AsLong(idx, "index");
        if (i < 0 || i >= a.Items.Count) Trap("R0002", "index " + i + " out of bounds for length " + a.Items.Count);
        if (a.Items[(int)i] is AbHole) Trap("R0008", "read of taken slot");
        return a.Items[(int)i];
    }
    public static void ArrSet(object o, object idx, object v) {
        var a = (AbArr)o; long i = AsLong(idx, "index");
        if (i < 0 || i >= a.Items.Count) Trap("R0002", "index " + i + " out of bounds for length " + a.Items.Count);
        a.Items[(int)i] = v;
    }
    public static object ArrSetIdx(object o, object idx, object v) { ArrSet(o, idx, v); return UNIT; }
    public static object ArrTake(object o, object idx) {
        var a = (AbArr)o; long i = AsLong(idx, "index");
        if (i < 0 || i >= a.Items.Count) Trap("R0002", "index " + i + " out of bounds for length " + a.Items.Count);
        if (a.Items[(int)i] is AbHole) Trap("R0008", ".take(): slot was already taken");
        var v = a.Items[(int)i]; a.Items[(int)i] = AbHole.Instance;
        return v;
    }
    public static object ArrClone(object o) {
        Bump();
        return new AbArr { Items = new List<object>(((AbArr)o).Items) };
    }
    public static object ArrReverse(object o) { ((AbArr)o).Items.Reverse(); return UNIT; }
    public static object ArrContains(object o, object v) {
        var a = (AbArr)o;
        foreach (var x in a.Items) if (!(x is AbHole) && ValuesEqual(x, v)) return (object)true;
        return (object)false;
    }
    public static object ArrIsEmpty(object o) { return (object)(ArrLen(o) == 0); }
    public static object ArrFirst(object o) { var a = (AbArr)o; return a.Items.Count > 0 && !(a.Items[0] is AbHole) ? SomeO(a.Items[0]) : NoneO(); }
    public static object ArrLast(object o) {
        var a = (AbArr)o; int i = a.Items.Count - 1;
        return i >= 0 && !(a.Items[i] is AbHole) ? SomeO(a.Items[i]) : NoneO();
    }
    public static object ArrSortBy(object o, object cmp) {
        var a = (AbArr)o;
        var vals = new List<object>();
        foreach (var x in a.Items) if (!(x is AbHole)) vals.Add(x);
        vals.Sort((x, y) => (int)AsLong(CallClosure(cmp, new object[] { x, y }), "cmp"));
        a.Items = vals;
        return UNIT;
    }

    public static string Key(object k) {
        if (k is string) return "s:" + (string)k;
        if (k is bool) return (bool)k ? "b:true" : "b:false";
        return "i:" + (long)k;
    }
    public static object MapLit(KeyValuePair<object, object>[] entries) {
        Bump();
        var m = new AbMap();
        foreach (var e in entries) {
            var k = Key(e.Key);
            if (!m.M.ContainsKey(k)) { m.Keys.Add(k); m.RawKeys.Add(e.Key); }
            m.M[k] = e.Value;
        }
        return m;
    }
    public static long MapLen(object o) { return (long)((AbMap)o).M.Count; }
    public static object MapInsert(object o, object k, object v) {
        var m = (AbMap)o; var kk = Key(k);
        object old; bool had = m.M.TryGetValue(kk, out old);
        if (!had) { m.Keys.Add(kk); m.RawKeys.Add(k); }
        m.M[kk] = v;
        return had ? SomeO(old) : NoneO();
    }
    public static object MapGet(object o, object k) {
        object v; return ((AbMap)o).M.TryGetValue(Key(k), out v) ? SomeO(v) : NoneO();
    }
    public static object MapRemove(object o, object k) {
        var m = (AbMap)o; var kk = Key(k);
        object v; bool had = m.M.TryGetValue(kk, out v);
        if (had) { m.M.Remove(kk); m.Keys.Remove(kk); m.RawKeys.Remove(k); }
        return had ? SomeO(v) : NoneO();
    }
    public static object MapKeys(object o) {
        Bump();
        var a = new AbArr();
        foreach (var rk in ((AbMap)o).RawKeys) a.Items.Add(rk);
        return a;
    }
    public static object MapContainsKey(object o, object k) { return (object)((AbMap)o).M.ContainsKey(Key(k)); }
    public static object MapIsEmpty(object o) { return (object)(((AbMap)o).M.Count == 0); }

    public static object SetLit(object[] items) { Bump(); var s = new AbSet(); foreach (var x in items) SetAddRaw(s, x); return s; }
    static void SetAddRaw(AbSet s, object x) { var k = Key(x); if (s.S.Add(k)) s.Items.Add(x); }
    public static long SetLen(object o) { return ((AbSet)o).S.Count; }
    public static object SetInsert(object o, object v) { return (object)((AbSet)o).S.Add(Key(v)); }
    public static object SetRemove(object o, object v) { var s = (AbSet)o; bool had = s.S.Remove(Key(v)); if (had) s.Items.RemoveAll(x => ValuesEqual(x, v)); return (object)had; }
    public static object SetContains(object o, object v) { return (object)((AbSet)o).S.Contains(Key(v)); }
    public static object SetToArray(object o) { Bump(); var a = new AbArr(); foreach (var x in ((AbSet)o).Items) a.Items.Add(x); return a; }

    public static object Struct(string type, Dictionary<string, object> fields) { Bump(); return new AbStruct { Type = type, Fields = fields }; }
    public static object StructGet(object o, string f) {
        var st = (AbStruct)o;
        object v; if (!st.Fields.TryGetValue(f, out v)) Trap("A0025", "struct " + st.Type + " has no field " + f);
        return v;
    }
    public static void StructSet(object o, string f, object v) { ((AbStruct)o).Fields[f] = v; }

    public static object Enum(string type, string variant, object[] payload) { Bump(); return new AbEnum { EType = type, Variant = variant, Payload = payload }; }
    public static object Tuple(object[] items) { Bump(); return new AbTuple { Items = items }; }
    public static object TupGet(object o, long i) { return ((AbTuple)o).Items[i]; }
    public static void TupSet(object o, long i, object v) { ((AbTuple)o).Items[i] = v; }

    public static object SomeO(object v) { Bump(); return new AbEnum { EType = "Option", Variant = "Some", Payload = new object[] { v } }; }
    public static object NoneO() { return NONE_ENUM; }
    public static object OkO(object v) { Bump(); return new AbEnum { EType = "Result", Variant = "Ok", Payload = new object[] { v } }; }
    public static object ErrO(object v) { Bump(); return new AbEnum { EType = "Result", Variant = "Err", Payload = new object[] { v } }; }
    public static readonly AbEnum NONE_ENUM = new AbEnum { EType = "Option", Variant = "None", Payload = new object[0] };

    public static bool IsSome(object v) { return v is AbEnum && ((AbEnum)v).Variant == "Some"; }
    public static bool IsNone(object v) { return v is AbEnum && ((AbEnum)v).Variant == "None"; }
    public static bool IsOk(object v) { return v is AbEnum && ((AbEnum)v).Variant == "Ok"; }
    public static bool IsErr(object v) { return v is AbEnum && ((AbEnum)v).Variant == "Err"; }
    public static object Unwrap(object v, string msg) {
        var e = (AbEnum)v;
        if (e.Payload.Length == 0 || e.Variant == "None") Trap("R0003", msg == "unwrap failed" ? "called unwrap on None" : msg);
        if (e.Variant == "Err") Trap("R0003", "called unwrap on Err(" + FmtDbg(e.Payload[0], true) + ")");
        return e.Payload[0];
    }
    public static object Expect(object v, object msgObj) {
        var e = (AbEnum)v;
        string m = AsStr(msgObj);
        if (e.Variant == "None" || e.Variant == "Err") Trap("R0003", "unwrap failed: " + m);
        return e.Payload[0];
    }
    public static object UnwrapOr(object v, object dflt) {
        var e = (AbEnum)v;
        return (e.Variant == "Some" || e.Variant == "Ok") ? e.Payload[0] : dflt;
    }

    public static object TableNew() { Bump(); return new AbTable(); }
    public static object TableInsert(object ot, object v) {
        var t = (AbTable)ot;
        foreach (var s in t.Slots) {
            if ((s.Gen & 1UL) == 0) { s.Gen |= 1UL; s.Val = v; t.Live++; return HandleO(t, t.Slots.IndexOf(s), s.Gen); }
        }
        t.Slots.Add(new AbSlot { Gen = 1, Val = v });
        t.Live++;
        return HandleO(t, t.Slots.Count - 1, 1UL);
    }
    static AbHandle HandleO(AbTable t, long idx, ulong gen) { Bump(); return new AbHandle { Tbl = t, Idx = idx, Gen = gen }; }
    static bool Matches(AbHandle h, AbSlot s) { return (s.Gen & 1UL) != 0 && s.Gen == h.Gen; }
    public static object TableGet(object ot, object oh) {
        var t = (AbTable)ot; var h = (AbHandle)oh;
        if (h.Tbl != t || h.Idx >= t.Slots.Count) return NoneO();
        var s = t.Slots[(int)h.Idx];
        return Matches(h, s) ? SomeO(s.Val) : NoneO();
    }
    public static object TableSet(object ot, object oh, object v) {
        var t = (AbTable)ot; var h = (AbHandle)oh;
        if (h.Tbl != t || h.Idx >= t.Slots.Count) return UNIT;
        var s = t.Slots[(int)h.Idx];
        if (Matches(h, s)) s.Val = v;
        return UNIT;
    }
    public static object TableRemove(object ot, object oh) {
        var t = (AbTable)ot; var h = (AbHandle)oh;
        if (h.Tbl != t || h.Idx >= t.Slots.Count) return NoneO();
        var s = t.Slots[(int)h.Idx];
        if (!Matches(h, s)) return NoneO();
        var old = s.Val;
        s.Gen += 2; t.Live--;
        return SomeO(old);
    }
    public static object TableAlive(object ot, object oh) {
        var t = (AbTable)ot; var h = (AbHandle)oh;
        if (h.Tbl != t || h.Idx >= t.Slots.Count) return (object)false;
        return (object)Matches(h, t.Slots[(int)h.Idx]);
    }
    public static long TableLen(object o) { return ((AbTable)o).Live; }
    public static object TableIsEmpty(object o) { return (object)(((AbTable)o).Live == 0); }

    public static object Closure(string[] names, AbFn fn) { Bump(); return new AbClosure { Names = names, Fn = fn }; }

    public static long LAdd(long a, long b) { try { checked { return a + b; } } catch (OverflowException) { Trap("R0004", "integer overflow"); return 0; } }
    public static long LSub(long a, long b) { try { checked { return a - b; } } catch (OverflowException) { Trap("R0004", "integer overflow"); return 0; } }
    public static long LMul(long a, long b) { try { checked { return a * b; } } catch (OverflowException) { Trap("R0004", "integer overflow"); return 0; } }
    public static long LDiv(long a, long b) { if (b == 0) Trap("R0005", "integer division by zero"); return a / b; }
    public static long LRem(long a, long b) { if (b == 0) Trap("R0005", "integer modulo by zero"); return a % b; }
    public static long LNeg(long a) { checked { return -a; } }
    public static double AsDoubleE(object v) { return v is double ? (double)v : System.Convert.ToDouble(v); }
    public static long FloatToIntRaw(double d) { return (long)Math.Truncate(d); }
    public static object RangeOf(object a, object b) { Trap("R0016", "range needs integers"); return UNIT; }
    public static string StrIdx(object s, object i) {
        var str = AsStr(s); var idx = (int)(long)i;
        if (idx < 0 || idx >= str.Length) Trap("R0002", "string index out of bounds");
        return str.Substring(idx, 1);
    }
    public static object RangeL(long s, long e) { Bump(); return new AbRange { Start = s, End = e }; }

    // Dynamic fallbacks: keep typed fast-paths compilable even when the
    // static types of an operand are unknown at codegen time.
    public static object LAdd(object a, object b) { return Add(a, b); }
    public static object LSub(object a, object b) { return Sub(a, b); }
    public static object LMul(object a, object b) { return Mul(a, b); }
    public static object LDiv(object a, object b) {
        if (a is long && ((long)b) == 0) Trap("R0005", "integer division by zero");
        return Div(a, b);
    }
    public static object LRem(object a, object b) {
        if (a is long && ((long)b) == 0) Trap("R0005", "integer modulo by zero");
        return Rem(a, b);
    }
    public static object LNeg(object a) { return Neg(a); }
    public static long AsLong(object v) { return AsLong(v, "value"); }


    public static long StrLen(object s) { return ((string)s).Length; }
    public static object StrUpper(object s) { return ((string)s).ToUpper(); }
    public static object StrLower(object s) { return ((string)s).ToLower(); }
    public static object StrTrim(object s) { return ((string)s).Trim(); }
    public static object StrContains(object s, object sub) { return (object)((string)s).Contains((string)sub); }
    public static object StrSplit(object s, object sep) { Bump(); var a = new AbArr(); foreach (var p in ((string)s).Split(new string[] { (string)sep }, StringSplitOptions.None)) a.Items.Add(p); return a; }
    public static object StrChars(object s) { Bump(); var a = new AbArr(); foreach (var c in (string)s) a.Items.Add(c.ToString()); return a; }
    public static object StrRepeat(object s, object nO) {
        long n = AsLong(nO, "repeat");
        if (n < 0 || n > 10000) Trap("R0010", ".repeat(n) needs 0 <= n <= 10000");
        var sb = new StringBuilder();
        for (long i = 0; i < n; i++) sb.Append((string)s);
        return sb.ToString();
    }
    public static bool StrStartsWith(object s, object p) { return ((string)s).StartsWith((string)p); }
    public static bool StrEndsWith(object s, object p) { return ((string)s).EndsWith((string)p); }
    public static object StrReplace(object s, object oldV, object newV) { return ((string)s).Replace((string)oldV, (string)newV); }
    public static object StrToInt(object s) {
        long v;
        if (long.TryParse(((string)s).Trim(), out v)) return OkO((object)v);
        return ErrO("not an integer: " + Escape((string)s));
    }
}
`;

const MAIN_ENTRY = String.raw`
public static class ArborEntry {
    public static void Main() {
        Generated.ab_main();
        RT.DrainAll();
    }
}
`;
