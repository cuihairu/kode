import { readFileSync } from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';
import {
  channels,
  configurationOverrides,
  lastFileSystemWatcher,
  messages
} from './helpers/vscodeStub';

// IDE-REV-024 def 结构闸接线:批内 .def 文件先做结构指纹对比——序列化/RPC
// 参数结构变化(属性增删/类型 Flags 变化/方法增删/签名变化)整批不发普通
// reload,状态回落就绪+日志与警告提示需重启;无基线(会话首见)/内容不可
// 读/无读取通道证明不了无结构变化,一律保守不发;注释/空白等非结构 def
// 与纯 Python 批照常发送,实际发送器收不到被拦批次的 reload。

const BASE_DEF = `<root>
  <Properties>
    <hp>
      <Type>INT32</Type>
      <Flags>CELL_PRIVATE</Flags>
    </hp>
  </Properties>
  <BaseMethods>
    <attack>
      <Arg>INT32</Arg>
    </attack>
  </BaseMethods>
</root>
`;
// 属性 Type 从 INT32 → FLOAT:序列化面结构变化
const STRUCTURAL_DEF = BASE_DEF.replace('<Type>INT32</Type>', '<Type>FLOAT</Type>');
// 只加注释:结构指纹不变
const NONSTRUCTURAL_DEF = `<!-- 注释不进指纹 -->\n${BASE_DEF}`;
// 装载面结构变化(IDE-AUD-014):Parent 改名=继承根变化 → 有效属性/方法集变化
const PARENT_BASE_DEF = `<root>\n  <Parent> Avatar </Parent>\n  <Properties>\n    <hp>\n      <Type>INT32</Type>\n      <Flags>CELL_PRIVATE</Flags>\n    </hp>\n  </Properties>\n</root>\n`;
const PARENT_CHANGED_DEF = PARENT_BASE_DEF.replace('<Parent> Avatar </Parent>', '<Parent> Monster </Parent>');
// 组件槽 Persistent 改(装载面/序列化交界):同样必须在火线路径被拦
const COMPONENT_BASE_DEF = `<root>\n  <Properties>\n    <hp>\n      <Type>INT32</Type>\n      <Flags>CELL_PRIVATE</Flags>\n    </hp>\n  </Properties>\n  <Components>\n    <bag>\n      <Type>ITEMS</Type>\n      <Persistent> true </Persistent>\n    </bag>\n  </Components>\n</root>\n`;
const COMPONENT_CHANGED_DEF = COMPONENT_BASE_DEF.replace(
  '<Persistent> true </Persistent>',
  '<Persistent> false </Persistent>'
);

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
  const handles = new Map<unknown, () => void>();
  return {
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
      return callbacks.length;
    },
    timers: {
      set: (callback): unknown => {
        const handle = handles.size;
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

const hotReloadLog = (): string[] => {
  const channel = channels.find(entry => entry.name === 'KBEngine 热更新');
  return channel?.lines ?? [];
};

describe('setupHotReload def 结构闸接线(IDE-REV-024)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    messages.warning.length = 0;
    channels.length = 0;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  // 同一装配实例上多发:content 可变,模拟 def 文件被逐次编辑
  const wire = (
    options: { withReader?: boolean } = {}
  ): {
    clock: ReturnType<typeof makeTimers>;
    runCalls: string[];
    setContent: (value: string | null) => void;
    fire: (file: string) => void;
  } => {
    const clock = makeTimers();
    const runCalls: string[] = [];
    let content: string | null = BASE_DEF;
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100, globs: ['**/*.py', '**/*.def'] }
    });
    setupHotReload(
      makeContext(),
      (name: string) => {
        runCalls.push(name);
        return true;
      },
      {
        timers: clock.timers,
        targetState: {
          store: new HotReloadTargetStateStore({ now: () => 1 }),
          resolveTargetId: () => 't1',
          resolveRootId: () => '/ws',
          ...(options.withReader === false
            ? {}
            : {
                readFileContent: async () => content
              })
        }
      }
    );
    return {
      clock,
      runCalls,
      setContent: value => {
        content = value;
      },
      fire: (file: string): void => {
        lastFileSystemWatcher.current!.fireChange({ fsPath: file } as never);
      }
    };
  };

  it('结构性 def 变更(属性 Type 变化):实际发送器未收到 reload,日志与警告提示需重启', async () => {
    const run = wire();
    // 第一发:会话首见,建基线(证明不了无结构变化,保守不发)
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);
    expect(hotReloadLog().some(line => line.includes('无基线'))).toBe(true);

    // 第二发:属性 Type INT32→FLOAT = 序列化面结构变化 → 拦下不发
    run.setContent(STRUCTURAL_DEF);
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);
    const log = hotReloadLog();
    expect(log.some(line => line.includes('需重启'))).toBe(true);
    expect(log.some(line => line.includes('属性结构变化'))).toBe(true);
    expect(messages.warning.some(text => text.includes('需要重启') && text.includes('不发普通 reload'))).toBe(true);
  });

  it('非结构 def 变更(只加注释):基线之后照常发送', async () => {
    const run = wire();
    run.setContent(NONSTRUCTURAL_DEF);
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    // 首见建基线:保守不发
    expect(run.runCalls).toEqual([]);

    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual(['热更']);
  });

  it('纯 Python 批:不经 def 闸照常发送', async () => {
    const run = wire();
    run.fire('/ws/scripts/base/Account.py');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual(['热更']);
  });

  it('混批(py+结构性 def):整批拦下,py 也不发普通 reload', async () => {
    const run = wire();
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);

    run.setContent(STRUCTURAL_DEF);
    run.fire('/ws/scripts/Avatar.def');
    run.fire('/ws/scripts/base/Account.py');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);
    expect(hotReloadLog().some(line => line.includes('需重启'))).toBe(true);
  });

  it('无内容读取通道:def 在批内证明不了无结构变化,保守不发', async () => {
    const run = wire({ withReader: false });
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);
    expect(hotReloadLog().some(line => line.includes('无内容读取通道'))).toBe(true);
  });

  it('结构性 def 拦下 → 审计行带通道「拦截:需重启」与触发源/文件/结果(IDE-HOT-102)', async () => {
    const run = wire();
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    run.setContent(STRUCTURAL_DEF);
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();

    const audit = hotReloadLog().find(line => line.includes('审计'));
    expect(audit).toBeDefined();
    expect(audit).toContain('触发源=watcher-auto');
    expect(audit).toContain('文件=1 个');
    expect(audit).toContain('通道=拦截:需重启');
    expect(audit).toContain('结果=未发送');
  });

  it('def 内容不可读:保守按结构性不发', async () => {
    const run = wire();
    run.setContent(null);
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);
    expect(hotReloadLog().some(line => line.includes('内容不可读'))).toBe(true);
  });

  it('源锁:hotReload 接 def 结构闸(共用判定面),状态面有 setRestartRequired', () => {
    const read = (name: string): string => readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
    const hotReload = read('hotReload.ts');
    // RT-3:判定面抽到 hotReloadDefGate(fire 与重试共用同一实例与基线册)
    expect(hotReload).toContain('createDefStructuralGate');
    expect(hotReload).toContain('defGate');
    expect(hotReload).toContain('defBaselines');
    const gate = read('hotReloadDefGate.ts');
    expect(gate).toContain('classifyDefChange');
    expect(gate).toContain("endsWith('.def')");
    const status = read('hotReloadStatus.ts');
    expect(status).toContain('setRestartRequired');
  });

  // IDE-REV-024 重新核验(2026-11-05):AUD-014 装载面(d08e315)在真实火线
  // 入口的拦下面——Parent/组件槽变化不只是指纹单测结论,实际发送器同样
  // 收不到 reload;非结构变化照常放行。
  it('装载面 Parent 变化:实际发送器未收到 reload(火线路径重新核验)', async () => {
    const run = wire();
    run.setContent(PARENT_BASE_DEF);
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    // 首见建基线:保守不发
    expect(run.runCalls).toEqual([]);

    run.setContent(PARENT_CHANGED_DEF);
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);
    expect(hotReloadLog().some(line => line.includes('需重启'))).toBe(true);
    expect(hotReloadLog().some(line => line.includes('装载面变化: parent'))).toBe(true);
  });

  it('装载面组件槽 Persistent 变化:拦下;之后非结构变化放行(火线路径重新核验)', async () => {
    const run = wire();
    run.setContent(COMPONENT_BASE_DEF);
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    run.setContent(COMPONENT_CHANGED_DEF);
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);
    expect(hotReloadLog().some(line => line.includes('装载面变化: component.bag'))).toBe(true);

    // 基线逐次滚动(保守口径):改回去同样是相对新基线的结构变化,仍拦
    run.setContent(COMPONENT_BASE_DEF);
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);
    expect(hotReloadLog().some(line => line.includes('装载面变化: component.bag'))).toBe(true);

    // 之后只加注释(相对当前基线非结构)→ 照常发送
    const commented = `<!-- 注释不进指纹 -->\n${COMPONENT_BASE_DEF}`;
    run.setContent(commented);
    run.fire('/ws/scripts/Avatar.def');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual(['热更']);
  });
});
