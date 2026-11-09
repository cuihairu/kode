/**
 * 真实空间列表查询联验执行面(IDE-LIV-004):对运行中的 cellappmgr 发起
 * 一次 Cellappmgr::querySpaces(50003),把空间快照与组件身份固化成证据;
 * 对账面=每个快照的 cellappID 必须能在广播发现的 cellapp 组件身份里找
 * 到(对得上/对不上都点名),geomappingPath / scriptModuleName / cells
 * 缺失时如实标「未知」,绝不猜邻居值。引擎依据:请求号 50003 出自
 * messages_fixed_defaults.xml <Cellappmgr::querySpaces><id>50003,回包
 * 走 CONSOLE_PROFILE_CB 通道(65503)。
 */

import { CELLAPPMGR_QUERY_SPACES_MSG_ID, COMPONENT_NAMES, type KBEngineComponentInfo, type SpaceQueryResult } from './backend/kbengineProtocol';
import type { RuntimeQueryProtocol } from './runtimeQueryWebView';
import { liveVerificationIdentity, type LiveVerificationIdentity } from './liveWatcherVerification';
import { WATCHER_PROTOCOL_AUDIT_VERSION } from './watcherProtocolAudit';

/** 缺失字段的统一标记:显式「未知」,不是空串也不是猜测值 */
export const SPACES_UNKNOWN_FIELD = '未知';

export interface LiveSpaceSnapshotRecord {
  spaceID: string;
  cellappID: string;
  geomappingPath: string;
  scriptModuleName: string;
  cells: string;
  /** 组件身份对账结果:cellappID 在发现的 cellapp 组件里=matched,否则 unknown-cellapp */
  cellappVerdict: 'matched' | 'unknown-cellapp';
  /** matched 时填对账到的 cellapp 身份(fullName@addr);未对上时不填不猜 */
  matchedCellapp?: string;
}

export interface LiveSpacesVerificationRecord {
  kind: 'spaces';
  /** cellappmgr 自身身份(查询目标) */
  manager: LiveVerificationIdentity;
  snapshots: LiveSpaceSnapshotRecord[];
  /** 原始查询结果(解析层产物,保线序) */
  raw: SpaceQueryResult;
  queriedAt: string;
  ok: boolean;
  error?: string;
  protocolSource: string;
}

export function spacesProtocolSource(): string {
  // 请求号直引 kbengineProtocol 的已核对常量(50003),不在本模块重抄
  return `kbe/res/server/messages_fixed_defaults.xml <Cellappmgr::querySpaces><id>${CELLAPPMGR_QUERY_SPACES_MSG_ID};回包 65503 kbe/src/lib/helper/console_helper.h;引擎 ${WATCHER_PROTOCOL_AUDIT_VERSION.repoUrl}@${WATCHER_PROTOCOL_AUDIT_VERSION.commit}`;
}

/**
 * 执行一次真实空间列表查询并固化证据。discoveredComponents=同轮广播
 * 发现的全部组件(对账用);查询抛错如实记 ok=false,不伪造快照。
 */
export async function runLiveSpacesVerification(
  protocol: Pick<RuntimeQueryProtocol, 'querySpaces'>,
  cellappmgr: KBEngineComponentInfo,
  discoveredComponents: KBEngineComponentInfo[],
  timeoutMs = 1200
): Promise<LiveSpacesVerificationRecord> {
  const manager = liveVerificationIdentity(cellappmgr);
  const protocolSource = spacesProtocolSource();
  try {
    const raw = await protocol.querySpaces(cellappmgr, timeoutMs);
    const cellapps = discoveredComponents.filter(component => component.componentType === 5);
    const snapshots = raw.spaces.map(space => {
      const matched = cellapps.find(
        component => component.componentID.toString() === space.cellappID.toString()
      );
      return {
        spaceID: space.spaceID >= 0 ? String(space.spaceID) : SPACES_UNKNOWN_FIELD,
        cellappID: space.cellappID.toString(),
        geomappingPath: space.geomappingPath || SPACES_UNKNOWN_FIELD,
        scriptModuleName: space.scriptModuleName || SPACES_UNKNOWN_FIELD,
        cells: space.cells.length > 0 ? space.cells.join(',') : SPACES_UNKNOWN_FIELD,
        cellappVerdict: matched ? ('matched' as const) : ('unknown-cellapp' as const),
        ...(matched
          ? {
              matchedCellapp: `${COMPONENT_NAMES[matched.componentType] ?? '?'}${matched.groupOrderID}@${matched.intaddr}:${matched.intport}`
            }
          : {})
      };
    });
    return {
      kind: 'spaces',
      manager,
      snapshots,
      raw,
      queriedAt: new Date().toISOString(),
      ok: true,
      protocolSource
    };
  } catch (error) {
    return {
      kind: 'spaces',
      manager,
      snapshots: [],
      raw: { componentType: cellappmgr.componentType, componentID: cellappmgr.componentID, spaces: [] },
      queriedAt: new Date().toISOString(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      protocolSource
    };
  }
}

/** 证据文本(逐行可入档;缺失字段显式「未知」) */
export function formatLiveSpacesEvidence(record: LiveSpacesVerificationRecord): string {
  const lines: string[] = [];
  lines.push(`[LIV-004] 空间列表联验 ${record.queriedAt}`);
  lines.push(
    `查询目标身份: ${record.manager.fullName} (type=${record.manager.componentType}/${record.manager.componentName}, id=${record.manager.componentID}, addr=${record.manager.address})`
  );
  if (!record.ok) {
    lines.push(`查询失败: ${record.error}(未伪造快照)`);
  }
  for (const snapshot of record.snapshots) {
    const verdictText =
      snapshot.cellappVerdict === 'matched'
        ? `cellapp 对账一致(${snapshot.matchedCellapp})`
        : 'cellapp 对不上:发现的 cellapp 组件里没有该 cellappID → 标未知归属';
    lines.push(
      `空间: spaceID=${snapshot.spaceID} cellappID=${snapshot.cellappID} geomapping=${snapshot.geomappingPath} scriptModule=${snapshot.scriptModuleName} cells=${snapshot.cells} → ${verdictText}`
    );
  }
  lines.push(`协议引据: ${record.protocolSource}`);
  lines.push(`快照数: ${record.snapshots.length}`);
  return lines.join('\n');
}

export type { LiveVerificationIdentity };
