import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { messages, windowState } from './fake-vscode/windowState';
import { workspace, workspaceState } from './fake-vscode/workspaceState';
import {
  DiagnosticSeverity,
  makeTextDocument,
  Uri,
  type ExtensionContext
} from './fake-vscode/core';

// kbengine.def.analyze 装配测试(批91:性能分析建议·命令呈现层):
// findFiles 扫描 → openTextDocument → analyzeDefDocument → 输出面板报告 +
// 诊断落册 + 汇总消息;覆盖空结果分支与 dispose 链。

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext')
});

const disposeAll = (context: ExtensionContext): void => {
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
};

// 三档严重度各一条:warning=大字段全体广播 / error=缺 Type / info=DetailLevel 冗余
const monsterDef = [
  '<root>',
  '  <Properties>',
  '    <memo>',
  '      <Type>STRING</Type>',
  '      <Flags>ALL_CLIENTS</Flags>',
  '    </memo>',
  '    <seed>',
  '      <Flags>CELL_PRIVATE</Flags>',
  '      <DetailLevel>FAR</DetailLevel>',
  '    </seed>',
  '    <broken>',
  '      <Flags>CELL_PRIVATE</Flags>',
  '    </broken>',
  '  </Properties>',
  '</root>'
].join('\n');

const cleanDef = ['<root>', '  <Properties>', '  </Properties>', '</root>'].join('\n');

describe('kbengine.def.analyze 命令', () => {
  let root: string;
  let monsterUri: Uri;
  let avatarUri: Uri;

  beforeEach(() => {
    commandRegistry.reset();
    languagesRegistry.reset();
    windowState.reset();
    workspaceState.reset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-def-analyze-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.textDocuments = [];
    // 保留实例引用:fake 诊断集合按 Uri 实例为 Map 键
    avatarUri = Uri.file(path.join(root, 'Avatar.def'));
    monsterUri = Uri.file(path.join(root, 'Monster.def'));
    workspace.findFiles = (async (): Promise<Uri[]> => [monsterUri, avatarUri]) as typeof workspace.findFiles;
    workspace.openTextDocument = (async (uri: unknown) => {
      const filePath = (uri as Uri).fsPath;
      const text = filePath.endsWith('Monster.def') ? monsterDef : cleanDef;
      return makeTextDocument(text, { uri: uri as Uri, fileName: filePath });
    }) as typeof workspace.openTextDocument;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('扫描工作区 .def 并把报告写入输出面板、诊断落册、汇总消息', async () => {
    const context = makeContext();
    activate(context);
    await new Promise(resolve => setTimeout(resolve, 300));

    await commands.executeCommand('kbengine.def.analyze');

    // 文件按 fsPath 排序:Avatar.def(0 建议)在前,Monster.def(1 条)在后
    const analysis = windowState.channels.find(entry => entry.name === 'KBEngine Def 分析');
    expect(analysis, '应创建 KBEngine Def 分析输出面板').toBeDefined();
    const joined = analysis?.lines.join('') ?? '';
    expect(joined).toContain(`${path.join(root, 'Avatar.def')}: 未发现可优化项`);
    expect(joined).toContain('heavy-sync-broadcast');
    expect(joined).toContain('missing-type');
    expect(joined).toContain('redundant-detail-level');
    expect(joined).toContain(
      `${path.join(root, 'Monster.def')}: 共 4 条建议(错误 2 / 警告 1 / 提示 1)`
    );

    const collection = languagesRegistry.diagnosticCollections.find(
      entry => entry.name === 'kbengine-def-analysis'
    );
    expect(collection, '应创建 kbengine-def-analysis 诊断集合').toBeDefined();
    const monsterDiagnostics = collection?.collection.get(monsterUri);
    expect(monsterDiagnostics).toHaveLength(4);
    // 严重度映射:warning→Warning / error→Error / info→Information(三档全触发)
    expect(monsterDiagnostics?.map(item => item.severity)).toEqual([
      DiagnosticSeverity.Warning,
      DiagnosticSeverity.Error,
      DiagnosticSeverity.Information,
      DiagnosticSeverity.Error
    ]);
    const heavyDiagnostic = monsterDiagnostics?.[0];
    expect(heavyDiagnostic?.message).toContain('ALL_CLIENTS');
    expect(heavyDiagnostic?.range.start.line).toBe(4); // Flags 值行(0 基)
    const avatarDiagnostics = collection?.collection.get(avatarUri);
    expect(avatarDiagnostics).toEqual([]);

    expect(messages.info.at(-1)).toBe(`Def 分析完成: 2 个文件, 4 条建议`);

    disposeAll(context);
    expect(deactivate()).toBeUndefined();
    expect(analysis?.disposed).toBe(true);
  });

  it('工作区无 .def 文件时给出提示且不写报告', async () => {
    workspace.findFiles = (async (): Promise<Uri[]> => []) as typeof workspace.findFiles;
    const context = makeContext();
    activate(context);
    await new Promise(resolve => setTimeout(resolve, 300));

    await commands.executeCommand('kbengine.def.analyze');

    expect(messages.info.at(-1)).toBe('未找到 .def 文件,无法分析');
    const analysis = windowState.channels.find(entry => entry.name === 'KBEngine Def 分析');
    expect(analysis?.lines ?? []).toEqual([]);

    disposeAll(context);
    expect(deactivate()).toBeUndefined();
  });

  it('继承链闭包接入命令链:同域位同名落诊断,悬空 Parent 走缓存 miss', async () => {
    // 真盘夹具:collectInheritedNames 经 findEntityDefsRootFromFile/读盘解析
    // 闭包(走 fs.existsSync + 文本缓存);Orphan 的首个 Parent 指向不在
    // findFiles 枚举内的 Dangling.def,覆盖 readDefText 的缓存 miss 臂
    const defsDir = path.join(root, 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'entities.xml'), '<root></root>');

    const childDef = [
      '<root>',
      '  <Parent>Monster</Parent>',
      '  <Properties>',
      '    <hp>',
      '      <Type>INT32</Type>',
      '      <Flags>CELL_PUBLIC</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    const ancestorDef = [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>INT32</Type>',
      '      <Flags>CELL_PUBLIC</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    const orphanDef = [
      '<root>',
      '  <Parent>Dangling</Parent>',
      '  <Properties>',
      '    <mp>',
      '      <Type>INT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </mp>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    fs.writeFileSync(path.join(defsDir, 'Child.def'), childDef);
    fs.writeFileSync(path.join(defsDir, 'Monster.def'), ancestorDef);
    fs.writeFileSync(path.join(defsDir, 'Orphan.def'), orphanDef);

    const childUri = Uri.file(path.join(defsDir, 'Child.def'));
    const defsMonsterUri = Uri.file(path.join(defsDir, 'Monster.def'));
    const orphanUri = Uri.file(path.join(defsDir, 'Orphan.def'));
    workspace.findFiles = (async (): Promise<Uri[]> => [
      childUri,
      defsMonsterUri,
      orphanUri
    ]) as typeof workspace.findFiles;
    workspace.openTextDocument = (async (uri: unknown) => {
      const filePath = (uri as Uri).fsPath;
      const text = filePath.endsWith('Child.def')
        ? childDef
        : filePath.endsWith('Orphan.def')
          ? orphanDef
          : ancestorDef;
      return makeTextDocument(text, { uri: uri as Uri, fileName: filePath });
    }) as typeof workspace.openTextDocument;

    const context = makeContext();
    activate(context);
    await new Promise(resolve => setTimeout(resolve, 300));

    await commands.executeCommand('kbengine.def.analyze');

    const analysis = windowState.channels.find(entry => entry.name === 'KBEngine Def 分析');
    const joined = analysis?.lines.join('') ?? '';
    expect(joined).toContain('inherited-name-collision');
    expect(joined).toContain('继承自 Monster.def');
    // 悬空边静默跳过:不虚构祖先面,也不产生误报
    expect(joined).not.toContain('Dangling.def');
    expect(messages.info.at(-1)).toBe('Def 分析完成: 3 个文件, 1 条建议');

    disposeAll(context);
  });
});
