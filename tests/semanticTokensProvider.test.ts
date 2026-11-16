// SemanticTokens provider 装配面测试(RUST-144 批 4):配置闸(默认关,
// RUST-148 冲突矩阵裁定前 opt-in)/决策核直通(编码=纯核产物)/版本缓
// 存(同版本命中不重建,版本变更重建)。决策核本身的面(spans/编码)由
// tests/semanticTokens.test.ts 与 golden 对拍 tests/kodeSemanticTokensParity
// .test.ts 把守,此处只钉装配行为。
import { afterEach, describe, expect, it } from 'vitest';
import {
  SemanticTokens,
  configurationOverrides,
  makeTextDocument
} from './helpers/vscodeStub';
import { SemanticTokensProvider } from '../src/semanticTokensProvider';
import {
  buildSemanticTokenSpans,
  encodeSemanticTokens
} from '../src/backend/semanticTokens';

const TEXT = ['class Avatar:', '    async def shoot(self, target):', '        pass', ''].join('\n');

describe('semantic tokens provider 装配(RUST-144 批 4)', () => {
  afterEach(() => {
    configurationOverrides.delete('kbengine');
  });

  it('配置闸:默认关零 token,开闸出码,回关再零', async () => {
    const provider = new SemanticTokensProvider();
    const document = makeTextDocument(TEXT, { fileName: '/proj/scripts/avatar.py', languageId: 'python', version: 1 });
    const off = (await provider.provideDocumentSemanticTokens(document)) as SemanticTokens;
    expect(Array.from(off.data)).toEqual([]);
    configurationOverrides.set('kbengine', { 'semanticTokens.enabled': true });
    const on = (await provider.provideDocumentSemanticTokens(document)) as SemanticTokens;
    expect(on.data.length).toBeGreaterThan(0);
    expect(on.data.length % 5).toBe(0);
    configurationOverrides.set('kbengine', { 'semanticTokens.enabled': false });
    const offAgain = (await provider.provideDocumentSemanticTokens(document)) as SemanticTokens;
    expect(Array.from(offAgain.data)).toEqual([]);
  });

  it('决策核直通:provider 编码与纯核 spans→encode 逐字节相等', async () => {
    configurationOverrides.set('kbengine', { 'semanticTokens.enabled': true });
    const provider = new SemanticTokensProvider();
    const document = makeTextDocument(TEXT, { fileName: '/proj/scripts/avatar.py', languageId: 'python', version: 1 });
    const produced = (await provider.provideDocumentSemanticTokens(document)) as SemanticTokens;
    const expected = new Uint32Array(
      encodeSemanticTokens(buildSemanticTokenSpans(document.getText()))
    );
    expect(Array.from(produced.data)).toEqual(Array.from(expected));
  });

  it('版本缓存:同版本命中同实例,版本变更重建新码', async () => {
    configurationOverrides.set('kbengine', { 'semanticTokens.enabled': true });
    const provider = new SemanticTokensProvider();
    const document = makeTextDocument(TEXT, { fileName: '/proj/scripts/avatar.py', languageId: 'python', version: 1 });
    const first = (await provider.provideDocumentSemanticTokens(document)) as SemanticTokens;
    const second = (await provider.provideDocumentSemanticTokens(document)) as SemanticTokens;
    // 同键命中:装箱新 SemanticTokens 但底层 buffer 同一实例(未重算)
    expect(second.data).toBe(first.data);
    // 编辑+版本递增:键随内容换,重算出不同编码
    document.setText(['class Avatar:', '    def shoot(self):', '        pass', ''].join('\n'));
    document.version = 2;
    const rebuilt = (await provider.provideDocumentSemanticTokens(document)) as SemanticTokens;
    expect(rebuilt.data).not.toBe(first.data);
    expect(Array.from(rebuilt.data)).not.toEqual(Array.from(first.data));
  });

  it('跨实例不撞键:同名新文档实例不命中旧实例缓存', async () => {
    configurationOverrides.set('kbengine', { 'semanticTokens.enabled': true });
    const provider = new SemanticTokensProvider();
    const first = makeTextDocument(TEXT, { fileName: '/proj/scripts/avatar.py', languageId: 'python', version: 1 });
    const firstTokens = (await provider.provideDocumentSemanticTokens(first)) as SemanticTokens;
    // 同名同版本的新实例(vscode 重开文档 version 重置的形态):实例身份
    // 不同 → 不命中,重算(内容不同则编码不同)
    const second = makeTextDocument(['def helper(a):', '    pass', ''].join('\n'), {
      fileName: '/proj/scripts/avatar.py',
      languageId: 'python',
      version: 1
    });
    const secondTokens = (await provider.provideDocumentSemanticTokens(second)) as SemanticTokens;
    expect(secondTokens.data).not.toBe(firstTokens.data);
    expect(Array.from(secondTokens.data)).not.toEqual(Array.from(firstTokens.data));
  });
});
