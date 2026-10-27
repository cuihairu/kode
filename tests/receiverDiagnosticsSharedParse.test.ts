import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PythonClassIndex } from '../src/pythonClassIndex';
import {
  computeReceiverNoneFindings,
  receiverNoneDiagnosticItems
} from '../src/receiverNoneDiagnostics';
import {
  getOperationSummary,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import { makeTextDocument } from './fake-vscode/core';
import type { MinimalTextDocument } from './fake-vscode/core';

// IDE-DIA-003:诊断复用同版本 Python 解析结果——类索引与 receiver 诊断
// 消费同一份版本键解析缓存:同版本第二次取零解析(同对象),诊断面吃
// 共享解析不再各自完整解析一次;版本前进才换新解析。

const temporaryDirectories: string[] = [];
const parseCount = (): number => getOperationSummary('document-parse')?.count ?? 0;

afterEach(() => {
  resetLanguageServiceMetrics();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

const PYTHON_SOURCE = [
  'class Avatar(Base):',
  '    def onClientDeath(self):',
  '        self.client.leaveSpace()',   // 无 guard → receiver-none
  ''
].join('\n');

const GUARDED_SOURCE = [
  'class Avatar(Base):',
  '    def onClientDeath(self):',
  '        if self.client is not None:',
  '            self.client.leaveSpace()',  // 有 guard → 不报
  ''
].join('\n');

function makePyFile(): { filePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-dia3-'));
  temporaryDirectories.push(root);
  const filePath = path.join(root, 'avatar.py');
  fs.writeFileSync(filePath, PYTHON_SOURCE, 'utf8');
  return { filePath };
}

describe('IDE-DIA-003:诊断复用同版本 Python 解析结果', () => {
  it('类索引与诊断同版本消费一次解析:同对象零重解,诊断面吃共享解析', async () => {
    const { filePath } = makePyFile();
    resetLanguageServiceMetrics();
    const index = new PythonClassIndex();
    const document: MinimalTextDocument = makeTextDocument(PYTHON_SOURCE, {
      fileName: filePath, languageId: 'python', version: 3
    });

    const first = index.syncDocumentParse(document);
    expect(first).toBeTruthy();
    expect(parseCount()).toBe(1);

    // 同版本再取:同对象,零解析
    const second = index.syncDocumentParse(document);
    expect(second).toBe(first);
    expect(parseCount()).toBe(1);

    // 类索引既有去重消费面同版本也零解析(诊断先解析,100ms 防抖补喂命中)
    await index.onDocumentChanged(document as never);
    expect(parseCount()).toBe(1);

    // 诊断面吃共享解析:guard 分析完整可用,不触发第三次解析
    const findings = computeReceiverNoneFindings(PYTHON_SOURCE, filePath, undefined, second);
    expect(findings.some(finding => finding.kind === 'receiver-none')).toBe(true);
    expect(parseCount()).toBe(1);

    // 诊断数据面与自解析口径完全一致
    expect(receiverNoneDiagnosticItems(PYTHON_SOURCE, filePath, undefined, true, second))
      .toEqual(receiverNoneDiagnosticItems(PYTHON_SOURCE, filePath, undefined, true));

    // 惰性提供器:零 receiver 使用点不过闸不取解析(DIA-001 语义保持)
    expect(computeReceiverNoneFindings(
      'class A:\n    def f(self):\n        return 42\n',
      filePath,
      undefined,
      () => { throw new Error('zero-receiver file must not request shared parse'); }
    )).toEqual([]);
    expect(parseCount()).toBe(1);
  });

  it('版本前进换新解析;版本不匹配的读取面返回 null 不误用旧代', async () => {
    const { filePath } = makePyFile();
    resetLanguageServiceMetrics();
    const index = new PythonClassIndex();
    const v3 = makeTextDocument(PYTHON_SOURCE, { fileName: filePath, languageId: 'python', version: 3 });
    const guardedV4 = makeTextDocument(GUARDED_SOURCE, { fileName: filePath, languageId: 'python', version: 4 });

    const stale = index.syncDocumentParse(v3);
    expect(parseCount()).toBe(1);
    expect(getOperationSummary('document-parse')?.count).toBe(1);

    // 版本不匹配:读取面 null(不把旧代当现版本用)
    expect(index.getParsedForVersion(filePath, 99)).toBeNull();
    expect(index.getParsedForVersion(filePath, undefined)).toBeNull();

    // 版本前进:换新解析(guard 源),诊断随共享解析不再报 receiver-none
    const fresh = index.syncDocumentParse(guardedV4);
    expect(fresh).not.toBe(stale);
    expect(parseCount()).toBe(2);
    const findings = computeReceiverNoneFindings(GUARDED_SOURCE, filePath, undefined, fresh);
    expect(findings.some(finding => finding.kind === 'receiver-none')).toBe(false);
  });
});
