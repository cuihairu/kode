/**
 * RUST-221(旧 UI-004)缓存维护纯核:kbengine.diagnostics.clearCaches 的
 * 确认文案与清后摘要渲染。诚实边界:三条缓存都是内存缓存——清掉只影响
 * 下次查询的冷启动延迟,不动磁盘与工作区文件,无数据丢失(与「勿要求用户
 * 清空 workspace 才能修」直接对答);文案如实列范围与影响,不夸大「修复」。
 * 动作组合(确认→清→报)在接线层,纯核只渲染。
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

/** 确认对话框文案:范围(三缓存+在册条数)+影响(内存缓存重建,无数据丢失) */
export function renderCacheClearConfirmation(gauges: readonly CacheClearEntryGauge[]): string {
  const scope = gauges.map(gauge => `${gauge.label} ${String(gauge.entries)} 条`).join('、');
  return [
    `将清空以下内存缓存:${scope}。`,
    '影响:缓存只是加速层,下次查询自动重建(短暂变慢);不动磁盘与工作区文件,无数据丢失。',
    '适用场景:怀疑缓存内容陈旧(改了 def/类型存储但界面未更新)时先试本命令,重启窗口不是第一步。'
  ].join('\n');
}

/** 清后摘要:逐缓存清掉条数(前后差),全部为零时如实说明 */
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
