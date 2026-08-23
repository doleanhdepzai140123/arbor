# The ARBOR Tutorial

<img src="../docs/logo_green_no_background.png" width="160" align="right" alt="ARBOR">

ARBOR has exactly **three concepts**: values, regions, and handles. This tutorial
walks through each one, then assembles them into real programs. Everything here
runs today with the reference interpreter (`node bin\arbor.js run file.ab`).

## 1. Your First Program

Save this as `hello.ab`:

```arb
fn main() {
  println("Hello, ARBOR!")
}
```

Run it:

```powershell
node bin\arbor.js run hello.ab
```

No semicolons needed. The last expression of a block is its value, so functions
return implicitly:

```arb
fn add(a: Int, b: Int) -> Int {
  a + b
}
```

Strings interpolate with braces: `"sum = {add(2, 3)}"`.

## 2. `let` and `var` — Immutable by Default

```arb
fn main() {
  let x = 10         // immutable
  var y = 20         // mutable
  y = y + x
}
```

Try to mutate a `let` binding and the compiler answers immediately:

```text
error[A0004]: cannot mutate `x`: it is bound with `let`
  hint: declare it with 'var' to allow mutation
```

## 3. Values Are Trees: Copy and Move

Small types (Int, Float, Bool, Str, and structs whose fields are all small) are
**Copy** — assignment duplicates them.

Containers (`[T]`, `Map`, `Set`, `Table`) are **Move** types — assigning hands
ownership to the new binding; the old one becomes unusable:

```arb
fn main() {
  var xs: [Int] = [1, 2, 3]
  let ys = xs          // xs moved into ys
  println("{ys.len()}")   // fine
  // println(xs.len())    // error[A0002]: use of moved value `xs`
}
```

This is ARBOR's closest cousin to Rust — but note what is *missing*: lifetime
annotations.

## 4. Three Parameter Modes: own / in / inout

```arb
fn read_len(xs: in [Int]) -> Int { xs.len() }      // lend read-only
fn push99(xs: inout [Int]) -> Int { xs.push(99) xs.len() }  // lend mutable
fn take_all(xs: [Int]) -> Int { xs.len() }         // own — caller loses it
```

Why no lifetime annotations like Rust's `'a`? Because ARBOR enforces
**call-tree discipline**: a callee always dies before its caller resumes.
Lending downward is therefore always valid — that is a theorem about the
language, not something each program must re-prove.

## 5. Modules — Split Code Across Files

Put shared functions in a separate file:

```arb
// math.ab
fn add(a: Int, b: Int) -> Int { a + b }
fn mul(a: Int, b: Int) -> Int { a * b }
```

Import it by path and call through the module name (the file stem):

```arb
use "./math.ab"

fn main() {
  println("{math.add(2, 3)}")   // 5
}
```

Modules export top-level functions and constants. Declare structs/enums in
your entry file. Circular imports are detected and rejected.

## 5b. Option / Result — No Null, No Exceptions

```arb
fn main() {
  var xs: [Int] = [10, 20]
  match xs.get(5) {
    Some(v) => println("found {v}")
    None => println("missing")
  }
}
```

Forget a variant? It does not compile:

```text
error[A0016]: match on `Option` is not exhaustive — missing variant(s): None
```

Business errors use `Result[T, E]` with the `?` operator for propagation:

```arb
fn divide(a: Int, b: Int) -> Result[Int, Str] {
  if b == 0 { Err("division by zero") } else { Ok(a / b) }
}

fn compute(x: Int, y: Int) -> Result[Int, Str] {
  let n = divide(x, y)?
  Ok(n * 2)
}
```

## 6. Regions — Allocate Many, Free Once

```arb
use std.mem.live

struct Particle { x: Int, y: Int }

fn main() {
  region arena {
    var ps: [Particle] = []
    var i = 0
    while i < 1_000_000 {
      ps.push(Particle { x: i, y: i })
      i = i + 1
    }
    println("{live()}")     // allocations alive: millions
  }                          // <- the whole forest freed in ONE operation
  println("{live()}")       // back to zero
}
```

No background GC, no per-object frees. Live together, die together.

> Numeric separators are not yet supported; write `1000000`.

## 7. Handles — Durable References That Stay Safe

Need relationships between objects (graphs, UI trees, ECS)? Store data in a
`Table[T]`, relate via `Handle[T]`:

```arb
var t = Table[Enemy].new()
let h = t.insert(Enemy { name: "Orc", hp: 30 })

t.remove(h)                 // slot reclaimed; generation bumped
match t.get(h) {            // h is now STALE
  Some(e) => println("bug!")
  None => println("safe: stale handle yields None")
}
```

Handles are **linear**: they are consumed exactly once. Consuming twice is a
compile error. Result: you can never misread memory someone else now owns.

## 8. spawn — Concurrency That Cannot Race

```arb
fn main() {
  let base = 100
  spawn {
    println("{base}")      // Copy type: task gets its own copy
  }
  var big: [Int] = [1, 2, 3]
  spawn {
    println("{big.len()}") // Move: THIS task owns big now
  }
  // println(big.len())    // error[A0002]: big was moved into the task
}                          // tasks join before this block ends
```

Tasks never outlive their enclosing block → no detached threads, no escaping
lifetimes, no races: Copy captures are duplicated, non-Copy captures move.

## 9. Working With the Compiler

Diagnostics show the current location **and** the earlier event that caused it:

```text
error[A0002]: use of moved value `xs`
  note: the previous move happened ...
                   use.ab:4:12
  previous event  4 |   let ys = xs
```

Blocked from moving twice? Call `.clone()` for a copy. Blocked from moving out
of an iteration variable? Use `.take(i)` or iterate a `.clone()`.

## 10. Cheat Sheet

| You want | Write |
|---|---|
| Shared lend | `fn f(x: in T)` |
| Mutable lend | `fn f(x: inout T)` + pass a `var` |
| Transfer ownership | `fn f(x: T)` (default) |
| Durable reference | `Table[T]` + `Handle[T]` |
| Absence | `Option[T]` + `match` |
| Business error | `Result[T, E]` + `?` |
| Bulk allocation | `region name { ... }` |
| Concurrency | `spawn { ... }` |

Happy building — safely, by construction.
