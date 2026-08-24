# ARBOR Commercialization Roadmap

> From working prototype to a language companies pay for.
> Status baseline: v0.3.0 — self-hosting milestone reached.

## Where we are (honest assessment)

**Assets**

| Asset | State |
|---|---|
| Core differentiator | Safety by unexpressibility: no lifetimes, no borrow checker, O(n) checking |
| Front end | Lexer/parser/checker complete, fast, precise diagnostics |
| Execution | Reference VM + C# back end producing standalone Windows .exe |
| Self-hosting | Lexer, parser and transpiler written in ARBOR; token-parity proven VM & native |
| Tests | 25 conformance cases (incl. mandated rejections), 12 native parity, self-hosting parity |
| Tooling | CLI (run/build/check/fmt/doc/ast/repl/lsp), VS Code extension |
| License | MIT — maximally adoptable |

**Gaps blocking commercial use**

1. Windows-only native story (depends on `csc.exe`).
2. Tree-walking VM is ~100× slower than compiled Go/Rust; native pipeline covers a subset.
3. No package manager, no registry, thin stdlib (no HTTP/JSON/crypto).
4. LSP is minimal; no debugger.
5. Zero community, zero production usage, single-maintainer risk.

---

## Phase 0 — Consolidation (v0.3.x, weeks)

Goal: make the repo credible to a stranger in under 5 minutes.

- [x] Self-hosting milestone + parity suites green
- [ ] GitHub Actions CI: Windows + Linux + macOS matrix running all three suites
- [ ] Cross-platform `arbor build`: detect mono/.NET on Linux/macOS, document limits
- [ ] CONTRIBUTING.md, issue templates, CODE_OF_CONDUCT
- [ ] Landing page + "try it" shell one-liner
- [ ] Deterministic release artifacts (`arbor-lang.zip` with CLI + examples)

Exit criteria: a first-time visitor can clone, run `npm test`, see everything green on any OS.

## Phase 1 — Language foundation (v0.4–v0.6, months 1–4)

Goal: close the expressiveness gap so real programs (a web server, a CLI tool) fit comfortably.

- [ ] Traits/interfaces + generic functions with inference-free, check-once semantics
- [ ] Closures & iterators that respect the ownership tree (lend-based `map/filter`)
- [ ] Error handling v2: `Result[T,E]` ergonomics, typed `catch`, panic boundaries
- [ ] Byte/string split: `[u8]`, UTF-8 validation at the boundary, slicing API
- [ ] Modules v2: explicit exports, doc comments → `arbor doc` HTML output
- [ ] **Bytecode VM**: replace tree-walking interpreter (target: ≥30× current speed,
      still deterministic task queue)
- [ ] FFI v0: call C from ARBOR through an owned-handle boundary (safety preserved by construction)

Exit criteria: rewrite two real tools (e.g. `wc`, an HTTP static file server) in pure ARBOR, published as packages.

## Phase 2 — Ecosystem & performance (v0.7–v0.9, months 4–9)

Goal: make adoption cheap and performance defensible.

- [ ] `arbor pkg`: init/add/build/publish; content-addressed cache; semver resolution
- [ ] Registry (static CDN + signed manifests first; UI later)
- [ ] Stdlib v1: `std.net` (TCP/HTTP client+server), `std.json`, `std.crypto` (hash/HMAC via OS libs), `std.io` buffered readers/writers
- [ ] Native back end v2: either LLVM target or finish the in-repo x86-64 pipeline;
      Linux ELF + macOS Mach-O writers; cross-compile matrix in CI
- [ ] Benchmarks suite vs Go/Rust/C# (fib, json parse, http throughput) published on the site
- [ ] LSP v2: hover types, go-to-def, completions; DAP debugger with region/handle inspection
- [ ] WASM playground: compiler compiled to WASM (the self-hosted front end makes this tractable)

Exit criteria: `arbor add web && arbor run server.ab` deploys a todo-API demo; benchmarks within 2× of Go.

## Phase 3 — 1.0 and production proof (months 9–15)

Goal: remove the "toy" objection permanently.

- [ ] Spec freeze: formal spec updated + property-based differential testing
      (VM vs bytecode VM vs native must agree; fuzz the checker)
- [ ] Semver + edition policy; deprecation windows
- [ ] External security review of the memory-safety claims; publish the report
- [ ] 3 public case studies (startup tool, teaching course, OSS port)
- [ ] Conference/workshop talk + paper on safety-by-unexpressibility
- [ ] Packaging: scoop/homebrew/apt/cargo-style installs; docker images

Exit criteria: someone outside the project ships a service written in ARBOR.

## Phase 4 — Commercial layers (from month 12, parallel)

The language stays MIT/open forever — value is sold around it.

| Product | Buyer | Notes |
|---|---|---|
| **ARBOR Pro support** | Companies using ARBOR in prod | SLA, priority fixes, LTS editions |
| **Certified builds** | Embedded/automotive/medtech | Reproducible toolchains + safety audit trail aligned with their process requirements; the "no UB by grammar" story is the pitch |
| **Team training & certification** | Enterprises, universities | Workshops, courseware, exam |
| **Sponsored roadmap** | Vendors needing features | Named sponsorship of stdlib/backend work |
| **Managed CI/build service** | Teams without infra | Hosted cross-compile + artifact signing |

Pricing principle: free for individuals/OSS forever; charge for reliability guarantees and time saved, never for the language itself.

## KPI dashboard (review monthly)

- Clones/stars/contributors; time-to-first-"hello native exe"
- Packages published; downloads per release
- Benchmark ratios vs Go/Rust
- Issues closed by non-maintainers (community health)
- First paid pilot conversations (Phase 4 signal)

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Rust occupies the mindshare | Position explicitly: "Rust's safety for the price of Go's simplicity"; target teams scared off by borrow checker |
| Single maintainer | Recruit 2 core contributors during Phase 2; document everything; foundation transfer option |
| Native backend scope creep | Bytecode VM is the product default; native is an optimizer, not a blocker |
| Registry abuse/legal | Signed manifests, takedown policy, org verification early |
