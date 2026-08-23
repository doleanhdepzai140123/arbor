import { writeFileSync } from 'node:fs';
import { Asm } from '../src/compiler/assembler.js';
import { PEImage } from '../src/compiler/pe.js';

const image = new PEImage();
image.addImport('kernel32.dll#0', 'GetCurrentProcessId');
image.addImport('kernel32.dll#1', 'ExitProcess');
const asm = new Asm();
asm.label('_start');
asm.and_rsp_align();
asm.sub_imm('rsp', 48);
asm.callImport('kernel32.dll#0', 'GetCurrentProcessId');
asm.mov_rr('rcx', 'rax');

// rcx &= 0xFF  (low byte of pid as exit code)
asm.rexFor(1, 'rcx', null, null);
asm.db(0x83); asm.db(0xE1); asm.db(0xFF);

asm.callImport('kernel32.dll#1', 'ExitProcess');
asm.emitImportThunks();
image.textBytes = Uint8Array.from(asm.resolve());
image.entryTextOff = asm.labels.get('_start');
for (const r of asm.extRefs) if (r.kind === 'iat') image.extRefs.push({ kind: 'iat', tag: r.tag, at: r.at });
image.layout();
writeFileSync('tests/smoke_perfn.exe', image.finish());
console.log('built perfn v2');
