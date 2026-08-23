export class Span {
  constructor(file, start, end) {
    this.file = file;
    this.start = start;
    this.end = end;
  }
  static union(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.file !== b.file) return a;
    return new Span(a.file, Math.min(a.start, b.start), Math.max(a.end, b.end));
  }
}

const ANSI = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code, s) {
  return ANSI ? `\x1b[${code}m${s}\x1b[0m` : s;
}

function lineCol(src, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') { line++; col = 1; } else col++;
  }
  return { line, col };
}

export class ArborError extends Error {
  constructor({ code, message, span, hint, notes }) {
    super(message);
    this.code = code;
    this.span = span;
    this.hint = hint;
    this.notes = notes || [];
    this.arbor = true;
  }
}

export function renderError(err, sources) {
  const out = [];
  out.push(`${paint('1;31', `error[${err.code}]`)}: ${err.message}`);
  if (err.span) {
    appendSnippet(out, sources, err.span, '1;33', null);
  }
  for (const n of err.notes || []) {
    out.push(`  ${paint('2;36', 'note')}: ${n}`);
  }
  if (err.prevSpan && (err.prevSpan.file !== (err.span && err.span.file) || true)) {
    appendSnippet(out, sources, err.prevSpan, '2;35', 'previous event');
  }
  if (err.hint) out.push(`  ${paint('2;32', 'hint')}: ${err.hint}`);
  return out.join('\n');
}

function appendSnippet(out, sources, span, caretColor, tag) {
  const src = sources.get(span.file);
  if (!src) return;
  const { line, col } = lineCol(src, span.start);
  const lines = src.split('\n');
  const lineText = lines[line - 1] ?? '';
  const width = String(line).length;
  const prefix = tag ? `  ${tag} ` : '';
  out.push(`${' '.repeat(prefix.length + 2)}${paint('2', `${span.file}:${line}:${col}`)}`);
  out.push(`${prefix} ${paint('2;36', String(line))} ${paint('2', '|')} ${lineText}`);
  const caretLen = Math.max(1, Math.min(span.end, src.length) - span.start);
  out.push(`${prefix} ${' '.repeat(width)} ${paint('2', '|')} ${' '.repeat(col - 1)}${paint(caretColor, '^'.repeat(caretLen))}`);
}
