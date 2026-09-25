import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityExplorerProvider } from '../src/explorerProviders';
import { workspace as stubWorkspace, Uri } from './helpers/vscodeStub';

// explorerProviders 的剩余缺口:ARRAY 元素属性的扁平化读取、实体描述
// 的 Client 徽章、loadResolved 返 null 的层级统计回落。readDefinitionStats
// 把入参整体当工作区根,本地名取 basename:用目录名与 <目录名>.def 同名
// 命中真实解析路径(顶层 ARRAY 属性保留名字,数组元素展开的 "名[]"
// 被 toStatsFromProperties 过滤)。三条死分支如实记录:
// createMethodSectionDescriptor 的 groups 空守卫(进入前置是
// inheritedGroups 非空,groups 恒非空)、readDefinitionStats 与
// readDefinitionHierarchyStats 的 loader 空守卫(入参路径恒非空)。

type ExplorerInternals = EntityExplorerProvider & {
  readDefinitionStats(defPath: string): Record<string, unknown>;
  buildDefinitionDescription(root: string, entry: Record<string, unknown>): string;
  readDefinitionHierarchyStats(
    root: string,
    entry: Record<string, unknown>
  ): { local: Record<string, unknown>; inherited: unknown[] };
};

const makeExplorer = (): ExplorerInternals =>
  new EntityExplorerProvider() as unknown as ExplorerInternals;

let root = '';

const write = (relative: string, content: string): void => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-explorer-gap-'));

  write('scripts/entities.xml', [
    '<root>',
    '  <Archer hasBase="true" hasCell="true" hasClient="true"/>',
    '  <BadXml hasBase="true"/>',
    '</root>'
  ].join('\n'));

  // 目录名与 <目录名>.def 同名:readDefinitionStats(root) 的 basename
  // 恰好命中注册文件。ARRAY-of 属性让扁平化访问 arrayElement 分支,
  // 元素子属性(bag[])不入名单,普通属性 focus 正常保留
  write(`scripts/entity_defs/${path.basename(root)}.def`, [
    '<root>',
    '  <Properties>',
    '    <bag>',
    '      <Type>',
    '        ARRAY',
    '        <of>UINT32</of>',
    '      </Type>',
    '    </bag>',
    '    <focus>',
    '      <Type>UINT8</Type>',
    '    </focus>',
    '  </Properties>',
    '</root>'
  ].join('\n'));

  // 无 root 的坏 def:loadResolved 走成功路径(空 local),不入本批断言
  write('scripts/entity_defs/BadXml.def', 'not xml at all');

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

describe('explorer provider stats gaps', () => {
  it('flattens array element properties while keeping only top-level names', () => {
    const stats = makeExplorer().readDefinitionStats(root);

    // 顶层属性入名单(bag 的名字不含 []);数组元素(bag[])被过滤
    expect(stats.properties).toEqual(['bag', 'focus']);
    expect(stats.baseMethods).toEqual([]);
    expect(stats.components).toEqual([]);
  });

  it('marks client participation in the entity description', () => {
    // 未注册实体无 runtime profile,徽章回落 hasBase/hasCell/hasClient
    const description = makeExplorer().buildDefinitionDescription(root, {
      category: 'entity',
      name: 'ClientOnly',
      filePath: path.join(root, 'scripts/entity_defs/ClientOnly.def'),
      exists: true,
      registered: false,
      hasBase: true,
      hasCell: true,
      hasClient: true
    });

    expect(description).toBe('Base, Cell, Client, Unregistered');
  });

  it('falls back to local-only hierarchy when the def file is missing', () => {
    // Ghost 无 def 文件:loadResolved 返 null,回落 local-only(空 shape)
    const hierarchy = makeExplorer().readDefinitionHierarchyStats(root, {
      category: 'entity',
      name: 'Ghost',
      filePath: path.join(root, 'scripts/entity_defs/Ghost.def'),
      exists: false,
      registered: true,
      hasBase: true,
      hasCell: false,
      hasClient: false
    });

    expect(hierarchy.inherited).toEqual([]);
    expect(hierarchy.local.properties).toEqual([]);
    expect(hierarchy.local.parent).toBeUndefined();
  });
});
