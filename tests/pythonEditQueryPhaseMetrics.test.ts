import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { Uri } from './fake-vscode/core';
import { makeTextDocument } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { PythonClassIndex } from '../src/pythonClassIndex';
import {
  getLanguageServiceSummaryReport,
  getOperationSummary,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import {
  flushPendingDocumentReturnAnnotationsForTests,
  resolveLocalVariableReturnTypeFromSnapshot
} from '../src/pythonReturnTypeInference';

// IDE-RST-009:Python 编辑查询四阶段耗时拆分——解析(document-parse,既有
// PR1 打点)、提交(document-commit)、MRO(python-mro-resolve)、查询
// (python-annotation-query,普通变量 hover 的注解路径=快照解析面)。
// 四段统一走 languageServiceMetrics 聚合面(showSummary 报告自动纳新行)。

const temporaryDirectories: string[] = [];

afterEach(() => {
  resetLanguageServiceMetrics();
  stubWorkspace.workspaceFolders = [];
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const makeRoot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-rst009-'));
  temporaryDirectories.push(dir);
  return dir;
};

const pythonDoc = (dir: string, name: string, text: string) =>
  makeTextDocument(text, {
    fileName: path.join(dir, name),
    languageId: 'python',
    uri: Uri.file(path.join(dir, name)),
    version: 1
  }) as never;

describe('IDE-RST-009:Python 编辑查询耗时阶段拆分', () => {
  it('编辑面:同一次文档变更同时产出解析与提交两段样本', async () => {
    const dir = makeRoot();
    resetLanguageServiceMetrics();
    const index = new PythonClassIndex();
    await index.onDocumentChanged(pythonDoc(dir, 'thing.py', 'class Thing:\n\tdef alpha(self):\n\t\tpass\n'));

    expect((getOperationSummary('document-parse')?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect((getOperationSummary('document-commit')?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('MRO 面:providersOfMethod 产出 python-mro-resolve 样本', async () => {
    const dir = makeRoot();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
    const index = new PythonClassIndex();
    await index.onDocumentChanged(pythonDoc(dir, 'base.py', 'class Base:\n\tdef foo(self):\n\t\tpass\n'));
    await index.onDocumentChanged(pythonDoc(dir, 'sub.py', 'class Sub(Base):\n\tdef bar(self):\n\t\tpass\n'));

    resetLanguageServiceMetrics();
    const providers = await index.providersOfMethod('Sub', 'foo');
    expect(providers.length).toBeGreaterThanOrEqual(1);
    expect(providers[0].className).toBe('Base');
    expect((getOperationSummary('python-mro-resolve')?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('查询面:普通变量 hover 注解路径产出 python-annotation-query 样本', async () => {
    const dir = makeRoot();
    resetLanguageServiceMetrics();
    const source = ['data = get_data()', '', 'def get_data() -> JSONDATA:', '\tpass'].join('\n');
    const context = { fileKey: path.join(dir, 'm.py'), version: 1, source: () => source };
    // IDE-REV-010:首次查询只读已发布桶并触发受控异步更新;发布后查询可见
    resolveLocalVariableReturnTypeFromSnapshot(source.split('\n'), 0, 'data', dir, context);
    await flushPendingDocumentReturnAnnotationsForTests();
    const resolved = resolveLocalVariableReturnTypeFromSnapshot(
      source.split('\n'),
      0,
      'data',
      dir,
      context
    );

    expect(resolved?.annotation).toBe('JSONDATA');
    expect((getOperationSummary('python-annotation-query')?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('汇总报告含四段行(解析/提交/MRO/查询)', async () => {
    const dir = makeRoot();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
    const index = new PythonClassIndex();
    await index.onDocumentChanged(pythonDoc(dir, 'base.py', 'class Base:\n\tdef foo(self):\n\t\tpass\n'));
    await index.onDocumentChanged(pythonDoc(dir, 'sub.py', 'class Sub(Base):\n\tdef bar(self):\n\t\tpass\n'));
    await index.providersOfMethod('Sub', 'foo');
    const source = ['data = get_data()', '', 'def get_data() -> JSONDATA:', '\tpass'].join('\n');
    resolveLocalVariableReturnTypeFromSnapshot(source.split('\n'), 0, 'data', dir, {
      fileKey: path.join(dir, 'm.py'),
      version: 1,
      source: () => source
    });

    const report = getLanguageServiceSummaryReport();
    for (const name of ['document-parse', 'document-commit', 'python-mro-resolve', 'python-annotation-query']) {
      expect(report, `汇总报告缺 ${name} 行`).toContain(name);
    }
  });
});
