import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DependencyType,
  EntityDependencyAnalyzer
} from '../src/entityDependency';
import { Uri, memoryFileSystem, workspace as stubWorkspace } from './helpers/vscodeStub';

// entityDependency 批66 分支补测:entities.xml 只给 hasClient 的注册实体
// (loadFromEntitiesXml 的 hasBase 假臂)与 FIXED_DICT implementedBy 内的
// 非实体标量类型(isEntityReference 的实体表 miss 臂)。analyze() 双遍扫描
// 使 has→get 不变式下的三处守卫不可达,已以精确单行 ignore 定案,见源码
// 注记与 TESTING.md 批66 段。def 内容双写:真实磁盘 + memoryFileSystem。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

let root = '';
const originalFindFiles = stubWorkspace.findFiles;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-dep-branch-'));
  memoryFileSystem.reset();

  const put = (relative: string, content: string) => {
    const abs = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    memoryFileSystem.set(abs, content);
  };

  // ClientOnly 仅 hasClient ⇒ hasBase 假臂;FDMix 提供 hasBase 真臂对照
  put('scripts/entities.xml', [
    '<root>',
    '  <ClientOnly hasClient="true"/>',
    '  <FDMix hasBase="true"/>',
    '</root>'
  ].join('\n'));

  put('scripts/entity_defs/ClientOnly.def', '<root>\n</root>');
  put('scripts/entity_defs/FDMix.def', [
    '<root>',
    '  <Properties>',
    '    <scalar_fd>',
    '      <Type>FIXED_DICT</Type>',
    '      <implementedBy>',
    '        <Type>UINT32</Type>',
    '      </implementedBy>',
    '      <Flags>BASE</Flags>',
    '    </scalar_fd>',
    '    <entity_fd>',
    '      <Type>FIXED_DICT</Type>',
    '      <implementedBy>',
    '        <Type>ClientOnly</Type>',
    '      </implementedBy>',
    '    </entity_fd>',
    '  </Properties>',
    '</root>'
  ].join('\n'));

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
  stubWorkspace.findFiles = async () => [
    Uri.file(p(root, 'scripts/entity_defs/ClientOnly.def')),
    Uri.file(p(root, 'scripts/entity_defs/FDMix.def'))
  ];
});

afterAll(() => {
  memoryFileSystem.reset();
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.workspaceFolders = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('EntityDependencyAnalyzer branch gaps (批66)', () => {
  it('keeps a hasClient-only registration free of the Base type', async () => {
    const graph = await new EntityDependencyAnalyzer({ subscriptions: [] }).analyze();

    const clientOnly = graph.nodes.find(node => node.name === 'ClientOnly');
    expect(clientOnly?.types).toEqual(['Client']);

    // 对照:FDMix 注册为 hasBase ⇒ 真臂照常入账
    const fdMix = graph.nodes.find(node => node.name === 'FDMix');
    expect(fdMix?.types).toContain('Base');
  });

  it('skips FIXED_DICT members that are not entity references', async () => {
    const graph = await new EntityDependencyAnalyzer({ subscriptions: [] }).analyze();
    const fdMix = graph.nodes.find(node => node.name === 'FDMix');

    // UINT32 过标识符正则但不在实体表 ⇒ 不产生 fixed_dict 引用
    expect(fdMix?.references.filter(ref => ref.propertyName === 'scalar_fd')).toEqual([]);

    // 对照:implementedBy 内的注册实体照常产生引用与边
    expect(fdMix?.references.filter(ref => ref.propertyName === 'entity_fd')).toEqual([
      {
        entityName: 'ClientOnly',
        type: DependencyType.FixedDict,
        propertyName: 'entity_fd'
      }
    ]);
    expect(graph.edges).toContainEqual({
      from: 'FDMix',
      to: 'ClientOnly',
      type: DependencyType.FixedDict,
      label: 'entity_fd'
    });
  });
});
