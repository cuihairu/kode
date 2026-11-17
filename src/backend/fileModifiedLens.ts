/**
 * 文件顶部修改时间纯核(FILE-TIME-001,用户令 2026-11-17):「在文件顶部
 * 显示修改的时间,热更新时间」。热更时间由既有 IDE-HOT-100 状态点承担
 * (hotReloadFileStateLens.ts 已含「上次 <时间>」投递时间),本核只补
 * 修改时间半边——盘上 mtime 一次 stat,编辑未保存时显式注记,不把缓冲区
 * 内容冒充盘上事实。零 vscode 零 IO:时间与时钟由调用方注入。
 */

/** 本地时间 HH:MM:SS(hotReloadStatus.formatHotReloadTime 同式,纯核自持
 * 不 import vscode 面文件) */
export const formatLocalClock = (epochMs: number): string => {
  const date = new Date(epochMs);
  const pad = (value: number): string => `${value < 10 ? '0' : ''}${value}`;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** 同日只出钟点,跨日补月-日(比照对最近一次落盘时间,同天读起来最短) */
export const formatModifiedStamp = (mtimeMs: number, nowMs: number): string => {
  const modified = new Date(mtimeMs);
  const now = new Date(nowMs);
  const sameDay =
    modified.getFullYear() === now.getFullYear() &&
    modified.getMonth() === now.getMonth() &&
    modified.getDate() === now.getDate();
  const pad = (value: number): string => `${value < 10 ? '0' : ''}${value}`;
  if (sameDay) {
    return formatLocalClock(mtimeMs);
  }
  return `${pad(modified.getMonth() + 1)}-${pad(modified.getDate())} ${formatLocalClock(mtimeMs)}`;
};

/** stat 注入口(provider 传真 fs.promises.stat,测试注入假体) */
export type StatMtimeMs = (file: string) => Promise<{ mtimeMs: number }>;

/**
 * 镜文字:`$(clock) 修改 <时间>`,未保存追加「(未保存)」——mtime 是盘上
 * 事实,缓冲区改动未落盘不能改写它,只注记差异不重排时间。
 * mtime 缺失(stat 失败)→ null,调用方不出镜(不编造时间)。
 */
export function formatModifiedTimeLens(
  mtimeMs: number | undefined,
  isDirty: boolean,
  nowMs: number
): string | null {
  if (mtimeMs === undefined) {
    return null;
  }
  const stamp = formatModifiedStamp(mtimeMs, nowMs);
  return isDirty ? `$(clock) 修改 ${stamp}(未保存)` : `$(clock) 修改 ${stamp}`;
}
