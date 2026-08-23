export class ByteWriter {
  constructor() { this.b = []; }
  w8(v) { this.b.push(v & 0xFF); return this; }
  w16(v) { this.w8(v); this.w8(v >>> 8); return this; }
  w32(v) { for (let i = 0; i < 4; i++) this.w8((v >>> (i * 8)) & 0xFF); return this; }
  w64(big) {
    const bi = typeof big === 'bigint' ? big : BigInt(big);
    for (let i = 0; i < 8; i++) this.w8(Number((bi >> BigInt(i * 8)) & 0xFFn));
    return this;
  }
  ascii(s) { for (let i = 0; i < s.length; i++) this.w8(s.charCodeAt(i)); return this; }
  zeros(n) { for (let i = 0; i < n; i++) this.w8(0); return this; }
  padTo(n) { while (this.b.length < n) this.w8(0); return this; }
}

export function alignUp(v, a) { return Math.ceil(v / a) * a; }

export function u32bytes(v) {
  return [(v >>> 0) & 0xFF, ((v >>> 0) >> 8) & 0xFF, ((v >>> 0) >> 16) & 0xFF, ((v >>> 0) >> 24) & 0xFF];
}
