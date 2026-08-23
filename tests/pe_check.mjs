import { readFileSync } from 'node:fs';

const b = readFileSync(process.argv[2] ?? 'tests/smoke.exe');
const u16 = (o) => b[o] | (b[o + 1] << 8);
const u32 = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

console.log('MZ:', String.fromCharCode(b[0], b[1]));
const lfanew = u32(0x3c);
console.log('e_lfanew:', '0x' + lfanew.toString(16));
console.log('PE sig:', String.fromCharCode(b[lfanew], b[lfanew + 1], b[lfanew + 2], b[lfanew + 3]));

const coff = lfanew + 4;
const machine = u16(coff);
const nsec = u16(coff + 2);
const symtab = u32(coff + 4);
const nsym = u32(coff + 8);
const optSize = u16(coff + 16);
const chars = u16(coff + 18);
console.log({ machine: '0x' + machine.toString(16), nsec, symtab, nsym, optSize, chars: '0x' + chars.toString(16) });

const opt = coff + 20;
console.log('opt magic:', '0x' + u16(opt).toString(16));
console.log('linker:', b[opt + 2], b[opt + 3]);
console.log('sizeOfCode:', u32(opt + 4));
console.log('sizeOfInitData:', u32(opt + 8));
console.log('entryRVA:', '0x' + u32(opt + 16).toString(16));
console.log('baseOfCode:', '0x' + u32(opt + 20).toString(16));
console.log('imageBase:', '0x' + u32(opt + 24).toString(16), '(high)', u32(opt + 28));
console.log('sectAlign:', '0x' + u32(opt + 32).toString(16));
console.log('fileAlign:', '0x' + u32(opt + 36).toString(16));
console.log('osVer:', u16(opt + 40), u16(opt + 42));
console.log('sizeOfImage:', '0x' + u32(opt + 56).toString(16));
console.log('sizeOfHeaders:', '0x' + u32(opt + 60).toString(16));
console.log('subsystem:', u16(opt + 68));
console.log('numRvaAndSizes:', u32(opt + 108));

const dirsBase = opt + 112;
for (let i = 0; i < 16; i++) {
  const rva = u32(dirsBase + i * 8);
  const sz = u32(dirsBase + i * 8 + 4);
  if (rva || sz) console.log(`dir[${i}] rva=0x${rva.toString(16)} size=${sz}`);
}

const sectTab = opt + optSize;
for (let s = 0; s < nsec; s++) {
  const o = sectTab + s * 40;
  const name = Buffer.from(b.slice(o, o + 8)).toString('binary').replace(/\0.*$/, '');
  const vSize = u32(o + 8), vAddr = u32(o + 12), rawSize = u32(o + 16), rawPtr = u32(o + 20), ch = u32(o + 36);
  const okAlign = rawPtr % 0x200 === 0 ? '' : ' ⚠️ RAW PTR NOT ALIGNED';
  console.log(`section ${name}: vSize=${vSize} vAddr=0x${vAddr.toString(16)} rawSize=${rawSize} rawPtr=0x${rawPtr.toString(16)} chars=0x${ch.toString(16)}${okAlign}`);
}
