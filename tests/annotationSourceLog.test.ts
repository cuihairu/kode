import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  annotationSourceLog,
  clearRecentAnnotationSourceLogs,
  getRecentAnnotationSourceLogs,
  isAnnotationSourceLogEnabled,
  setAnnotationSourceLogEnabled,
  setAnnotationSourceLogSink
} from '../src/annotationSourceLog';

// IDE-REV-037 注解来源日志模块面:默认关闭零开销(消息不求值、sink 不触
// 发)、开启后环形缓冲与 sink 同步收行、clear 清空、环形上限不无界增长。
// 与 jumpLog 同口径;模块本身不 import vscode,sink 由使用方注入。
describe('注解来源日志(annotationSourceLog)', () => {
  afterEach(() => {
    setAnnotationSourceLogEnabled(false);
    setAnnotationSourceLogSink(undefined);
    clearRecentAnnotationSourceLogs();
  });

  it('默认关闭:消息惰性函数不求值、无行、sink 不触发(零开销)', () => {
    expect(isAnnotationSourceLogEnabled()).toBe(false);
    const message = vi.fn(() => 'hover-resolve source=disk-snapshot');
    const sink = vi.fn();
    setAnnotationSourceLogSink(sink);
    annotationSourceLog('info', message);
    expect(message).not.toHaveBeenCalled();
    expect(getRecentAnnotationSourceLogs()).toHaveLength(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it('开启后:前缀行入环形缓冲,sink 同步收同一行', () => {
    setAnnotationSourceLogEnabled(true);
    const sink = vi.fn();
    setAnnotationSourceLogSink(sink);
    annotationSourceLog('info', () => 'hover-resolve word=data source=hovered-document');
    const lines = getRecentAnnotationSourceLogs();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('[kode-annot][info] hover-resolve word=data source=hovered-document');
    expect(sink).toHaveBeenCalledWith(lines[0]);
  });

  it('未注入 sink 时只进环形缓冲;clear 清空;环形有上限不无界增长', () => {
    setAnnotationSourceLogEnabled(true);
    annotationSourceLog('debug', 'first');
    expect(getRecentAnnotationSourceLogs()).toHaveLength(1);
    clearRecentAnnotationSourceLogs();
    expect(getRecentAnnotationSourceLogs()).toHaveLength(0);
    // 上限 400:灌 420 行,留存的是最后 400 行(首 20 行滚出)
    for (let index = 0; index < 420; index += 1) {
      annotationSourceLog('info', `line-${index}`);
    }
    const lines = getRecentAnnotationSourceLogs();
    expect(lines).toHaveLength(400);
    expect(lines[0]).toContain('line-20');
    expect(lines[399]).toContain('line-419');
  });
});
