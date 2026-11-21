import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import {
  channels,
  configurationOverrides,
  lastFileSystemWatcher,
  messages
} from './helpers/vscodeStub';

// RUST-399(HR-HASH-012)装配面:entities.xml 批内注册项变化 → 受影响实体标注
// 与注册版本状态报告生成并并入需重启理由(注册表是引擎装载期结构面,Python
// reload 不替代——默认不发 Python 热更请求替代结构变更)。判据:
// - 首见建档基线(变更面自下次起报告);
// - 前后内容变化 → 报告点名受影响实体;审计「拦截:配置变更需重启」理由
//   含报告行(注册表版本变化,需重启加载);
// - 校验失败面也如实记影响报告(事实面),不阻塞拦截;
// - 纯 Python 批无 entities.xml:零影响报告,照常发送。

const ENTITIES_BEFORE = `<root>
  <Account hasClient="true"></Account>
  <Avatar config="kbengine_avatar_defaults"/>
</root>
`;
const ENTITIES_AFTER = `<root>
  <Account hasClient="true" hasBase="true"></Account>
  <Avatar config="kbengine_avatar_defaults"/>
</root>
`;

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

const hotReloadLog = (): string[] =>
  channels.find(entry => entry.name === 'KBEngine 热更新')?.lines ?? [];

describe('装配面:setupHotReload entities.xml 影响报告接线(RUST-399)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    messages.warning.length = 0;
    channels.length = 0;
  });

  const wire = (): {
    clock: ReturnType<typeof makeTimers>;
    setContent: (value: string) => void;
    fire: (file: string) => void;
  } => {
    const clock = makeTimers();
    let content = ENTITIES_BEFORE;
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100, globs: ['**/*.py', '**/*.xml'] }
    });
    setupHotReload(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      () => true,
      {
        timers: clock.timers,
        targetState: {
          store: new HotReloadTargetStateStore({ now: () => 1 }),
          resolveTargetId: () => 't1',
          resolveRootId: () => '/ws',
          readFileContent: async () => content
        }
      }
    );
    return {
      clock,
      setContent: value => {
        content = value;
      },
      fire: (file: string): void => {
        lastFileSystemWatcher.current!.fireChange({ fsPath: file } as never);
      }
    };
  };

  it('首见建档基线:内容校验通过,无影响报告行,不走模块发送', async () => {
    const run = wire();
    run.fire('/ws/scripts/entities.xml');
    run.clock.tick();
    await flush();
    const log = hotReloadLog().join('\n');
    expect(log).toContain('拦截:配置变更需重启');
    expect(log).toContain('已建档为基线');
    expect(log).not.toContain('注册变化');
  });

  it('第二次变化 → 影响报告点名受影响实体,并入需重启理由(注册表版本变化)', async () => {
    const run = wire();
    run.fire('/ws/scripts/entities.xml');
    run.clock.tick();
    await flush();
    // 首见建档后,改内容(Account 加 hasBase)再触发
    run.setContent(ENTITIES_AFTER);
    run.fire('/ws/scripts/entities.xml');
    run.clock.tick();
    await flush();
    const log = hotReloadLog().join('\n');
    // 报告并入「拦截:配置变更需重启」理由(注册表版本变化,不自动热更)
    expect(log).toContain('entities.xml 注册变化:');
    expect(log).toContain('Account');
    expect(log).toContain('hasBase: (无) → true');
    expect(log).toContain('注册表版本变化');
    expect(log).toContain('需重启加载');
    // 审计/警告理由带报告行(不自动热更)
    expect(messages.warning.join(' ')).toContain('需重启引擎生效');
  });

  it('纯 Python 批无 entities.xml:零影响报告,照常发送', async () => {
    const run = wire();
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/Avatar.py' } as never);
    run.clock.tick();
    await flush();
    expect(hotReloadLog().join('\n')).not.toContain('entities.xml 注册变化');
  });
});
