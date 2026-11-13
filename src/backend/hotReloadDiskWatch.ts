/**
 * 热更磁盘监视装配核(HR-PR-05,书 §19.4 disk-watch):
 * - 零 vscode 导入:FileSystemWatcher 以工厂注入(真装配传
 *   vscode.createFileSystemWatcher 的薄适配;测试传内存 watcher 总线);
 * - HR-WATCH-003 磁盘事件进流水线:change/create 事件经 isWatchableScriptFile
 *   过滤后以 source='disk-change' offer;与 save 事件的重叠去重在流水线纯核
 *   (同 pending 归并记 disk-save-overlap,不双发);delete 事件不 offer
 *   (已删除文件由流水线稳定等待如实丢弃,此处直接不理,记诊断);
 * - HR-WATCH-004 只监已声明根:每根派生递归 glob(根下全部 .py),根外
 *   事件天然到不了(watcher 模式匹配),过滤面再拦排除目录/备份名;
 * - HR-WATCH-005 生命周期:dispose 全清;rebuild = 旧 watcher 全 dispose
 *   +按新根重建(配置/根变更),armed 状态跨 rebuild 保持(重建不重开
 *   基线窗,真 watcher 重建不会对既有文件补发事件);
 * - HR-WATCH-015 基线不是变更:arm() 之前到达的磁盘事件一律丢弃并记
 *   诊断——激活期先建 watcher 后 arm,启动绝不把既有文件当变更发送;
 * - Git 批量变更(分支切换/checkout):本核只保证逐事件不吞不放大,爆发
 *   由流水线三层兜住=波次归集(同窗一批)+同内容去重(checkout 还原同字节
 *   不重发)+批量预览阈值(超阈只预览不自动发,HR-WATCH-016);
 * - 远端形态(WSL //wsl$、UNC、Remote SSH):路径一律先经
 *   canonicalizeScriptFilePath 规范化再过滤/offer,与发送面同键。
 */

import { canonicalizeScriptFilePath } from './hotReloadModuleIdentity';
import { isWatchableScriptFile, type HotReloadEventSource, type WatchableFileOptions } from './hotReloadSavePipeline';

/** watcher 最小面(真装配适配 vscode.FileSystemWatcher 的 create/change/delete) */
export interface DiskWatcherHandle {
  readonly pattern: string;
  readonly onDidChange: (cb: (uri: string) => void) => void;
  readonly onDidCreate: (cb: (uri: string) => void) => void;
  readonly onDidDelete: (cb: (uri: string) => void) => void;
  readonly dispose: () => void;
}

/** watcher 工厂:真装配=vscode.createFileSystemWatcher 薄适配;测试=内存总线 */
export type DiskWatcherFactory = (pattern: string) => DiskWatcherHandle;

/** 磁盘监视诊断型(装配面可审查;HR-WATCH-017 同思路,本核子集) */
export type DiskWatchDiagnosticType =
  | 'watch-created'
  | 'dropped-before-arm'
  | 'filtered'
  | 'delete-ignored'
  | 'disposed';

export interface DiskWatchDiagnostic {
  readonly type: DiskWatchDiagnosticType;
  readonly detail: string;
}

export interface HotReloadDiskWatchOptions {
  /** 事件管线入口(流水线纯核的 offer;去抖/归并/去重/波次都在那头) */
  readonly offer: (file: string, source: HotReloadEventSource) => void;
  /** watcher 工厂(注入) */
  readonly createWatcher: DiskWatcherFactory;
  /** 过滤选项(HR-WATCH-004;缺省 .py + 默认排除表) */
  readonly filterOptions?: WatchableFileOptions;
  /** 诊断出口(可缺省) */
  readonly onDiagnostic?: (diagnostic: DiskWatchDiagnostic) => void;
}

/** 磁盘监视控制器(HR-PR-05):按根建 watcher,事件过滤后喂流水线 */
export class HotReloadDiskWatchController {
  private readonly offer: (file: string, source: HotReloadEventSource) => void;
  private readonly createWatcher: DiskWatcherFactory;
  private readonly filterOptions: WatchableFileOptions;
  private readonly onDiagnostic?: (diagnostic: DiskWatchDiagnostic) => void;

  private readonly watchers: DiskWatcherHandle[] = [];
  /** HR-WATCH-015:基线窗未关(未 arm)前,磁盘事件一律丢弃 */
  private armed = false;
  private disposed = false;

  constructor(options: HotReloadDiskWatchOptions) {
    this.offer = options.offer;
    this.createWatcher = options.createWatcher;
    this.filterOptions = options.filterOptions ?? {};
    this.onDiagnostic = options.onDiagnostic;
  }

  /** 自省:当前 watcher 模式集合(测试/装配面核查) */
  watchedPatterns(): string[] {
    return this.watchers.map(watcher => watcher.pattern);
  }

  /** 自省:基线窗状态(HR-WATCH-015) */
  isArmed(): boolean {
    return this.armed;
  }

  /**
   * HR-WATCH-004 只监已声明根:每根派生递归 glob(根下全部 .py)。
   * 根先规范化(与流水线/发送面同键),空规范化根如实跳过不建 watcher。
   */
  watchRoots(roots: readonly string[]): void {
    if (this.disposed) {
      return;
    }
    for (const root of roots) {
      const canonical = canonicalizeScriptFilePath(root);
      if (canonical.length === 0) {
        continue;
      }
      const pattern = `${canonical}/**/*.py`;
      const watcher = this.createWatcher(pattern);
      watcher.onDidChange(uri => this.handleDiskEvent(uri));
      watcher.onDidCreate(uri => this.handleDiskEvent(uri));
      watcher.onDidDelete(uri => this.handleDelete(uri));
      this.watchers.push(watcher);
      this.onDiagnostic?.({ type: 'watch-created', detail: pattern });
    }
  }

  /** HR-WATCH-015:基线窗关闭,此后磁盘事件才视为变更 */
  arm(): void {
    if (this.disposed) {
      return;
    }
    this.armed = true;
  }

  /**
   * HR-WATCH-005 生命周期:按新根重建(配置/根/模式变更)。
   * 旧 watcher 全 dispose;armed 保持不变——重建不重开基线窗(真 watcher
   * 重建不会对既有文件补发事件,重开反而制造启动全仓发送风险)。
   */
  rebuild(roots: readonly string[]): void {
    if (this.disposed) {
      return;
    }
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers.length = 0;
    this.watchRoots(roots);
  }

  /** HR-WATCH-005:停用全清(含 dispose 全部 watcher),后续事件不再受理 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers.length = 0;
    this.armed = false;
    this.onDiagnostic?.({ type: 'disposed', detail: 'disk watch disposed' });
  }

  /** 磁盘事件统一入口:基线窗 → 过滤 → offer(disk-change) */
  private handleDiskEvent(rawUri: string): void {
    if (this.disposed) {
      return;
    }
    if (!this.armed) {
      this.onDiagnostic?.({ type: 'dropped-before-arm', detail: rawUri });
      return;
    }
    if (!isWatchableScriptFile(rawUri, this.filterOptions)) {
      this.onDiagnostic?.({ type: 'filtered', detail: rawUri });
      return;
    }
    const canonical = canonicalizeScriptFilePath(rawUri);
    if (canonical.length === 0) {
      this.onDiagnostic?.({ type: 'filtered', detail: rawUri });
      return;
    }
    this.offer(canonical, 'disk-change');
  }

  /** 删除事件不进流水线(已删除由稳定等待如实丢弃);记诊断如实可审查 */
  private handleDelete(rawUri: string): void {
    if (this.disposed) {
      return;
    }
    this.onDiagnostic?.({ type: 'delete-ignored', detail: rawUri });
  }
}

/** 派生 glob(装配面复用:vscode.RelativePattern 的 pattern 段) */
export function deriveWatchGlob(root: string): string {
  const canonical = canonicalizeScriptFilePath(root);
  return canonical.length > 0 ? `${canonical}/**/*.py` : '';
}
