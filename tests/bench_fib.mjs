function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

const start = performance.now();
const result = fib(32);
const elapsed = Math.round(performance.now() - start);
console.log(`fib(32) = ${result}`);
console.log(`elapsed_ms = ${elapsed}`);
