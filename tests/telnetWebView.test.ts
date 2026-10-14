import { beforeEach, describe, expect, it } from 'vitest';
import { TelnetWebView } from '../src/telnetWebView';
import type { TelnetProbeState, TelnetService, TelnetTarget } from '../src/telnetService';
import { messages, panelRegistry, windowState } from './helpers/vscodeStub';

// TelnetWebView 面板协议:目标列表状态灯渲染、closed 的 kbengine.xml
// 开启指引、auth-required 的密码指引、select/connect/disconnect 消息驱动、
// send 未过白名单的拒绝回执(postMessage rejected)、面板复用与销毁重建。
// 输出与状态灯走增量通道(append/states),整页重渲只在选中目标形态变化
// 时发生——面板里不整页重建,连输入框都不动,正在输入的命令与焦点保住。
// service 用记录型假例:面板测试聚焦消息协议与渲染,不依赖真网络。

interface FakeService {
  service: TelnetService;
  targets: TelnetTarget[];
  states: Map<string, TelnetProbeState>;
  sessions: Map<string, string | null>;
  outputs: Map<string, string[]>;
  calls: { connect: string[]; disconnect: string[]; sent: Array<{ key: string; text: string }> };
  changeListeners: Array<() => void>;
  outputListeners: Array<(line: { key: string; text: string }) => void>;
  emitChange(): void;
}

const target = (over: Partial<TelnetTarget> = {}): TelnetTarget => ({
  key: '127.0.0.1:31000',
  label: 'loginapp',
  component: 'loginapp',
  host: '127.0.0.1',
  port: 31000,
  password: 'pwd123456',
  enableCommands: [],
  ...over
});

const makeFakeService = (targets: TelnetTarget[] = []): FakeService => {
  const fake: FakeService = {
    service: null as unknown as TelnetService,
    targets,
    states: new Map(),
    sessions: new Map(),
    outputs: new Map(),
    calls: { connect: [], disconnect: [], sent: [] },
    changeListeners: [],
    outputListeners: [],
    emitChange(): void {
      for (const listener of [...fake.changeListeners]) {
        listener();
      }
    }
  };
  fake.service = {
    getTargets: () => fake.targets,
    getState: key => fake.states.get(key) ?? 'closed',
    getSessionState: key => fake.sessions.get(key) ?? null,
    getOutput: key => fake.outputs.get(key) ?? [],
    connectTarget: key => {
      fake.calls.connect.push(key);
    },
    disconnectTarget: key => {
      fake.calls.disconnect.push(key);
    },
    sendCommand: (key, text) => {
      fake.calls.sent.push({ key, text });
      return text === 'len(entities)';
    },
    onDidChange: listener => {
      fake.changeListeners.push(listener);
      return { dispose: () => undefined };
    },
    onOutput: listener => {
      fake.outputListeners.push(listener);
      return { dispose: () => undefined };
    }
  } as unknown as TelnetService;
  return fake;
};

const currentPanel = () => panelRegistry.panels[panelRegistry.panels.length - 1];

const send = (message: unknown): void => {
  panelRegistry.fireMessage(currentPanel(), message);
};

beforeEach(() => {
  panelRegistry.reset();
  windowState.reset();
});

describe('TelnetWebView 渲染', () => {
  it('show 创建面板(viewType/标题/脚本启用)并渲染空目标提示', () => {
    const fake = makeFakeService([]);
    new TelnetWebView({} as never, fake.service).show();

    const panel = currentPanel();
    expect(panelRegistry.panels).toHaveLength(1);
    expect(panel.viewType).toBe('kbengine.telnetPanel');
    expect(panel.title).toBe('KBEngine Telnet');
    expect((panel.options as { enableScripts: boolean }).enableScripts).toBe(true);
    expect(panel.webview.html).toContain('telnet 未配置');
    expect(panel.webview.html).toContain('kbengine.telnet.host');
  });

  it('目标列表逐项渲染状态灯与地址;closed 目标选中后附 kbengine.xml 开启片段', () => {
    const fake = makeFakeService([
      target(),
      target({ key: '127.0.0.1:32000', label: 'dbmgr', component: 'dbmgr', port: 32000 })
    ]);
    fake.states.set('127.0.0.1:31000', 'connected');
    fake.states.set('127.0.0.1:32000', 'closed');
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();

    const html = currentPanel().webview.html;
    expect(html).toContain('loginapp');
    expect(html).toContain('127.0.0.1:31000');
    expect(html).toContain('已连接');
    expect(html).toContain('dbmgr');

    // closed 指引:选中未开启目标后如实提示 + telnet_service 配置片段,不空转
    send({ command: 'select', key: '127.0.0.1:32000' });
    const hint = currentPanel().webview.html;
    expect(hint).toContain('的 telnet 未开启');
    expect(hint).toContain('&lt;telnet_service&gt;');
    expect(hint).toContain('&lt;port&gt; 31000 &lt;/port&gt;');
    expect(hint).toContain('&lt;default_layer&gt; python &lt;/default_layer&gt;');
    webview.dispose();
  });

  it('auth-required 目标渲染密码指引与会话连接钮;connected 渲染断开钮与输出回显', () => {
    const fake = makeFakeService([target()]);
    fake.states.set('127.0.0.1:31000', 'auth-required');
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();
    expect(currentPanel().webview.html).toContain('端口已开启,但未配置密码');
    expect(currentPanel().webview.html).toContain('连接会话(自动登录)');

    fake.states.set('127.0.0.1:31000', 'connected');
    fake.sessions.set('127.0.0.1:31000', 'ready');
    fake.outputs.set('127.0.0.1:31000', ['echo: len(entities)', '[loginapp@python ~]# ']);
    fake.emitChange();

    const html = currentPanel().webview.html;
    expect(html).toContain('断开会话');
    expect(html).toContain('echo: len(entities)');
    expect(html).toContain('[loginapp@python ~]# ');
    expect(html).toContain('实体数量');
    webview.dispose();
  });

  it('onOutput 只追加选中目标输出且不整页重渲(下行流不重建输入框)', () => {
    const fake = makeFakeService([target(), target({ key: 'k2', label: 'dbmgr', component: 'dbmgr' })]);
    fake.states.set('k2', 'connected');
    fake.sessions.set('k2', 'ready');
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();
    send({ command: 'select', key: 'k2' });

    const htmlBefore = currentPanel().webview.html;
    // 未选中目标的输出不进面板、不发消息
    for (const listener of fake.outputListeners) {
      listener({ key: '127.0.0.1:31000', text: 'other target output' });
    }
    expect(currentPanel().webview.html).toBe(htmlBefore);
    expect(currentPanel().webview.postedMessages).toHaveLength(0);

    // 选中目标输出走 append 增量:整页 html 不动(输入框焦点保住),
    // 空行与服务端环缓冲口径一致地过滤掉
    for (const listener of fake.outputListeners) {
      listener({ key: 'k2', text: 'selected target line\n\n[loginapp@python ~] >>> ' });
    }
    expect(currentPanel().webview.html).toBe(htmlBefore);
    expect(currentPanel().webview.postedMessages.map(entry => entry.message)).toEqual([
      {
        command: 'append',
        lines: ['selected target line', '[loginapp@python ~] >>> ']
      }
    ]);

    // 全空白块不发消息
    for (const listener of fake.outputListeners) {
      listener({ key: 'k2', text: '   \r\n  ' });
    }
    expect(currentPanel().webview.postedMessages).toHaveLength(1);
    webview.dispose();
  });

  it('未选中目标状态翻转只发状态灯补丁,不整页重渲', () => {
    const fake = makeFakeService([target(), target({ key: 'k2', label: 'dbmgr', component: 'dbmgr' })]);
    fake.states.set('k2', 'connected');
    fake.sessions.set('k2', 'ready');
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();
    send({ command: 'select', key: 'k2' });
    const htmlBefore = currentPanel().webview.html;

    // 另一组件在探测循环里启停:不该打断正在输入的会话
    fake.states.set('127.0.0.1:31000', 'open');
    fake.emitChange();
    expect(currentPanel().webview.html).toBe(htmlBefore);
    expect(currentPanel().webview.postedMessages.map(entry => entry.message)).toEqual([
      {
        command: 'states',
        states: [
          { key: '127.0.0.1:31000', state: 'open' },
          { key: 'k2', state: 'connected' }
        ]
      }
    ]);

    // 选中目标自己状态变了:会话形态会变,仍走整页重渲
    fake.states.set('k2', 'closed');
    fake.emitChange();
    expect(currentPanel().webview.html).not.toBe(htmlBefore);
    webview.dispose();
  });

  it('未显式选中时,面板展示的第一个目标状态变化照样整页重渲', () => {
    const fake = makeFakeService([target()]);
    fake.states.set('127.0.0.1:31000', 'open');
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();
    const htmlBefore = currentPanel().webview.html;

    // 没点过任何目标(面板展示的是第一个目标):它连上后要换成输入区,
    // 不能因为「没有 selectedKey」就停在旧指引上
    fake.states.set('127.0.0.1:31000', 'connected');
    fake.sessions.set('127.0.0.1:31000', 'ready');
    fake.emitChange();

    const html = currentPanel().webview.html;
    expect(html).not.toBe(htmlBefore);
    expect(html).toContain('断开会话');
    webview.dispose();
  });

  it('空目标下状态变化:effective 为空走 null 臂,发空状态补丁不炸', () => {
    const fake = makeFakeService([]);
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();

    fake.emitChange();

    // keys 与选中态都没变(本来就空):走补丁路径,states 为空数组
    expect(currentPanel().webview.postedMessages.map(entry => entry.message)).toEqual([
      { command: 'states', states: [] }
    ]);
    webview.dispose();
  });

  it('面板脚本内置 Ctrl+]/Ctrl+D 断开与增量输出处理', () => {
    const fake = makeFakeService([target()]);
    fake.states.set('127.0.0.1:31000', 'connected');
    fake.sessions.set('127.0.0.1:31000', 'ready');
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();
    const html = currentPanel().webview.html;
    expect(html).toContain("event.key === ']'");
    expect(html).toContain("event.key === 'd'");
    expect(html).toContain('Ctrl+] / Ctrl+D 断开会话');
    expect(html).toContain("message.command === 'append'");
    expect(html).toContain("message.command === 'rejected'");
    expect(html).toContain("message.command === 'states'");
    webview.dispose();
  });
});

describe('TelnetWebView 未开面板时的守卫', () => {
  it('未 show 期间 onDidChange/onOutput 触发不炸、不建面板', () => {
    const fake = makeFakeService([target()]);
    const webview = new TelnetWebView({} as never, fake.service);

    fake.emitChange();
    for (const listener of fake.outputListeners) {
      listener({ key: '127.0.0.1:31000', text: 'no panel yet' });
    }
    expect(panelRegistry.panels).toHaveLength(0);
    webview.dispose();
  });
});

describe('TelnetWebView 消息协议', () => {
  it('select 记录选中并重渲出选中高亮', () => {
    const fake = makeFakeService([target(), target({ key: 'k2', label: 'dbmgr', component: 'dbmgr' })]);
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();

    send({ command: 'select', key: 'k2' });

    expect(currentPanel().webview.html).toContain('target selected');
    webview.dispose();
  });

  it('connect/disconnect 驱动 service 并重渲', () => {
    const fake = makeFakeService([target()]);
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();

    send({ command: 'connect', key: '127.0.0.1:31000' });
    expect(fake.calls.connect).toEqual(['127.0.0.1:31000']);

    send({ command: 'disconnect', key: '127.0.0.1:31000' });
    expect(fake.calls.disconnect).toEqual(['127.0.0.1:31000']);
    webview.dispose();
  });

  it('disconnectActive:选中目标优先,无选中时取首个已连接目标', () => {
    const fake = makeFakeService([target(), target({ key: 'k2', label: 'dbmgr', component: 'dbmgr' })]);
    fake.states.set('k2', 'connected');
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();

    // 默认选中第一个目标(状态 closed):选中目标无会话,取首个已连接
    webview.disconnectActive();
    expect(fake.calls.disconnect).toEqual(['k2']);

    // 选中目标也有会话时优先断选中目标
    send({ command: 'select', key: '127.0.0.1:31000' });
    fake.states.set('127.0.0.1:31000', 'connected');
    webview.disconnectActive();
    expect(fake.calls.disconnect).toEqual(['k2', '127.0.0.1:31000']);
    webview.dispose();
  });

  it('disconnectActive 无已连接会话:如实提示不空转', () => {
    const fake = makeFakeService([target()]);
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();

    webview.disconnectActive();

    expect(fake.calls.disconnect).toEqual([]);
    expect(messages.info).toEqual(['没有已连接的 telnet 会话']);
    webview.dispose();
  });

  it('disconnectActive 未开面板:会话照拆,重渲静默跳过(顶部命令入口无面板可用)', () => {
    const fake = makeFakeService([target()]);
    fake.states.set('127.0.0.1:31000', 'connected');
    const webview = new TelnetWebView({} as never, fake.service);

    webview.disconnectActive();

    expect(fake.calls.disconnect).toEqual(['127.0.0.1:31000']);
    expect(panelRegistry.panels).toHaveLength(0);
  });

  it('send 过白名单转发 service 不重渲;未过白名单回 rejected 回执(含原文)', async () => {
    const fake = makeFakeService([target()]);
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();

    const htmlBefore = currentPanel().webview.html;
    send({ command: 'send', key: '127.0.0.1:31000', text: 'len(entities)' });
    expect(fake.calls.sent).toEqual([{ key: '127.0.0.1:31000', text: 'len(entities)' }]);
    // 发送成功不重渲也不本地补回显行:引擎 onRecvInput default 分支逐字
    // 回显(telnet_handler.cpp L396-411),服务端回显经 append 通道到达,
    // 本地再补一行会重复显示;输入框焦点不被打断
    expect(currentPanel().webview.html).toBe(htmlBefore);
    expect(currentPanel().webview.postedMessages).toHaveLength(0);

    send({ command: 'send', key: '127.0.0.1:31000', text: 'rm -rf /' });
    const posted = currentPanel().webview.postedMessages.map(entry => entry.message);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ command: 'rejected', key: '127.0.0.1:31000', text: 'rm -rf /' });
    webview.dispose();
  });

  it('空命令不转发不回执;无选中目标时 connect 缺 key 空转', () => {
    const fake = makeFakeService([]);
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();

    send({ command: 'send', key: '127.0.0.1:31000' });
    send({ command: 'send', key: '127.0.0.1:31000', text: '   ' });
    send({ command: 'connect' });
    send({ command: 'send', text: 'len(entities)' });
    // 未知命令消息:忽略不炸
    send({ command: 'mystery', key: '127.0.0.1:31000' });

    expect(fake.calls).toEqual({ connect: [], disconnect: [], sent: [] });
    expect(currentPanel().webview.postedMessages).toHaveLength(0);
    webview.dispose();
  });

  it('面板复用(reveal)与销毁后重建', () => {
    const fake = makeFakeService([target()]);
    const webview = new TelnetWebView({} as never, fake.service);
    webview.show();
    webview.show();
    expect(panelRegistry.panels).toHaveLength(1);
    expect(currentPanel().revealed).toBe(true);

    webview.dispose();
    expect(currentPanel().disposed).toBe(true);
    webview.show();
    expect(panelRegistry.panels).toHaveLength(2);
    webview.dispose();
  });
});
