import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

// nightly win32-x64 43817266345: every cargo suite passed and six of seven
// platforms passed, but the win32 packaging smoke died with
// `spawnSync kode-mcp.exe ETIMEDOUT` at exactly the 20 s budget. A cold-start
// spawn timeout like that is a runner-load transient, and the old run() also
// discarded the child's stdout/stderr so the failure could not be attributed
// from the workflow log.
//
// Behaviour is pinned by driving the real scripts/vsix-staging.mjs through a
// temporary .mjs (this suite's TS has no .mjs import precedent;
// platformPackageSet.test.ts avoids it the same way), plus source-level
// guards on the retry policy itself.
const repoRoot = path.resolve(__dirname, '..');
const staging = path.join(repoRoot, 'scripts', 'vsix-staging.mjs');

// Plain JS, run by node rather than vitest's TS transform. `firstBlocks` is
// substituted per mode; no interpolation otherwise (no ${...} in the source).
const driverSource = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Absolute POSIX paths are not valid ESM specifiers; resolve through a URL.
const { run } = await import(pathToFileURL(process.argv[4]).href);

const mode = process.argv[2];
const root = process.argv[3];
const firstBlocks = __FIRST_BLOCKS__;
const marker = path.join(root, 'attempts');
const childSource = [
  'const fs = require("fs");',
  // argv[2]: argv[0]=node, argv[1]=this script.
  'const m = process.argv[2];',
  'const seen = fs.existsSync(m) ? fs.readFileSync(m, "utf8").trim().split("\\n").filter(Boolean).length : 0;',
  'fs.appendFileSync(m, seen === 0 ? "cold\\n" : "warm\\n");',
  'if (seen === 0 || ' + firstBlocks + ') { setTimeout(function () {}, 5000); }',
  'else { process.stdout.write("recovered on attempt " + (seen + 1) + "\\n"); }',
].join('\n');
const child = path.join(root, 'child.cjs');
fs.writeFileSync(child, childSource);

if (mode === 'retry' || mode === 'exhaust') {
  try {
    const out = run(process.execPath, [child, marker], {
      encoding: 'utf8', stdio: 'pipe', timeout: 300,
    });
    console.log('RETRY_OUT:' + out.stdout.trim());
  } catch (error) {
    console.log('EXHAUST_CODE:' + (error && error.code ? error.code : 'nocode'));
    console.log('EXHAUST_MSG:' + String(error && error.message).slice(0, 120));
  }
  console.log('MARK:' + fs.readFileSync(marker, 'utf8').trim().split('\n').join(','));
} else {
  const failing = [
    'process.stdout.write("out-marker-8842\\n");',
    'process.stderr.write("err-marker-8842\\n");',
    'process.exitCode = 3;',
  ].join('\n');
  const child2 = path.join(root, 'failing.cjs');
  fs.writeFileSync(child2, failing);
  try {
    run(process.execPath, [child2], { encoding: 'utf8', stdio: 'pipe', timeout: 2000 });
    console.log('OUTPUT:none');
  } catch (error) {
    console.log('OUTPUT_MSG:' + String(error && error.message));
  }
}
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function drive(mode: 'retry' | 'exhaust' | 'output'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-smoke-retry-'));
  roots.push(root);
  const driver = driverSource

    .replace('__FIRST_BLOCKS__', mode === 'exhaust' ? 'true' : 'false');
  fs.writeFileSync(path.join(root, 'driver.mjs'), driver);
  const result = spawnSync(process.execPath, [path.join(root, 'driver.mjs'), mode, root, staging], {
    encoding: 'utf8', stdio: 'pipe', timeout: 30000,
  });
  if (result.status !== 0) {
    throw new Error(`driver ${mode} failed: ${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const stagingSource = () => fs.readFileSync(staging, 'utf8');

describe('packaging smoke spawn retry (nightly 43817266345)', () => {
  it('retries a cold-start ETIMEDOUT and reports the recovered output', () => {
    const stdout = drive('retry');
    expect(stdout).toContain('RETRY_OUT:recovered on attempt 2');
    expect(stdout).toContain('MARK:cold,warm');
  });

  it('exhausts three attempts on a permanent timeout and names the code', () => {
    const stdout = drive('exhaust');
    expect(stdout).toContain('EXHAUST_CODE:ETIMEDOUT');
    expect(stdout).toContain('EXHAUST_MSG:');
    expect(stdout).not.toContain('EXHAUST_MSG:nocode');
    expect(stdout).toContain('MARK:cold,warm,warm');
  });

  it('keeps the child output in the error instead of swallowing it', () => {
    const stdout = drive('output');
    expect(stdout).toContain('out-marker-8842');
    expect(stdout).toContain('err-marker-8842');
  });

  it('classifies only cold-start spawn codes as retryable', () => {
    const source = stagingSource();
    expect(source).toContain("TRANSIENT_SPAWN_CODES = new Set(['ETIMEDOUT', 'ESRCH'])");
    expect(source).toContain('MAX_SPAWN_ATTEMPTS = 3');
  });

  it('backs off between attempts instead of hammering the runner', () => {
    const source = stagingSource();
    expect(source).toContain('SPAWN_BACKOFF_MS = [20, 60, 150]');
    expect(source).toContain('sleepMs(SPAWN_BACKOFF_MS[attempt] ?? 150)');
  });
});
