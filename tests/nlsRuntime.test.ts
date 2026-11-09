// KODE-I18N-002:共用公共实现 nlsRuntime 的取词契约。
// 三态断言:默认(未注入 bundle)= 英文源串(与真实 VS Code 英文 locale
// 同口径);注入 zh-cn bundle = 中文;译文包缺 key = 回落英文源串(不空串,
// 占位符仍替换)——真实 VS Code 对缺失 key 的行为就是原样返回 message。
import { afterEach, describe, expect, it } from 'vitest';
import { setL10nBundle } from './fake-vscode/l10n';
import { l10nText } from '../src/nlsRuntime';
import { activate } from '../src/extension';
import { commandRegistry } from './fake-vscode/commandRegistry';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';

afterEach(() => {
  setL10nBundle(null);
});

describe('nlsRuntime 共用实现取词契约', () => {
  it('英文默认(未注入 bundle)返回英文源串', () => {
    expect(l10nText('Telnet: {label}', { label: 'baseapp' })).toBe('Telnet: baseapp');
  });

  it('缺 key 回退:译文包没有该键时原样返回英文源串,占位符仍替换', () => {
    setL10nBundle({ 'Connected': '已连接' });
    expect(l10nText('Connected')).toBe('已连接');
    expect(l10nText('Source-only key {n}', { n: 3 })).toBe('Source-only key 3');
    expect(l10nText('Source-only key')).not.toBe('');
  });

  // UX-REVIEW-010f 真机探针:kbengine.l10nProbe(activate 注册,不在
  // contributes=不出命令面板)返回当前扩展上下文的产品取词结果,真机层
  // --bundlefallback 经 executeCommand 用它验证缺 key 回退。两态单元锁:
  // 命令返回值随 l10n bundle 切换,与 l10nText 同源。
  it('真机探针命令 kbengine.l10nProbe 两态返回产品取词结果', async () => {
    commandRegistry.reset();
    const context: ExtensionContext = { subscriptions: [], extensionUri: Uri.file('/tmp') };
    activate(context);
    await new Promise(resolve => setTimeout(resolve, 100));
    const probe = commandRegistry.registrations.get('kbengine.l10nProbe');
    expect(probe, 'kbengine.l10nProbe 未注册').toBeDefined();
    expect(await probe!.handler('Not identified')).toBe('Not identified');
    setL10nBundle(zhCnBundle as Record<string, string>);
    expect(await probe!.handler('Not identified')).toBe('未识别');
    for (const disposable of context.subscriptions) disposable.dispose();
  });

  it('占位符在译文内替换(先查译文再替换,与真实 vscode.l10n 同序)', () => {
    setL10nBundle({ 'Port probe {host}:{port}': '端口探测 {host}:{port}' });
    expect(l10nText('Port probe {host}:{port}', { host: '127.0.0.1', port: 20013 })).toBe(
      '端口探测 127.0.0.1:20013'
    );
  });
});
