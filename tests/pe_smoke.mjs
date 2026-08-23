import { writeFileSync } from 'node:fs';
import { Asm } from '../src/compiler/assembler.js';
import { PEImage, IMAGE_BASE } from '../src/compiler/pe.js';

const variant = process.argv[2] ?? 'exit';
const image = new PEImage();
image.addImport('kernel32.dll', 'ExitProcess');
if (variant !== 'exit') image.addImport('kernel32.dll', 'GetStdHandle');
if (variant === 'write') image.addImport('kernel32.dll', 'WriteFile');

const asm = new Asm();
const MSG = 'Hi\n';

asm.label('_start');
asm.and_rsp_align();
asm.sub_imm('rsp', 48);
if (variant !== 'exit') {
  asm.mov_imm('rcx', -11);
  asm.callImport('kernel32.dll', 'GetStdHandle');
}
if (variant === 'write') {
  asm.mov_rr('rbx', 'rax');
  asm.leaRdata('rdx', 0);
  asm.mov_rr('rcx', 'rbx');
  asm.mov_imm('r8', MSG.length);
  asm.lea('r9', 'rsp', { disp: 32 });
  asm.mov_imm('rax', 0);
  asm.store64('rax', 'rsp', { disp: 32 });
  asm.callImport('kernel32.dll', 'WriteFile');
}
asm.mov_imm('rcx', variant === 'exit' ? 42 : 7);
asm.callImport('kernel32.dll', 'ExitProcess');

asm.emitImportThunks();

const rdata = [];
for (const ch of MSG) rdata.push(ch.charCodeAt(0));

image.textBytes = Uint8Array.from(asm.resolve());
image.entryTextOff = asm.labels.get('_start');
image.rdataBytes = Uint8Array.from(rdata);
image.dataBytes = [];

for (const ref of asm.extRefs) {
  if (ref.kind === 'iat') {
    image.extRefs.push({ kind: 'iat', tag: ref.tag, at: ref.at });
  } else if (ref.kind === 'rdata') {
    image.extRefs.push({ kind: 'rdata', tag: 0, at: ref.at });
  }
}

image.layout();
for (const r of image.extRefs) {
  const tagStr = String(r.tag);
  console.log('ref', r.kind, tagStr.replace('kernel32.dll!', ''), 'at=0x' + r.at.toString(16), 'va=+0x' + (r.va - IMAGE_BASE).toString(16));
}

const exe = image.finish();
writeFileSync(`tests/smoke_${variant}.exe`, exe);
console.log(`wrote smoke_${variant}.exe`);
