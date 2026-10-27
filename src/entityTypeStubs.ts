import type { EntityMapping } from './entityMapping';
import {
  getCustomTypeInfos,
  type CustomTypeInfo
} from './definitionWorkspace';
import { EntityMappingManager } from './entityMapping';
import {
  PYTHON_STUB_EXPORT_ENABLED_DEFAULT,
  fileSystemStubExportDeps,
  kbeStubDir,
  readManagedDirSetting,
  resolveManagedDirName,
  type StubExportDeps
} from './pythonStubExport';
import {
  PYTHON_BUILTIN_TYPE_ANNOTATIONS,
  PYTHON_TYPE_STUB_FALLBACK,
  buildPythonTypeStubPlan,
  groupCustomTypesByModule,
  kbeTypesModuleOfKey,
  resolveAnnotationTypeWithRegistry
} from './pythonTypeStubs';
import * as vscode from 'vscode';

export const ENTITY_TYPE_STUB_FILE_NAME = 'entity_types.pyi';
/** 方法面开关默认值(kbengine.python.entityStubMethods,默认开) */
export const ENTITY_STUB_METHODS_ENABLED_DEFAULT = true;

export interface EntityTypePropertyEntry {
  name: string;
  annotation: string;
  /** 属性 .def 声明行(1 起);统一源码映射禁止反推生成行号 */
  sourceLine: number;
  /** 引用 types.xml 自定义类型时的类型节点行(1 起) */
  customTypeLine?: number;
}

export interface EntityTypeStubEntry {
  entity: string;
  properties: EntityTypePropertyEntry[];
  methods: EntityTypeMethodEntry[];
}

export interface EntityTypeMethodEntry {
  name: string;
  args: string[];
  section: 'BaseMethods' | 'CellMethods' | 'ClientMethods';
  exposed: boolean;
  sourceLine: number;
}

export interface EntityTypeStubPlan {
  content: string | null;
  entries: EntityTypeStubEntry[];
}

export interface EntityTypeStubExportOptions {
  listMappings?: (workspaceRoot: string) => EntityMapping[];
  listCustomTypes?: (workspaceRoot: string) => CustomTypeInfo[];
  silent?: boolean;
}

export async function exportEntityTypeStubs(
  mappingManager: EntityMappingManager,
  deps: StubExportDeps = fileSystemStubExportDeps,
  options: EntityTypeStubExportOptions = {}
): Promise<string[]> {
  const enabled = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('python.stubExport', PYTHON_STUB_EXPORT_ENABLED_DEFAULT);
  if (!enabled) {
    return [];
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return [];
  }
  const listMappings = options.listMappings ?? (() => mappingManager.getAllMappings());
  const listCustomTypes = options.listCustomTypes ?? getCustomTypeInfos;
  // 实体方法面独立开关(用户令 2026-10-21):kbengine.python.entityStubMethods
  // =false 时实体存根只含属性面,方法面整体让位(总闸 stubExport 依旧先行)。
  const includeMethods = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('python.entityStubMethods', ENTITY_STUB_METHODS_ENABLED_DEFAULT);
  const written: string[] = [];
  for (const folder of folders) {
    const plan = buildEntityTypeStubPlan(
      listMappings(folder.uri.fsPath),
      listCustomTypes(folder.uri.fsPath),
      { includeMethods, workspaceRoot: folder.uri.fsPath }
    );
    if (!plan.content) {
      continue;
    }
    // 托管目录可配置(任务 B):entity_types.pyi 与 KBEngine.pyi/kbe_types.pyi
    // 同居 <managedDir>/stubs,随 kbengine.managedDir 同迁(旧键 stubDir 不经此处)
    const managedDirName = resolveManagedDirName(readManagedDirSetting()).name;
    const stubDir = kbeStubDir(folder.uri.fsPath, managedDirName);
    const target = `${stubDir}/${ENTITY_TYPE_STUB_FILE_NAME}`;
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
      deps.mkdir(stubDir);
      deps.writeFile(target, plan.content);
      written.push(folder.name);
    } catch {
      if (!options.silent) {
        await vscode.window.showWarningMessage(`实体类型桩导出失败: ${folder.name}`);
      }
    }
  }
  return written;
}

interface EntityStubContext {
  customTypes: ReadonlyMap<string, CustomTypeInfo>;
  /** kbe_types.pyi 真实发射的自定义类型名(类 + 别名)→ 其分件镜像模块路径 */
  customTypeModules: ReadonlyMap<string, string>;
}

function annotationForDefType(typeName: string | undefined, context: EntityStubContext): {
  annotation: string;
  customTypeLine?: number;
} {
  const trimmed = typeName?.trim();
  if (!trimmed || trimmed === 'ALIAS') {
    return { annotation: PYTHON_TYPE_STUB_FALLBACK };
  }
  const customType = context.customTypes.get(trimmed);
  if (customType) {
    // 跨文件可解析断层修复(用户令 2026-10-27 pyi ③):裸类名引用只有配上
    // 真实存在的 kbe_types 导入才可解析。只认 kbe_types.pyi 实际发射的名
    // (成环/指引为空等 poisoned 条目不发射),拿不到的诚实落 Any,不悬挂
    // 一个 Pylance 解析不到的名字。
    if (context.customTypeModules.has(trimmed)) {
      return { annotation: trimmed, customTypeLine: customType.line };
    }
    return { annotation: PYTHON_TYPE_STUB_FALLBACK };
  }
  if (trimmed === 'ARRAY') {
    return { annotation: `List[${PYTHON_TYPE_STUB_FALLBACK}]` };
  }
  return {
    annotation: PYTHON_BUILTIN_TYPE_ANNOTATIONS[trimmed] ?? PYTHON_TYPE_STUB_FALLBACK
  };
}

/**
 * 只收 kbe_types.pyi 实际发射的名字(类 + 别名)→ 其镜像模块路径:
 * stubs/scripts/entity_defs/kbe_types.pyi 按 extraPaths 根打成点分模块
 * `scripts.entity_defs.kbe_types`,根级单文件即 `kbe_types`(2026-10-27
 * pyi ④ 起按镜像目录分模块,同目录 types.xml/alias.xml 合并,同名后到按
 * addDataType 口径作废不发射——poisoned 与作废名都不进)。
 */
function collectCustomTypeModules(
  customTypes: readonly CustomTypeInfo[],
  workspaceRoot: string | undefined
): Map<string, string> {
  const modules = new Map<string, string>();
  for (const [moduleKey, group] of groupCustomTypesByModule(customTypes, workspaceRoot)) {
    const modulePath = kbeTypesModuleOfKey(moduleKey);
    for (const entry of buildPythonTypeStubPlan(group).entries) {
      modules.set(entry.name, modulePath);
    }
  }
  return modules;
}

export function buildEntityTypeStubPlan(
  mappings: readonly EntityMapping[],
  customTypes: readonly CustomTypeInfo[],
  options: { includeMethods?: boolean; workspaceRoot?: string } = {}
): EntityTypeStubPlan {
  const context: EntityStubContext = {
    customTypes: new Map(customTypes.map(info => [info.name, info])),
    customTypeModules: collectCustomTypeModules(customTypes, options.workspaceRoot)
  };
  // 方法面开关(用户令 2026-10-21):默认含方法面;includeMethods=false 时
  // 方法表整体留空,只有方法的实体随之落出存根(属性面不受影响)。
  const includeMethods = options.includeMethods !== false;
  const entries = [...mappings]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(mapping => {
      const withDefinitions = mapping as EntityMapping & {
        propertyDefinitions?: Array<{ identity: { symbolName: string }; typeName?: string }>
      };
      // ARRAY of 折叠(用户报 bug 2026-10-27):parseProperties 对 ARRAY of 的
      // 元素/嵌套子属性以 `${fullPath}[]` 登记(foo[] 与 foo[].x),toLegacyMapping
      // 原样进 properties 表——存根原样吐出时 foo 与 foo[] 各出一行,且 foo[]
      // 非法标识符。[] 子路径一律不落行,折叠回顶层属性;顶层元素(恰好 `x[]`
      // 那条)的 typeName 经同链解析,可解析则升级 list[元素类型],否则保持
      // 顶层自身注解(裸 ARRAY 无元素声明仍 list[Any],诚实不硬造)。
      const rawEntries = Object.entries(mapping.properties);
      const elementAnnotations = new Map<string, { annotation: string; customTypeLine?: number }>();
      for (const [name] of rawEntries) {
        const cut = name.indexOf('[]');
        if (cut === -1 || cut + 2 !== name.length) { continue; }
        const parentPath = name.slice(0, cut);
        if (elementAnnotations.has(parentPath)) { continue; }
        if (!rawEntries.some(([other]) => other === parentPath)) { continue; }
        const elementInfo = withDefinitions.propertyDefinitions?.find(
          definition => definition.identity.symbolName === name
        );
        elementAnnotations.set(parentPath, annotationForDefType(elementInfo?.typeName, context));
      }
      return {
        entity: mapping.name,
        properties: rawEntries
          .filter(([name]) => !name.includes('[]'))
          .map(([name, location]) => {
            const propertyInfo = withDefinitions.propertyDefinitions?.find(
              definition => definition.identity.symbolName === name
            );
            let resolved = annotationForDefType(propertyInfo?.typeName, context);
            const element = elementAnnotations.get(name);
            if (element && propertyInfo?.typeName?.trim() === 'ARRAY') {
              resolved = {
                annotation: `List[${element.annotation}]`,
                customTypeLine: element.customTypeLine
              };
            }
            return {
              name,
              annotation: resolved.annotation,
              customTypeLine: resolved.customTypeLine,
              sourceLine: location.line
            };
          })
          .sort((left, right) => left.name.localeCompare(right.name)),
        methods: includeMethods ? collectEntityTypeMethods(mapping) : []
      };
    })
    .filter(entry => entry.properties.length > 0 || entry.methods.length > 0);
  return {
    content: entries.length === 0
      ? null
      : buildEntityTypeStubContent(entries, customTypes, context.customTypeModules),
    entries
  };
}

function collectEntityTypeMethods(mapping: EntityMapping): EntityTypeMethodEntry[] {
  const sections = ['BaseMethods', 'CellMethods', 'ClientMethods'] as const;
  return [...new Set(Object.keys(mapping.methods))]
    .map(methodName => {
      const declarations = mapping.methods[methodName] ?? [];
      const declaration = sections
        .map(section => declarations.find(item => item.section === section))
        .find(Boolean);
      if (!declaration) {
        return null;
      }
      return {
        name: methodName,
        args: declaration.declaredArgs ?? [],
        section: declaration.section,
        exposed: declaration.exposed,
        sourceLine: declaration.line
      };
    })
    .filter((method): method is EntityTypeMethodEntry => method !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildEntityTypeStubContent(
  entries: readonly EntityTypeStubEntry[],
  customTypes: readonly CustomTypeInfo[] = [],
  customTypeModules: ReadonlyMap<string, string> = new Map()
): string {
  // mailbox 面(pyi ④ 任务1):有方法面的实体配 <Entity>MB(EntityCall)
  // 远端句柄类,方法签名与实体类同源同链(同一 methodArgAnnotation)。
  const anyMailbox = entries.some(entry => entry.methods.length > 0);
  const lines = [
    '# Entity stubs generated by kode from *.def and types.xml.',
    '# Manual edits are overwritten. Source comments preserve original lines;',
    '# generated line numbers must never be used to infer source locations.',
    // 导入口径与 kbe_types.pyi 一致(全量固定):注解面可能用到
    // VECTORx→Tuple、PY_DICT→Dict、PY_LIST→List、FIXED_DICT→TypedDict 等
    // typing 名,缺 import 时 Pylance 直接报未定义(用户实锤)。
    'from typing import Any, Callable, Dict, List, Tuple, TypedDict, Union',
    // 继承面(pyi ④ 任务1):实体类继承 KBEngine 存根 Entity;有 mailbox
    // 面时 EntityCall 也从 KBEngine 导入(只导注解面真实引用到的名字)。
    `from KBEngine import Entity${anyMailbox ? ', EntityCall' : ''}`
  ];
  // kbe_types 跨文件导入(用户令 2026-10-27 pyi ③):注解面引用的自定义
  // 类型名按其分件镜像模块逐组导入(根级 kbe_types / 镜像 scripts.entity_defs.
  // kbe_types),只导注解面真实引用到的名字——跨文件同名注解必须真实可解析。
  // 方法形参注解同扫:MB 面与实体方法面共用同一批注解,漏扫即悬挂裸名。
  const referenced = new Set<string>();
  const identifierOf = (annotation: string): void => {
    for (const name of customTypeModules.keys()) {
      if (new RegExp(`\\b${name}\\b`).test(annotation)) {
        referenced.add(name);
      }
    }
  };
  for (const entry of entries) {
    for (const property of entry.properties) {
      identifierOf(property.annotation);
    }
    for (const method of entry.methods) {
      for (const arg of method.args) {
        identifierOf(methodArgAnnotation(arg, customTypes));
      }
    }
  }
  if (referenced.size > 0) {
    const byModule = new Map<string, string[]>();
    for (const name of [...referenced].sort()) {
      const modulePath = customTypeModules.get(name)!;
      const list = byModule.get(modulePath) ?? [];
      list.push(name);
      byModule.set(modulePath, list);
    }
    for (const [modulePath, names] of [...byModule.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))) {
      lines.push(`from ${modulePath} import ${names.join(', ')}`);
    }
  }
  for (const entry of entries) {
    // mailbox 类先于实体类:实体类的 base/cell/client 注解按名引用它
    // (.pyi 注解不求值,前后引用皆可;就近排放为可读性)。
    if (entry.methods.length > 0) {
      lines.push('', `# Mailbox face: ${entry.entity} 远端句柄,.def 方法面(Base/Cell/Client)`);
      lines.push(`class ${entry.entity}MB(EntityCall):`);
      for (const method of entry.methods) {
        lines.push(...methodFaceLines(method, customTypes));
      }
    }
    lines.push('', `class ${entry.entity}(Entity):`);
    if (entry.properties.length === 0 && entry.methods.length === 0) {
      lines.push('    pass');
      continue;
    }
    if (entry.methods.length > 0) {
      // 引擎 Entity 基类的 client/base/cell 语义存在但无逐实体类型;此处
      // 按本实体 MB 收窄(取舍见 docs/design/def-pyi-stubs.md §8.4)。
      lines.push(`    # mailbox handles: Union[${entry.entity}MB, None]`);
      lines.push(`    base: Union[${entry.entity}MB, None]`);
      lines.push(`    cell: Union[${entry.entity}MB, None]`);
      lines.push(`    client: Union[${entry.entity}MB, None]`);
    }
    for (const property of entry.properties) {
      const sourceParts = [`.def:${property.sourceLine}`];
      if (property.customTypeLine !== undefined) {
        sourceParts.push(`types.xml:${property.customTypeLine}`);
      }
      lines.push(`    # source: ${sourceParts.join(' -> ')}`);
      lines.push(`    ${property.name}: ${property.annotation}`);
    }
    for (const method of entry.methods) {
      lines.push('', ...methodFaceLines(method, customTypes));
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** 方法面两处共用(实体类声明 + mailbox 句柄类):同源同注解链 */
function methodFaceLines(method: EntityTypeMethodEntry, customTypes: readonly CustomTypeInfo[]): string[] {
  const parameters = method.args.map((arg, index) =>
    `${pythonParameterName(arg, index)}: ${methodArgAnnotation(arg, customTypes)}`
  );
  return [
    `    # source: .def:${method.sourceLine} (${method.section})`,
    `    def ${method.name}(${parameters.join(', ')}) -> None: ...`
  ];
}

function pythonParameterName(typeName: string, index: number): string {
  return `arg${index + 1}`;
}

/**
 * 方法面形参注解(用户令 2026-10-21 收口):不再单表直查,与 hover 签名共用
 * resolveAnnotationTypeWithRegistry 解析链——types.xml 自定义类型逐层下钻到
 * 内建(如 TIMESTAMP→int),链断/成环/未知仍 Any 不硬造。ARRAY 不再特判:
 * 未注册的裸 ARRAY 与未知同责落 Any。
 */
function methodArgAnnotation(typeName: string, customTypes: readonly CustomTypeInfo[]): string {
  return resolveAnnotationTypeWithRegistry(typeName, customTypes);
}
