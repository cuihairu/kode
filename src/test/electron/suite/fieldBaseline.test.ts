// P0-4b 现场基线采集(docs/perf/2026-10-26-stall-analysis.md P0-4b):
//   真 VS Code 扩展宿主内,脚本化执行 hover/definition/保存/突发请求,
//   采集扩展宿主事件循环延迟、CPU 增量、RSS 峰值、语言服务指标摘要,
//   并按 KODE_FIELD_MODE 区分「启用(Kode 激活)」/「禁用(不激活,VS Code 裸面)」对照。
//   输出:KEY=VALUE 行落 KODE_FIELD_OUT(缺省 docs/perf/2026-10-27-field-baseline-run.txt)。
// 口径边界(如实):请求端到端耗时经 vscode.executeHoverProvider/executeDefinitionProvider
//   真实 provider 链;hover 的请求级取消 token 不经公开命令面暴露,「取消」以突发
//   并发下的宿主响应性(事件循环延迟)与「取消后无残留」(突发后延迟回落)近似,
//   不虚构单请求取消语义;CPU 为增量采样(非 flamegraph);残留在指标摘要 cancelled
//   计数 + 突发后延迟回落双面,无专用残留计数量规。
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import * as vscode from 'vscode';
import {
  getOperationSummary,
  LanguageServiceEventName,
  resetLanguageServiceMetrics
} from '../../../languageServiceMetrics';

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --field must set KODE_FIELD_WORKSPACE');
const MODE = process.env.KODE_FIELD_MODE ?? 'enabled';
// P0-4c 联合验收面:KODE_FIELD_JOINT=1 时断言 Python 语言服务(Pylance)同场激活,
// 追加 hover 突发与长会话轮次(轮间保存+定距间隔),指标行前缀 session.r<N>。
const JOINT = process.env.KODE_FIELD_JOINT === '1';
const OUT_FILE = process.env.KODE_FIELD_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-27-field-baseline-run.txt');

const SYMBOL_FILE = 'scripts/common/training/mixins/combat.py';
const SYMBOL_NEEDLE = '# nav: runtime-damage';
const SYMBOL = 'compute_damage';

const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
};

const percentile = (samples: number[], rank: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
};

const metric = (name: string, samples: number[]): void => {
  emit(
    `FIELD-METRIC ${name} n=${samples.length} ` +
    `p50=${percentile(samples, 0.5)}ms p95=${percentile(samples, 0.95)}ms ` +
    `p99=${percentile(samples, 0.99)}ms max=${Math.round(Math.max(...samples) * 100) / 100}ms ` +
    `avg=${Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 100) / 100}ms`
  );
};

const once = (name: string, value: number | string, unit = 'ms'): void => {
  emit(`FIELD-METRIC ${name} n=1 ${value}${unit}`);
};

/** 取文件里 needle 所在行的 symbol 中部位置 */
async function symbolPosition(): Promise<vscode.Position> {
  const uri = vscode.Uri.file(path.join(WORKSPACE!, SYMBOL_FILE));
  const document = await vscode.workspace.openTextDocument(uri);
  const lines = document.getText().split(/\r?\n/);
  const line = lines.findIndex(text => text.includes(SYMBOL_NEEDLE));
  assert.ok(line >= 0, `missing source marker ${SYMBOL_NEEDLE}`);
  const character = lines[line].indexOf(SYMBOL);
  assert.ok(character >= 0, `missing symbol ${SYMBOL}`);
  return new vscode.Position(line, character + Math.floor(SYMBOL.length / 2));
}

async function hoverAt(position: vscode.Position): Promise<vscode.Hover[]> {
  const raw = await vscode.commands.executeCommand<vscode.Hover[] | vscode.Hover | null>(
    'vscode.executeHoverProvider',
    vscode.Uri.file(path.join(WORKSPACE!, SYMBOL_FILE)),
    position
  );
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

async function definitionAt(position: vscode.Position): Promise<vscode.Location[]> {
  const raw = await vscode.commands.executeCommand<vscode.Location[] | vscode.Location | null>(
    'vscode.executeDefinitionProvider',
    vscode.Uri.file(path.join(WORKSPACE!, SYMBOL_FILE)),
    position
  );
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

describe('P0-4b 现场基线采集(真 VS Code 扩展宿主)', function () {
  this.timeout(120_000);

  let pos: vscode.Position;
  let delay: ReturnType<typeof monitorEventLoopDelay> | null = null;
  let cpuSamples = 0;
  let cpuUserNs = 0;
  let cpuSysNs = 0;
  let cpuPeakRss = 0;
  let sampler: NodeJS.Timeout | null = null;

  before(async function () {
    this.timeout(120_000);
    if (MODE === 'enabled') {
      const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
      assert.ok(extension, 'Kode extension is unavailable in the extension host');
      await extension.activate();
    }
    // 环境记录(现场口径:本机真 VS Code + 已装扩展)
    once('env.vscodeVersion', vscode.version, '');
    once('env.mode', MODE, '');
    once('env.platform', `${os.platform()} ${os.release()} ${os.arch()}`, '');
    once('env.cpus', os.cpus().length, '');
    once('env.totalmemMiB', Math.round(os.totalmem() / 1024 / 1024), '');
    once('env.nodeVersion', process.version, '');
    once('env.workspace', WORKSPACE, '');
    const assetsRoot = vscode.workspace.getConfiguration('kbengine').get<string>('assetsRoot');
    once('env.assetsRoot', assetsRoot ?? '(unset)', '');
    // 事件循环延迟监控:整场采样,结束时取分位(Histogram 以纳秒计,取分位后 /1e6 转 ms)
    delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    // CPU/RSS 增量采样:500ms 一格,差分累积 user/sys 纳秒,RSS 峰值
    const cpuPrev = { user: 0, system: 0 };
    sampler = setInterval(() => {
      const usage = process.cpuUsage();
      cpuUserNs += usage.user - cpuPrev.user;
      cpuSysNs += usage.system - cpuPrev.system;
      cpuPrev.user = usage.user;
      cpuPrev.system = usage.system;
      cpuPeakRss = Math.max(cpuPeakRss, process.memoryUsage().rss);
      cpuSamples += 1;
    }, 500);
    resetLanguageServiceMetrics();
    pos = await symbolPosition();
    if (JOINT) {
      // 联合验收前置:打开 .py 文档已触发 onLanguage:python,等 Pylance 激活到位
      const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
      assert.ok(pylance, 'Pylance 未安装于 harness VS Code(先 --install-extension)');
      const deadline = Date.now() + 90_000;
      while (!pylance.isActive && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      once('env.pylanceActive', String(pylance.isActive), '');
      once('env.pylanceVersion', pylance.packageJSON.version ?? '(unknown)', '');
      const pythonExt = vscode.extensions.getExtension('ms-python.python');
      once('env.pythonExtActive', String(pythonExt?.isActive ?? false), '');
    }
  });

  after(async function () {
    if (sampler) { clearInterval(sampler); }
    if (delay) { delay.disable(); }
    // 扩展宿主资源账
    const hwm = Number((fs.readFileSync('/proc/self/status', 'utf8')
      .match(/VmHWM:\s+(\d+)/)?.[1] ?? '0'));
    once('host.vmHwmMiB', Math.round(hwm / 1024), '');
    once('host.peakRssMiB', Math.round(cpuPeakRss / 1024 / 1024), '');
    // process.cpuUsage() 以微秒计,除以 1e6 转秒
    once('host.cpuUserSec', Math.round((cpuUserNs / 1e6) * 100) / 100, '');
    once('host.cpuSysSec', Math.round((cpuSysNs / 1e6) * 100) / 100, '');
    once('host.cpuSampleCount', cpuSamples, '');
    if (delay) {
      // Histogram 分位/max/mean 皆为纳秒,统一 /1e6 转毫秒
      const ns = (v: number): number => Math.round(v / 1e6 * 100) / 100;
      once('eventloop.p50Ms', ns(delay.percentile(50)), '');
      once('eventloop.p95Ms', ns(delay.percentile(95)), '');
      once('eventloop.p99Ms', ns(delay.percentile(99)), '');
      once('eventloop.maxMs', ns(delay.max), '');
      once('eventloop.meanMs', ns(delay.mean), '');
    }
    // 语言服务指标摘要(Kode 侧与 Python 语言服务侧的分界:本机未装 Python LS,
    // 摘要是 Kode 索引口径;Python LS 索引不在本场,如实标注)
    const events: LanguageServiceEventName[] = [
      'hover', 'definition', 'completion', 'diagnostics',
      'python-index-scan', 'python-composition-roots', 'entity-mapping-scan',
      'semantic-query', 'type-registry-query', 'file-discovery', 'document-parse'
    ];
    for (const name of events) {
      const s = getOperationSummary(name);
      if (!s) { continue; }
      emit(
        `FIELD-SUMMARY ${name} count=${s.count} p50=${s.p50Ms} p95=${s.p95Ms} p99=${s.p99Ms} ` +
        `max=${s.maxMs} hit=${s.cacheHits} miss=${s.cacheMisses} ` +
        `discover=${s.fileDiscoveryCount} read=${s.fileReadCount} parse=${s.fileParseCount} ` +
        `ok=${s.statusCounts.ok} missStatus=${s.statusCounts.miss} ` +
        `cancelled=${s.statusCounts.cancelled} error=${s.statusCounts.error} ` +
        `waitInit=${s.waitedForInitCount}`
      );
    }
    emit(`FIELD-SUMMARY sessionEnd ${new Date().toISOString()}`);
  });

  it('冷启动:激活后首个 definition 请求(含背景索引并发)', async function () {
    this.timeout(120_000);
    const startedAt = performance.now();
    const results = await definitionAt(pos);
    once('cold.firstDefinitionMs', Math.round((performance.now() - startedAt) * 100) / 100);
    emit(`FIELD-METRIC cold.firstDefinitionTargets n=1 ${results.length}`);
  });

  it('热态 hover 50 次', async function () {
    const samples: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const startedAt = performance.now();
      await hoverAt(pos);
      samples.push(performance.now() - startedAt);
    }
    metric('hot.hoverMs', samples);
  });

  it('热态 definition 50 次', async function () {
    const samples: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const startedAt = performance.now();
      await definitionAt(pos);
      samples.push(performance.now() - startedAt);
    }
    metric('hot.definitionMs', samples);
  });

  it('未知符号(未命中分支)hover/definition', async function () {
    const uri = vscode.Uri.file(path.join(WORKSPACE!, SYMBOL_FILE));
    const document = await vscode.workspace.openTextDocument(uri);
    const line = document.getText().split(/\r?\n/).findIndex(text => text.includes('return'));
    const posUnknown = new vscode.Position(Math.max(0, line), 0);
    const hoverSamples: number[] = [];
    const defSamples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const h0 = performance.now();
      await hoverAt(posUnknown);
      hoverSamples.push(performance.now() - h0);
      const d0 = performance.now();
      await definitionAt(posUnknown);
      defSamples.push(performance.now() - d0);
    }
    metric('miss.hoverMs', hoverSamples);
    metric('miss.definitionMs', defSamples);
  });

  it('连续保存 + 保存后首次跳转', async function () {
    const uri = vscode.Uri.file(path.join(WORKSPACE!, SYMBOL_FILE));
    const document = await vscode.workspace.openTextDocument(uri);
    for (let i = 0; i < 10; i += 1) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(0, 0), `# save-storm ${i}\n`);
      await vscode.workspace.applyEdit(edit);
      await document.save();
    }
    const startedAt = performance.now();
    await definitionAt(pos);
    once('saveStorm.firstJumpMs', Math.round((performance.now() - startedAt) * 100) / 100);
  });

  it('突发 20 路并发 definition(排队/响应性)', async function () {
    // 直方图为累积窗口:before/after 取同一累计 p99(纳秒→ms),反映突发前后宿主事件循环 p99
    const beforeP99 = delay ? delay.percentile(99) : 0;
    const startedAt = performance.now();
    await Promise.all(Array.from({ length: 20 }, () => definitionAt(pos)));
    const wall = performance.now() - startedAt;
    const afterP99 = delay ? delay.percentile(99) : 0;
    once('burst.20wallMs', Math.round(wall * 100) / 100);
    once('burst.20hostP99BeforeMs', Math.round(beforeP99 / 1e6 * 100) / 100);
    once('burst.20hostP99AfterMs', Math.round(afterP99 / 1e6 * 100) / 100);
  });

  it('P0-4c 联合验收:hover 面向', async function () {
    if (!JOINT) { this.skip(); }
    // 与 definition 突发同口径的 hover 突发(请求级取消 token 不经公开命令面暴露,
    // 取消语义以突发响应性+摘要 cancelled 计数近似,如实标注)
    const beforeP99 = delay ? delay.percentile(99) : 0;
    const startedAt = performance.now();
    await Promise.all(Array.from({ length: 20 }, () => hoverAt(pos)));
    const wall = performance.now() - startedAt;
    const afterP99 = delay ? delay.percentile(99) : 0;
    once('joint.burstHover.20wallMs', Math.round(wall * 100) / 100);
    once('joint.burstHover.20hostP99BeforeMs', Math.round(beforeP99 / 1e6 * 100) / 100);
    once('joint.burstHover.20hostP99AfterMs', Math.round(afterP99 / 1e6 * 100) / 100);
  });

  // P0-4c 长会话:10 轮热态场景,轮间保存+5s 定距(背景索引持续在场),
  // 逐轮记录 hover/def 分位与宿主 RSS,观察指标不随会话时长劣化。
  for (let round = 1; round <= 10; round += 1) {
    it(`P0-4c 长会话第 ${round} 轮`, async function () {
      if (!JOINT) { this.skip(); }
      const hoverSamples: number[] = [];
      const defSamples: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const h0 = performance.now();
        await hoverAt(pos);
        hoverSamples.push(performance.now() - h0);
        const d0 = performance.now();
        await definitionAt(pos);
        defSamples.push(performance.now() - d0);
      }
      metric(`session.r${round}.hoverMs`, hoverSamples);
      metric(`session.r${round}.definitionMs`, defSamples);
      // 轮间保存(增量索引压力)+ 定距间隔(让背景索引/LS 持续工作)
      const uri = vscode.Uri.file(path.join(WORKSPACE!, SYMBOL_FILE));
      const document = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(0, 0), `# joint-session ${round}\n`);
      await vscode.workspace.applyEdit(edit);
      await document.save();
      await new Promise(resolve => setTimeout(resolve, 5000));
      once(`session.r${round}.rssMiB`, Math.round(process.memoryUsage().rss / 1024 / 1024), '');
    });
  }
});
