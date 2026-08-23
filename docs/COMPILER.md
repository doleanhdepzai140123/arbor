# The ARBOR Compiler — Architecture & Roadmap

This document describes ARBOR's compilation strategy, what is implemented today,
and the precise engineering plan toward a fully self-hosted native toolchain.

## Pipeline Overview

```
source.ab
   │  lexer.js        tokens, doc comments, interpolation spans
   ▼
tokens
   │  parser.js       Pratt parser → AST (newline-sensitive statements)
   ▼
AST
   │  checker.js      type check + move analysis + linearity + spawn rules
   ▼                  (stamps resolved types onto every node)
Typed AST ─────────────► interp.js        reference execution (exact semantics)
   │
   ▼  compiler/*
Back-end code generation
```

The front end is complete and battle-tested by the conformance suite
(`tests/run_tests.mjs`, 21 cases: positive output parity + mandated rejections).

## Design Invariants Carried Into Every Back End

1. **Values are trees.** No interior pointers are materialized; composite values
   live in arenas and are passed as owning pointers.
2. **Uniform slots.** Every value occupies exactly one machine word at rest:
   integers/booleans/handles directly, floats as raw doubles, composites as
   arena pointers.
3. **Moves are free.** A move copies one word (or zero, for register values).
4. **Lends never exist at runtime.** `in`/`inout` compile to plain register or
   stack access — safety was proven statically.
5. **Determinism.** Spawned tasks execute in FIFO order joined before their
   scope exits, identical to the reference interpreter on every back end.

## Implemented Components

### x86-64 encoder (`assembler.js`) — WORKING
Byte-level emitter verified by generating running executables: labels with rel32
fixups, ModRM/SIB addressing, REX prefixes, SSE2 doubles, external-reference
infrastructure for globals/imports, import thunks. Notable fixed defects:
double-REX emission when extending registers (r9 was silently losing REX.R),
and `mov_imm` silently zeroing immediates above Number.MAX_SAFE_INTEGER
(all large constants must be passed as `BigInt`).

### PE32+ writer (`pe.js`) — WORKING
Two-phase layout producing console executables that Windows loads and runs:
`.text/.rdata/.data/.idata`, import descriptors, INT/IAT arrays, hint/name
blobs, rip-relative patching against a preferred base of `0x140000000`.
Verified end-to-end: an exe that calls `GetCurrentProcessId` and returns its
low byte as the exit code produces a different code on every run — proof that
imports resolve and arguments flow correctly.

### Import strategy — SOLVED WITH PER-FUNCTION DESCRIPTORS
Windows' loader rejected multi-function import tables built naively (all slots
left unsnapped → jump-to-placeholder crash). Emitting **one descriptor per
imported function** (duplicate DLL names suffixed `#0`, `#1`, …; the real DLL
name string is written without the suffix) resolves reliably. This is the
strategy the native backend ships with.

### C11 runtime (`arbort.h`)
Single-header reference for the C back end: bump arena, region snapshot stack,
hole-capable arrays, generational tables, task queue, shortest-round-trip
float formatting matching the interpreter byte-for-byte.

### Native runtime (`runtime_native.js`) — IN PROGRESS
Hand-emitted machine-code routines: entry stubs, bump allocator with
`VirtualAlloc` growth, stdout caching + `WriteFile` writer, i64→decimal
conversion, float formatting via `_snprintf("%.17g")` plus `.0` normalization,
string concat, traps with error codes, bounds checks, generational tables,
region counters, structured-spawn task queue.

### C generator (`c_backend.js`) — experimental
Lowers typed AST to readable C11. Under active development; not wired into
the CLI yet.

## Milestones Toward Native Builds

| Milestone | Scope | Status |
|---|---|---|
| M1 Front end frozen | parser/checker/diagnostics | **done** |
| M2 Reference VM | deterministic interpreter | **done** |
| M3 Encoder + PE writer | self-contained object emission | **done** (running exes) |
| M4a Import strategy | loader-compatible tables | **done** (per-fn descriptors) |
| M4b Native runtime completion | all stdlib routines in asm | **in progress** |
| M5 Codegen | typed AST → machine code, `arbor build` | **in progress** |
| M6 Optimizer | const-fold/DCE/CSE/regalloc, `-O0/-O1/-O2` | design below |
| M7 Parity harness | compiled output == VM output on all tests | planned |
| M8 Self-hosting | rewrite front end in ARBOR | future |

## Running the Native Smoke Tests

```powershell
node tests\pe_min.mjs     && .\tests\min.exe        # exit 9
node tests\pe_smoke.mjs exit  && .\tests\smoke_exit.exe   # exit 42
node tests\pe_perfn.mjs   && .\tests\smoke_perfn.exe # random PID low-byte
```

## M6 Design: Optimization Tiers

- **O0** — direct translation, every temporary through memory. Correctness oracle.
- **O1** — constant folding/propagation, algebraic simplification, dead-code
  elimination, local value-numbered CSE.
- **O2** — single-use temporary fusion, bounds-check hoisting over proven
  ranges, sound region reclamation after escape analysis, drain-check elision
  for leaf functions.

Safety checks (bounds, overflow, null-free-by-construction) stay enabled at
every tier.

## Parity Testing

Every conformance case will run twice: reference VM and compiled artifact,
outputs compared byte-for-byte; mandated-rejection cases must fail identically.

