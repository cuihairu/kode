import { beforeEach, describe, expect, it } from 'vitest';
import {
  PYTHON_BUILTIN_TYPE_ANNOTATIONS,
  PYTHON_TYPE_STUB_FALLBACK,
  PYTHON_TYPE_STUB_FILE_NAME,
  buildPythonTypeStubContent,
  buildPythonTypeStubPlan,
  exportPythonTypeStubs,
  kbeTypeStubFilePath,
  setupTypeStubRegeneration
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
// Python 类型桩模块 kbe_types.py(方案 A:真 .py,TypedDict/type alias 运行时
// 可用),与 KBEngine.pyi 同居 stubDir 三级解析目录,复用 kbengine.python.
// stubExport 开关与「内容一致零写」纪律;extraPaths 管理段同盘并入。

interface TypeScript {
  name: string;
  aliasType: string;
  rawValue?: string;
  of?: string;
  properties?: Array<{ name: string; typeName?: string }>;
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
    filePath: '/ws/scripts/entity_defs/types.xml',
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
    properties: (script.properties ?? []).map(property => ({ name: property.name, typeName: property.typeName }))
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
      sourceLine: 1
    });
  });

  it('别名到内置类型发赋值语句', () => {
    const plan = buildPythonTypeStubPlan([SAMPLE_TYPES()[2]]);

    expect(plan.entries[0]).toEqual({
      annotation: 'str',
      kind: 'alias',
      name: 'AVATAR_NAME',
      sourceLine: 1
    });
    expect(plan.content).toContain('AVATAR_NAME = str');
  });

  it('类在先、别名链拓扑序:A=STRING → B=A → C=B,输入乱序也按依赖序出', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'C', aliasType: 'B', rawValue: 'B' }),
      makeType({ name: 'B', aliasType: 'A', rawValue: 'A' }),
      makeType({ name: 'A', aliasType: 'STRING', rawValue: 'STRING' })
    ]);

    const names = plan.entries.map(entry => entry.name);
    expect(names.indexOf('A')).toBeLessThan(names.indexOf('B'));
    expect(names.indexOf('B')).toBeLessThan(names.indexOf('C'));
    expect(plan.content).toContain('A = str');
    expect(plan.content).toContain('B = A');
    expect(plan.content).toContain('C = B');
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
      sourceLine: 1
    });
  });

  it('名字序在前的别名依赖名字序在后的:多轮迭代也能排完,依赖先出', () => {
    const plan = buildPythonTypeStubPlan([
      makeType({ name: 'ALIAS_B', aliasType: 'ZTARGET', rawValue: 'ZTARGET' }),
      makeType({ name: 'ZTARGET', aliasType: 'STRING', rawValue: 'STRING' })
    ]);

    const names = plan.entries.map(entry => entry.name);
    expect(names).toEqual(['ZTARGET', 'ALIAS_B']);
    expect(plan.content).toContain('ZTARGET = str');
    expect(plan.content).toContain('ALIAS_B = ZTARGET');
  });

  it('零自定义类型/全跳过时 content 为 null(不生成文件)', () => {
    expect(buildPythonTypeStubPlan([]).content).toBeNull();
    expect(buildPythonTypeStubPlan([SAMPLE_TYPES()[2]]).content).not.toBeNull();
  });

  it('内容确定:同一输入两次构建逐字节一致(零写语义的前提)', () => {
    const first = buildPythonTypeStubPlan(SAMPLE_TYPES()).content;
    const second = buildPythonTypeStubPlan(SAMPLE_TYPES()).content;
    expect(first).toBe(second);
  });

  it('头部带生成物声明与 gitignore 建议,future annotations + typing 导入', () => {
    const content = buildPythonTypeStubPlan(SAMPLE_TYPES()).content ?? '';

    expect(content).toContain('from __future__ import annotations');
    expect(content).toContain('from typing import Any, Dict, List, Tuple, TypedDict');
    expect(content).toContain('.gitignore');
    expect(content).toContain('.kbengine/stubs');
  });
});

describe('buildPythonTypeStubContent(空表)', () => {
  it('空条目直接 null', () => {
    expect(buildPythonTypeStubContent([])).toBeNull();
  });
});

describe('kbeTypeStubFilePath', () => {
  it('默认约定目录下的 kbe_types.py', () => {
    expect(kbeTypeStubFilePath('/ws')).toBe('/ws/.kbengine/stubs/kbe_types.py');
    expect(PYTHON_TYPE_STUB_FILE_NAME).toBe('kbe_types.py');
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

  it('首 导出到默认约定目录:建目录写 kbe_types.py,播报文件夹', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes, mkdirs } = makeDeps();

    const written = await exportPythonTypeStubs(deps, { listCustomTypes: () => SAMPLE_TYPES() });

    expect(written).toEqual(['ws']);
    expect(mkdirs).toEqual(['/ws/.kbengine/stubs']);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/ws/.kbengine/stubs/kbe_types.py');
    expect(writes[0].content).toBe(buildPythonTypeStubPlan(SAMPLE_TYPES()).content);
    expect(messages.info[0]).toContain('ws');
    expect(messages.info[0]).toContain('kbe_types.py');
  });

  it('内容一致时零写零提示;陈旧时重写;读不到按陈旧重写', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const content = buildPythonTypeStubPlan(SAMPLE_TYPES()).content ?? '';

    const unchanged = makeDeps({
      existing: [kbeTypeStubFilePath('/ws')],
      initial: { [kbeTypeStubFilePath('/ws')]: content }
    });
    await exportPythonTypeStubs(unchanged.deps, { listCustomTypes: () => SAMPLE_TYPES() });
    expect(unchanged.writes).toHaveLength(0);
    expect(messages.info).toHaveLength(0);

    const stale = makeDeps({
      existing: [kbeTypeStubFilePath('/ws')],
      initial: { [kbeTypeStubFilePath('/ws')]: '# 旧版本' }
    });
    await exportPythonTypeStubs(stale.deps, { listCustomTypes: () => SAMPLE_TYPES() });
    expect(stale.writes).toHaveLength(1);
    expect(stale.writes[0].content).toBe(content);

    const unreadable = makeDeps({
      existing: [kbeTypeStubFilePath('/ws')],
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

  it('用户配置目录:已有 kbe_types.py 按用户资产跳过;没有才生成', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': '/user-stubs' });
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const owned = makeDeps({ existing: ['/user-stubs/kbe_types.py'] });

    await exportPythonTypeStubs(owned.deps, { listCustomTypes: () => SAMPLE_TYPES() });

    expect(owned.writes).toHaveLength(0);
    expect(messages.info.some(message => message.includes('按用户资产不覆盖'))).toBe(true);

    const free = makeDeps();
    await exportPythonTypeStubs(free.deps, { listCustomTypes: () => SAMPLE_TYPES() });
    expect(free.writes).toHaveLength(1);
    expect(free.writes[0].path).toBe('/user-stubs/kbe_types.py');
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
      exists: (candidate: string): boolean => false,
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
    expect(writes[0].path).toBe('/good/.kbengine/stubs/kbe_types.py');
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
