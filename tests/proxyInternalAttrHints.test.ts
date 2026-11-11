import { describe, expect, it, beforeEach } from 'vitest';
import {
  KBEngineProxyInternalAttrHintsProvider,
  PROXY_INTERNAL_ATTR_HINTS_SETTING
} from '../src/languageProviders/inlay';
import {
  Position,
  Range,
  configurationOverrides,
  makeTextDocument,
  windowState
} from './helpers/vscodeStub';
import { setL10nBundle } from './fake-vscode/l10n';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 批 ③(用户令 2026-11-11):Proxy 的 __ACCOUNT_NAME__/__ACCOUNT_PASSWORD__
// 访问处渲染「内部属性 · Proxy」提示;项目桩包 Proxy.pyi 在盘时经
// InlayHintLabelPart.location 出导航(与复制属性提示同一惯用法)。声明行
// 现场扫描项目副本——副本可魔改,钉死行号必漂。

const PROXY_PYE = '/ws/.kbengine/stubs/KBEngine/Proxy.pyi';
const PROXY_PYE_CONTENT = [
  'class Proxy(Entity):',
  '    __ACCOUNT_NAME__: str',
  '    __ACCOUNT_PASSWORD__: str',
  ''
].join('\n');

const doc = (text: string, fileName = '/ws/scripts/base/Account.py'): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python' });

const fullRange = (document: MinimalTextDocument): Range => {
  const lastLine = document.getText().split('\n').length - 1;
  return new Range(new Position(0, 0), new Position(lastLine, 0));
};

interface PartLike {
  value: string;
  location?: { uri: { fsPath: string }; range: { start: { line: number } } };
}

const labelParts = (hint: unknown): PartLike[] =>
  Array.isArray((hint as { label: unknown }).label)
    ? ((hint as { label: PartLike[] }).label)
    : [];

beforeEach(() => {
  configurationOverrides.clear();
  windowState.reset();
});

describe('KBEngineProxyInternalAttrHintsProvider', () => {
  it('设置键为 python.proxyInternalAttrHints(kbengine 段相对键)', () => {
    expect(PROXY_INTERNAL_ATTR_HINTS_SETTING).toBe('python.proxyInternalAttrHints');
  });

  it('两个内部属性访问处出提示,带项目副本声明行导航', async () => {
    const provider = new KBEngineProxyInternalAttrHintsProvider({
      resolveProxyPyiPath: () => PROXY_PYE,
      readFile: () => PROXY_PYE_CONTENT
    });
    const document = doc(
      'class Account(Proxy):\n    def onLogin(self):\n        self.__ACCOUNT_NAME__ = ""\n        self.__ACCOUNT_PASSWORD__ = ""\n'
    );
    const hints = await provider.provideInlayHints(document, fullRange(document));

    expect(hints).toHaveLength(2);
    const [first, second] = hints as Array<{ position: { line: number; character: number }; label: unknown }>;
    // 提示位在访问表达式之后(同一行)
    expect(first.position.line).toBe(2);
    expect(second.position.line).toBe(3);
    const firstParts = labelParts(first);
    expect(firstParts).toHaveLength(1);
    expect(firstParts[0]!.value).toContain('internal attribute');
    expect(firstParts[0]!.value).toContain('Proxy');
    // 导航面:项目副本声明行(现场扫描,NAME 在副本第 1 行)
    expect(firstParts[0]!.location?.uri.fsPath).toBe(PROXY_PYE);
    expect(firstParts[0]!.location?.range.start.line).toBe(1);
    const secondParts = labelParts(second);
    expect(secondParts[0]!.location?.range.start.line).toBe(2);
  });

  it('桩未复制(resolveProxyPyiPath null)只出标签,不出导航', async () => {
    const provider = new KBEngineProxyInternalAttrHintsProvider({
      resolveProxyPyiPath: () => null
    });
    const document = doc('self.__ACCOUNT_NAME__\n');
    const hints = await provider.provideInlayHints(document, fullRange(document));

    expect(hints).toHaveLength(1);
    const parts = labelParts(hints[0]);
    expect(parts[0]!.value).toContain('internal attribute');
    expect(parts[0]!.location).toBeUndefined();
  });

  it('zh 语言包注入后标签出中文(内部属性)', async () => {
    setL10nBundle({ 'internal attribute': '内部属性' });
    try {
      const provider = new KBEngineProxyInternalAttrHintsProvider({
        resolveProxyPyiPath: () => null
      });
      const document = doc('self.__ACCOUNT_NAME__\n');
      const hints = await provider.provideInlayHints(document, fullRange(document));

      expect(hints).toHaveLength(1);
      expect(labelParts(hints[0])[0]!.value).toBe('内部属性 · Proxy');
    } finally {
      setL10nBundle(null);
    }
  });

  it('项目副本里没有该属性声明行时,标签照出导航缺位(宁缺勿错)', async () => {
    const provider = new KBEngineProxyInternalAttrHintsProvider({
      resolveProxyPyiPath: () => PROXY_PYE,
      readFile: () => 'class Proxy(Entity):\n    pass\n'
    });
    const document = doc('self.__ACCOUNT_NAME__\n');
    const hints = await provider.provideInlayHints(document, fullRange(document));

    expect(hints).toHaveLength(1);
    expect(labelParts(hints[0])[0]!.location).toBeUndefined();
  });

  it('开关关(proxies 内部属性提示=false)返回空', async () => {
    configurationOverrides.set('kbengine', { 'python.proxyInternalAttrHints': false });
    const provider = new KBEngineProxyInternalAttrHintsProvider({
      resolveProxyPyiPath: () => PROXY_PYE,
      readFile: () => PROXY_PYE_CONTENT
    });
    const document = doc('self.__ACCOUNT_NAME__\n');
    expect(await provider.provideInlayHints(document, fullRange(document))).toEqual([]);
  });

  it('非 demo 资产脚本域(无 base/cell/client/bots 段)不提示', async () => {
    const provider = new KBEngineProxyInternalAttrHintsProvider({
      resolveProxyPyiPath: () => PROXY_PYE,
      readFile: () => PROXY_PYE_CONTENT
    });
    const document = doc('self.__ACCOUNT_NAME__\n', '/ws/loose.py');
    expect(await provider.provideInlayHints(document, fullRange(document))).toEqual([]);
  });

  it('非 python 文件不提示', async () => {
    const provider = new KBEngineProxyInternalAttrHintsProvider({
      resolveProxyPyiPath: () => PROXY_PYE,
      readFile: () => PROXY_PYE_CONTENT
    });
    const document = makeTextDocument('self.__ACCOUNT_NAME__\n', {
      fileName: '/ws/scripts/base/notes.txt',
      languageId: 'plaintext'
    });
    expect(await provider.provideInlayHints(document, fullRange(document))).toEqual([]);
  });

  it('视窗口外不出 hint(inlay 按可视区要)', async () => {
    const provider = new KBEngineProxyInternalAttrHintsProvider({
      resolveProxyPyiPath: () => PROXY_PYE,
      readFile: () => PROXY_PYE_CONTENT
    });
    const document = doc(
      'self.__ACCOUNT_NAME__\nself.__ACCOUNT_NAME__\nself.__ACCOUNT_NAME__\nself.__ACCOUNT_NAME__\n'
    );
    const window = new Range(new Position(1, 0), new Position(2, 0));
    const hints = await provider.provideInlayHints(document, window);

    expect(hints).toHaveLength(2);
    for (const hint of hints as Array<{ position: { line: number } }>) {
      expect(hint.position.line).toBeGreaterThanOrEqual(1);
      expect(hint.position.line).toBeLessThanOrEqual(2);
    }
  });
});
