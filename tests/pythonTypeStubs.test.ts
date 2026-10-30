import { beforeEach, describe, expect, it } from 'vitest';
import {
  PYTHON_BUILTIN_TYPE_ANNOTATIONS,
  PYTHON_TYPE_STUB_FALLBACK,
  PYTHON_TYPE_STUB_FILE_NAME,
  buildPythonTypeStubContent,
  buildPythonTypeStubPlan,
  exportPythonTypeStubs,
  kbeTypeStubFilePath,
  resolveCustomTypePropertyAnnotation,
  resolveFixedDictMember,
  setupTypeStubRegeneration,
  typeStubMirrorRelativeDir
} from '../src/pythonTypeStubs';
import type { CustomTypeInfo } from '../src/definitionWorkspace';
import {
  configurationOverrides,
  messages,
  Uri,
  windowState,
  workspace as stubWorkspace,
  workspaceState
} from './helpers/vscodeStub';

// docs/design/def-pyi-stubs.md §6 立项落地:types.xml 自定义类型(utype)发射成
// Python 类型桩 kbe_types.pyi(B 单:纯 .pyi 声明桩,按 types.xml 文件分件、
// 镜像 scripts 树收独立 typings 根,T-04 不做同目录同名 sidecar),与
// KBEngine.pyi 同居 stubDir 三级解析目录,复用 kbengine.python.stubExport
// 开关与「内容一致零写」纪律;extraPaths 管理段同盘并入。

interface TypeScript {
  name: string;
  aliasType: string;
  rawValue?: string;
  of?: string;
  filePath?: string;
  properties?: Array<{
    name: string;
    typeName?: string;
    typeStructure?: { name: string; rawValue?: string; children: Array<{ tag: string; value: { name: string; children: never[] } }> };
  }>;
}

const makeType = (script: TypeScript): CustomTypeInfo => {
  const rawValue = script.rawValue ?? script.aliasType;
  const ofNode = (of: TypeScript['of']): { tag: string; value: { name: string; rawValue: string; children: never[] } } | null => {
    if (!of) {
      return null;
    }
    if (typeof of === 'string') {
      return { tag: 'of', value: { name: of, rawValue: of, children: [] } };
    }
    return { tag: 'of', value: { name: of.name, rawValue: of.name, children: [] } };
  };
  return {
    name: script.name,
    filePath: script.filePath ?? '/ws/scripts/entity_defs/types.xml',
    line: 1,
    implementedByLine: 1,
    startOffset: 0,
    endOffset: 1,
    aliasType: script.aliasType,
    rawValue,
    structure: {
      name: script.aliasType,
      rawValue,
      children: ofNode(script.of) ? [ofNode(script.of) as { tag: string; value: { name: string; rawValue: string; children: never[] } }] : []
    },
    properties: (script.properties ?? []).map(property => ({
      name: property.name,
      typeName: property.typeName,
      typeStructure: property.typeStructure
    }))
  };
};

interface DepsScript {
  existing?: string[];
  initial?: Record<string, string>;
  readFails?: boolean;
  writeFails?: boolean;
}

const makeDeps = (script: DepsScript = {}): {
  deps: import('../src/pythonStubExport').StubExportDeps;
  writes: Array<{ path: string; content: string }>;
  mkdirs: string[];
} => {
  const writes: Array<{ path: string; content: string }> = [];
  const mkdirs: string[] = [];
  return {
    writes,
    mkdirs,
    deps: {
      exists: (candidate: string): boolean => (script.existing ?? []).includes(candidate),
      readFile: (path: string): string => {
        if (script.readFails) {
          throw new Error('EACCES');
        }
        return script.initial?.[path] ?? '';
      },
      writeFile: (path: string, content: string): void => {
        if (script.writeFails) {
          throw new Error('EROFS');
        }
        writes.push({ path, content });
      },
      mkdir: (dir: string): void => {
        if (script.writeFails) {
          throw new Error('EROFS');
        }
        mkdirs.push(dir);
      }
    }
  };
};

const folder = (fsPath: string) => ({ uri: Uri.file(fsPath), name: fsPath.replace(/^\//, ''), index: 0 });

const SAMPLE_TYPES = (): CustomTypeInfo[] => [
  makeType({
    name: 'AVATAR_INFO',
    aliasType: 'FIXED_DICT',
    rawValue: 'FIXED_DICT',
    properties: [
      { name: 'name', typeName: 'STRING' },
      { name: 'level', typeName: 'UINT32' }
    ]
  }),
  makeType({ name: 'AVATAR_INFO_LIST', aliasType: 'ARRAY', rawValue: 'ARRAY <of> AVATAR_INFO </of>', of: 'AVATAR_INFO' }),
  makeType({ name: 'AVATAR_NAME', aliasType: 'STRING', rawValue: 'STRING' })
];

describe('PYTHON_BUILTIN_TYPE_ANNOTATIONS(内置类型 → Python 注解)', () => {
  it('标量三族齐:整型→int,浮点→float,字符串→str', () => {
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.STRING).toBe('str');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.UNICODE).toBe('str');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.INT32).toBe('int');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.UINT64).toBe('int');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.FLOAT).toBe('float');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.DOUBLE).toBe('float');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.BOOL).toBe('bool');
  });

  it('向量按定长 tuple,PY 系与 ENTITYCALL 归 Any 族,BLOB→bytes', () => {
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.VECTOR2).toBe('Tuple[float, float]');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.VECTOR3).toBe('Tuple[float, float, float]');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.VECTOR4).toBe('Tuple[float, float, float, float]');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.PYTHON).toBe('Any');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.PY_DICT).toBe('Dict[Any, Any]');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.PY_TUPLE).toBe('Tuple[Any, ...]');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.PY_LIST).toBe('List[Any]');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.ENTITYCALL).toBe('Any');
    expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS.BLOB).toBe('bytes');
  });

  it('兜底注解是 Any(有损但合法,分析 §2 口径)', () => {
    expect(PYTHON_TYPE_STUB_FALLBACK).toBe('Any');
  });

  it('注册面锁:引擎 addDataType 全部内建名都在表内,一个不漏(2026-10-27 pyi ④)', () => {
    // 出处:kbe/src/lib/entitydef/datatypes.cpp DataTypes::initialize 的
    // addDataType 注册面(56-79 行,21 个;本地检出 /home/cui/workspaces/kbengine
    // 与上游 master 同面核对过)。仓里没有默认 types.xml——内建全走 C++ 注册,
    // types.xml 只装用户自定义类型,「对照 types.xml」即对照这条注册面。
    const registered = [
      'UINT8', 'UINT16', 'UINT32', 'UINT64',
      'INT8', 'INT16', 'INT32', 'INT64',
      'STRING', 'UNICODE', 'FLOAT', 'DOUBLE',
      'PYTHON', 'PY_DICT', 'PY_TUPLE', 'PY_LIST',
      'ENTITYCALL', 'BLOB',
      'VECTOR2', 'VECTOR3', 'VECTOR4'
    ];
    for (const name of registered) {
      expect(PYTHON_BUILTIN_TYPE_ANNOTATIONS[name], `缺注册面内建 ${name}`).toBeDefined();
    }
    // 表里除注册面外只许 BOOL 一条礼貌容错(BigWorld 迁移遗产;def 层仍按
    // 幻影类型诊断,见 defAnalyzer PHANTOM_TYPE_NAMES),不得自创其他条目
    const extras = Object.keys(PYTHON_BUILTIN_TYPE_ANNOTATIONS)
      .filter(name => !registered.includes(name) && name !== 'BOOL');
    expect(extras).toEqual([]);
  });
});

describe('buildPythonTypeStubPlan(类型表→发射计划)', () => {
  it('FIXED_DICT 发 TypedDict 类,属性按内置表注解', () => {
    const plan = buildPythonTypeStubPlan([SAMPLE_TYPES()[0]]);

    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toEqual({
      kind: 'class',
      name: 'AVATAR_INFO',
      properties: [
        { name: 'name', annotation: 'str' },
        { name: 'level', annotation: 'int' }
      ],
      propertySourceLines: {
        level: null,
        name: null
      },
      sourceFile: 'types.xml',
      sourceLine: 1
    });
    expect(plan.skipped).toEqual([]);
    expect(plan.content).toContain('class AVATAR_INFO(TypedDict):');
    expect(plan.content).toContain('    name: str');
    expect(plan.content).toContain('    level: int');
  });

  it('ARRAY 别名发 List[元素],元素是自定义类型名', () => {
    const plan = buildPythonTypeStubPlan([SAMPLE_TYPES()[0], SAMPLE_TYPES()[1]]);

    const alias = plan.entries.find(entry => entry.kind === 'alias');
    expect(alias).toEqual({
      annotation: 'List[AVATAR_INFO]',
      kind: 'alias',
      name: 'AVATAR_INFO_LIST',
      sourceFile: 'types.xml',
      sourceLine: 1
    });
  });

  it('别名单层解析到底层内建:TIMESTAMP→UINT64 发 int', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'TIMESTAMP', aliasType: 'UINT64', rawValue: 'UINT64' })
    ]);

    expect(plan.entries[0]).toEqual({
      annotation: 'int',
      kind: 'alias',
      name: 'TIMESTAMP',
      sourceFile: 'types.xml',
      sourceLine: 1
    });
    expect(plan.content).toContain('TIMESTAMP = int');
  });

  it('别名到内置类型发赋值语句', () => {
    const plan = buildPythonTypeStubPlan([SAMPLE_TYPES()[2]]);

    expect(plan.entries[0]).toEqual({
      annotation: 'str',
      kind: 'alias',
      name: 'AVATAR_NAME',
      sourceFile: 'types.xml',
      sourceLine: 1
    });
    expect(plan.content).toContain('AVATAR_NAME = str');
  });

  it('别名多链逐层解析到底:B→A→STRING 整链都解析成 str,不发射链上裸名', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'C', aliasType: 'B', rawValue: 'B' }),
      makeType({ name: 'B', aliasType: 'A', rawValue: 'A' }),
      makeType({ name: 'A', aliasType: 'STRING', rawValue: 'STRING' })
    ]);

    const annotations = Object.fromEntries(
      plan.entries.map(entry => [entry.name, entry.kind === 'alias' ? entry.annotation : ''])
    );
    expect(annotations).toEqual({ A: 'str', B: 'str', C: 'str' });
    expect(plan.content).toContain('A = str');
    expect(plan.content).toContain('B = str');
    expect(plan.content).toContain('C = str');
    expect(plan.skipped).toEqual([]);
  });

  it('别名解析到 FIXED_DICT 引用类名(类已在本文件定义,不算悬挂)', () => {
    const plan = buildPythonTypeStubPlan([
      SAMPLE_TYPES()[0],
      makeType({ name: 'INFO_REF', aliasType: 'AVATAR_INFO', rawValue: 'AVATAR_INFO' })
    ]);

    const alias = plan.entries.find(entry => entry.name === 'INFO_REF');
    expect(alias?.kind).toBe('alias');
    if (!alias || alias.kind !== 'alias') {
      return;
    }
    expect(alias.annotation).toBe('AVATAR_INFO');
    expect(plan.content).toContain('INFO_REF = AVATAR_INFO');
  });

  it('FD 属性引用别名时同样解析到底,不发射链上裸名', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'TIMESTAMP', aliasType: 'UINT64', rawValue: 'UINT64' }),
      makeType({
        name: 'EVENT',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        properties: [{ name: 'at', typeName: 'TIMESTAMP' }]
      })
    ]);

    const entry = plan.entries.find(candidate => candidate.name === 'EVENT');
    if (!entry || entry.kind !== 'class') {
      return;
    }
    expect(entry.properties[0].annotation).toBe('int');
  });

  it('别名环成环整链跳过,原因写明', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'X', aliasType: 'Y', rawValue: 'Y' }),
      makeType({ name: 'Y', aliasType: 'X', rawValue: 'X' })
    ]);

    expect(plan.entries).toHaveLength(0);
    expect(plan.content).toBeNull();
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped[0].reason).toContain('环');
  });

  it('指引为空(aliasType 落 ALIAS 占位)跳过并说明', () => {
    const plan = buildPythonTypeStubPlan([makeType({ name: 'GHOST', aliasType: 'ALIAS', rawValue: '' })]);

    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0].name).toBe('GHOST');
    expect(plan.skipped[0].reason).toContain('指引');
  });

  it('依赖链上游被跳过时下游连带跳过', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'GHOST', aliasType: 'ALIAS', rawValue: '' }),
      makeType({ name: 'FOLLOWER', aliasType: 'GHOST', rawValue: 'GHOST' })
    ]);

    const names = plan.skipped.map(item => item.name).sort();
    expect(names).toEqual(['FOLLOWER', 'GHOST']);
    expect(plan.skipped.find(item => item.name === 'FOLLOWER')?.reason).toContain('GHOST');
  });

  it('嵌套 ARRAY(of 套 of)递归成 List[List[元素]]', () => {
    const nested = makeType({ name: 'NESTED', aliasType: 'ARRAY', rawValue: 'ARRAY <of> ARRAY <of> INT32 </of> </of>' });
    nested.structure = {
      name: 'ARRAY',
      rawValue: nested.rawValue,
      children: [
        {
          tag: 'of',
          value: {
            name: 'ARRAY',
            rawValue: 'ARRAY <of> INT32 </of>',
            line: null,
            children: [{ tag: 'of', value: { name: 'INT32', rawValue: 'INT32', children: [], line: null } }]
          }
        }
      ],
      line: null
      };

    const plan = buildPythonTypeStubPlan([nested]);

    expect(plan.entries[0]).toEqual({
      annotation: 'List[List[int]]',
      kind: 'alias',
      name: 'NESTED',
      sourceFile: 'types.xml',
      sourceLine: 1
    });
  });

  it('FD 属性引用自定义类型名出名字注解;未知类型落 Any;内联 ARRAY 落 List[Any]', () => {
    const plan = buildPythonTypeStubPlan([
      SAMPLE_TYPES()[0],
      makeType({
        name: 'PROFILE',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        properties: [
          { name: 'avatar', typeName: 'AVATAR_INFO' },
          { name: 'mystery', typeName: 'NOT_A_TYPE' },
          { name: 'inlineArray', typeName: 'ARRAY' },
          { name: 'blank', typeName: undefined }
        ]
      })
    ]);

    const entry = plan.entries.find(candidate => candidate.name === 'PROFILE');
    expect(entry?.kind).toBe('class');
    if (!entry || entry.kind !== 'class') {
      return;
    }
    const byName = Object.fromEntries(entry.properties.map(property => [property.name, property.annotation]));
    expect(byName.avatar).toBe('AVATAR_INFO');
    expect(byName.mystery).toBe('Any');
    expect(byName.inlineArray).toBe('List[Any]');
    expect(byName.blank).toBe('Any');
  });

  it('FD 属性内联 ARRAY<of>自定义类型:元素型按结构树解析成 List[元素名](2026-10-29 用户报 List[Any])', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({
        name: 'SHOW_ROLE_INFO',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        properties: [{ name: 'dbid', typeName: 'UINT64' }]
      }),
      makeType({
        name: 'AVATAR_SHOW_INFO',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        properties: [
          {
            name: 'roleInfoList',
            typeName: 'ARRAY',
            typeStructure: {
              name: 'ARRAY',
              rawValue: 'ARRAY <of> SHOW_ROLE_INFO </of>',
              children: [
                { tag: 'of', value: { name: 'SHOW_ROLE_INFO', rawValue: 'SHOW_ROLE_INFO', children: [] } }
              ]
            }
          }
        ]
      })
    ]);

    const entry = plan.entries.find(candidate => candidate.name === 'AVATAR_SHOW_INFO');
    expect(entry?.kind).toBe('class');
    if (!entry || entry.kind !== 'class') {
      return;
    }
    const byName = Object.fromEntries(entry.properties.map(property => [property.name, property.annotation]));
    // 元素型照结构树解析到 FIXED_DICT 类名,不再有损落 List[Any]
    expect(byName.roleInfoList).toBe('List[SHOW_ROLE_INFO]');
  });

  it('FD 零属性出 pass 体', () => {
    const plan = buildPythonTypeStubPlan([makeType({ name: 'EMPTY_FD', aliasType: 'FIXED_DICT', rawValue: 'FIXED_DICT' })]);

    expect(plan.content).toContain('class EMPTY_FD(TypedDict):');
    expect(plan.content).toContain('    pass');
  });

  it('数组元素缺失 of 时落 List[Any]', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'BARE_ARRAY', aliasType: 'ARRAY', rawValue: 'ARRAY' })
    ]);

    expect(plan.entries[0]).toEqual({
      annotation: 'List[Any]',
      kind: 'alias',
      name: 'BARE_ARRAY',
      sourceFile: 'types.xml',
      sourceLine: 1
    });
  });

  it('数组元素指引为 ALIAS 占位时也落 List[Any],不把占位符当类型名发射', () => {
    const ghostElement = makeType({ name: 'GHOST_ARRAY', aliasType: 'ARRAY', rawValue: 'ARRAY <of> ALIAS </of>', of: 'ALIAS' });

    const plan = buildPythonTypeStubPlan([ghostElement]);

    expect(plan.entries[0]).toEqual({
      annotation: 'List[Any]',
      kind: 'alias',
      name: 'GHOST_ARRAY',
      sourceFile: 'types.xml',
      sourceLine: 1
    });
  });

  it('同镜像目录合并解析:types.xml 引 alias.xml 的名字真实可解析,不落 Any(2026-10-27 pyi ④)', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({
        name: 'AVATAR_INFO',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        properties: [
          { name: 'name', typeName: 'UNICODE' },
          { name: 'skillFlags', typeName: 'SKILL_FLAGS' }
        ]
      }),
      makeType({
        name: 'SKILL_FLAGS',
        aliasType: 'ARRAY',
        rawValue: 'ARRAY <of> UINT32 </of>',
        of: 'UINT32',
        filePath: '/ws/scripts/entity_defs/alias.xml'
      })
    ]);

    const avatar = plan.entries.find(entry => entry.name === 'AVATAR_INFO');
    expect(avatar?.kind === 'class' && avatar.properties.find(property => property.name === 'skillFlags')?.annotation)
      .toBe('List[int]');
    expect(plan.content).toContain('SKILL_FLAGS = List[int]');
    // 合并分件逐条可辨来源:alias.xml 条目不再冒名 types.xml
    expect(plan.content).toContain('# source: alias.xml:1');
    expect(plan.content).toContain('# source: types.xml:1');
  });

  it('同名去重:引擎 addDataType 拒重复注册,types.xml 先见保留、alias.xml 后到作废', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'DUP', aliasType: 'STRING', rawValue: 'STRING' }),
      makeType({ name: 'DUP', aliasType: 'UINT8', rawValue: 'UINT8', filePath: '/ws/scripts/entity_defs/alias.xml' })
    ]);

    expect(plan.entries.filter(entry => entry.name === 'DUP')).toHaveLength(1);
    expect(plan.content).toContain('DUP = str');
    expect(plan.content).not.toContain('DUP = int');
    const skipped = plan.skipped.find(item => item.name === 'DUP');
    expect(skipped?.reason).toContain('addDataType');
    expect(skipped?.reason).toContain('types.xml');
  });

  it('跨模块引用面:别的 kbe_types 分件已发射的名字按名引用,不落 Any(诚实 Any 边界收口)', () => {
    const external = new Map([['AVATAR_INFO', 'scripts.entity_defs.kbe_types']]);
    const plan = buildPythonTypeStubPlan(
      [makeType({
        name: 'REMOTE_LIST',
        aliasType: 'ARRAY',
        rawValue: 'ARRAY <of> AVATAR_INFO </of>',
        of: 'AVATAR_INFO',
        filePath: '/ws/scripts/cellapp/entity_defs/types.xml'
      })],
      { externalModules: external }
    );

    expect(plan.entries[0]?.kind === 'alias' && plan.entries[0].annotation).toBe('List[AVATAR_INFO]');
    expect(plan.content).toContain('REMOTE_LIST = List[AVATAR_INFO]');
    expect(plan.content).toContain('from scripts.entity_defs.kbe_types import AVATAR_INFO');
  });

  it('别名赋值按名字序发射(解析后注解只含到底类型,顺序与输入无关)', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'ALIAS_B', aliasType: 'ZTARGET', rawValue: 'ZTARGET' }),
      makeType({ name: 'ZTARGET', aliasType: 'STRING', rawValue: 'STRING' })
    ]);

    const names = plan.entries.map(entry => entry.name);
    expect(names).toEqual(['ALIAS_B', 'ZTARGET']);
    expect(plan.content).toContain('ZTARGET = str');
    expect(plan.content).toContain('ALIAS_B = str');
  });

  it('零自定义类型/全跳过时 content 为 null(不生成文件)', () => {
    expect(buildPythonTypeStubPlan([]).content).toBeNull();
    expect(buildPythonTypeStubPlan([SAMPLE_TYPES()[2]]).content).not.toBeNull();
  });

  it('FD 属性内联 ARRAY 元素引用成环别名:解析抛错有损落 List[Any],不外抛(覆盖率 360)', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'LOOP', aliasType: 'LOOP', rawValue: 'LOOP' }),
      makeType({
        name: 'ARRAY_OF_LOOP',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        properties: [{
          name: 'items',
          typeName: 'ARRAY',
          typeStructure: {
            name: 'LOOP',
            rawValue: 'LOOP',
            children: [] as Array<{ tag: string; value: { name: string; children: never[] } }>
          }
        }]
      })
    ]);

    const entry = plan.entries.find(candidate => candidate.name === 'ARRAY_OF_LOOP');
    expect(entry?.kind).toBe('class');
    if (!entry || entry.kind !== 'class') {
      return;
    }
    // 成环元素解析抛错被属性层接住:数组形状保留,元素型 Any,不炸整份发射
    expect(entry.properties[0].annotation).toBe('List[Any]');
  });

  it('FD 属性类型引用成环别名:有损落 Any,不外抛(覆盖率 368)', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'LOOP', aliasType: 'LOOP', rawValue: 'LOOP' }),
      makeType({
        name: 'USES_LOOP',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        properties: [{ name: 'field', typeName: 'LOOP' }]
      })
    ]);

    const entry = plan.entries.find(candidate => candidate.name === 'USES_LOOP');
    expect(entry?.kind).toBe('class');
    if (!entry || entry.kind !== 'class') {
      return;
    }
    expect(entry.properties[0].annotation).toBe('Any');
  });

  it('内容确定:同一输入两次构建逐字节一致(零写语义的前提)', () => {
    const first = buildPythonTypeStubPlan(SAMPLE_TYPES()).content;
    const second = buildPythonTypeStubPlan(SAMPLE_TYPES()).content;
    expect(first).toBe(second);
  });

  it('头部带生成物声明与 gitignore 建议,future annotations + typing 导入', () => {
    const content = buildPythonTypeStubPlan(SAMPLE_TYPES()).content ?? '';

    expect(content).toContain('from __future__ import annotations');
    expect(content).toContain('import KBEngine');
    expect(content).toContain('from KBEngine import Entity');
    expect(content).toContain('from typing import Any, Callable, Dict, List, Tuple, TypedDict, Union');
    expect(content).toContain('.gitignore');
    expect(content).toContain('.kbengine/stubs');
  });

  it('引用引擎类型时同文件给出 KBEngine 出处,未引用则不导入', () => {
    const unqualified = buildPythonTypeStubPlan([
      makeType({
        name: 'MONITORED',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        properties: [
          { name: 'address', typeName: 'Address' },
          { name: 'value', typeName: 'WatcherValue' }
        ]
      })
    ]).content ?? '';
    expect(unqualified).toContain('from KBEngine import Address, WatcherValue');
    expect(unqualified).toContain('    address: Address');
    expect(unqualified).toContain('    value: WatcherValue');

    const qualified = buildPythonTypeStubPlan(SAMPLE_TYPES()).content ?? '';
    expect(qualified).not.toContain('from KBEngine import Address');
    expect(qualified).not.toContain('from KBEngine import WatcherValue');
  });

  it('生成桩中每类外部注解名都有导入着落', () => {
    const content = buildPythonTypeStubPlan([
      makeType({
        name: 'EXTERNAL_REFS',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        properties: [
          { name: 'address', typeName: 'Address' },
          { name: 'callback', typeName: 'Callable' },
          { name: 'value', typeName: 'WatcherValue' }
        ]
      })
    ]).content ?? '';

    const importedNames = new Set(
      content
        .split('\n')
        .filter(line => /^(?:from [.\w]+ import|import )/.test(line))
        .flatMap(line => line.replace(/^.*\bimport\s*/, '').split(','))
        .map(name => name.trim().split(/\s+as\s+/).pop() ?? '')
    );
    for (const name of ['Address', 'Callable', 'Entity', 'WatcherValue']) {
      expect(importedNames.has(name), name).toBe(true);
    }
  });

  it('头部 typing 导入中的 Union 也保留着落', () => {
    const content = buildPythonTypeStubPlan(SAMPLE_TYPES()).content ?? '';
    expect(content).toContain('from typing import Any, Callable, Dict, List, Tuple, TypedDict, Union');
  });

  it('多外部模块引用按模块名排序逐组发 import(覆盖率 545 比较器)', () => {
    const content = buildPythonTypeStubContent(
      [{
        kind: 'class',
        name: 'MIXED',
        properties: [
          { name: 'left', annotation: 'A' },
          { name: 'right', annotation: 'B' }
        ],
        propertySourceLines: { left: null, right: null },
        sourceFile: 'types.xml',
        sourceLine: 1
      }],
      new Map([
        ['A', 'scripts.aaa.kbe_types'],
        ['B', 'scripts.zzz.kbe_types']
      ])
    ) ?? '';
    expect(content).toContain('from scripts.aaa.kbe_types import A');
    expect(content).toContain('from scripts.zzz.kbe_types import B');
    // 多模块:按模块路径排序列出,先 aaa 后 zzz
    const aaa = content.indexOf('scripts.aaa.kbe_types');
    const zzz = content.indexOf('scripts.zzz.kbe_types');
    expect(aaa).toBeGreaterThanOrEqual(0);
    expect(zzz).toBeGreaterThan(aaa);
  });
});

describe('buildPythonTypeStubContent(空表)', () => {
  it('空条目直接 null', () => {
    expect(buildPythonTypeStubContent([])).toBeNull();
  });
});

describe('undefined-name regression gate', () => {
  it('engine names referenced by plan entries are emitted with imports', () => {
    const entries = buildPythonTypeStubPlan([
      makeType({
        name: 'MONITORED',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        properties: [
          { name: 'address', typeName: 'Address' },
          { name: 'value', typeName: 'WatcherValue' }
        ]
      })
    ]).entries;

    const content = buildPythonTypeStubContent(entries) ?? '';
    expect(content).toContain('from KBEngine import Address, WatcherValue');
    for (const name of ['Address', 'WatcherValue']) {
      expect(content, name).toMatch(new RegExp(`from KBEngine import [^\\n]*\\b${name}\\b`));
      expect(content, name).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('typing names referenced by plan entries are emitted with imports', () => {
    const entries = buildPythonTypeStubPlan([
      makeType({
        name: 'TYPED_CALLBACKS',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        properties: [
          { name: 'callback', typeName: 'Callable' },
          { name: 'choice', typeName: 'Union' }
        ]
      })
    ]).entries;

    const content = buildPythonTypeStubContent(entries) ?? '';
    expect(content).toContain(
      'from typing import Any, Callable, Dict, List, Tuple, TypedDict, Union'
    );
    for (const name of ['Callable', 'Union']) {
      expect(content, name).toMatch(new RegExp(`from typing import [^\\n]*\\b${name}\\b`));
      expect(content, name).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});

describe('kbeTypeStubFilePath(产物形态 .pyi,分件镜像路径)', () => {
  const MIRROR_PATH = '/ws/.kbengine/stubs/scripts/entity_defs/kbe_types.pyi';

  it('文件名是 .pyi(纯声明桩)', () => {
    expect(PYTHON_TYPE_STUB_FILE_NAME).toBe('kbe_types.pyi');
    expect(kbeTypeStubFilePath('/ws')).toBe('/ws/.kbengine/stubs/kbe_types.pyi');
  });

  it('分件镜像相对目录:工作区内照相对路径镜像 scripts 树', () => {
    expect(typeStubMirrorRelativeDir('/ws/scripts/entity_defs/types.xml', '/ws')).toBe(
      'scripts/entity_defs'
    );
    expect(
      typeStubMirrorRelativeDir('/ws/assets/scripts/cellapp/entity_defs/types.xml', '/ws')
    ).toBe('assets/scripts/cellapp/entity_defs');
  });

  it('工作区外但带 /scripts/ 段的从该段起镜像;认不出退回 null(根级单文件)', () => {
    expect(
      typeStubMirrorRelativeDir('/other/assets/scripts/entity_defs/types.xml', '/ws')
    ).toBe('scripts/entity_defs');
    expect(typeStubMirrorRelativeDir('/elsewhere/types.xml', '/ws')).toBeNull();
  });

  it('分件落点 = typings 根 + 镜像相对目录 + kbe_types.pyi(不做 types.xml 同目录 sidecar)', () => {
    const mirrorDir = typeStubMirrorRelativeDir('/ws/scripts/entity_defs/types.xml', '/ws');
    expect(`${'/ws/.kbengine/stubs'}/${mirrorDir}/kbe_types.pyi`).toBe(MIRROR_PATH);
    expect(MIRROR_PATH.startsWith('/ws/scripts')).toBe(false);
  });
});

describe('exportPythonTypeStubs(装配层)', () => {
  beforeEach(() => {
    messages.info.length = 0;
    messages.warning.length = 0;
    messages.error.length = 0;
    windowState.reset();
    workspaceState.reset();
    configurationOverrides.clear();
  });

  it('默认设置为开(复用 kbengine.python.stubExport 开关)', async () => {
    const { PYTHON_STUB_EXPORT_ENABLED_DEFAULT } = await import('../src/pythonStubExport');
    expect(PYTHON_STUB_EXPORT_ENABLED_DEFAULT).toBe(true);
  });

  it('开关关闭时说明返回,不写任何文件;静默模式零提示', async () => {
    configurationOverrides.set('kbengine', { 'python.stubExport': false });
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps } = makeDeps();

    await exportPythonTypeStubs(deps, { listCustomTypes: () => SAMPLE_TYPES() });

    expect(messages.info[0]).toContain('已关闭');
    expect(messages.info[0]).toContain('kbengine.python.stubExport');

    await exportPythonTypeStubs(deps, { silent: true, listCustomTypes: () => SAMPLE_TYPES() });
    expect(messages.info).toHaveLength(1);
    stubWorkspace.workspaceFolders = [];
  });

  it('未打开工作区时如实说明', async () => {
    stubWorkspace.workspaceFolders = [];
    const { deps } = makeDeps();

    await exportPythonTypeStubs(deps, { listCustomTypes: () => SAMPLE_TYPES() });

    expect(messages.info[0]).toContain('未打开工作区');
    expect(messages.info[0]).toContain('类型桩');
  });

  it('workspaceFolders 为 undefined(非空数组)时同样按无工作区处理', async () => {
    stubWorkspace.workspaceFolders = undefined as unknown as [];
    const { deps } = makeDeps();

    await exportPythonTypeStubs(deps, { listCustomTypes: () => SAMPLE_TYPES() });

    expect(messages.info[0]).toContain('未打开工作区');
    expect(messages.info[0]).toContain('类型桩');
    stubWorkspace.workspaceFolders = [];
  });

  it('未打开工作区 + 静默:零提示', async () => {
    stubWorkspace.workspaceFolders = [];
    const { deps } = makeDeps();

    await exportPythonTypeStubs(deps, { silent: true, listCustomTypes: () => SAMPLE_TYPES() });

    expect(messages.info).toHaveLength(0);
    expect(messages.warning).toHaveLength(0);
  });

  it('首导出到默认约定目录:镜像 scripts 树建目录写分件,播报文件夹', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes, mkdirs } = makeDeps();

    const written = await exportPythonTypeStubs(deps, { listCustomTypes: () => SAMPLE_TYPES() });

    expect(written).toEqual(['ws']);
    expect(mkdirs).toEqual(['/ws/.kbengine/stubs/scripts/entity_defs']);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/ws/.kbengine/stubs/scripts/entity_defs/kbe_types.pyi');
    expect(writes[0].content).toBe(buildPythonTypeStubPlan(SAMPLE_TYPES()).content);
    expect(messages.info[0]).toContain('ws');
    expect(messages.info[0]).toContain('kbe_types.pyi');
  });

  it('按文件分件:多个 types.xml 各出自镜像路径的独立 .pyi,内容互不混', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes } = makeDeps();
    const cellTypes = [
      makeType({
        name: 'CELL_INFO',
        aliasType: 'FIXED_DICT',
        rawValue: 'FIXED_DICT',
        filePath: '/ws/scripts/cellapp/entity_defs/types.xml',
        properties: [{ name: 'speed', typeName: 'FLOAT' }]
      })
    ];
    const listCustomTypes = (): CustomTypeInfo[] => [...SAMPLE_TYPES(), ...cellTypes];

    const written = await exportPythonTypeStubs(deps, { listCustomTypes });

    expect(written).toEqual(['ws']);
    expect(writes).toHaveLength(2);
    const byPath = new Map(writes.map(write => [write.path, write.content]));
    expect([...byPath.keys()].sort()).toEqual([
      '/ws/.kbengine/stubs/scripts/cellapp/entity_defs/kbe_types.pyi',
      '/ws/.kbengine/stubs/scripts/entity_defs/kbe_types.pyi'
    ]);
    expect(byPath.get('/ws/.kbengine/stubs/scripts/entity_defs/kbe_types.pyi')).toBe(
      buildPythonTypeStubPlan(SAMPLE_TYPES()).content
    );
    expect(byPath.get('/ws/.kbengine/stubs/scripts/cellapp/entity_defs/kbe_types.pyi')).toBe(
      buildPythonTypeStubPlan(cellTypes).content
    );
  });

  it('同镜像目录合并写一份:types.xml+alias.xml 只出一支 kbe_types.pyi,不再互相覆盖(2026-10-27 pyi ④)', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes } = makeDeps();
    const aliases = [
      makeType({
        name: 'SKILL_FLAGS',
        aliasType: 'ARRAY',
        rawValue: 'ARRAY <of> UINT32 </of>',
        of: 'UINT32',
        filePath: '/ws/scripts/entity_defs/alias.xml'
      }),
      makeType({ name: 'LEVEL_ALIAS', aliasType: 'UINT8', rawValue: 'UINT8', filePath: '/ws/scripts/entity_defs/alias.xml' })
    ];

    const written = await exportPythonTypeStubs(deps, { listCustomTypes: () => [...SAMPLE_TYPES(), ...aliases] });

    expect(written).toEqual(['ws']);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/ws/.kbengine/stubs/scripts/entity_defs/kbe_types.pyi');
    // 一份文件里两源齐在,跨文件引用解析到底
    expect(writes[0]?.content).toContain('class AVATAR_INFO(TypedDict):');
    expect(writes[0]?.content).toContain('SKILL_FLAGS = List[int]');
    expect(writes[0]?.content).toContain('LEVEL_ALIAS = int');
  });

  it('跨模块引用:另一镜像分件的名字在导出件里给出处 import', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes } = makeDeps();
    const remote = [
      makeType({
        name: 'REMOTE_LIST',
        aliasType: 'ARRAY',
        rawValue: 'ARRAY <of> AVATAR_INFO </of>',
        of: 'AVATAR_INFO',
        filePath: '/ws/scripts/cellapp/entity_defs/types.xml'
      })
    ];

    await exportPythonTypeStubs(deps, { listCustomTypes: () => [...SAMPLE_TYPES(), ...remote] });

    expect(writes).toHaveLength(2);
    const cellapp = writes.find(write => write.path.endsWith('cellapp/entity_defs/kbe_types.pyi'))?.content ?? '';
    expect(cellapp).toContain('REMOTE_LIST = List[AVATAR_INFO]');
    expect(cellapp).toContain('from scripts.entity_defs.kbe_types import AVATAR_INFO');
    const main = writes.find(write => write.path === '/ws/.kbengine/stubs/scripts/entity_defs/kbe_types.pyi')?.content ?? '';
    expect(main).not.toContain('from scripts.entity_defs.kbe_types import');
  });

  it('内容一致时零写零提示;陈旧时重写;读不到按陈旧重写', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const target = '/ws/.kbengine/stubs/scripts/entity_defs/kbe_types.pyi';
    const content = buildPythonTypeStubPlan(SAMPLE_TYPES()).content ?? '';

    const unchanged = makeDeps({
      existing: [target],
      initial: { [target]: content }
    });
    await exportPythonTypeStubs(unchanged.deps, { listCustomTypes: () => SAMPLE_TYPES() });
    expect(unchanged.writes).toHaveLength(0);
    expect(messages.info).toHaveLength(0);

    const stale = makeDeps({
      existing: [target],
      initial: { [target]: '# 旧版本' }
    });
    await exportPythonTypeStubs(stale.deps, { listCustomTypes: () => SAMPLE_TYPES() });
    expect(stale.writes).toHaveLength(1);
    expect(stale.writes[0].content).toBe(content);

    const unreadable = makeDeps({
      existing: [target],
      readFails: true
    });
    await exportPythonTypeStubs(unreadable.deps, { listCustomTypes: () => SAMPLE_TYPES() });
    expect(unreadable.writes).toHaveLength(1);
    stubWorkspace.workspaceFolders = [];
  });

  it('无自定义类型时跳过并说明,不写文件', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes } = makeDeps();

    await exportPythonTypeStubs(deps, { listCustomTypes: () => [] });

    expect(writes).toHaveLength(0);
    expect(messages.info.some(message => message.includes('无自定义类型'))).toBe(true);
    stubWorkspace.workspaceFolders = [];
  });

  it('用户配置目录:已有分件按用户资产跳过;没有才生成', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': '/user-stubs' });
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const owned = makeDeps({ existing: ['/user-stubs/scripts/entity_defs/kbe_types.pyi'] });

    await exportPythonTypeStubs(owned.deps, { listCustomTypes: () => SAMPLE_TYPES() });

    expect(owned.writes).toHaveLength(0);
    expect(messages.info.some(message => message.includes('按用户资产不覆盖'))).toBe(true);

    const free = makeDeps();
    await exportPythonTypeStubs(free.deps, { listCustomTypes: () => SAMPLE_TYPES() });
    expect(free.writes).toHaveLength(1);
    expect(free.writes[0].path).toBe('/user-stubs/scripts/entity_defs/kbe_types.pyi');
    stubWorkspace.workspaceFolders = [];
  });

  it('写失败(目录不可写)告警并继续,返回空表', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps } = makeDeps({ writeFails: true });

    const written = await exportPythonTypeStubs(deps, { listCustomTypes: () => SAMPLE_TYPES() });

    expect(written).toEqual([]);
    expect(messages.warning[0]).toContain('类型桩导出失败');
    stubWorkspace.workspaceFolders = [];
  });

  it('多文件夹逐个处理,失败不挡其余', async () => {
    stubWorkspace.workspaceFolders = [folder('/bad'), folder('/good')];
    const writes: Array<{ path: string; content: string }> = [];
    const deps = {
      exists: (_candidate: string): boolean => false,
      readFile: (): string => '',
      writeFile: (path: string, content: string): void => {
        if (path.startsWith('/bad')) {
          throw new Error('EROFS');
        }
        writes.push({ path, content });
      },
      mkdir: (): void => undefined
    };

    const written = await exportPythonTypeStubs(deps, { listCustomTypes: () => SAMPLE_TYPES() });

    expect(written).toEqual(['good']);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/good/.kbengine/stubs/scripts/entity_defs/kbe_types.pyi');
    stubWorkspace.workspaceFolders = [];
  });

  it('某分件模块全被跳过(成环)时 content=null 不落文件,其余模块照常(覆盖率 659)', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes } = makeDeps();
    // cellapp 模块是成环对(整链跳过 → content null),entity_defs 模块正常发射
    const cyclic = [
      makeType({ name: 'LOOP_A', aliasType: 'LOOP_B', rawValue: 'LOOP_B', filePath: '/ws/scripts/cellapp/entity_defs/types.xml' }),
      makeType({ name: 'LOOP_B', aliasType: 'LOOP_A', rawValue: 'LOOP_A', filePath: '/ws/scripts/cellapp/entity_defs/types.xml' })
    ];

    const written = await exportPythonTypeStubs(deps, { listCustomTypes: () => [...SAMPLE_TYPES(), ...cyclic] });

    expect(written).toEqual(['ws']);
    // 只落正常模块的分件,成环模块整份跳过不写文件
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/ws/.kbengine/stubs/scripts/entity_defs/kbe_types.pyi');
    expect(writes[0].content).toContain('class AVATAR_INFO(TypedDict):');
    stubWorkspace.workspaceFolders = [];
  });

  it('缺省 listCustomTypes 走真 getCustomTypeInfos(无 types.xml 即跳过)', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws-empty')];
    const { deps, writes } = makeDeps();

    await exportPythonTypeStubs(deps);

    expect(writes).toHaveLength(0);
    expect(messages.info.some(message => message.includes('无自定义类型'))).toBe(true);
    stubWorkspace.workspaceFolders = [];
  });

  it('静默模式:写入/跳过/失败三类事件都不弹提示', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];

    const failing = makeDeps({ writeFails: true });
    await exportPythonTypeStubs(failing.deps, { silent: true, listCustomTypes: () => SAMPLE_TYPES() });
    expect(failing.writes).toHaveLength(0);
    expect(messages.info).toHaveLength(0);
    expect(messages.warning).toHaveLength(0);

    const skipping = makeDeps();
    await exportPythonTypeStubs(skipping.deps, { silent: true, listCustomTypes: () => [] });
    expect(messages.info).toHaveLength(0);

    const writing = makeDeps();
    await exportPythonTypeStubs(writing.deps, { silent: true, listCustomTypes: () => SAMPLE_TYPES() });
    expect(writing.writes).toHaveLength(1);
    expect(messages.info).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });
});

describe('setupTypeStubRegeneration(types.xml watcher 自动重生成,def-pyi-stubs §4 二期)', () => {
  beforeEach(() => {
    messages.info.length = 0;
    messages.warning.length = 0;
    messages.error.length = 0;
    windowState.reset();
    workspaceState.reset();
    configurationOverrides.clear();
  });

  it('types.xml 增/改/删三事件都触发静默重导出,内容一致零写', () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    const writes: Array<{ path: string; content: string }> = [];
    // 有状态 deps:写入回灌 exists/readFile,零写臂才走得到
    const files = new Map<string, string>();
    const deps = {
      exists: (candidate: string): boolean => files.has(candidate),
      readFile: (path: string): string => files.get(path) ?? '',
      writeFile: (path: string, content: string): void => {
        files.set(path, content);
        writes.push({ path, content });
      },
      mkdir: (): void => undefined
    };

    const watcher = setupTypeStubRegeneration(
      context as never,
      deps,
      () => SAMPLE_TYPES()
    );

    watcher.fireChange({ fsPath: '/ws/scripts/entity_defs/types.xml' } as never);
    expect(writes).toHaveLength(1);

    // 内容一致:重复触发零写,零提示
    watcher.fireCreate({ fsPath: '/ws/scripts/entity_defs/types.xml' } as never);
    expect(writes).toHaveLength(1);
    expect(messages.info).toHaveLength(0);

    watcher.fireDelete({ fsPath: '/ws/scripts/entity_defs/types.xml' } as never);
    expect(writes).toHaveLength(1);
    stubWorkspace.workspaceFolders = [];
  });

  it('types.xml 删除后(自定义类型消失)不再重写旧桩', () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    let types = SAMPLE_TYPES();
    const { deps, writes } = makeDeps();

    const watcher = setupTypeStubRegeneration(context as never, deps, () => types);

    watcher.fireChange({ fsPath: '/ws/scripts/entity_defs/types.xml' } as never);
    expect(writes).toHaveLength(1);

    types = [];
    watcher.fireDelete({ fsPath: '/ws/scripts/entity_defs/types.xml' } as never);
    expect(writes).toHaveLength(1);
    expect(messages.info).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('watcher 挂进 context.subscriptions 随扩展注销销毁', () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const context = { subscriptions: [] as Array<{ dispose(): void }> };

    const watcher = setupTypeStubRegeneration(context as never, makeDeps().deps, () => SAMPLE_TYPES());

    expect(context.subscriptions).toContain(watcher);
    stubWorkspace.workspaceFolders = [];
  });
});

// 2026-10-30 用户令:FIXED_DICT(→TypedDict,运行时 dict 子类)属性的
// 子成员推断——字段读(types.xml 字段名)与字典方法(items/keys/values/get)
// 都应解析出 Python 注解;字段名优先于同名 dict 方法(values 即字段读)。
describe('resolveFixedDictMember(FIXED_DICT 子成员推断)', () => {
  it('字段读:直接命 types.xml 字段注解', () => {
    const hit = resolveFixedDictMember('AVATAR_INFO', 'level', false, SAMPLE_TYPES());
    expect(hit).toEqual({ annotation: 'int', kind: 'field' });
  });

  it('字典方法:items() 出 ItemsView[str, 值并]', () => {
    const hit = resolveFixedDictMember('AVATAR_INFO', 'items', true, SAMPLE_TYPES());
    expect(hit).toEqual({ annotation: 'ItemsView[str, str | int]', kind: 'method' });
  });

  it('字典方法:keys() 出 KeysView[str]', () => {
    const hit = resolveFixedDictMember('AVATAR_INFO', 'keys', true, SAMPLE_TYPES());
    expect(hit).toEqual({ annotation: 'KeysView[str]', kind: 'method' });
  });

  it('字典方法:values() 出 ValuesView[值并]', () => {
    const hit = resolveFixedDictMember('AVATAR_INFO', 'values', true, SAMPLE_TYPES());
    expect(hit).toEqual({ annotation: 'ValuesView[str | int]', kind: 'method' });
  });

  it('字典方法:get() 出 值并|None', () => {
    const hit = resolveFixedDictMember('AVATAR_INFO', 'get', true, SAMPLE_TYPES());
    expect(hit).toEqual({ annotation: 'str | int | None', kind: 'method' });
  });

  it('字段名优先于同名 dict 方法:REWARD_DICT.values 字段读', () => {
    const rewardDict = makeType({
      name: 'REWARD_DICT',
      aliasType: 'FIXED_DICT',
      rawValue: 'FIXED_DICT',
      properties: [{ name: 'values', typeName: 'UINT32' }]
    });
    // 字段读(非调用)与同名方法调用都归字段:字段优先
    expect(resolveFixedDictMember('REWARD_DICT', 'values', false, [rewardDict])).toEqual({
      annotation: 'int',
      kind: 'field'
    });
    expect(resolveFixedDictMember('REWARD_DICT', 'values', true, [rewardDict])).toEqual({
      annotation: 'int',
      kind: 'field'
    });
  });

  it('字段是 ARRAY:按 typeStructure 解析元素型', () => {
    const skillSlot = makeType({
      name: 'SKILL_SLOT',
      aliasType: 'FIXED_DICT',
      rawValue: 'FIXED_DICT',
      properties: [{ name: 'slot_list', typeName: 'ARRAY', typeStructure: { name: 'ARRAY', rawValue: 'ARRAY', children: [{ tag: 'of', value: { name: 'UINT32', rawValue: 'UINT32', children: [] } }] } }]
    });
    expect(resolveFixedDictMember('SKILL_SLOT', 'slot_list', false, [skillSlot])).toEqual({
      annotation: 'List[int]',
      kind: 'field'
    });
  });

  it('非 FIXED_DICT 根 → null(不接管)', () => {
    expect(resolveFixedDictMember('AVATAR_NAME', 'items', true, SAMPLE_TYPES())).toBeNull();
    expect(resolveFixedDictMember('AVATAR_INFO_LIST', 'items', true, SAMPLE_TYPES())).toBeNull();
  });

  it('未知成员 → null(落回根注解)', () => {
    expect(resolveFixedDictMember('AVATAR_INFO', 'unknown', false, SAMPLE_TYPES())).toBeNull();
    // 非调用也不是字段 → 非方法调用不接管
    expect(resolveFixedDictMember('AVATAR_INFO', 'items', false, SAMPLE_TYPES())).toBeNull();
  });

  it('空字段 FIXED_DICT:值并为 Any', () => {
    const empty = makeType({ name: 'EMPTY', aliasType: 'FIXED_DICT', rawValue: 'FIXED_DICT', properties: [] });
    expect(resolveFixedDictMember('EMPTY', 'items', true, [empty])).toEqual({
      annotation: 'ItemsView[str, Any]',
      kind: 'method'
    });
  });

  it('属性字段面向解析链(ARRAY 别名/内建/未知)同口径', () => {
    const types = SAMPLE_TYPES();
    const prop = { name: 'level', typeName: 'UINT32', line: 1 };
    expect(resolveCustomTypePropertyAnnotation(prop, types)).toBe('int');
    const arrayProp = { name: 'slots', typeName: 'ARRAY', line: 1 };
    expect(resolveCustomTypePropertyAnnotation(arrayProp, types)).toBe('List[Any]');
  });
});
