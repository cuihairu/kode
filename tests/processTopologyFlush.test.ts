import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  activate,
  deactivate,
  getProcessTopologySchedulerForTests,
  setProcessTopologySchedulerForTests
} from '../src/extension';
import { workspace, workspaceEvents } from './fake-vscode/workspaceState';
import { Uri, makeTextDocument, type ExtensionContext } from './fake-vscode/core';

// KODE-AUD-001:extension.ts 编辑冲刷周期此前只 requestQueued 进程拓扑诊断,
// 不同节拍 flushQueued,queued 任务滞留不发布致「编辑 .def/entities.xml/
// process_topology.xml 后编辑期诊断不更新」。本集成测试经测试访问器暴露
// processTopologyScheduler(activate 内局部实例,镜像 getDiagnosticScheduler
// 不可达,故加 set/getProcessTopologySchedulerForTests),断言:
// ① 编辑清单文档 → requestQueued 受理(requested 递增);
// ② 同节拍宏任务冲刷 → flushQueued 排空队列(computed>0)——无修复时
//    flush 定时器只冲刷其余四个调度器,本队列永不处理,computed 恒 0,此断言即红。

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

describe('KODE-AUD-001 进程拓扑编辑冲刷接线(编辑事件→requestQueued→flushQueued)', () => {
  it('编辑 process_topology.xml:受理入队,同节拍冲刷后队列排空并计算', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-aud001-'));
    fs.writeFileSync(path.join(root, 'process_topology.xml'), MANIFEST, 'utf-8');
    // languageId='xml':避免被 isDefDocument(languageId==='kbengine-def') 提前分流,
    // 使编辑事件落到 isProcessTopologyManifestDocument 分支
    const manifestDoc = makeTextDocument(MANIFEST, {
      fileName: path.join(root, 'process_topology.xml'),
      languageId: 'xml'
    });
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.textDocuments = [manifestDoc];

    const context = makeContext();
    try {
      activate(context);
      const scheduler = getProcessTopologySchedulerForTests();
      expect(scheduler, 'activate 应已装配并暴露进程拓扑调度器').not.toBeNull();

      // 激活期对已打开清单文档走 'immediate' 通道立即计算(extension.ts:2041),
      // 先等它落定再取基线,否则初始异步计算干扰 computed 断言
      await scheduler!.pendingComputations();
      await waitMs(10);
      const requestedBefore = scheduler!.stats.requested;
      const computedBefore = scheduler!.stats.computed;

      // 编辑事件 → onDidChangeTextDocument → queued 通道受理
      workspaceEvents.documentChanged.fire({
        document: manifestDoc,
        contentChanges: [{ text: MANIFEST }]
      });
      expect(scheduler!.stats.requested, '编辑事件应受理 requestQueued').toBe(
        requestedBefore + 1
      );

      // 同节拍冲刷:flush 定时器(setTimeout 0)→ flushQueued → computeAsync
      // (Rust 门禁在 vitest 不可用 → 返回 [] → publish 空)→ 队列排空
      await waitMs(30);
      await scheduler!.pendingComputations();

      expect(
        scheduler!.stats.computed,
        '无修复时 flush 周期漏 processTopologyScheduler.flushQueued(),' +
          'queued 任务滞留永不计算(恒 0);有修复应 >0'
      ).toBeGreaterThan(computedBefore);
    } finally {
      setProcessTopologySchedulerForTests(null);
      deactivate();
    }
  });
});
