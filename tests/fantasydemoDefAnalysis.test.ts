import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  analyzeDefDocument,
  collectInheritedNames
} from '../src/defAnalyzer';
import type { DefAnalysisCheck } from '../src/defAnalyzer';
import { buildDefChain } from '../src/defChain';
import {
  DEF_METHOD_SECTIONS,
  getDirectChildElement,
  getDirectChildElements,
  getScalarChildValue,
  hasTruthyChildTag,
  parseDefDocument
} from '../src/defParser';
import type { DefElementNode } from '../src/defParser';
import { analyzeEntitiesXml } from '../src/entitiesXmlAnalysis';

// C-9(V-07·b):fantasydemo 真实脚本样例批 —— def 解析 / 继承 / 校验行为断言。
// 口径与 tests/fantasydemoRealExport.test.ts 一致:无本机
// BigWorld/programming/fantasydemo 检出即整组跳过(CI 默认环境),缺席时不虚构
// 「真实脚本」结果。这批断言的价值是**误报闸**——真实引擎脚本(非本仓手写样例)
// 必须:① 解析不抛且节结构与文件语义一致;② 方法-节归属与引擎 def 格式一致;
// ③ correctness 类检查零误报(invalid-identifier / duplicate-type-tag /
// engine-limited-name / missing-type / inherited-name-collision);
// ④ 无 Implements 的真实树继承闭包为空、def 链单节点无祖先(不虚构继承);
// ⑤ entities.xml 注册面与 entity_defs 库存双向对账。
const FANTASY_ROOT = '/home/cui/workspaces/BigWorld/programming/fantasydemo/res';
const SCRIPTS_DIR = join(FANTASY_ROOT, 'scripts');
const DEFS_DIR = join(SCRIPTS_DIR, 'entity_defs');

const EXPECTED_DEFS = ['Account.def', 'Avatar.def', 'ClientOnly.def', 'Guard.def', 'Space.def'];

// correctness 类:真实引擎脚本上必须为零(报告即误报)
const CORRECTNESS_CHECKS: DefAnalysisCheck[] = [
  'invalid-identifier',
  'duplicate-type-tag',
  'engine-limited-name',
  'missing-type',
  'inherited-name-collision'
];

describe.skipIf(!existsSync(DEFS_DIR))('fantasydemo 真实 def 脚本行为断言', () => {
  const readDef = (name: string): string => readFileSync(join(DEFS_DIR, name), 'utf8');
  const rootOf = (name: string): DefElementNode => {
    const root = parseDefDocument(readDef(name)).root;
    expect(root, `${name} 解析后应有根元素`).not.toBeNull();
    return root as DefElementNode;
  };
  const sectionNames = (root: DefElementNode, section: string): string[] =>
    (getDirectChildElement(root, section) ?? { children: [] }).children
      .filter(child => child.kind === 'element')
      .map(child => (child as DefElementNode).name);
  const propertyNames = (root: DefElementNode): DefElementNode[] =>
    getDirectChildElements(getDirectChildElement(root, 'Properties')).map(node => node);

  it('entity_defs 库存与 entities.xml 注册面双向对账', () => {
    const inventory = readdirSync(DEFS_DIR).filter(name => name.endsWith('.def')).sort();
    expect(inventory).toEqual([...EXPECTED_DEFS].sort());

    const entitiesRoot = parseDefDocument(readFileSync(join(SCRIPTS_DIR, 'entities.xml'), 'utf8')).root;
    expect(entitiesRoot).not.toBeNull();
    const clientServer = getDirectChildElement(entitiesRoot, 'ClientServerEntities');
    const serverOnly = getDirectChildElement(entitiesRoot, 'ServerOnlyEntities');
    expect(serverOnly, 'entities.xml 应有 ServerOnlyEntities 节(可为空段)').toBeDefined();
    expect(sectionNames(entitiesRoot as DefElementNode, 'ServerOnlyEntities')).toEqual([]);
    expect(sectionNames(entitiesRoot as DefElementNode, 'ClientServerEntities').sort()).toEqual(
      ['Account', 'Avatar', 'ClientOnly', 'Guard', 'Space'].sort()
    );

    // 双向:注册表每个实体都有对应 def,库存每个 def 都被注册
    const registered = sectionNames(entitiesRoot as DefElementNode, 'ClientServerEntities');
    for (const entity of registered) {
      expect(existsSync(join(DEFS_DIR, `${entity}.def`)), `${entity} 已注册但缺 def`).toBe(true);
    }
    for (const file of inventory) {
      expect(registered).toContain(file.replace(/\.def$/, ''));
    }
    expect(clientServer).toBeDefined();
  });

  it('五个真实 def 全部可解析,节结构与文件语义一致(Space 零属性三方法节齐全)', () => {
    for (const file of EXPECTED_DEFS) {
      expect(() => parseDefDocument(readDef(file))).not.toThrow(`${file} 解析失败`);
      const root = rootOf(file);
      for (const section of DEF_METHOD_SECTIONS) {
        expect(getDirectChildElement(root, section), `${file} 缺 ${section} 节`).toBeDefined();
      }
    }

    // 真实语义:Space 是「无可持久化属性的容器实体」,Properties 节存在但为空段
    const space = rootOf('Space.def');
    expect(getDirectChildElement(space, 'Properties')).toBeDefined();
    expect(propertyNames(space)).toEqual([]);
    const avatar = rootOf('Avatar.def');
    expect(getDirectChildElement(avatar, 'Properties')).toBeDefined();
    expect(getDirectChildElement(avatar, 'Volatile')).toBeDefined();
    expect(sectionNames(avatar, 'Volatile').sort()).toEqual(['pitch', 'position', 'yaw'].sort());
  });

  it('方法-节归属与引擎 def 格式一致(Avatar logOff→Base、fromCell/cellTick→Client)', () => {
    expect(sectionNames(rootOf('Avatar.def'), 'BaseMethods')).toEqual(['logOff']);
    expect(sectionNames(rootOf('Avatar.def'), 'CellMethods')).toEqual([]);
    expect(sectionNames(rootOf('Avatar.def'), 'ClientMethods')).toEqual(['fromCell', 'cellTick']);
    expect(sectionNames(rootOf('Account.def'), 'ClientMethods')).toEqual(['chatMessage']);
    expect(sectionNames(rootOf('Account.def'), 'BaseMethods')).toEqual([]);
    expect(sectionNames(rootOf('ClientOnly.def'), 'ClientMethods')).toEqual(['method1']);
    // Guard 是 cell+client 占位实体:三方法节标签在但全空
    for (const section of DEF_METHOD_SECTIONS) {
      expect(sectionNames(rootOf('Guard.def'), section)).toEqual([]);
    }

    // 引擎格式差异:base 方法用 <Exposed/>,client 方法用 <Arg>
    const logOff = getDirectChildElements(getDirectChildElement(rootOf('Avatar.def'), 'BaseMethods'))[0];
    const fromCell = getDirectChildElements(getDirectChildElement(rootOf('Avatar.def'), 'ClientMethods'))[0];
    expect(hasTruthyChildTag(logOff, 'Exposed')).toBe(true);
    expect(getScalarChildValue(fromCell, 'Arg')).toBe('STRING');
  });

  it('属性面:类型/域位/Identifier 与真实脚本一致', () => {
    const avatarProps = propertyNames(rootOf('Avatar.def'));
    expect(avatarProps.map(node => node.name)).toEqual(['playerName', 'prop1', 'prop2', 'prop3']);
    expect(getScalarChildValue(avatarProps[0], 'Type')).toBe('STRING');
    expect(getScalarChildValue(avatarProps[0], 'Flags')).toBe('ALL_CLIENTS');
    expect(hasTruthyChildTag(avatarProps[0], 'Identifier')).toBe(true);
    expect(getScalarChildValue(avatarProps[1], 'Type')).toBe('INT32');
    expect(getScalarChildValue(avatarProps[3], 'Type')).toBe('INT8');
    expect(getScalarChildValue(avatarProps[3], 'Flags')).toBe('OTHER_CLIENTS');

    expect(propertyNames(rootOf('Account.def')).map(node => node.name)).toEqual(['playerName', 'character']);
    expect(getScalarChildValue(propertyNames(rootOf('Account.def'))[1], 'Flags')).toBe('BASE');
    expect(propertyNames(rootOf('Guard.def')).map(node => node.name)).toEqual(['name']);
    expect(propertyNames(rootOf('Space.def'))).toEqual([]);
  });

  it('校验行为:真实脚本零 correctness 类误报,建议类发现只落已知清单', () => {
    const known: DefAnalysisCheck[] = [
      'phantom-type',
      'missing-type',
      'duplicate-type-tag',
      'heavy-sync-broadcast',
      'redundant-detail-level',
      'invalid-identifier',
      'method-property-collision',
      'engine-limited-name',
      'inherited-name-collision'
    ];
    let advisory = 0;
    for (const file of EXPECTED_DEFS) {
      const findings = analyzeDefDocument(readDef(file));
      const unexpected = findings.filter(finding => !known.includes(finding.check));
      expect(unexpected, `${file} 出现未知检查项`).toEqual([]);
      const correctness = findings.filter(finding => CORRECTNESS_CHECKS.includes(finding.check));
      expect(correctness, `${file} correctness 类误报`).toEqual([]);
      advisory += findings.length;
    }
    // 建议类(重同步广播等)如实允许出现,数量进 CI 日志供趋势观察
    process.stdout.write(`fantasydemo advisory findings total: ${advisory}\n`);
  });

  it('继承行为:无 Implements 的真实树闭包为空、def 链单节点无祖先', () => {
    for (const file of EXPECTED_DEFS) {
      const filePath = join(DEFS_DIR, file);
      expect(collectInheritedNames(filePath), `${file} 无祖先,闭包应空`).toEqual(new Map());
      const chain = buildDefChain(filePath);
      expect(chain, `${file} 无继承/接口/组件槽`).toEqual({
        parentChain: [],
        interfaces: [],
        components: [],
        cycleTruncated: false
      });
    }
  });

  it('entities.xml 校验:零发现且重复条目定位口径稳定', () => {
    const text = readFileSync(join(SCRIPTS_DIR, 'entities.xml'), 'utf8');
    expect(analyzeEntitiesXml(text)).toEqual([]);
    // 注入一个真实重复条目:发现应恰好一条并覆盖该重复开标签
    const duplicated = text.replace('<Account/>', '<Account/>\n\t\t<Account/>');
    const findings = analyzeEntitiesXml(duplicated);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('duplicate-entity-name');
    expect(findings[0].name).toBe('Account');
    expect(duplicated.slice(findings[0].offset, findings[0].offset + findings[0].length)).toBe('<Account/>');
  });
});
