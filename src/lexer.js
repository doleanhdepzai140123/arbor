import { Span } from './diagnostics.js';

const KEYWORDS = new Set([
  'fn', 'let', 'var', 'if', 'else', 'while', 'for', 'in', 'match',
  'return', 'break', 'continue', 'region', 'spawn', 'use',
  'struct', 'enum', 'const', 'true', 'false', 'and', 'or', 'not', 'inout',
]);

export class Token {
  constructor(kind, value, span, nlBefore = false) {
    this.kind = kind;
    this.value = value;
    this.span = span;
    this.nlBefore = nlBefore;
  }
}

function isIdentStart(c) { return /[A-Za-z_]/.test(c); }
function isIdentChar(c) { return /[A-Za-z0-9_]/.test(c); }
function isDigit(c) { return c >= '0' && c <= '9'; }

export function tokenize(src, file = '<input>') {
  const toks = [];
  let i = 0;
  let nlPending = false;
  const push = (kind, value, start, end) => {
    toks.push(new Token(kind, value, new Span(file, start, end), nlPending));
    nlPending = false;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { nlPending = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      if (src[i + 2] === '/') {
        const start = i;
        i += 3;
        const textStart = i;
        while (i < src.length && src[i] !== '\n') i++;
        push('doc', src.slice(textStart, i).trim(), start, i);
        continue;
      }
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i >= src.length) throw err('A0010', 'unterminated block comment', new Span(file, start, i));
      i += 2;
      continue;
    }
    const start = i;

    if (isDigit(c)) {
      let kind = 'int';
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        while (i < src.length && /[0-9a-fA-F_]/.test(src[i])) i++;
        push('int', parseInt(src.slice(start + 2, i).replace(/_/g, ''), 16), start, i);
        continue;
      }
      while (i < src.length && /[0-9_]/.test(src[i])) i++;
      if (src[i] === '.' && isDigit(src[i + 1])) {
        kind = 'float';
        i++;
        while (i < src.length && /[0-9_]/.test(src[i])) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        kind = 'float';
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        while (i < src.length && isDigit(src[i])) i++;
      }
      const text = src.slice(start, i).replace(/_/g, '');
      push(kind, kind === 'int' ? Number(text) : Number(text), start, i);
      continue;
    }

    if (isIdentStart(c)) {
      while (i < src.length && isIdentChar(src[i])) i++;
      const word = src.slice(start, i);
      if (KEYWORDS.has(word)) push(word, word, start, i);
      else push('ident', word, start, i);
      continue;
    }

    if (c === '"') {
      i++;
      const parts = [];
      let buf = '';
      while (true) {
        if (i >= src.length) throw err('A0010', 'unterminated string literal', new Span(file, start, i));
        const ch = src[i];
        if (ch === '"') { i++; break; }
        if (ch === '\\') {
          const n = src[i + 1];
          if (n === 'n') buf += '\n';
          else if (n === 't') buf += '\t';
          else if (n === '\\') buf += '\\';
          else if (n === '"') buf += '"';
          else if (n === '{') buf += '{';
          else if (n === '}') buf += '}';
          else if (n === 'r') buf += '\r';
          else if (n === '0') buf += '\0';
          else throw err('A0011', `unknown escape sequence \\${n}`, new Span(file, i, i + 2));
          i += 2;
          continue;
        }
        if (ch === '{') {
          const exprStart = i + 1;
          let depth = 1;
          let j = exprStart;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            if (depth === 0) break;
            if (src[j] === '"') {
              j++;
              while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
            }
            j++;
          }
          if (depth !== 0) throw err('A0010', 'unterminated interpolation in string', new Span(file, i, j));
          if (buf) { parts.push({ str: buf }); buf = ''; }
          parts.push({ exprSrc: src.slice(exprStart, j), file, baseOffset: exprStart });
          i = j + 1;
          continue;
        }
        buf += ch;
        i++;
      }
      if (buf || parts.length === 0) parts.push({ str: buf });
      push('string', parts, start, i);
      continue;
    }

    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (two === '->') { push('arrow', '->', start, i + 2); i += 2; continue; }
    if (two === '=>') { push('fatarrow', '=>', start, i + 2); i += 2; continue; }
    if (two === '==') { push('op', '==', start, i + 2); i += 2; continue; }
    if (two === '!=') { push('op', '!=', start, i + 2); i += 2; continue; }
    if (two === '<=') { push('op', '<=', start, i + 2); i += 2; continue; }
    if (two === '>=') { push('op', '>=', start, i + 2); i += 2; continue; }
    if (two === '..') { push('dotdot', '..', start, i + 2); i += 2; continue; }
    if (two === '+=') { push('opassign', '+=', start, i + 2); i += 2; continue; }
    if (two === '-=') { push('opassign', '-=', start, i + 2); i += 2; continue; }
    if (two === '*=') { push('opassign', '*=', start, i + 2); i += 2; continue; }
    if (two === '/=') { push('opassign', '/=', start, i + 2); i += 2; continue; }
    if ('(){}[],:;.?=<>+-*/%'.includes(c)) { push(c, c, start, i + 1); i++; continue; }
    if (c === '!') throw err('A0012', "use 'not' instead of '!'", new Span(file, start, i + 1));
    if (c === '&') throw err('A0012', "ARBOR has no address-of '&' — lending happens only through parameter modes", new Span(file, start, i + 1));
    if (c === '*') { /* handled above */ }
    throw err('A0013', `unexpected character '${c}'`, new Span(file, start, i + 1));
  }
  push('eof', null, src.length, src.length);
  return toks;
}

import { ArborError } from './diagnostics.js';
function err(code, message, span) {
  return new ArborError({ code, message, span });
}
