// IDE-SNP-010:根配置 generation。扫描根集(工作区文件夹 ∪ assetsRoot)与
// 运行域配置(数据库连接/表前缀)是派生快照的隐性输入:SNP-006 的文件版本
// 清单只覆盖文件面,根/域变了旧快照仍「文件未变」被误复用。这里给根配置一
// 个全局单调 generation——变化点 bump,快照构建期记下当前值,消费端比对
// 「当前 vs 构建」即判过期(与 inputVersions 双轴并行)。
let rootConfigGeneration = 0;
let lastBumpReason = '';

export function getRootConfigGeneration(): number {
  return rootConfigGeneration;
}

/** 最近一次 bump 的原因(观测/诊断用;空串=从未 bump) */
export function getRootConfigLastBumpReason(): string {
  return lastBumpReason;
}

/** 根配置变化点 bump(assetsRoot 切换/工作区根集变化/运行域配置变化);返回新 generation */
export function bumpRootConfigGeneration(reason: string): number {
  rootConfigGeneration += 1;
  lastBumpReason = reason;
  return rootConfigGeneration;
}

/** 测试面:清回基线(generation 与原因) */
export function resetRootConfigGenerationForTests(): void {
  rootConfigGeneration = 0;
  lastBumpReason = '';
}
