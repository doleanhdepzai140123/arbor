# Changelog

## v0.4.1 — Match v2, closures verified, and `arborc`

### Match everywhere (VM + native, identical output)
- `match` now works in **expression position** (as function tail, `let`
  initializer, call argument) — the C# back end previously discarded the
  value of a tail match.
- **Guards**: `Pattern if cond => body` — a failing guard leaves the arm
  unmatched for later arms; bindings are available to the guard.
- Variant patterns bind payloads (`Circle(r) => ...`) and literal payload
  patterns match (`Circle(0) => ...`).
- Zero-payload variants usable as plain values: `Shape.Point`.
- Fixed: enum constructors `Shape.Circle(4)` compiled to UNIT natively.

### Plain indexing fixed on native
`xs[i]` yields the element directly with R0002/R0008 traps (was wrongly
Option-wrapped, breaking `.field` chains). `.get(i)` remains the Option form.

### Closures — verified full stack
Anonymous `fn` literals, `fn(T...) -> R` types, higher-order functions and
variable capture work identically in the VM and natively.

### `std.process.exec(cmd, args) -> Result[Str]`
Run external processes from ARBOR (VM + native).

### `arborc` — the compiler as a product
- `npm run build:arborc` produces **arborc.exe**: a standalone native ARBOR
  compiler written in ARBOR (self-hosted, no Node at run time).
- `arborc <input.ab> -o <out.exe> -exe` compiles straight to an executable;
  `-csc <path>` overrides the C# compiler. `arborc.cmd` shim included.
- Known limitation: the *reference* back end cannot yet compile arborsc's
  own source (typed-field operators); the canonical bootstrap path is the
  self-emitted pipeline (`npm run build:arborc`), which is fully verified.

## v0.4.0 — Full self-hosting (Thompson bootstrap)

### The compiler is now written in ARBOR
`self/arborsc.ab` is a complete ARBOR→C# compiler written in ARBOR itself —
lexer, parser, semantic pass and code generator (~1,900 lines of ARBOR across
five files). The bootstrap chain, verified by `tests/bootstrap.mjs`:

1. **Seed** — the reference toolchain compiles `arborsc.ab` into a native
   `arborsc_seed.exe`.
2. **Self** — the seed re-compiles the compiler's own source; output C# is
   byte-for-byte deterministic.
3. **Parity** — both native compilers compile programs whose executables
   match the reference VM's output exactly.

This is the same fixed-point property Rust and Go reached: from here on,
the reference VM only needs to build the seed once; every later compiler
can be built by ARBOR itself.

### Components (all written in ARBOR)
- `self/self_lexer.ab` — lexer (token-parity with the reference lexer)
- `self/parser.ab` — recursive-descent parser to a tagged-tree IR:
  functions/methods/structs/enums, let/var, assignment & op-assignment,
  if/else (statement *and* expression position), while, for-in,
  break/continue, match statements, string interpolation desugared to
  concatenation, array & struct literals
- `self/checker.ab` — semantic pass v0: symbol tables, arity checks,
  scope/name resolution, enum variant ctors, duplicate detection
  (full ownership analysis remains in the reference checker)
- `self/emit.ab` — C# generator with a self-contained runtime prelude
  (boxed-object value model, arrays/structs/enums/options, string methods,
  file I/O, args)
- `self/arborsc.ab` — driver: import discovery, per-file parsing with
  flat namespace merging, pipeline orchestration

### Reference toolchain fixes surfaced by bootstrapping
- `src/loader.js`: struct literals of imported types failed to parse
  (`knownStructs` was per-file); loader now unions struct names across all
  files before parsing.
- `src/interp.js`: ordered string comparison (`< <= > >=`) implemented in
  the VM to match checker + back end.

### Known limitations of the self-hosted compiler (v0.4)
- Semantic pass does not perform move/borrow analysis yet — the reference
  checker stays authoritative there.
- Match is statement-position only, without payload binding values.
- No closures/tuples/ranges/maps in the emitted subset.

## v0.3.0 — Self-hosting milestone

### ARBOR compiles ARBOR
- **`self/self_lexer.ab`** — a full ARBOR lexer written in ARBOR. Its token
  stream is verified token-for-token against the reference lexer
  (`tests/self_hosted.mjs`) in two modes: executed by the reference VM *and*
  compiled to a standalone native .exe through the C# back end. 157/157
  tokens match in all three configurations.
- **`self/transpiler.ab`** — an ARBOR→C# transpiler written in ARBOR,
  completing the bootstrap loop end-to-end: ARBOR source is rewritten into C#
  by a program written in ARBOR itself, then compiled with `csc.exe` into a
  runnable executable (`input.ab` → `self/test_transpile.ab` → `output.cs`
  → `.exe`).
- **`self/self_parser.ab`** — recursive-descent parser + precedence-climbing
  expression parser written in ARBOR, emitting C# directly.
- **`self/self_analysis.ab`** — ARBOR analyzing its own compiler component's
  source (token statistics over `self_lexer.ab`).
- `npm test` now chains conformance (25), native parity (12) and self-hosting
  parity suites.

### Language fixes surfaced by self-hosting
- Fixed the reference interpreter rejecting ordered string comparison
  (`"a" < "b"`): the checker and the C# back end already supported
  lexicographic `Str` ordering, but the VM raised R0016. The self-hosted
  lexer's character classification was the first real-world program to need
  it — exactly what self-hosting is for.

## v0.2.0

### Multi-file modules & methods
- `use "./math.ab"` imports a file; its functions are called through the
  module namespace (`math.add(1, 2)`) in both the VM and compiled executables.
- Recursive imports with cycle detection; module functions namespaced as
  `math__add` compiling to direct static calls in C#.
- User-defined methods: `fn Point.sum(self: Point) -> Int { ... }` invoked as
  `p.sum()` — with two-pass hoisting so declaration order is free.

### Compiled language
- **`arbor build` compiles ARBOR to standalone native .exe files** via the new
  C# back end (`src/compiler/cs_backend.js`) and the .NET Framework's `csc.exe`,
  present on every Windows install.
- **9/9 compiled-vs-VM parity tests**: every positive conformance case produces
  byte-identical output from the compiled executable and the reference VM
  (`tests/native_parity.mjs`). All 7 examples build and run natively.

### Native x86-64 pipeline (self-contained, no external toolchain)
- Machine-code encoder verified by generating running executables; fixed
  double-REX register-extension loss and unsafe-large-immediate handling.
- PE32+ writer with two-phase layout, import descriptors, INT/IAT arrays,
  hint/name blobs and rip-relative patching — produces executables that Windows
  loads at the preferred base.
- Import resolution solved with per-function descriptors after diagnosing a
  loader behavior where multi-entry tables built naively were left unsnapped.
- Hand-emitted assembly runtime: bump allocator over `VirtualAlloc`, stdout
  caching + `WriteFile`, i64→decimal conversion, float formatting via
  `_snprintf("%.17g")` with `.0` normalization, traps with error codes,
  bounds checks (in progress).

### Language & tooling
- Checker stamps resolved types and call targets onto the AST for typed back ends.
- `///` doc comments captured on declarations.
- New builtins: `assert(cond)`, `assert_eq(a, b)`.

## v0.1.0

- Complete front end: lexer, parser, type checker with move analysis, handle
  linearity, structured-spawn rules and exhaustive-match enforcement.
- Reference interpreter with deterministic FIFO task semantics, generational
  tables, region allocation accounting, Option/Result with `?` propagation.
- CLI: run / check / ast / repl; pretty two-location diagnostics.
- 21-case conformance suite (positive parity + mandated rejections).
- Six worked examples including pointer-free graphs and stale-handle safety.
