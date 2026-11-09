/**
 * IDE-GIT 泳道(文件修改历史,类似 TortoiseGit)的功能开关与命令门。
 *
 * IDE-GIT-001:声明默认开启的历史功能开关 `kbengine.gitHistory.enabled`。
 * 用户约束(2026-10-29):默认开启、按需查询——开启只提供入口,绝不在激活、
 * 打开文件、移动光标或选区变化时运行 Git,不预取历史、不挂历史专用监听、
 * 不新增常驻轮询;用户打开历史面板才启动查询;关闭功能时不启动 Git 子进程
 * 或历史任务。本模块只承载开关读取与命令门,不接任何 Git 子进程。
 */

/** 历史功能开关设置键(完整,含 kbengine. 前缀;onDidChangeConfiguration.affectsConfiguration 用)。 */
export const GIT_HISTORY_ENABLED_SETTING = 'kbengine.gitHistory.enabled';
/** 设置键(getConfiguration('kbengine') 段内相对键,不带 kbengine. 前缀;读取用)。 */
export const GIT_HISTORY_ENABLED_KEY = 'gitHistory.enabled';

/** 历史视图/命令可见性上下文键(经 vscode setContext 驱动 `when` 子句)。 */
export const GIT_HISTORY_CONTEXT_KEY = 'kode.gitHistoryEnabled';

/** 命令 ID:查看文件历史(资源管理器/编辑器/命令面板)。 */
export const GIT_HISTORY_SHOW_COMMAND = 'kbengine.git.showHistory';

/** 命令 ID:查看选中范围历史(编辑器选区/命令面板)。 */
export const GIT_HISTORY_SHOW_RANGE_COMMAND = 'kbengine.git.showRangeHistory';

/** 配置读取注入面(与其余设置读取链同口径)。 */
export interface GitHistoryConfigReader {
  get<T>(key: string, defaultValue: T): T;
}

/** 读开关:缺省(未配置)→true(默认开启);显式 true/false 照读。
 * 读取用段内相对键(装配层传 getConfiguration('kbengine') 的段作用域读取器,
 * 与 engineVersion/managedDir 同口径);完整键只用于 affectsConfiguration 判定。 */
export function readGitHistoryEnabled(reader: GitHistoryConfigReader): boolean {
  return reader.get<boolean>(GIT_HISTORY_ENABLED_KEY, true) === true;
}

/**
 * 命令门:只在开关开启时执行 body。开关关闭时直接命令调用也不运行 Git
 * (body 是唯一可能触达 Git 的执行面,门关闭即不触达)。
 */
export function runGitHistoryWhenEnabled(enabled: boolean, body: () => void): void {
  if (enabled) body();
}

/**
 * 选中范围历史前的未保存内容守卫(审核发现:未保存的插入/删除会让磁盘
 * diff 与编辑器缓冲不一致,按磁盘内容映射选区会查错 HEAD 行)。
 * 返回 null=可查询;否则返回用户可见的拒绝原因。
 */
export function rangeHistoryDirtyGuard(isDirty: boolean): string | null {
  if (!isDirty) return null;
  return '编辑器有未保存修改,选中范围历史暂不查询(保存后重试,避免按磁盘旧内容映射到错误 HEAD 行)';
}
