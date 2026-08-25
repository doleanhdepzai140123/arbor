// Bootstrap proof — the Thompson check for ARBOR.
//
//   node tests/bootstrap.mjs
//
// Chain:
//   1. SEED     — the reference toolchain (JavaScript + C# back end)
//                 compiles self/arborsc.ab (the compiler, written in
//                 ARBOR) into a native arborsc_seed.exe.
//   2. SELF     — arborsc_seed.exe compiles its OWN source again,
//                 producing stage2 C#, compiled to arborsc_self.exe.
//   3. PARITY   — both native compilers compile the sample program; the
//                 resulting executables must produce byte-identical
//                 output to the reference VM.
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CSC = process.env.ARBOR_CSC ??
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const TMP = tmpdir();
const SAMPLE = 'tests/selfhost_sample.ab';

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function csc(outExe, csFile) {
  sh(CSC, ['/nologo', '/optimize+', `/out:${outExe}`, '/t:exe', csFile]);
}

let step = 0;
function ok(msg) { step++; console.log(`PASS ${step}. ${msg}`); }

rmSync(join(TMP, 'stage1.cs'), { force: true });
sh('node', ['bin/arbor.js', 'run', 'self/arborsc.ab', 'self/arborsc.ab', '-o', join(TMP, 'stage1.cs')]);
csc(join(TMP, 'arborsc_seed.exe'), join(TMP, 'stage1.cs'));
ok('SEED: reference toolchain compiled the ARBOR-written compiler -> arborsc_seed.exe');

const seedOut = sh(join(TMP, 'arborsc_seed.exe'), ['self/arborsc.ab', '-o', join(TMP, 'stage2.cs')]);
if (!seedOut.includes('compiled')) throw new Error('seed compiler failed:\n' + seedOut);
csc(join(TMP, 'arborsc_self.exe'), join(TMP, 'stage2.cs'));
ok('SELF: arborsc_seed.exe re-compiled its own source -> arborsc_self.exe');

const selfOut = sh(join(TMP, 'arborsc_self.exe'), [SAMPLE, '-o', join(TMP, 'sample_self.cs')]);
if (!selfOut.includes('compiled')) throw new Error('self-hosted compiler failed on sample:\n' + selfOut);
csc(join(TMP, 'sample_self.exe'), join(TMP, 'sample_self.cs'));
ok('SELF: arborsc_self.exe compiled the sample program -> sample_self.exe');

// determinism: stage1 and stage2 outputs must be identical
const s1 = readFileSync(join(TMP, 'stage1.cs'), 'utf8');
const s2 = readFileSync(join(TMP, 'stage2.cs'), 'utf8');
if (s1 !== s2) throw new Error('self-compilation is not deterministic');
ok('DETERMINISM: compiling the compiler twice yields identical C#');

const want = sh('node', ['bin/arbor.js', 'run', SAMPLE]).replace(/\r\n/g, '\n').trimEnd();
const gotSeed = sh(join(TMP, 'arborsc_seed.exe'), [SAMPLE, '-o', join(TMP, 'p1.cs')]);
csc(join(TMP, 'p1.exe'), join(TMP, 'p1.cs'));
const got1 = sh(join(TMP, 'p1.exe'), []).replace(/\r\n/g, '\n').trimEnd();
if (got1 !== want.trimEnd()) throw new Error(`parity mismatch (seed-built):\n--- vm ---\n${want}\n--- exe ---\n${got1}`);
ok('PARITY: seed-compiled sample matches the reference VM byte-for-byte');

const gotSelf = sh(join(TMP, 'sample_self.exe'), []).replace(/\r\n/g, '\n').trimEnd();
if (gotSelf !== want.trimEnd()) throw new Error(`parity mismatch (self-built):\n--- vm ---\n${want}\n--- exe ---\n${gotSelf}`);
ok('PARITY: self-compiled sample matches the reference VM byte-for-byte');

console.log('\nbootstrap: all checks green — ARBOR compiles ARBOR compiles ARBOR.');
