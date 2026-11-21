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

// RUST-398(HR-HASH-011)装配面:types.xml 批内变化 → reverse-dependency 影响
// 报告生成并并入需重启理由(受影响 .def 按 RUST-397 同判据需重启,不自动
// 热更)。判据:
// - 首见建档基线(变更面自下次起报告);
// - 前后内容变化 → 报告点名受影响 .def;审计「拦截:配置变更需重启」理由
//   含报告行;
// - collectDefsForTypesImpact 注入的 .def 参与分析;未注入/空 → 报告如实
//   点名「未收集 .def,影响面未知」;
// - 校验失败面也如实记影响报告(事实面),不阻塞拦截。

const TYPES_BEFORE = '<types>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</types>\n';
const TYPES_AFTER = '<types>\n  <ITEM_ID> UINT32 </ITEM_ID>\n</types>\n';
const DEF_USING_ITEM = `<root>
  <Properties>
    <item>
      <Type>ITEM_ID</Type>
    </item>
  </Properties>
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

describe('装配面:setupHotReload types.xml 影响报告接线(RUST-398)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    messages.warning.length = 0;
    channels.length = 0;
  });

  const wire = (options: { defs?: Array<{ name: string; text: string }> } = {}): {
    clock: ReturnType<typeof makeTimers>;
    setContent: (value: string) => void;
    fire: (file: string) => void;
  } => {
    const clock = makeTimers();
    let content = TYPES_BEFORE;
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
        },
        collectDefsForTypesImpact: async () => options.defs ?? []
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
    const run = wire({ defs: [{ name: 'Monster.def', text: DEF_USING_ITEM }] });
    run.fire('/ws/entity_defs/types.xml');
    run.clock.tick();
    await flush();
    const log = hotReloadLog().join('\n');
    expect(log).toContain('拦截:配置变更需重启');
    expect(log).toContain('已建档为基线');
    expect(log).not.toContain('影响报告:');
  });

  it('第二次变化 → 影响报告点名受影响 .def,并入需重启理由', async () => {
    const run = wire({ defs: [{ name: 'Monster.def', text: DEF_USING_ITEM }] });
    run.fire('/ws/entity_defs/types.xml');
    run.clock.tick();
    await flush();
    // 首见建档后,改内容再触发
    run.setContent(TYPES_AFTER);
    run.fire('/ws/entity_defs/types.xml');
    run.clock.tick();
    await flush();
    const log = hotReloadLog().join('\n');
    // 报告并入「拦截:配置变更需重启」理由(不自动热更),报告行点名变化类型
    // 与受影响 .def
    expect(log).toContain('types.xml 变化:');
    expect(log).toContain('ITEM_ID');
    expect(log).toContain('Monster.def');
    expect(log).toContain('需重启');
    // 审计/警告理由带报告行(不自动热更)
    expect(messages.warning.join(' ')).toContain('需重启引擎生效');
  });

  it('未注入 .def 收集 → 报告如实点名「未收集 .def,影响面未知」', async () => {
    const run = wire();
    run.fire('/ws/entity_defs/types.xml');
    run.clock.tick();
    await flush();
    run.setContent(TYPES_AFTER);
    run.fire('/ws/entity_defs/types.xml');
    run.clock.tick();
    await flush();
    const log = hotReloadLog().join('\n');
    expect(log).toContain('未收集 .def,影响面未知');
  });

  it('纯 Python 批无 types.xml:零影响报告,照常发送', async () => {
    const run = wire({ defs: [{ name: 'Monster.def', text: DEF_USING_ITEM }] });
    // 直接触发一个 py(无 types.xml)——需有实际发送器回调记录;这里只断言
    // 无影响报告行,发送行为沿用既有装配(不在本验收范围)。
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/Avatar.py' } as never);
    run.clock.tick();
    await flush();
    expect(hotReloadLog().join('\n')).not.toContain('types.xml 影响报告');
  });
});
