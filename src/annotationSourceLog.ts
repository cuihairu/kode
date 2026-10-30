// IDE-REV-037:注解来源日志(验收「日志明确所用来源」)——hover 推导答话
// 时把「本次用了哪个来源」(悬停文档桶/其余打开文档桶/磁盘注解快照)落
// [kode-annot] 行;过期未命中与受控重建触发同样落账。体量=每查一行,
// 开关 kbengine.annotationLog 默认关闭,关闭时第一行即返回、消息以 () =>
// 惰性传入零字符串拼接(同 jumpLog 口径)。本模块不 import vscode(与
// pythonReturnTypeInference 的无 vscode 约束对齐):输出面板落盘由
// extension 激活时注入 sink,环形缓冲供测试/取证直接读。
export type AnnotationLogLevel = 'info' | 'debug';

export type AnnotationLogSink = (line: string) => void;

const RECENT_LIMIT = 400;
const recentLines: string[] = [];
let enabled = false;
let sink: AnnotationLogSink | undefined;

export function getRecentAnnotationSourceLogs(): readonly string[] {
  return recentLines;
}

export function clearRecentAnnotationSourceLogs(): void {
  recentLines.length = 0;
}

/** 开关注入点:extension 激活读配置、配置变更时刷新;测试直接置位 */
export function setAnnotationSourceLogEnabled(value: boolean): void {
  enabled = value;
}

export function isAnnotationSourceLogEnabled(): boolean {
  return enabled;
}

/** 输出面板接线:extension 注入(通道懒建);测试可注入自己的收行器 */
export function setAnnotationSourceLogSink(next: AnnotationLogSink | undefined): void {
  sink = next;
}

export function annotationSourceLog(
  level: AnnotationLogLevel,
  message: string | (() => string)
): void {
  if (!enabled) { return; }
  const text = typeof message === 'function' ? message() : message;
  const line = `[kode-annot][${level}] ${text}`;
  recentLines.push(line);
  if (recentLines.length > RECENT_LIMIT) { recentLines.shift(); }
  sink?.(line);
}
