// P0-4b 现场基线采集(docs/perf/2026-10-26-stall-analysis.md P0-4b):
//   真 VS Code 扩展宿主内,脚本化执行 hover/definition/保存/突发请求,
//   采集扩展宿主事件循环延迟、CPU 增量、RSS 峰值、语言服务指标摘要,
//   并按 KODE_FIELD_MODE 区分「启用(Kode 激活)」/「禁用(不激活,VS Code 裸面)」对照。
//   输出:KEY=VALUE 行落 KODE_FIELD_OUT(缺省 docs/perf/2026-10-27-field-baseline-run.txt)。
// 2026-10-28 审核重开补齐(三项 + 联合场 CPU profile):
//   ①请求级 hover 取消路径:激活返回探针 API(probeHover)——同一
//     KBEngineHoverProvider 实例 + 调用方 CancellationToken,cancelAfterMs 后
//     真实取消请求,不再以突发响应性近似;
//   ②有效命中证据:多候选点位探针(def 方法声明/def 文件/types.xml 类型),
//     断言至少一个 returnedHover,且公开 executeHoverProvider 突发后
//     getOperationSummary('hover').statusCounts.ok 增长(内部命中非墙钟空转);
//   ③残留任务量规:pendingWork() 聚合诊断排队/在途+编辑去抖注解+索引任务+
//     schema 冷构建在途计数,取消与保存风暴后按时距采样观测排干;
//   ④CPU profile:node:inspector Profiler 整场采样,写 <OUT>.cpuprofile 并
//     输出 top 自耗时行(联合场扩展宿主剖面,非仅增量)。
//   长会话轮数/轮间距可配:KODE_FIELD_ROUNDS(缺省 10)/KODE_FIELD_GAP_MS(缺省 5000)。
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Session } from 'node:inspector';
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
// 2026-10-28 审核重开:长会话足时长化(轮数×轮间距可配,缺省维持旧口径 10×5s,
// 验收跑用 KODE_FIELD_ROUNDS=18 KODE_FIELD_GAP_MS=20000 ≈ 6 分钟会话)。
const ROUNDS = Number(process.env.KODE_FIELD_ROUNDS ?? 10);
const GAP_MS = Number(process.env.KODE_FIELD_GAP_MS ?? 5000);
const OUT_FILE = process.env.KODE_FIELD_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-27-field-baseline-run.txt');

/** 激活返回的现场探针 API(见 extension.ts activate 返回值;禁用场无扩展=undefined) */
interface KodeFieldProbeApi {
  probeHover(
    target: { file: string; line: number; character: number },
    cancelAfterMs?: number,
    preCancel?: boolean
  ): Promise<{
    elapsedMs: number;
    cancelled: boolean;
    returnedHover: boolean;
    preview: string;
  }>;
  pendingWork(): {
    diagnosticsQueued: number;
    diagnosticsInFlight: number;
    annotationUpdates: number;
    indexTasksQueued: number;
    schemaColdBuilds: number;
  };
}

interface HitCandidate {
  id: string;
  file: string;
  needle: string;
  symbol: string;
}

const SYMBOL_FILE = 'scripts/common/training/mixins/combat.py';
const SYMBOL_NEEDLE = '# nav: runtime-damage';
const SYMBOL = 'compute_damage';

/** CPU profile 结构面(node:inspector Profiler.stop 返回值的所用子集) */
interface CpuProfileNode {
  hitCount: number;
  callFrame: { functionName: string; url: string };
}
interface CpuProfile {
  nodes: CpuProfileNode[];
}

const inspectorPost = <T>(session: Session, method: string, params?: object): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    session.post(method, params, (err: Error | null, result?: object) =>
      (err ? reject(err) : resolve(result as T)));
  });

/** 有效命中候选(2026-10-28 审核重开):def 方法声明(python)/def 文件/types.xml
 *  类型——覆盖 provideHover 的 def 方法注解面与 def/xml 文件面。 */
const HIT_CANDIDATES: HitCandidate[] = [
  { id: 'cell.reqAttack', file: 'scripts/cell/TrainingAvatar.py', needle: 'def reqAttack', symbol: 'reqAttack' },
  { id: 'base.reqEnterArena', file: 'scripts/base/TrainingAvatar.py', needle: 'def reqEnterArena', symbol: 'reqEnterArena' },
  { id: 'client.onBattleResult', file: 'scripts/client/TrainingAvatar.py', needle: 'def onBattleResult', symbol: 'onBattleResult' },
  { id: 'def.reqAttack', file: 'scripts/entity_defs/TrainingAvatar.def', needle: '<reqAttack>', symbol: 'reqAttack' },
  { id: 'types.ITEM_ID', file: 'scripts/entity_defs/types.xml', needle: '<ITEM_ID>', symbol: 'ITEM_ID' }
];

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

/** 命中候选点位:候选文件内 needle 行的 symbol 中部 */
async function candidatePosition(candidate: HitCandidate): Promise<vscode.Position> {
  const uri = vscode.Uri.file(path.join(WORKSPACE!, candidate.file));
  const document = await vscode.workspace.openTextDocument(uri);
  const lines = document.getText().split(/\r?\n/);
  const line = lines.findIndex(text => text.includes(candidate.needle));
  assert.ok(line >= 0, `missing ${candidate.needle} in ${candidate.file}`);
  const character = lines[line].indexOf(candidate.symbol);
  assert.ok(character >= 0, `missing ${candidate.symbol} in ${candidate.file}`);
  return new vscode.Position(line, character + Math.floor(candidate.symbol.length / 2));
}

async function hoverAt(position: vscode.Position, file: string = SYMBOL_FILE): Promise<vscode.Hover[]> {
  const raw = await vscode.commands.executeCommand<vscode.Hover[] | vscode.Hover | null>(
    'vscode.executeHoverProvider',
    vscode.Uri.file(path.join(WORKSPACE!, file)),
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
  let kodeApi: KodeFieldProbeApi | undefined;
  let profiler: Session | null = null;

  before(async function () {
    this.timeout(120_000);
    if (MODE === 'enabled') {
      const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
      assert.ok(extension, 'Kode extension is unavailable in the extension host');
      kodeApi = await extension.activate() as KodeFieldProbeApi | undefined;
    }
    // CPU profile(2026-10-28 审核重开):整场 1ms 采样,after() 写 <OUT>.cpuprofile
    profiler = new Session();
    profiler.connect();
    await inspectorPost(profiler, 'Profiler.enable');
    await inspectorPost(profiler, 'Profiler.setSamplingInterval', { interval: 1000 });
    await inspectorPost(profiler, 'Profiler.start');
    // 环境记录(现场口径:本机真 VS Code + 已装扩展)
    once('env.fieldRounds', ROUNDS, '');
    once('env.fieldGapMs', GAP_MS, '');
    once('env.probeApi', kodeApi ? 'available' : 'unavailable', '');
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
    // CPU profile:先停采样再拆其余监控,剖面覆盖整场(含所有测试)
    if (profiler) {
      try {
        const { profile } = await inspectorPost<{ profile: CpuProfile }>(profiler, 'Profiler.stop');
        fs.writeFileSync(`${OUT_FILE}.cpuprofile`, JSON.stringify(profile));
        once('host.cpuProfile.written', `${OUT_FILE}.cpuprofile`, '');
        const top = [...profile.nodes]
          .filter(node => node.hitCount > 0)
          .sort((a, b) => b.hitCount - a.hitCount)
          .slice(0, 10);
        top.forEach((node, i) => {
          const where = (node.callFrame.url || '').split('/').pop() ?? '';
          once(
            `host.cpuProfile.selfTop${i + 1}`,
            `${node.hitCount}ms ${node.callFrame.functionName || '(anonymous)'} ${where}`,
            ''
          );
        });
      } catch (error) {
        emit(`FIELD-EVIDENCE host.cpuProfile.error ${(error as Error).message}`);
      }
      profiler.disconnect();
      profiler = null;
    }
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
    // 与 definition 突发同口径的 hover 突发(响应性面;请求级取消另由 probeHover 探针覆盖)
    const beforeP99 = delay ? delay.percentile(99) : 0;
    const startedAt = performance.now();
    await Promise.all(Array.from({ length: 20 }, () => hoverAt(pos)));
    const wall = performance.now() - startedAt;
    const afterP99 = delay ? delay.percentile(99) : 0;
    once('joint.burstHover.20wallMs', Math.round(wall * 100) / 100);
    once('joint.burstHover.20hostP99BeforeMs', Math.round(beforeP99 / 1e6 * 100) / 100);
    once('joint.burstHover.20hostP99AfterMs', Math.round(afterP99 / 1e6 * 100) / 100);
  });

  // 2026-10-28 审核重开:请求级取消路径必须在命中探针之前执行——此时
  // def 方法注解面尚未被任何 hover 请求预热,梯次 cancelAfterMs 的取消
  // 更可能落在真实在途计算中,而非热缓存瞬时返回。热缓存下 hover 多为
  // 同步块完成(事件循环不释放,timer 插不进),故另设预取消面(确定性):
  // token 在 provider 调用前已取消,入口守卫必须零工作返回空。
  it('审核重开:hover 请求级取消路径(probeHover 梯次取消)', async function () {
    if (!kodeApi) { this.skip(); }
    this.timeout(60_000);
    const cancelCandidates = HIT_CANDIDATES.filter(c => c.file.endsWith('.py'));
    const delays = [0, 1, 2, 4, 8, 16];
    const results: Array<{ id: string; cancelAfterMs: number; elapsedMs: number; cancelled: boolean; returnedHover: boolean }> = [];
    for (const candidate of cancelCandidates) {
      const position = await candidatePosition(candidate);
      for (const cancelAfterMs of delays) {
        const result = await kodeApi.probeHover({
          file: path.join(WORKSPACE!, candidate.file),
          line: position.line,
          character: position.character
        }, cancelAfterMs);
        results.push({ id: candidate.id, cancelAfterMs, ...result });
        emit(
          `FIELD-EVIDENCE cancel.probe ${candidate.id} after=${cancelAfterMs}ms ` +
          `cancelled=${result.cancelled} returnedHover=${result.returnedHover} ` +
          `elapsed=${result.elapsedMs}ms`
        );
      }
    }
    const cancelledCount = results.filter(r => r.cancelled).length;
    const cancelledWithHover = results.filter(r => r.cancelled && r.returnedHover).length;
    once('cancel.probeCount', results.length, '');
    once('cancel.cancelledCount', cancelledCount, '');
    once('cancel.cancelledWithHover', cancelledWithHover, '');
    metric('cancel.elapsedMs', results.map(r => r.elapsedMs));
    assert.ok(results.every(r => r.elapsedMs < 5000), 'cancel probes must stay bounded');
    assert.strictEqual(cancelledWithHover, 0, 'cancelled probes must not return hover content');
    // 预取消面(确定性请求级取消):token 在 provider 调用前已取消——
    // 入口守卫必须零工作返回空,这是 VS Code 快速输入/失焦时递给 provider
    // 的真实取消语义面。
    for (const candidate of cancelCandidates) {
      const position = await candidatePosition(candidate);
      const result = await kodeApi.probeHover({
        file: path.join(WORKSPACE!, candidate.file),
        line: position.line,
        character: position.character
      }, undefined, true);
      emit(
        `FIELD-EVIDENCE cancel.preCancelled ${candidate.id} ` +
        `cancelled=${result.cancelled} returnedHover=${result.returnedHover} ` +
        `elapsed=${result.elapsedMs}ms`
      );
      assert.ok(result.cancelled, `pre-cancelled probe must report cancelled (${candidate.id})`);
      assert.ok(!result.returnedHover, `pre-cancelled probe must return no hover (${candidate.id})`);
    }
    once('cancel.preCancelledCount', cancelCandidates.length, '');
  });

  it('审核重开:有效命中探针 + 内部命中证据', async function () {
    if (!kodeApi) { this.skip(); }
    this.timeout(60_000);
    const hits: string[] = [];
    for (const candidate of HIT_CANDIDATES) {
      const position = await candidatePosition(candidate);
      const result = await kodeApi.probeHover({
        file: path.join(WORKSPACE!, candidate.file),
        line: position.line,
        character: position.character
      });
      once(`hit.probe.${candidate.id}`, result.returnedHover ? 'HIT' : 'MISS', '');
      once(`hit.probe.${candidate.id}.elapsedMs`, result.elapsedMs);
      if (result.preview) {
        emit(`FIELD-EVIDENCE hit.probe.${candidate.id}.preview ${result.preview.slice(0, 80)}`);
      }
      if (result.returnedHover) { hits.push(candidate.id); }
    }
    assert.ok(
      hits.length >= 1,
      `expected at least one hover hit among candidates, got: ${hits.join(',') || 'none'}`
    );
    // 内部命中证据(非墙钟空转):公开 executeHoverProvider 于命中点位 20 连发,
    // Kode 侧 hover 指标 ok(返回了内容的请求)计数必须增长
    const hitting = HIT_CANDIDATES.find(c => c.id === hits[0])!;
    const position = await candidatePosition(hitting);
    const okBefore = getOperationSummary('hover')?.statusCounts.ok ?? 0;
    const burstSamples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      await hoverAt(position, hitting.file);
      burstSamples.push(performance.now() - t0);
    }
    const okAfter = getOperationSummary('hover')?.statusCounts.ok ?? 0;
    metric('hit.burstHoverMs', burstSamples);
    once('hit.burstHover.okBefore', okBefore, '');
    once('hit.burstHover.okDelta', okAfter - okBefore, '');
    assert.ok(okAfter - okBefore > 0, 'expected hover ok count to grow on hitting-position burst');
  });

  it('审核重开:取消/保存风暴后残留任务量规排干', async function () {
    if (!kodeApi) { this.skip(); }
    this.timeout(60_000);
    // 取消风暴:20 路并发梯次取消(在途请求面)+ 保存风暴(诊断/注解去抖面)
    const cancelCandidates = HIT_CANDIDATES.filter(c => c.file.endsWith('.py'));
    const positions = new Map<string, vscode.Position>();
    for (const candidate of cancelCandidates) {
      positions.set(candidate.id, await candidatePosition(candidate));
    }
    await Promise.all(Array.from({ length: 20 }, (_, i) => {
      const candidate = cancelCandidates[i % cancelCandidates.length];
      const position = positions.get(candidate.id)!;
      return kodeApi!.probeHover({
        file: path.join(WORKSPACE!, candidate.file),
        line: position.line,
        character: position.character
      }, (i % 5) * 2);
    }));
    const uri = vscode.Uri.file(path.join(WORKSPACE!, SYMBOL_FILE));
    const document = await vscode.workspace.openTextDocument(uri);
    for (let i = 0; i < 5; i += 1) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(0, 0), `# residual-storm ${i}\n`);
      await vscode.workspace.applyEdit(edit);
      await document.save();
    }
    const sample = (tag: string) => {
      const work = kodeApi!.pendingWork();
      emit(
        `FIELD-EVIDENCE residual.${tag} diagQueued=${work.diagnosticsQueued} ` +
        `diagInFlight=${work.diagnosticsInFlight} annotationUpdates=${work.annotationUpdates} ` +
        `indexQueued=${work.indexTasksQueued} schemaColdBuilds=${work.schemaColdBuilds}`
      );
      return work;
    };
    sample('t0');
    await new Promise(resolve => setTimeout(resolve, 500));
    sample('t500');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const drained = sample('t2000');
    // 交互面残留必须排干:诊断排队/在途、编辑去抖注解归零
    assert.strictEqual(drained.diagnosticsQueued, 0, 'diagnostics queue must drain');
    assert.strictEqual(drained.diagnosticsInFlight, 0, 'in-flight diagnostics must drain');
    assert.strictEqual(drained.annotationUpdates, 0, 'annotation updates must drain');
    // 背景队列如实记录不设断言(冷扫描/低优任务在长会话中合法持有工作)
    once('residual.indexTasksQueuedAtDrain', drained.indexTasksQueued, '');
    once('residual.schemaColdBuildsAtDrain', drained.schemaColdBuilds, '');
  });

  // P0-4c 长会话(2026-10-28 审核重开:轮数/轮间距可配足时长化):
  // 热态场景轮转,轮间保存+定距间隔(背景索引持续在场),逐轮记录 hover/def
  // 分位与宿主 RSS,观察指标不随会话时长劣化。
  for (let round = 1; round <= ROUNDS; round += 1) {
    it(`P0-4c 长会话第 ${round} 轮`, async function () {
      if (!JOINT) { this.skip(); }
      this.timeout(120_000);
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
      await new Promise(resolve => setTimeout(resolve, GAP_MS));
      once(`session.r${round}.rssMiB`, Math.round(process.memoryUsage().rss / 1024 / 1024), '');
    });
  }
});
