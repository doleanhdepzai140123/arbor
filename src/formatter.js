// arbor formatter — canonical pretty-printer over the AST

class Fmt {
  constructor() {
    this.lines = [];
    this.ind = 0;
  }
  w(s) { this.lines.push('  '.repeat(this.ind) + s); }
  body(stmts) {
    this.ind++;
    for (const s of stmts) this.stmt(s);
    this.ind--;
  }
  block(block) {
    this.w('{');
    this.body(block.stmts);
    this.w('}');
  }

  program(prog) {
    for (const d of prog.decls) {
      if (this.lines.length) this.lines.push('');
      this.decl(d);
    }
    return this.lines.join('\n') + '\n';
  }

  decl(d) {
    if (d.docs) for (const line of d.docs.split('\n')) this.w(`/// ${line.trim()}`);
    switch (d.k) {
      case 'use': {
        if (d.names) this.w(`use ${d.segments.join('.')}.{${d.names.join(', ')}}`);
        else this.w(`use ${d.segments.join('.')}`);
        break;
      }
      case 'useFile':
        this.w(`use "${d.path}"${d.alias ? ` as ${d.alias}` : ''}`);
        break;
      case 'const':
        this.w(`const ${d.name} = ${this.expr(d.value)}`);
        break;
      case 'struct': {
        this.w(`struct ${d.name} {`);
        this.ind++;
        for (const f of d.fields) this.w(`${f.name}: ${this.ty(f.ty)},`);
        this.ind--;
        this.w('}');
        break;
      }
      case 'enum': {
        this.w(`enum ${d.name} {`);
        this.ind++;
        for (const v of d.variants) {
          this.w(v.tys.length ? `${v.name}(${v.tys.map(t => this.ty(t)).join(', ')}),` : `${v.name},`);
        }
        this.ind--;
        this.w('}');
        break;
      }
      case 'fn': {
        const params = d.params.map(p => {
          const mode = p.mode === 'own' ? '' : `${p.mode} `;
          return `${p.name}: ${mode}${this.ty(p.ty)}`;
        }).join(', ');
        const tp = d.typarams.length ? `[${d.typarams.join(', ')}]` : '';
        const ret = d.retTy ? ` -> ${this.ty(d.retTy)}` : '';
        this.w(`fn ${d.name}${tp}(${params})${ret} {`);
        this.body(d.body.stmts);
        this.w('}');
        break;
      }
      default: break;
    }
  }

  ty(t) {
    if (!t) return '';
    switch (t.k) {
      case 'tyName': return t.args.length ? `${t.name}[${t.args.map(a => this.ty(a)).join(', ')}]` : t.name;
      case 'tyArray': return `[${this.ty(t.elem)}]`;
      case 'tyTuple': return `(${t.items.map(x => this.ty(x)).join(', ')})`;
      case 'tyUnit': return '()';
      case 'tyFn': return `fn(${t.params.map(x => this.ty(x)).join(', ')}) -> ${t.ret ? this.ty(t.ret) : '()'}`;
      default: return '';
    }
  }

  stmt(s) {
    switch (s.k) {
      case 'let':
        this.w(`let ${s.name}${s.ty ? ': ' + this.ty(s.ty) : ''} = ${this.expr(s.init)};`);
        break;
      case 'var':
        this.w(`var ${s.name}${s.ty ? ': ' + this.ty(s.ty) : ''} = ${this.expr(s.init)};`);
        break;
      case 'assign':
        this.w(`${this.place(s.target)} = ${this.expr(s.value)};`);
        break;
      case 'expr': {
        const before = this.lines.length;
        const text = this.expr(s.e);
        if (this.lines.length === before && !['if', 'match', 'block', 'closure'].includes(s.e.k)) {
          this.w(`${text};`);
        } else if (!['if', 'match', 'block', 'closure'].includes(s.e.k)) {
          this.lines.push(`${'  '.repeat(Math.max(this.ind, 0))}${text};`);
        }
        break;
      }
      case 'return':
        this.w(s.value ? `return ${this.expr(s.value)};` : 'return;');
        break;
      case 'break': this.w('break;'); break;
      case 'continue': this.w('continue;'); break;
      case 'while':
        this.w(`while ${this.expr(s.cond)} {`);
        this.body(s.body.stmts);
        this.w('}');
        break;
      case 'for': {
        this.w(`for ${this.pat(s.pat)} in ${this.expr(s.iter)} {`);
        this.body(s.body.stmts);
        this.w('}');
        break;
      }
      case 'region': {
        this.w(`region ${s.name} {`);
        this.body(s.body.stmts);
        this.w('}');
        break;
      }
      case 'spawn': {
        this.w('spawn {');
        this.body(s.body.stmts);
        this.w('}');
        break;
      }
      default: break;
    }
  }

  place(e) {
    switch (e.k) {
      case 'name': return e.ident;
      case 'index': return `${this.placeOrExpr(e.obj)}[${this.expr(e.idx)}]`;
      case 'field': return /^\d+$/.test(e.name)
        ? `${this.placeOrExpr(e.obj)}.${e.name}`
        : `${this.placeOrExpr(e.obj)}.${e.name}`;
      default: return this.expr(e);
    }
  }
  placeOrExpr(e) {
    return e.k === 'name' ? e.ident : this.expr(e);
  }

  pat(p) {
    switch (p.k) {
      case 'pbind': return p.name;
      case 'pwild': return '_';
      case 'plit':
        if (p.kind === 'str') return JSON.stringify(p.v);
        if (p.kind === 'bool') return p.v ? 'true' : 'false';
        return String(p.v);
      case 'ptuple': return `(${p.items.map(x => this.pat(x)).join(', ')})`;
      case 'pvariant':
        return p.name + (p.subs.length ? `(${p.subs.map(x => this.pat(x)).join(', ')})` : '');
      default: return '_';
    }
  }

  expr(e) {
    switch (e.k) {
      case 'int': return String(e.v);
      case 'float': {
        const s = String(e.v);
        return s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`;
      }
      case 'bool': return e.v ? 'true' : 'false';
      case 'unit': return '()';
      case 'str': return this.strLit(e);
      case 'name': return e.ident;
      case 'unary':
        return e.op === '-' ? `-(${this.expr(e.e)})` : `not (${this.expr(e.e)})`;
      case 'binary': {
        if (e.op === 'and' || e.op === 'or') {
          return `(${this.expr(e.l)} ${e.op} ${this.expr(e.r)})`;
        }
        return `(${this.expr(e.l)} ${e.op} ${this.expr(e.r)})`;
      }
      case 'call': {
        const callee = this.calleeText(e.callee);
        const args = e.args.map(a => this.expr(a)).join(', ');
        return `${callee}(${args})`;
      }
      case 'method': {
        const recv = this.expr(e.obj);
        const args = e.args.map(a => this.expr(a)).join(', ');
        return `${recv}.${e.name}(${args})`;
      }
      case 'index': return `${this.expr(e.obj)}[${this.expr(e.idx)}]`;
      case 'field': return `${this.expr(e.obj)}.${e.name}`;
      case 'try': return `${this.expr(e.e)}?`;
      case 'structLit': {
        const fields = e.fields.map(f => `${f.name}: ${this.expr(f.value)}`).join(', ');
        return `${e.name} { ${fields} }`;
      }
      case 'arrayLit': return `[${e.items.map(x => this.expr(x)).join(', ')}]`;
      case 'mapLit': {
        const entries = e.entries.map(en => `${this.expr(en.key)}: ${this.expr(en.value)}`).join(', ');
        return `[${entries}]`;
      }
      case 'tupleLit': return `(${e.items.map(x => this.expr(x)).join(', ')})`;
      case 'closure': {
        const params = e.params.map(p => `${p.name}: ${p.ty ? this.ty(p.ty) : 'auto'}`).join(', ');
        if (e.isExpr) return `fn(${params}) -> ${this.expr(e.body)}`;
        this.w(`fn(${params}) {`);
        this.body(e.body.stmts);
        this.w('}');
        return '<fn>';
      }
      case 'match': {
        this.w(`match ${this.expr(e.scrutinee)} {`);
        this.ind++;
        for (const arm of e.arms) {
          const guard = arm.guard ? ` if ${this.expr(arm.guard)}` : '';
          if (arm.body.k === 'block') {
            this.w(`${this.pat(arm.pattern)}${guard} => {`);
            this.body(arm.body.stmts);
            this.w('}');
          } else {
            this.w(`${this.pat(arm.pattern)}${guard} => ${this.expr(arm.body)},`);
          }
        }
        this.ind--;
        this.w('}');
        return '<match>';
      }
      case 'if': {
        this.w(`if ${this.expr(e.cond)} {`);
        this.body(e.thenB.stmts);
        if (e.elseB) {
          if (e.elseB.k === 'block') {
            this.w('} else {');
            this.body(e.elseB.stmts);
          } else {
            this.w('} else ' + this.expr(e.elseB).replace(/\n\s*/g, `\n${'  '.repeat(this.ind)}`));
            return '<if>';
          }
        }
        this.w('}');
        return '<if>';
      }
      case 'block': {
        this.w('{');
        this.body(e.stmts);
        this.w('}');
        return '<block>';
      }
      default: return '<expr>';
    }
  }

  calleeText(c) {
    if (c.k === 'name') return c.ident;
    if (c.k === 'field') return `${this.calleeText(c.obj)}.${c.name}`;
    return this.expr(c);
  }

  strLit(e) {
    let out = '"';
    for (const p of e.parts) {
      if (p.str !== undefined) {
        for (const ch of p.str) {
          if (ch === '"') out += '\\"';
          else if (ch === '\\') out += '\\\\';
          else if (ch === '\n') out += '\\n';
          else if (ch === '\t') out += '\\t';
          else out += ch;
        }
      } else if (p.exprSrc !== undefined) {
        out += `{${p.exprSrc.trim()}}`;
      } else {
        out += `{${this.expr(p.expr)}}`;
      }
    }
    return out + '"';
  }
}

export { Fmt };
