import { tokenize } from './lexer.js';
import { E, P, S, D, T } from './ast.js';
import { ArborError, Span } from './diagnostics.js';

const BIN_PREC = {
  or: 1, and: 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '..': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
};

function isBinOp(tok) {
  return tok.kind === 'and' || tok.kind === 'or' || tok.kind === 'dotdot'
    || (tok.kind === 'op' && BIN_PREC[tok.value] !== undefined)
    || BIN_PREC[tok.kind] !== undefined;
}

class Parser {
  constructor(toks, file, knownStructs = new Set()) {
    this.toks = toks;
    this.pos = 0;
    this.file = file;
    this.knownStructs = knownStructs;
  }
  peek(off = 0) { return this.toks[Math.min(this.pos + off, this.toks.length - 1)]; }
  next() { const t = this.toks[this.pos]; if (t.kind !== 'eof') this.pos++; return t; }
  at(kind, value) {
    const t = this.peek();
    return t.kind === kind && (value === undefined || t.value === value);
  }
  atAny(...kinds) { return kinds.includes(this.peek().kind); }
  expect(kind, what) {
    if (!this.at(kind)) this.fail(what || `'${kind}'`);
    return this.next();
  }
  fail(expected) {
    const t = this.peek();
    const got = t.kind === 'eof' ? 'end of file' : `'${t.value ?? t.kind}'`;
    throw new ArborError({
      code: 'A0000',
      message: `expected ${expected}, found ${got}`,
      span: t.span,
      hint: t.nlBefore && t.kind !== 'eof' ? 'statements are separated by newlines; keep an expression on one line to continue it' : undefined,
    });
  }
  spanFrom(startTok, endTok) {
    return Span.union(startTok.span, endTok ? endTok.span : this.toks[Math.max(0, this.pos - 1)].span);
  }

  parseProgram() {
    const decls = [];
    while (!this.at('eof')) decls.push(this.parseTop());
    return { decls };
  }

  parseTop() {
    let docs = null;
    while (this.at('doc')) {
      const d = this.next();
      docs = docs ? `${docs}\n${d.value}` : d.value;
    }
    let decl;
    if (this.at('use')) decl = this.parseUse();
    else if (this.at('fn')) decl = this.parseFnDecl();
    else if (this.at('struct')) decl = this.parseStruct();
    else if (this.at('enum')) decl = this.parseEnum();
    else if (this.at('const')) decl = this.parseConst();
    else this.fail("'fn', 'struct', 'enum', 'const' or 'use' at top level");
    if (docs && decl.k !== 'use') decl.docs = docs;
    return decl;
  }

  parseConst() {
    const start = this.next();
    const name = this.expect('ident', 'constant name').value;
    this.expect('=');
    const value = this.parseExpr();
    return D.constD(name, value, this.spanFrom(start));
  }

  parseUse() {
    const start = this.next();
    if (this.at('string')) {
      const s = this.next();
      const path = s.value.length === 1 && s.value[0].str !== undefined ? s.value[0].str : null;
      if (path === null) this.fail('a file path string');
      let alias = null;
      if (this.at('ident') && this.peek().value === 'as') {
        this.next();
        alias = this.expect('ident', 'module alias').value;
      }
      const d = D.useFile(path, this.spanFrom(start));
      d.alias = alias;
      return d;
    }
    const segments = [this.expect('ident', 'module path').value];
    while (this.at('.') ) {
      this.next();
      if (this.at('{')) {
        this.next();
        const names = [];
        do {
          names.push(this.expect('ident', 'import name').value);
        } while (this.at(',') && this.next());
        this.expect('}');
        return D.use(segments, names, this.spanFrom(start));
      }
      segments.push(this.expect('ident', 'module path').value);
    }
    return D.use(segments, null, this.spanFrom(start));
  }

  parseFnDecl() {
    const start = this.next();
    let name = this.expect('ident', 'function name').value;
    if (this.at('.') && this.peek(1).kind === 'ident') {
      this.next();
      name = `${name}.${this.expect('ident', 'method name').value}`;
    }
    const typarams = [];
    if (this.at('[')) {
      this.next();
      do { typarams.push(this.expect('ident', 'type parameter').value); } while (this.at(',') && this.next());
      this.expect(']');
    }
    const params = this.parseParams();
    let retTy = null;
    if (this.at('arrow')) { this.next(); retTy = this.parseType(); }
    const body = this.parseBlock();
    return D.fn(name, typarams, params, retTy, body, this.spanFrom(start));
  }

  parseParams() {
    this.expect('(');
    const params = [];
    if (!this.at(')')) {
      do {
        const name = this.expect('ident', 'parameter name').value;
        this.expect(':');
        let mode = 'own';
        if (this.at('in')) { mode = 'in'; this.next(); }
        else if (this.at('inout')) { mode = 'inout'; this.next(); }
        const ty = this.parseType();
        params.push({ mode, name, ty });
      } while (this.at(',') && this.next());
    }
    this.expect(')');
    return params;
  }

  parseStruct() {
    const start = this.next();
    const name = this.expect('ident', 'struct name').value;
    const typarams = [];
    if (this.at('[')) {
      this.next();
      do { typarams.push(this.expect('ident', 'type parameter').value); } while (this.at(',') && this.next());
      this.expect(']');
    }
    this.expect('{');
    const fields = [];
    while (!this.at('}')) {
      const fname = this.expect('ident', 'field name').value;
      this.expect(':');
      fields.push({ name: fname, ty: this.parseType() });
      if (this.at(',')) this.next();
    }
    this.expect('}');
    return D.structD(name, fields, this.spanFrom(start));
  }

  parseEnum() {
    const start = this.next();
    const name = this.expect('ident', 'enum name').value;
    const typarams = [];
    if (this.at('[')) {
      this.next();
      do { typarams.push(this.expect('ident', 'type parameter').value); } while (this.at(',') && this.next());
      this.expect(']');
    }
    this.expect('{');
    const variants = [];
    while (!this.at('}')) {
      const vname = this.expect('ident', 'variant name').value;
      const tys = [];
      if (this.at('(')) {
        this.next();
        if (!this.at(')')) {
          do { tys.push(this.parseType()); } while (this.at(',') && this.next());
        }
        this.expect(')');
      }
      variants.push({ name: vname, tys });
      if (this.at(',')) this.next();
    }
    this.expect('}');
    return D.enumD(name, variants, this.spanFrom(start));
  }

  parseType() {
    const t = this.peek();
    if (this.at('fn')) {
      this.next();
      this.expect('(');
      const items = [];
      if (!this.at(')')) {
        do { items.push(this.parseType()); } while (this.at(',') && this.next());
      }
      this.expect(')');
      let ret = null;
      if (this.at('arrow')) { this.next(); ret = this.parseType(); }
      return T.fnType(items, ret, t.span);
    }
    if (this.at('[')) {
      this.next();
      const elem = this.parseType();
      this.expect(']');
      return T.array(elem, t.span);
    }
    if (this.at('(')) {
      this.next();
      const items = [];
      if (!this.at(')')) {
        do { items.push(this.parseType()); } while (this.at(',') && this.next());
      }
      this.expect(')');
      if (items.length === 0) return T.unit(t.span);
      if (items.length === 1) return items[0];
      return T.tuple(items, t.span);
    }
    if (this.at('ident')) {
      this.next();
      const args = [];
      if (this.at('[')) {
        this.next();
        do { args.push(this.parseType()); } while (this.at(',') && this.next());
        this.expect(']');
      }
      return T.name(t.value, args, t.span);
    }
    this.fail('a type');
  }

  parseBlock() {
    const start = this.expect('{');
    const stmts = [];
    while (!this.at('}')) {
      if (this.at(';')) { this.next(); continue; }
      stmts.push(this.parseStmt());
    }
    const end = this.next();
    return E.block(stmts, this.spanFrom(start, end));
  }

  parseStmt() {
    const t = this.peek();
    switch (t.kind) {
      case 'let':
      case 'var': {
        this.next();
        let pat = null;
        if (this.at('(')) {
          pat = this.parsePattern();
        }
        const name = pat ? '_' : this.expect('ident', 'binding name').value;
        let ty = null;
        if (this.at(':')) { this.next(); ty = this.parseType(); }
        this.expect('=');
        const init = this.parseExpr();
        const stmt = t.kind === 'let' ? S.let(name, ty, init, t.span) : S.declVar(name, ty, init, t.span);
        if (pat) stmt.pat = pat;
        return stmt;
      }
      case 'if': {
        const e = this.parseExpr();
        return S.expr(e, e.span);
      }
      case 'while': {
        this.next();
        const cond = this.parseExpr();
        const body = this.parseBlock();
        return S.whileS(cond, body, this.spanFrom(t));
      }
      case 'for': {
        this.next();
        const pat = this.parsePattern();
        if (!this.at('in')) this.fail("'in'");
        this.next();
        const iter = this.parseExpr();
        const body = this.parseBlock();
        return S.forS(pat, iter, body, this.spanFrom(t));
      }
      case 'return': {
        this.next();
        let value = null;
        if (!this.at('}') && !this.at(';') && !this.peek().nlBefore) value = this.parseExpr();
        return S.returnS(value, this.spanFrom(t));
      }
      case 'break': this.next(); return S.breakS(t.span);
      case 'continue': this.next(); return S.continueS(t.span);
      case 'region': {
        this.next();
        const name = this.expect('ident', 'region name').value;
        const body = this.parseBlock();
        return S.regionS(name, body, this.spanFrom(t));
      }
      case 'spawn': {
        this.next();
        const body = this.parseBlock();
        return S.spawnS(body, this.spanFrom(t));
      }
      case 'fn': {
        if (this.peek(1).kind === '(') {
          const e = this.parseExpr();
          return S.expr(e, e.span);
        }
        return this.parseFnDecl();
      }
      default: {
        const e = this.parseExpr();
        if ((this.at('=') || this.at('opassign')) && (e.k === 'name' || e.k === 'index' || e.k === 'field')) {
          const assignTok = this.next();
          const value = this.parseExpr();
          let finalValue = value;
          if (assignTok.kind === 'opassign') {
            const binOp = assignTok.value[0];
            finalValue = E.binary(binOp, e, value, this.spanFrom(t));
          }
          return S.assign(e, finalValue, this.spanFrom(t));
        }
        return S.expr(e, e.span);
      }
    }
  }

  isCapitalized(name) { return name[0] >= 'A' && name[0] <= 'Z'; }

  looksLikeStructLit() {
    if (!this.at('ident') || !this.isCapitalized(this.peek().value)) return false;
    if (this.peek(1).kind !== '{') return false;
    return this.knownStructs.has(this.peek().value);
  }

  parseExpr(minPrec = 0) {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (isBinOp(t)) {
        const op = t.kind === 'op' ? t.value : t.value;
        const prec = BIN_PREC[op];
        if (prec === undefined || prec < minPrec) break;
        if (t.nlBefore) break;
        this.next();
        const right = this.parseExpr(prec + 1);
        left = E.binary(op, left, right, Span.union(left.span, right.span));
        continue;
      }
      if (t.kind === '?' && !t.nlBefore) {
        this.next();
        left = E.tryExpr(left, Span.union(left.span, t.span));
        continue;
      }
      break;
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (t.kind === '-') {
      this.next();
      const e = this.parseUnary();
      return E.unary('-', e, Span.union(t.span, e.span));
    }
    if (t.kind === 'not') {
      this.next();
      const e = this.parseUnary();
      return E.unary('not', e, Span.union(t.span, e.span));
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let e = this.parsePrimary();
    while (true) {
      const t = this.peek();
      if (t.kind === '.' ) {
        this.next();
        if (this.at('int')) {
          const idxTok = this.next();
          e = E.field(e, String(idxTok.value), Span.union(e.span, idxTok.span));
          continue;
        }
        const name = this.expect('ident', 'field or method name').value;
        if (this.at('(')) {
          const args = this.parseArgs();
          e = E.method(e, name, args, Span.union(e.span, this.toks[this.pos - 1].span));
        } else {
          e = E.field(e, name, Span.union(e.span, this.toks[this.pos - 1].span));
        }
        continue;
      }
      if (t.kind === '(' && !t.nlBefore) {
        const args = this.parseArgs();
        e = E.call(e, args, Span.union(e.span, this.toks[this.pos - 1].span));
        continue;
      }
      if (t.kind === '[' && !t.nlBefore) {
        this.next();
        const idx = this.parseExpr();
        const end = this.expect(']');
        e = E.index(e, idx, Span.union(e.span, end.span));
        continue;
      }
      if (t.kind === '?' && !t.nlBefore) {
        this.next();
        e = E.tryExpr(e, Span.union(e.span, t.span));
        continue;
      }
      break;
    }
    return e;
  }

  parseArgs() {
    this.expect('(');
    const args = [];
    if (!this.at(')')) {
      do { args.push(this.parseExpr()); } while (this.at(',') && this.next());
    }
    this.expect(')');
    return args;
  }

  parsePrimary() {
    const t = this.peek();
    switch (t.kind) {
      case 'int': this.next(); return E.int(t.value, t.span);
      case 'float': this.next(); return E.float(t.value, t.span);
      case 'true': this.next(); return E.bool(true, t.span);
      case 'false': this.next(); return E.bool(false, t.span);
      case 'string': {
        this.next();
        return E.str(t.value, t.span);
      }
      case 'if': return this.parseIf();
      case 'match': return this.parseMatch();
      case '{': return this.parseBlock();
      case 'fn': {
        this.next();
        const params = this.parseParams();
        let retTy = null;
        if (this.at('arrow')) { this.next(); retTy = this.parseType(); }
        if (this.at('{')) {
          const body = this.parseBlock();
          return E.closure(params, body, false, Span.union(t.span, body.span), retTy);
        }
        const bodyE = this.parseExpr();
        return E.closure(params, bodyE, true, Span.union(t.span, bodyE.span), retTy);
      }
      case '[': {
        this.next();
        if (this.at(']')) { this.next(); return E.arrayLit([], t.span); }
        const first = this.parseExpr();
        if (this.at(':')) {
          this.next();
          const v = this.parseExpr();
          const entries = [{ key: first, value: v }];
          while (this.at(',') && this.next()) {
            if (this.at(']')) break;
            const k2 = this.parseExpr();
            this.expect(':');
            const v2 = this.parseExpr();
            entries.push({ key: k2, value: v2 });
          }
          this.expect(']');
          return E.mapLit(entries, Span.union(t.span, this.toks[this.pos - 1].span));
        }
        const items = [first];
        while (this.at(',') && this.next()) {
          if (this.at(']')) break;
          items.push(this.parseExpr());
        }
        this.expect(']');
        return E.arrayLit(items, Span.union(t.span, this.toks[this.pos - 1].span));
      }
      case '(': {
        this.next();
        if (this.at(')')) { this.next(); return E.unit(t.span); }
        const first = this.parseExpr();
        if (!this.at(',')) {
          this.expect(')');
          return first;
        }
        const items = [first];
        while (this.at(',') && this.next()) {
          if (this.at(')')) break;
          items.push(this.parseExpr());
        }
        this.expect(')');
        return E.tupleLit(items, Span.union(t.span, this.toks[this.pos - 1].span));
      }
      case 'ident': {
        if (this.looksLikeStructLit()) {
          const name = this.next().value;
          this.expect('{');
          const fields = [];
          while (!this.at('}')) {
            const fname = this.expect('ident', 'field name').value;
            this.expect(':');
            fields.push({ name: fname, value: this.parseExpr() });
            if (this.at(',')) this.next();
            else break;
          }
          const end = this.expect('}');
          return E.structLit(name, fields, Span.union(t.span, end.span));
        }
        this.next();
        if (this.isCapitalized(t.value) && this.at('[')) {
          const save = this.pos;
          try {
            this.next();
            const tyArgs = [];
            do { tyArgs.push(this.parseType()); } while (this.at(',') && this.next());
            this.expect(']');
            const node = E.name(t.value, t.span);
            node.tyArgs = tyArgs;
            return node;
          } catch (err) {
            if (err instanceof ArborError) {
              this.pos = save;
            } else {
              throw err;
            }
          }
        }
        return E.name(t.value, t.span);
      }
      default:
        this.fail('an expression');
    }
  }

  parseIf() {
    const t = this.expect('if');
    const cond = this.parseExpr();
    const thenB = this.parseBlock();
    let elseB = null;
    if (this.at('else')) {
      this.next();
      if (this.at('if')) elseB = this.parseIf();
      else elseB = this.parseBlock();
    }
    return E.ifE(cond, thenB, elseB, this.spanFrom(t));
  }

  parseMatch() {
    const t = this.expect('match');
    const scrutinee = this.parseExpr();
    this.expect('{');
    const arms = [];
    while (!this.at('}')) {
      const pat = this.parsePattern();
      let guard = null;
      if (this.at('if')) { this.next(); guard = this.parseExpr(); }
      this.expect('fatarrow');
      const body = this.at('{')
        ? this.parseBlock()
        : this.atAny('return', 'break', 'continue')
          ? (() => {
              const st = this.parseStmt();
              return E.block([st], st.span);
            })()
          : this.parseExpr();
      arms.push({ pattern: pat, guard, body });
      if (this.at(',')) this.next();
    }
    this.expect('}');
    return E.match(scrutinee, arms, this.spanFrom(t));
  }

  parsePattern() {
    const t = this.peek();
    if (t.kind === 'int') { this.next(); return P.lit('int', t.value, t.span); }
    if (t.kind === 'float') { this.next(); return P.lit('float', t.value, t.span); }
    if (t.kind === 'true') { this.next(); return P.lit('bool', true, t.span); }
    if (t.kind === 'false') { this.next(); return P.lit('bool', false, t.span); }
    if (t.kind === '-' && this.peek(1).kind === 'int') {
      this.next();
      const n = this.next();
      return P.lit('int', -n.value, t.span);
    }
    if (t.kind === 'string') {
      this.next();
      const flat = t.value.length === 1 && t.value[0].str !== undefined ? t.value[0].str : null;
      if (flat === null) {
        throw new ArborError({
          code: 'A0033',
          message: 'string interpolation is not allowed in patterns',
          span: t.span,
        });
      }
      return P.lit('str', flat, t.span);
    }
    if (t.kind === '(') {
      this.next();
      const items = [];
      if (!this.at(')')) {
        do { items.push(this.parsePattern()); } while (this.at(',') && this.next());
      }
      this.expect(')');
      return P.tuple(items, t.span);
    }
    if (t.kind === 'ident') {
      this.next();
      if (t.value === '_') return P.wild(t.span);
      if (this.isCapitalized(t.value)) {
        const subs = [];
        if (this.at('(')) {
          this.next();
          if (!this.at(')')) {
            do { subs.push(this.parsePattern()); } while (this.at(',') && this.next());
          }
          this.expect(')');
        }
        return P.variant(null, t.value, subs, t.span);
      }
      return P.bind(t.value, t.span);
    }
    this.fail('a pattern');
  }
}

export function parse(src, file = '<input>') {
  const toks = tokenize(src, file);
  const knownStructs = new Set();
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].kind === 'struct' && toks[i + 1] && toks[i + 1].kind === 'ident') {
      knownStructs.add(toks[i + 1].value);
    }
  }
  return new Parser(toks, file, knownStructs).parseProgram();
}

// Like parse(), but with an externally supplied set of known struct names
// so that struct literals of IMPORTED types parse correctly.
export function parseWithKnownStructs(src, file, knownStructs) {
  const toks = tokenize(src, file);
  return new Parser(toks, file, knownStructs).parseProgram();
}

export function parseInterp(exprSrc, file, baseOffset) {
  const pad = ' '.repeat(baseOffset);
  const src = pad + exprSrc;
  const toks = tokenize(src, file);
  const p = new Parser(toks, file);
  const e = p.parseExpr();
  if (!p.at('eof')) p.fail('end of interpolation');
  return e;
}
