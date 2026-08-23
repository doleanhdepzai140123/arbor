import { writeFileSync } from 'node:fs';
import { Asm } from '../src/compiler/assembler.js';
import { PEImage } from '../src/compiler/pe.js';

const variant = process.argv[2] ?? 'getonly';
const image = new PEImage();
image.addImport('kernel32.dll', 'ExitProcess');
image.addImport('kernel32.dll', 'GetStdHandle');
if (variant === 'write' || variant === 'writenox') image.addImport('kernel32.dll', 'WriteFile');

const asm = new Asm();
asm.label('_start');
asm.and_rsp_align();
asm.sub_imm('rsp', 48);
asm.mov_imm('rcx', -11);
asm.callImport('kernel32.dll', 'GetStdHandle');

if (variant === 'getonly') {
  asm.mov_imm('rcx', 7);
} else if (variant === 'writenox') {
  asm.mov_rr('rcx', 'rax');
  asm.leaRdata('rdx', 0);
  asm.mov_imm('r8', 3);
  asm.mov_imm('r9', 0);
  asm.callImport('kernel32.dll', 'WriteFile');
  asm.mov_imm('rcx', 7);
} else if (variant === 'write') {
  asm.mov_rr('rbx', 'rax');
  asm.leaRdata('rdx', 0);
  asm.mov_rr('rcx', 'rbx');
  asm.mov_imm('r8', 3);
  asm.lea('r9', 'rsp', { disp: 32 });
  asm.mov_imm('rax', 0);
  asm.store64('rax', 'rsp', { disp: 32 });
  asm.callImport('kernel32.dll', 'WriteFile');
  asm.mov_imm('rcx', 7);
}
asm.callImport('kernel32.dll', 'ExitProcess');

asm.emitImportThunks();
image.textBytes = Uint8Array.from(asm.resolve());
image.entryTextOff = asm.labels.get('_start');
image.rdataBytes = Uint8Array.from([72, 105, 10]);
image.dataBytes = [];
for (const ref of asm.extRefs) {
  if (ref.kind === 'iat') image.extRefs.push({ kind: 'iat', tag: ref.tag, at: ref.at });
  else if (ref.kind === 'rdata') image.extRefs.push({ kind: 'rdata', tag: 0, at: ref.at });
}
image.layout();
writeFileSync(`tests/smoke_${variant}.exe`, image.finish());
console.log('wrote', variant);
