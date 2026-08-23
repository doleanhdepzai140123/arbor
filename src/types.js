export const TyInt = { k: 'int' };
export const TyFloat = { k: 'float' };
export const TyBool = { k: 'bool' };
export const TyStr = { k: 'str' };
export const TyUnit = { k: 'unit' };
export const TyPoison = { k: 'poison' };

let varCounter = 0;
export function freshVar(label) {
  return { k: 'tvar', id: ++varCounter, label: label || 'T', bound: null };
}

export const mkArray = (elem) => ({ k: 'array', elem });
export const mkMap = (key, val) => ({ k: 'map', key, val });
export const mkSet = (elem) => ({ k: 'set', elem });
export const mkTable = (elem) => ({ k: 'table', elem });
export const mkHandle = (elem) => ({ k: 'handle', elem });
export const mkTuple = (items) => ({ k: 'tuple', items });
export const mkStruct = (name, fields) => ({ k: 'struct', name, fields });
export const mkEnum = (name, variants) => ({ k: 'enum', name, variants });
export const mkFn = (params, ret) => ({ k: 'fn', params, ret });
export const TyRange = { k: 'range' };

export function prune(t) {
  while (t && t.k === 'tvar' && t.bound) t = t.bound;
  return t;
}

export function eqTypes(a, b) {
  a = prune(a);
  b = prune(b);
  if (a === b) return true;
  if (a.k === 'poison' || b.k === 'poison') return true;
  if (a.k === 'tvar' || b.k === 'tvar') return a === b;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'int': case 'float': case 'bool': case 'str': case 'unit': return true;
    case 'array': return eqTypes(a.elem, b.elem);
    case 'set': return eqTypes(a.elem, b.elem);
    case 'handle': return eqTypes(a.elem, b.elem);
    case 'table': return eqTypes(a.elem, b.elem);
    case 'map': return eqTypes(a.key, b.key) && eqTypes(a.val, b.val);
    case 'tuple':
      return a.items.length === b.items.length && a.items.every((x, i) => eqTypes(x, b.items[i]));
    case 'struct': return a.name === b.name;
    case 'enum': return a.name === b.name;
    case 'fn':
      return a.ret && b.ret
        && a.params.length === b.params.length
        && a.params.every((p, i) => eqTypes(p.ty, b.params[i].ty))
        && eqTypes(a.ret, b.ret);
    default: return false;
  }
}

function bindVar(v, other) {
  v = prune(v);
  if (v.k !== 'tvar') return undefined;
  if (other.k === 'tvar') {
    other = prune(other);
    if (other === v) return true;
  }
  v.bound = other;
  return true;
}

export { bindVar };

export function isNumeric(t) {
  t = prune(t);
  return t.k === 'int' || t.k === 'float';
}

export function isScalarKey(t) {
  t = prune(t);
  return t.k === 'int' || t.k === 'str' || t.k === 'bool';
}

export function isCopy(t) {
  t = prune(t);
  if (!t) return false;
  switch (t.k) {
    case 'int': case 'float': case 'bool': case 'str': case 'unit': return true;
    case 'poison': return true;
    case 'tuple': return t.items.every(isCopy);
    case 'struct': return [...t.fields.values()].every(isCopy);
    case 'enum': return [...t.variants.values()].every(pay => pay.every(isCopy));
    default: return false;
  }
}

export function fmt(t) {
  t = prune(t);
  if (!t) return '?';
  switch (t.k) {
    case 'int': return 'Int';
    case 'float': return 'Float';
    case 'bool': return 'Bool';
    case 'str': return 'Str';
    case 'unit': return 'Unit';
    case 'poison': return '?';
    case 'tvar': return t.label;
    case 'array': return `[${fmt(t.elem)}]`;
    case 'set': return `Set[${fmt(t.elem)}]`;
    case 'handle': return `Handle[${fmt(t.elem)}]`;
    case 'table': return `Table[${fmt(t.elem)}]`;
    case 'map': return `Map[${fmt(t.key)}, ${fmt(t.val)}]`;
    case 'tuple': return `(${t.items.map(fmt).join(', ')})`;
    case 'struct': return t.name;
    case 'enum': return t.name;
    case 'fn': return `fn(${t.params.map(p => fmt(p.ty)).join(', ')}) -> ${fmt(t.ret)}`;
    case 'range': return 'Range';
    default: return '?';
  }
}
