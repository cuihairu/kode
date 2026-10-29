/**
 * types.xml 自定义类型 → Python 类型桩(docs/design/def-pyi-stubs.md §6):
 * 把 entity_defs/types.xml 里的自定义类型(utype)按「文件分件」发射成
 * `<typings 根>/<scripts 镜像相对目录>/kbe_types.pyi`。
 *
 * 产物形态(B 单,2026-10-21):纯 .pyi 声明桩,镜像 scripts 树逐 types.xml
 * 出一份,收在 kode 自管的独立 typings 根(默认 .kbengine/stubs,照常走
 * stubDir 三级解析)。T-04 取舍:不做 types.xml 同目录同名 sidecar——
 * types.pyi 落回工程 scripts 树会把生成物混进用户资产树,还有 .pyi 遮蔽
 * 用户 .py 的红线风险沿目录扩散;改走「镜像树 + 独立根」,与 kbengine 仓
 * typings/ 的分层形态同构。旧版单文件 kbe_types.py 的 extraPaths 并入判定
 * 保留(typeStubArtifactExists),迁移期残留也能接上。
 *
 * 映射口径:FIXED_DICT → TypedDict(属性按 types.xml 文档序);别名
 * (<Type 别名=底层/>)逐层解析到引擎注册的内建类型再映射 Python 类型。
 * 注册名以 kbe/src/lib/entitydef/datatypes.cpp DataTypes::initialize 的
 * addDataType 注册面为准,映射值沿用 PYTHON_BUILTIN_TYPE_ANNOTATIONS
 * (整型族→int、FLOAT/DOUBLE→float、STRING/UNICODE→str、BLOB→bytes、
 * VECTOR2/3/4→定长 Tuple、PYTHON 系与 ENTITYCALL→Any 族),不自创条目。
 * 循环别名保留环检测,整链跳过;任何发射出去的声明名必须已解析或在本文件
 * 已定义,禁止裸名悬挂。内容确定性优先:头部不带时间戳,同输入逐字节同
 * 输出,才撑得起与 KBEngine.pyi 同一套「内容一致零写」纪律。
 */

import * as vscode from 'vscode';
import {
  getCustomTypeInfos,
  type CustomTypeInfo,
  type CustomTypePropertyInfo,
  type CustomTypeStructureNode
} from './definitionWorkspace';
import {
  PYTHON_STUB_EXPORT_ENABLED_DEFAULT,
  fileSystemStubExportDeps,
  kbeStubDir,
  MANAGED_DIR_DEFAULT,
  readManagedDirSetting,
  readStubDirSetting,
  resolveManagedDirName,
  resolveStubDir,
  type StubExportDeps
} from './pythonStubExport';

export const PYTHON_TYPE_STUB_FILE_NAME = 'kbe_types.pyi';

/** 旧版单文件产物名(B 单前);extraPaths 接线对盘上残留保持并入(迁移期) */
export const PYTHON_TYPE_STUB_LEGACY_FILE_NAME = 'kbe_types.py';

/**
 * KBEngine API 桩里的引擎级类型别名(docs/design/def-pyi-stubs.md 与引擎
 * typings 同源)。types.xml 属性引用它们时按名透传,并在头部从 KBEngine 导入;
 * 其余未知名字仍兜底成 Any,避免发射无出处的引用。
 */
const KBENGINE_TYPE_ALIASES = new Set(['Address', 'WatcherValue']);

/**
 * KBEngine 内置类型 → Python 注解。与 clientSdkGenerator 的 TS_BUILTIN_TYPES
 * 同一张语义表的 Python 面,注册名对齐 datatypes.cpp 的 addDataType 注册面:
 * 整型归 int、浮点归 float、字符串归 str;PY_DICT/PY_TUPLE/PY_LIST 用 typing
 * 泛型(py3.7 安全,future-annotations 帮不到模块级赋值);引擎侧无对应物的
 * ENTITYCALL 与 PYTHON(PythonType = 任意可 pickle 对象,datatype.h:528)归 Any。
 */
export const PYTHON_BUILTIN_TYPE_ANNOTATIONS: Record<string, string> = {
  UINT8: 'int',
  UINT16: 'int',
  UINT32: 'int',
  UINT64: 'int',
  INT8: 'int',
  INT16: 'int',
  INT32: 'int',
  INT64: 'int',
  FLOAT: 'float',
  DOUBLE: 'float',
  STRING: 'str',
  UNICODE: 'str',
  BOOL: 'bool',
  VECTOR2: 'Tuple[float, float]',
  VECTOR3: 'Tuple[float, float, float]',
  VECTOR4: 'Tuple[float, float, float, float]',
  ENTITYCALL: 'Any',
  PYTHON: 'Any',
  PY_DICT: 'Dict[Any, Any]',
  PY_TUPLE: 'Tuple[Any, ...]',
  PY_LIST: 'List[Any]',
  BLOB: 'bytes'
};

/** 未识别类型的兜底注解(有损但合法,分析 §2 口径) */
export const PYTHON_TYPE_STUB_FALLBACK = 'Any';

export interface PythonTypeStubClassEntry {
  kind: 'class';
  name: string;
  properties: Array<{ name: string; annotation: string }>;
  /** FIXED_DICT 类型节点声明行(1 起);测试注入缺源时为 null */
  sourceLine?: number | null;
  /** 源文件标签(types.xml / alias.xml);合并分件逐条可分 */
  sourceFile?: string;
  /** 属性名 → 属性行或内联 <Type> 行(1 起) */
  propertySourceLines?: Record<string, number | null>;
}

export interface PythonTypeStubAliasEntry {
  kind: 'alias';
  name: string;
  annotation: string;
  /** 别名节点声明行(1 起);测试注入缺源时为 null */
  sourceLine?: number | null;
  /** 源文件标签(types.xml / alias.xml);合并分件逐条可分 */
  sourceFile?: string;
}

export type PythonTypeStubEntry = PythonTypeStubClassEntry | PythonTypeStubAliasEntry;

export interface PythonTypeStubSkipped {
  name: string;
  reason: string;
}

export interface PythonTypeStubPlan {
  /** 可直接落盘的模块全文;零条目可发射时为 null(不生成文件) */
  content: string | null;
  entries: PythonTypeStubEntry[];
  skipped: PythonTypeStubSkipped[];
}

function joinPath(...segments: string[]): string {
  return segments.join('/').replace(/\\/g, '/');
}

/** 类型桩约定路径:typings 根(kode 自管默认目录)下的根级分件(fallback 布局) */
export function kbeTypeStubFilePath(
  workspaceRoot: string,
  managedDirName: string = MANAGED_DIR_DEFAULT
): string {
  return joinPath(kbeStubDir(workspaceRoot, managedDirName), PYTHON_TYPE_STUB_FILE_NAME);
}

/**
 * 默认布局(scripts/entity_defs/types.xml)下分件镜像的约定落点;extraPaths
 * 接线用它探测「类型桩分件已在盘」。
 */
function kbeTypeStubMirrorFilePath(
  workspaceRoot: string,
  managedDirName: string = MANAGED_DIR_DEFAULT
): string {
  return joinPath(kbeStubDir(workspaceRoot, managedDirName), 'scripts', 'entity_defs', PYTHON_TYPE_STUB_FILE_NAME);
}

/**
 * types.xml 是否已有类型桩产物在盘(新旧两种落点都认)。extraPaths 接线的
 * 「目录并入」判定用:旧版单文件 kbe_types.py 残留同样算数,迁移期不断线。
 * managedDirName 缺省走默认 .kbengine;装配层传配置值(kbengine.managedDir)。
 */
export function typeStubArtifactExists(
  deps: Pick<StubExportDeps, 'exists'>,
  workspaceRoot: string,
  managedDirName: string = MANAGED_DIR_DEFAULT
): boolean {
  return (
    deps.exists(kbeTypeStubFilePath(workspaceRoot, managedDirName)) ||
    deps.exists(kbeTypeStubMirrorFilePath(workspaceRoot, managedDirName)) ||
    deps.exists(joinPath(kbeStubDir(workspaceRoot, managedDirName), PYTHON_TYPE_STUB_LEGACY_FILE_NAME))
  );
}

/**
 * 分件镜像相对目录(T-04):types.xml 在工作区树里的目录原样镜像进 typings
 * 根(如 /ws/scripts/entity_defs/types.xml → typings 根下 scripts/entity_defs/
 * kbe_types.pyi);工作区外但带 /scripts/ 段的从该段起镜像;都认不出返回
 * null(退回 typings 根根级单文件)。不做同目录同名 sidecar。
 */
export function typeStubMirrorRelativeDir(
  typesXmlPath: string,
  workspaceRoot: string
): string | null {
  const normalize = (value: string): string => value.replace(/\\/g, '/');
  const file = normalize(typesXmlPath);
  const dir = file.slice(0, Math.max(file.lastIndexOf('/'), 0));
  const root = normalize(workspaceRoot).replace(/\/+$/, '');
  if (root.length > 0 && (dir + '/').startsWith(root + '/')) {
    const relative = dir.slice(root.length).replace(/^\/+/, '');
    return relative.length > 0 ? relative : null;
  }
  const scriptsIndex = dir.indexOf('/scripts/');
  if (scriptsIndex >= 0) {
    return dir.slice(scriptsIndex + 1);
  }
  return null;
}

/**
 * 按分件镜像目录分组(= kbe_types.pyi 模块身份,用户令 2026-10-27 pyi ④):
 * 同目录的 types.xml 与 alias.xml 落同一个镜像 kbe_types.pyi——按源文件各写
 * 一份会互相覆盖(落点相同),且互相引用的名字各查各表解析不到。键为镜像
 * 相对目录('' = 根级);Map 保序,顺序随输入,确定性。
 */
export function groupCustomTypesByModule(
  customTypes: readonly CustomTypeInfo[],
  workspaceRoot: string | undefined
): Map<string, CustomTypeInfo[]> {
  const groups = new Map<string, CustomTypeInfo[]>();
  for (const info of customTypes) {
    const key = workspaceRoot
      ? typeStubMirrorRelativeDir(info.filePath, workspaceRoot) ?? ''
      : '';
    const group = groups.get(key);
    if (group) {
      group.push(info);
    } else {
      groups.set(key, [info]);
    }
  }
  return groups;
}

/** 镜像目录键 → 点分模块路径('' → 根级 kbe_types),与 entity 侧导入口径同源 */
export function kbeTypesModuleOfKey(moduleKey: string): string {
  return moduleKey === '' ? 'kbe_types' : `${moduleKey.replace(/\//g, '.')}.kbe_types`;
}

/** 源文件标签(types.xml / alias.xml):合并分件里两种来源逐条可分 */
function sourceLabelOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base === '' ? 'types.xml' : base;
}

/** 别名解析失败(指引为空/成环/上游被跳过)的内部信号,reason 可直接入 skipped */
class AliasResolutionError extends Error {
  constructor(
    readonly sourceName: string,
    readonly reason: string
  ) {
    super(reason);
  }
}

const EMPTY_GUIDANCE_REASON = 'types.xml 指引为空,无法解析目标类型';
const CYCLE_REASON = '别名链成环,无法排出依赖序,整链跳过';

interface ResolutionContext {
  /** 全部自定义类型名 → 定义(解析目标) */
  byName: ReadonlyMap<string, CustomTypeInfo>;
  /** 别名解析中的名字栈(环检测) */
  resolving: Set<string>;
  /** 被跳过的名字 → 原因(下游级联与类体兜底都读它) */
  poisoned: Map<string, string>;
  /** 跨模块引用面:其他 kbe_types 模块已发射的名字 → 模块路径 */
  externalModules?: ReadonlyMap<string, string>;
  /** 本次解析实际引用到的跨模块名(名 → 模块路径),头部导入面 */
  referencedExternals: Map<string, string>;
}

/**
 * 单个类型名 → Python 注解(属性面/别名指引共用)。别名逐层下钻,直到落到
 * 内建表、TypedDict 类名或引擎类型别名;认不出的落 Any,绝不裸名悬挂。
 */
function resolveTypeName(typeName: string, context: ResolutionContext): string {
  const trimmed = typeName.trim();
  if (trimmed.length === 0 || trimmed === 'ALIAS') {
    // 空指引或「未解析」占位不该被当类型名发射
    return PYTHON_TYPE_STUB_FALLBACK;
  }
  const builtin = PYTHON_BUILTIN_TYPE_ANNOTATIONS[trimmed];
  if (builtin !== undefined) {
    return builtin;
  }
  const info = context.byName.get(trimmed);
  if (info !== undefined) {
    if (info.aliasType === 'FIXED_DICT') {
      // 类定义在本文件先于别名发射,引用类名不算悬挂
      return trimmed;
    }
    // 别名(含 ARRAY)统一走 resolveAliasInfo:环检测与级联跳过都在那层
    return resolveAliasInfo(info, context);
  }
  if (KBENGINE_TYPE_ALIASES.has(trimmed)) {
    return trimmed;
  }
  const external = context.externalModules?.get(trimmed);
  if (external !== undefined) {
    // 跨模块引用(pyi ④):别的 kbe_types 分件已发射这个名字——按名引用,
    // 头部补 import,绝不因「不在本文件」就落 Any
    context.referencedExternals.set(trimmed, external);
    return trimmed;
  }
  return PYTHON_TYPE_STUB_FALLBACK;
}

/** 数组结构的元素注解:of 套 of 递归成 List[List[...]],缺 of 落 List[Any] */
function resolveStructureElement(
  node: CustomTypeStructureNode,
  context: ResolutionContext
): string {
  if (node.name === 'ARRAY') {
    const ofChild = node.children.find(child => child.tag === 'of');
    if (!ofChild) {
      // 裸 ARRAY(缺 <of>):还是数组,只是元素型有损落 Any
      return `List[${PYTHON_TYPE_STUB_FALLBACK}]`;
    }
    return `List[${resolveStructureElement(ofChild.value, context)}]`;
  }
  return resolveTypeName(node.name, context);
}

/**
 * 别名条目解析:逐层下钻到底层类型;成环/指引为空把本名记入 poisoned 后
 * 抛出,引用方沿调用链逐层记「连带跳过」——整链绝不发射悬挂赋值。
 */
function resolveAliasInfo(info: CustomTypeInfo, context: ResolutionContext): string {
  const poisoned = context.poisoned.get(info.name);
  if (poisoned !== undefined) {
    throw new AliasResolutionError(info.name, poisoned);
  }
  if (context.resolving.has(info.name)) {
    if (!context.poisoned.has(info.name)) {
      context.poisoned.set(info.name, CYCLE_REASON);
    }
    throw new AliasResolutionError(info.name, CYCLE_REASON);
  }
  context.resolving.add(info.name);
  try {
    if (info.aliasType === 'ARRAY') {
      // structure 顶层节点就是 ARRAY,resolveStructureElement 自己包 List
      return resolveStructureElement(info.structure, context);
    }
    if (info.aliasType === 'ALIAS') {
      throw new AliasResolutionError(info.name, EMPTY_GUIDANCE_REASON);
    }
    return resolveTypeName(info.aliasType, context);
  } catch (error) {
    if (error instanceof AliasResolutionError && !context.poisoned.has(info.name)) {
      const reason =
        error.sourceName === info.name
          ? error.reason
          : `依赖的类型 ${error.sourceName} 未能解析,连带跳过`;
      context.poisoned.set(info.name, reason);
    }
    throw error;
  } finally {
    context.resolving.delete(info.name);
  }
}

/** FIXED_DICT 属性注解:别名也解析到底;引用被跳过的别名落 Any 不裸挂 */
function propertyAnnotation(property: CustomTypePropertyInfo, context: ResolutionContext): string {
  const typeName = property.typeName?.trim();
  if (typeName === undefined || typeName.length === 0) {
    return PYTHON_TYPE_STUB_FALLBACK;
  }
  if (typeName === 'ARRAY') {
    // 属性面内联数组(<Type>ARRAY<of>X</of></Type>):元素型按属性结构树解析
    // (definitionWorkspace.parseCustomTypeProperties 产出,与类型条目顶层
    // 同源);树缺失/解析失败才有损落 List[Any](2026-10-29 用户报收口)
    if (property.typeStructure) {
      try {
        return resolveStructureElement(property.typeStructure, context);
      } catch {
        return `List[${PYTHON_TYPE_STUB_FALLBACK}]`;
      }
    }
    return `List[${PYTHON_TYPE_STUB_FALLBACK}]`;
  }
  try {
    return resolveTypeName(typeName, context);
  } catch {
    return PYTHON_TYPE_STUB_FALLBACK;
  }
}

/**
 * 统一解析底座(用户令 2026-10-21):单个类型名 → Python 注解,hover 签名、
 * 补全 detail 与 entity_types.pyi 方法面共用同一条链——a) 内建直查
 * PYTHON_BUILTIN_TYPE_ANNOTATIONS;b) types.xml/alias.xml 自定义类型注册表
 * 逐层下钻(复用上方 resolveTypeName/resolveAliasInfo 的别名链与环检测,
 * 禁第二套);c) 链断/成环/仍未知落 Any,绝不硬造。纯逻辑无缓存:注册表
 * 由调用方(definitionWorkspace.resolveEntityAnnotationType)按工作区供给。
 */
export function resolveAnnotationTypeWithRegistry(
  raw: string,
  customTypes: readonly CustomTypeInfo[]
): string {
  const sorted = [...customTypes].sort((left, right) => left.name.localeCompare(right.name));
  const context: ResolutionContext = {
    byName: new Map(sorted.map(info => [info.name, info])),
    resolving: new Set(),
    poisoned: new Map(),
    referencedExternals: new Map()
  };
  try {
    return resolveTypeName(raw.trim(), context);
  } catch {
    // 成环/指引为空已按 B 单口径记 poisoned,这里统一回落 Any
    return PYTHON_TYPE_STUB_FALLBACK;
  }
}

export interface PythonTypeStubPlanOptions {
  /** 其他 kbe_types 分件已发射的名字 → 模块路径(跨模块引用面) */
  externalModules?: ReadonlyMap<string, string>;
}

export function buildPythonTypeStubPlan(
  customTypes: readonly CustomTypeInfo[],
  options: PythonTypeStubPlanOptions = {}
): PythonTypeStubPlan {
  // 同名去重(引擎口径,datatypes.cpp addDataType 对重复名报错并拒注册):
  // types.xml 先注册、alias.xml 后到,同名后到整条作废;两类之内先见优先。
  const ordered = [...customTypes].sort((left, right) => {
    const leftAlias = left.filePath.endsWith('alias.xml') ? 1 : 0;
    const rightAlias = right.filePath.endsWith('alias.xml') ? 1 : 0;
    return leftAlias - rightAlias || left.name.localeCompare(right.name);
  });
  const kept = new Map<string, CustomTypeInfo>();
  const duplicateSkipped: PythonTypeStubSkipped[] = [];
  for (const info of ordered) {
    const winner = kept.get(info.name);
    if (winner === undefined) {
      kept.set(info.name, info);
      continue;
    }
    duplicateSkipped.push({
      name: info.name,
      reason: `与 ${sourceLabelOf(winner.filePath)}:${winner.line} 同名,引擎 addDataType 拒绝重复注册,后到不发射`
    });
  }
  const sorted = ordered.filter(info => kept.get(info.name) === info)
    .sort((left, right) => left.name.localeCompare(right.name));
  const context: ResolutionContext = {
    byName: kept,
    resolving: new Set(),
    poisoned: new Map(),
    externalModules: options.externalModules,
    referencedExternals: new Map()
  };

  // 先解析别名条目:poison 表记全(成环/指引为空/级联),类体随后引用兜底。
  // 别名注解解析后只含内建/typing/类名/引擎别名,不再互相引用,发射按名字序
  // 即可,输出与输入顺序无关。
  const aliases: PythonTypeStubAliasEntry[] = [];
  for (const info of sorted) {
    if (info.aliasType === 'FIXED_DICT') {
      continue;
    }
    try {
      aliases.push({
        kind: 'alias',
        name: info.name,
        annotation: resolveAliasInfo(info, context),
        sourceLine: info.line,
        sourceFile: sourceLabelOf(info.filePath)
      });
    } catch {
      // 失败已记入 poisoned,不发射该条
    }
  }
  aliases.sort((left, right) => left.name.localeCompare(right.name));

  const classes: PythonTypeStubClassEntry[] = [];
  for (const info of sorted) {
    if (info.aliasType !== 'FIXED_DICT') {
      continue;
    }
    classes.push({
      kind: 'class',
      name: info.name,
      properties: info.properties.map(property => ({
        name: property.name,
        annotation: propertyAnnotation(property, context)
      })),
      sourceLine: info.line,
      sourceFile: sourceLabelOf(info.filePath),
      propertySourceLines: Object.fromEntries(info.properties.map(property => {
        const sourceLine = property.typeLine ?? property.line;
        return [property.name, sourceLine === undefined ? null : sourceLine];
      }))
    });
  }

  const entries: PythonTypeStubEntry[] = [...classes, ...aliases];
  const skipped: PythonTypeStubSkipped[] = [
    ...[...duplicateSkipped].map(item => ({ ...item })),
    ...[...context.poisoned.entries()].map(([name, reason]) => ({ name, reason }))
  ].sort((left, right) => left.name.localeCompare(right.name));
  return {
    content: buildPythonTypeStubContent(entries, context.referencedExternals),
    entries,
    skipped
  };
}

/**
 * 模块全文:头部声明生成物身份与 gitignore 建议(确定性,无时间戳),
 * 类体在先、别名赋值随后(已全部解析到底,按名字序)。零条目返回 null。
 */
export function buildPythonTypeStubContent(
  entries: readonly PythonTypeStubEntry[],
  externalImports: ReadonlyMap<string, string> = new Map()
): string | null {
  if (entries.length === 0) {
    return null;
  }
  const lines = [
    '# KBE types.xml 自定义类型 → Python 类型桩(由 kode 扩展的',
    '# kbengine.python.exportTypeStubs 生成)。手工修改会在下次生成时被覆盖;',
    '# 默认目录 .kbengine/stubs 是 kode 管理目录,建议把 .kbengine/ 加入',
    '# .gitignore(生成物不入库)。用户自配目录里的同名文件按用户资产不动。',
    'from __future__ import annotations',
    '',
    'from typing import Any, Callable, Dict, List, Tuple, TypedDict, Union'
  ];
  lines.push('import KBEngine');
  lines.push('from KBEngine import Entity');
  const referencedEngineAliases = new Set<string>();
  const collectEngineAliases = (annotation: string): void => {
    for (const alias of KBENGINE_TYPE_ALIASES) {
      if (new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(annotation)) {
        referencedEngineAliases.add(alias);
      }
    }
  };
  for (const entry of entries) {
    if (entry.kind === 'class') {
      for (const property of entry.properties) {
        collectEngineAliases(property.annotation);
      }
    } else {
      collectEngineAliases(entry.annotation);
    }
  }
  if (referencedEngineAliases.size > 0) {
    lines.push(`from KBEngine import ${[...referencedEngineAliases].sort().join(', ')}`);
  }
  // 跨模块引用面(pyi ④):注解引用了别的 kbe_types 分件发射的名字时按
  // 模块逐组导入,同目录合并件(types.xml+alias.xml)不在此列——同件引用。
  if (externalImports.size > 0) {
    const byModule = new Map<string, string[]>();
    for (const [name, modulePath] of externalImports) {
      const list = byModule.get(modulePath) ?? [];
      list.push(name);
      byModule.set(modulePath, list);
    }
    for (const [modulePath, names] of [...byModule.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))) {
      lines.push(`from ${modulePath} import ${[...names].sort().join(', ')}`);
    }
  }
  for (const entry of entries) {
    lines.push('', '');
    if (entry.kind === 'class') {
      lines.push(`# source: ${entry.sourceFile ?? 'types.xml'}:${entry.sourceLine ?? 'unknown'}`);
      lines.push(`class ${entry.name}(TypedDict):`);
      if (entry.properties.length === 0) {
        lines.push('    pass');
      } else {
        for (const property of entry.properties) {
          const sourceLine = entry.propertySourceLines?.[property.name];
          lines.push(`    # source: ${entry.sourceFile ?? 'types.xml'}:${sourceLine ?? 'unknown'}`);
          lines.push(`    ${property.name}: ${property.annotation}`);
        }
      }
    } else {
      lines.push(`# source: ${entry.sourceFile ?? 'types.xml'}:${entry.sourceLine ?? 'unknown'}`);
      lines.push(`${entry.name} = ${entry.annotation}`);
      }
  }
  lines.push('');
  return lines.join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface PythonTypeStubExportOptions {
  /** 激活期自动导出传 true:全程零提示;命令面板手动导出保持播报 */
  silent?: boolean;
  /** 自定义类型来源(测试注入;装配层为 definitionWorkspace.getCustomTypeInfos) */
  listCustomTypes?: (workspaceRoot: string) => CustomTypeInfo[];
}

/**
 * 逐工作区把 types.xml 自定义类型导出为 kbe_types.pyi(B 单:按镜像目录
 * 分件,同目录 types.xml/alias.xml 合并成同一模块,镜像 scripts 树收独立
 * typings 根,T-04 不做同目录 sidecar),与 exportKbeStubs 同一套纪律:共用
 * kbengine.python.stubExport 开关;无自定义类型不生成;用户配置目录已有同名
 * 文件按用户资产跳过;默认目录内容一致零写、陈旧重写;目录不可写告警并继续
 * 其余文件夹。返回实际写入的文件夹名列表。
 */
export async function exportPythonTypeStubs(
  deps: StubExportDeps = fileSystemStubExportDeps,
  options: PythonTypeStubExportOptions = {}
): Promise<string[]> {
  const enabled = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('python.stubExport', PYTHON_STUB_EXPORT_ENABLED_DEFAULT);
  if (!enabled) {
    if (!options.silent) {
      await vscode.window.showInformationMessage(
        'KBEngine 类型桩导出已关闭(kbengine.python.stubExport,与 KBEngine.pyi 存根共用开关)'
      );
    }
    return [];
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    if (!options.silent) {
      await vscode.window.showInformationMessage('未打开工作区,跳过 KBEngine 类型桩导出');
    }
    return [];
  }
  const listCustomTypes = options.listCustomTypes ?? getCustomTypeInfos;
  const written: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const folder of folders) {
    const customTypes = listCustomTypes(folder.uri.fsPath);
    if (customTypes.length === 0) {
      skipped.push(`${folder.name}(无自定义类型(types.xml),无需类型桩)`);
      continue;
    }
    const resolved = resolveStubDir(folder.uri.fsPath, {
      setting: readStubDirSetting(),
      managedDir: resolveManagedDirName(readManagedDirSetting()).name,
      folders: [{ fsPath: folder.uri.fsPath, name: folder.name }],
      filePath: vscode.window.activeTextEditor?.document.fileName
    });
    let folderWritten = false;
    let folderFailed = false;
    // 两遍解析(pyi ④):先按镜像目录分组建各模块计划拿发射名,再把「别的
    // 模块已发射的名字」配成跨模块引用面重解析——引用只改头部导入,不改
    // 条目面,两遍 entries 恒一致。
    const moduleGroups = groupCustomTypesByModule(customTypes, folder.uri.fsPath);
    const firstPass = new Map<string, PythonTypeStubPlan>();
    for (const [moduleKey, group] of moduleGroups) {
      firstPass.set(moduleKey, buildPythonTypeStubPlan(group));
    }
    const emittedOwner = new Map<string, string>();
    for (const [moduleKey, plan] of firstPass) {
      for (const entry of plan.entries) {
        if (!emittedOwner.has(entry.name)) {
          emittedOwner.set(entry.name, moduleKey);
        }
      }
    }
    for (const [moduleKey, basePlan] of firstPass) {
      const externalModules = new Map<string, string>();
      for (const [name, ownerKey] of emittedOwner) {
        if (ownerKey !== moduleKey) {
          externalModules.set(name, kbeTypesModuleOfKey(ownerKey));
        }
      }
      const plan = externalModules.size > 0
        ? buildPythonTypeStubPlan(moduleGroups.get(moduleKey)!, { externalModules })
        : basePlan;
      // 该模块全被跳过(成环/指引为空)不落文件
      if (plan.content === null) {
        continue;
      }
      const target =
        moduleKey === ''
          ? joinPath(resolved.dir, PYTHON_TYPE_STUB_FILE_NAME)
          : joinPath(resolved.dir, moduleKey, PYTHON_TYPE_STUB_FILE_NAME);
      // 用户指定目录是用户资产:目标文件已在就不碰;默认目录归 kode 自管,
      // 走内容比对。
      if (resolved.userOwned && deps.exists(target)) {
        skipped.push(`${folder.name}(${target} 已存在,按用户资产不覆盖)`);
        continue;
      }
      // 一致性比对段防御:存在性判定/读取抛错(权限等)按陈旧处理触发重写
      let unchanged = false;
      try {
        unchanged = deps.exists(target) && deps.readFile(target) === plan.content;
      } catch {
        unchanged = false;
      }
      if (unchanged) {
        continue;
      }
      try {
        deps.mkdir(moduleKey === '' ? resolved.dir : joinPath(resolved.dir, moduleKey));
        deps.writeFile(target, plan.content);
        folderWritten = true;
      } catch {
        // 目录不可写(只读挂载/权限):如实告警,不挡其余文件与文件夹
        folderFailed = true;
      }
    }
    if (folderWritten) {
      written.push(folder.name);
    }
    if (folderFailed) {
      failed.push(folder.name);
    }
  }
  if (skipped.length > 0 && !options.silent) {
    await vscode.window.showInformationMessage(`KBEngine 类型桩导出已跳过:${skipped.join(';')}`);
  }
  if (failed.length > 0 && !options.silent) {
    await vscode.window.showWarningMessage(
      `KBEngine 类型桩导出失败(目录不可写?): ${failed.join('、')}`
    );
  }
  if (written.length > 0 && !options.silent) {
    await vscode.window.showInformationMessage(
      `已为 ${written.join('、')} 导出 kbe_types.pyi 类型桩(按镜像目录分件,同目录 types.xml/alias.xml 合并,FIXED_DICT→TypedDict、别名解析到内建再映射,配合 extraPaths 接线供 Python 扩展解析)`
    );
  }
  return written;
}

/**
 * types.xml watcher 自动重生成(def-pyi-stubs §4 二期):保存/新建/删除
 * types.xml 后静默重导出 .pyi 分件。不设去抖、不加开关——导出函数自带
 * `kbengine.python.stubExport` 门(关掉即停),内容确定性与零写纪律保证
 * 重复触发无副作用;快照每次直读磁盘,事件到达即读到新内容,无缓存竞态。
 * watcher 只盯 types.xml:kbe_types.pyi 的内容来源仅此一类文件,写自己的
 * 生成物不会反触发自己。
 */
export function setupTypeStubRegeneration(
  context: vscode.ExtensionContext,
  deps: StubExportDeps = fileSystemStubExportDeps,
  listCustomTypes?: (workspaceRoot: string) => CustomTypeInfo[]
): vscode.FileSystemWatcher {
  const watcher = vscode.workspace.createFileSystemWatcher('**/types.xml');
  const regenerate = (): void => {
    void exportPythonTypeStubs(deps, { silent: true, listCustomTypes });
  };
  watcher.onDidChange(regenerate);
  watcher.onDidCreate(regenerate);
  watcher.onDidDelete(regenerate);
  context.subscriptions.push(watcher);
  return watcher;
}
