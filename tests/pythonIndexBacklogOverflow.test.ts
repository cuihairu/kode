import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PythonClassIndex } from '../src/pythonClassIndex';
import type { ParsedPythonFile } from '../src/pythonParser';
import { makeTextDocument } from './helpers/vscodeStub';
import { Uri } from './fake-vscode/core';

// IDE-RES-002 调用面:pythonParserWorkerHost 积压字节上限拒绝(可解释错误)
// 到达 pythonClassIndex 时——onDocumentChanged 不得把拒绝变 unhandled rejection
// 上抛;本次编辑不入索引,下一次编辑同通道自然重试。host 侧上限本身另有
// pythonParserWorkerHost.test.ts 直测,此处 mock 拒绝只锁调用方行为。

const hostMock = vi.hoisted(() => ({
  failuresLeft: 0
}));

vi.mock('../src/pythonParserWorkerHost', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/pythonParserWorkerHost')>();
  const { parsePythonFile } = await import('../src/pythonParser');
  return {
    ...actual,
    parsePythonFileResponsive: vi.fn(async (
      content: string,
      filePath: string,
      revision: number
    ): Promise<{ revision: number; parsed: ParsedPythonFile }> => {
      if (hostMock.failuresLeft > 0) {
        hostMock.failuresLeft -= 1;
        throw new Error('Python parse backlog byte budget exceeded (8388608 bytes queued)');
      }
      return { revision, parsed: parsePythonFile(content, filePath) };
    })
  };
});

interface VersionedDocument extends ReturnType<typeof makeTextDocument> {
  version: number;
}

const makeDoc = (text: string, version: number): VersionedDocument => {
  const document = makeTextDocument(text, {
    fileName: '/ws/backlog.py',
    languageId: 'python',
    uri: Uri.file('/ws/backlog.py')
  }) as VersionedDocument;
  document.version = version;
  return document;
};

describe('IDE-RES-002 调用面:积压上限拒绝不变成 unhandled rejection', () => {
  beforeEach(() => {
    hostMock.failuresLeft = 0;
  });

  it('host 拒绝时 onDocumentChanged 正常返回,本次不入索引;下次编辑自愈', async () => {
    const index = new PythonClassIndex();
    hostMock.failuresLeft = 1;

    const first = makeDoc('class A:\n\tdef m(self):\n\t\tpass\n', 1);
    // 修复前:拒绝穿透 onDocumentChanged 上抛(调用方 extension 处是 void,
    // 成 unhandled rejection);修复后:吞下并日志,返回 undefined
    await expect(index.onDocumentChanged(first)).resolves.toBeUndefined();
    expect(index.getParsedForVersion(first.fileName, 1)).toBeNull();

    // 下一次编辑(版本前进)同通道重试:成功后该版本可查
    const second = makeDoc('class A:\n\tdef m(self):\n\t\tpass\n\tdef n(self):\n\t\tpass\n', 2);
    await expect(index.onDocumentChanged(second)).resolves.toBeUndefined();
    const parsed = index.getParsedForVersion(second.fileName, 2);
    expect(parsed).not.toBeNull();
    expect(parsed?.classes.map(cls => cls.name)).toEqual(['A']);
    expect([...(parsed?.classes[0]?.methods.keys() ?? [])]).toEqual(['m', 'n']);
  });
});
