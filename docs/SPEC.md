# ARBOR Specification (v0.2)

This document formally describes the ARBOR language: syntax, semantics, the
safety checking system, and a proof sketch of the central safety theorem.

---

## 1. Data Model

### 1.1 The Value-Tree Model

Every runtime value is an **ownership tree**. The type system has no concept of
interior pointers: no expression ever has type "reference to T". The only
references that exist are *lends* — read or write permissions granted strictly
for the duration of one call, sound because of call-tree discipline (§3.1).

By definition: since reference-values cannot be expressed, use-after-free,
dangling pointers, and double-frees are not runtime errors to be detected —
they are sentences that do not exist in the language.

### 1.2 Copy vs Move

A type is `Copy` iff every constituent is Copy:

```
Copy    ::= Int | Float | Bool | Str | Unit
          | tuple(T1..Tn)     if every Ti is Copy
          | struct S          if every field is Copy
          | enum E            if every payload of every variant is Copy
NonCopy ::= [T] | Map[K,V] | Set[T] | Table[T] | Handle[T] | function types
```

Assigning or passing a NonCopy value **moves** it: the source becomes unusable
(checker code A0002). Re-assignment to a moved binding is permitted
(re-initialization).

### 1.3 Regions

The block `region name { ... }` opens a lexically scoped heap arena:

- Every allocation inside is attributed to the innermost open region.
- When the block ends, the region is reclaimed **in a single operation**
  (bump-pointer reset in native backends; allocation accounting in the VM).
- Values leaving via move/copy are re-owned by the destination context.

`std.mem.live()` reports allocations attributed to currently open regions;
`std.mem.allocs()` reports the cumulative total.

### 1.4 Generational Handles

`Handle[T]` is a durable reference ticket `(table-id, slot-index, generation)`.
`Table[T]` stores slots `{gen, value}`; `remove` advances `gen`, invalidating
every outstanding handle into that slot. Access through a stale handle returns
`None` — it can never misread recycled storage.

**Linearity:** `Handle[T]` is NonCopy. The checker tracks `Fresh → Moved`
per binding. A handle is consumed exactly once; an unused handle reaching end
of scope raises warning W0001.

---

## 2. Syntax (Summary)

```text
program   := (use | fnDecl | structDecl | enumDecl)*
use       := "use" "std" ("." ident)* ("." "{" ident ("," ident)* "}")?
fnDecl    := "fn" ident "[" typarams "]"? "(" params? ")" ("->" type)? block
param     := ident ":" ("in" | "inout")? type        // mode defaults to own
type      := ident ("[" types "]")?                  // Table[Int], Option[T]
           | "[" type "]"                            // array
           | "fn" "(" types? ")" "->" type           // function type
           | "(" types? ")"                          // tuple / unit
stmt      := letStmt | varStmt | assign | whileS | forS | returnS | breakS
           | continueS | regionS | spawnS | exprStmt | fnDecl
letStmt   := "let" (pattern | ident) (":" type)? "=" expr
regionS   := "region" ident block
spawnS    := "spawn" block                           // body: Unit
expr      := Pratt binary | unary(- not) | postfix+
postfix   := call | [index] | .ident | .int | ?      // ? = try-propagate
primary   := literal | "interp-string" | ident tyArgs? | StructLit{..}
           | [items] | [k:v, ..] | (tuple) | closure | ifExpr | matchExpr | block
matchExpr := "match" expr "{" arm* "}"
arm       := pattern ("if" guard)? "=>" body ","?
pattern   := literal | ident | _ | (patterns) | Variant patterns?
```

Strings support interpolation `"x = {expr}"`. Semicolons are unnecessary —
newlines terminate statements; binary operators must share a line with their
left operand to continue an expression.

---

## 3. The Safety Checking System

ARBOR replaces the borrow checker with four local rules, each checked in O(1)
amortized per syntax node — total cost O(program size), no fixed points, no
cross-procedural inference.

### 3.1 Call-Tree Discipline

**Layout:** every call creates a frame that lives *strictly shorter* than its
caller's frame; every lexical block lives shorter than its parent block. The
"lives-shorter-than" relation forms a tree determined entirely by syntax — no
inference required.

**Consequence:** an `in`/`inout` lend passed downward is always valid for the
duration of the call, because the callee cannot outlive the lender. Hence
**no lifetime annotations exist** — lifetime information is encoded by the
syntax tree itself.

### 3.2 Move Rule (A0002)

Each binding has state `Fresh | Moved`. Passing own-mode arguments, assignment
right-hand sides, returns, and container-literal elements are **consuming
positions**: a NonCopy binding transitions `Fresh → Moved`; reading a `Moved`
binding is a compile error. Loans (loop variables over collections) may never
be consumed (A0014) — iterator invalidation is unexpressible.

### 3.3 Handle Linearity

A special case of §3.2 plus: warning W0001 when a handle reaches scope end
never having been used. Combined with generation checks at runtime ⇒ no races
through handles and stale handles are harmless.

### 3.4 Structured Spawn (A0007)

`spawn { body }` is a statement whose body yields Unit; `return`/`break`/
`continue` may not cross the boundary. Free variables are captured: Copy by
deep copy, NonCopy by move (the source dies at the spawn point). Tasks join
automatically before the enclosing block exits. No orphan tasks ⇒ no lifetimes
escaping into the background ⇒ every datum a task touches outlives the task.

### 3.5 Exhaustive Match (A0016)

Match on an enum must cover every variant (or include `_`). Match on any other
type requires a default arm. Guards make arms conditional and excluded from
coverage.

---

## 4. Execution Semantics

- **Deterministic sequential semantics.** Arguments evaluate left-to-right.
  Parameter modes affect static permissions, not evaluation order.
- **Spawn:** tasks enter a FIFO queue drained when execution returns to depth
  zero; nested spawns append before draining reaches them. Identical programs
  produce identical output on every run — determinism is a semantic invariant,
  parallelism is a back-end concern.
- **Try operator `?`:** on `Option[T]`/`Result[T,E]`, `Some/Ok` unwraps,
  `None/Err(e)` makes the enclosing function return that value immediately.
- **Runtime traps (R-codes):** division by zero, index out of bounds, reading a
  taken slot, unwrap on None/Err, integer overflow, stack overflow — all carry
  source locations.

---

## 5. The Central Safety Theorem (Proof Sketch)

**Theorem (Memory & Thread Safety).** Every program accepted by the checker
executes with:

1. no access to freed memory;
2. no double free;
3. no null access;
4. no data race between tasks.

*Proof sketch (structural induction on statements):*

- (1)(2) By §1.1 no dereference operation on reference-values exists in the
  grammar; heap arenas close wholesale at lexical boundaries, and the move rule
  guarantees no binding still owns into a closed arena at closing time, since
  every escape path passes through move/copy re-ownership.
- (3) The language has no null value; absence is represented by `Option[T]`,
  and exhaustiveness checking (§3.5) forces handling of the empty case.
- (4) Two tasks can touch mutable data only through captures; NonCopy captures
  move (the source dies statically), Copy captures deep-copy. Handles — the one
  sharing channel between regions — are linear, so at any instant exactly one
  task holds each. ∎

The philosophical point: this proof is performed **once for the calculus**, not
per program. Because the safety rules are local and structural, "checking"
degenerates to a single tree walk — the origin of all three headline properties:
fast, simple, safe.

---

## 6. Error Codes

| Code | Meaning |
|---|---|
| A0001 | unresolved name |
| A0002 | use of moved value |
| A0003 | type mismatch |
| A0004 | mutation without `var` / non-place inout argument |
| A0007 | return/break/continue crossing spawn boundary |
| A0008 | break/continue outside loop |
| A0009 | wrong arity |
| A0014 | move out of a lend |
| A0016 | match missing variants / no catch-all |
| A0031 | `?` outside Option/Result-returning function |
| R0002 | index out of bounds |
| R0003 | unwrap on None/Err |
| R0004 | integer overflow |
| R0005 | integer division/modulo by zero |
| R0008 | read of a taken slot |
| W0001 | unused handle reaching end of scope |
