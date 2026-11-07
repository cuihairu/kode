/**
 * 真实 watcher 路径查询联验执行面(IDE-LIV-003):对可启动的真实引擎
 * 组件发起一次 watcher 路径查询,把原始回包帧、组件身份、请求时刻与
 * 协议引据(审计表 LIV-002 的引擎 commit+源码文件行)固化成证据记录;
 * reconcileWatcherEvidence 把面板口径行(watcherResultRows)与引擎控制台
 * 侧参考值逐路径对账——一致/不一致都点名,不吻合绝不写成一致。本模块
 * 只做执行与记录:发现组件仍走 discoverLocalComponents,渲染仍在面板。
 */

import {
  WATCHER_MESSAGE_PROTOCOL_AUDIT,
  WATCHER_PROTOCOL_AUDIT_VERSION
} from './watcherProtocolAudit';
import type { RuntimeQueryProtocol, WatcherResultRow } from './runtimeQueryWebView';
import { watcherResultRows } from './runtimeQueryWebView';
import { COMPONENT_NAMES, type KBEngineComponentInfo, type WatcherQueryResult } from './kbengineProtocol';

/** 联验证据里的组件身份段(全部来自广播发现的真实值,不猜) */
export interface LiveVerificationIdentity {
  componentType: number;
  componentName: string;
  componentID: string;
  fullName: string;
  address: string;
  pid: number;
}

export interface LiveWatcherVerificationRecord {
  kind: 'watcher';
  identity: LiveVerificationIdentity;
  path: string;
  /** 原始回包帧(解析层产物,保线序不重排)——联验证据的原始面 */
  frames: WatcherQueryResult[];
  /** 面板口径行(与 runtimeQueryWebView 表格同源) */
  rows: WatcherResultRow[];
  queriedAt: string;
  ok: boolean;
  error?: string;
  /** 协议引据:请求号/回包号的引擎源码出处(LIV-002 审计表) */
  protocolSource: string;
}

/** 组件身份只取发现结果的真实字段,不合成 */
export function liveVerificationIdentity(component: KBEngineComponentInfo): LiveVerificationIdentity {
  return {
    componentType: component.componentType,
    componentName: COMPONENT_NAMES[component.componentType] ?? `component_${component.componentType}`,
    componentID: component.componentID.toString(),
    fullName: component.fullName,
    address: `${component.intaddr}:${component.intport}`,
    pid: component.pid
  };
}

/** 请求号引据(LIV-002 审计表),组件类型不在审计表时如实说明 */
export function watcherProtocolSourceFor(componentType: number): string {
  const entry = WATCHER_MESSAGE_PROTOCOL_AUDIT.find(candidate => candidate.componentType === componentType);
  if (!entry) {
    return `组件类型 ${componentType} 不在 watcher 协议审计表(WATCHER_MESSAGE_PROTOCOL_AUDIT),未发请求`;
  }
  return `${entry.requestSource};回包 65502 kbe/src/lib/helper/console_helper.h:11;引擎 ${WATCHER_PROTOCOL_AUDIT_VERSION.repoUrl}@${WATCHER_PROTOCOL_AUDIT_VERSION.commit}`;
}

/**
 * 执行一次真实 watcher 路径查询并固化证据。protocol 注入(测试传仿真,
 * 真机联验传 defaultRuntimeQueryProtocol);查询抛错如实记 ok=false,
 * 绝不伪造帧。
 */
export async function runLiveWatcherPathVerification(
  protocol: Pick<RuntimeQueryProtocol, 'queryWatcherPath'>,
  component: KBEngineComponentInfo,
  path: string,
  timeoutMs = 1200
): Promise<LiveWatcherVerificationRecord> {
  const identity = liveVerificationIdentity(component);
  const protocolSource = watcherProtocolSourceFor(component.componentType);
  try {
    const frames = await protocol.queryWatcherPath(component, path, timeoutMs);
    return {
      kind: 'watcher',
      identity,
      path,
      frames,
      rows: watcherResultRows(frames),
      queriedAt: new Date().toISOString(),
      ok: true,
      protocolSource
    };
  } catch (error) {
    return {
      kind: 'watcher',
      identity,
      path,
      frames: [],
      rows: [],
      queriedAt: new Date().toISOString(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      protocolSource
    };
  }
}

/** 单路径对账结果:一致/不一致/缺参考,三种都如实点名 */
export interface WatcherReconciliationLine {
  path: string;
  panelValue: string;
  referenceValue?: string;
  verdict: 'match' | 'mismatch' | 'no-reference';
}

export interface WatcherReconciliation {
  ok: boolean;
  lines: WatcherReconciliationLine[];
}

/**
 * 面板口径行 ↔ 引擎控制台侧参考值逐路径对账。reference 键=全路径,
 * 值=引擎侧同路径读数(控制台/第二实现采集);面板行里 kind!=='value'
 * (目录项)没有读数,不参与对账。
 */
export function reconcileWatcherEvidence(
  record: LiveWatcherVerificationRecord,
  reference: Record<string, string>
): WatcherReconciliation {
  const lines: WatcherReconciliationLine[] = [];
  for (const row of record.rows) {
    if (row.kind !== 'value') {
      continue;
    }
    const referenceValue = reference[row.path];
    if (referenceValue === undefined) {
      lines.push({ path: row.path, panelValue: row.value, verdict: 'no-reference' });
      continue;
    }
    lines.push({
      path: row.path,
      panelValue: row.value,
      referenceValue,
      verdict: row.value === referenceValue ? 'match' : 'mismatch'
    });
  }
  return { ok: lines.every(line => line.verdict === 'match'), lines };
}

/** 证据文本(逐行可入档 docs/evidence;原始帧值全保留) */
export function formatLiveWatcherEvidence(
  record: LiveWatcherVerificationRecord,
  reconciliation?: WatcherReconciliation
): string {
  const lines: string[] = [];
  lines.push(`[LIV-003] watcher 路径联验 ${record.queriedAt}`);
  lines.push(
    `组件身份: ${record.identity.fullName} (type=${record.identity.componentType}/${record.identity.componentName}, id=${record.identity.componentID}, pid=${record.identity.pid}, addr=${record.identity.address})`
  );
  lines.push(`查询路径: ${record.path} → ok=${record.ok}${record.error ? ` error=${record.error}` : ''}`);
  for (const frame of record.frames) {
    lines.push(
      `原始帧: type=${frame.type} path='${frame.path}' values=${JSON.stringify(frame.values)} keys=${JSON.stringify(frame.keys)}`
    );
  }
  for (const row of record.rows) {
    lines.push(`面板行: ${row.path} kind=${row.kind}${row.kind === 'value' ? ` value=${row.value}` : ''}`);
  }
  lines.push(`协议引据: ${record.protocolSource}`);
  if (reconciliation) {
    for (const line of reconciliation.lines) {
      const verdictText =
        line.verdict === 'match'
          ? '一致'
          : line.verdict === 'mismatch'
            ? `不一致(引擎控制台参考=${line.referenceValue})`
            : '无引擎控制台参考(未对账)';
      lines.push(`对账: ${line.path} 面板=${line.panelValue} → ${verdictText}`);
    }
    lines.push(`对账结论: ${reconciliation.ok ? '全部一致' : '存在不一致/缺参考'}`);
  }
  return lines.join('\n');
}
