/**
 * 指纹增量统计(RUST-403/旧 HR-HASH-016):让「单文件修改不触发全项目
 * Hash 重算」可观测——不是宣称增量,而是把增量工作量记账出来:
 * - bytes read:指纹计算实际读入的字节数(单文件保存≈该文件字节数;
 *   若实现劣化成全项目重扫,此数会膨胀到语料总量,一眼可见);
 * - rehashed files:实际重算指纹的文件数(单文件保存=1);
 * - affected dependency nodes:依赖遍历命中的受影响节点数(types.xml
 *   自定义类型变化的 reverse-dependency 闭包,analyzeTypesImpact 的
 *   affectedDefCount;entities.xml 注册表变化是注册面不是依赖图,不进此账)。
 *
 * 统计口径=**变更触发面**(def 保存/指纹命令/types.xml 变化);显示面
 * (CodeLens 惰性读)只读不重算基线,不进账。纯逻辑零 vscode;装配持有,
 * 生命周期随宿主。
 */

/** 统计只读视图(累计值;装配侧经 view() 读、reset() 清) */
export interface FingerprintStatsView {
  readonly bytesRead: number;
  readonly rehashedFiles: number;
  readonly affectedDependencyNodes: number;
}

/**
 * 指纹统计台账:三个计数器的累计面。防御性 clamp(负数入参按 0 计)——
 * 统计是观测面不是判定面,坏输入不抛错不污染账。
 */
export class FingerprintStats {
  private bytes = 0;
  private files = 0;
  private nodes = 0;

  /** 一次指纹计算:bytesRead=本次读入字节,rehashedFiles=本次重算文件数(缺省 1) */
  recordCompute(bytesRead: number, rehashedFiles = 1): void {
    this.bytes += Math.max(0, Math.floor(bytesRead));
    this.files += Math.max(0, Math.floor(rehashedFiles));
  }

  /** 一次依赖影响分析:affectedNodes=受影响依赖节点数(types 闭包命中数) */
  recordDependencyTraversal(affectedNodes: number): void {
    this.nodes += Math.max(0, Math.floor(affectedNodes));
  }

  /** 累计只读快照 */
  view(): FingerprintStatsView {
    return { bytesRead: this.bytes, rehashedFiles: this.files, affectedDependencyNodes: this.nodes };
  }

  /** 清零(会话复位/测试用) */
  reset(): void {
    this.bytes = 0;
    this.files = 0;
    this.nodes = 0;
  }
}

/** 统计回显行(OUTPUT/审计同源) */
export function formatFingerprintStats(view: FingerprintStatsView): string {
  return `指纹统计: bytes read=${view.bytesRead} B, rehashed files=${view.rehashedFiles}, affected dependency nodes=${view.affectedDependencyNodes}`;
}
