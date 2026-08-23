# ARBOR Language Reference (v0.2)

## Types

| Type | Category | Copy | Notes |
|---|---|---|---|
| `Int` | scalar | yes | 64-bit signed; overflow traps |
| `Float` | scalar | yes | 64-bit IEEE; `/` by zero yields inf, `%`/int-div trap |
| `Bool` | scalar | yes | `true` / `false`; `and`, `or`, `not` short-circuit |
| `Str` | value | yes | immutable; interpolation `"x = {e}"` |
| `()` | unit | yes | written `()` |
| `[T]` | container | no | dynamic array; holes created by `.take(i)` |
| `Map[K, V]` | container | no | K ∈ {Int, Str, Bool} in v0.2 |
| `Set[T]` | container | no | T ∈ {Int, Str, Bool} |
| `Table[T]` | region | no | generational slots; pairs with `Handle[T]` |
| `Handle[T]` | linear | **no** | use-once ticket; stale access returns `None` |
| `(A, B)` | tuple | if fields | fields via `.0`, `.1` |
| user `struct` | record | if fields | `Point { x: 1, y: 2 }` |
| user `enum` | variant | if payloads | exhaustive `match` required |
| `Option[T]` / `Result[T,E]` | enum | built-in | `Some/None`, `Ok/Err`; `?` propagates |

## Constants

`const NAME = literal-or-constant-expression`
Module-level constants are evaluated at compile time (literals and arithmetic
over other constants). Typed: Int / Float / Bool / Str.

## Compound Assignment

`+= -= *= /=` desugar to plain assignment plus the binary operation:
`total += i` is exactly `total = total + i`.

## Range For-Loops

`for i in start..end { ... }` iterates integers from start (inclusive) to end
(exclusive). Works in both the reference VM and compiled executables.

## Declarations

```arb
fn name[a, b](x: T, y: in U, z: inout W) -> R { ... }
struct Name { field: Type, ... }
enum Name { VariantA(T), VariantB, ... }
use std.io.{println, print}     // import members
use std.math                    // bind module
```

Doc comments (`///`) above a declaration are captured by `arbor doc`.

## Statements

```arb
let x = expr              let (a, b) = tupleExpr
var x: [Int] = []
target = expr             // var bindings, arr[i], struct.field
if cond { .. } else { .. }          // expression-capable
while cond { .. }
for pattern in iterable { .. }      // arrays, sets, strings
region name { .. }
spawn { .. }              // statement; body is Unit; joins at scope end
return [expr]  break  continue
match value { pattern [if guard] => body, ... }
```

## Parameter Modes

| Mode | Meaning | Caller keeps use? | Callee may mutate? |
|---|---|---|---|
| *(default)* own | ownership transfer | never | yes |
| `in` | shared lend for the call | yes | no |
| `inout` | exclusive lend | paused during call | yes (needs mutable place) |

## Operators (loosest to tightest)

```text
or < and < == != < <= > >= < + - < * / %   ; unary - not ; postfix . [] () ?
```

Mixed Int/Float arithmetic is an error — convert explicitly with `.to_float()`
or `.to_int()`. Equality requires a Copy type.

## Stdlib (v0.2)

- `io`: `println(x)` `print(x)` `dbg(x)` `to_str(x)`
- `math`: `sqrt floor ceil round abs pow exp ln sin cos` and constants `pi e`
- `mem`: `live()` `allocs()`
- Prelude also binds `println print dbg drop assert assert_eq`

### Array

`len push get set take pop clone reverse contains is_empty first last sort_by`

`sort_by(cmp)` takes `fn(a: T, b: T) -> Int` returning negative/zero/positive.

### Map

`len insert(k,v)→Option[V] get(k)→Option[V] remove(k)→Option[V] keys contains_key is_empty`

### Set

`len insert remove contains to_array`

### Table

`insert(v)→Handle[T] get(h)→Option[T] set(h,v) remove(h)→Option[T] alive(h) len is_empty`

### Option / Result

`unwrap expect is_some is_none unwrap_or` / `unwrap expect is_ok is_err unwrap_or`

### Int / Float / Str / Bool methods

`Int.to_float to_str abs` · `Float.floor ceil round sqrt abs to_int to_str` ·
`Str.len upper lower trim contains split chars repeat to_int` · `Bool.to_str`

## Error Codes

| Code | Meaning |
|---|---|
| A0001 | unresolved name |
| A0002 | use of moved value |
| A0003 | type mismatch |
| A0004 | mutation without `var` / non-place inout |
| A0007 | return/break/continue crossing spawn |
| A0008 | break/continue outside loop |
| A0009 | wrong arity |
| A0014 | move out of a lend |
| A0016 | non-exhaustive match |
| R0002 | index out of bounds |
| R0003 | unwrap on None/Err |
| R0004 | integer overflow |
| R0005 | integer division/modulo by zero |
| R0008 | read of taken slot |
| W0001 | unused handle warning |
