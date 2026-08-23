import { readFileSync } from 'node:fs';

const b = readFileSync(process.argv[2] ?? 'tests/smoke_exit.exe');
const u16 = o => b[o] | (b[o + 1] << 8);
const u32 = o => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const lfanew = u32(0x3c);
const coff = lfanew + 4;
const optSize = u16(coff + 16);
const sectTab = coff + 20 + optSize;
const nsec = u16(coff + 2);
const secs = [];
for (let s = 0; s < nsec; s++) {
  const o = sectTab + s * 40;
  const name = Buffer.from(b.slice(o, o + 8)).toString('binary').replace(/\0.*$/, '');
  secs.push({ name, rva: u32(o + 12), rawPtr: u32(o + 20), size: u32(o + 16) });
}
const rvaToOff = (rva) => {
  const s = secs.find(s => rva >= s.rva && rva < s.rva + Math.max(s.size, 1));
  return s ? s.rawPtr + (rva - s.rva) : -1;
};
const dirRVA = u32(coff + 20 + 112 + 8);
console.log('import dir RVA:', '0x' + dirRVA.toString(16));
let off = rvaToOff(dirRVA);
console.log('file off:', '0x' + off.toString(16));

let idx = 0;
while (true) {
  const oft = u32(off), ts = u32(off + 4), fwd = u32(off + 8), name = u32(off + 12), ft = u32(off + 16);
  if (!oft && !name && !ft) { console.log(`[${idx}] terminator`); break; }
  const nameOff = rvaToOff(name);
  const dllName = Buffer.from(b.slice(nameOff, nameOff + 24)).toString('binary').replace(/\0.*$/, '');
  console.log(`[${idx}] OFT=0x${oft.toString(16)} Name="${dllName}" FT=0x${ft.toString(16)}`);
  // walk INT
  let intOff = rvaToOff(oft);
  let i = 0;
  while (true) {
    const hintNameRVA = u32(intOff + i * 4);
    if (hintNameRVA === 0) { console.log(`   INT[${i}] end`); break; }
    const hOff = rvaToOff(hintNameRVA);
    const fname = Buffer.from(b.slice(hOff + 2, hOff + 40)).toString('binary').replace(/\0.*$/, '');
    console.log(`   INT[${i}] -> "${fname}"`);
    i++;
  }
  off += 20;
  idx++;
  if (idx > 5) break;
}
