import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import {
  Uri,
  lastFileSystemWatcher,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// EntityMappingManager 的索引缺口:组件槽 rebased 属性(children 递归与
// ARRAY 元素)、未解析组件槽的跳过、toLegacyMapping 的同路径去重、无
// python 绑定方法的正则回退、未知 owner 的空解析、未定义被调的入边
// 过滤、python owner 文件读取失败的整体跳过与解析后文件消失的容错。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const write = (root: string, relative: string, content: string) => {
  const target = p(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
};

const originalFindFiles = stubWorkspace.findFiles;

// vitest v5 默认 clearMocks 会在每个用例前清空 mock.calls,
// 解析失败的错误记录改用自持数组承载,不受用例间重置影响
const defErrors: string[] = [];

let root = '';
let manager: EntityMappingManager | undefined;

const hostPython = (): string => p(root, 'scripts', 'base', 'CompHost.py');

const internals = (target: EntityMappingManager): {
  mappingIndexes: Map<string, {
    propertyDefinitions: Array<{
      defFile: string;
      identity: { propertyPath?: string; componentSlotName?: string };
    }>;
  }>;
} => target as unknown as never;

beforeAll(async () => {
  vi.spyOn(console, 'error').mockImplementation(((first?: unknown) => {
    defErrors.push(String(first));
  }) as typeof console.error);

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mapping-gap-'));

  write(root, 'scripts/entities.xml', [
    '<root>',
    '  <CompHost hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Boom hasBase="true" hasCell="false" hasClient="false"/>',
    '</root>'
  ].join('\n'));

  // pack 同时是 FIXED_DICT 属性(带子属性 inner)与组件槽名:组件属性
  // rebased 后与实体侧同路径,触发 toLegacyMapping 的同路径去重。
  // ghost 槽引用不存在的组件,驱动 resolved 空跳过。
  write(root, 'scripts/entity_defs/CompHost.def', [
    '<root>',
    '  <Properties>',
    '    <pack>',
    '      <Type>FIXED_DICT</Type>',
    '      <Properties>',
    '        <inner>',
    '          <Type>UINT32</Type>',
    '          <Flags>BASE</Flags>',
    '          <Persistent>true</Persistent>',
    '        </inner>',
    '      </Properties>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </pack>',
    '    <bag>',
    '      <Type>',
    '        ARRAY',
    '        <of>UINT32</of>',
    '      </Type>',
    '      <Flags>CELL_PUBLIC</Flags>',
    '    </bag>',
    '  </Properties>',
    '  <Components>',
    '    <pack>',
    '      <Type>NestedComp</Type>',
    '    </pack>',
    '    <ghost>',
    '      <Type>MissingComp</Type>',
    '    </ghost>',
    '  </Components>',
    '  <BaseMethods>',
    '    <orphan/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/components/NestedComp.def', [
    '<root>',
    '  <Properties>',
    '    <proxy>',
    '      <Type>FIXED_DICT</Type>',
    '      <Properties>',
    '        <inner>',
    '          <Type>UINT8</Type>',
    '        </inner>',
    '      </Properties>',
    '      <Flags>BASE</Flags>',
    '    </proxy>',
    '  </Properties>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/Boom.def', [
    '<root>',
    '  <Properties>',
    '    <bp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '    </bp>',
    '  </Properties>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/base/CompHost.py', [
    'class CompHost(object):',
    '    def real(self):',
    '        self.ghostCall()',
    ''
  ].join('\n'));

  // 组件 owner 的 python 文件:组件符号不单独建索引,解析须经引用实体回溯
  write(root, 'scripts/base/components/NestedComp.py', [
    'class NestedComp(object):',
    '    def applied(self):',
    '        pass',
    ''
  ].join('\n'));

  // python owner 文件是目录:收集层 existsSync 通过,读取层抛 EISDIR
  fs.mkdirSync(p(root, 'scripts', 'base', 'Boom.py'), { recursive: true });

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
  stubWorkspace.findFiles = async () => {
    const results: Uri[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = p(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.def')) {
          results.push(Uri.file(full));
        }
      }
    };
    walk(root);
    return results;
  };

  manager = new EntityMappingManager({ subscriptions: [] });
  await until(() => (manager as EntityMappingManager).getAllMappings().some(m => m.name === 'CompHost'), 'initial scan');
});

afterAll(() => {
  vi.mocked(console.error).mockRestore();
  manager?.dispose();
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.workspaceFolders = [];
  lastFileSystemWatcher.current = null;
  fs.rmSync(root, { recursive: true, force: true });
});

const hostIndex = () => {
  const index = internals(manager as EntityMappingManager).mappingIndexes.get('CompHost');
  expect(index, 'CompHost index exists').toBeTruthy();
  return index!;
};

describe('component slot indexing gaps', () => {
  it('indexes rebased component children and array elements, skipping unresolved slots', () => {
    const definitions = hostIndex().propertyDefinitions;
    const paths = definitions.map(item => item.identity.propertyPath);

    // 实体侧 FIXED_DICT 子属性与 ARRAY 元素(children/arrayElement 递归)
    expect(paths).toContain('pack.inner');
    expect(paths).toContain('bag[]');
    // 组件属性 rebased 到槽名前缀:proxy → pack,proxy.inner → pack.inner
    expect(paths).toContain('pack');
    expect(paths.filter(item => item === 'pack.inner')).toHaveLength(2);

    const rebased = definitions.find(item =>
      item.identity.propertyPath === 'pack.inner' && item.identity.componentSlotName === 'pack'
    );
    expect(rebased?.defFile).toContain('NestedComp.def');

    // 未解析组件槽:整个槽被跳过,不产生属性也不抛错
    expect(paths.some(item => item?.startsWith('ghost'))).toBe(false);
  });

  it('keeps only the first definition for a duplicated rebased property path', () => {
    const mapping = (manager as EntityMappingManager).getAllMappings().find(m => m.name === 'CompHost')!;

    // 对外映射里同路径只保留先到的实体侧定义
    expect(mapping.properties['pack.inner'].defFile).toContain('CompHost.def');
    expect(mapping.properties['bag[]']).toBeDefined();
    expect(mapping.properties['pack']).toBeDefined();
  });
});

describe('identity resolution gaps', () => {
  it('falls back to regex lookup when a def method has no python binding', async () => {
    // def 声明 orphan 但 python 无 def orphan:direct 绑定未命中,
    // 回退到 owner 文件上的正则查找,仍找不到 → null
    const location = await (manager as EntityMappingManager).resolveMethodImplementationByIdentity({
      ownerKind: 'entity',
      ownerName: 'CompHost',
      sourceKind: 'local',
      sourceChain: [],
      section: 'BaseMethods',
      symbolName: 'orphan'
    });
    expect(location).toBeNull();
  });

  it('returns null for an unknown owner identity', async () => {
    // 重建扫描后仍无该 owner → ensureIndexForOwner 返回 undefined
    const location = await (manager as EntityMappingManager).resolveMethodImplementationByIdentity({
      ownerKind: 'entity',
      ownerName: 'NoSuchEntity',
      sourceKind: 'local',
      sourceChain: [],
      section: 'BaseMethods',
      symbolName: 'whatever'
    });
    expect(location).toBeNull();
  });

  it('resolves a component owner through the referencing entity index', async () => {
    // 组件符号无独立索引:findByOwner 回溯到引用它的 CompHost 索引,
    // 再在组件 owner 文件上做正则查找,无 def nowhere → null
    const location = await (manager as EntityMappingManager).resolveMethodImplementationByIdentity({
      ownerKind: 'component',
      ownerName: 'NestedComp',
      sourceKind: 'local',
      sourceChain: [],
      section: 'BaseMethods',
      symbolName: 'nowhere'
    });
    expect(location).toBeNull();
  });
});

describe('incoming call graph gaps', () => {
  it('drops calls whose callee has no indexed definition', async () => {
    // real() 调 self.ghostCall(),但 ghostCall 无任何定义:
    // call 命中而 resolved 未命中 → 该入边被丢弃
    const incoming = await (manager as EntityMappingManager).getIncomingPythonMethodCalls(hostPython(), 'ghostCall');
    expect(incoming).toEqual([]);
  });
});

describe('python owner read failures', () => {
  it('logs and skips a def whose python owner file cannot be read', () => {
    // Boom.py 是目录:收集层 existsSync 通过,collectPythonMethods 读取
    // 抛 EISDIR → buildIndex 失败被 parseDefFile 捕获,索引不收录 Boom
    const names = (manager as EntityMappingManager).getAllMappings().map(m => m.name);
    expect(names).not.toContain('Boom');
    expect(defErrors.some(text => text.includes('Boom.def'))).toBe(true);
  });

  it('survives a deleted or unreadable python owner during identity resolution', async () => {
    const identity = {
      ownerKind: 'entity' as const,
      ownerName: 'CompHost',
      sourceKind: 'local' as const,
      sourceChain: [],
      section: 'BaseMethods' as const,
      symbolName: 'orphan'
    };

    // 索引已建好后文件消失:正则回退的存在性检查先行返回
    fs.rmSync(hostPython());
    expect(await (manager as EntityMappingManager).resolveMethodImplementationByIdentity(identity)).toBeNull();

    // 文件被替换为目录:existsSync 通过但读取抛 EISDIR,被 catch 吞掉
    fs.mkdirSync(hostPython());
    expect(await (manager as EntityMappingManager).resolveMethodImplementationByIdentity(identity)).toBeNull();
  });
});
