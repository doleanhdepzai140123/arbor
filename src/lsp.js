// ARBOR Language Server — LSP 3.17 over stdio
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from './parser.js';
import { checkProgram } from './checker.js';

const KEYWORDS = ['fn', 'let', 'var', 'const', 'if', 'else', 'while', 'for', 'in',
  'match', 'return', 'break', 'continue', 'region', 'spawn', 'use', 'struct',
  'enum', 'true', 'false', 'and', 'or', 'not', 'in', 'inout'];
const BUILTIN_METHODS = ['len', 'push', 'pop', 'get', 'set', 'take', 'clone', 'reverse',
  'contains', 'is_empty', 'first', 'last', 'sort_by', 'insert', 'remove', 'keys',
  'contains_key', 'to_array', 'alive', 'unwrap', 'expect', 'is_some', 'is_none',
  'is_ok', 'is_err', 'unwrap_or', 'to_float', 'to_int', 'to_str', 'abs', 'sqrt',
  'floor', 'ceil', 'round', 'upper', 'lower', 'trim', 'split', 'chars', 'repeat'];

class LspDoc {
  constructor(uri, text, version) {
    this.uri = uri;
    this.text = text;
    this.version = version;
    this.diagnostics = [];
  }
  recheck() {
    this.diagnostics = [];
    try {
      const prog = parse(this.text, this.uri);
      const result = checkProgram(prog, this.uri);
      for (const e of result.errors) {
        this.diagnostics.push(toDiagnostic(e, 1));
      }
      for (const w of result.warnings) {
        this.diagnostics.push(toDiagnostic(w, 2));
      }
    } catch (e) {
      if (e.span) this.diagnostics.push(toDiagnostic(e, 1));
    }
  }
}

function toDiagnostic(e, severity) {
  const src = e.span?.file ?? '';
  let line = 0, col = 0, endCol = 1;
  try {
    const text = globalThis.__arborDocs?.get(src);
    if (text && e.span) {
      const before = text.slice(0, e.span.start);
      const lines = before.split('\n');
      line = lines.length - 1;
      col = lines[lines.length - 1].length;
      endCol = col + Math.max(1, e.span.end - e.span.start);
    }
  } catch (_) {}
  return {
    severity,
    range: {
      start: { line, character: col },
      end: { line, character: endCol },
    },
    message: `[${e.code}] ${e.message}`,
    source: 'arbor',
    code: e.code,
  };
}

class Server {
  constructor() {
    this.docs = new Map();
    this.buffer = Buffer.alloc(0);
  }

  start() {
    process.stdin.on('data', chunk => this.onData(chunk));
    process.stdin.on('end', () => process.exit(0));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { this.buffer = Buffer.alloc(0); return; }
      const len = parseInt(match[1], 10);
      const total = headerEnd + 4 + len;
      if (this.buffer.length < total) break;
      const body = this.buffer.slice(headerEnd + 4, total).toString('utf8');
      this.buffer = this.buffer.slice(total);
      try {
        const msg = JSON.parse(body);
        this.dispatch(msg);
      } catch (_) { /* malformed JSON — skip */ }
    }
  }

  send(msg) {
    const body = JSON.stringify(msg);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  reply(id, result) { this.send({ jsonrpc: '2.0', id, result }); }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }

  publishDiagnostics(uri) {
    const doc = this.docs.get(uri);
    if (!doc) return;
    globalThis.__arborDocs = globalThis.__arborDocs || new Map();
    globalThis.__arborDocs.set(uri, doc.text);
    this.notify('textDocument/publishDiagnostics', {
      uri,
      diagnostics: doc.diagnostics,
    });
  }

  dispatch(msg) {
    if (msg.id !== undefined && msg.method) return this.handleRequest(msg);
    if (msg.method === 'textDocument/didOpen') {
      const p = msg.params.textDocument;
      const doc = new LspDoc(p.uri, p.text, p.version);
      doc.recheck();
      this.docs.set(p.uri, doc);
      this.publishDiagnostics(p.uri);
    } else if (msg.method === 'textDocument/didChange') {
      const p = msg.params;
      const doc = this.docs.get(p.textDocument.uri);
      if (doc) {
        for (const change of p.contentChanges) {
          if (change.range) continue; // incremental unsupported — full text only
          doc.text = change.text;
        }
        doc.version = p.textDocument.version;
        doc.recheck();
        this.publishDiagnostics(p.textDocument.uri);
      }
    } else if (msg.method === 'textDocument/didClose') {
      this.docs.delete(msg.params.textDocument.uri);
    }
  }

  handleRequest(msg) {
    switch (msg.method) {
      case 'initialize':
        this.reply(msg.id, {
          capabilities: {
            textDocumentSync: 1,
            completionProvider: { triggerCharacters: ['.', ' '] },
            hoverProvider: true,
            documentSymbolProvider: true,
            definitionProvider: false,
          },
          serverInfo: { name: 'arbor-lsp', version: '0.2.1' },
        });
        break;
      case 'shutdown':
        this.reply(msg.id, null);
        break;
      case 'exit':
        process.exit(0);
        break;
      case 'textDocument/completion':
        this.reply(msg.id, this.completion(msg.params));
        break;
      case 'textDocument/hover':
        this.reply(msg.id, this.hover(msg.params));
        break;
      case 'textDocument/documentSymbol':
        this.reply(msg.id, this.documentSymbols(msg.params));
        break;
      default:
        this.reply(msg.id, null);
    }
  }

  completion(params) {
    const items = [];
    for (const kw of KEYWORDS) {
      items.push({ label: kw, kind: 14, detail: 'keyword' });
    }
    for (const m of BUILTIN_METHODS) {
      items.push({ label: m, kind: 2, detail: 'builtin method' });
    }
    for (const t of ['Int', 'Float', 'Bool', 'Str', 'Array', 'Map', 'Set', 'Table', 'Handle', 'Option', 'Result']) {
      items.push({ label: t, kind: 7, detail: 'builtin type' });
    }
    const uri = params.textDocument?.uri;
    const doc = uri && this.docs.get(uri);
    if (doc) {
      try {
        const prog = parse(doc.text, uri);
        for (const d of prog.decls) {
          if (d.k === 'fn') items.push({ label: d.name, kind: 3, detail: 'function' });
          else if (d.k === 'struct') items.push({ label: d.name, kind: 22, detail: 'struct' });
          else if (d.k === 'enum') items.push({ label: d.name, kind: 10, detail: 'enum' });
          else if (d.k === 'const') items.push({ label: d.name, kind: 21, detail: 'constant' });
        }
      } catch (_) { /* parse errors — keywords only */ }
    }
    return { isIncomplete: false, items };
  }

  hover(params) {
    const uri = params.textDocument.uri;
    const doc = this.docs.get(uri);
    if (!doc) return null;
    const pos = params.position;
    const lines = doc.text.split('\n');
    const lineText = lines[pos.line] ?? '';
    const start = lineText.lastIndexOf(' ', pos.character) + 1;
    const end = lineText.indexOf(' ', pos.character) === -1
      ? lineText.length
      : lineText.indexOf(' ', pos.character);
    const word = lineText.slice(start, end).replace(/[^A-Za-z0-9_.]/g, '');
    if (!word) return null;

    try {
      const prog = parse(doc.text, uri);
      const result = checkProgram(prog, uri);
      void result;
      for (const d of prog.decls) {
        if (d.k === 'fn' && d.name === word) {
          const sig = d.params.map(p => `${p.name}: ${p.ty?.name ?? ''}`).join(', ');
          return {
            contents: {
              kind: 'markdown',
              value: `\`\`\`\`fn ${d.name}(${sig})\`\`\`` + (d.docs ? `\n\n${d.docs}` : ''),
            },
          };
        }
        if (d.k === 'struct' && d.name === word) {
          return { contents: { kind: 'markdown', value: `\`\`\`\`struct ${d.name}\`\`\`` } };
        }
        if (d.k === 'enum' && d.name === word) {
          return { contents: { kind: 'markdown', value: `\`\`\`\`enum ${d.name}\`\`\`` } };
        }
      }
    } catch (_) { /* errors — no hover */ }
    if (KEYWORDS.includes(word)) {
      return { contents: { kind: 'plaintext', value: `keyword: ${word}` } };
    }
    return null;
  }

  documentSymbols(params) {
    const uri = params.textDocument.uri;
    const doc = this.docs.get(uri);
    if (!doc) return [];
    const symbols = [];
    try {
      const prog = parse(doc.text, uri);
      const lines = doc.text.split('\n');
      for (const d of prog.decls) {
        if (!d.span) continue;
        let line = 0;
        try {
          const before = doc.text.slice(0, d.span.start);
          line = before.split('\n').length - 1;
        } catch (_) {}
        void lines;
        const kind = d.k === 'fn' ? 12 : d.k === 'struct' ? 23 : d.k === 'enum' ? 10 : d.k === 'const' ? 21 : 0;
        if (kind) symbols.push({ name: d.name, kind, range: mkRange(line), selectionRange: mkRange(line) });
      }
    } catch (_) {}
    return symbols;
  }
}

function mkRange(line) {
  return { start: { line, character: 0 }, end: { line: line + 1, character: 0 } };
}

export { Server };
