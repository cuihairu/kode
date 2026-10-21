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
  PYTHON_TYPE_STUB_FALLBACK
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
      { includeMethods }
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
    return { annotation: trimmed, customTypeLine: customType.line };
  }
  if (trimmed === 'ARRAY') {
    return { annotation: `list[${PYTHON_TYPE_STUB_FALLBACK}]` };
  }
  return {
    annotation: PYTHON_BUILTIN_TYPE_ANNOTATIONS[trimmed] ?? PYTHON_TYPE_STUB_FALLBACK
  };
}

export function buildEntityTypeStubPlan(
  mappings: readonly EntityMapping[],
  customTypes: readonly CustomTypeInfo[],
  options: { includeMethods?: boolean } = {}
): EntityTypeStubPlan {
  const context: EntityStubContext = {
    customTypes: new Map(customTypes.map(info => [info.name, info]))
  };
  // 方法面开关(用户令 2026-10-21):默认含方法面;includeMethods=false 时
  // 方法表整体留空,只有方法的实体随之落出存根(属性面不受影响)。
  const includeMethods = options.includeMethods !== false;
  const entries = [...mappings]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(mapping => {
      return {
        entity: mapping.name,
        properties: Object.entries(mapping.properties)
          .map(([name, location]) => {
            const withDefinitions = mapping as EntityMapping & {
              propertyDefinitions?: Array<{ identity: { symbolName: string }; typeName?: string }>
            };
            const propertyInfo = withDefinitions.propertyDefinitions?.find(
              definition => definition.identity.symbolName === name
            );
            const resolved = annotationForDefType(propertyInfo?.typeName, context);
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
    content: entries.length === 0 ? null : buildEntityTypeStubContent(entries),
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

export function buildEntityTypeStubContent(entries: readonly EntityTypeStubEntry[]): string {
  const lines = [
    '# Entity stubs generated by kode from *.def and types.xml.',
    '# Manual edits are overwritten. Source comments preserve original lines;',
    '# generated line numbers must never be used to infer source locations.',
    'from typing import Any'
  ];
  for (const entry of entries) {
    lines.push('', `class ${entry.entity}:`);
    if (entry.properties.length === 0 && entry.methods.length === 0) {
      lines.push('    pass');
      continue;
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
      lines.push('', `    # source: .def:${method.sourceLine} (${method.section})`);
      const parameters = method.args.map((arg, index) =>
        `${pythonParameterName(arg, index)}: ${methodArgAnnotation(arg)}`
      );
      lines.push(`    def ${method.name}(${parameters.join(', ')}) -> None: ...`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function pythonParameterName(typeName: string, index: number): string {
  return `arg${index + 1}`;
}

function methodArgAnnotation(typeName: string): string {
  const trimmed = typeName.trim();
  if (!trimmed || trimmed === 'ARRAY') {
    return PYTHON_TYPE_STUB_FALLBACK;
  }
  return PYTHON_BUILTIN_TYPE_ANNOTATIONS[trimmed] ?? PYTHON_TYPE_STUB_FALLBACK;
}
