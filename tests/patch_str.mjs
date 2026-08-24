import fs from 'node:fs';

// builtins.js — add str method signatures
let b = fs.readFileSync('src/builtins.js', 'utf8');
const bAnchor = `    to_int: { sig: () => ({ selfMode: 'in', params: [], ret: BUILTIN_TYPES.Result.build([TyInt, TyStr]) }) },`;
if (!b.includes(bAnchor)) { console.log('B MISS'); process.exit(1); }
b = b.replace(bAnchor, bAnchor + `
    starts_with: { sig: () => ({ selfMode: 'in', params: [{ mode: 'in', ty: TyStr }], ret: TyBool }) },
    ends_with: { sig: () => ({ selfMode: 'in', params: [{ mode: 'in', ty: TyStr }], ret: TyBool }) },
    replace: { sig: () => ({ selfMode: 'in', params: [{ mode: 'in', ty: TyStr }, { mode: 'in', ty: TyStr }], ret: TyStr }) },`);
fs.writeFileSync('src/builtins.js', b);
console.log('builtins ok');

// runtime.js — add implementations
let r = fs.readFileSync('src/runtime.js', 'utf8');
const rAnchor = `      case 'to_int': {`;
if (!r.includes(rAnchor)) { console.log('R MISS'); process.exit(1); }
r = r.replace(rAnchor, `      case 'starts_with': arity(name, args, 1, span); return r.startsWith(args[0]);
      case 'ends_with': arity(name, args, 1, span); return r.endsWith(args[0]);
      case 'replace': arity(name, args, 2, span); return r.split(args[0]).join(args[1]);
` + rAnchor);
fs.writeFileSync('src/runtime.js', r);
console.log('runtime ok');

// cs_backend.js — add method dispatch + prelude helpers
let cs = fs.readFileSync('src/compiler/cs_backend.js', 'utf8');
const csAnchor = `        if (m === 'to_int') return \`\${'RT'}StrToInt(\${recv})\`;`;
const csAlt = `        if (m === 'to_int') return \`RT.StrToInt(\${recv})\`;`;
if (cs.includes(csAlt)) {
  cs = cs.replace(csAlt, csAlt + `
        if (m === 'starts_with') return \`RT.StrStartsWith(\${recv}, \${A()[0]})\`;
        if (m === 'ends_with') return \`RT.StrEndsWith(\${recv}, \${A()[0]})\`;
        if (m === 'replace') return \`RT.StrReplace(\${recv}, \${A()[0]}, \${A()[1]})\`;`);
} else if (cs.includes(csAnchor)) {
  cs = cs.replace(csAnchor, csAnchor + `
        if (m === 'starts_with') return \`RT.StrStartsWith(\${recv}, \${A()[0]})\`;
        if (m === 'ends_with') return \`RT.StrEndsWith(\${recv}, \${A()[0]})\`;
        if (m === 'replace') return \`RT.StrReplace(\${recv}, \${A()[0]}, \${A()[1]})\`;`);
} else {
  console.log('CS to_int anchor MISS');
}

const preludeAnchor = `    public static object StrToInt(object s) {`;
if (!cs.includes(preludeAnchor)) { console.log('CS PRELUDE MISS'); process.exit(1); }
cs = cs.replace(preludeAnchor, `    public static bool StrStartsWith(object s, object p) { return ((string)s).StartsWith((string)p); }
    public static bool StrEndsWith(object s, object p) { return ((string)s).EndsWith((string)p); }
    public static object StrReplace(object s, object oldV, object newV) { return ((string)s).Replace((string)oldV, (string)newV); }
` + preludeAnchor);
fs.writeFileSync('src/compiler/cs_backend.js', cs);
console.log('cs ok');
