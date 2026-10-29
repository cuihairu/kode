/**
 * 漂移校验证据接线(IDE-REV-020):把 databaseDriftEvidence 的记录/分类
 * 接到真实 drift 报告——只有真实执行(checked=true,确实查询过库)才落
 * 证据;未校验不落(无可信查询面,模拟面单独存在也不冒充联调结果)。
 * 引擎版本经注入探测(null=探不到,记 'unknown'——分类面按
 * unknown-version 悬置结论,不宣称兼容)。重查面按版本渲染已存证据,
 * 结论一律走 classifyDriftEvidence,渲染层不另判。
 */

import {
  classifyDriftEvidence,
  type DriftEvidenceRecord,
  type DriftEvidenceVerdict
} from './databaseDriftEvidence';
import type { DriftReport } from './databaseDrift';

/** workspaceState 持久化键(与 DATABASE_CONNECTIONS_STATE_KEY 同形) */
export const DRIFT_EVIDENCE_STATE_KEY = 'kbengine.databaseDriftEvidence.v1';

export interface DriftEvidenceRecordingDeps {
  /** 引擎版本探测(null=探不到);口径与 engineCompatibility 的版本宏读取一致 */
  resolveEngineVersion(): string | null;
  now(): number;
}

/**
 * 真实执行 → 证据记录:queried 面写实查摘要,simulated 面明示 def 推导
 * 基准(非实测)。未校验(checked=false,连不上/读表失败)返回 null——
 * 无可信查询面就不落证据,不拿纯模拟面冒充联调结果。
 */
export function recordDriftEvidenceFromReport(
  report: DriftReport,
  deps: DriftEvidenceRecordingDeps
): DriftEvidenceRecord | null {
  if (!report.checked) {
    return null;
  }
  return {
    engineVersion: deps.resolveEngineVersion() ?? 'unknown',
    queried: {
      summary: `真实查询 ${report.databaseName}:${report.entityName},发现 ${report.findings.length} 项`
    },
    simulated: {
      summary: `def 推导虚拟 schema ${report.entityName}(对比基准面,非实测)`
    },
    driftSummary:
      report.findings.length === 0
        ? ''
        : `${report.findings.length} 项:${report.findings
            .map(finding => finding.message)
            .slice(0, 3)
            .join(';')}${report.findings.length > 3 ? '…' : ''}`,
    recordedAt: deps.now()
  };
}

/** 重查渲染:每版本一条,结论经 classifyDriftEvidence(不另判) */
export function renderDriftEvidenceRecords(records: readonly DriftEvidenceRecord[]): string {
  if (records.length === 0) {
    return [
      '===== KBEngine 漂移校验证据 =====',
      '(尚无已保存证据——真实执行 checkDrift / checkAllDrift 后按引擎版本落证据;未校验与纯模拟面不落)'
    ].join('\n');
  }
  const lines = ['===== KBEngine 漂移校验证据 =====', ''];
  for (const record of records) {
    const verdict = classifyDriftEvidence(record);
    lines.push(`引擎版本 ${record.engineVersion} → ${verdict.verdict}`);
    lines.push(`  结论:${verdict.detail}`);
    lines.push(`  实际查询面:${record.queried?.summary ?? '无(未连接——纯模拟面,未验证)'}`);
    lines.push(`  模拟 schema 面:${record.simulated.summary}`);
    lines.push(`  记录时间:${new Date(record.recordedAt).toISOString()}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** 真实执行落证据后的通道尾行:带结论与重查入口 */
export function formatDriftEvidenceSaveLine(
  record: DriftEvidenceRecord,
  verdict: DriftEvidenceVerdict
): string {
  return `证据已按引擎版本 ${record.engineVersion} 保存:${verdict.verdict}(${verdict.detail});kbengine.database.showDriftEvidence 可重新查看`;
}

/** 未校验的通道尾行:如实说明不落证据的原因 */
export function formatDriftEvidenceSkipLine(reason: string): string {
  return `本次未校验(${reason}),不落证据——未查询过库,模拟面单独存在也不冒充联调结果`;
}

export interface ShowDriftEvidenceDeps {
  loadRecords(): DriftEvidenceRecord[];
  channel: { clear(): void; appendLine(line: string): void; show(preserveFocus?: boolean): void };
  showInformationMessage(message: string): unknown;
}

/** 重查命令:已存证据按版本渲染进漂移通道;无证据如实说无,不虚构 */
export function runShowDriftEvidenceCommand(deps: ShowDriftEvidenceDeps): void {
  const records = deps.loadRecords();
  deps.channel.clear();
  deps.channel.appendLine(renderDriftEvidenceRecords(records));
  deps.channel.show(true);
  if (records.length === 0) {
    deps.showInformationMessage(
      '尚无已保存的漂移校验证据:真实执行漂移校验(checkDrift / checkAllDrift)后会按引擎版本保存'
    );
  }
}
