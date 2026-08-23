import { Asm } from './assembler.js';

const MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, PAGE_RW = 0x04;
const CHUNK = 1 << 20;

export const IMPORTS = [
  ['kernel32.dll', 'ExitProcess'],
  ['kernel32.dll', 'GetStdHandle'],
  ['kernel32.dll', 'WriteFile'],
  ['kernel32.dll', 'VirtualAlloc'],
  ['msvcrt.dll', '_snprintf'],
];

export const GLOBALS = [
  'g_heap_ptr', 'g_heap_end', 'g_stdout',
  'g_total', 'g_rstack', 'g_rdepth',
  'g_task_q', 'g_task_head', 'g_task_tail', 'g_task_cap',
];

// rd: rdata builder supplied by compiler/index.js with .cstr(s)->offset and .bytes(...)
export function emitRuntime(asm, rd) {
  entry(asm);
  grow(asm);
  alloc(asm);
  getStdout(asm);
  write(asm);
  printStr(asm);
  printF64(asm, rd);
  intToStr(asm);
  floatToStr(asm, rd);
  boolToStr(asm, rd);
  strConcat(asm);
  memcpyN(asm);
  trap(asm, rd);
  bounds(asm);
  tableNew(asm);
  tableInsert(asm);
  tableGet(asm);
  tableSet(asm);
  tableRemove(asm);
  tableAlive(asm);
  regionEnterExit(asm);
  liveAllocs(asm);
  spawnDrain(asm);
}

function entry(a) {
  a.align(16);
  a.label('_start');
  a.and_rsp_align();
  a.sub_imm('rsp', 32);
  a.call('arbor_main');
  a.mov_rr('rcx', 'rax');
  a.callImport('kernel32.dll', 'ExitProcess');
}

function grow(a) {
  a.align(16);
  a.label('rt_grow');
  a.push('rbx');
  a.mov_imm('rcx', 0);
  a.mov_imm('rdx', CHUNK);
  a.mov_imm('r8', MEM_COMMIT | MEM_RESERVE);
  a.mov_imm('r9', PAGE_RW);
  a.callImport('kernel32.dll', 'VirtualAlloc');
  a.pop('rbx');
  a.test_rr('rax', 'rax');
  a.jcc('ne', '.ok');
  a.mov_imm('rcx', 3);
  a.callImport('kernel32.dll', 'ExitProcess');
  a.label('.ok');
  a.loadGlobal('rcx', 'g_heap_ptr');
  a.store64('rcx', 'rax', { disp: 0 });
  a.lea('rdx', 'rax', { disp: CHUNK - 16 });
  a.storeGlobal('rax', 'g_heap_ptr');
  a.storeGlobal('rdx', 'g_heap_end');
  a.ret();
}

function alloc(a) {
  a.align(16);
  a.label('rt_alloc');
  a.push('rbx');
  a.mov_rr('rbx', 'rcx');
  a.add_imm('rcx', 15);
  a.and_imm('rcx', -16);
  a.loadGlobal('r10', 'g_heap_ptr');
  a.loadGlobal('r11', 'g_heap_end');
  a.lea('rax', 'r10', { index: 'rcx', scale: 1 });
  a.cmp_rr('rax', 'r11');
  a.jcc('be', '.fit');
  a.mov_rr('rcx', 'rbx');
  a.call('rt_grow');
  a.mov_rr('rcx', 'rbx');
  a.loadGlobal('r10', 'g_heap_ptr');
  a.label('.fit');
  a.lea('r11', 'r10', { index: 'rcx', scale: 1 });
  a.storeGlobal('r11', 'g_heap_ptr');
  a.loadGlobal('rax', 'g_total');
  a.add_imm('rax', 1);
  a.storeGlobal('rax', 'g_total');
  a.mov_rr('rax', 'r10');
  a.pop('rbx');
  a.ret();
}

function getStdout(a) {
  a.align(16);
  a.label('rt_get_stdout');
  a.loadGlobal('rax', 'g_stdout');
  a.test_rr('rax', 'rax');
  a.jcc('ne', '.done');
  a.push('rbx');
  a.sub_imm('rsp', 32);
  a.mov_imm('rcx', -11);
  a.callImport('kernel32.dll', 'GetStdHandle');
  a.add_imm('rsp', 32);
  a.pop('rbx');
  a.storeGlobal('rax', 'g_stdout');
  a.label('.done');
  a.loadGlobal('rax', 'g_stdout');
  a.ret();
}

function write(a) {
  a.align(16);
  a.label('rt_write');
  a.push('rbx');
  a.push('r12');
  a.sub_imm('rsp', 48);
  a.mov_rr('rbx', 'rcx');
  a.mov_rr('r12', 'rdx');
  a.call('rt_get_stdout');
  a.mov_rr('rcx', 'rax');
  a.mov_rr('rdx', 'rbx');
  a.mov_rr('r8', 'r12');
  a.lea('r9', 'rsp', { disp: 32 });
  a.mov_imm('rax', 0);
  a.store64('rax', 'rsp', { disp: 32 });
  a.callImport('kernel32.dll', 'WriteFile');
  a.add_imm('rsp', 48);
  a.pop('r12');
  a.pop('rbx');
  a.ret();
}

function printStr(a) {
  a.align(16);
  a.label('rt_print_str');       // rcx = AbStr*
  a.push('rbx');
  a.sub_imm('rsp', 32);
  a.mov_rr('rbx', 'rcx');
  a.load64('rdx', 'rbx', { disp: 0 });
  a.lea('rcx', 'rbx', { disp: 8 });
  a.call('rt_write');
  a.add_imm('rsp', 32);
  a.pop('rbx');
  a.ret();
}

// converts i64 in rbx into buffer [rsp+bufOff..+31]; returns rcx=start, rdx=len
function i64Digits(a, bufOff) {
  a.mov_imm('r13', 10);
  a.lea('rcx', 'rsp', { disp: bufOff + 40 });
  a.test_rr('rbx', 'rbx');
  a.jcc('ns', '.pos');
  a.neg_r('rbx');
  a.label('.negloop');
  a.mov_rr('rax', 'rbx');
  a.xor_rr('edx', 'edx');
  a.idiv_r('r13');
  a.add_imm('rdx', 48);
  a.sub_imm('rcx', 1);
  a.store64('rdx', 'rcx', { disp: 0 });
  a.mov_rr('rbx', 'rax');
  a.test_rr('rbx', 'rbx');
  a.jcc('ne', '.negloop');
  a.sub_imm('rcx', 1);
  a.store_imm32('rcx', { disp: 0 }, 45);
  a.jmp('.fin');
  a.label('.pos');
  a.label('.posloop');
  a.mov_rr('rax', 'rbx');
  a.xor_rr('edx', 'edx');
  a.idiv_r('r13');
  a.add_imm('rdx', 48);
  a.sub_imm('rcx', 1);
  a.store64('rdx', 'rcx', { disp: 0 });
  a.mov_rr('rbx', 'rax');
  a.test_rr('rbx', 'rbx');
  a.jcc('ne', '.posloop');
  a.label('.fin');
  a.lea('rdx', 'rsp', { disp: bufOff + 40 });
  a.sub_rr('rdx', 'rcx');
}

function printI64(a) {
  a.align(16);
  a.label('rt_print_i64');      // rcx = value
  a.push('rbx');
  a.push('r12');
  a.push('r13');
  a.sub_imm('rsp', 96);          // shadow 32 + buf 64
  a.mov_rr('rbx', 'rcx');
  i64Digits(a, 32);
  a.call('rt_write');
  a.add_imm('rsp', 96);
  a.pop('r13');
  a.pop('r12');
  a.pop('rbx');
  a.ret();
}

function intToStr(a) {
  a.align(16);
  a.label('rt_int_to_str');     // rcx = value -> rax AbStr
  a.push('rbx');
  a.push('r12');
  a.push('r13');
  a.sub_imm('rsp', 96);
  a.mov_rr('rbx', 'rcx');
  i64Digits(a, 32);
  a.mov_rr('r12', 'rdx');        // len
  a.mov_rr('rcx', 'rdx');
  a.add_imm('rcx', 8);
  a.call('rt_alloc');
  a.mov_rr('rbx', 'rax');
  a.store64('r12', 'rbx', { disp: 0 });
  a.lea('rdi', 'rbx', { disp: 8 });
  a.mov_rr('rsi', 'rsp');
  a.add_rr('rsi', { toReg: 'none' });
  void 0;
  // copy digits: src = rsp+32+(40-len) => rcx saved earlier lost; recompute:
  a.mov_rr('rcx', 'r12');
  a.lea('rsi', 'rsp', { disp: 72 });
  a.sub_rr('rsi', 'rcx');
  a.rep_movsb();
  a.mov_rr('rax', 'rbx');
  a.add_imm('rsp', 96);
  a.pop('r13');
  a.pop('r12');
  a.pop('rbx');
  a.ret();
}

function floatToStr(a, rd) {
  a.align(16);
  a.label('rt_float_to_str');   // xmm0 = value -> rax AbStr
  a.push('rbx');
  a.push('r12');
  a.push('r13');
  a.sub_imm('rsp', 128);         // 32 shadow + 96 buf
  a.lea('rcx', 'rsp', { disp: 32 });
  a.mov_imm('rdx', 95);
  const fmtOff = rd.cstr('%.17g');
  a.leaRdata('r8', fmtOff);
  a.mov_imm('eax', 1);
  a.callImport('msvcrt.dll', '_snprintf');
  a.mov_rr('r12', 'rax');
  a.test_rr('r12', 'r12');
  a.jcc('g', '.haveLen');
  a.mov_imm('r12', 1);
  a.label('.haveLen');
  // ensure trailing ".0" when no [.eE]
  a.lea('rcx', 'rsp', { disp: 32 });
  a.xor_rr('r13', 'r13');
  a.label('.scan');
  a.cmp_rr('r13', 'r12');
  a.jcc('ge', '.scanDone');
  a.load64_zx8('rax', 'rcx', {});
  void_loadzx_fix(a);
  a.cmp_imm('rax', 46); a.jcc('e', '.hasDot');
  a.cmp_imm('rax', 101); a.jcc('e', '.hasDot');
  a.cmp_imm('rax', 69); a.jcc('e', '.hasDot');
  a.cmp_imm('rax', 110); a.jcc('e', '.hasDot');
  a.cmp_imm('rax', 78); a.jcc('e', '.hasDot');
  a.add_imm('rcx', 1);
  a.add_imm('r13', 1);
  a.jmp('.scan');
  a.label('.hasDot');
  a.jmp('.mk');
  a.label('.scanDone');
  a.mov_rr('rax', 46);
  a.store64('rax', 'rcx', { disp: 0 });
  a.mov_rr('rax', 48);
  a.store64('rax', 'rcx', { disp: 1 });
  a.add_imm('r12', 2);
  a.label('.mk');
  a.mov_rr('rcx', 'r12');
  a.add_imm('rcx', 8);
  a.call('rt_alloc');
  a.mov_rr('rbx', 'rax');
  a.store64('r12', 'rbx', { disp: 0 });
  a.lea('rdi', 'rbx', { disp: 8 });
  a.lea('rsi', 'rsp', { disp: 32 });
  a.mov_rr('rcx', 'r12');
  a.rep_movsb();
  a.mov_rr('rax', 'rbx');
  a.add_imm('rsp', 128);
  a.pop('r13');
  a.pop('r12');
  a.pop('rbx');
  a.ret();
}

function void_loadzx_fix(a) {
  void a;
}
