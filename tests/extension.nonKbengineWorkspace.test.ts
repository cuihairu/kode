import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { activate } from '../src/extension';
import { getDiagnosticScheduler } from '../src/backend/diagnosticScheduler';
import { commandRegistry } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { messages } from './fake-vscode/windowState';
import { makeTextDocument, Position, Uri } from './fake-vscode/core';
import { workspace } from './fake-vscode/workspaceState';
import { disposeAll, makeContext, resetExtensionTestState } from './extensionTestShared';

// RUST-036(旧 AUDIT-003)负案例:onLanguage:python 激活门会把无 KBEngine
// 工作区(普通 python 项目,无 scripts/entity_defs、无 types.xml/entities.xml)
// 也带进全套装配。钉三面:①激活本身不崩(负案例主钉);②KBEngine 语义面
// 零产出——普通 .py 不产 KBEngine 诊断、悬停提供器对普通文档零 KBEngine
// 内容;③错误消息零产出(缺资产属正常形态,如实空转,不报错轰炸)。
// 初始化面已标出(current-state.md §AUDIT-003):激活即建全套机制;本例钉
// 「机制在无资产工作区空转无害」。

describe('RUST-036 无 KBEngine 工作区负案例', () => {
  it('激活不崩,机制空转:零诊断、零 KBEngine 悬停、零错误消息', async () => {
    resetExtensionTestState();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nonkbe-'));
    // 普通 python 项目:一个 .py,无任何 KBEngine 标记资产
    fs.writeFileSync(path.join(root, 'plain.py'), 'def main():\n    pass\n');
    const document = makeTextDocument('def main():\n    pass\n', {
      fileName: path.join(root, 'plain.py'),
      languageId: 'python',
      uri: Uri.file(path.join(root, 'plain.py'))
    });
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'plain-ws', index: 0 }];
    workspace.textDocuments = [document];
    const context = makeContext();
    try {
      // ①激活不崩:onLanguage:python 在无资产工作区照常完成装配
      expect(() => activate(context)).not.toThrow();
      await getDiagnosticScheduler().pendingComputations();
      // 非空守卫:装配确实发生(诊断集合与悬停提供器已注册)——否则下面的
      // 「零产出」断言会在空注册表上 vacuous 通过,负案例失去意义
      expect(languagesRegistry.diagnosticCollections.length).toBeGreaterThan(0);
      expect(languagesRegistry.hoverRegistrations.length).toBeGreaterThan(0);

      // ②语义零产出:普通 python 不产 KBEngine 诊断
      for (const registered of languagesRegistry.diagnosticCollections) {
        const found = registered.collection.get(document.uri);
        expect(found ?? []).toHaveLength(0);
      }
      // 悬停提供器对普通文档:零 KBEngine 内容(空/null 都算空转,不许崩)
      for (const registration of languagesRegistry.hoverRegistrations) {
        const provider = registration.provider as {
          provideHover?: (doc: unknown, pos: unknown, tok: unknown) => Promise<unknown>;
        };
        if (!provider.provideHover) { continue; }
        const hover = await provider.provideHover(document, new Position(0, 1), {
          isCancellationRequested: false
        });
        if (hover && typeof hover === 'object' && 'contents' in hover) {
          const text = JSON.stringify((hover as { contents: unknown }).contents);
          expect(text).not.toContain('KBEngine');
        }
      }

      // ③错误零产出:缺资产是正常形态,不弹错误
      expect(messages.error).toHaveLength(0);
    } finally {
      disposeAll(context);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('命令面仍在但语义面空转:注册表完整,无资产不缺命令注册', () => {
    resetExtensionTestState();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nonkbe-cmds-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'plain-ws2', index: 0 }];
    const context = makeContext();
    try {
      expect(() => activate(context)).not.toThrow();
      // 装配完成度:无资产工作区照样注册命令面(功能可用性不因无资产缺席;
      // 降级发生在命令调用时,各有如实降级测试,如 databaseTablePreview)
      expect(commandRegistry.registeredCommandIds().length).toBeGreaterThan(0);
    } finally {
      disposeAll(context);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
