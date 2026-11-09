// C-17:进程拓扑 findings → 诊断规范映射(纯逻辑半边,无 vscode 依赖,可单测)。
//
// 边界:findings(Rust 返回)带 1 基行号与文件路径,本模块按文件分组并解析
// 目标 URI(manifest 用哨兵 "<manifest>" → 实际 process_topology.xml 路径;
// def 用其 filePath),产出诊断规范;extension 侧按规范 + 文档文本换算
// vscode.Range 并发布到独立集合 `kbengine-process-topology`。

import type { ProcessTopologyFinding } from './backend/processTopologyRust';

/** 清单文件在 findings 中的哨兵路径(Rust 侧约定) */
export const MANIFEST_FINDING_SENTINEL = '<manifest>';

/** 诊断 code 前缀(C-19 惯例 kbengine.<camelCase>) */
export const PROCESS_TOPOLOGY_DIAGNOSTIC_PREFIX = 'kbengine.processTopology';

/** 单条诊断规范(定位=1 基行号;extension 侧换算 Range 需文档文本) */
export interface ProcessTopologyDiagnosticSpec {
  /** 目标文档 fsPath */
  filePath: string;
  /** 1 基行号 */
  line: number;
  message: string;
  code: string;
  /** 诊断严重级别(vscode.DiagnosticSeverity 数值;2=Warning) */
  severity: number;
  related: Array<{ filePath: string; line: number; message: string }>;
}

/**
 * findings → 按文件分组的诊断规范。
 * `resolveManifestPath` 把哨兵 "<manifest>" 换成实际清单路径(workspace 根 +
 * process_topology.xml);def 类 finding 直接用其 filePath。
 */
export function mapFindingsToDiagnostics(
  findings: ProcessTopologyFinding[],
  resolveManifestPath: () => string | null
): ProcessTopologyDiagnosticSpec[] {
  const specs: ProcessTopologyDiagnosticSpec[] = [];
  for (const finding of findings) {
    const filePath = resolveTargetPath(finding.filePath, resolveManifestPath);
    if (!filePath) {
      // 清单路径不可解析(无 workspace 根)→ 跳过该条,不误报。
      continue;
    }
    specs.push({
      filePath,
      line: Math.max(1, finding.line),
      message: finding.message,
      code: finding.code,
      severity: finding.severity,
      related: (finding.related ?? []).map(related => ({
        filePath: resolveTargetPath(related.filePath, resolveManifestPath) ?? related.filePath,
        line: Math.max(1, related.line),
        message: related.message
      }))
    });
  }
  return specs;
}

function resolveTargetPath(
  filePath: string,
  resolveManifestPath: () => string | null
): string | null {
  if (filePath === MANIFEST_FINDING_SENTINEL) {
    return resolveManifestPath();
  }
  return filePath;
}
