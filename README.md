# ARBOR v0.4.0

<p align="center"><img src="docs/logo_green_no_background.png" alt="ARBOR" width="280"></p>

> **Safety is not something the compiler must prove for every program.
> Safety is something you cannot express incorrectly in the first place.**

ARBOR is a compiled, systems-oriented programming language built on the principle
of **safety by unexpressibility**: instead of proving programs safe with a borrow
checker (Rust) or pure value semantics alone (Hylo), ARBOR restructures its data
model so that unsafe operations **cannot be spelled in the grammar at all**.

That single design decision yields all three of its headline properties:

- **Blazing-fast compilation** — no lifetime inference, no fixed-point analysis,
  no trait solving. The safety checker is nearly indistinguishable from the parser:
  O(n) with tiny constants. A 2,200-line program type-checks in under 200 ms.
- **No lifetimes in types. Ever.** Call-tree discipline (a callee always outlives
  its caller's frame *and* dies before it) makes every downward lend automatically
  valid — with zero annotations.
- **Structural memory safety** — use-after-free, double-free, dangling pointers,
  iterator invalidation, null dereferences and data races are *inexpressible*,
  not merely detected.

## Quick Start

```powershell
node bin\arbor.js run examples\regions.ab     # bulk-freed memory regions
node bin\arbor.js run examples\handles.ab    # generational handles — stale = safe
node bin\arbor.js run examples\spawn.ab      # structured concurrency
node bin\arbor.js run examples\graph.ab      # graphs with NO pointers and NO GC

node bin\arbor.js build examples\native_hello.ab -o hello.exe   # COMPILE to native!
.\hello.exe                                                     # runs standalone

node bin\arbor.js check your_file.ab         # safety report only
node bin\arbor.js repl                       # interactive session
npm test                                     # 25 conformance + 12 native parity + self-hosting parity

# Self-hosting — ARBOR compiles ARBOR:
node bin\arbor.js run self\self_analysis.ab  # ARBOR tokenizes its own lexer's source
npm run test:bootstrap                       # the Thompson check:
                                             #   seed -> arborsc.exe (native, written in ARBOR)
                                             #   arborsc.exe compiles ITSELF -> identical behavior
                                             #   programs it compiles match the reference VM exactly
node tests\self_hosted.mjs                   # self-hosted lexer == reference lexer, VM & native
```

`arbor build` lowers ARBOR through the C# back end and invokes the .NET
Framework's `csc.exe` (present on every Windows install) — producing a real
standalone executable. All 7 examples and 9 parity cases compile and run with
byte-identical output to the reference VM.

## The Whole Language in Three Nouns

| Concept | Meaning |
|---|---|
| **Value** | Everything is an ownership tree. No interior pointers exist in the type system. |
| **Region** | A lexical block that owns a heap arena. Same region = live together, die together, freed in one operation. |
| **Handle** | A linear ticket (`Handle[T]`, use-once) that refers durably across regions. A stale handle returns `None` — it never silently misreads. |

### Three parameter modes

```text
fn f(a: Int)              // own   — takes ownership (move); caller can no longer use it
fn g(in a: Int)           // in    — shared lend; valid because callees die before callers
fn h(a: inout [Int])      // inout — exclusive lend to mutate; needs a mutable place
```

That is everything you will ever annotate. No `'a`, no `<T: 'static>`.

## What Gets Blocked?

```text
error[A0002]: use of moved value `xs` — ARBOR values are trees;
              a moved tree belongs to its new owner
 5 |   println("len = {xs.len()}")
   |                   ^^
                  use_after_move.ab:4:12
 previous event  4 |   let ys = xs
                   |            ^^
```

| Classic bug | In ARBOR |
|---|---|
| Use-after-free | Impossible — values are trees; references never escape |
| Dangling pointer | Generational handles; stale access yields `None` |
| Double free | Regions die exactly once, by structure |
| Data race | Linear handles + spawn joins before scope exit; captures copy-or-move |
| Iterator invalidation | Loop elements are *lends* — moving out is a compile error |
| Non-exhaustive match | A0016 — every variant must be handled |
| Null | Does not exist. There is `Option[T]`. |

See `tests\cases\*.fail.ab` for thirteen programs that must fail to compile.

## Toolchain

```
bin/arbor.js            CLI: run / build / check / ast / repl
src/lexer.js            Tokenizer with doc-comments and string interpolation
src/parser.js           Pratt parser (newline-sensitive)
src/checker.js          Type checking + move analysis + handle linearity + spawn rules
src/types.js            Semantic types + unification
src/builtins.js         Stdlib signatures
src/runtime.js          Values, generational tables, method dispatch (reference VM)
src/interp.js           Tree-walking interpreter with deterministic task queue

src/compiler/
  cs_backend.js         ARBOR → C# back end — native .exe via csc.exe (WORKING)
  arbort.h              C11 runtime header for the portable C back end
  assembler.js          x86-64 machine-code encoder (labels, ext refs, SSE2) (WORKING)
  pe.js                 PE32+ executable writer with import tables (WORKING)
  runtime_native.js     Hand-emitted assembly runtime (in progress)
  c_backend.js          ARBOR → C11 generator (experimental)

self/                   ARBOR written in ARBOR (full self-hosting)
  self_lexer.ab         Lexer — token-for-token parity with src/lexer.js, VM & native
  parser.ab             Parser: source -> tagged-tree IR (Node)
  checker.ab            Semantic pass v0: scopes, arity, name resolution
  emit.ab               C# code generator + self-contained runtime prelude
  arborsc.ab            THE COMPILER — driver for the whole pipeline
  lexdump.ab            Token dump driver used by tests/self_hosted.mjs
```

## Documentation

- [docs/GUIDE.md](docs/GUIDE.md) — step-by-step tutorial
- [docs/LANGUAGE.md](docs/LANGUAGE.md) — language reference card
- [docs/SPEC.md](docs/SPEC.md) — formal specification + central safety theorem sketch
- [docs/COMPILER.md](docs/COMPILER.md) — compiler architecture and roadmap
- [CHANGELOG.md](CHANGELOG.md)

## Status

v0.4 reaches **full self-hosting** — the Thompson fixed point. The compiler
(`self/arborsc.ab`) is written in ARBOR: the seed toolchain builds it once,
then it rebuilds itself deterministically and compiles programs whose output
matches the reference VM byte-for-byte (`npm run test:bootstrap`). Alongside
it ship the complete front end, reference interpreter, native compiler
(`arbor build`, 12/12 parity), 25 conformance cases and the lexer-parity
suite. See [docs/ROADMAP.md](docs/ROADMAP.md) for what comes next.
