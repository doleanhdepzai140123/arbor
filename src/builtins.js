import {
  TyInt, TyFloat, TyBool, TyStr, TyUnit,
  mkArray,
  mkMap, mkSet, mkTable, mkHandle, mkTuple,
  mkStruct, mkEnum, mkFn, freshVar,
} from './types.js';

export const BUILTIN_TYPES = {
  Int: { kind: 'int', arity: 0, build: () => TyInt },
  Float: { kind: 'float', arity: 0, build: () => TyFloat },
  Bool: { kind: 'bool', arity: 0, build: () => TyBool },
  Str: { kind: 'str', arity: 0, build: () => TyStr },
  Unit: { kind: 'unit', arity: 0, build: () => TyUnit },
  Array: { kind: 'array', arity: 1, build: (a) => mkArray(a[0]) },
  Map: { kind: 'map', arity: 2, build: (a) => mkMap(a[0], a[1]) },
  Set: { kind: 'set', arity: 1, build: (a) => mkSet(a[0]) },
  Table: { kind: 'table', arity: 1, build: (a) => mkTable(a[0]) },
  Handle: { kind: 'handle', arity: 1, build: (a) => mkHandle(a[0]) },
  Option: {
    kind: 'enum', arity: 1,
    build: (a) => mkEnum('Option', new Map([['Some', [a[0]]], ['None', []]])),
  },
  Result: {
    kind: 'enum', arity: 2,
    build: (a) => mkEnum('Result', new Map([['Ok', [a[0]]], ['Err', [a[1]]]])),
  },
};

const ANY = { k: 'any' };

function bif(name, params, ret) {
  return { symKind: 'bif', name, params, ret };
}

export const MODULES = {
  std: {
    io: {
      println: bif('println', [{ mode: 'in', name: 'x', ty: ANY }], TyUnit),
      print: bif('print', [{ mode: 'in', name: 'x', ty: ANY }], TyUnit),
      dbg: bif('dbg', [{ mode: 'in', name: 'x', ty: ANY }], TyUnit),
      to_str: bif('to_str', [{ mode: 'in', name: 'x', ty: ANY }], TyStr),
    },
    math: {
      sqrt: bif('sqrt', [{ mode: 'in', name: 'x', ty: TyFloat }], TyFloat),
      floor: bif('floor', [{ mode: 'in', name: 'x', ty: TyFloat }], TyFloat),
      ceil: bif('ceil', [{ mode: 'in', name: 'x', ty: TyFloat }], TyFloat),
      round: bif('round', [{ mode: 'in', name: 'x', ty: TyFloat }], TyFloat),
      abs: bif('abs', [{ mode: 'in', name: 'x', ty: TyFloat }], TyFloat),
      pow: bif('pow', [{ mode: 'in', name: 'base', ty: TyFloat }, { mode: 'in', name: 'exp', ty: TyFloat }], TyFloat),
      exp: bif('exp', [{ mode: 'in', name: 'x', ty: TyFloat }], TyFloat),
      ln: bif('ln', [{ mode: 'in', name: 'x', ty: TyFloat }], TyFloat),
      sin: bif('sin', [{ mode: 'in', name: 'x', ty: TyFloat }], TyFloat),
      cos: bif('cos', [{ mode: 'in', name: 'x', ty: TyFloat }], TyFloat),
      pi: { symKind: 'const', ty: TyFloat },
      e: { symKind: 'const', ty: TyFloat },
    },
    fs: {
      read_file: bif('read_file', [{ mode: 'in', name: 'path', ty: TyStr }], BUILTIN_TYPES.Result.build([TyStr, TyStr])),
      write_file: bif('write_file', [{ mode: 'in', name: 'path', ty: TyStr }, { mode: 'in', name: 'contents', ty: TyStr }], BUILTIN_TYPES.Result.build([TyInt, TyStr])),
    },
    time: {
      now_ms: bif('now_ms', [], TyInt),
    },
    env: {
      args: bif('args', [], mkArray(TyStr)),
    },
    mem: {
      live: bif('live', [], TyInt),
      allocs: bif('allocs', [], TyInt),
    },
  },
};

export const PRELUDE_FNS = {
  println: MODULES.std.io.println,
  print: MODULES.std.io.print,
  dbg: MODULES.std.io.dbg,
  drop: bif('drop', [{ mode: 'own', name: 'x', ty: ANY }], TyUnit),
  assert: bif('assert', [{ mode: 'in', name: 'cond', ty: TyBool }], TyUnit),
  assert_eq: bif('assert_eq', [{ mode: 'in', name: 'a', ty: ANY }, { mode: 'in', name: 'b', ty: ANY }], TyUnit),
};

export function makeGenericCtor(enumName, variantName, arity) {
  return {
    symKind: 'ctor',
    genericCtor: true,
    enumName,
    variantName,
    arity,
    instantiate(argTys, err) {
      if (argTys.length !== arity) {
        err('A0009', `variant ${enumName}.${variantName} expects ${arity} payload value(s), got ${argTys.length}`);
        return null;
      }
      const vars = [];
      for (let i = 0; i < BUILTIN_TYPES[enumName].arity; i++) vars.push(freshVar(`${enumName}${i}`));
      const enumTy = BUILTIN_TYPES[enumName].build(vars);
      const payloads = enumTy.variants.get(variantName);
      return { enumTy, payloads };
    },
  };
}

export const PRELUDE_CTORS = {
  Some: makeGenericCtor('Option', 'Some', 1),
  None: makeGenericCtor('Option', 'None', 0),
  Ok: makeGenericCtor('Result', 'Ok', 1),
  Err: makeGenericCtor('Result', 'Err', 1),
};

function annotatePaths(node, prefix) {
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') {
      if ('symKind' in v) {
        v._path = `${prefix}.${k}`;
      } else {
        annotatePaths(v, `${prefix}.${k}`);
      }
    }
  }
}

for (const [topName, sub] of Object.entries(MODULES)) {
  annotatePaths(sub, topName);
}

export const METHODS = {
  int: {
    to_float: { sig: () => ({ selfMode: 'in', params: [], ret: TyFloat }) },
    to_str: { sig: () => ({ selfMode: 'in', params: [], ret: TyStr }) },
    abs: { sig: () => ({ selfMode: 'in', params: [], ret: TyInt }) },
  },
  float: {
    floor: { sig: () => ({ selfMode: 'in', params: [], ret: TyFloat }) },
    ceil: { sig: () => ({ selfMode: 'in', params: [], ret: TyFloat }) },
    round: { sig: () => ({ selfMode: 'in', params: [], ret: TyFloat }) },
    sqrt: { sig: () => ({ selfMode: 'in', params: [], ret: TyFloat }) },
    abs: { sig: () => ({ selfMode: 'in', params: [], ret: TyFloat }) },
    to_int: { sig: () => ({ selfMode: 'in', params: [], ret: TyInt }) },
    to_str: { sig: () => ({ selfMode: 'in', params: [], ret: TyStr }) },
  },
  str: {
    len: { sig: () => ({ selfMode: 'in', params: [], ret: TyInt }) },
    upper: { sig: () => ({ selfMode: 'in', params: [], ret: TyStr }) },
    lower: { sig: () => ({ selfMode: 'in', params: [], ret: TyStr }) },
    trim: { sig: () => ({ selfMode: 'in', params: [], ret: TyStr }) },
    contains: { sig: () => ({ selfMode: 'in', params: [{ mode: 'in', ty: TyStr }], ret: TyBool }) },
    split: { sig: () => ({ selfMode: 'in', params: [{ mode: 'in', ty: TyStr }], ret: mkArray(TyStr) }) },
    chars: { sig: () => ({ selfMode: 'in', params: [], ret: mkArray(TyStr) }) },
    repeat: { sig: () => ({ selfMode: 'in', params: [{ mode: 'in', ty: TyInt }], ret: TyStr }) },
    to_int: { sig: () => ({ selfMode: 'in', params: [], ret: BUILTIN_TYPES.Result.build([TyInt, TyStr]) }) },
  },
  bool: {
    to_str: { sig: () => ({ selfMode: 'in', params: [], ret: TyStr }) },
  },
  array: {
    len: { sig: (r) => ({ selfMode: 'in', params: [], ret: TyInt }) },
    push: { sig: (r) => ({ selfMode: 'inout', params: [{ mode: 'own', ty: r.elem }], ret: TyUnit }) },
    pop: { sig: (r) => ({ selfMode: 'inout', params: [], ret: BUILTIN_TYPES.Option.build([r.elem]) }) },
    get: { sig: (r) => ({ selfMode: 'in', params: [{ mode: 'in', ty: TyInt }], ret: BUILTIN_TYPES.Option.build([r.elem]) }) },
    set: { sig: (r) => ({ selfMode: 'inout', params: [{ mode: 'in', ty: TyInt }, { mode: 'own', ty: r.elem }], ret: TyUnit }) },
    take: { sig: (r) => ({ selfMode: 'inout', params: [{ mode: 'in', ty: TyInt }], ret: r.elem }) },
    clone: { sig: (r) => ({ selfMode: 'in', params: [], ret: r }) },
    reverse: { sig: (r) => ({ selfMode: 'inout', params: [], ret: TyUnit }) },
    contains: { sig: (r) => ({ selfMode: 'in', params: [{ mode: 'in', ty: r.elem }], ret: TyBool }) },
    is_empty: { sig: (r) => ({ selfMode: 'in', params: [], ret: TyBool }) },
    first: { sig: (r) => ({ selfMode: 'in', params: [], ret: BUILTIN_TYPES.Option.build([r.elem]) }) },
    last: { sig: (r) => ({ selfMode: 'in', params: [], ret: BUILTIN_TYPES.Option.build([r.elem]) }) },
    sort_by: {
      sig: (r) => ({
        selfMode: 'inout',
        params: [{ mode: 'in', ty: mkFn([{ mode: 'in', ty: r.elem }, { mode: 'in', ty: r.elem }], TyInt) }],
        ret: TyUnit,
      }),
    },
  },
  map: {
    len: { sig: () => ({ selfMode: 'in', params: [], ret: TyInt }) },
    insert: { sig: (r) => ({ selfMode: 'inout', params: [{ mode: 'in', ty: r.key }, { mode: 'own', ty: r.val }], ret: BUILTIN_TYPES.Option.build([r.val]) }) },
    get: { sig: (r) => ({ selfMode: 'in', params: [{ mode: 'in', ty: r.key }], ret: BUILTIN_TYPES.Option.build([r.val]) }) },
    remove: { sig: (r) => ({ selfMode: 'inout', params: [{ mode: 'in', ty: r.key }], ret: BUILTIN_TYPES.Option.build([r.val]) }) },
    keys: { sig: (r) => ({ selfMode: 'in', params: [], ret: mkArray(r.key) }) },
    contains_key: { sig: (r) => ({ selfMode: 'in', params: [{ mode: 'in', ty: r.key }], ret: TyBool }) },
    is_empty: { sig: () => ({ selfMode: 'in', params: [], ret: TyBool }) },
  },
  set: {
    len: { sig: () => ({ selfMode: 'in', params: [], ret: TyInt }) },
    insert: { sig: (r) => ({ selfMode: 'inout', params: [{ mode: 'in', ty: r.elem }], ret: TyBool }) },
    remove: { sig: (r) => ({ selfMode: 'inout', params: [{ mode: 'in', ty: r.elem }], ret: TyBool }) },
    contains: { sig: (r) => ({ selfMode: 'in', params: [{ mode: 'in', ty: r.elem }], ret: TyBool }) },
    to_array: { sig: (r) => ({ selfMode: 'in', params: [], ret: mkArray(r.elem) }) },
  },
  table: {
    len: { sig: () => ({ selfMode: 'in', params: [], ret: TyInt }) },
    insert: { sig: (r) => ({ selfMode: 'inout', params: [{ mode: 'own', ty: r.elem }], ret: mkHandle(r.elem) }) },
    get: { sig: (r) => ({ selfMode: 'in', params: [{ mode: 'in', ty: mkHandle(r.elem) }], ret: BUILTIN_TYPES.Option.build([r.elem]) }) },
    set: { sig: (r) => ({ selfMode: 'inout', params: [{ mode: 'in', ty: mkHandle(r.elem) }, { mode: 'own', ty: r.elem }], ret: TyUnit }) },
    remove: { sig: (r) => ({ selfMode: 'inout', params: [{ mode: 'in', ty: mkHandle(r.elem) }], ret: BUILTIN_TYPES.Option.build([r.elem]) }) },
    alive: { sig: (r) => ({ selfMode: 'in', params: [{ mode: 'in', ty: mkHandle(r.elem) }], ret: TyBool }) },
    is_empty: { sig: () => ({ selfMode: 'in', params: [], ret: TyBool }) },
  },
  handle: {},
  option: {
    unwrap: { sig: (r) => optSig(r, 'Some', 'unwrap') },
    expect: { sig: (r) => optSig(r, 'Some', 'expect') },
    is_some: { sig: (r) => optSig(r, 'Some', 'is_some') },
    is_none: { sig: (r) => optSig(r, 'Some', 'is_none') },
    unwrap_or: { sig: (r) => optSigOr(r) },
  },
  result: {
    unwrap: { sig: (r) => resSig(r, 'unwrap') },
    expect: { sig: (r) => resSig(r, 'expect') },
    is_ok: { sig: (r) => resFlag(r, 'is_ok') },
    is_err: { sig: (r) => resFlag(r, 'is_err') },
    unwrap_or: { sig: (r) => resOr(r) },
  },
};

function optSig(r, _, name) {
  const inner = r.variants.get('Some')[0];
  if (name === 'unwrap' || name === 'expect') {
    return {
      selfMode: 'in',
      params: name === 'expect' ? [{ mode: 'in', ty: TyStr }] : [],
      ret: inner,
      trapOn: { variant: 'None', msg: 'called unwrap on None' },
    };
  }
  if (name === 'is_some' || name === 'is_none') return { selfMode: 'in', params: [], ret: TyBool };
  throw new Error('unreachable');
}

function optSigOr(r) {
  const inner = r.variants.get('Some')[0];
  return { selfMode: 'in', params: [{ mode: 'own', ty: inner }], ret: inner };
}

function resSig(r, name) {
  const okTy = r.variants.get('Ok')[0];
  return {
    selfMode: 'in',
    params: name === 'expect' ? [{ mode: 'in', ty: TyStr }] : [],
    ret: okTy,
    trapOn: { variant: 'Err', msg: 'called unwrap on Err' },
  };
}

function resFlag(r, name) {
  void r;
  void name;
  return { selfMode: 'in', params: [], ret: TyBool };
}

function resOr(r) {
  const okTy = r.variants.get('Ok')[0];
  return { selfMode: 'in', params: [{ mode: 'own', ty: okTy }], ret: okTy };
}

export function methodKindOf(ty) {
  switch (ty.k) {
    case 'int': return 'int';
    case 'float': return 'float';
    case 'str': return 'str';
    case 'bool': return 'bool';
    case 'array': return 'array';
    case 'map': return 'map';
    case 'set': return 'set';
    case 'table': return 'table';
    case 'handle': return 'handle';
    case 'enum':
      if (ty.name === 'Option') return 'option';
      if (ty.name === 'Result') return 'result';
      return null;
    default: return null;
  }
}

export const UNIT_LIT = E_unit();
function E_unit() { return { k: 'unitv' }; }
