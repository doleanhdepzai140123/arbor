import { prune, isCopy } from '../types.js';
import { cType, isFloatT, mangle, cStringLiteral } from './c_rt_types.js';

export function lowerToC(checkResult, program, opts = {}) {
  const g = new CGen(checkResult, program, opts);
  return g.generate();
}

class CGen {
  constructor(checkResult, program, opts) {
    this.check = checkResult;
    this.program = program;
    this.opts = opts;
    this.enums = new Map();
    this.structs = new Map();
    this.tmp = 0;
    this.pre = [];
    this.out = [];
    this.ind = 1;
    this.arrShapes = new Map();
    this.tupleShapes = new Map();
    this.shadowStack = [];
    for (const [, sym] of checkResult.programScope.values) {
      if (sym.symKind === 'enumType') this.enums.set(sym.decl.name, sym.decl);
      if (sym.symKind === 'struct') this.structs.set(sym.decl.name, sym.decl);
    }
  }

  w(s) { this.out.push('    '.repeat(this.ind) + s + '\n'); }
  fresh(p = 't') { return `${p}${this.tmp++}`; }
  ty(e) { return e && e.ty ? prune(e.ty) : null; }

  shadowLookup(name) {
    for (let i = this.shadowStack.length - 1; i >= 0; i--) {
      if (this.shadowStack[i].has(name)) return this.shadowStack[i].get(name);
    }
    return name;
  }

  resolveTy(tyAst, tyEnv = null) {
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
        if (k === 'option') return { k: 'option', args: tyAst.args.map(a => this.resolveTy(a, tyEnv)) };
        if (k === 'result') return { k: 'result', args: tyAst.args.map(a => this.resolveTy(a, tyEnv)) };
        return { k: 'struct', name: tyAst.name, __maybeEnum: true };
      }
      default: return { k: 'unit' };
    }
  }

  ct(t) {
    if (!t) return 'void';
    if (t.__tv) return `AbV`;
    if (t.k === 'struct' || t.k === 'enum') {
      const isUserEnum = this.enums.has(t.name) || t.__maybeEnum;
      if (isUserEnum && !this.structs.has(t.name)) return 'AbEnum*';
    }
    return cType(t);
  }

  arrShapeName(elemT) {
    const key = JSON.stringify(this.shapeKey(elemT));
    if (!this.arrShapes.has(key)) this.arrShapes.set(key, elemT);
    return key;
  }

  shapeKey(t) {
    switch (t.k) {
      case 'tuple': return { k: 'tuple', items: t.items.map(x => this.shapeKey(x)) };
      case 'array': case 'set': case 'handle': case 'table': return { k: t.k, e: this.shapeKey(t.elem) };
      case 'map': return { k: 'map', k2: this.shapeKey(t.key), v: this.shapeKey(t.val) };
      default: return { k: t.k };
    }
  }

  generate() {
    const parts = [];
    const fns = this.program.decls.filter(d => d.k === 'fn');
    for (const d of fns) {
      const tyEnv = d.typarams.length ? new Map(d.typarams.map(t => [t, { __tv: t }])) : null;
      d.__sig = {
        params: d.params.map(p => ({ name: p.name, mode: p.mode, t: this.resolveTy(p.ty, tyEnv) })),
        ret: d.retTy ? this.resolveTy(d.retTy, tyEnv) : { k: 'unit' },
      };
    }
    parts.push(this.genDecls());
    for (const d of fns) parts.push(this.genFn(d));
    return parts.join('\n');
  }

  fnSigText(d) {
    const s = d.__sig;
    const params = s.params.length
      ? s.params.map(p => `${this.ct(p.t)} ${p.name}`).join(', ')
      : 'void';
    return `${this.ct(s.ret)} ${mangle(d.name)}(${params})`;
  }

  genDecls() {
    const out = ['#include "arbort.h"', ''];
    for (const d of this.program.decls) {
      if (d.docs) {
        for (const line of d.docs.split('\n')) out.push(`// ${line}`);
      }
    }
    out.push('');
    for (const [name, sd] of this.structs) {
      out.push(`typedef struct AbS_${name} {`);
      for (const f of sd.fields) {
        const t = this.resolveTy(f.ty);
        out.push(`    ${this.ct(t)} ${f.name};`);
      }
      out.push(`} AbS_${name};`);
      out.push('');
    }
    for (const [name, ed] of this.enums) {
      out.push(`static const char* AB_ENUM_${name}_VARIANTS[] = { ${ed.variants.map(v => `"${v.name}"`).join(', ')} };`);
      out.push('');
    }
    for (const d of this.program.decls.filter(x => x.k === 'fn')) {
      out.push(`${this.fnSigText(d)};`);
    }
    out.push('');
    return out.join('\n');
  }

  genFn(d) {
    this.curFnRet = d.__sig.ret;
    this.tmp = 0;
    this.out = [];
    this.ind = 1;
    this.hasSpawn = false;
    this.scanSpawns(d.body);
    this.genBlock(d.body);
    let tail = '';
    const lastStmt = d.body.stmts[d.body.stmts.length - 1];
    const lastIsExpr = lastStmt && lastStmt.k === 'expr';
    if (!lastIsExpr && d.__sig.ret.k !== 'unit') {
      this.w(`return (${this.ct(d.__sig.ret)})0;`);
    }
    if (this.hasSpawn) {
      tail = '    ab_drain_tasks();\n';
    }
    const header = `${this.fnSigText(d)} {`;
    return [header, ...this.out].join('') + tail + '}\n\n';
  }

  scanSpawns(block) {
    for (const st of block.stmts) {
      if (st.k === 'spawn') { this.hasSpawn = true; continue; }
      if (st.k === 'while' || st.k === 'region') this.scanSpawns(st.body);
      else if (st.k === 'for') this.scanSpawns(st.body);
    }
  }

  lift(e) {
    const ty = this.ty(e);
    const needsLift = e.k === 'call' || e.k === 'method' || e.k === 'binary'
      || (e.k === 'str' && e.parts.some(p => p.expr))
      || e.k === 'index' || e.k === 'field' || e.k === 'name'
      || e.k === 'if' || e.k === 'match' || e.k === 'try';
    if (!needsLift) {
      return this.genExprPure(e);
    }
    const v = this.fresh('lv');
    const val = this.genExpr(e, ty);
    this.w(`${this.ct(ty)} ${v} = ${val};`);
    return v;
  }

  genBlock(block) {
    for (const st of block.stmts) this.genStmt(st);
  }

  genStmt(st) {
    switch (st.k) {
      case 'let':
      case 'var': {
        const init = this.lift(st.init);
        if (st.pat) {
          this.w(`${this.ct(st.patTy)} ${this.genPatDecls(st.pat, init).names} = ${init};`);
          break;
        }
        const mut = st.k === 'var' ? '' : 'const ';
        this.w(`${mut}${this.ct(st.varTy)} ${st.name} = ${init};`);
        break;
      }
      case 'expr':
        this.w(`${this.lift(st.e)};`);
        break;
      case 'assign': {
        const v = this.lift(st.value);
        this.assignTarget(st.target, v);
        break;
      }
      case 'return': {
        if (st.value) {
          const v = this.lift(st.value);
          this.w(`return ${v};`);
        } else {
          this.w(`return;`);
        }
        break;
      }
      case 'break': this.w(`goto __brk;`); break;
      case 'continue': this.w(`goto __cnt;`); break;
      case 'while': {
        this.w(`for (;;) {`);
        this.ind++;
        this.w(`__ab_label_cnt:`);
        const c = this.genExpr(st.cond);
        this.w(`if (!(${c})) break;`);
        this.genBlock(st.body);
        this.w(`__ab_label_brk:;`);
        this.ind--;
        this.w(`}`);
        break;
      }
      case 'for': {
        const iter = this.lift(st.iter);
        const et = st.elemTy ? prune(st.elemTy) : { k: 'int' };
        this.w(`{`);
        this.ind++;
        const idxVar = this.fresh('i');
        const lenVar = this.fresh('n');
        this.w(`long long ${idxVar} = 0, ${lenVar} = ab_iter_len(${iter});`);
        this.w(`for (; ${idxVar} < ${lenVar}; ${idxVar}++) {`);
        this.ind++;
        this.w(`__ab_label_cnt:;`);
        this.w(`${this.ct(et)} ${this.genPatBind(st.pat)} = ab_iter_get(${iter}, ${idxVar});`);
        this.genBlock(st.body);
        this.w(`}`);
        this.w(`__ab_label_brk:;`);
        this.ind--;
        this.w(`}`);
        break;
      }
      case 'region': {
        this.w(`{ ab_region_enter();`);
        this.genBlock(st.body);
        this.w(`ab_region_exit(); }`);
        break;
      }
      case 'spawn': {
        const caps = st.captures || [];
        this.w(`{`);
        this.ind++;
        const ctxName = this.fresh('ctx');
        const sizeExpr = caps.length ? caps.length * 8 : 8;
        void sizeExpr;
        this.w(`AbTaskCtx ${ctxName} = ab_task_ctx_new(${caps.length});`);
        caps.forEach((nm, i) => {
          this.w(`ab_task_ctx_set(&${ctxName}, ${i}, &${this.shadowLookup(nm)});`);
        });
        const taskIdx = this.fresh('taskfn');
        this.w(`AbTaskFn ${taskIdx} = ab_make_task_${this.taskSeq++ ?? 0}_${this.fresh('f')};`);
        this.taskSeq = (this.taskSeq || 0) + 1;
        this.w(`ab_spawn_task(${taskIdx}, ${ctxName});`);
        this.ind--;
        this.w(`}`);
        break;
      }
      default: break;
    }
  }

  genPatDecls(pat, init) {
    void pat;
    void init;
    return { names: '_' };
  }

  genPatBind(pat) {
    return pat.k === 'pbind' ? pat.name : '_p';
  }

  assignTarget(target, value) {
    switch (target.k) {
      case 'name':
        this.w(`${this.shadowLookup(target.ident)} = ${value};`);
        break;
      case 'index': {
        const obj = this.lift(target.obj);
        const idx = this.lift(target.idx);
        this.w(`ab_arr_set(&${obj}, ${idx}, ${value});`);
        break;
      }
      case 'field': {
        const obj = this.lift(target.obj);
        this.w(`${obj}->${target.name} = ${value};`);
        break;
      }
      default: break;
    }
  }

  genExprPure(e) {
    const t = this.ty(e);
    switch (e.k) {
      case 'int': return `(ab_i64)${e.v}`;
      case 'float': return `((double)${e.v})`;
      case 'bool': return e.v ? '1' : '0';
      case 'unit': return '0';
      case 'name': return this.shadowLookup(e.ident);
      default: throw new Error(`pure expr expected, got ${e.k}`);
    }
  }

  genExpr(e) {
    const t = this.ty(e);
    switch (e.k) {
      case 'int': case 'float': case 'bool': case 'unit': case 'name':
        return this.genExprPure(e);
      case 'str': return this.genStr(e);
      case 'unary': {
        const v = this.genExpr(e.e);
        return e.op === '-' ? `-(${v})` : `!(${v})`;
      }
      case 'binary': return this.genBinary(e);
      case 'call': return this.genCall(e);
      case 'method': return this.genMethod(e);
      case 'index': {
        const obj = this.genExpr(e.obj);
        const idx = this.genExpr(e.idx);
        return `ab_arr_get(&${obj}, ${idx})`;
      }
      case 'field': {
        const obj = this.genExpr(e.obj);
        return `${obj}->${e.name}`;
      }
      case 'try': {
        const inner = this.genExpr(e.e);
        return `ab_try_unwrap(${inner})`;
      }
      case 'structLit': {
        const v = this.fresh('s');
        this.w(`${this.ct(t)} ${v} = ab_alloc(sizeof(AbS_${e.name}));`);
        for (const f of e.fields) {
          const fv = this.genExpr(f.value);
          this.w(`${v}->${f.name} = ${fv};`);
        }
        return v;
      }
      case 'arrayLit': {
        const v = this.fresh('a');
        this.w(`${this.ct(t)} ${v} = ab_arr_new(${e.items.length});`);
        e.items.forEach((item, i) => {
          const iv = this.genExpr(item);
          this.w(`ab_arr_store(&${v}, ${i}, ${iv});`);
        });
        return v;
      }
      case 'tupleLit': {
        const v = this.fresh('tup');
        this.w(`${this.ct(t)} ${v} = ab_tuple_new(${e.items.length});`);
        e.items.forEach((item, i) => {
          const iv = this.genExpr(item);
          this.w(`ab_tuple_set(&${v}, ${i}, ${iv});`);
        });
        return v;
      }
      case 'closure':
        return `ab_closure_new(0, 0)`;
      case 'match': return this.genMatch(e);
      case 'if': return this.genIf(e);
      case 'block': {
        this.w(`{`);
        this.ind++;
        this.genBlock(e);
        this.ind--;
        this.w(`}`);
        return '0';
      }
      default: return '0';
    }
  }

  genStr(e) {
    const segs = [];
    for (const p of e.parts) {
      if (p.str !== undefined) segs.push({ lit: p.str });
      else segs.push({ expr: p.expr });
    }
    if (segs.length === 1 && segs[0].lit !== undefined) {
      return `ab_str_lit(${JSON.stringify(segs[0].lit)})`;
    }
    const acc = this.fresh('sb');
    this.w(`AbStrBuilder ${acc} = ab_sb_new();`);
    for (const s of segs) {
      if (s.lit !== undefined) {
        this.w(`ab_sb_push(&${acc}, ${JSON.stringify(s.lit)}, ${Buffer.byteLength(s.lit)});`);
      } else {
        const pieceTy = prune(s.expr.ty);
        const piece = this.genExpr(s.expr);
        this.w(`ab_sb_push(&${acc}, ab_as_string_${pieceTy.k}(${piece}), ab_strlen_${pieceTy.k}(${piece}));`);
      }
    }
    const fin = this.fresh('sv');
    this.w(`AbStr* ${fin} = ab_sb_finish(&${acc});`);
    return fin;
  }

  genBinary(e) {
    const lt = prune(e.l.ty);
    if (e.op === 'and' || e.op === 'or') {
      const l = this.genExpr(e.l);
      const r = this.genExpr(e.r);
      return e.op === 'and' ? `((${l}) && (${r}))` : `((${l}) || (${r}))`;
    }
    const l = this.genExpr(e.l);
    const r = this.genExpr(e.r);
    if (isFloatT(lt)) {
      return `((${l}) ${e.op} (${r}))`;
    }
    if (prune(e.r.ty).k === 'str' && e.op === '+') {
      return `ab_str_concat(${l}, ${r})`;
    }
    if (e.op === '==') return `(${l} == ${r})`;
    if (e.op === '!=') return `(${l} != ${r})`;
    if (e.op === '/') return `ab_div_checked(${l}, ${r})`;
    if (e.op === '%') return `ab_rem_checked(${l}, ${r})`;
    return `((${l}) ${e.op} (${r}))`;
  }

  genCall(e) {
    if (e.bifPath) return this.genBifCall(e);
    const args = e.args.map(a => this.genExpr(a));
    const calleeName = e.callDecl ? mangle(e.callDecl.name) : null;
    if (calleeName) return `${calleeName}(${args.join(', ')})`;
    return '0';
  }

  genBifCall(e) {
    const a = e.args.map(x => this.genExpr(x));
    switch (e.bifPath) {
      case 'std.io.println': return `ab_println_any(${a[0] ? this.displayOf(e.args[0]) : '0'})`;
      case 'std.io.print': return `ab_print_any(${a[0] ? this.displayOf(e.args[0]) : '0'})`;
      default: return '0';
    }
  }

  displayOf(argE) {
    const t = prune(argE.ty);
    const v = this.genExpr(argE);
    return `ab_to_string_${t.k}(${v})`;
  }

  genMethod(e) {
    const recv = this.genExpr(e.obj);
    const A = () => e.args.map(a => this.genExpr(a));
    switch (e.recvKind) {
      case 'str':
        if (e.name === 'len') return `ab_str_len_chars(${recv})`;
        if (e.name === 'to_int') return `ab_str_to_int(${recv})`;
        break;
      case 'int':
        if (e.name === 'to_float') return `((double)(${recv}))`;
        if (e.name === 'abs') return `llabs(${recv})`;
        if (e.name === 'to_str') return `ab_str_from_int(${recv})`;
        break;
      case 'float':
        if (e.name === 'to_int') return `((ab_i64)trunc(${recv}))`;
        if (e.name === 'sqrt') return `sqrt(${recv})`;
        if (e.name === 'abs') return `fabs(${recv})`;
        if (e.name === 'floor') return `floor(${recv})`;
        if (e.name === 'ceil') return `ceil(${recv})`;
        if (e.name === 'round') return `round(${recv})`;
        if (e.name === 'to_str') return `ab_str_from_float(${recv})`;
        break;
      case 'array':
        if (e.name === 'len') return `ab_arr_len(&${recv})`;
        if (e.name === 'push') return `(ab_arr_push(&${recv}, ${A()[0]}), 0)`;
        if (e.name === 'get') return `ab_arr_get_opt(&${recv}, ${A()[0]})`;
        if (e.name === 'pop') return `ab_arr_pop(&${recv})`;
        if (e.name === 'take') return `ab_arr_take(&${recv}, ${A()[0]})`;
        if (e.name === 'clone') return recv;
        if (e.name === 'is_empty') return `(ab_arr_len(&${recv}) == 0)`;
        if (e.name === 'first') return `ab_arr_get_opt(&${recv}, 0)`;
        if (e.name === 'last') return `ab_arr_get_opt(&${recv}, ab_arr_len(&${recv}) - 1)`;
        if (e.name === 'reverse') return `(ab_arr_reverse(&${recv}), 0)`;
        break;
      case 'table':
        if (e.name === 'insert') return `ab_table_insert(${recv}, ${A()[0]})`;
        if (e.name === 'get') return `ab_table_get(${recv}, ${A()[0]})`;
        if (e.name === 'remove') return `ab_table_remove(${recv}, ${A()[0]})`;
        if (e.name === 'alive') return `ab_table_alive(${recv}, ${A()[0]})`;
        if (e.name === 'len') return `(((${recv}))->live)`;
        if (e.name === 'is_empty') return `(((${recv})->live) == 0)`;
        break;
      case 'option':
      case 'result': {
        const optM = {
          unwrap: `ab_unwrap`, expect: `ab_expect`,
          is_some: `ab_is_some`, is_none: `ab_is_none`,
          is_ok: `ab_is_ok`, is_err: `ab_is_err`,
          unwrap_or: `ab_unwrap_or`,
        }[e.name];
        if (optM) {
          const extra = A().length ? `, ${A()[0]}, "${(e.trapOn && e.trapOn.msg) || ''}"` : ``;
          return `${optM}(${recv}${extra})`;
        }
        break;
      }
      default: break;
    }
    return '0';
  }

  genIf(e) {
    const v = this.fresh('ifv');
    const hasElse = !!e.elseB;
    const resTy = hasElse ? this.ct(prune(e.thenB.ty || e.ty)) : 'void';
    this.w(`${hasElse ? this.ct(this.ty(e)) : 'void'} ${v};`);
    const cond = this.genExpr(e.cond);
    this.w(`if (${cond}) {`);
    this.ind++;
    this.genBranchValue(e.thenB, v, hasElse ? this.ct(this.ty(e)) : null);
    this.ind--;
    this.w(`}`);
    if (hasElse) {
      this.w(`else {`);
      this.ind++;
      if (e.elseB.k === 'block') this.genBranchValue(e.elseB, v, this.ct(this.ty(e)));
      else this.w(`${v} = ${this.genIf(e.elseB)};`);
      this.ind--;
      this.w(`}`);
    }
    void resTy;
    return v;
  }

  genBranchValue(b, target, castTo) {
    const stmts = b.stmts;
    const last = stmts[stmts.length - 1];
    for (let i = 0; i < stmts.length - (last && last.k === 'expr' ? 1 : 0); i++) {
      this.genStmt(stmts[i]);
    }
    if (last && last.k === 'expr') {
      const val = this.lift(last.e);
      if (castTo) this.w(`${target} = ${val};`);
      else this.w(`(void)(${val});`);
    } else if (castTo) {
      this.w(`${target} = (${castTo})0;`);
    }
  }

  genMatch(e) {
    const scrut = this.lift(e.scrutinee);
    const v = this.fresh('mv');
    const resC = this.ct(this.ty(e));
    this.w(`${resC} ${v};`);
    this.w(`do {`);
    this.ind++;

    const arms = e.arms;
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      const condParts = [];
      const binds = [];
      this.patternCond(arm.pattern, scrutineeRef(scrut, this.ty(e.scrutinee)), condParts, binds);
      if (arm.guard) condParts.push(`(${this.genExpr(arm.guard)})`);
      const cond = condParts.length ? condParts.join(' && ') : '1';
      const kw = i === 0 ? 'if' : 'else if';
      this.w(`${kw} (${cond}) {`);
      this.ind++;
      for (const b of binds) this.w(b);
      this.genArmBody(arm, v, resC);
      this.ind--;
      this.w(`}`);
    }
    this.ind--;
    this.w(`} while (0);`);
    return v;
  }

  genArmBody(arm, target, castTo) {
    if (arm.body.k === 'block') this.genBranchValue(arm.body, target, castTo);
    else {
      const val = this.lift(arm.body);
      this.w(`${target} = ${val};`);
    }
  }

  patternCond(pat, ref, parts, binds) {
    switch (pat.k) {
      case 'pwild': return;
      case 'pbind':
        binds.push(`${ref} as binding ${pat.name}`);
        return;
      case 'plit': {
        if (pat.kind === 'str') parts.push(`ab_str_eq(${ref}, ${JSON.stringify(pat.v)})`);
        else if (pat.kind === 'bool') parts.push(`((${ref}) == ${pat.v ? 1 : 0})`);
        else parts.push(`((${ref}) == ${pat.v})`);
        return;
      }
      case 'ptuple': {
        pat.items.forEach((sub, i) => this.patternCond(sub, `ab_tuple_field(${ref}, ${i})`, parts, binds));
        return;
      }
      case 'pvariant': {
        parts.push(`((${ref})->tag == ab_tag_of_variant("${pat.name}"))`);
        pat.subs.forEach((sub, i) => this.patternCond(sub, `ab_enum_payload(${ref}, ${i})`, parts, binds));
        return;
      }
      default: return;
    }
  }
}

function scrutineeRef(name, ty) {
  void ty;
  return name;
}
