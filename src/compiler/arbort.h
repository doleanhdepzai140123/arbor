/* arbort.h — ARBOR runtime library (C11, single header) */
#ifndef ABORT_H
#define ABORT_H

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

typedef int64_t ab_i64;
typedef double ab_f64;
typedef uint8_t ab_bool;
typedef struct AbStr AbStr;
typedef struct AbArrHeader AbArr;
typedef struct AbTable AbTable;
typedef struct AbHandle AbHandle;
typedef struct AbMap AbMap;
typedef struct AbSet AbSet;
typedef struct AbEnum AbEnum;
typedef struct AbTuple AbTuple;
typedef struct AbClosure AbClosure;

/* ---- heap (monotonic bump arena; reclaimed at exit) ---- */
static uint8_t* ab_heap_ptr = NULL;
static uint8_t* ab_heap_end = NULL;
static long long ab_alloc_total = 0;
static long long ab_region_stack[4096];
static int ab_region_depth = 0;

static void* ab_alloc(size_t n) {
    if (!ab_heap_ptr || (size_t)(ab_heap_end - ab_heap_ptr) < n) {
        size_t chunk = n > (1u << 20) ? (n + 4095) & ~4095 : (1u << 20);
        ab_heap_ptr = (uint8_t*)malloc(chunk);
        if (!ab_heap_ptr) { fprintf(stderr, "error[R0006]: out of memory\n"); exit(1); }
        ab_heap_end = ab_heap_ptr + chunk;
    }
    void* p = ab_heap_ptr;
    ab_heap_ptr += (n + 15) & ~(size_t)15;
    ab_alloc_total++;
    return p;
}

static inline long long ab_mem_allocs(void) { return ab_alloc_total; }
static inline long long ab_mem_live(void) {
    return ab_region_depth ? ab_alloc_total - ab_region_stack[ab_region_depth - 1] : ab_alloc_total;
}
static inline void ab_region_enter(void) { ab_region_stack[ab_region_depth++] = ab_alloc_total; }
static inline void ab_region_exit(void) { if (ab_region_depth) ab_region_depth--; }

/* ---- traps ---- */
static void ab_trap(const char* code, const char* msg) {
    fprintf(stderr, "error[%s]: %s\n", code, msg);
    exit(1);
}

/* ---- strings: {len, bytes} immutable ---- */
struct AbStr { long long len; char bytes[]; };

static AbStr* ab_str_new(long long len) {
    AbStr* s = (AbStr*)ab_alloc(sizeof(AbStr) + (size_t)len + 1);
    s->len = len; s->bytes[len] = 0;
    return s;
}
static AbStr* ab_str_lit(const char* lit) {
    long long len = (long long)strlen(lit);
    AbStr* s = ab_str_new(len);
    memcpy(s->bytes, lit, (size_t)len);
    return s;
}
static AbStr* ab_str_from_raw(const char* data, long long len) {
    AbStr* s = ab_str_new(len);
    memcpy(s->bytes, data, (size_t)len);
    return s;
}
static inline long long ab_str_len_chars(AbStr* s) { return s->len; }
static inline ab_bool ab_str_eq(AbStr* a, AbStr* b) {
    return (a->len == b->len) && memcmp(a->bytes, b->bytes, (size_t)a->len) == 0;
}
static AbStr* ab_str_concat(AbStr* a, AbStr* b) {
    AbStr* s = ab_str_new(a->len + b->len);
    memcpy(s->bytes, a->bytes, (size_t)a->len);
    memcpy(s->bytes + a->len, b->bytes, (size_t)b->len);
    return s;
}
static AbStr* ab_str_from_int(ab_i64 v) {
    char buf[32];
    int n = snprintf(buf, sizeof buf, "%lld", (long long)v);
    return ab_str_from_raw(buf, n);
}
static AbStr* ab_str_from_float(double v) {
    if (v != v) return ab_str_lit("NaN");
    if (v == HUGE_VAL) return ab_str_lit("+inf");
    if (v == -HUGE_VAL) return ab_str_lit("-inf");
    if (v == (double)(long long)v && v < 1e15 && v > -1e15) {
        char buf[64];
        snprintf(buf, sizeof buf, "%.1f", v);
        return ab_str_from_raw(buf, (long long)strlen(buf));
    }
    char buf[64];
    for (int prec = 1; prec <= 17; prec++) {
        snprintf(buf, sizeof buf, "%.*g", prec, v);
        double back = strtod(buf, NULL);
        if (back == v) break;
    }
    return ab_str_from_raw(buf, (long long)strlen(buf));
}
static AbStr* ab_str_to_int(AbStr* s) {
    /* returns Result-like enum handled by generator; here: parse or NULL-ish tag */
    char* end = NULL;
    long long v = strtoll(s->bytes, &end, 10);
    int ok = (end != s->bytes);
    while (ok && *end) { if (*end != ' ' && *end != '\t') { ok = 0; break; } end++; }
    AbEnum* e = (AbEnum*)ab_alloc(sizeof(AbEnum) + sizeof(ab_i64));
    e->tag = ok ? 0 : 1; /* Ok=0, Err=1 by convention of generated enums */
    *(ab_i64*)(e->payload) = ok ? v : (ab_i64)(intptr_t)ab_str_lit("not an integer");
    return (AbStr*)e; /* reinterpreted by generated code */
}
static AbStr* ab_str_repeat(AbStr* s, long long n) {
    if (n < 0 || n > 10000) ab_trap("R0010", ".repeat(n) needs 0 <= n <= 10000");
    AbStr* r = ab_str_new(s->len * n);
    for (long long i = 0; i < n; i++) memcpy(r->bytes + i * s->len, s->bytes, (size_t)s->len);
    return r;
}

/* ---- arrays with holes (take leaves None) ---- */
struct AbArr { long long cap; long long live; void** data; unsigned char* hole; };
static AbArr* ab_arr_new(long long cap0) {
    long long cap = cap0 < 4 ? 4 : cap0;
    AbArr* a = (AbArr*)ab_alloc(sizeof(AbArr));
    a->cap = cap; a->live = 0;
    a->data = (void**)ab_alloc(sizeof(void*) * (size_t)cap);
    a->hole = (unsigned char*)ab_alloc((size_t)cap);
    memset(a->hole, 1, (size_t)cap);
    for (long long i = 0; i < cap; i++) a->data[i] = NULL;
    return a;
}
static void ab_arr_grow(AbArr* a, long long need) {
    long long cap = a->cap;
    while (cap <= need) cap *= 2;
    void** nd = (void**)ab_alloc(sizeof(void*) * (size_t)cap);
    unsigned char* nh = (unsigned char*)ab_alloc((size_t)cap);
    memset(nh, 1, (size_t)cap);
    memcpy(nd, a->data, sizeof(void*) * (size_t)a->cap);
    memcpy(nh, a->hole, (size_t)a->cap);
    a->data = nd; a->hole = nh; a->cap = cap;
}
static inline void ab_arr_push(AbArr* a, void* v) {
    if (a->live >= a->cap) ab_arr_grow(a, a->cap);
    a->data[a->live] = v; a->hole[a->live] = 0; a->live++;
}
static inline long long ab_arr_len(AbArr* a) { return a->live; }
static inline void* ab_arr_get_opt(AbArr* a, long long i) {
    if (i < 0 || i >= a->live || a->hole[i]) return NULL;
    return a->data[i];
}
static inline void* ab_arr_get(AbArr* a, long long i) {
    void* v = ab_arr_get_opt(a, i);
    if (!v) {
        static char msg[128];
        snprintf(msg, sizeof msg, "index %lld out of bounds for length %lld", i, a->live);
        ab_trap("R0002", msg);
    }
    return v;
}
static inline void ab_arr_set(AbArr* a, long long i, void* v) {
    if (i < 0 || i >= a->live) {
        static char msg[128];
        snprintf(msg, sizeof msg, "index %lld out of bounds for length %lld", i, a->live);
        ab_trap("R0002", msg);
    }
    a->data[i] = v; a->hole[i] = 0;
}
static void* ab_arr_take(AbArr* a, long long i) {
    if (i < 0 || i >= a->live) {
        static char msg[128];
        snprintf(msg, sizeof msg, "index %lld out of bounds for length %lld", i, a->live);
        ab_trap("R0002", msg);
    }
    if (a->hole[i]) ab_trap("R0008", ".take(): slot was already taken");
    void* v = a->data[i];
    a->hole[i] = 1; a->live--;
    return v;
}
static void* ab_arr_pop(AbArr* a) {
    while (a->live > 0 && a->hole[a->live - 1]) a->live--;
    if (a->live == 0) return NULL;
    void* v = a->data[a->live - 1];
    a->live--;
    return v;
}
static ab_bool ab_arr_contains(AbArr* a, void* v) {
    for (long long i = 0; i < a->live; i++)
        if (!a->hole[i] && a->data[i] == v) return 1;
    return 0;
}

/* ---- generational tables ---- */
struct AbSlot { unsigned long long gen; void* val; };   /* gen bit0: 1 = occupied */
struct AbTable { long long cap; long long live; struct AbSlot* slots; };
struct AbHandle { AbTable* tbl; long long idx; unsigned long long gen; };

static inline int ab_slot_alive(const struct AbSlot* s) { return (s->gen & 1ULL) != 0; }

static AbTable* ab_table_new(void) {
    AbTable* t = (AbTable*)ab_alloc(sizeof(AbTable));
    t->cap = 8; t->live = 0;
    t->slots = (struct AbSlot*)ab_alloc(sizeof(struct AbSlot) * (size_t)t->cap);
    for (long long i = 0; i < t->cap; i++) { t->slots[i].gen = 0; t->slots[i].val = NULL; }
    return t;
}
static AbHandle* ab_handle_new(AbTable* t, long long idx, unsigned long long gen) {
    AbHandle* h = (AbHandle*)ab_alloc(sizeof(AbHandle));
    h->tbl = t; h->idx = idx; h->gen = gen;
    return h;
}
static AbHandle* ab_table_insert(AbTable* t, void* v) {
    for (long long i = 0; i < t->cap; i++) {
        struct AbSlot* s = &t->slots[i];
        if (!ab_slot_alive(s)) {
            s->gen |= 1ULL;
            s->val = v;
            t->live++;
            return ab_handle_new(t, i, s->gen);
        }
    }
    /* grow */
    long long oldCap = t->cap;
    struct AbSlot* ns = (struct AbSlot*)ab_alloc(sizeof(struct AbSlot) * (size_t)(oldCap * 2));
    for (long long i = 0; i < oldCap * 2; i++) { ns[i].gen = 0; ns[i].val = NULL; }
    memcpy(ns, t->slots, sizeof(struct AbSlot) * (size_t)oldCap);
    t->slots = ns; t->cap = oldCap * 2;
    return ab_table_insert(t, v);
}
static inline int ab_handle_matches(AbHandle* h, struct AbSlot* s) {
    return ab_slot_alive(s) && s->gen == h->gen;
}
static void* ab_table_get(AbTable* t, AbHandle* h) {
    static AbEnum noneObj;
    if (h->tbl != t || h->idx >= t->cap) return (void*)&noneObj; /* tag 0 = None */
    struct AbSlot* s = &t->slots[h->idx];
    if (!ab_handle_matches(h, s)) return (void*)&noneObj;
    return s->val;
}
static void ab_table_set(AbTable* t, AbHandle* h, void* v) {
    if (h->tbl != t || h->idx >= t->cap) return;
    struct AbSlot* s = &t->slots[h->idx];
    if (ab_handle_matches(h, s)) s->val = v;
}
static void* ab_table_remove(AbTable* t, AbHandle* h) {
    static AbEnum noneObj;
    if (h->tbl != t || h->idx >= t->cap) return (void*)&noneObj;
    struct AbSlot* s = &t->slots[h->idx];
    if (!ab_handle_matches(h, s)) return (void*)&noneObj;
    void* old = s->val;
    s->gen += 2;              /* next generation, empty again */
    t->live--;
    return old;
}
static ab_bool ab_table_alive(AbTable* t, AbHandle* h) {
    if (h->tbl != t || h->idx >= t->cap) return 0;
    return ab_handle_matches(h, &t->slots[h->idx]);
}

/* ---- maps / sets (Int/Str/Bool keys) ---- */
struct AbEntry { char* k; long long ki; int kind; void* v; };  /* kind 0=i,1=s,2=b */
struct AbMap { struct AbEntry* e; long long len; long long cap; };
static AbMap* ab_map_new(void) {
    AbMap* m = (AbMap*)ab_alloc(sizeof(AbMap));
    m->cap = 16; m->len = 0;
    m->e = (struct AbEntry*)ab_alloc(sizeof(struct AbEntry) * (size_t)m->cap);
    return m;
}

/* ---- enums: {tag, payload} ---- */
struct AbEnum { int tag; unsigned char payload[]; };

/* ---- tuples ---- */
struct AbTuple { long long n; void* items[]; };
static AbTuple* ab_tuple_new(long long n) {
    AbTuple* t = (AbTuple*)ab_alloc(sizeof(AbTuple) + sizeof(void*) * (size_t)n);
    t->n = n;
    return t;
}
static inline void* ab_tuple_field(AbTuple* t, long long i) { return t->items[i]; }

/* ---- closures ---- */
struct AbClosure { void* fn; void* env; };
static AbClosure* ab_closure_new(void* fn, void* env) {
    AbClosure* c = (AbClosure*)ab_alloc(sizeof(AbClosure));
    c->fn = fn; c->env = env;
    return c;
}

/* ---- structured tasks ---- */
typedef void (*AbTaskFn)(void*);
struct AbTaskRec { AbTaskFn fn; void* ctx; };
static struct AbTaskRec* ab_tasks = NULL;
static long long ab_task_head = 0, ab_task_tail = 0, ab_task_cap = 0;

typedef struct { long long n; } AbTaskCtxHdr;

static void* ab_task_ctx_new(long long slots) {
    return ab_alloc(8 + slots * 8);
}
static void ab_task_ctx_set(void* ctx, long long i, void* slotPtr) {
    void** cells = (void**)ctx;
    cells[1 + i] = *(void**)slotPtr;   /* copy current slot value (move/copy semantics) */
}
static void ab_spawn_task(AbTaskFn fn, void* ctx) {
    if (ab_task_tail >= ab_task_cap) {
        long long nc = ab_task_cap ? ab_task_cap * 2 : 16;
        struct AbTaskRec* nt = (struct AbTaskRec*)ab_alloc(sizeof(struct AbTaskRec) * (size_t)nc);
        if (ab_tasks) memcpy(nt, ab_tasks + ab_task_head, sizeof(struct AbTaskRec) * (size_t)(ab_task_tail - ab_task_head));
        ab_tasks = nt; ab_task_tail -= ab_task_head; ab_task_head = 0; ab_task_cap = nc;
    }
    ab_tasks[ab_task_tail].fn = fn;
    ab_tasks[ab_task_tail].ctx = ctx;
    ab_task_tail++;
}
static void ab_drain_tasks(void) {
    while (ab_task_head < ab_task_tail) {
        AbTaskFn fn = ab_tasks[ab_task_head].fn;
        void* ctx = ab_tasks[ab_task_head].ctx;
        ab_task_head++;
        fn(ctx);
    }
}

/* ---- printing (format parity with reference interpreter) ---- */
static void ab_write_raw(const char* s, size_t n) { fwrite(s, 1, n, stdout); }
static const char* ab_to_string_i64(ab_i64 v) { return NULL; }

#endif /* ABORT_H */
