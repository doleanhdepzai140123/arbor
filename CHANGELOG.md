# Changelog

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
