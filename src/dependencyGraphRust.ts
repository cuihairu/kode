/**
 * IDE-RUST-007:def 依赖图 Rust 核心接线。
 *
 * 图拓扑推导在 Rust(`$/kode/dependency/graph`);本模块只做输入收集
 * (entities.xml/types.xml/全部 def 原文+路径+分类、python 实现文件路径、
 * user_type 实现路径)与结果形状校验。Rust 不可用(无 gate/调用失败/形状
 * 不符)返回 null,由调用方回落到现有 TS EntityDependencyAnalyzer(降级视图)。
 *
 * python 文件路径解析保留 TS(脚本目录约定 + ImplementedBy 模块解析,配置/
 * 文件系统感知,与 entityMapping/definitionWorkspace 同源);图拓扑推导归 Rust。
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  findEntityDefsDirForDefFile,
  getCustomTypeInfos,
  getDefinitionWorkspaceLayout,
  readWorkspaceTextFile,
  scriptFoldersForRole,
} from './definitionWorkspace';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { findFilesAcrossRoots } from './scanRoots';

/** Rust 依赖图节点(kind 六员;entity 带 types,type 带 implFile 视有无)。 */
export interface DependencyGraphRustNode {
  readonly id: string;
  readonly kind: 'entity' | 'def' | 'interface' | 'component' | 'type' | 'python';
  readonly name: string;
  readonly filePath: string;
  readonly types?: string[];
  readonly implFile?: string;
}

/** Rust 依赖图边(kind 七员:registration/inheritance/is-a/has-a/property-type/
 * implements/method-impl;has-a/property-type 带 label)。 */
export interface DependencyGraphRustEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly label?: string;
}

export interface DependencyGraphRustStats {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly entityCount: number;
  readonly defCount: number;
  readonly interfaceCount: number;
  readonly componentCount: number;
  readonly typeCount: number;
  readonly pythonCount: number;
}

/** Rust `$/kode/dependency/graph` 完整结果。 */
export interface DependencyGraphRust {
  readonly nodes: DependencyGraphRustNode[];
  readonly edges: DependencyGraphRustEdge[];
  readonly reverseEdges: Record<string, Array<{ from: string; kind: string; label?: string }>>;
  readonly paths: { entitiesXml: string; defsRoot: string; typesXml: string };
  readonly stats: DependencyGraphRustStats;
}

const KIND_SET = new Set(['entity', 'def', 'interface', 'component', 'type', 'python']);

/** 结果形状校验:不合规返回 false,调用方回落 TS 兜底。 */
function shapeCheckDependencyGraph(value: unknown): value is DependencyGraphRust {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const g = value as Record<string, unknown>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    return false;
  }
  if (typeof g.reverseEdges !== 'object' || g.reverseEdges === null) {
    return false;
  }
  const paths = g.paths as Record<string, unknown> | undefined;
  if (!paths || typeof paths.entitiesXml !== 'string' || typeof paths.defsRoot !== 'string' || typeof paths.typesXml !== 'string') {
    return false;
  }
  const stats = g.stats as Record<string, unknown> | undefined;
  if (!stats || typeof stats.nodeCount !== 'number') {
    return false;
  }
  for (const n of g.nodes as unknown[]) {
    const node = n as Record<string, unknown>;
    if (typeof node.id !== 'string' || typeof node.kind !== 'string' || !KIND_SET.has(node.kind)) {
      return false;
    }
  }
  return true;
}

/** def 目录分类:按与 entityDefsRoot/interfacesRoot/componentsRoot 的前缀关系。 */
function classifyDefPath(layout: ReturnType<typeof getDefinitionWorkspaceLayout>, filePath: string): string {
  const under = (root: string | null): boolean =>
    root !== null && (filePath === root || filePath.startsWith(`${root}${path.sep}`));
  if (under(layout.interfacesRoot)) {
    return 'interface';
  }
  if (under(layout.componentsRoot)) {
    return 'component';
  }
  if (under(layout.entityDefsRoot)) {
    return 'entity';
  }
  return 'def';
}

/** 收集全部 .def 原文 + 路径 + 分类(实体/接口/组件/其他)。 */
async function collectDependencyDefs(
  root: string
): Promise<{ defs: Record<string, string>; paths: Record<string, string>; categories: Record<string, string> }> {
  const layout = getDefinitionWorkspaceLayout(root);
  const defs: Record<string, string> = {};
  const paths: Record<string, string> = {};
  const categories: Record<string, string> = {};
  const files = await findFilesAcrossRoots('**/*.def', null);
  for (const file of files) {
    const filePath = file.fsPath;
    const name = path.basename(filePath, '.def');
    if (name === '') {
      continue;
    }
    defs[name] = readWorkspaceTextFile(filePath);
    paths[name] = filePath;
    categories[name] = classifyDefPath(layout, filePath);
  }
  return { defs, paths, categories };
}

/**
 * python 实现文件候选(仅返回存在的文件):与 entityMapping 的脚本目录约定
 * 同源(脚本根四形态 + 角色目录 + 接口单/复数 + Interface_ 变体 + 组件
 * components/ 嵌套),按 def 分类跨 base/cell/client 取并集。
 */
function collectPythonFilesForDefs(
  root: string,
  entries: Array<{ name: string; category: string; filePath: string }>
): Record<string, string[]> {
  const layout = getDefinitionWorkspaceLayout(root);
  const baseRoots: string[] = [
    layout.entityScriptsRoot ?? '',
    path.join(root, 'scripts'),
    path.join(root, 'assets', 'scripts'),
    path.join(root, 'server_assets', 'scripts'),
  ].filter((r) => r.length > 0);
  const roles: Array<'base' | 'cell' | 'client'> = ['base', 'cell', 'client'];
  const result: Record<string, string[]> = {};

  for (const entry of entries) {
    const roots = [...baseRoots];
    // 资产根不在工作区根本身(<repo>/<xxx>_assets 布局)时,按 def 所在
    // entity_defs 父目录反推 scripts 根(与 entityMapping getPythonScriptRoots 同)。
    const defsDir = findEntityDefsDirForDefFile(entry.filePath);
    if (defsDir) {
      const parent = path.dirname(defsDir);
      if (!roots.includes(parent)) {
        roots.push(parent);
      }
    }

    const files = new Set<string>();
    const addIfExists = (p: string): void => {
      if (p.length > 0 && fs.existsSync(p)) {
        files.add(p);
      }
    };
    for (const scriptRoot of roots) {
      if (entry.category === 'entity') {
        for (const role of roles) {
          for (const folder of scriptFoldersForRole(role)) {
            addIfExists(path.join(scriptRoot, folder, `${entry.name}.py`));
          }
        }
        addIfExists(path.join(scriptRoot, `${entry.name}.py`));
      } else if (entry.category === 'component') {
        for (const role of roles) {
          for (const folder of scriptFoldersForRole(role)) {
            addIfExists(path.join(scriptRoot, folder, 'components', `${entry.name}.py`));
          }
        }
      } else if (entry.category === 'interface') {
        for (const role of roles) {
          for (const folder of ['interfaces', `${role}/interfaces`, 'interface', `${role}/interface`]) {
            addIfExists(path.join(scriptRoot, folder, `${entry.name}.py`));
            addIfExists(path.join(scriptRoot, folder, `Interface_${entry.name}.py`));
          }
        }
      }
    }
    if (files.size > 0) {
      result[entry.name] = [...files];
    }
  }
  return result;
}

/** user_type 实现路径:getCustomTypeInfos 已解析 implementedBy → pythonFilePath。 */
function collectTypeImpls(root: string): Record<string, string> {
  const impls: Record<string, string> = {};
  for (const info of getCustomTypeInfos(root)) {
    if (info.pythonFilePath) {
      impls[info.name] = info.pythonFilePath;
    }
  }
  return impls;
}

/**
 * 主路径:Rust 核心推导依赖图。Rust 不可用或结果不合规返回 null,
 * 由调用方回落到 TS EntityDependencyAnalyzer(降级 entity→entity 图)。
 */
export async function buildDependencyGraphInRust(root: string): Promise<DependencyGraphRust | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const layout = getDefinitionWorkspaceLayout(root);
  const { defs, paths, categories } = await collectDependencyDefs(root);
  const defEntries = Object.keys(defs).map((name) => ({ name, category: categories[name] ?? 'def', filePath: paths[name] }));
  const pythonFiles = collectPythonFilesForDefs(root, defEntries);
  const typeImpls = collectTypeImpls(root);

  const response = await gate.runInRust<DependencyGraphRust>('$/kode/dependency/graph', {
    entitiesXml: layout.entitiesXmlPath ? readWorkspaceTextFile(layout.entitiesXmlPath) : '',
    typesXml: layout.typesXmlPath ? readWorkspaceTextFile(layout.typesXmlPath) : '',
    defsRoot: layout.entityDefsRoot ?? '',
    entitiesXmlPath: layout.entitiesXmlPath ?? '',
    typesXmlPath: layout.typesXmlPath ?? '',
    defs,
    paths,
    categories,
    pythonFiles,
    typeImpls,
  });
  if (!response.ok) {
    return null;
  }
  if (!shapeCheckDependencyGraph(response.result)) {
    return null;
  }
  return response.result;
}
