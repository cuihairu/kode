// TelnetWebView UI 重设计(UI-03):
// - 目标列表 + 会话区双栏布局(原型 #tel .body 左右结构);
// - 六态状态灯接入统一状态色板(Bootstrap 五cb85c/d9534f/f0ad4e 退场),
//   状态词与 TelnetProbeState 一一对应且走字符串表(zh/en);
// - 面板接入 webviewTheme token,全部文案 i18n。
import { beforeEach, describe, expect, it } from 'vitest';
import { TelnetWebView } from '../src/telnetWebView';
import { configurationOverrides, envState } from './helpers/vscodeStub';

const makeService = () => ({
  onDidChange: () => ({ dispose: () => undefined }),
  onOutput: () => ({ dispose: () => undefined }),
  getTargets: () => [
    { key: 'baseapp:31001', label: 'baseapp', host: '127.0.0.1', port: 31001 },
    { key: 'cellapp:31000', label: 'cellapp', host: '127.0.0.1', port: 31000 },
    { key: 'loginapp:31002', label: 'loginapp', host: '127.0.0.1', port: 31002 }
  ],
  getState: (key: string) =>
    key === 'cellapp:31000' ? 'connected' : key === 'baseapp:31001' ? 'open' : 'auth-rejected',
  getSessionState: () => 'ready',
  getOutput: () => ['echo: len(entities)']
});

const render = (): string => {
  const webview = new TelnetWebView(
    {} as unknown as import('vscode').ExtensionContext,
    makeService() as never
  );
  return (webview as unknown as { getHtml: () => string }).getHtml();
};

beforeEach(() => {
  configurationOverrides.delete('kbengine');
  envState.language = 'zh-cn';
});

describe('TelnetWebView 设计系统', () => {
  it('token 进面板,Bootstrap 状态灯旧色退场', () => {
    const html = render();
    expect(html).toContain('--kode-ok:#89d185');
    expect(html).not.toContain('#5cb85c');
    expect(html).not.toContain('#d9534f');
    expect(html).not.toContain('#f0ad4e');
  });

  it('目标列表 + 会话区双栏布局(tel-body/tel-targets/tel-session)', () => {
    const html = render();
    expect(html).toContain('class="tel-body"');
    expect(html).toContain('id="targets"');
    expect(html).toContain('id="session"');
  });
});

describe('TelnetWebView i18n', () => {
  it('zh:状态词与现有枚举一一对应(沿用现有文案)', () => {
    const html = render();
    expect(html).toContain('已连接');
    expect(html).toContain('密码被拒');
    expect(html).toContain('连接会话(自动登录)');
    expect(html).toContain('Ctrl+] / Ctrl+D 断开会话');
  });

  it('en:kbengine.webviewLocale=en 输出英文面板与状态词', () => {
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    const html = render();
    expect(html).toContain('KBEngine Telnet Probe');
    expect(html).toContain('Connected');
    expect(html).toContain('Auth rejected');
    expect(html).toContain('Connect session (auto login)');
    expect(html).not.toContain('连接会话(自动登录)');
  });

  it('en:拒绝提示本地化注入内联脚本', () => {
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    const html = render();
    expect(html).toContain('Rejected (not allow-listed or session not ready): ');
    expect(html).not.toContain('已拒绝(白名单外或会话未就绪): ');
  });
});
