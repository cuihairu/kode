// webviewStrings:全套 i18n 字符串表(zh 默认 + en 全量)。8 个 webview 面板
// 的全部文案走这里;语言跟随 vscode.env.language(zh-cn/zh-tw→中文,其余→
// 英文),kbengine.webviewLocale(auto/zh/en)可覆盖。telnet 状态词与现有
// TelnetProbeState 枚举一一对应(诊断报告 §四)。
import { beforeEach, describe, expect, it } from 'vitest';
import * as stub from './helpers/vscodeStub';
import {
  resolveLocale,
  resolvePanelLocale,
  strings,
  telnetStateLabels,
  type WebviewLocale
} from '../src/webviewStrings';

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    flattenKeys(v, prefix ? `${prefix}.${k}` : k)
  );
}

describe('resolveLocale', () => {
  it('auto:zh-cn/zh-tw 归中文,其余归英文', () => {
    expect(resolveLocale('auto', 'zh-cn')).toBe('zh');
    expect(resolveLocale('auto', 'zh-tw')).toBe('zh');
    expect(resolveLocale('auto', 'en')).toBe('en');
    expect(resolveLocale('auto', 'ja')).toBe('en');
  });

  it('大小写不敏感且未知语言回落英文', () => {
    expect(resolveLocale('auto', 'ZH-CN')).toBe('zh');
    expect(resolveLocale('auto', '')).toBe('en');
  });

  it('显式设置覆盖 env 语言', () => {
    expect(resolveLocale('zh', 'en')).toBe('zh');
    expect(resolveLocale('en', 'zh-cn')).toBe('en');
  });
});

describe('resolvePanelLocale(经 vscode 语境)', () => {
  beforeEach(() => {
    stub.configurationOverrides.delete('kbengine');
    stub.envState.language = 'en';
  });

  it('默认 auto 跟随 env.language', () => {
    stub.envState.language = 'zh-cn';
    expect(resolvePanelLocale()).toBe('zh');
    stub.envState.language = 'en';
    expect(resolvePanelLocale()).toBe('en');
  });

  it('kbengine.webviewLocale 可覆盖', () => {
    stub.envState.language = 'zh-cn';
    stub.configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    expect(resolvePanelLocale()).toBe('en');
    stub.envState.language = 'en';
    stub.configurationOverrides.set('kbengine', { webviewLocale: 'zh' });
    expect(resolvePanelLocale()).toBe('zh');
  });
});

describe('字符串表完整性', () => {
  const locales: WebviewLocale[] = ['zh', 'en'];

  it('zh/en 键集合完全一致(全量双语)', () => {
    for (const locale of locales) {
      const zhKeys = flattenKeys(strings('zh')).sort();
      const keys = flattenKeys(strings(locale)).sort();
      expect(keys).toEqual(zhKeys);
    }
  });

  it('键集合非空且覆盖 8 面板命名空间', () => {
    const table = strings('zh') as Record<string, Record<string, unknown>>;
    for (const ns of [
      'common',
      'monitoring',
      'logs',
      'telnet',
      'runtimeQuery',
      'entityDependency',
      'entityFlow',
      'defCallChain',
      'errorScan'
    ]) {
      expect(Object.keys(table[ns]).length, `namespace ${ns}`).toBeGreaterThan(0);
    }
  });

  it('zh/en 样例值正确', () => {
    expect(strings('zh').runtimeQuery.title).toBe('运行时查询');
    expect(strings('en').runtimeQuery.title).toBe('Runtime Queries');
    expect(strings('zh').monitoring.title).toBe('KBEngine 服务器监控');
    expect(strings('en').monitoring.title).toBe('KBEngine Server Monitoring');
  });
});

describe('telnet 状态词与现有枚举一一对应', () => {
  it('六个 TelnetProbeState 全覆盖且 zh 沿用现有文案', () => {
    const labels = telnetStateLabels('zh');
    expect(Object.keys(labels).sort()).toEqual(
      ['auth-rejected', 'auth-required', 'closed', 'connected', 'open', 'unconfigured'].sort()
    );
    expect(labels.unconfigured).toBe('未配置');
    expect(labels.closed).toBe('未开启');
    expect(labels.open).toBe('已开启(未接会话)');
    expect(labels['auth-required']).toBe('端口开·未配密码');
    expect(labels['auth-rejected']).toBe('密码被拒');
    expect(labels.connected).toBe('已连接');
  });

  it('en 全量翻译', () => {
    const labels = telnetStateLabels('en');
    expect(labels.unconfigured).toBe('Unconfigured');
    expect(labels.closed).toBe('Closed');
    expect(labels.open).toBe('Open');
    expect(labels['auth-required']).toBe('Auth required');
    expect(labels['auth-rejected']).toBe('Auth rejected');
    expect(labels.connected).toBe('Connected');
  });
});
