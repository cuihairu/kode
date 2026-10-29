import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PythonClassIndex } from '../src/pythonClassIndex';
import {
  getOperationSummary,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import { makeTextDocument } from './fake-vscode/core';
import type { MinimalTextDocument } from './fake-vscode/core';

// IDE-REV-001:统一 Python 解析入口的版本代守卫——syncDocumentParse 同步发布
// 新版本时必须同步推进 revision 令牌与当前文档身份:在途旧版 worker 的回包
// 在令牌守卫处丢弃,已发布新代不被覆盖回旧代;同版本编辑通知命中缓存提前
// 返回后不再留下旧代回写窗口。

const temporaryDirectories: string[] = [];
const parseCount = (): number => getOperationSummary('document-parse')?.count ?? 0;

afterEach(() => {
  resetLanguageServiceMetrics();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

const genSource = (className: string): string =>
  `class ${className}(Base):\n    def m(self):\n        return 1\n`;

function documentAt(filePath: string, className: string, version: number): MinimalTextDocument {
  return makeTextDocument(genSource(className), { fileName: filePath, languageId: 'python', version });
}

describe('IDE-REV-001:Python 解析入口版本代守卫', () => {
  it('门住 v1 worker→同步发布 v2→同版本通知提前返回→释放 v1 后仍为 v2;v3 前进与同版本去重', async () => {
    resetLanguageServiceMetrics();
    const filePath = '/tmp/rev-guard/avatar.py'; // 纯缓冲路径,全程无磁盘 IO
    const index = new PythonClassIndex();
    const v1 = documentAt(filePath, 'GenOne', 1);
    const v2 = documentAt(filePath, 'GenTwo', 2);

    // 门住 v1 worker:onDocumentChanged 同步段只完成令牌递增与任务派发,
    // 提交段在其后微任务——此刻同步发布 v2 即「旧回包在途,新代已发布」
    const staleWorker = index.onDocumentChanged(v1 as never);
    expect(index.getParsedForVersion(filePath, 1)).toBeNull(); // v1 尚未提交

    const published = index.syncDocumentParse(v2);
    expect(published.classes.some(cls => cls.name === 'GenTwo')).toBe(true);
    expect(index.getParsedForVersion(filePath, 2)).toBe(published); // 新代已入缓存

    // 同版本编辑通知:命中缓存提前返回(零解析零提交),不再递增令牌
    const deduped = index.onDocumentChanged(v2 as never);
    await staleWorker; // 释放 v1:回包必须被令牌守卫丢弃
    await deduped;
    expect(parseCount()).toBe(1); // 唯一一次解析=同步发布的 v2

    // 释放 v1 后仍为 v2:v1 从未发布,新代不被覆盖回旧代
    expect(index.getParsedForVersion(filePath, 2)).toBe(published);
    expect(index.getParsedForVersion(filePath, 1)).toBeNull();

    // v3:版本前进换新代(新令牌),发布后可查
    const v3 = documentAt(filePath, 'GenThree', 3);
    await index.onDocumentChanged(v3 as never);
    const v3Parsed = index.getParsedForVersion(filePath, 3);
    expect(v3Parsed?.classes.some(cls => cls.name === 'GenThree')).toBe(true);
    expect(parseCount()).toBe(2);

    // 同版本去重:重复 v3 通知零解析零提交,缓存对象不变
    await index.onDocumentChanged(v3 as never);
    await index.onDocumentChanged(v3 as never);
    expect(parseCount()).toBe(2);
    expect(index.getParsedForVersion(filePath, 3)).toBe(v3Parsed);
  });

  it('同步发布注册当前文档身份:后续按需装载读缓冲,不回退磁盘旧内容', async () => {
    resetLanguageServiceMetrics();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-rev1-'));
    temporaryDirectories.push(root);
    const filePath = path.join(root, 'avatar.py');
    fs.writeFileSync(filePath, genSource('DiskOld'), 'utf8');

    const index = new PythonClassIndex();
    // 缓冲内容(未保存)比磁盘新:同步发布后,磁盘上仍是旧代
    const buffer = makeTextDocument(genSource('BufferNew'), {
      fileName: filePath, languageId: 'python', version: 7
    });
    index.syncDocumentParse(buffer);

    // 文件变更触发的按需装载必须读缓冲身份(版本 7 的新内容),不回退磁盘
    await index.onFileChanged(filePath);
    const loaded = index.getParsedForVersion(filePath, 7);
    expect(loaded?.classes.some(cls => cls.name === 'BufferNew')).toBe(true);
  });
});
