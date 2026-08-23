import { ArborError } from './diagnostics.js';

export const UNIT = { arb: 'unit' };
const HOLE = { arb: '__hole__' };

let nextTableId = 0;
const TABLES = new Map();

function trap(code, message, span, hint) {
  throw new ArborError({ code, message, span, hint });
}

export const mkF = (x) => ({ arb: 'f', v: x });
export const unF = (v) => (v !== null && typeof v === 'object' && v.arb === 'f' ? v.v : v);
export function isFloatV(v) {
  return v !== null && typeof v === 'object' && v.arb === 'f';
}
export function isIntV(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

export const mkArr = (items) => ({ arb: 'array', items });
export const mkMapV = (m) => ({ arb: 'map', m });
export const mkSetV = (s) => ({ arb: 'set', s });
export const mkTblV = () => {
  nextTableId++;
  const t = { arb: 'table', tid: nextTableId, slots: [], live: 0 };
  TABLES.set(t.tid, t);
  return t;
};
export const mkHandleV = (tid, idx, gen) => ({ arb: 'handle', tid, idx, gen });
export const mkStructV = (name, fields) => ({ arb: 'struct', name, fields });
export const mkEnumV = (enumName, variant, payload) => ({ arb: 'enum', name: enumName, variant, payload });
export const mkTupleV = (items) => ({ arb: 'tuple', items });
export const someOf = (v) => mkEnumV('Option', 'Some', [v]);
export const noneOf = () => mkEnumV('Option', 'None', []);
export const okOf = (v) => mkEnumV('Result', 'Ok', [v]);
export const errOf = (v) => mkEnumV('Result', 'Err', [v]);

export function cloneCopy(v) {
  if (v === null || typeof v !== 'object') return v;
  switch (v.arb) {
    case 'struct': {
      const f = new Map();
      for (const [k, x] of v.fields) f.set(k, cloneCopy(x));
      return mkStructV(v.name, f);
    }
    case 'enum':
      return mkEnumV(v.name, v.variant, v.payload.map(cloneCopy));
    case 'tuple':
      return mkTupleV(v.items.map(cloneCopy));
    default:
      return v;
  }
}

function valueEq(a, b) {
  if (isFloatV(a) || isFloatV(b)) {
    return isFloatV(a) && isFloatV(b) && a.v === b.v;
  }
  return a === b;
}

function isIntVal(v) { return typeof v === 'number' && Number.isInteger(v); }
function isFloatVal(v) { return typeof v === 'number'; }

export function fmtValue(v, debug = false) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (isFloatV(v)) {
    const n = v.v;
    if (Number.isNaN(n)) return 'NaN';
    if (!Number.isFinite(n)) return n > 0 ? '+inf' : '-inf';
    const s = String(n);
    return s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`;
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) {
      throw new Error(`internal: untagged non-integer number ${v}`);
    }
    return String(v);
  }
  if (typeof v === 'string') return debug ? JSON.stringify(v) : v;
  switch (v.arb) {
    case 'unit': return '()';
    case 'array': return `[${v.items.map(x => fmtValue(x, true)).join(', ')}]`;
    case 'map': {
      const parts = [];
      for (const [k, val] of v.m) parts.push(`${fmtKey(k)}: ${fmtValue(val, true)}`);
      return `{${parts.join(', ')}}`;
    }
    case 'set': return `#{${[...v.s].map(x => fmtValue(x, true)).join(', ')}}`;
    case 'table': return `<Table #${v.tid} (${v.live} live)>`;
    case 'handle': return `#${v.tid}.${v.idx}@${v.gen}`;
    case 'tuple': return `(${v.items.map(x => fmtValue(x, true)).join(', ')})`;
    case 'struct': {
      const parts = [];
      for (const [k, x] of v.fields) parts.push(`${k}: ${fmtValue(x, true)}`);
      return `${v.name} { ${parts.join(', ')} }`;
    }
    case 'enum':
      return v.payload.length
        ? `${v.variant}(${v.payload.map(p => fmtValue(p, true)).join(', ')})`
        : v.variant;
    case 'closure': return `<fn ${v.name || 'anonymous'}>`;
    case 'bif': return `<builtin ${v.path}>`;
    case 'module': return `<module ${v.path}>`;
    case 'userenum': return `<enum ${v.name}>`;
    case 'ctor': return `<ctor ${v.enumName}.${v.variant}>`;
    default: return '?';
  }
}

function fmtKey(k) {
  if (typeof k === 'string') return k;
  return fmtValue(k, true);
}

export function runtimeStats() {
  let liveSlots = 0;
  for (const t of TABLES.values()) liveSlots += t.live;
  return { tables: TABLES.size, liveSlots };
}

export function makeMethodRunner(ctx) {
  const invoke = ctx.invoke;

  function runMethod(recv, name, args, span) {
    if (isFloatV(recv)) return floatMethod(recv.v, name, args, span);
    if (typeof recv === 'number') return intMethod(recv, name, args, span);
    if (typeof recv === 'boolean') return boolMethod(recv, name, args, span);
    if (typeof recv === 'string') return strMethod(recv, name, args, span);
    switch (recv.arb) {
      case 'array': return arrayMethod(recv, name, args, span);
      case 'map': return mapMethod(recv, name, args, span);
      case 'set': return setMethod(recv, name, args, span);
      case 'table': return tableMethod(recv, name, args, span);
      case 'enum': return enumMethod(recv, name, args, span);
      default:
        trap('R0009', `value has no method .${name}()`, span);
    }
  }

  function arity(name, args, n, span) {
    if (args.length !== n) {
      trap('A0009', `.${name}() expects ${n} argument(s), got ${args.length}`, span);
    }
  }

  function intMethod(r, name, args, span) {
    switch (name) {
      case 'to_float': arity(name, args, 0, span); return mkF(r);
      case 'to_str': arity(name, args, 0, span); return String(r);
      case 'abs': arity(name, args, 0, span); return Math.abs(r);
      default: trap('R0009', `Int has no method .${name}()`, span);
    }
  }

  function floatMethod(raw, name, args, span) {
    switch (name) {
      case 'floor': arity(name, args, 0, span); return mkF(Math.floor(raw));
      case 'ceil': arity(name, args, 0, span); return mkF(Math.ceil(raw));
      case 'round': arity(name, args, 0, span); return mkF(Math.round(raw));
      case 'sqrt': arity(name, args, 0, span); return mkF(Math.sqrt(raw));
      case 'abs': arity(name, args, 0, span); return mkF(Math.abs(raw));
      case 'to_int': arity(name, args, 0, span); return Math.trunc(raw);
      case 'to_str': arity(name, args, 0, span); return fmtValue(mkF(raw));
      default: trap('R0009', `Float has no method .${name}()`, span);
    }
  }

  function boolMethod(r, name, args, span) {
    if (name === 'to_str') { arity(name, args, 0, span); return r ? 'true' : 'false'; }
    trap('R0009', `Bool has no method .${name}()`, span);
  }

  function strMethod(r, name, args, span) {
    switch (name) {
      case 'len': arity(name, args, 0, span); return [...r].length;
      case 'upper': arity(name, args, 0, span); return r.toUpperCase();
      case 'lower': arity(name, args, 0, span); return r.toLowerCase();
      case 'trim': arity(name, args, 0, span); return r.trim();
      case 'contains': arity(name, args, 1, span); return r.includes(args[0]);
      case 'split': arity(name, args, 1, span); return mkArr(r.split(args[0]));
      case 'chars': arity(name, args, 0, span); return mkArr([...r]);
      case 'repeat': {
        arity(name, args, 1, span);
        const n = args[0];
        if (!isIntVal(n) || n < 0 || n > 10000) trap('R0010', `.repeat(n) needs 0 <= n <= 10000`, span);
        return r.repeat(n);
      }
      case 'to_int': {
        arity(name, args, 0, span);
        const t = r.trim();
        if (/^[+-]?\d+$/.test(t)) return okOf(Number(t));
        return errOf(`not an integer: ${JSON.stringify(r)}`);
      }
      default: trap('R0009', `Str has no method .${name}()`, span);
    }
  }

  function arrayMethod(r, name, args, span) {
    switch (name) {
      case 'len': arity(name, args, 0, span); return r.items.filter(x => x !== HOLE).length;
      case 'push': arity(name, args, 1, span); r.items.push(args[0]); return UNIT;
      case 'pop': {
        arity(name, args, 0, span);
        while (r.items.length && r.items[r.items.length - 1] === HOLE) r.items.pop();
        if (!r.items.length) return noneOf();
        return someOf(r.items.pop());
      }
      case 'get': {
        arity(name, args, 1, span);
        const i = checkIndex(args[0], span);
        if (i < 0 || i >= r.items.length || r.items[i] === HOLE) return noneOf();
        return someOf(r.items[i]);
      }
      case 'set': {
        arity(name, args, 2, span);
        const i = checkIndex(args[0], span);
        bounds(r, i, span);
        r.items[i] = args[1];
        return UNIT;
      }
      case 'take': {
        arity(name, args, 1, span);
        const i = checkIndex(args[0], span);
        bounds(r, i, span);
        const v = r.items[i];
        if (v === HOLE) trap('R0008', `.take(${i}): slot was already taken`, span);
        r.items[i] = HOLE;
        return v;
      }
      case 'clone': arity(name, args, 0, span); return mkArr([...r.items]);
      case 'reverse': arity(name, args, 0, span); r.items.reverse(); return UNIT;
      case 'contains': {
        arity(name, args, 1, span);
        return r.items.some(x => valueEq(x, args[1]));
      }
      case 'is_empty': arity(name, args, 0, span); return r.items.length === 0;
      case 'first': arity(name, args, 0, span); return optAt(r, 0);
      case 'last': arity(name, args, 0, span); return optAt(r, r.items.length - 1);
      case 'sort_by': {
        arity(name, args, 1, span);
        const cmp = args[0];
        const idx = r.items.map((v, i) => [v, i]).filter(([v]) => v !== HOLE);
        idx.sort((a, b) => {
          const c = invoke(cmp, [a[0], b[0]], span);
          if (typeof c !== 'number' || !Number.isInteger(c)) {
            trap('R0011', 'sort_by comparator must return Int', span);
          }
          return c;
        });
        r.items = idx.map(([v]) => v);
        return UNIT;
      }
      default: trap('R0009', `Array has no method .${name}()`, span);
    }
  }

  function optAt(r, i) {
    if (i < 0 || i >= r.items.length || r.items[i] === HOLE) return noneOf();
    return someOf(r.items[i]);
  }

  function checkIndex(v, span) {
    if (!isIntVal(v)) trap('R0002', 'index must be Int', span);
    return v;
  }

  function bounds(r, i, span) {
    if (i < 0 || i >= r.items.length) {
      trap('R0002', `index ${i} out of bounds for length ${r.items.length}`, span);
    }
  }

  function valueEq(a, b) {
    if (a === b) return true;
    return false;
  }

  function mapMethod(r, name, args, span) {
    switch (name) {
      case 'len': arity(name, args, 0, span); return r.m.size;
      case 'insert': {
        arity(name, args, 2, span);
        const old = r.m.get(mapKey(args[0]));
        r.m.set(mapKey(args[0]), args[1]);
        return old === undefined ? noneOf() : someOf(old);
      }
      case 'get': {
        arity(name, args, 1, span);
        const v = r.m.get(mapKey(args[0]));
        return v === undefined ? noneOf() : someOf(v);
      }
      case 'remove': {
        arity(name, args, 1, span);
        const v = r.m.get(mapKey(args[0]));
        r.m.delete(mapKey(args[0]));
        return v === undefined ? noneOf() : someOf(v);
      }
      case 'keys': arity(name, args, 0, span); return mkArr([...r.m.keys()].map(unwrapKey));
      case 'contains_key': arity(name, args, 1, span); return r.m.has(mapKey(args[0]));
      case 'is_empty': arity(name, args, 0, span); return r.m.size === 0;
      default: trap('R0009', `Map has no method .${name}()`, span);
    }
  }

function mapKey(k) {
  return encodeKey(k);
}

function unwrapKey(k) {
  return decodeKey(k);
}

  function setMethod(r, name, args, span) {
    switch (name) {
      case 'len': arity(name, args, 0, span); return r.s.size;
      case 'insert': arity(name, args, 1, span); {
        const had = r.s.has(mapKey(args[0]));
        r.s.add(mapKey(args[0]));
        return !had;
      }
      case 'remove': arity(name, args, 1, span); return r.s.delete(mapKey(args[0]));
      case 'contains': arity(name, args, 1, span); return r.s.has(mapKey(args[0]));
      case 'to_array': arity(name, args, 0, span); return mkArr([...r.s].map(unwrapKey));
      default: trap('R0009', `Set has no method .${name}()`, span);
    }
  }

  function tableMethod(r, name, args, span) {
    switch (name) {
      case 'len': arity(name, args, 0, span); return r.live;
      case 'is_empty': arity(name, args, 0, span); return r.live === 0;
      case 'insert': {
        arity(name, args, 1, span);
        let idx = -1;
        for (let i = 0; i < r.slots.length; i++) {
          if (r.slots[i] === null) { idx = i; break; }
        }
        if (idx < 0) { r.slots.push(null); idx = r.slots.length - 1; }
        r.slots[idx] = { gen: 0, val: args[0] };
        r.live++;
        return mkHandleV(r.tid, idx, 0);
      }
      case 'get': {
        arity(name, args, 1, span);
        const slot = resolveSlot(r, args[0], span);
        return slot === null ? noneOf() : someOf(slot.val);
      }
      case 'set': {
        arity(name, args, 2, span);
        const slot = resolveSlot(r, args[0], span);
        if (slot !== null) slot.val = args[1];
        return UNIT;
      }
      case 'remove': {
        arity(name, args, 1, span);
        const h = args[0];
        assertHandle(h, span);
        if (h.tid !== r.tid) trap('R0006', '.remove(): handle belongs to a different table', span);
        const slot = r.slots[h.idx];
        if (!slot || slot.gen !== h.gen) return noneOf();
        const old = slot.val;
        slot.val = HOLE;
        r.slots[h.idx] = { gen: slot.gen + 1, val: null };
        r.live--;
        return someOf(old);
      }
      case 'alive': {
        arity(name, args, 1, span);
        return resolveSlot(r, args[0], span) !== null;
      }
      default: trap('R0009', `Table has no method .${name}()`, span);
    }
  }

  function resolveSlot(r, h, span) {
    assertHandle(h, span);
    if (h.tid !== r.tid) return null;
    const raw = r.slots[h.idx];
    if (!raw || raw.gen !== h.gen || raw.val === HOLE || raw.val === null) return null;
    return raw;
  }

  function assertHandle(h, span) {
    if (!h || h.arb !== 'handle') trap('R0006', 'expected a Handle', span);
  }

  function enumMethod(r, name, args, span) {
    if (r.name === 'Option') {
      switch (name) {
        case 'unwrap': {
          arity(name, args, 0, span);
          if (r.variant !== 'Some') trap('R0003', 'called unwrap on None', span);
          return r.payload[0];
        }
        case 'expect': {
          arity(name, args, 1, span);
          if (r.variant !== 'Some') trap('R0003', `unwrap failed: ${args[0]}`, span);
          return r.payload[0];
        }
        case 'is_some': arity(name, args, 0, span); return r.variant === 'Some';
        case 'is_none': arity(name, args, 0, span); return r.variant === 'None';
        case 'unwrap_or': {
          arity(name, args, 1, span);
          return r.variant === 'Some' ? r.payload[0] : args[0];
        }
        default: trap('R0009', `Option has no method .${name}()`, span);
      }
    }
    if (r.name === 'Result') {
      switch (name) {
        case 'unwrap': {
          arity(name, args, 0, span);
          if (r.variant !== 'Ok') trap('R0003', `called unwrap on Err(${fmtValue(r.payload[0])})`, span);
          return r.payload[0];
        }
        case 'expect': {
          arity(name, args, 1, span);
          if (r.variant !== 'Ok') trap('R0003', `unwrap failed: ${args[0]} — Err(${fmtValue(r.payload[0])})`, span);
          return r.payload[0];
        }
        case 'is_ok': arity(name, args, 0, span); return r.variant === 'Ok';
        case 'is_err': arity(name, args, 0, span); return r.variant === 'Err';
        case 'unwrap_or': {
          arity(name, args, 1, span);
          return r.variant === 'Ok' ? r.payload[0] : args[0];
        }
        default: trap('R0009', `Result has no method .${name}()`, span);
      }
    }
    trap('R0009', `type has no method .${name}()`, span);
  }

  return runMethod;
}

export function encodeKey(k) {
  if (typeof k === 'string') return `s:${k}`;
  if (typeof k === 'boolean') return `b:${k}`;
  return `i:${k}`;
}

export function decodeKey(k) {
  return k.slice(2);
}
