/**
 * types.xml 自定义类型 → Python 类型桩模块(docs/design/def-pyi-stubs.md §6
 * 立项落地):把 entity_defs/types.xml 里的 utype(FIXED_DICT 结构体与类型
 * 别名)发射成 `<存根目录>/kbe_types.py`——方案 A 选真 .py 而非 .pyi:纯 .pyi
 * 没有运行时形态,Pylance 对 .pyi 里 `X = List[int]` 这类模块级赋值的支持
 * 不稳,真 .py 既能当类型来源也能被 Python 侧 import。
 *
 * 映射口径(分析 §2):FIXED_DICT → TypedDict(属性按 types.xml 文档序);
 * ARRAY → List[元素];别名 → 目标类型名;内置类型走与 clientSdkGenerator
 * TS_BUILTIN_TYPES 同表的 Python 版;解析不了的指引落 Any(有损但合法)。
 * 内容确定性优先:头部不带时间戳,同输入逐字节同输出,才撑得起与
 * KBEngine.pyi 同一套「内容一致零写」纪律。别名赋值是模块级急切求值,
 * 依赖序由拓扑排序保证;成环/指引为空的上游会被跳过并连带跳过下游,
 * 绝不发射引用未定义名字的赋值。
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
  readStubDirSetting,
  resolveStubDir,
  type StubExportDeps
} from './pythonStubExport';

export const PYTHON_TYPE_STUB_FILE_NAME = 'kbe_types.py';

/**
 * KBEngine API 桩里的引擎级类型别名(docs/design/def-pyi-stubs.md 与引擎
 * typings 同源)。types.xml 属性引用它们时按名透传,并在头部从 KBEngine 导入;
 * 其余未知名字仍兜底成 Any,避免发射无出处的引用。
 */
const KBENGINE_TYPE_ALIASES = new Set(['Address', 'WatcherValue']);

/**
 * KBEngine 内置类型 → Python 注解。与 clientSdkGenerator 的 TS_BUILTIN_TYPES
 * 同一张语义表的 Python 面整型归 int、浮点归 float、字符串归 str;
 * PY_DICT/PY_TUPLE/PY_LIST 用 typing 泛型(py3.7 安全,future-annotations
 * 帮不到模块级赋值);引擎侧无对应物的 ENTITYCALL/PYTHON 归 Any。
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
  /** 属性名 → 属性行或内联 <Type> 行(1 起) */
  propertySourceLines?: Record<string, number | null>;
}

export interface PythonTypeStubAliasEntry {
  kind: 'alias';
  name: string;
  annotation: string;
  /** ARRAY/别名节点声明行(1 起);测试注入缺源时为 null */
  sourceLine?: number | null;
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

/** 类型桩约定路径:与 KBEngine.pyi 同居的默认目录(用户配置目录照常让位) */
export function kbeTypeStubFilePath(workspaceRoot: string): string {
  return joinPath(kbeStubDir(workspaceRoot), PYTHON_TYPE_STUB_FILE_NAME);
}

interface AnnotationContext {
  /** 全部自定义类型名(类或别名,注解里可引用) */
  names: ReadonlySet<string>;
  /** 其中的别名(模块级赋值,拓扑序约束只作用于它们) */
  aliasNames: ReadonlySet<string>;
}

function propertyAnnotation(
  property: CustomTypePropertyInfo,
  context: AnnotationContext
): string {
  const typeName = property.typeName?.trim();
  if (typeName === 'ARRAY') {
    return `List[${PYTHON_TYPE_STUB_FALLBACK}]`;
  }
  return annotationForType(typeName ?? '', context);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 数组结构的元素注解:of 套 of 递归成 List[List[...]],缺 of 落 List[Any] */
function annotationFromArrayNode(node: CustomTypeStructureNode, context: AnnotationContext): string {
  if (node.name === 'ARRAY') {
    const ofChild = node.children.find(child => child.tag === 'of');
    if (!ofChild) {
      return `List[${PYTHON_TYPE_STUB_FALLBACK}]`;
    }
    return `List[${annotationFromArrayNode(ofChild.value, context)}]`;
  }
  return annotationForType(node.name, context);
}

/** 单个类型名 → Python 注解(属性面/别名指引共用,拿不到结构细节) */
function annotationForType(typeName: string, context: AnnotationContext): string {
  const trimmed = typeName.trim();
  if (trimmed.length === 0 || trimmed === 'ALIAS') {
    // 空指引或「未解析」占位不该被当类型名发射
    return PYTHON_TYPE_STUB_FALLBACK;
  }
  if (trimmed === 'ARRAY') {
    // 属性面内联数组(如 <Type>ARRAY<of>X</of></Type>)元素型拿不到,有损落 Any
    return `List[${PYTHON_TYPE_STUB_FALLBACK}]`;
  }
  const builtin = PYTHON_BUILTIN_TYPE_ANNOTATIONS[trimmed];
  if (builtin !== undefined) {
    return builtin;
  }
  if (context.names.has(trimmed)) {
    return trimmed;
  }
  if (KBENGINE_TYPE_ALIASES.has(trimmed)) {
    return trimmed;
  }
  return PYTHON_TYPE_STUB_FALLBACK;
}

/** 注解里引用到的别名名(拓扑序只关心别名之间的依赖) */
function referencedAliasNames(annotation: string, context: AnnotationContext): string[] {
  return [...context.aliasNames].filter(name =>
    new RegExp(`\\b${escapeRegExp(name)}\\b`).test(annotation)
  );
}

export function buildPythonTypeStubPlan(customTypes: readonly CustomTypeInfo[]): PythonTypeStubPlan {
  const skipped: PythonTypeStubSkipped[] = [];
  const sorted = [...customTypes].sort((left, right) => left.name.localeCompare(right.name));

  const names = new Set(sorted.map(info => info.name));
  const classNames = new Set(
    sorted.filter(info => info.aliasType === 'FIXED_DICT').map(info => info.name)
  );
  const context: AnnotationContext = {
    names,
    aliasNames: new Set([...names].filter(name => !classNames.has(name)))
  };
  const typeByName = new Map(sorted.map(info => [info.name, info]));

  const classes: PythonTypeStubClassEntry[] = [];
  // 别名与其注解;null = 指引为空/成环等被跳过,不发射
  const aliasAnnotations = new Map<string, string>();
  for (const info of sorted) {
    if (info.aliasType === 'FIXED_DICT') {
      classes.push({
        kind: 'class',
        name: info.name,
        properties: info.properties.map(property => ({
          name: property.name,
          annotation: propertyAnnotation(property, context)
        })),
        sourceLine: info.line,
        propertySourceLines: Object.fromEntries(info.properties.map(property => {
          const sourceLine = property.typeLine ?? property.line;
          return [property.name, sourceLine === undefined ? null : sourceLine];
        }))
      });
      continue;
    }
    if (info.aliasType === 'ARRAY') {
      // ARRAY 别名从 structure 取 <of> 子节点(属性面那种内联写法拿不到元素型)
      aliasAnnotations.set(info.name, annotationFromArrayNode(info.structure, context));
      continue;
    }
    // 剩下的按普通别名走;aliasType 为 ALIAS 占位说明指引没解析出来
    if (info.aliasType === 'ALIAS') {
      skipped.push({
        name: info.name,
        reason: 'types.xml 指引为空,无法解析目标类型'
      });
      continue;
    }
    aliasAnnotations.set(info.name, annotationForType(info.aliasType, context));
  }

  // 类体注解是惰性的(Python class 体求值前有 future-annotations 兜着),
  // 只有模块级别名赋值是急切求值:按依赖排定发射序,上游被跳过(指引为空)
  // 的下游连带跳过,剩余发射不出去的就是环,整链跳过——绝不发射引用未定义
  // 名字的赋值。
  const aliasWork = new Map<string, { annotation: string; refs: string[] }>();
  for (const [name, annotation] of aliasAnnotations) {
    aliasWork.set(name, { annotation, refs: referencedAliasNames(annotation, context) });
  }
  const poisoned = new Map<string, string>(skipped.map(item => [item.name, item.reason]));
  let cascading = true;
  while (cascading) {
    cascading = false;
    for (const [name, work] of aliasWork) {
      if (poisoned.has(name)) {
        continue;
      }
      const broken = work.refs.find(ref => poisoned.has(ref));
      if (broken !== undefined) {
        poisoned.set(name, `依赖的类型 ${broken} 未能解析,连带跳过`);
        cascading = true;
      }
    }
  }
  for (const [name, reason] of poisoned) {
    aliasAnnotations.delete(name);
    aliasWork.delete(name);
    if (!skipped.some(item => item.name === name)) {
      skipped.push({ name, reason });
    }
  }

  // 每轮按名字序发射「依赖已全部就绪」的别名,直到一轮无所出;迭代轮次
  // 与输入顺序无关,输出确定
  const orderedEntries: PythonTypeStubAliasEntry[] = [];
  const emitted = new Set<string>();
  let progressing = true;
  while (progressing) {
    progressing = false;
    for (const [name, work] of [...aliasWork].sort((left, right) => left[0].localeCompare(right[0]))) {
      if (emitted.has(name)) {
        continue;
      }
      if (work.refs.every(ref => emitted.has(ref))) {
        orderedEntries.push({
          kind: 'alias',
          name,
          annotation: work.annotation,
          sourceLine: typeByName.get(name)?.line ?? null
        });
        emitted.add(name);
        progressing = true;
      }
    }
  }
  for (const [name] of [...aliasWork].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (!emitted.has(name)) {
      skipped.push({ name, reason: '别名链成环,无法排出依赖序,整链跳过' });
    }
  }

  const entries: PythonTypeStubEntry[] = [...classes, ...orderedEntries];
  return { content: buildPythonTypeStubContent(entries), entries, skipped };
}

/**
 * 模块全文:头部声明生成物身份与 gitignore 建议(确定性,无时间戳),
 * 类体在先、别名赋值随后(调用方已按依赖排好序)。零条目返回 null。
 */
export function buildPythonTypeStubContent(entries: readonly PythonTypeStubEntry[]): string | null {
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
  for (const entry of entries) {
    lines.push('', '');
    if (entry.kind === 'class') {
      lines.push(`# source: types.xml:${entry.sourceLine ?? 'unknown'}`);
      lines.push(`class ${entry.name}(TypedDict):`);
      if (entry.properties.length === 0) {
        lines.push('    pass');
      } else {
        for (const property of entry.properties) {
          const sourceLine = entry.propertySourceLines?.[property.name];
          lines.push(`    # source: types.xml:${sourceLine ?? 'unknown'}`);
          lines.push(`    ${property.name}: ${property.annotation}`);
        }
      }
    } else {
      lines.push(`# source: types.xml:${entry.sourceLine ?? 'unknown'}`);
      lines.push(`${entry.name} = ${entry.annotation}`);
      }
  }
  lines.push('');
  return lines.join('\n');
}

export interface PythonTypeStubExportOptions {
  /** 激活期自动导出传 true:全程零提示;命令面板手动导出保持播报 */
  silent?: boolean;
  /** 自定义类型来源(测试注入;装配层为 definitionWorkspace.getCustomTypeInfos) */
  listCustomTypes?: (workspaceRoot: string) => CustomTypeInfo[];
}

/**
 * 逐工作区把 types.xml 自定义类型导出为 kbe_types.py,与 exportKbeStubs
 * 同一套纪律:共用 kbengine.python.stubExport 开关;无自定义类型不生成;
 * 用户配置目录已有同名文件按用户资产跳过;默认目录内容一致零写、陈旧重写;
 * 目录不可写告警并继续其余文件夹。返回实际写入的文件夹名列表。
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
    const plan = buildPythonTypeStubPlan(listCustomTypes(folder.uri.fsPath));
    if (plan.content === null) {
      skipped.push(`${folder.name}(无自定义类型(types.xml),无需类型桩)`);
      continue;
    }
    const resolved = resolveStubDir(folder.uri.fsPath, {
      setting: readStubDirSetting(),
      folders: [{ fsPath: folder.uri.fsPath, name: folder.name }],
      filePath: vscode.window.activeTextEditor?.document.fileName
    });
    const target = joinPath(resolved.dir, PYTHON_TYPE_STUB_FILE_NAME);
    // 用户指定目录是用户资产:目标文件已在就不碰(kbe_types.py 是 .py,按
    // 文件存在性判,不做 .pyi 目录扫描);默认目录归 kode 自管,走内容比对。
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
      deps.mkdir(resolved.dir);
      deps.writeFile(target, plan.content);
      written.push(folder.name);
    } catch {
      // 目录不可写(只读挂载/权限):如实告警,不挡其余文件夹
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
      `已为 ${written.join('、')} 导出 kbe_types.py 类型桩(FIXED_DICT→TypedDict、别名→类型名,配合 extraPaths 接线供 Python 扩展解析)`
    );
  }
  return written;
}

/**
 * types.xml watcher 自动重生成(def-pyi-stubs §4 二期):保存/新建/删除
 * types.xml 后静默重导出 kbe_types.py。不设去抖、不加开关——导出函数自带
 * `kbengine.python.stubExport` 门(关掉即停),内容确定性与零写纪律保证
 * 重复触发无副作用;快照每次直读磁盘,事件到达即读到新内容,无缓存竞态。
 * watcher 只盯 types.xml:kbe_types.py 的内容来源仅此一个文件,写自己的
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
