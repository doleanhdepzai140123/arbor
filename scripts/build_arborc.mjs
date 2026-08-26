// Builds the real ARBOR compiler binary: arborc.exe
//
//   node scripts/build_arborc.mjs
//
// Path: the reference toolchain RUNS the ARBOR-written compiler
// (self/arborsc.ab) to emit C#, then csc turns that into a native exe.
// The result is a standalone arborc.exe — no Node required at run time —
// which can compile ARBOR programs, including its own source again.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CSC = process.env.ARBOR_CSC ??
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const stage = join(tmpdir(), 'arborc_selfemit.cs');
const outExe = 'arborc.exe';

console.log('[1/3] running the ARBOR-written compiler on its own source...');
execFileSync('node', ['bin/arbor.js', 'run', 'self/arborsc.ab', 'self/arborsc.ab', '-o', stage], { stdio: 'inherit' });

console.log('[2/3] compiling emitted C# -> native arborc.exe...');
rmSync(outExe, { force: true });
execFileSync(CSC, ['/nologo', '/optimize+', `/out:${outExe}`, '/t:exe', stage], { stdio: 'inherit' });

console.log('[3/3] smoke test: arborc.exe compiles a sample to a native exe...');
const demo = join(tmpdir(), 'arborc_smoke.ab');
const demoCs = join(tmpdir(), 'arborc_smoke_out.cs');
const demoExe = join(tmpdir(), 'arborc_smoke.exe');
rmSync(demoExe, { force: true });
writeFileSync(demo, 'fn main() {\n  println("arborc works")\n}\n');
const out = execFileSync(`./${outExe}`, [demo, '-o', demoExe, '-exe'], { encoding: 'utf8' });
if (!existsSync(demoExe)) throw new Error('smoke failed:\n' + out);
const ran = execFileSync(demoExe, [], { encoding: 'utf8' });
if (!ran.includes('arborc works')) throw new Error('smoke output mismatch:\n' + ran);
void demoCs;
console.log('\narborc.exe ready — usage: arborc <input.ab> [-o <out.cs>] [-exe] [-csc <path>]');
