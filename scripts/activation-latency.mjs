#!/usr/bin/env node
// RUST-022 extension activation 段实测(RUST-022 余项,此前 PERF-005 记 Untested)。
//
// 做法:同一份已编译产物连开 N 次真实 VS Code(xvfb),每次用**全新 user-data**
// 冷启(无缓存、无热态),读宿主自带的 exthost.log,解析出激活分段时刻。
// 度量全部来自宿主日志时间戳(宿主侧证据),不引入扩展内埋点。
//
// 用法:
//   node scripts/activation-latency.mjs [--runs 5] [--out docs/perf/activation-run.txt]
// 依赖 out/ 已编译(`pnpm run compile && tsc -p tsconfig.mocha.json`),
// 无显示环境用 xvfb-run -a 包住本脚本。
//
// 诚实边界:宿主日志无 activate() 返回时刻,得出的 activateToEager 是
// 「激活入口 → 启动期激活全量完成」口径(宿主可证下界),非扩展同步体精确耗时。

import { execFileSync } from 'child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const EXT_ID = 'cuihairu.kode-kbengine';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const runs = Number(argValue('--runs', '5'));
const outFile = argValue('--out', 'docs/perf/activation-run.txt');

// 惰性加载解析核(out/ 编译产物;脚本顶层静态 import 会在未编译时直接失败)
const loadParser = async () => import(join(process.cwd(), 'out', 'backend', 'activationTiming.js'));

const buffer = [];
const emit = (text) => {
  process.stdout.write(text + '\n');
  buffer.push(text);
};

const percentile = (samples, rank) => {
  if (samples.length === 0) { return null; }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * samples.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
};

// user-data/logs/<时间戳>/window1/exthost/exthost.log
const findExthostLog = (userDataDir) => {
  const logsRoot = join(userDataDir, 'logs');
  if (!existsSync(logsRoot)) { return null; }
  for (const dir of readdirSync(logsRoot).sort().reverse()) {
    const candidate = join(logsRoot, dir, 'window1', 'exthost', 'exthost.log');
    if (existsSync(candidate)) { return candidate; }
  }
  return null;
};

const main = async () => {
  const entry = join(process.cwd(), 'out', 'test', 'electron', 'runTest.js');
  if (!existsSync(entry)) {
    console.error('缺少已编译入口 out/test/electron/runTest.js(先跑 pnpm run compile 与 tsc -p tsconfig.mocha.json)');
    return 1;
  }
  const parser = await loadParser();

  emit(`# RUST-022 extension activation 段实测`);
  emit(`# runs=${runs} date=${new Date().toISOString()}`);
  try {
    emit(`# loadavg=${readFileSync('/proc/loadavg', 'utf8').trim()}`);
  } catch {
    emit(`# loadavg=n/a (非 Linux)`);
  }
  emit(`# 口径:宿主日志时间戳(每次全新 user-data 冷启)。`);
  emit(`# 非 activate() 同步体精确耗时(那需扩展内埋点,见 docs/perf/2026-11-07-activation-views-first.md)。`);
  emit(`# activateToEager 若带 trailingStartup>0 则是混合窗(含其他扩展激活体),`);
  emit(`# 不可单读本扩展——两者必须同看。`);

  const samples = { hostStartToActivateMs: [], activateToEagerMs: [], hostStartToEagerMs: [] };
  const events = new Set();
  const trailingCounts = [];

  for (let i = 1; i <= runs; i += 1) {
    const userDataDir = mkdtempSync(join(tmpdir(), 'kode-activation-ud-'));
    const startedAt = Date.now();
    try {
      execFileSync(process.execPath, [entry, '--demo'], {
        env: { ...process.env, KODE_ACTIVATION_BENCH_UD: userDataDir },
        stdio: 'ignore',
        timeout: 900_000
      });
    } catch (error) {
      emit(`run#${i}: 宿主运行失败(${error?.message ? String(error.message).slice(0, 120) : 'unknown'}),跳过`);
      rmSync(userDataDir, { recursive: true, force: true });
      continue;
    }
    const wallMs = Date.now() - startedAt;

    const logPath = findExthostLog(userDataDir);
    const parsed = logPath ? parser.parseActivationLog(readFileSync(logPath, 'utf8'), EXT_ID) : null;
    rmSync(userDataDir, { recursive: true, force: true });

    if (!parsed) {
      emit(`run#${i}: 宿主日志里无 ${EXT_ID} 激活行(运行 ${wallMs}ms),跳过`);
      continue;
    }
    events.add(parsed.activationEvent ?? '(none)');
    const {
      hostStartToActivateMs,
      activateToEagerMs,
      hostStartToEagerMs,
      trailingStartupActivations
    } = parsed.derived;
    if (hostStartToActivateMs !== null) { samples.hostStartToActivateMs.push(hostStartToActivateMs); }
    if (activateToEagerMs !== null) { samples.activateToEagerMs.push(activateToEagerMs); }
    if (hostStartToEagerMs !== null) { samples.hostStartToEagerMs.push(hostStartToEagerMs); }
    trailingCounts.push(trailingStartupActivations);
    emit(
      `run#${i}: hostStartToActivate=${hostStartToActivateMs ?? 'n/a'}ms `
      + `activateToEager=${activateToEagerMs ?? 'n/a'}ms `
      + `hostStartToEager=${hostStartToEagerMs ?? 'n/a'}ms `
      + `trailingStartup=${trailingStartupActivations} (wall=${wallMs}ms)`
    );
  }

  emit('');
  for (const [name, values] of [
    ['hostStartToActivateMs', samples.hostStartToActivateMs],
    ['activateToEagerMs', samples.activateToEagerMs],
    ['hostStartToEagerMs', samples.hostStartToEagerMs]
  ]) {
    if (values.length === 0) {
      emit(`METRIC ${name}: no sample`);
      continue;
    }
    emit(
      `METRIC ${name}: n=${values.length} p50=${percentile(values, 0.5)}ms `
      + `p90=${percentile(values, 0.9)}ms max=${percentile(values, 1)}ms min=${percentile(values, 0)}ms`
    );
  }
  emit(`ACTIVATION_EVENT: ${[...events].join(' | ')}`);
  emit(`TRAILING_STARTUP_ACTIVATIONS: ${trailingCounts.length === 0 ? 'n/a' : `${Math.min(...trailingCounts)}-${Math.max(...trailingCounts)}`}`);
  appendFileSync(outFile, buffer.join('\n') + '\n');
  return 0;
};

main()
  .then(code => process.exit(code ?? 0))
  .catch(error => {
    console.error('activation 测量失败:', error);
    process.exit(1);
  });
