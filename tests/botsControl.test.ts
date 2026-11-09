import { describe, expect, it } from 'vitest';
import {
  BOTS_ADD_WHITELIST_ENTRY,
  BOTS_COUNT_COMMAND,
  buildAddBotsCommand,
  commandAllowed,
  parseOptionalInt,
  runBotsAddCommand,
  runBotsCountCommand,
  type BotsControlDeps,
  type BotsTelnetTarget
} from '../src/backend/botsControl';

// IDE-BOT-001(机器人,A 案:本地单机闭环)单元锁:
// - 命令串构造镜像引擎 python 层形态(一次性=单参,分批=三参),非法入参抛错;
// - 白名单闸不绕:缺项如实报出该加的 enableCommands 条目,绝不静默绕过;
// - 会话未就绪/目标缺失都如实返回,不假装成功;
// - 减员无 API 的诚实文案(减员=停进程)必出现在成功发送后的输出通道;
// - 计数读取诚实:读到数字报数字,读不到明说(不编造)。
// 全部依赖注入(makeDeps 替身),不 import vscode。

function makeTarget(overrides: Partial<BotsTelnetTarget> = {}): BotsTelnetTarget {
  return {
    key: '127.0.0.1:51000',
    component: 'bots',
    host: '127.0.0.1',
    port: 51000,
    enableCommands: [BOTS_ADD_WHITELIST_ENTRY, BOTS_COUNT_COMMAND],
    ...overrides
  };
}

interface DepsState {
  target: BotsTelnetTarget | null;
  sessionState: string | null;
  outputs: string[];
  sent: string[];
  connected: number;
  infos: string[];
  errors: string[];
  channelLines: string[];
  channelShown: number;
  inputs: string[];
  inputPrompts: string[];
  /** 发送计数命令后模拟推送的输出行。 */
  countOutput?: string[];
  /** getSessionState 第 N 次轮询(1 起)起变 ready;默认一直 ready。 */
  readyAfterPolls?: number;
}

function makeDeps(state: DepsState): BotsControlDeps {
  let poll = 0;
  return {
    getBotsTarget: () => state.target,
    connectTarget: key => {
      if (key === state.target?.key) {
        state.connected += 1;
        if (state.sessionState === null) {
          state.sessionState = 'connecting';
        }
      }
    },
    getSessionState: key => {
      if (key !== state.target?.key) {
        return null;
      }
      if (state.sessionState === 'connecting' && state.readyAfterPolls !== undefined) {
        poll += 1;
        if (poll >= state.readyAfterPolls) {
          state.sessionState = 'ready';
        }
      }
      return state.sessionState;
    },
    sendCommand: (key, command) => {
      if (key !== state.target?.key || state.sessionState !== 'ready') {
        return false;
      }
      state.sent.push(command);
      if (command === BOTS_COUNT_COMMAND && state.countOutput !== undefined) {
        state.outputs.push(...state.countOutput);
      }
      return true;
    },
    getOutput: key => (key === state.target?.key ? [...state.outputs] : []),
    sleep: () => Promise.resolve(),
    withInput: (prompt, _placeholder, _validate) => {
      (state.inputPrompts ??= []).push(prompt);
      return Promise.resolve(state.inputs.shift());
    },
    showInformationMessage: message => {
      state.infos.push(message);
      return Promise.resolve(undefined);
    },
    showErrorMessage: message => {
      state.errors.push(message);
      return Promise.resolve(undefined);
    },
    channel: {
      appendLine: line => state.channelLines.push(line),
      show: () => {
        state.channelShown += 1;
      }
    }
  };
}

describe('buildAddBotsCommand(命令串构造)', () => {
  it('一次性=单参,分批=三参(镜像引擎文档示例形态)', () => {
    expect(buildAddBotsCommand(5)).toBe('KBEngine.addBots(5)');
    expect(buildAddBotsCommand(1000, 5, 10)).toBe('KBEngine.addBots(1000, 5, 10)');
    expect(buildAddBotsCommand(100, 20, 0)).toBe('KBEngine.addBots(100, 20, 0)');
  });

  it('非法入参抛错(total 非正整数/tickCount 非正整数/tickTime 负数)', () => {
    expect(() => buildAddBotsCommand(0)).toThrow();
    expect(() => buildAddBotsCommand(-1)).toThrow();
    expect(() => buildAddBotsCommand(1.5)).toThrow();
    expect(() => buildAddBotsCommand(10, 0, 5)).toThrow();
    expect(() => buildAddBotsCommand(10, 5, -1)).toThrow();
  });
});

describe('parseOptionalInt(可选整数输入解析)', () => {
  it('空串/纯空白=undefined,整数文本=number,其余=null', () => {
    expect(parseOptionalInt('')).toBeUndefined();
    expect(parseOptionalInt('   ')).toBeUndefined();
    expect(parseOptionalInt('42')).toBe(42);
    expect(parseOptionalInt(' -7 ')).toBe(-7);
    expect(parseOptionalInt('abc')).toBeNull();
    expect(parseOptionalInt('1.5')).toBeNull();
  });
});

describe('commandAllowed(白名单判定,与服务层同口径)', () => {
  it('精确或前缀(空格/python 括号)命中;内置快捷命令恒放行;空条目忽略', () => {
    expect(commandAllowed('KBEngine.addBots(5)', ['KBEngine.addBots'])).toBe(true);
    expect(commandAllowed('KBEngine.addBots(1000, 5, 10)', ['KBEngine.addBots'])).toBe(true);
    expect(commandAllowed('len(KBEngine.bots)', ['len(KBEngine.bots)'])).toBe(true);
    // 服务层口径:内置只读快捷命令(如 len(entities))无需用户配置
    expect(commandAllowed('len(entities)', [])).toBe(true);
    expect(commandAllowed('KBEngine.addBots(5)', [])).toBe(false);
    expect(commandAllowed('KBEngine.addBots(5)', ['KBEngine.addBotsX'])).toBe(false);
    expect(commandAllowed('anything', [''])).toBe(false);
  });
});

describe('runBotsAddCommand(添加机器人编排)', () => {
  it('无 bots telnet 目标:如实报错,不连接不发送', async () => {
    const state: DepsState = { target: null, sessionState: null, outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0, inputs: [] };
    const result = await runBotsAddCommand(makeDeps(state));
    expect(result).toContain('No bots telnet target found');
    expect(state.errors[0]).toContain('telnet_service');
    expect(state.connected).toBe(0);
    expect(state.sent).toEqual([]);
  });

  it('首个输入取消:如实返回未执行,不发送', async () => {
    const state: DepsState = { target: makeTarget(), sessionState: 'ready', outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0, inputPrompts: [], inputs: [undefined as unknown as string] };
    const result = await runBotsAddCommand(makeDeps(state));
    expect(result).toContain('Cancelled');
    expect(state.sent).toEqual([]);
  });

  it('白名单缺 addBots:报出该加的条目,不连接不发送', async () => {
    const state: DepsState = {
      target: makeTarget({ enableCommands: [BOTS_COUNT_COMMAND] }),
      sessionState: null,
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: ['100', '']
    };
    const result = await runBotsAddCommand(makeDeps(state));
    expect(result).toContain('Whitelist is missing');
    expect(state.errors[0]).toContain('kbengine.telnet.enableCommands');
    expect(state.errors[0]).toContain(BOTS_ADD_WHITELIST_ENTRY);
    expect(state.connected).toBe(0);
    expect(state.sent).toEqual([]);
  });

  it('会话一直不就绪:报未就绪,不发送', async () => {
    const state: DepsState = {
      target: makeTarget(),
      sessionState: null,
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: ['100', '']
    };
    const result = await runBotsAddCommand(makeDeps(state));
    expect(result).toContain('not ready');
    expect(state.connected).toBe(1);
    expect(state.sent).toEqual([]);
  });

  it('一次性添加:连接就绪后发送单参命令,输出通道含减员=停进程诚实文案并附带计数', async () => {
    const state: DepsState = {
      target: makeTarget(),
      sessionState: 'ready',
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: ['100', ''],
      countOutput: ['100']
    };
    const result = await runBotsAddCommand(makeDeps(state));
    expect(result).toContain('KBEngine.addBots(100)');
    expect(state.sent).toEqual(['KBEngine.addBots(100)', 'len(KBEngine.bots)']);
    expect(state.connected).toBe(0); // 已就绪不再重连
    const joined = state.channelLines.join('\n');
    expect(joined).toContain('Sent KBEngine.addBots(100)');
    expect(joined).toContain('no per-bot removal API');
    expect(joined).toContain('stopping the bots process');
    expect(joined).toContain('current bot count (len(KBEngine.bots))=100');
    expect(state.channelShown).toBeGreaterThan(0);
    expect(state.errors).toEqual([]);
  });

  it('分批添加:三参命令形态,间隔留空按 0', async () => {
    const state: DepsState = {
      target: makeTarget({ enableCommands: [BOTS_ADD_WHITELIST_ENTRY] }),
      sessionState: 'ready',
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: ['1000', '50', '']
    };
    const result = await runBotsAddCommand(makeDeps(state));
    expect(state.sent).toEqual(['KBEngine.addBots(1000, 50, 0)']);
    expect(result).toContain('KBEngine.addBots(1000, 50, 0)');
    // 计数不在白名单:不查询(发送表只有 addBots 一条),结果摘要如实提示可选项
    expect(result).toContain('len(KBEngine.bots)');
  });

  it('连接在途轮询到就绪(handshake 第 3 次轮询变 ready)仍发送', async () => {
    const state: DepsState = {
      target: makeTarget(),
      sessionState: null,
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: ['10', ''],
      readyAfterPolls: 3,
      countOutput: ['10']
    };
    const result = await runBotsAddCommand(makeDeps(state));
    expect(state.connected).toBe(1);
    expect(state.sent[0]).toBe('KBEngine.addBots(10)');
    expect(result).toContain('Sent ');
  });
});

describe('runBotsCountCommand(查询 bot 数编排)', () => {
  it('读到数字:返回数字串并落输出通道', async () => {
    const state: DepsState = {
      target: makeTarget(),
      sessionState: 'ready',
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: [], countOutput: ['123']
    };
    const result = await runBotsCountCommand(makeDeps(state));
    expect(result).toBe('123');
    expect(state.sent).toEqual([BOTS_COUNT_COMMAND]);
    expect(state.channelLines.join('\n')).toContain('=123');
  });

  it('读不到结果行:如实说未读到,返回 null', async () => {
    const state: DepsState = {
      target: makeTarget(),
      sessionState: 'ready',
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: [], countOutput: []
    };
    const result = await runBotsCountCommand(makeDeps(state));
    expect(result).toBeNull();
    expect(state.channelLines.join('\n')).toContain('No bot-count result line read');
  });

  it('白名单缺计数命令:报出条目,返回 null', async () => {
    const state: DepsState = {
      target: makeTarget({ enableCommands: [BOTS_ADD_WHITELIST_ENTRY] }),
      sessionState: 'ready',
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: []
    };
    const result = await runBotsCountCommand(makeDeps(state));
    expect(result).toBeNull();
    expect(state.errors[0]).toContain(BOTS_COUNT_COMMAND);
  });

  it('无 bots 目标:如实报错,返回 null', async () => {
    const state: DepsState = { target: null, sessionState: null, outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0, inputs: [] };
    const result = await runBotsCountCommand(makeDeps(state));
    expect(result).toBeNull();
    expect(state.errors[0]).toContain('No telnet target found for bots');
  });
});

/** withInput 会真跑 validator 的替身:probes 先灌非法/边界形态覆盖闸臂,再按 raw 判定。 */
function makeValidatingDeps(
  state: DepsState & { probes?: string[][] },
  sendOverrides?: Array<boolean>
): BotsControlDeps {
  const deps = makeDeps(state);
  let sendIndex = 0;
  return {
    ...deps,
    withInput: (_prompt, _placeholder, validate) => {
      for (const probe of state.probes?.shift() ?? []) {
        validate(probe);
      }
      const raw = state.inputs.shift();
      if (raw === undefined) {
        return Promise.resolve(undefined);
      }
      return validate(raw) === null ? Promise.resolve(raw) : Promise.resolve(undefined);
    },
    sendCommand: (key, command) => {
      if (sendOverrides !== undefined) {
        const verdict = sendOverrides[sendIndex++];
        if (verdict !== undefined) {
          return verdict;
        }
      }
      return deps.sendCommand(key, command);
    }
  };
}

describe('runBotsAddCommand 缺口臂(输入校验闸/中途取消/发送失败)', () => {
  it('校验闸真跑:非法形态被拒文案、负数/越界被拒、合法放行,三参命令照发', async () => {
    const state: DepsState & { probes?: string[][] } = {
      target: makeTarget(),
      sessionState: 'ready',
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: ['100', '5', '0'],
      probes: [
        ['abc'],            // total 闸:非整数 → 拒文案
        ['abc', '-1'],      // tick 闸:空/非整数拒文案;负数拒;raw '5' 合法放行
        ['abc']             // 间隔闸:非整数拒文案;raw '0' 合法放行
      ],
      countOutput: ['7']
    };
    const result = await runBotsAddCommand(makeValidatingDeps(state));
    expect(state.sent[0]).toBe('KBEngine.addBots(100, 5, 0)');
    expect(result).toContain('current bot count');
  });

  it('tick 输入取消:如实返回未执行,不发送', async () => {
    const state: DepsState = {
      target: makeTarget(),
      sessionState: 'ready',
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: ['100']
    };
    const result = await runBotsAddCommand(makeValidatingDeps(state));
    expect(result).toContain('Cancelled');
    expect(state.sent).toEqual([]);
  });

  it('间隔输入取消:如实返回未执行,不发送', async () => {
    const state: DepsState = {
      target: makeTarget(),
      sessionState: 'ready',
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: ['100', '5']
    };
    const result = await runBotsAddCommand(makeValidatingDeps(state));
    expect(result).toContain('Cancelled');
    expect(state.sent).toEqual([]);
  });

  it('addBots 发送失败(会话掉线):如实报错并返回 Send failed', async () => {
    const state: DepsState = {
      target: makeTarget(),
      sessionState: 'ready',
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: ['100', '', '']
    };
    const result = await runBotsAddCommand(makeValidatingDeps(state, [false]));
    expect(state.errors.join('\n')).toContain('failed to send');
    expect(result).toContain('Send failed');
  });

  it('计数命令发送失败:通道如实说明,摘要仍返回', async () => {
    const state: DepsState = {
      target: makeTarget(),
      sessionState: 'ready',
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: ['100', '', '']
    };
    const result = await runBotsAddCommand(makeValidatingDeps(state, [true, false]));
    expect(state.channelLines.join('\n')).toContain('failed to send');
    expect(result).toContain('current bot count');
  });
});

describe('runBotsCountCommand 缺口臂(会话未就绪)', () => {
  it('白名单命中但会话不就绪:如实报错,返回 null 不发送', async () => {
    const state: DepsState = {
      target: makeTarget(),
      sessionState: null,
      outputs: [], sent: [], connected: 0, infos: [], errors: [], channelLines: [], channelShown: 0,
      inputs: []
    };
    const result = await runBotsCountCommand(makeDeps(state));
    expect(state.errors.join('\n')).toContain('not ready');
    expect(result).toBeNull();
    expect(state.sent).toEqual([]);
  });
});
