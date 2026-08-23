export function cType(t) {
  switch (t.k) {
    case 'int': return 'ab_i64';
    case 'float': return 'double';
    case 'bool': return 'ab_bool';
    case 'str': return 'AbStr*';
    case 'unit': return 'void';
    case 'array': return 'AbArr*';
    case 'map': return 'AbMap*';
    case 'set': return 'AbSet*';
    case 'handle': return 'AbHandle*';
    case 'table': return 'AbTable*';
    case 'tuple': return 'AbTuple*';
    case 'struct': return `Ab_${t.name}*`;
    case 'enum': return `AbEnum*`;
    case 'fn': return 'AbClosure*';
    default: return 'void';
  }
}

export function isFloatT(t) { return t && t.k === 'float'; }
export function isStrT(t) { return t && t.k === 'str'; }

export function mangle(name) { return `ab_${name}`; }

export function cStringLiteral(s) {
  let out = '"';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (code < 32) out += `\\x${(code < 16 ? '0' : '') + code.toString(16)}" "`;
    else out += ch;
  }
  return out + '"';
}
