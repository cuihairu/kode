import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PythonClassIndex, resetDegradedParseNoticeForTests } from '../src/backend/pythonClassIndex';
import type { ParsedPythonFile } from '../src/backend/pythonParser';
import { makeTextDocument } from './helpers/vscodeStub';
import { Uri } from './fake-vscode/core';
import { messages } from './fake-vscode/windowState';

// IDE-RES-002 调用面:pythonParserWorkerHost 积压字节上限拒绝(可解释错误)
// 到达 pythonClassIndex 时——asyncDocumentParse 不得把拒绝变 unhandled rejection
// 上抛;本次编辑不入索引,下一次编辑同通道自然重试。host 侧上限本身另有
// pythonParserWorkerHost.test.ts 直测,此处 mock 拒绝只锁调用方行为。
// RUST-031:超预算拒绝属能力限制,须走用户明示面(每文件会话内一次);
// worker 停用等非能力限制错误不警示。

const hostMock = vi.hoisted(() => ({
  failuresLeft: 0,
  disposedLeft: 0
}));

vi.mock('../src/backend/pythonParserWorkerHost', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/backend/pythonParserWorkerHost')>();
  const { parsePythonFile } = await import('../src/backend/pythonParser');
  return {
    ...actual,
    parsePythonFileResponsive: vi.fn(async (
      content: string,
      filePath: string,
      revision: number
    ): Promise<{ revision: number; parsed: ParsedPythonFile }> => {
      if (hostMock.disposedLeft > 0) {
        hostMock.disposedLeft -= 1;
        throw new Error('Python parser worker disposed');
      }
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
    hostMock.disposedLeft = 0;
    resetDegradedParseNoticeForTests();
    messages.warning.length = 0;
  });

  it('host 拒绝时按需解析(asyncDocumentParse)正常返回,本次不入索引;下次编辑自愈', async () => {
    const index = new PythonClassIndex();
    hostMock.failuresLeft = 1;

    const first = makeDoc('class A:\n\tdef m(self):\n\t\tpass\n', 1);
    // 修复前:拒绝穿透 asyncDocumentParse 上抛(调用方 extension 处是 void,
    // 成 unhandled rejection);修复后:吞下并日志,返回 undefined
    await expect(index.asyncDocumentParse(first)).resolves.toBeNull();
    expect(index.getParsedForVersion(first.fileName, 1)).toBeNull();

    // 下一次编辑(版本前进)同通道重试:成功后该版本可查
    const second = makeDoc('class A:\n\tdef m(self):\n\t\tpass\n\tdef n(self):\n\t\tpass\n', 2);
    await index.asyncDocumentParse(second);
    const parsed = index.getParsedForVersion(second.fileName, 2);
    expect(parsed).not.toBeNull();
    expect(parsed?.classes.map(cls => cls.name)).toEqual(['A']);
    expect([...(parsed?.classes[0]?.methods.keys() ?? [])]).toEqual(['m', 'n']);
  });

  it('RUST-031 明示面:超预算降级每文件警示一次,非预算错误不警示', async () => {
    const index = new PythonClassIndex();

    // 首次超预算拒绝:用户可见警示(明示能力限制,文案含「降级」)
    hostMock.failuresLeft = 1;
    const doc = makeDoc('class A:\n\tdef m(self):\n\t\tpass\n', 1);
    await index.asyncDocumentParse(doc);
    expect(messages.warning).toHaveLength(1);
    expect(messages.warning[0]).toContain('降级');
    expect(messages.warning[0]).toContain('backlog.py');

    // 同文件第二次拒绝:去重,不重复轰炸
    hostMock.failuresLeft = 1;
    const doc2 = makeDoc('class A:\n\tdef m(self):\n\t\tpass\n', 2);
    await index.asyncDocumentParse(doc2);
    expect(messages.warning).toHaveLength(1);

    // 另一文件拒绝:再警示一次(每文件各一次)
    hostMock.failuresLeft = 1;
    const other = makeTextDocument('class B:\n\tpass\n', {
      fileName: '/ws/other.py',
      languageId: 'python',
      uri: Uri.file('/ws/other.py')
    });
    other.version = 1;
    await index.asyncDocumentParse(other as typeof doc);
    expect(messages.warning).toHaveLength(2);
    expect(messages.warning[1]).toContain('other.py');

    // 非预算错误(worker 停用形态):能力限制不成立,不警示
    hostMock.disposedLeft = 1;
    const doc3 = makeDoc('class A:\n\tdef m(self):\n\t\tpass\n', 3);
    await index.asyncDocumentParse(doc3);
    expect(messages.warning).toHaveLength(2);
  });

  it('RUST-031 有界去重表:超过 50 文件逐出最旧,被逐出的文件再次降级会重新警示', async () => {
    const index = new PythonClassIndex();
    const docAt = (name: string, version: number): VersionedDocument => {
      const document = makeTextDocument('class A:\n\tpass\n', {
        fileName: `/ws/big/${name}.py`,
        languageId: 'python',
        uri: Uri.file(`/ws/big/${name}.py`)
      }) as VersionedDocument;
      document.version = version;
      return document;
    };

    // 51 个不同文件各超预算一次:去重表有界 50,第 51 个入表时逐出最旧(第 1 个)
    for (let i = 0; i < 51; i += 1) {
      hostMock.failuresLeft = 1;
      await index.asyncDocumentParse(docAt(`f${i}`, 1));
    }
    expect(messages.warning).toHaveLength(51);

    // 被逐出的第一个文件再次超预算:去重表里已无它,重新警示一次
    hostMock.failuresLeft = 1;
    await index.asyncDocumentParse(docAt('f0', 2));
    expect(messages.warning).toHaveLength(52);
    expect(messages.warning[51]).toContain('f0.py');

    // 仍在表内的文件再次拒绝:去重,不重复警示
    hostMock.failuresLeft = 1;
    await index.asyncDocumentParse(docAt('f10', 2));
    expect(messages.warning).toHaveLength(52);
  });
});
