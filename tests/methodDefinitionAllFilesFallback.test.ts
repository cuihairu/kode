import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import type { DefinitionSymbolIdentity } from '../src/entityMapping';
import { resetScanRootCache } from '../src/scanRoots';
import { Uri } from './helpers/vscodeStub';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';

// 用户令(2026-10-20):.def <BaseMethods> 方法的实现不在同名 python 文件时,
// 解析放宽到全项目 python——唯一命中才跳,多处命中静默(返回 null)。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const write = (root: string, relative: string, content: string): void => {
  const target = p(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const originalFindFiles = stubWorkspace.findFiles;

let root = '';

const identityFor = (symbolName: string): DefinitionSymbolIdentity => ({
  ownerKind: 'entity',
  ownerName: 'Avatar',
  sourceKind: 'declared',
  sourceChain: ['Avatar'],
  section: 'base',
  symbolName
});

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-method-global-'));
  resetScanRootCache();
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'workspace', index: 0 }];

  write(root, 'scripts/entities.xml', ['<root>', '  <Avatar hasBase="true"/>', '</root>'].join('\n'));

  write(root, 'scripts/entity_defs/Avatar.def', [
    '<root>',
    '  <BaseMethods>',
    '    <uniqueInParent/>',
    '    <ambiguousInParents/>',
    '    <commonOnly/>',
    '    <baseOnlyMethod/>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <onCellSide/>',
    '  </CellMethods>',
    '</root>'
  ].join('\n'));

  // 同名脚本：两个方法都没有实现（实现只在别的 py 里）
  write(root, 'scripts/base/Avatar.py', [
    'class Avatar:',
    '    def placeholder(self):',
    '        pass'
  ].join('\n'));

  // 全项目唯一的父类实现
  write(root, 'scripts/base/AvatarParent.py', [
    'class AvatarParent:',
    '    def uniqueInParent(self):',
    '        return 1'
  ].join('\n'));

  // 两处同名实现 → 歧义应静默
  write(root, 'scripts/base/RoleA.py', [
    'class RoleA:',
    '    def ambiguousInParents(self):',
    '        return 1'
  ].join('\n'));
  write(root, 'scripts/base/RoleB.py', [
    'class RoleB:',
    '    def ambiguousInParents(self):',
    '        return 2'
  ].join('\n'));

  // 域目录层(2026-10-21 用户令):CellMethods 的方法 base 里有同名函数不得错跳
  write(root, 'scripts/base/baseOnly.py', [
    'def baseOnlyMethod():',
    '    return "base"'
  ].join('\n'));
  write(root, 'scripts/cell/cellSide.py', [
    'def baseOnlyMethod():',
    '    return "cell-同名"',
    '',
    'def onCellSide():',
    '    return "cell"'
  ].join('\n'));
  write(root, 'scripts/common/util.py', [
    'def commonOnly():',
    '    return "common"'
  ].join('\n'));

  const files = [
    'scripts/entities.xml',
    'scripts/entity_defs/Avatar.def',
    'scripts/base/Avatar.py',
    'scripts/base/AvatarParent.py',
    'scripts/base/RoleA.py',
    'scripts/base/RoleB.py',
    'scripts/base/baseOnly.py',
    'scripts/cell/cellSide.py',
    'scripts/common/util.py'
  ];
  stubWorkspace.findFiles = (async (pattern?: string) => {
    const want = typeof pattern === 'string' && pattern.includes('*.def')
      ? (name: string): boolean => name.endsWith('.def')
      : typeof pattern === 'string' && pattern.includes('entities.xml')
        ? (name: string): boolean => name === 'entities.xml'
        : (name: string): boolean => name.endsWith('.py');
    return files.filter(item => want(item.split('/').pop()!)).map(item => Uri.file(p(root, ...item.split('/'))));
  }) as typeof stubWorkspace.findFiles;
});

afterAll(() => {
  stubWorkspace.findFiles = originalFindFiles;
  fs.rmSync(root, { force: true, recursive: true });
});

describe('def 方法全项目回退（用户令 2026-10-20）', () => {
  it('同名 py 无实现、全项目唯一命中 → 跳该文件行号', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const result = await manager.resolveMethodImplementationByIdentity(identityFor('uniqueInParent'));
    expect(result).not.toBeNull();
    expect(path.basename(result!.filePath)).toBe('AvatarParent.py');
    expect(result!.line).toBeGreaterThan(0);
  });

  it('全项目多处命中 → 静默（null，交给约定链/提示）', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const result = await manager.resolveMethodImplementationByIdentity(identityFor('ambiguousInParents'));
    expect(result).toBeNull();
  });

  it('全项目都没有 → 维持现状 null，不误跳', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const result = await manager.resolveMethodImplementationByIdentity(identityFor('missingEverywhere'));
    expect(result).toBeNull();
  });

  it('公开全项目回退口（identity 早落分支复用）：唯一命中/歧义/缺失三态', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const unique = await manager.resolveMethodImplementationGlobally('uniqueInParent');
    expect(unique && path.basename(unique.filePath)).toBe('AvatarParent.py');
    expect(await manager.resolveMethodImplementationGlobally('ambiguousInParents')).toBeNull();
    expect(await manager.resolveMethodImplementationGlobally('missingEverywhere')).toBeNull();
  });
});

describe('def 方法域目录层（用户令 2026-10-21：BaseMethods→base/、CellMethods→cell/）', () => {
  const identityInSection = (
    symbolName: string,
    section: 'BaseMethods' | 'CellMethods'
  ): DefinitionSymbolIdentity => ({
    ownerKind: 'entity',
    ownerName: 'Avatar',
    sourceKind: 'declared',
    sourceChain: ['Avatar'],
    section,
    symbolName
  });

  it('CellMethods：base 有同名函数也必须跳 cell 内实现（onClientEnabled 同型）', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const result = await manager.resolveMethodImplementationByIdentity(
      identityInSection('onCellSide', 'CellMethods')
    );
    expect(result).not.toBeNull();
    expect(result!.filePath.replace(/\\/g, '/')).toContain('/cell/');
    expect(path.basename(result!.filePath)).toBe('cellSide.py');
  });

  it('BaseMethods：cell 有同名函数也必须跳 base 内实现', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const result = await manager.resolveMethodImplementationByIdentity(
      identityInSection('baseOnlyMethod', 'BaseMethods')
    );
    expect(result).not.toBeNull();
    expect(result!.filePath.replace(/\\/g, '/')).toContain('/base/');
    expect(path.basename(result!.filePath)).toBe('baseOnly.py');
  });

  it('域内无果 → 仍走全项目唯一命中（common/ 目录兜底不倒退）', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const result = await manager.resolveMethodImplementationByIdentity(
      identityInSection('commonOnly', 'BaseMethods')
    );
    expect(result).not.toBeNull();
    expect(path.basename(result!.filePath)).toBe('util.py');
  });
});
