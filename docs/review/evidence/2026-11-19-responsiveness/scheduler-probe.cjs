// Run from repository root: node docs/review/evidence/2026-11-19-responsiveness/scheduler-probe.cjs
// Executes current scheduler source; only metrics are stubbed. No VS Code required.
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const output = ts.transpileModule(fs.readFileSync('src/backend/indexScheduler.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const errors = [];
const box = { exports: {}, require: name => name === '../languageServiceMetrics'
  ? { startLanguageServiceOperation: () => ({ end() {} }) } : require(name),
  queueMicrotask: fn => queueMicrotask(() => { try { fn(); } catch (e) { errors.push(e.message); } }),
  setTimeout, clearTimeout };
vm.runInNewContext(output, box);
const { IndexScheduler, IndexTaskPriority: P } = box.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const s = new IndexScheduler({ interactiveCooldownMs: 0 });
  let release;
  const scan = s.enqueue({kind:'initial-scan', priority:P.BackgroundFull,
    run:() => new Promise(resolve => { release = resolve; })});
  await tick();
  let ran = false;
  const local = s.enqueue({kind:'single-file-update', priority:P.RequestLocal,
    run:async () => { ran = true; }});
  await tick();
  assert.equal(ran, false);
  assert.equal(local.state(), 'queued');
  scan.cancel();
  assert.equal(scan.state(), 'running');
  console.log('RESP-002: pending discovery blocks RequestLocal; running cancel is no-op');
  release(); await local.wait; s.dispose();

  const broken = new IndexScheduler({interactiveCooldownMs:0});
  broken.enqueue({kind:'initial-scan', priority:P.BackgroundFull, run:() => {throw Error('sync-failure');}});
  await tick();
  const next = broken.enqueue({kind:'single-file-update',priority:P.RequestLocal,run:async()=>{}});
  await tick();
  assert.deepEqual(errors, ['sync-failure']);
  assert.equal(broken.getStatus().running.kind, 'initial-scan');
  assert.equal(next.state(), 'queued');
  console.log('RESP-003: synchronous throw escapes pump; running slot never cleared');
  broken.dispose();

  // Exact dependency shape of launchInitialScanViaScheduler + scheduleDefMethodLutRebuild.
  const dead = new IndexScheduler({interactiveCooldownMs:0});
  let discoverDone;
  const discovered = new Promise(resolve => { discoverDone = resolve; });
  let work;
  const initial = dead.ensureTask('initial',()=>({kind:'initial-scan',priority:P.BackgroundFull,
    run:async()=> {work = discovered.then(async()=> {
      await dead.enqueue({kind:'full-reindex',priority:P.BackgroundFull,run:async()=>{}}).wait;
    });}
  })).then(async()=>{await work;});
  await tick();
  dead.ensureTask('lut',()=>({kind:'non-interactive',priority:P.NonInteractive,
    run:async()=>{await initial;}})).catch(()=>{});
  await tick(); discoverDone(); await tick();
  assert.equal(dead.getStatus().running.kind,'non-interactive');
  assert.equal(dead.getStatus().queued,1);
  console.log('RESP-004: LUT waits initial scan while owning slot needed by scan batch (dependency-shape reproduction)');
  dead.dispose(); await tick();
})().catch(e => { console.error(e); process.exitCode=1; });
