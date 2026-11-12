import type { EntityMapping } from './entityMapping';
import {
  getCustomTypeInfos,
  type CustomTypeInfo
} from './definitionWorkspace';
import { EntityMappingManager } from './entityMapping';
import {
  PYTHON_STUB_EXPORT_ENABLED_DEFAULT,
  fileSystemStubExportDeps,
  readManagedDirSetting,
  readStubDirSetting,
  resolveStubDir,
  resolveManagedDirName,
  type StubExportDeps
} from './pythonStubExport';
import {
  PYTHON_TYPE_STUB_FILE_NAME,
  PYTHON_BUILTIN_TYPE_ANNOTATIONS,
  PYTHON_TYPE_STUB_FALLBACK,
  buildPythonTypeStubPlan,
  groupCustomTypesByModule,
  kbeTypesModuleOfKey,
  resolveAnnotationTypeWithRegistry
} from './pythonTypeStubs';
import { PYTHON_FAMILY_BASE, inferPythonLiteralAnnotation } from './backend/pythonLiteralTypes';
import {
  childProcessPyrightRunner,
  detectPyrightCommand,
  runPyrightDiagnostics,
  summarizePyrightReport,
  type PyrightCommandRunner
} from './backend/pyrightStubGate';
import * as vscode from 'vscode';
import { processStubRoot } from './backend/pythonProcess';

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
  /**
   * GEN-DEF-1(用户令 2026-11-02):容器属性(FIXED_DICT/ARRAY)在生成实体类
   * __init__ 里的 is None 守卫复位值——FixedArray → '[]'、FixedDict → '{}'
   * (与新建实体向导 entityWizard.containerGuardProperties 同口径);简单类型
   * 与落 Any 的 poisoned 名恒 undefined(不守卫、不生成空 __init__)。
   */
  guardNoneEmpty?: '[]' | '{}';
}

export interface EntityTypeStubEntry {
  entity: string;
  properties: EntityTypePropertyEntry[];
  methods: EntityTypeMethodEntry[];
  role?: 'base' | 'cell' | 'client';
  remoteMethods?: EntityTypeMethodEntry[];
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
  /**
   * IDE-STUB-002:generated 档 pyright 校验面。缺省装配层 runner =
   * child_process.execFile;测试注入 runner 全程不碰真进程。note 缺省落
   * 「KBEngine Stub Pyright」输出通道。
   */
  pyright?: PyrightStubGateOptions;
}

export interface PyrightStubGateOptions {
  runner?: PyrightCommandRunner;
  /** CLI 探测候选序覆盖(缺省 pyright → npx --no-install pyright) */
  candidates?: readonly string[][];
  /** 逐行输出落点(输出面板);缺省落专用输出通道 */
  note?: (line: string) => void;
}

/** 输出面板缺省落点:专用通道,建一次复用 */
let stubPyrightChannel: vscode.OutputChannel | null = null;
function defaultPyrightNote(line: string): void {
  stubPyrightChannel ??= vscode.window.createOutputChannel('KBEngine Stub Pyright');
  stubPyrightChannel.appendLine(line);
}

/**
 * IDE-STUB-002:generated 档的 pyright 校验(写入发生后才跑;探测不可用
 * 降级纯生成,只提示不报错)。档位闸在调用侧:real-source 档的复制产物
 * 不经此校验。
 */
async function runPyrightStubGate(
  targets: readonly string[],
  gate: PyrightStubGateOptions
): Promise<void> {
  if (targets.length === 0) {
    return;
  }
  const note = gate.note ?? defaultPyrightNote;
  const runner = gate.runner ?? childProcessPyrightRunner;
  const command = await detectPyrightCommand(runner, gate.candidates);
  if (!command) {
    note('[pyright] 未检测到可用 CLI(pyright / npx pyright),降级纯生成,跳过诊断校验');
    return;
  }
  const report = await runPyrightDiagnostics(runner, command, targets);
  for (const line of summarizePyrightReport(report)) {
    note(line);
  }
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
  // IDE-STUB-002:pyright 校验(默认装配即触发;收据循环后统一收集落盘
  // stub——不依赖本次是否发生写入:实体桩内容一致零写、或只有桩包分件/
  // kbe_types 分件在盘时同样校验。批 ③ 起桩面全部来自内置静态模板,不再有
  // real-source 档(复制真实代码车道退役),校验闸恒开)
  const pyrightGateActive = true;
  for (const folder of folders) {
    const managedDirName = resolveManagedDirName(readManagedDirSetting()).name;
    const stubDir = resolveStubDir(folder.uri.fsPath, {
      managedDir: managedDirName, setting: readStubDirSetting(),
      folders: [{ fsPath: folder.uri.fsPath, name: folder.name }]
    }).dir;
    const isolated = deps.exists(`${processStubRoot(stubDir, 'base')}/KBEngine/__init__.pyi`);
    const outputs = isolated
      ? (['base', 'cell', 'bots', 'client'] as const).map(process => ({
        dir: processStubRoot(stubDir, process), role: process === 'bots' ? 'client' as const : process
      }))
      : [{ dir: stubDir, role: undefined }];
    for (const output of outputs) {
      const plan = buildEntityTypeStubPlan(listMappings(folder.uri.fsPath), listCustomTypes(folder.uri.fsPath),
        { includeMethods, workspaceRoot: folder.uri.fsPath, role: output.role });
      if (!plan.content) { continue; }
      const target = `${output.dir}/${ENTITY_TYPE_STUB_FILE_NAME}`;
      try {
        if (deps.exists(target) && deps.readFile(target) === plan.content) { continue; }
        deps.mkdir(output.dir);
        deps.writeFile(target, plan.content);
        if (!written.includes(folder.name)) { written.push(folder.name); }
      } catch {
        if (!options.silent) {
          await vscode.window.showWarningMessage(`实体类型桩导出失败: ${folder.name}`);
        }
      }
    }
  }
  // IDE-STUB-002:generated 档落盘 stub 的 pyright 校验(默认装配即触发;
  // 循环后统一收集——存在才收:entity_types.pyi + KBEngine.pyi + kbe_types
  // 分件镜像按 groupCustomTypesByModule 同源键逐一枚举,不漏 cellapp 等
  // 非 entity_defs 分件;探测不可用降级纯生成,输出面板提示)
  if (pyrightGateActive) {
    const pyrightTargets: string[] = [];
    for (const folder of folders) {
      const managedDirName = resolveManagedDirName(readManagedDirSetting()).name;
      const stubDir = resolveStubDir(folder.uri.fsPath, {
        managedDir: managedDirName, setting: readStubDirSetting(),
        folders: [{ fsPath: folder.uri.fsPath, name: folder.name }]
      }).dir;
      const isolated = deps.exists(`${processStubRoot(stubDir, 'base')}/KBEngine/__init__.pyi`);
      const candidates = [
        `${stubDir}/${ENTITY_TYPE_STUB_FILE_NAME}`,
        `${stubDir}/KBEngine.pyi`,
        // 根级 kbe_types.pyi 无条件进候选:旧布局遗留/类型清单变动后,在盘的
        // 根级分件不该因当前清单无空键而漏校验
        `${stubDir}/${PYTHON_TYPE_STUB_FILE_NAME}`
      ];
      for (const moduleKey of groupCustomTypesByModule(
        listCustomTypes(folder.uri.fsPath),
        folder.uri.fsPath
      ).keys()) {
        if (moduleKey === '') {
          continue;
        }
        candidates.push(`${stubDir}/${moduleKey}/${PYTHON_TYPE_STUB_FILE_NAME}`);
      }
      if (isolated) {
        const project = `${folder.uri.fsPath}/pyrightconfig.json`;
        if (deps.exists(project)) {
          const targets = ['base', 'cell', 'bots', 'client'].flatMap(role => {
            const root = processStubRoot(stubDir, role as 'base' | 'cell' | 'bots' | 'client');
            return [`${root}/${ENTITY_TYPE_STUB_FILE_NAME}`, `${root}/KBEngine`].filter(deps.exists);
          });
          if (targets.length > 0) { await runPyrightStubGate(['--project', project, ...targets], options.pyright ?? {}); }
        }
        continue;
      }
      for (const candidate of candidates) {
        try {
          if (deps.exists(candidate)) {
            pyrightTargets.push(candidate);
          }
        } catch {
          // 存在性判定失败就不收该候选,不影响其余
        }
      }
    }
    if (pyrightTargets.length > 0) {
      await runPyrightStubGate(pyrightTargets, options.pyright ?? {});
    }
  }
  return written;
}

interface EntityStubContext {
  customTypes: ReadonlyMap<string, CustomTypeInfo>;
  /** kbe_types.pyi 真实发射的自定义类型名(类 + 别名)→ 其分件镜像模块路径 */
  customTypeModules: ReadonlyMap<string, string>;
  /** 守卫判定别名链解析用(pythonTypeStubs 解析链吃数组形态) */
  customTypeList: readonly CustomTypeInfo[];
}

function annotationForDefType(
  typeName: string | undefined,
  context: EntityStubContext,
  defaultValue?: string
): {
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
    // 裸 ARRAY 无元素声明:运行时容器是引擎 FixedArray(非 Python list),有损
    // 落 FixedArray[Any],诚实不硬造元素型(2026-10-27 用户报 bug 收口)。
    return { annotation: `FixedArray[${PYTHON_TYPE_STUB_FALLBACK}]` };
  }
  // GEN-DEF-1c:PYTHON 族属性带 <Default> 字面量时精化精确类型(如 PY_DICT
  // <Default>{'hp': 1}</Default> → dict[str,int]),无 Default/解析失败回落
  // 表映射。VECTORx 走映射表(KBEngine.Vector2/3/4),不经字面量。
  if (PYTHON_FAMILY_BASE[trimmed] !== undefined) {
    return {
      annotation: inferPythonLiteralAnnotation(defaultValue, trimmed)
    };
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
  options: { includeMethods?: boolean; workspaceRoot?: string; role?: 'base' | 'cell' | 'client' } = {}
): EntityTypeStubPlan {
  const context: EntityStubContext = {
    customTypes: new Map(customTypes.map(info => [info.name, info])),
    customTypeModules: collectCustomTypeModules(customTypes, options.workspaceRoot),
    customTypeList: customTypes
  };
  // 方法面开关(用户令 2026-10-21):默认含方法面;includeMethods=false 时
  // 方法表整体留空,只有方法的实体随之落出存根(属性面不受影响)。
  const includeMethods = options.includeMethods !== false;
  const entries = [...mappings]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(mapping => {
      const withDefinitions = mapping as EntityMapping & {
        propertyDefinitions?: Array<{
          identity: { symbolName: string };
          typeName?: string;
          defaultValue?: string;
          domains?: Array<'base' | 'cell' | 'client'>;
        }>
      };
      // ARRAY of 折叠(用户报 bug 2026-10-27):parseProperties 对 ARRAY of 的
      // 元素/嵌套子属性以 `${fullPath}[]` 登记(foo[] 与 foo[].x),toLegacyMapping
      // 原样进 properties 表——存根原样吐出时 foo 与 foo[] 各出一行,且 foo[]
      // 非法标识符。[] 子路径一律不落行,折叠回顶层属性;顶层元素(恰好 `x[]`
      // 那条)的 typeName 经同链解析,可解析则升级 list[元素类型],否则保持
      // 顶层自身注解(裸 ARRAY 无元素声明仍 list[Any],诚实不硬造)。
      const rawEntries = Object.entries(mapping.properties).filter(([name]) => {
        if (!options.role) { return true; }
        const definition = withDefinitions.propertyDefinitions?.find(p => p.identity.symbolName === name);
        // Unknown flags must not be advertised on every process.
        return definition?.domains?.includes(options.role) ?? false;
      });
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
        elementAnnotations.set(
          parentPath,
          annotationForDefType(elementInfo?.typeName, context, elementInfo?.defaultValue)
        );
      }
      return {
        entity: mapping.name,
        properties: rawEntries
          .filter(([name]) => !name.includes('[]'))
          .map(([name, location]) => {
            const propertyInfo = withDefinitions.propertyDefinitions?.find(
              definition => definition.identity.symbolName === name
            );
            let resolved = annotationForDefType(
              propertyInfo?.typeName,
              context,
              propertyInfo?.defaultValue
            );
            const element = elementAnnotations.get(name);
            if (element && propertyInfo?.typeName?.trim() === 'ARRAY') {
              // ARRAY of 折叠:元素型经同链解析后包进引擎 FixedArray(非
              // Python list,def 属性运行时容器是 FixedArray[T],GEN-DEF-1b)。
              resolved = {
                annotation: `FixedArray[${element.annotation}]`,
                customTypeLine: element.customTypeLine
              };
            }
            const guardNoneEmpty = guardNoneEmptyOf(resolved.annotation, context);
            return {
              name,
              annotation: resolved.annotation,
              customTypeLine: resolved.customTypeLine,
              sourceLine: location.line,
              ...(guardNoneEmpty !== undefined ? { guardNoneEmpty } : {})
            };
          })
          .sort((left, right) => left.name.localeCompare(right.name)),
        methods: includeMethods ? collectEntityTypeMethods(mapping).filter(method => !options.role ||
          method.section === ({ base: 'BaseMethods', cell: 'CellMethods', client: 'ClientMethods' } as const)[options.role]) : [],
        ...(options.role ? {
          role: options.role,
          remoteMethods: includeMethods ? collectEntityTypeMethods(mapping) : []
        } : {})
      };
    })
    .filter(entry => options.role || entry.properties.length > 0 || entry.methods.length > 0);
  return {
    content: entries.length === 0
      ? null
      : buildEntityTypeStubContent(entries, customTypes, context.customTypeModules),
    entries
  };
}

/**
 * GEN-DEF-1(用户令 2026-11-02,源码已核实):容器属性的 __init__ is None 守卫
 * 复位值——仅引用型(FIXED_DICT/ARRAY,含命名别名)生成;简单类型与落 Any 的
 * poisoned 名返回 undefined(不守卫)。判定与注解同链:a) FixedArray[...] 直译
 * → '[]';b) 其余走 pythonTypeStubs 同一别名解析链(resolveAnnotationType-
 * WithRegistry,环检测/级联跳过全复用,禁第二套)——链尾落到 FixedArray[...]
 * (ARRAY 别名)→ '[]';链尾是 kbe_types.pyi 实际发射的 FIXED_DICT 类名
 * (直接定义或别名指向)→ '{}'。禁 `if not self.` 形态(falsy 判断会把引擎
 * 合法默认 0/""/[] 误判并重建,引用失效)。
 */
function guardNoneEmptyOf(
  annotation: string,
  context: EntityStubContext
): '[]' | '{}' | undefined {
  if (annotation.startsWith('FixedArray[')) {
    return '[]';
  }
  const resolved = resolveAnnotationTypeWithRegistry(annotation, context.customTypeList);
  if (resolved.startsWith('FixedArray[')) {
    return '[]';
  }
  const target = context.customTypes.get(resolved);
  if (
    target?.aliasType === 'FIXED_DICT' &&
    context.customTypeModules.has(resolved)
  ) {
    return '{}';
  }
  return undefined;
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
  return renderEntityTypeStub(entries, customTypes, customTypeModules, null);
}

/** KR-AUD-78:生成文档行映射——entity 名 → 属性名 → 属性行(0 起)。
 * 来源镜按行精确映射,不再硬编码 0/2。 */
export interface EntityTypeStubLineMap {
  readonly propertyLines: ReadonlyMap<string, Readonly<Record<string, number>>>;
}

export function buildEntityTypeStubLineMap(
  entries: readonly EntityTypeStubEntry[],
  customTypes: readonly CustomTypeInfo[] = [],
  customTypeModules: ReadonlyMap<string, string> = new Map()
): EntityTypeStubLineMap {
  const propertyLines = new Map<string, Record<string, number>>();
  renderEntityTypeStub(entries, customTypes, customTypeModules, (entity, property, line) => {
    const bucket = propertyLines.get(entity) ?? {};
    bucket[property] = line;
    propertyLines.set(entity, bucket);
  });
  return { propertyLines };
}

function renderEntityTypeStub(
  entries: readonly EntityTypeStubEntry[],
  customTypes: readonly CustomTypeInfo[],
  customTypeModules: ReadonlyMap<string, string>,
  recordPropertyLine: ((entity: string, property: string, line: number) => void) | null
): string {
  // mailbox 面(pyi ④ 任务1):有方法面的实体配 <Entity>MB(EntityCall)
  // 远端句柄类,方法签名与实体类同源同链(同一 methodArgAnnotation)。
  const anyMailbox = entries.some(entry => entry.methods.length > 0 || entry.role);
  // KBEngine 导入面(GEN-DEF-1b/1c):注解面出现 ARRAY 容器时 FixedArray 一并从
  // KBEngine 导入(运行时容器真实类型,KBEngine.pyi 定义);方法形参注解经
  // ARRAY 别名同链解析也可能落 FixedArray,一并扫。VECTOR2/3/4 属性注解用
  // KBEngine.Vector2/3/4,同样按真实引用导入。
  const kbeAnnotationNames = new Set<string>();
  const collectKbeNames = (annotation: string): void => {
    for (const name of ['FixedArray', 'Vector2', 'Vector3', 'Vector4']) {
      if (new RegExp(`\\b${name}\\b`).test(annotation)) {
        kbeAnnotationNames.add(name);
      }
    }
  };
  for (const entry of entries) {
    for (const property of entry.properties) {
      collectKbeNames(property.annotation);
    }
    for (const method of [...entry.methods, ...(entry.remoteMethods ?? [])]) {
      for (const arg of method.args) {
        collectKbeNames(methodArgAnnotation(arg, customTypes));
      }
    }
  }
  const kbeImportSuffix = [
    ...(anyMailbox ? ['EntityCall'] : []),
    ...[...kbeAnnotationNames].sort()
  ].join(', ');
  const lines = [
    '# Entity stubs generated by kode from *.def and types.xml.',
    '# Manual edits are overwritten. Source comments preserve original lines;',
    '# generated line numbers must never be used to infer source locations.',
    // 导入口径与 kbe_types.pyi 一致(全量固定):注解面可能用到
    // VECTORx→Vector2/3/4、PY_DICT→dict、PY_LIST→list、FIXED_DICT→TypedDict
    // 等 typing 名,缺 import 时 Pylance 直接报未定义(用户实锤)。
    'from typing import Any, Callable, Dict, List, Tuple, TypedDict, Union',
    // 继承面(pyi ④ 任务1):实体类继承 KBEngine 存根 Entity;有 mailbox
    // 面时 EntityCall 也从 KBEngine 导入;注解面引用 FixedArray/Vector 时
    // 一并导(只导注解面真实引用到的名字)。
    `from KBEngine import Entity${kbeImportSuffix ? `, ${kbeImportSuffix}` : ''}`
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
    for (const method of [...entry.methods, ...(entry.remoteMethods ?? [])]) {
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
    if (entry.role) {
      const channels = ['base', 'cell', 'client'] as const;
      for (const channel of channels) {
        if (channel === entry.role) { continue; }
        lines.push('', `class ${entry.entity}${channel[0].toUpperCase()}${channel.slice(1)}MB(EntityCall):`);
        const section = ({ base: 'BaseMethods', cell: 'CellMethods', client: 'ClientMethods' } as const)[channel];
        const methods = (entry.remoteMethods ?? []).filter(m => m.section === section &&
          (entry.role !== 'client' || m.exposed));
        if (methods.length === 0) { lines.push('    pass'); }
        for (const method of methods) { lines.push(...methodFaceLines(method, customTypes)); }
      }
    }
    // mailbox 类先于实体类:实体类的 base/cell/client 注解按名引用它
    // (.pyi 注解不求值,前后引用皆可;就近排放为可读性)。
    if (!entry.role && entry.methods.length > 0) {
      lines.push('', `# Mailbox face: ${entry.entity} 远端句柄,.def 方法面(Base/Cell/Client)`);
      lines.push(`class ${entry.entity}MB(EntityCall):`);
      for (const method of entry.methods) {
        lines.push(...methodFaceLines(method, customTypes));
      }
    }
    lines.push('', `class ${entry.entity}(Entity):`);
    if (!entry.role && entry.properties.length === 0 && entry.methods.length === 0) {
      lines.push('    pass');
      continue;
    }
    if (entry.role) {
      for (const channel of ['base', 'cell', 'client'] as const) {
        if (channel === entry.role) { continue; }
        lines.push(`    ${channel}: Union[${entry.entity}${channel[0].toUpperCase()}${channel.slice(1)}MB, None]`);
      }
    } else if (entry.methods.length > 0) {
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
      recordPropertyLine?.(entry.entity, property.name, lines.length - 1);
    }
    // GEN-DEF-1(用户令 2026-11-02):实体类 __init__ 初始化守卫——仅容器属性
    // (FIXED_DICT/ARRAY)生成 is None 守卫(引擎创建线灌 newDefaultVal 后仍防
    // 手工改库/迁移缺列/外部 delattr/stub 脱离引擎);简单类型不生成,守卫恒
    // `if self.<prop> is None:` 形态,绝不 `if not self.`(falsy 误判重建)。
    // 无容器属性不生成空 __init__;属性面在先,行映射不受守卫段影响。
    const guardProperties = entry.properties.filter(property => property.guardNoneEmpty !== undefined);
    if (guardProperties.length > 0) {
      lines.push('', '    def __init__(self) -> None:');
      for (const property of guardProperties) {
        lines.push(`        if self.${property.name} is None:`);
        lines.push(`            self.${property.name} = ${property.guardNoneEmpty}`);
      }
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
