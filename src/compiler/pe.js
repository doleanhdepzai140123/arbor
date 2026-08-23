import { ByteWriter, alignUp } from './bytes.js';

const MACHINE_AMD64 = 0x8664;
const OPT_PE32PLUS = 0x20B;
const SUBSYSTEM_CONSOLE = 3;
const SEC_ALIGN = 0x1000;
const FILE_ALIGN = 0x1000;

const CHAR_TEXT = 0x60000020;
const CHAR_RDATA = 0x40000040;
const CHAR_DATA = 0xC0000040;

export const IMAGE_BASE = 0x140000000n;

export class PEImage {
  constructor({ forceImportDir = false } = {}) {
    this.forceImportDir = forceImportDir;
    this.textBytes = null;
    this.entryTextOff = 0;
    this.rdataBytes = [];
    this.dataBytes = [];
    this.dataOffsets = new Map();
    this.importDlls = new Map();
    this.extRefs = [];
    this.iatVAs = new Map();
    this.globalVAs = new Map();
  }

  addImport(dll, fn) {
    if (!this.importDlls.has(dll)) this.importDlls.set(dll, new Set());
    this.importDlls.get(dll).add(fn);
  }

  addGlobal(name, size) {
    if (!this.dataOffsets.has(name)) {
      this.dataOffsets.set(name, this.dataBytes.length);
      for (let i = 0; i < size; i++) this.dataBytes.push(0);
    }
    return this.dataOffsets.get(name);
  }

  globalVA(name) {
    const off = this.dataOffsets.get(name);
    if (off === undefined) throw new Error(`no such global: ${name}`);
    return IMAGE_BASE + BigInt(this.dataRVA + off);
  }

  rdataVA(offset) {
    return IMAGE_BASE + BigInt(this.rdataRVA + offset);
  }

  addExtRef(kind, tag) {
    const idx = this.extRefs.length;
    this.extRefs.push({ kind, tag, at: null });
    return idx;
  }

  layout() {
    this.textRVA = SEC_ALIGN;
    this.textRawPtr = SEC_ALIGN;
    this.textRawSize = alignUp(this.textBytes.length, FILE_ALIGN);

    let cursor = this.textRVA + alignUp(Math.max(this.textBytes.length, 1), SEC_ALIGN);
    this.rdataRVA = cursor;
    this.rdataRawPtr = cursor;
    this.rdataVirtAligned = alignUp(Math.max(this.rdataBytes.length, 1), SEC_ALIGN);
    cursor += this.rdataVirtAligned;

    this.dataRVA = cursor;
    this.dataRawPtr = cursor;
    this.dataVirtAligned = alignUp(Math.max(this.dataBytes.length, 1), SEC_ALIGN);
    cursor += this.dataVirtAligned;

    this.idataRVA = cursor;
    this.idataRawPtr = cursor;

    for (const [name, off] of this.dataOffsets) {
      this.globalVAs.set(name, IMAGE_BASE + BigInt(this.dataRVA + off));
    }

    const plan = this.planIdata();
    this.idataSize = plan.totalSize;
    cursor += alignUp(Math.max(plan.totalSize, 1), SEC_ALIGN);

    this.sizeOfImage = cursor;

    for (const ref of this.extRefs) {
      if (ref.kind === 'global') {
        ref.va = IMAGE_BASE + BigInt(this.dataRVA + this.dataOffsets.get(ref.tag));
      } else if (ref.kind === 'rdata') {
        ref.va = IMAGE_BASE + BigInt(this.rdataRVA + ref.tag);
      } else if (ref.kind === 'iat') {
        ref.va = plan.iatVAs.get(ref.tag);
      }
      if (ref.va === undefined) throw new Error(`unresolved external ref ${ref.kind}:${ref.tag}`);
    }
  }

  planIdata() {
    const dlls = [...this.importDlls.keys()].sort();
    const descCount = dlls.length + 1;
    let cursor = descCount * 20;
    const intOffsets = new Map();
    const iatOffsets = new Map();
    const nameOffsets = new Map();
    const dllNameOffsets = new Map();
    const realDllName = (pseudo) => pseudo.split('#')[0];

    for (const dll of dlls) {
      intOffsets.set(dll, cursor);
      cursor += (this.importDlls.get(dll).size + 1) * 8;
    }
    for (const dll of dlls) {
      iatOffsets.set(dll, cursor);
      cursor += (this.importDlls.get(dll).size + 1) * 8;
    }

    for (const dll of dlls) {
      const realName = realDllName(dll);
      dllNameOffsets.set(dll, cursor);
      cursor += realName.length + 1;
      for (const fn of this.importDlls.get(dll)) {
        nameOffsets.set(`${dll}!${fn}`, cursor + 2);
        cursor += 2 + fn.length + 1;
        if (cursor % 2 !== 0) cursor++;
      }
    }

    const totalSize = cursor;
    const iatVAs = new Map();
    for (const dll of dlls) {
      let i = 0;
      for (const fn of this.importDlls.get(dll)) {
        iatVAs.set(`${dll}!${fn}`, IMAGE_BASE + BigInt(this.idataRVA + iatOffsets.get(dll) + i * 8));
        i++;
      }
    }
    return { dlls, intOffsets, iatOffsets, nameOffsets, dllNameOffsets, realDllName, iatVAs, totalSize };
  }

  finish() {
    const plan = this.planIdata();
    const buf = new Uint8Array(Math.max(plan.totalSize, 1));
    const put32 = (off, v) => {
      buf[off] = v & 0xFF; buf[off + 1] = (v >>> 8) & 0xFF;
      buf[off + 2] = (v >>> 16) & 0xFF; buf[off + 3] = (v >>> 24) & 0xFF;
    };
    const putStr = (off, s) => {
      for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
      buf[off + s.length] = 0;
    };

    const { dlls } = plan;
    let d = 0;
    for (; d < dlls.length; d++) {
      const dll = dlls[d];
      const base = d * 20;
      put32(base, this.idataRVA + plan.intOffsets.get(dll));
      put32(base + 12, this.idataRVA + plan.dllNameOffsets.get(dll));
      put32(base + 16, this.idataRVA + plan.iatOffsets.get(dll));
    }

    for (const dll of dlls) {
      const names = [...this.importDlls.get(dll)];
      const intBase = plan.intOffsets.get(dll);
      const iatBase = plan.iatOffsets.get(dll);
      names.forEach((fn, i) => {
        const hintRva = this.idataRVA + plan.nameOffsets.get(`${dll}!${fn}`) - 2;
        put32(intBase + i * 4, hintRva);
        put32(iatBase + i * 4, hintRva);
      });
    }

    for (const dll of dlls) {
      putStr(plan.dllNameOffsets.get(dll), plan.realDllName(dll));
      for (const fn of this.importDlls.get(dll)) {
        const off = plan.nameOffsets.get(`${dll}!${fn}`) - 2;
        buf[off] = 0; buf[off + 1] = 0;
        putStr(off + 2, fn);
      }
    }

    const idata = { b: [...buf] };

    const hdr = new ByteWriter();
    hdr.ascii('MZ');
    hdr.zeros(0x3C - 2);
    hdr.w32(0x80);
    hdr.padTo(0x80);
    hdr.ascii('PE\0\0');
    hdr.w16(MACHINE_AMD64);
    hdr.w16(4);
    hdr.w32(0); hdr.w32(0); hdr.w32(0);
    hdr.w16(240);
    hdr.w16(0x0022);

    hdr.w16(OPT_PE32PLUS);
    hdr.w8(8); hdr.w8(0);
    hdr.w32(this.textRawSize);
    hdr.w32(alignUp(this.rdataBytes.length, FILE_ALIGN)
      + alignUp(this.dataBytes.length, FILE_ALIGN)
      + alignUp(idata.b.length, FILE_ALIGN));
    hdr.w32(0);
    hdr.w32(this.textRVA + this.entryTextOff);
    hdr.w32(this.textRVA);
    hdr.w64(IMAGE_BASE);
    hdr.w32(SEC_ALIGN); hdr.w32(FILE_ALIGN);
    hdr.w16(6); hdr.w16(0);
    hdr.w16(0); hdr.w16(0);
    hdr.w16(6); hdr.w16(0);
    hdr.w32(0);
    hdr.w32(this.sizeOfImage);
    hdr.w32(SEC_ALIGN);
    hdr.w32(0);
    hdr.w16(SUBSYSTEM_CONSOLE); hdr.w16(0);
    hdr.w64(0x100000n); hdr.w64(0x10000n);
    hdr.w64(0x100000n); hdr.w64(0x10000n);
    hdr.w32(0);
    hdr.w32(16);
    if (this.importDlls.size > 0) {
      const plan0 = this.planIdata();
      hdr.w32(0); hdr.w32(0);
      hdr.w32(this.idataRVA); hdr.w32(plan0.totalSize);
    } else if (this.forceImportDir) {
      hdr.w32(this.idataRVA); hdr.w32(20);
      hdr.w32(0); hdr.w32(0);
    } else {
      hdr.w32(0); hdr.w32(0);
      hdr.w32(0); hdr.w32(0);
    }
    for (let d = 2; d < 16; d++) { hdr.w32(0); hdr.w32(0); }

    const secs = [
      ['.text', this.textBytes, CHAR_TEXT],
      ['.rdata', this.rdataBytes.length ? this.rdataBytes : [0], CHAR_RDATA],
      ['.data', this.dataBytes.length ? this.dataBytes : [0], CHAR_DATA],
      ['.idata', Uint8Array.from(idata.b.length ? idata.b : [0]), CHAR_DATA],
    ];
    void plan;
    const rawSizes = new Map(secs.map(([nm], i) => {
      const arr = secs[i][1];
      return [nm, alignUp(arr.length, FILE_ALIGN)];
    }));
    for (const [nm] of secs) {
      for (let i = 0; i < 8; i++) hdr.w8(i < nm.length ? nm.charCodeAt(i) : 0);
      const arr = secs.find(s => s[0] === nm)[1];
      hdr.w32(arr.length);
      if (nm === '.text') { hdr.w32(this.textRVA); hdr.w32(rawSizes.get(nm)); hdr.w32(this.textRawPtr); }
      else if (nm === '.rdata') { hdr.w32(this.rdataRVA); hdr.w32(rawSizes.get(nm)); hdr.w32(this.rdataRawPtr); }
      else if (nm === '.data') { hdr.w32(this.dataRVA); hdr.w32(rawSizes.get(nm)); hdr.w32(this.dataRawPtr); }
      else { hdr.w32(this.idataRVA); hdr.w32(rawSizes.get(nm)); hdr.w32(this.idataRawPtr); }
      hdr.w32(0); hdr.w32(0); hdr.w16(0); hdr.w16(0);
      const chars = { '.text': CHAR_TEXT, '.rdata': CHAR_RDATA, '.data': CHAR_DATA, '.idata': CHAR_DATA }[nm];
      hdr.w32(chars);
    }
    hdr.padTo(SEC_ALIGN);

    const file = new ByteWriter();
    file.b = hdr.b.slice();
    for (const [nm] of secs) {
      const arr = secs.find(s => s[0] === nm)[1];
      const rawPtr = nm === '.text' ? this.textRawPtr
        : nm === '.rdata' ? this.rdataRawPtr
          : nm === '.data' ? this.dataRawPtr : this.idataRawPtr;
      while (file.b.length < rawPtr) file.w8(0);
      for (const b of arr) file.w8(b);
      const padded = rawSizes.get(nm);
      while (file.b.length < rawPtr + padded) file.w8(0);
    }

    const out = Uint8Array.from(file.b);
    const textBaseFileOff = this.textRawPtr;
    for (const ref of this.extRefs) {
      const nextInstrVA = IMAGE_BASE + BigInt(this.textRVA + ref.at + 4);
      const disp = Number(ref.va - nextInstrVA);
      const at = textBaseFileOff + ref.at;
      for (let i = 0; i < 4; i++) out[at + i] = (disp >>> (i * 8)) & 0xFF;
    }
    return out;
  }
}

void MACHINE_AMD64;
