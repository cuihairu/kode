/**
 * 两个 Kode ID 共激活检测(IDE-REL-001):只有「实际共激活」(两个 Kode
 * 系扩展 ID 在当前扩展宿主窗口都 isActive)才判冲突;已安装但未激活
 * (启用未触发懒激活、或被禁用——禁用扩展不进 extensions.all,采集面
 * 天然见不到)不算冲突,如实分列到 inactiveInstalledIds 不虚报。采集
 * (vscode.extensions.all 按 Kode 系筛)在 extension.ts 装配,本模块只
 * 做判定与提示文案,测试零桩。
 */

/** 单个 Kode 系扩展的激活事实(采集自 vscode.extensions.all) */
export interface ExtensionActivationFact {
  id: string;
  /** 当前扩展宿主窗口中是否已激活 */
  isActive: boolean;
}

export interface DualActivationVerdict {
  /** 实际共激活(≥2 个 isActive)才为 true */
  conflict: boolean;
  /** 实际激活的 ID(字典序;只有这些是冲突证据) */
  activeIds: string[];
  /** 已安装(在 extensions.all 里)但未激活的 ID(如实分列,不算冲突) */
  inactiveInstalledIds: string[];
}

export function detectDualActivation(
  facts: ReadonlyArray<ExtensionActivationFact>
): DualActivationVerdict {
  const activeIds = facts.filter(fact => fact.isActive).map(fact => fact.id).sort();
  const inactiveInstalledIds = facts.filter(fact => !fact.isActive).map(fact => fact.id).sort();
  return {
    conflict: activeIds.length >= 2,
    activeIds,
    inactiveInstalledIds
  };
}

/** 冲突提示文案:点名实际共激活的 ID;无冲突返回 null(零打扰) */
export function formatDualActivationWarning(verdict: DualActivationVerdict): string | null {
  if (!verdict.conflict) {
    return null;
  }
  return `检测到两个 Kode 扩展同时激活:${verdict.activeIds.join('、')}——请禁用其一,避免重复索引与命令冲突`;
}
