/**
 * RUST-221 (former UI-004) cache maintenance pure core: the confirmation copy
 * and the post-clear summary rendering for kbengine.diagnostics.clearCaches.
 * Honest boundary: all three caches are in-memory caches -- clearing them only
 * affects the cold-start latency of the next query, it does not touch disk or
 * workspace files, and nothing is lost (a direct answer to "never ask the user
 * to wipe their workspace to fix things"); the copy lists the scope and impact
 * as-is and does not overstate "repair". The action chain (confirm -> clear ->
 * report) lives in the wiring layer; the pure core only renders.
 */

export interface CacheClearEntryGauge {
  label: string;
  entries: number;
}

export interface CacheClearBeforeAfter {
  label: string;
  before: number;
  after: number;
}

/** Confirmation dialog copy: scope (three caches + entry counts) + impact (in-memory caches are rebuilt, no data loss) */
export function renderCacheClearConfirmation(gauges: readonly CacheClearEntryGauge[]): string {
  const scope = gauges.map(gauge => `${gauge.label} ${String(gauge.entries)} 条`).join('、');
  return [
    `将清空以下内存缓存:${scope}。`,
    '影响:缓存只是加速层,下次查询自动重建(短暂变慢);不动磁盘与工作区文件,无数据丢失。',
    '适用场景:怀疑缓存内容陈旧(改了 def/类型存储但界面未更新)时先试本命令,重启窗口不是第一步。'
  ].join('\n');
}

/** Post-clear summary: entries cleared per cache (before/after delta); states as-is when everything is zero */
export function renderCacheClearedReport(beforeAfter: readonly CacheClearBeforeAfter[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const entry of beforeAfter) {
    const cleared = entry.before - entry.after;
    total += cleared;
    lines.push(`${entry.label}: 清掉 ${String(cleared)} 条`);
  }
  if (total === 0) {
    lines.push('本次没有清掉任何条目(缓存本已为空)。');
  }
  return lines.join('\n');
}
