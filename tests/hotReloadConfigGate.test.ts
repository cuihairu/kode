import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import {
  checkHotReloadConfigFiles,
  isHotReloadConfigFile
} from '../src/backend/hotReloadConfigGate';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import {
  channels,
  configurationOverrides,
  lastFileSystemWatcher,
  messages
} from './helpers/vscodeStub';

// RUST-336(旧 HR-WATCH-012 配置检查半面)验收受注:批内 KBEngine 配置
// 文件发送前内容校验——types.xml 值域/一致性复用 RUST-177 引擎真源结构
// 检查(error 级拦/Warning 级放,与引擎「打日志但继续」同行为),其余配置
// XML 至少过良构;致命发现整批拦下不发(与语法闸「有错误标 blocked」同
// 语义);读不到/无读取通道=证明不了无风险保守拦;零发现放行走普通通道
// (与 def 非结构批同哲学)。纯核+装配双面,全部 mock 构造。

const CLEAN_TYPES = `<types>
  <VELOCITY> VECTOR3 </VELOCITY>
  <UID> UINT64 </UID>
</types>
`;
// SPEED 指向未声明类型:引擎装载 ERROR「can't fount type」→ 启动中止级
const BROKEN_TYPES = `<types>
  <VELOCITY> VECTOR3 </VELOCITY>
  <SPEED> MISSING_TYPE </SPEED>
</types>
`;
// 别名重定义(大小写不敏感撞名):引擎打日志但装载继续 → Warning 级不拦
const WARNING_TYPES = `<types>
  <VEL> VECTOR3 </VEL>
  <vel> VECTOR3 </vel>
</types>
`;
const MALFORMED_XML = `<kbengine>
  <app> <baseapp> </app>
</kbengine>
`;

describe('纯核:配置文件判定与校验(RUST-336)', () => {
  it('isHotReloadConfigFile:types.xml/entities.xml/kbengine*.xml 任意目录 + entity_defs 下 XML', () => {
    expect(isHotReloadConfigFile('/ws/assets/scripts/entity_defs/types.xml')).toBe(true);
    expect(isHotReloadConfigFile('/ws/types.xml')).toBe(true);
    // RUST-399:entities.xml 实体注册表任意目录也是配置(注册表版本变化,需重启)
    expect(isHotReloadConfigFile('/ws/scripts/entities.xml')).toBe(true);
    expect(isHotReloadConfigFile('/ws/kbengine.xml')).toBe(true);
    expect(isHotReloadConfigFile('/ws/kbengine_defaults.xml')).toBe(true);
    expect(isHotReloadConfigFile('/ws/assets/scripts/entity_defs/Avatar.xml')).toBe(true);
    expect(isHotReloadConfigFile('C:\\ws\\entity_defs\\Monster.xml')).toBe(true);
    expect(isHotReloadConfigFile('/ws/scripts/Avatar.py')).toBe(false);
    expect(isHotReloadConfigFile('/ws/scripts/Avatar.def')).toBe(false);
    expect(isHotReloadConfigFile('/ws/docs/Avatar.xml')).toBe(false);
  });

  it('纯 Python 批:零配置文件零读取,reasons 空', async () => {
    let reads = 0;
    const verdict = await checkHotReloadConfigFiles(['/ws/a.py', '/ws/b.py'], async () => {
      reads += 1;
      return 'x';
    });
    expect(verdict.reasons).toEqual([]);
    expect(reads).toBe(0);
  });

  it('干净 types.xml 放行;别名重定义(Warning 级)与引擎同行为放行', async () => {
    expect((await checkHotReloadConfigFiles(['/ws/entity_defs/types.xml'], async () => CLEAN_TYPES)).reasons).toEqual([]);
    expect((await checkHotReloadConfigFiles(['/ws/entity_defs/types.xml'], async () => WARNING_TYPES)).reasons).toEqual([]);
  });

  it('types.xml 指向未声明类型:error 级拦下,理由点名文件与类型', async () => {
    const verdict = await checkHotReloadConfigFiles(['/ws/entity_defs/types.xml'], async () => BROKEN_TYPES);
    expect(verdict.reasons.length).toBeGreaterThan(0);
    expect(verdict.reasons[0]).toContain('/ws/entity_defs/types.xml');
    expect(verdict.reasons.join(' ')).toContain('MISSING_TYPE');
  });

  it('畸形 XML(kbengine.xml):良构失败拦下;entity_defs XML 同口径', async () => {
    for (const file of ['/ws/kbengine.xml', '/ws/entity_defs/Avatar.xml']) {
      const verdict = await checkHotReloadConfigFiles([file], async () => MALFORMED_XML);
      expect(verdict.reasons.length).toBe(1);
      expect(verdict.reasons[0]).toContain('良构失败');
    }
  });

  it('内容读不到=保守拦;读取异常同样如实拦', async () => {
    const unreadable = await checkHotReloadConfigFiles(['/ws/kbengine.xml'], async () => null);
    expect(unreadable.reasons[0]).toContain('不可读');
    const throwing = await checkHotReloadConfigFiles(['/ws/kbengine.xml'], async () => {
      throw new Error('disk gone');
    });
    expect(throwing.reasons[0]).toContain('读取异常');
  });
});

// 定时器只登记不即发(与 def 闸接线测试同款 tick 形态)
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

describe('装配面:setupHotReload 配置闸接线(RUST-336)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    messages.warning.length = 0;
    channels.length = 0;
  });

  const wire = (options: { withReader?: boolean } = {}): {
    clock: ReturnType<typeof makeTimers>;
    runCalls: string[];
    setContent: (value: string) => void;
    fire: (file: string) => void;
  } => {
    const clock = makeTimers();
    const runCalls: string[] = [];
    let content = CLEAN_TYPES;
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100, globs: ['**/*.py', '**/*.xml'] }
    });
    setupHotReload(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
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
            : { readFileContent: async () => content })
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

  it('批含坏 types.xml(指向未声明类型):实际发送器未收到 reload,审计记配置校验失败,警告不称需重启', async () => {
    const run = wire();
    run.setContent(BROKEN_TYPES);
    run.fire('/ws/entity_defs/types.xml');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);
    expect(hotReloadLog().some(line => line.includes('拦截:配置校验失败'))).toBe(true);
    expect(messages.warning.join(' ')).toContain('配置文件校验失败');
    expect(messages.warning.join(' ')).not.toContain('需重启');
  });

  it('批含干净 types.xml:不走模块发送,按需重启面呈现(校验通过让重启有依据)', async () => {
    const run = wire();
    run.setContent(CLEAN_TYPES);
    run.fire('/ws/entity_defs/types.xml');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);
    expect(hotReloadLog().some(line => line.includes('拦截:配置变更需重启'))).toBe(true);
    expect(hotReloadLog().some(line => line.includes('内容校验通过'))).toBe(true);
    expect(messages.warning.join(' ')).toContain('需重启引擎生效');
  });

  it('纯 Python 批:零配置文件,行为与接闸前一致(照常发送,零拦截行)', async () => {
    const run = wire();
    run.fire('/ws/scripts/Avatar.py');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual(['热更']);
  });

  it('无内容读取通道 + 批含配置文件:不走模块发送,需重启面如实注明未校验', async () => {
    const run = wire({ withReader: false });
    run.fire('/ws/entity_defs/types.xml');
    run.clock.tick();
    await flush();
    expect(run.runCalls).toEqual([]);
    expect(hotReloadLog().some(line => line.includes('无内容读取通道'))).toBe(true);
    expect(hotReloadLog().some(line => line.includes('拦截:配置变更需重启'))).toBe(true);
  });
});
