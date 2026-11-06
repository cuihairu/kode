import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  activate,
  getProcessTopologySchedulerForTests,
  setProcessTopologySchedulerForTests
} from '../src/extension';
import { workspace, workspaceEvents } from './fake-vscode/workspaceState';
import { Uri, makeTextDocument, type ExtensionContext } from './fake-vscode/core';

// KR-AUD-54:进程拓扑诊断链此前三处 getWorkspaceRootForDocument() 无参调用
// (清单路径/defs 集合/entities.xml 布局),多根工作区一律回落第一根——
// 文档在第二根时清单读不到,拓扑诊断整段静默。修复后根随触发文档定位。
// 观测面:清单只存在于第二根,编辑第二根的清单文档,scheduler.requested
// 应递增(清单按文档根解析成功才会受理入队)。

const MANIFEST = [
  '<root>',
  '  <process name="cellapp" role="cell" />',
  '</root>',
  ''
].join('\n');

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext'),
  extensionPath: path.resolve(__dirname, '..'),
  extension: { extensionKind: 'workspace' }
});

beforeEach(() => {
  workspace.workspaceFolders = [];
  workspace.textDocuments = [];
});

const waitMs = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

describe('KR-AUD-54: 进程拓扑根随触发文档定位(多根不串)', () => {
  it('文档在第二根(清单仅第二根存在):编辑事件受理入队', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-aud54-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-aud54-b-'));
    // 第一根故意无清单;清单与文档都在第二根
    fs.writeFileSync(path.join(rootB, 'process_topology.xml'), MANIFEST, 'utf-8');
    const manifestDoc = makeTextDocument(MANIFEST, {
      fileName: path.join(rootB, 'process_topology.xml'),
      languageId: 'xml'
    });
    workspace.workspaceFolders = [
      { uri: Uri.file(rootA), name: 'a', index: 0 },
      { uri: Uri.file(rootB), name: 'b', index: 1 }
    ];
    workspace.textDocuments = [manifestDoc];

    const context = makeContext();
    try {
      activate(context);
      const scheduler = getProcessTopologySchedulerForTests();
      expect(scheduler, 'activate 应已装配并暴露进程拓扑调度器').not.toBeNull();
      await scheduler!.pendingComputations();
      await waitMs(10);
      const requestedBefore = scheduler!.stats.requested;

      workspaceEvents.documentChanged.fire({
        document: manifestDoc,
        contentChanges: [{ text: MANIFEST }]
      });
      // 无参回落第一根时:清单路径解析为 rootA(无清单)→ 提前 return,
      // requestQueued 不受理,requested 不动——本断言即红
      expect(scheduler!.stats.requested, '编辑事件应受理 requestQueued').toBe(
        requestedBefore + 1
      );
    } finally {
      for (const disposable of context.subscriptions) {
        disposable.dispose();
      }
      setProcessTopologySchedulerForTests(undefined);
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  }, 8000);
});
