import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import {
  formatHotReloadDiagnosticLine,
  HotReloadDiagnosticsPanel,
  HOT_RELOAD_DIAGNOSTICS_CHANNEL_NAME,
  HOT_RELOAD_SHOW_DIAGNOSTICS_COMMAND,
  SAVE_PIPELINE_DIAGNOSTIC_LABELS
} from '../src/backend/hotReloadDiagnostics';
import type { SavePipelineDiagnostic } from '../src/backend/hotReloadSavePipeline';
import {
  channels,
  commandRegistry,
  configurationOverrides,
  lastFileSystemWatcher
} from './helpers/vscodeStub';

// RUST-341 验收受注:八型保存流水线诊断(HR-WATCH-017)的用户可审查呈现面。
// - 纯面:标签表八型齐备(类型穷尽由 Record 保证),一行一事件
//   `[时间] 标签 文件: 明细`,文件/明细缺省如实省略;
// - 面板:push 全量落通道,show 打开通道,dispose 后不再落账;
// - 装配面:真 setupHotReload 触发保存,诊断落「KBEngine 热更诊断」通道
//   (trigger/flushed 实发实收),showDiagnostics 命令注册,装配释放通道随之
//   dispose;主日志既有契约不因新面而丢。

const fmt = (ms: number): string => `T${ms}`;

describe('纯面:标签表与行格式化(RUST-341)', () => {
  it('八型诊断标签齐备且非空(类型穷尽由 Record 锁死)', () => {
    const types = [
      'trigger',
      'filtered',
      'debounced',
      'deduped',
      'blocked',
      'scheduled',
      'preview',
      'flushed'
    ] as const;
    expect(Object.keys(SAVE_PIPELINE_DIAGNOSTIC_LABELS).sort()).toEqual([...types].sort());
    for (const type of types) {
      expect(SAVE_PIPELINE_DIAGNOSTIC_LABELS[type].length).toBeGreaterThan(0);
    }
  });

  it('完整形态:[时间] 标签 文件: 明细', () => {
    const d: SavePipelineDiagnostic = {
      type: 'blocked',
      uri: '/ws/scripts/Avatar.py',
      detail: '语法错误:1 处',
      time: 1234
    };
    expect(formatHotReloadDiagnosticLine(d, fmt)).toBe(
      '[T1234] 闸门拦下 /ws/scripts/Avatar.py: 语法错误:1 处'
    );
  });

  it('缺省如实省略:无文件/无明细不补空段', () => {
    expect(
      formatHotReloadDiagnosticLine({ type: 'flushed', detail: '3 文件', time: 9 }, fmt)
    ).toBe('[T9] 成批发出: 3 文件');
    expect(
      formatHotReloadDiagnosticLine({ type: 'scheduled', uri: '/ws/a.py', time: 9 }, fmt)
    ).toBe('[T9] 排窗 /ws/a.py');
  });
});

describe('面板:push 全量落通道,show 打开,dispose 停收(RUST-341)', () => {
  it('push 逐事件落一行;show 打开通道;dispose 后不再落账且通道释放', () => {
    const lines: string[] = [];
    let shown = 0;
    let disposed = 0;
    const panel = new HotReloadDiagnosticsPanel({
      channel: {
        appendLine: line => {
          lines.push(line);
        },
        show: () => {
          shown += 1;
        },
        dispose: () => {
          disposed += 1;
        }
      },
      formatTime: fmt
    });
    panel.push({ type: 'trigger', uri: '/ws/a.py', detail: 'save(第 1 事件)', time: 5 });
    panel.push({ type: 'deduped', uri: '/ws/a.py', detail: '同内容同目标,不重复发送', time: 6 });
    expect(lines).toEqual(['[T5] 触发 /ws/a.py: save(第 1 事件)', '[T6] 去重跳过 /ws/a.py: 同内容同目标,不重复发送']);
    panel.show();
    expect(shown).toBe(1);
    panel.dispose();
    expect(disposed).toBe(1);
    panel.push({ type: 'flushed', detail: '1 文件', time: 7 });
    expect(lines).toHaveLength(2);
    panel.dispose();
    expect(disposed).toBe(1); // 幂等
  });
});

// 定时器只登记不即发(生产定时器绝不同步触发;与 wiring 测试同款 tick 形态)
const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => void } => {
  const handles = new Map<unknown, () => void>();
  let nextHandle = 0;
  return {
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
    timers: {
      set: (callback): unknown => {
        const handle = nextHandle++;
        handles.set(handle, callback);
        return handle;
      },
      clear: (handle): void => {
        handles.delete(handle);
      }
    }
  };
};

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

const diagnosticsChannel = (): { name: string; lines: string[]; disposed: boolean } | undefined =>
  channels.find(entry => entry.name === HOT_RELOAD_DIAGNOSTICS_CHANNEL_NAME);

describe('装配面:setupHotReload 诊断全量落通道+命令入口(RUST-341)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    channels.length = 0;
  });

  it('真保存链路:trigger/flushed 诊断落「KBEngine 热更诊断」通道,一行一事件', async () => {
    const clock = makeTimers();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    setupHotReload({ subscriptions: [] } as unknown as vscode.ExtensionContext, () => true, {
      timers: clock.timers
    });

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    // offer 即落 trigger 行(同步,不待窗到点)
    expect(diagnosticsChannel()).toBeDefined();
    expect(diagnosticsChannel()!.lines.some(line => line.includes('触发') && line.includes('/ws/a.py'))).toBe(true);
    clock.tick();
    await flush();
    // 定稿成批 → flushed 行(带文件数)
    expect(
      diagnosticsChannel()!.lines.some(line => line.includes('成批发出') && line.includes('1 文件'))
    ).toBe(true);
  });

  it('kbengine.hotReload.showDiagnostics 命令注册,处理器打开通道(不抛)', () => {
    const clock = makeTimers();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    setupHotReload({ subscriptions: [] } as unknown as vscode.ExtensionContext, () => true, {
      timers: clock.timers
    });
    const registration = commandRegistry.registrations.get(HOT_RELOAD_SHOW_DIAGNOSTICS_COMMAND);
    expect(registration).toBeDefined();
    expect(() => registration!.handler()).not.toThrow();
  });

  it('装配释放:复合 disposable dispose → 诊断通道 disposed', () => {
    const clock = makeTimers();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    setupHotReload(context, () => true, { timers: clock.timers });
    const composite = (context.subscriptions as Array<{ dispose(): void }>)[0];
    expect(composite).toBeDefined();
    composite.dispose();
    expect(diagnosticsChannel()!.disposed).toBe(true);
  });
});
