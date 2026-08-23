export const REGS64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
const REGS32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi',
  'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'];
const REGS8L = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil',
  'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b'];

function regIdx(r) { return typeof r === 'number' ? r : REGS64.indexOf(r); }

const CC = { e: 0x4, ne: 0x5, l: 0xC, le: 0xE, g: 0xF, ge: 0xD, b: 0x2, be: 0x6, a: 0x7, ae: 0x3 };

export class Asm {
  constructor() {
    this.text = [];
    this.labels = new Map();
    this.fixups = [];
    this.extRefs = [];
    this.usedImports = new Set();
  }

  here() { return this.text.length; }
  label(name) {
    if (this.labels.has(name)) throw new Error(`duplicate label ${name}`);
    this.labels.set(name, this.text.length);
  }
  db(...bytes) { for (const b of bytes) this.text.push(b & 0xFF); }
  dq(value) {
    const big = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    for (let i = 0; i < 8; i++) this.text.push(Number((big >> BigInt(i * 8)) & 0xFFn));
  }
  dd(value) {
    const u = (value | 0) >>> 0;
    this.db(u & 0xFF, (u >> 8) & 0xFF, (u >> 16) & 0xFF, (u >> 24) & 0xFF);
  }
  align(n) { while (this.text.length % n !== 0) this.text.push(0xCC); }
  embedBytes(bytes) { for (const b of bytes) this.text.push(b & 0xFF); }

  rel32Fixup(targetLabel, at) { this.fixups.push({ at, targetLabel }); }

  emitRel32(targetLabel) { this.rel32Fixup(targetLabel, this.here()); this.dd(0); }

  ripDisp32(kind, tag) {
    this.extRefs.push({ kind, tag, at: this.here() });
    this.dd(0);
  }

  loadGlobal(reg, name) {
    const ri = regIdx(reg);
    if (ri >= 8) this.rex(1, false, false, true);
    else this.rex(1);
    this.db(0x8B);
    this.db(this.modrm(0, ri, 5));
    this.ripDisp32('global', name);
  }
  storeGlobal(reg, name) {
    const ri = regIdx(reg);
    if (ri >= 8) this.rex(1, false, false, true);
    else this.rex(1);
    this.db(0x89);
    this.db(this.modrm(0, ri, 5));
    this.ripDisp32('global', name);
  }
  leaGlobal(reg, name) {
    const ri = regIdx(reg);
    if (ri >= 8) this.rex(1, false, false, true);
    else this.rex(1);
    this.db(0x8D);
    this.db(this.modrm(0, ri, 5));
    this.ripDisp32('global', name);
  }
  leaRdata(reg, offset) {
    const ri = regIdx(reg);
    if (ri >= 8) this.rex(1, false, false, true);
    else this.rex(1);
    this.db(0x8D);
    this.db(this.modrm(0, ri, 5));
    this.ripDisp32('rdata', offset);
  }

  callImport(dll, fn) {
    const tag = `${dll}!${fn}`;
    this.usedImports.add(tag);
    const thunk = `imp_${tag.replace(/[^A-Za-z0-9]/g, '_')}`;
    this.call(thunk);
  }

  jmpQwordRip(dll, fn) {
    const tag = `${dll}!${fn}`;
    this.usedImports.add(tag);
    this.db(0xFF); this.db(0x25);
    this.ripDisp32('iat', tag);
  }

  emitImportThunks() {
    if (this.usedImports.size === 0) return;
    this.align(16);
    for (const tag of [...this.usedImports].sort()) {
      const safe = `imp_${tag.replace(/[^A-Za-z0-9]/g, '_')}`;
      this.label(safe);
      this.jmpQwordRip(...tag.split('!'));
    }
  }

  rex(w, r, x, b) {
    let v = 0x40;
    if (w) v |= 8;
    if (r) v |= 4;
    if (x) v |= 2;
    if (b) v |= 1;
    if (v !== 0x40) this.db(v);
    return v;
  }
  modrm(mod, reg, rm) { return ((mod & 3) << 6) | ((reg & 7) << 3) | (rm & 7); }
  sib(scale, idx, base) { return ((scaleLog(scale) & 3) << 6) | ((idx & 7) << 3) | (base & 7); }

  memNoRex(reg, base, { disp = 0, index = null, scale = 1 } = {}) {
    const ri = regIdx(reg), bi = regIdx(base);
    const ii = index == null ? null : regIdx(index);
    if (ii == null && bi !== 4) {
      if (disp === 0 && bi !== 5) {
        this.db(this.modrm(0, ri, bi));
      } else if (disp >= -128 && disp <= 127) {
        this.db(this.modrm(1, ri, bi)); this.db(disp & 0xFF);
      } else {
        this.db(this.modrm(2, ri, bi)); this.dd(disp);
      }
      return;
    }
    const useBase = !(bi === 5 && disp === 0 && ii != null);
    const idxForSib = ii == null ? 4 : ii;
    const baseForSib = useBase ? bi : 5;
    this.db(this.modrm(ii == null ? (disp === 0 && bi !== 5 ? 0 : (disp >= -128 && disp <= 127 ? 1 : 2)) : 2, ri, 4));
    this.db(this.sib(scale, idxForSib, baseForSib));
    if (!useBase) {
      this.dd(disp);
    } else if (disp >= -128 && disp <= 127) {
      this.db(disp & 0xFF);
    } else {
      this.dd(disp);
    }
  }

  rexFor(opSize64, reg, index, base) {
    const w = !!opSize64;
    const r = reg != null && regIdx(reg) >= 8;
    const x = index != null && regIdx(index) >= 8;
    const b = base != null && regIdx(base) >= 8;
    if (!w && !r && !x && !b) return;
    let v = 0x40;
    if (w) v |= 8;
    if (r) v |= 4;
    if (x) v |= 2;
    if (b) v |= 1;
    this.db(v);
  }

  mov_rr(dst, src) {
    const d = regIdx(dst), s = regIdx(src);
    this.rex(1, s >= 8, 0, d >= 8);
    this.db(0x89); this.db(this.modrm(3, s, d));
  }
  mov_imm(dst, imm64) {
    const d = regIdx(dst);
    let big;
    if (typeof imm64 === 'bigint') big = imm64;
    else {
      if (!Number.isSafeInteger(imm64)) {
        throw new Error(`mov_imm: unsafe number ${imm64} — pass a BigInt instead`);
      }
      big = BigInt(imm64);
      if (big < 0n) big += 1n << 64n;   // normalize to unsigned bit pattern
    }
    const signed = big >= (1n << 63n) ? big - (1n << 64n) : big;
    if (signed >= -2147483648n && signed <= 2147483647n) {
      this.rex(1, 0, 0, d >= 8);
      this.db(0xC7); this.db(this.modrm(3, 0, d)); this.dd(Number(signed));
    } else {
      this.rex(1, 0, 0, d >= 8);
      this.db(0xB8 + (d & 7)); this.dq(signed < 0n ? signed + (1n << 64n) : signed);
    }
  }
  mov_rm(dstReg, base, memOpts) { this.load64(dstReg, base, memOpts); }
  load64(dstReg, base, opts) {
    const d = regIdx(dstReg);
    const idx = opts && opts.index != null ? opts.index : null;
    this.rexFor(1, dstReg, idx, base);
    this.db(0x8B);
    this.memNoRex(d, base, opts);
  }
  store64(srcReg, base, opts) {
    const s = regIdx(srcReg);
    const idx = opts && opts.index != null ? opts.index : null;
    this.rexFor(1, srcReg, idx, base);
    this.db(0x89);
    this.memNoRex(s, base, opts);
  }
  store_imm32(base, opts, imm32) {
    const idx = opts && opts.index != null ? opts.index : null;
    this.rexFor(1, null, idx, base);
    this.db(0xC7);
    this.memNoRex(0, base, opts);
    this.dd(imm32 | 0);
  }
  lea(dstReg, base, opts) {
    const d = regIdx(dstReg);
    const idx = opts && opts.index != null ? opts.index : null;
    this.rexFor(1, dstReg, idx, base);
    this.db(0x8D);
    this.memNoRex(d, base, opts);
  }

  binop(opCode, dstReg, srcReg) {
    const d = regIdx(dstReg), s = regIdx(srcReg);
    this.rex(1, s >= 8, 0, d >= 8);
    this.db(opCode); this.db(this.modrm(3, s, d));
  }
  add_rr(d, s) { this.binop(0x01, d, s); }
  sub_rr(d, s) { this.binop(0x29, d, s); }
  and_rr(d, s) { this.binop(0x21, d, s); }
  and_imm(reg, imm8) {
    const r = regIdx(reg);
    this.rex(1, 0, 0, r >= 8);
    this.db(0x83); this.db(this.modrm(3, 4, r)); this.db(imm8 & 0xFF);
  }
  neg_r(reg) {
    const r = regIdx(reg);
    this.rex(1, 0, 0, r >= 8);
    this.db(0xF7); this.db(this.modrm(3, 3, r));
  }
  movq_xmm_from_gpr(xmm, gpr) {
    this.db(0x66);
    this.rex(1, regIdx(xmm) >= 8, 0, regIdx(gpr) >= 8);
    this.db(0x0F); this.db(0x6E); this.db(this.modrm(3, regIdx(xmm), regIdx(gpr)));
  }
  movq_gpr_from_xmm(gpr, xmm) {
    this.db(0x66);
    this.rex(1, regIdx(xmm) >= 8, 0, regIdx(gpr) >= 8);
    this.db(0x0F); this.db(0x7E); this.db(this.modrm(3, regIdx(gpr), regIdx(xmm)));
  }
  and_rsp_align() {
    this.rex(1);
    this.db(0x83); this.db(this.modrm(3, 4, 4)); this.db(0xF0);
  }
  or_rr(d, s) { this.binop(0x09, d, s); }
  xor_rr(d, s) { this.binop(0x31, d, s); }
  cmp_rr(a, b) { this.binop(0x39, a, b); }
  test_rr(a, b) { this.binop(0x85, a, b); }
  movzx8(dst, src) {
    const d = regIdx(dst), s = regIdx(src);
    this.db(0x0F); this.rex(1, d >= 8, 0, s >= 8); this.db(0xB6); this.db(this.modrm(3, d, s));
  }
  imul_rr(dst, src) {
    const d = regIdx(dst), s = regIdx(src);
    this.rex(1, s >= 8, 0, d >= 8);
    this.db(0x0F); this.db(0xAF); this.db(this.modrm(3, d, s));
  }
  cqo() { this.rex(1, 0, 0, 0); this.db(0x99); }
  idiv_r(r) {
    const i = regIdx(r);
    this.rex(1, 0, 0, i >= 8);
    this.db(0xF7); this.db(this.modrm(3, 7, i));
  }
  shift_left(r, cl) {
    void cl;
    const i = regIdx(r);
    this.rex(1, 0, 0, i >= 8);
    this.db(0xD3); this.db(this.modrm(3, 4, i));
  }
  sar_r(r) {
    const i = regIdx(r);
    this.rex(1, 0, 0, i >= 8);
    this.db(0xD3); this.db(this.modrm(3, 7, i));
  }
  add_imm(dst, imm32) {
    const d = regIdx(dst);
    this.rex(1, 0, 0, d >= 8);
    this.db(0x81); this.db(this.modrm(3, 0, d)); this.dd(imm32 | 0);
  }
  sub_imm(dst, imm32) {
    const d = regIdx(dst);
    this.rex(1, 0, 0, d >= 8);
    this.db(0x81); this.db(this.modrm(3, 5, d)); this.dd(imm32 | 0);
  }
  cmp_imm(r, imm32) {
    const i = regIdx(r);
    this.rex(1, 0, 0, i >= 8);
    this.db(0x81); this.db(this.modrm(3, 7, i)); this.dd(imm32 | 0);
  }
  push(r) { const i = regIdx(r); if (i >= 8) this.db(0x41); this.db(0x50 + (i & 7)); }
  pop(r) { const i = regIdx(r); if (i >= 8) this.db(0x41); this.db(0x58 + (i & 7)); }
  ret() { this.db(0xC3); }
  nop() { this.db(0x90); }

  setcc(cc, r) {
    const i = regIdx(r);
    this.db(0x0F); this.db(0x90 + CC[cc]);
    this.db(this.modrm(3, 0, i));
  }

  jcc(cc, targetLabel, nearOnly = false) {
    void nearOnly;
    this.db(0x0F); this.db(0x80 + CC[cc]); this.emitRel32(targetLabel);
  }
  jmp(targetLabel) { this.db(0xE9); this.emitRel32(targetLabel); }
  call(labelName) { this.db(0xE8); this.emitRel32(labelName); }

  xmm_movsd_rr(dst, src) { this.db(0xF2); this.rex(1, regIdx(dst) >= 8, 0, regIdx(src) >= 8); this.db(0x0F); this.db(0x10); this.db(this.modrm(3, regIdx(dst), regIdx(src))); }
  xmm_loadsd(dst, base, opts) {
    const d = regIdx(dst);
    const idx = opts && opts.index != null ? opts.index : null;
    this.db(0xF2);
    this.rexFor(1, dst, idx, base);
    this.db(0x0F); this.db(0x10);
    this.memNoRex(d, base, opts);
  }
  xmm_storesd(src, base, opts) {
    const s = regIdx(src);
    const idx = opts && opts.index != null ? opts.index : null;
    this.db(0xF2);
    this.rexFor(1, src, idx, base);
    this.db(0x0F); this.db(0x11);
    this.memNoRex(s, base, opts);
  }
  xmm_fbinop(op, dst, src) {
    const code = { addsd: [0xF2, 0x58], subsd: [0xF2, 0x5C], mulsd: [0xF2, 0x59], divsd: [0xF2, 0x5E] }[op];
    this.db(code[0]);
    this.rex(1, regIdx(dst) >= 8, 0, regIdx(src) >= 8);
    this.db(0x0F); this.db(code[1]);
    this.db(this.modrm(3, regIdx(dst), regIdx(src)));
  }
  xmm_ucomisd(a, b) {
    this.db(0x66);
    this.rex(1, regIdx(a) >= 8, 0, regIdx(b) >= 8);
    this.db(0x0F); this.db(0x2E); this.db(this.modrm(3, regIdx(a), regIdx(b)));
  }
  cvtsi2sd(xmmDst, intSrc) {
    const d = regIdx(xmmDst), s = regIdx(intSrc);
    this.db(0xF2);
    this.rex(1, d >= 8, 0, s >= 8);
    this.db(0x0F); this.db(0x2A); this.db(this.modrm(3, d, s));
  }
  cvttsd2si(intDst, xmmSrc) {
    const d = regIdx(intDst), s = regIdx(xmmSrc);
    this.db(0xF2);
    this.rex(1, d >= 8, 0, s >= 8);
    this.db(0x0F); this.db(0x2C); this.db(this.modrm(3, d, s));
  }

  resolve() {
    const out = new Uint8Array(this.text.length);
    for (let i = 0; i < this.text.length; i++) out[i] = this.text[i] & 0xFF;
    for (const f of this.fixups) {
      const target = this.labels.get(f.targetLabel);
      if (target === undefined) throw new Error(`unresolved label ${f.targetLabel}`);
      const value = target - (f.at + 4);
      for (let i = 0; i < 4; i++) out[f.at + i] = Number((BigInt(value) >> BigInt(i * 8)) & 0xFFn);
    }
    return out;
  }
}

function scaleLog(s) {
  switch (s) { case 1: return 0; case 2: return 1; case 4: return 2; case 8: return 3; default: throw new Error('bad scale'); }
}
