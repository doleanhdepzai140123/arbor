export const T = {
  name: (name, args, span) => ({ k: 'tyName', name, args: args || [], span }),
  array: (elem, span) => ({ k: 'tyArray', elem, span }),
  tuple: (items, span) => ({ k: 'tyTuple', items, span }),
  unit: (span) => ({ k: 'tyUnit', span }),
  fnType: (params, ret, span) => ({ k: 'tyFn', params, ret, span }),
};

export const E = {
  int: (v, span) => ({ k: 'int', v, span }),
  float: (v, span) => ({ k: 'float', v, span }),
  bool: (v, span) => ({ k: 'bool', v, span }),
  str: (parts, span) => ({ k: 'str', parts, span }),
  unit: (span) => ({ k: 'unit', span }),
  name: (ident, span) => ({ k: 'name', ident, span }),
  unary: (op, e, span) => ({ k: 'unary', op, e, span }),
  binary: (op, l, r, span) => ({ k: 'binary', op, l, r, span }),
  call: (callee, args, span) => ({ k: 'call', callee, args, span }),
  index: (obj, idx, span) => ({ k: 'index', obj, idx, span }),
  field: (obj, name, span) => ({ k: 'field', obj, name, span }),
  method: (obj, name, args, span) => ({ k: 'method', obj, name, args, span }),
  tryExpr: (e, span) => ({ k: 'try', e, span }),
  structLit: (name, fields, span) => ({ k: 'structLit', name, fields, span }),
  arrayLit: (items, span) => ({ k: 'arrayLit', items, span }),
  mapLit: (entries, span) => ({ k: 'mapLit', entries, span }),
  tupleLit: (items, span) => ({ k: 'tupleLit', items, span }),
  closure: (params, body, isExpr, span) => ({ k: 'closure', params, body, isExpr, span }),
  match: (scrutinee, arms, span) => ({ k: 'match', scrutinee, arms, span }),
  ifE: (cond, thenB, elseB, span) => ({ k: 'if', cond, thenB, elseB, span }),
  block: (stmts, span) => ({ k: 'block', stmts, span }),
};

export const P = {
  lit: (kind, v, span) => ({ k: 'plit', kind, v, span }),
  bind: (name, span) => ({ k: 'pbind', name, span }),
  wild: (span) => ({ k: 'pwild', span }),
  tuple: (items, span) => ({ k: 'ptuple', items, span }),
  variant: (path, name, subs, span) => ({ k: 'pvariant', path, name, subs, span }),
};

export const S = {
  let: (name, ty, init, span) => ({ k: 'let', name, ty, init, span }),
  declVar: (name, ty, init, span) => ({ k: 'var', name, ty, init, span }),
  expr: (e, span) => ({ k: 'expr', e, span }),
  assign: (target, value, span) => ({ k: 'assign', target, value, span }),
  whileS: (cond, body, span) => ({ k: 'while', cond, body, span }),
  forS: (pat, iter, body, span) => ({ k: 'for', pat, iter, body, span }),
  returnS: (value, span) => ({ k: 'return', value, span }),
  breakS: (span) => ({ k: 'break', span }),
  continueS: (span) => ({ k: 'continue', span }),
  regionS: (name, body, span) => ({ k: 'region', name, body, span }),
  spawnS: (body, span) => ({ k: 'spawn', body, span }),
};

export const D = {
  fn: (name, typarams, params, retTy, body, span) =>
    ({ k: 'fn', name, typarams, params, retTy, body, span }),
  structD: (name, fields, span) => ({ k: 'struct', name, fields, span }),
  enumD: (name, variants, span) => ({ k: 'enum', name, variants, span }),
  use: (segments, names, span) => ({ k: 'use', segments, names, span }),
  useFile: (path, span) => ({ k: 'useFile', path, span }),
  constD: (name, value, span) => ({ k: 'const', name, value, span }),
};
