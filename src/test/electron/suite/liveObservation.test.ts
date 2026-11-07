/**
 * IDE-LIV-003..007 真机联验套件(--live):对一台真实运行的 KBEngine
 * (组件发现/watcher/spaces 全走生产协议实现)逐项取证:
 * ① LIV-003 真实 watcher 路径查询——面板口径(runLiveWatcherPathVerification,
 *   与 runtimeQueryWebView 同一 queryWatcherPath 实现)两轮独立查询,目录键
 *   与两轮不变的叶子值逐路径对账,原始帧全量入证据;
 * ② LIV-004 真实空间列表查询——cellappmgr 的 spaces 快照与广播发现的
 *   cellapp 组件身份对账,缺失字段标未知;
 * ③ LIV-005 稳定目标身份——同类型两个实例(componentType 相同、componentID
 *   不同)的观测点按 type:id 分桶,数值互不混合;
 * ④ LIV-006 断连恢复——真实成功→live,对不可达地址的失败轮→stale(旧值
 *   时刻保留),再真实成功→恢复 live;
 * ⑤ LIV-007 运行异常→源码定位——从引擎日志原始行解析 file:line,在打开的
 *   工作区里解析到真实文件并跳转(无源码/不可解析则如实保留原始信息)。
 * 引擎不可达或日志缺异常行时,对应阶段如实记「未测」,不冒充已联验。
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { after, before, describe, it } from 'mocha';
import * as assert from 'assert';
import {
  CONSOLE_WATCHER_CB_MSG_ID,
  buildCString,
  buildFrame,
  discoverLocalComponents,
  parseWatcherFrame,
  queryWatcherPath,
  WATCHER_QUERY_MSG_IDS,
  type KBEngineComponentInfo
} from '../../../kbengineProtocol';
import { defaultRuntimeQueryProtocol } from '../../../runtimeQueryWebView';
import {
  formatLiveWatcherEvidence,
  reconcileWatcherEvidence,
  runLiveWatcherPathVerification
} from '../../../liveWatcherVerification';
import { formatLiveSpacesEvidence, runLiveSpacesVerification } from '../../../liveSpacesVerification';
import {
  groupObservationsByTarget,
  observationTargetFor,
  observationsFromRound,
  describeObservationTarget
} from '../../../observationIdentity';
import {
  createObservationFreshnessTracker,
  describeObservationFreshness
} from '../../../observationConnectionState';
import {
  formatUnresolvedException,
  parseExceptionSourceLocation,
  resolveExceptionSource
} from '../../../exceptionSourceLocator';

const evidenceLines: string[] = [];
const evidenceOut = process.env.KODE_LIV_OUT ?? path.resolve(__dirname, '../../../docs/perf/liv-observation-run.txt');

/** 独立参考客户端:raw socket 直接对引擎 console 通道发 queryWatcher(与生产
 * queryWatcherPath 分开实现,做「引擎控制台同路径值」的参考侧) */
function referenceWatcherQuery(
  component: KBEngineComponentInfo,
  msgId: number,
  watcherPath: string,
  timeoutMs = 1200
): Promise<{ type: number; path: string; values: Record<string, string | number | boolean>; keys: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('reference query timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      socket.write(buildFrame(msgId, buildCString(watcherPath)));
    });
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const frameId = buffer.readUInt16LE(0);
        const frameLen = buffer.readUInt16LE(2);
        if (buffer.length < 4 + frameLen) break;
        const body = buffer.subarray(4, 4 + frameLen);
        buffer = buffer.subarray(4 + frameLen);
        if (frameId === CONSOLE_WATCHER_CB_MSG_ID) {
          clearTimeout(timer);
          socket.destroy();
          resolve(parseWatcherFrame(body));
          return;
        }
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
    socket.connect(component.intport, component.intaddr);
  });
}

describe('IDE-LIV 真机运行观测联验', function () {
  this.timeout(120000);
  let components: KBEngineComponentInfo[] = [];

  before(async function () {
    evidenceLines.push(`[LIV] 真机联验开始 ${new Date().toISOString()}`);
    try {
      // 真机可在异机时,发现地址经 KODE_LIV_DISCOVERY_HOST 覆盖(默认 127.0.0.1,
      // 与 machine 广播口同机直查;异机跑套件的前提是对端 20086/udp 可达)
      components = await discoverLocalComponents({
        host: process.env.KODE_LIV_DISCOVERY_HOST || '127.0.0.1',
        timeoutMs: 2000
      });
    } catch (error) {
      components = [];
      evidenceLines.push(`发现失败:${error instanceof Error ? error.message : String(error)}`);
    }
    evidenceLines.push(
      `发现组件(${components.length}): ${components
        .map(c => `${c.fullName}(type=${c.componentType},id=${c.componentID.toString()},pid=${c.pid},addr=${c.intaddr}:${c.intport})`)
        .join('; ')}`
    );
  });

  it('LIV-003 真实 watcher 路径查询:面板口径与引擎参考逐路径一致', async function () {
    const cellapp = components.find(c => c.componentType === 5);
    if (!cellapp) {
      evidenceLines.push('LIV-003: 未测(缺可启动 cellapp 实例)');
      this.skip();
    }
    const msgId = WATCHER_QUERY_MSG_IDS[cellapp.componentType];
    const record = await runLiveWatcherPathVerification(defaultRuntimeQueryProtocol, cellapp, '/cellapp', 1200);
    assert.ok(record.ok, `watcher 查询失败:${record.error}`);
    evidenceLines.push(formatLiveWatcherEvidence(record));

    // 参考侧:独立 raw socket 客户端查同路径(引擎控制台通道)
    const reference = await referenceWatcherQuery(cellapp, msgId, '/cellapp');
    evidenceLines.push(
      `参考侧(raw socket): type=${reference.type} path='${reference.path}' keys=${JSON.stringify(reference.keys)} values=${JSON.stringify(reference.values)}`
    );

    const referenceValues: Record<string, string> = {};
    for (const key of reference.keys) {
      referenceValues[key] = key;
    }
    for (const [name, value] of Object.entries(reference.values)) {
      referenceValues[`${reference.path}/${name}`.replace(/^\/\//, '/')] = String(value);
    }
    const reconciliation = reconcileWatcherEvidence(record, referenceValues);
    // 目录键必须逐路径一致;叶子读数若两轮之间引擎值变化,如实记 mismatch
    const dirLines = reconciliation.lines.filter(line => record.rows.find(row => row.path === line.path && row.kind === 'child'));
    for (const line of dirLines) {
      assert.strictEqual(line.verdict, 'match', `目录键不一致:${line.path} 面板=${line.panelValue} 参考=${line.referenceValue}`);
    }
    evidenceLines.push(
      `LIV-003 对账: 目录键 ${dirLines.length} 条全部一致; 叶子 ${reconciliation.lines.length - dirLines.length} 条(引擎实时计数,逐条 verdict 见证据行)`
    );
    evidenceLines.push('LIV-003 结论: 已测,目录键面板↔引擎参考逐路径一致');
  });

  it('LIV-004 真实空间列表查询:空间与组件身份可与运行引擎对账', async function () {
    const manager = components.find(c => c.componentType === 4);
    if (!manager) {
      evidenceLines.push('LIV-004: 未测(缺 cellappmgr 实例)');
      this.skip();
    }
    const record = await runLiveSpacesVerification(defaultRuntimeQueryProtocol, manager, components, 1200);
    assert.ok(record.ok, `spaces 查询失败:${record.error}`);
    evidenceLines.push(formatLiveSpacesEvidence(record));
    if (record.snapshots.length > 0) {
      for (const snapshot of record.snapshots) {
        assert.strictEqual(
          snapshot.cellappVerdict,
          'matched',
          `空间 ${snapshot.spaceID} 的 cellappID=${snapshot.cellappID} 不在广播发现的 cellapp 组件里`
        );
      }
      evidenceLines.push('LIV-004 结论: 已测,快照 cellappID 与发现身份逐条对账一致');
    } else {
      evidenceLines.push('LIV-004 结论: 已测(引擎无活跃空间快照,查询通道验证通过,缺失字段口径见「未知」标记)');
    }
  });

  it('LIV-005 稳定目标身份:同类型两实例观测点分桶不混值', async function () {
    const cellapps = components.filter(c => c.componentType === 5);
    if (cellapps.length < 2) {
      evidenceLines.push('LIV-005: 未测(运行引擎中同类型实例不足 2 个)');
      this.skip();
    }
    // 真实读数:两个 cellapp 各查一次 uptime,按稳定身份归组
    const readings = [];
    const readValues: Array<{ target: ReturnType<typeof observationTargetFor>; value: number }> = [];
    for (const cellapp of cellapps.slice(0, 2)) {
      const frames = await queryWatcherPath(cellapp, '/cellapp/uptime', 1200);
      const value = Number(frames.find(frame => frame.type === 0)?.values['uptime'] ?? NaN);
      readValues.push({ target: observationTargetFor(cellapp), value });
      readings.push({ component: cellapp, values: { '/cellapp/uptime': value } });
    }
    const points = observationsFromRound(readings, new Date().toISOString());
    const groups = groupObservationsByTarget(points);
    const keys = [...groups.keys()].sort();
    assert.strictEqual(keys.length, 2, `同类型两实例必须分两桶,实得 ${keys.length} 桶:${keys.join(',')}`);
    assert.notEqual(keys[0], keys[1]);
    for (const [key, bucket] of groups) {
      assert.strictEqual(bucket.length, 1, `桶 ${key} 应只含本实例的观测点`);
      assert.strictEqual(bucket[0].target.targetKey, key);
    }
    evidenceLines.push(
      `LIV-005 结论: 已测; ${describeObservationTarget(readValues[0].target)} uptime=${readValues[0].value} 与 ${describeObservationTarget(readValues[1].target)} uptime=${readValues[1].value} 分属 ${keys.join('/')} 两桶,零混值`
    );
  });

  it('LIV-006 断连恢复:失败轮标过期旧值,重连成功恢复实时', async function () {
    const cellapp = components.find(c => c.componentType === 5);
    if (!cellapp) {
      evidenceLines.push('LIV-006: 未测(缺 cellapp 实例)');
      this.skip();
    }
    const tracker = createObservationFreshnessTracker(() => new Date().toISOString());
    const target = observationTargetFor(cellapp);
    // ① 真实成功一轮 → live
    await queryWatcherPath(cellapp, '/cellapp', 1200);
    tracker.recordRound(target, true);
    const live = tracker.view(target.targetKey)!;
    assert.strictEqual(live.state, 'live');
    // ② 对不可达地址的真实失败轮 → stale,旧值时刻保留
    const unreachable: KBEngineComponentInfo = { ...cellapp, intaddr: '127.0.0.1', intport: 1 };
    let failed = false;
    try {
      await queryWatcherPath(unreachable, '/cellapp', 500);
    } catch {
      failed = true;
    }
    tracker.recordRound(target, false);
    const stale = tracker.view(target.targetKey)!;
    assert.strictEqual(stale.state, 'stale', '失败轮后必须标过期');
    assert.ok(stale.lastSuccessAt, '过期态必须保留旧值取值时刻');
    assert.ok(failed, '不可达地址查询应真实失败');
    // ③ 再真实成功 → 恢复 live
    await queryWatcherPath(cellapp, '/cellapp', 1200);
    tracker.recordRound(target, true);
    const restored = tracker.view(target.targetKey)!;
    assert.strictEqual(restored.state, 'live', '重连真实成功后必须恢复实时');
    assert.ok(Date.parse(restored.lastSuccessAt ?? '') > Date.parse(stale.lastFailureAt ?? ''), '恢复时刻必须晚于断连时刻');
    evidenceLines.push(
      `LIV-006 结论: 已测; live(${describeObservationFreshness(live)}) → 断连(${describeObservationFreshness(stale)}) → 恢复(${describeObservationFreshness(restored)})`
    );
  });

  it('LIV-007 运行异常关联源码定位:真实日志行跳转工作区文件', async function () {
    const logDir = process.env.KODE_LIV_ENGINE_LOG_DIR;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!logDir || !workspaceRoot) {
      evidenceLines.push('LIV-007: 未测(缺引擎日志目录或工作区装配)');
      this.skip();
    }
    // 从引擎日志里找带 File "…" line N 的真实异常行
    let rawLine: string | null = null;
    for (const name of fs.readdirSync(logDir)) {
      if (!name.endsWith('.txt')) continue;
      const text = fs.readFileSync(path.join(logDir, name), 'utf8');
      const match = text.split('\n').find(line => /File\s+"/.test(line));
      if (match) {
        rawLine = match.trim();
        evidenceLines.push(`LIV-007 引擎日志来源: ${name} ${rawLine}`);
        break;
      }
    }
    if (!rawLine) {
      evidenceLines.push('LIV-007: 未测(引擎日志中无带 file:line 的异常行)');
      this.skip();
    }
    const location = parseExceptionSourceLocation(rawLine!);
    assert.ok(location, `真实异常行应可解析:${rawLine}`);
    evidenceLines.push(`LIV-007 解析: file=${location!.file} line=${location!.line} qualifier=${location!.qualifier}`);
    const resolved = resolveExceptionSource([workspaceRoot], location!);
    assert.ok(resolved, `异常文件在工作区应可解析:${location!.file}`);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved!.absolutePath));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const targetLine = Math.max(0, Math.min(location!.line - 1, document.lineCount - 1));
    assert.strictEqual(editor.selection.active.line, targetLine, '跳转后光标应落在异常行');
    evidenceLines.push(
      `LIV-007 结论: 已测; ${location!.file}:${location!.line} → ${resolved!.absolutePath} 光标行=${editor.selection.active.line + 1}(1 基)`
    );
    // 无源码面:把解析出的文件行指向一个不存在的文件,必须保留原始信息而不是猜
    const unresolved = resolveExceptionSource(
      [workspaceRoot],
      parseExceptionSourceLocation('File "scripts/base/LIV7Ghost.py", line 9, in nowhere')!
    );
    assert.strictEqual(unresolved, null, '工作区不存在的文件不得给出落点');
    evidenceLines.push(
      `LIV-007 无源码面: ${formatUnresolvedException('File "scripts/base/LIV7Ghost.py", line 9, in nowhere', parseExceptionSourceLocation('File "scripts/base/LIV7Ghost.py", line 9, in nowhere'))}`
    );
  });

  after(function () {
    evidenceLines.push(`[LIV] 真机联验结束 ${new Date().toISOString()}`);
    fs.mkdirSync(path.dirname(evidenceOut), { recursive: true });
    fs.writeFileSync(evidenceOut, `${evidenceLines.join('\n')}\n`);
  });
});
