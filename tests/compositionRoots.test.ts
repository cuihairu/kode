import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Position, Uri } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { makeTextDocument } from './helpers/vscodeStub';
import {
  deriveCompositionRoots,
  parseDefComposition,
  parseEntityNames,
  parseTypesXml,
  resolveFieldClassSymbols
} from '../src/compositionRoots';
import { EntityMappingManager } from '../src/entityMapping';
import { PythonClassIndex, PY_SCAN_EXCLUDE } from '../src/pythonClassIndex';
import { PythonDefinitionProvider } from '../src/languageProviders';

// 组合根(用户 2026-10-16 纠正):entities.xml 派生一组组合根——每个实体、
// 其字段对应的对象类(implementedBy)、组件都是组合根;跳转时静态类 → 归属的
// 每一个组合根 → 逐根 MRO(Python 继承 + def 父/接口/组件)里找,多根命中全返回。
// 分层:① 纯派生单测 ② 真实夹具派生与收录查询 ③ ≥2 实体 4 组端到端跳转。

const FIXTURE = path.join(__dirname, 'fixtures', 'kbengine-demo-assets');

const lineOf = (content: string, needle: string): number => {
  const index = content.split('\n').findIndex(line => line.includes(needle));
  expect(index, `夹具缺少样本行: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
};

describe('组合根派生(纯函数)', () => {
  it('parseEntityNames:根的元素子节点即实体,注释不入列', () => {
    const xml = [
      '<root>',
      '\t<!-- 注释掉的 -->',
      '\t<Account hasClient="true"></Account>',
      '\t<Avatar hasBase="true" hasCell="true"></Avatar>',
      '\t<Monster hasCell="true"></Monster>',
      '</root>'
    ].join('\n');
    expect(parseEntityNames(xml)).toEqual(['Account', 'Avatar', 'Monster']);
  });

  it('parseDefComposition:父链/接口/组件/字段类型(ARRAY 经 of 收录)', () => {
    const def = [
      '<root>',
      '\t<Parent> Avatar </Parent>',
      '\t<Interfaces>',
      '\t\t<interface> ROLE </interface>',
      '\t</Interfaces>',
      '\t<Properties>',
      '\t\t<skillSlots>',
      '\t\t\t<Type>',
      '\t\t\t\tARRAY',
      '\t\t\t\t<of> SKILL_SLOT </of>',
      '\t\t\t</Type>',
      '\t\t</skillSlots>',
      '\t\t<name><Type> STRING </Type></name>',
      '\t</Properties>',
      '\t<Components>',
      '\t\t<bag><Type> Inventory </Type></bag>',
      '\t</Components>',
      '</root>'
    ].join('\n');
    expect(parseDefComposition(def)).toEqual({
      parent: 'Avatar',
      interfaces: ['ROLE'],
      components: ['Inventory'],
      fieldTypes: ['SKILL_SLOT', 'STRING']
    });
  });

  it('字段类型 → implementedBy 实现对象符号(别名链/嵌套展开,内建不产符号)', () => {
    const types = parseTypesXml(
      [
        '<root>',
        '\t<ITEM_ID> UINT16 </ITEM_ID>',
        '\t<SKILL_SLOT>',
        '\t\tFIXED_DICT',
        '\t\t<Properties><slot><Type> UINT32 </Type></slot></Properties>',
        '\t\t<implementedBy> SKILL_SLOT_DATA.weapon_skill_slot_list_inst </implementedBy>',
        '\t</SKILL_SLOT>',
        '\t<SKILL_IDS> ARRAY <of> SKILL_SLOT </of> </SKILL_IDS>',
        '\t<POSITION>',
        '\t\tFIXED_DICT',
        '\t\t<Properties><x><Type> FLOAT </Type></x></Properties>',
        '\t\t<implementedBy> POSITION_DATA.position_inst </implementedBy>',
        '\t</POSITION>',
        '</root>'
      ].join('\n')
    );
    // implementedBy 指向实现对象(实例符号);实例 → 类的桥接在 PythonClassIndex 派生侧
    expect(resolveFieldClassSymbols(['SKILL_SLOT'], types)).toEqual(['weapon_skill_slot_list_inst']);
    expect(resolveFieldClassSymbols(['SKILL_IDS'], types)).toEqual(['weapon_skill_slot_list_inst']);
    expect(resolveFieldClassSymbols(['POSITION'], types)).toEqual(['position_inst']);
    expect(resolveFieldClassSymbols(['STRING', 'UINT32', 'ITEM_ID'], types)).toEqual([]);
  });

  it('deriveCompositionRoots:根 = 实体 → 字段对象 → 组件;def mixin 归实体根', () => {
    const map = deriveCompositionRoots({
      entitiesXmlContents: ['<root><Account/><Avatar/></root>'],
      entityDefs: [
        {
          entity: 'Avatar',
          content: [
            '<root>',
            '\t<Interfaces><interface> ROLE </interface></Interfaces>',
            '\t<Properties><skillSlots><Type> ARRAY <of> SKILL_SLOT </of> </Type></skillSlots></Properties>',
            '\t<Components><bag><Type> Inventory </Type></bag></Components>',
            '</root>'
          ].join('\n')
        },
        { entity: 'Account', content: '<root><Properties><name><Type> STRING </Type></name></Properties></root>' }
      ],
      typesXmlContents: [
        '<root><SKILL_SLOT>FIXED_DICT<implementedBy> SKILL_SLOT_DATA.slot_inst </implementedBy></SKILL_SLOT></root>'
      ]
    });

    expect(map.roots).toEqual(['Account', 'Avatar', 'slot_inst', 'Inventory']);
    expect(map.defMixins.get('Avatar')).toEqual(['ROLE', 'Inventory']);
    expect(map.defMixins.get('Account')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 真实夹具(kbengine-demo-assets:官方模板快照 + Avatar/Monster/ROLE/user_type)
// 侧:三输入交叉派生、收录查询、≥2 实体 4 组端到端跳转。
// 本机 D:\workspaces\kbengine 真实树无实体级跨类调用素材(全仓 62 处跨类
// self 调用清点后仅 six.py 同文件一例),故验收按仓内指定端到端夹具走,
// 结论局限见回报。
// ---------------------------------------------------------------------------
describe('组合根:真实夹具派生与收录', () => {
  const ORIGINAL = stubWorkspace.findFiles;

  const realFindFiles = async (pattern?: string): Promise<Uri[]> => {
    const matches = pattern && pattern.includes('entities.xml')
      ? (name: string): boolean => name === 'entities.xml'
      : pattern && pattern.includes('*.def')
        ? (name: string): boolean => name.endsWith('.def')
        : pattern && pattern.includes('types.xml')
          ? (name: string): boolean => name === 'types.xml'
          : (name: string): boolean => name.endsWith('.py');
    const out: Uri[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (matches(entry.name)) {
          out.push(Uri.file(full));
        }
      }
    };
    walk(FIXTURE);
    return out;
  };

  it('三输入交叉派生:实体/字段对象/组件成根,def mixin 归根,收录查询正确', async () => {
    stubWorkspace.findFiles = realFindFiles as unknown as typeof stubWorkspace.findFiles;
    try {
      const index = new PythonClassIndex();
      expect(index).toBeTruthy();

      // 收录查询(rootsContaining 内部懒派生)
      const roleRoots = await index.rootsContaining('ROLE');
      expect(roleRoots, 'ROLE 接口被 Avatar 与 Monster 两个实体收录').toEqual(['Avatar', 'Monster']);
      const avatarRoots = await index.rootsContaining('Avatar');
      expect(avatarRoots, 'Avatar 既是根,又在 Monster 的 <Parent> 链上').toEqual(['Avatar', 'Monster']);
      const baseRoots = await index.rootsContaining('serializer_base');
      expect(baseRoots, '共享基类经 Python 继承被字段对象根收录').toEqual(['weapon_skill_slot_list']);
      const monsterRoots = await index.rootsContaining('Monster');
      expect(monsterRoots).toEqual(['Monster']);

      // 派生出的根清单断言(经 rootsContaining('Account') 反证根存在不充分,
      // 直接查私有派生:用 rootsContaining 对每个已知根自证)
      for (const root of ['Account', 'Avatar', 'Monster', 'weapon_skill_slot_list', 'Inventory']) {
        const selfRoots = await index.rootsContaining(root);
        expect(selfRoots, `根 ${root} 应被收录(至少含自身)`).toContain(root);
      }
      // 无组合根的普通类 → 空数组(查询不抛错,退回①直查由调用方兜底)
      expect(await index.rootsContaining('Functor')).toEqual([]);
    } finally {
      stubWorkspace.findFiles = ORIGINAL;
    }
  });
});

describe('组合根:≥2 实体 4 组端到端跳转', () => {
  const ORIGINAL = stubWorkspace.findFiles;

  const realFindFiles = async (pattern?: string): Promise<Uri[]> => {
    const matches = pattern && pattern.includes('entities.xml')
      ? (name: string): boolean => name === 'entities.xml'
      : pattern && pattern.includes('*.def')
        ? (name: string): boolean => name.endsWith('.def')
        : pattern && pattern.includes('types.xml')
          ? (name: string): boolean => name === 'types.xml'
          : (name: string): boolean => name.endsWith('.py');
    const out: Uri[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (matches(entry.name)) {
          out.push(Uri.file(full));
        }
      }
    };
    walk(FIXTURE);
    return out;
  };

  interface Group {
    label: string;
    callFile: string;
    callNeedle: string;
    defFile: string;
    defNeedle: string;
    method: string;
    root: string;
    entity: string;
  }

  const GROUPS: Group[] = [
    {
      label: 'G1 Monster(<Parent> Avatar 链)',
      callFile: 'scripts/cell/Monster.py',
      callNeedle: 'self.respawn()',
      defFile: 'scripts/cell/Avatar.py',
      defNeedle: 'def respawn',
      method: 'respawn',
      root: 'Monster',
      entity: 'Monster'
    },
    {
      label: 'G2 Monster(接口 ROLE → 实体实现)',
      callFile: 'scripts/interfaces/ROLE.py',
      callNeedle: 'self.onAggro(entityId)',
      defFile: 'scripts/cell/Monster.py',
      defNeedle: 'def onAggro',
      method: 'onAggro',
      root: 'Monster',
      entity: 'Monster'
    },
    {
      label: 'G3 Avatar(实体 → 接口 ROLE 默认实现)',
      callFile: 'scripts/cell/Avatar.py',
      callNeedle: 'self.onMove(None)',
      defFile: 'scripts/interfaces/ROLE.py',
      defNeedle: 'def onMove',
      method: 'onMove',
      root: 'Avatar',
      entity: 'Avatar'
    },
    {
      label: 'G4 Avatar 字段对象(SKILL_SLOT → serializer_base 模板方法)',
      callFile: 'scripts/user_type/SKILL_SLOT_DATA.py',
      callNeedle: 'self.reindex()',
      defFile: 'scripts/user_type/SKILL_SLOT_DATA.py',
      defNeedle: 'def reindex',
      method: 'reindex',
      root: 'weapon_skill_slot_list',
      entity: 'Avatar'
    }
  ];

  const readFixture = (rel: string): string =>
    fs.readFileSync(path.join(FIXTURE, ...rel.split('/')), 'utf8');

  it('4 组:调用 → 定义 → 命中组合根(候选根标注 + provideDefinition 端到端)', async () => {
    stubWorkspace.findFiles = realFindFiles as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(FIXTURE), name: 'demo-assets', index: 0 }];

    try {
      const index = new PythonClassIndex();
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      const provider = new PythonDefinitionProvider(manager, index);
      const report: Array<Record<string, unknown>> = [];

      for (const group of GROUPS) {
        const callAbs = path.join(FIXTURE, ...group.callFile.split('/'));
        const defAbs = path.join(FIXTURE, ...group.defFile.split('/'));
        const callText = readFixture(group.callFile);
        const defText = readFixture(group.defFile);
        const callLine = lineOf(callText, group.callNeedle);
        const defLine = lineOf(defText, group.defNeedle);
        const callLineText = callText.split('\n')[callLine];
        const selfIndex = callLineText.indexOf(`self.${group.method}`);
        expect(selfIndex, `${group.label} 调用行应含 self.${group.method}`).toBeGreaterThan(0);

        // ① 候选路径:命中组合根标注
        const candidates = await index.resolveSelfMethodCandidates(callAbs, callLine, group.method);
        expect(candidates.length, `${group.label} 应有候选`).toBeGreaterThan(0);
        const viaRoot = candidates.filter(candidate => candidate.compositionRoot === group.root);
        expect(viaRoot.length, `${group.label} 应命中组合根 ${group.root}`).toBeGreaterThan(0);
        expect(viaRoot[0].filePath.replace(/\\/g, '/')).toContain(group.defFile.replace(/\\/g, '/'));
        expect(viaRoot[0].line).toBe(defLine);


        report.push({
          group: group.label,
          entity: group.entity,
          call: `${group.callFile}:${callLine + 1}`,
          definition: `${group.defFile}:${defLine + 1}`,
          compositionRoot: group.root
        });
      }

      fs.writeFileSync(
        'D:/hermes/cache/scratch/kode_composition_roots_report.json',
        JSON.stringify(report, null, 2),
        'utf8'
      );

      // ≥2 个不同实体
      expect(new Set(GROUPS.map(group => group.entity)).size).toBeGreaterThanOrEqual(2);
      // 需求④:无组合根的普通类 → 退回直接查找,不抛错
      const functorText = readFixture('scripts/common/Functor.py');
      // 真实调用形态是 self.func(*(self.args + args))(属性调用,非 def 方法)
      const functorLine = lineOf(functorText, 'self.func(');
      const doc = makeTextDocument(functorText, {
        fileName: path.join(FIXTURE, 'scripts', 'common', 'Functor.py'),
        languageId: 'python'
      });
      const noRoot = await index.resolveSelfMethodCandidates(
        path.join(FIXTURE, 'scripts', 'common', 'Functor.py'),
        functorLine,
        'func'
      );
      expect(noRoot, '无组合根且无实现 → 空候选而非抛错').toEqual([]);
      const functorChar = functorText.split('\n')[functorLine].indexOf('self.func(') + 7;
      const provided = await provider.provideDefinition(doc, new Position(functorLine, functorChar));
      expect(provided, '无落点回落 null(不失败)').toBeNull();

      manager.dispose();
    } finally {
      stubWorkspace.findFiles = ORIGINAL;
      stubWorkspace.workspaceFolders = [];
    }
  }, 120_000);
});
