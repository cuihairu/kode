/**
 * KSEM-CFG-03 统一配置字段身份(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md SEM-033,旧 KSEM-CFG-03):以配置根/层级路径/工程/版本
 * 定位字段;map 动态键与固定对象字段区分。
 *
 * 字段身份四轴(CFG-02 契约记录之上的定位层):
 *  - root:配置根('defaults' 引擎默认 / 'custom' 项目覆盖文件 / 'final'
 *    合成最终配置);
 *  - path:点分层级路径(去 <root> 包裹,与 serverConfigCatalog 键同口径);
 *  - project:工程标识(调用方传入的资产根指纹;null=纯引擎默认);
 *  - version:引擎快照锚(942 行 baseline,CFG-02 同源)。
 *
 * 动态键区分(与 CFG-02 的 dynamicKeys 不冲突——那是「引擎是否迭代未知
 * 子节点」的行为面,无证据不记;本模块是**结构观察面**):
 *  - fixed:字段名在引擎 defaults 快照可枚举;
 *  - dynamic-extension:字段只出现在项目 custom 树(结构上可证:defaults
 *    里无同名兄弟),身份串内标记段名,定位仍可达。
 *
 * 纯逻辑模块:输入已解析树(parseConfigXml 产物)+定位轴,输出身份串/
 * 溯源分类;不读文件不读配置不 import vscode。
 */
import type { ConfigXmlNode } from '../serverConfigMerge';

export type ConfigRootKind = 'defaults' | 'custom' | 'final';

export interface ConfigFieldLocator {
  root: ConfigRootKind;
  path: string;
  /** 工程标识(资产根指纹/路径;null=纯引擎默认) */
  project: string | null;
  /** 引擎快照锚(如 'kbengine-defaults-942') */
  version: string;
}

export interface ParsedConfigFieldIdentity {
  root: ConfigRootKind;
  project: string | null;
  version: string;
  path: string;
  /** 路径中属动态扩展段的段名(custom-only 段),按序 */
  dynamicSegments: readonly string[];
}

/**
 * 合成字段身份串(可解析往返):
 * `{root}://{project}@{version}/{path}`;动态段在段名前加 `~` 标记:
 * `final://proj-a@kbengine-defaults-942/myservice~.host`——`myservice~`
 * 表示该段是项目动态扩展段,非引擎固定对象字段。
 */
export function configFieldIdentity(
  locator: ConfigFieldLocator,
  dynamicSegments: readonly string[] = [],
): string {
  const markedPath = markDynamicSegments(locator.path, dynamicSegments);
  const project = locator.project ?? '';
  return `${locator.root}://${project}@${locator.version}/${markedPath}`;
}

/** 段名加动态标记(与 dynamicSegments 对应的层级段);不存在则原样返回 */
function markDynamicSegments(path: string, dynamicSegments: readonly string[]): string {
  if (dynamicSegments.length === 0) {
    return path;
  }
  const segments = path.split('.');
  const dynamicSet = new Set(dynamicSegments);
  return segments.map((segment) => (dynamicSet.has(segment) ? `${segment}~` : segment)).join('.');
}

const ROOT_KINDS: readonly ConfigRootKind[] = ['defaults', 'custom', 'final'];

/** 身份串解析(往返);非良构返回 null——不猜。 */
export function parseConfigFieldIdentity(id: string): ParsedConfigFieldIdentity | null {
  // version 不容 '@'(project 含 '@' 时整体不匹配——往返完整性优先)
  const schemeMatch = id.match(/^(defaults|custom|final):\/\/([^@/]*)@([^/@]+)\/(.+)$/);
  if (!schemeMatch) {
    return null;
  }
  const [, rootKind, project, version, markedPath] = schemeMatch;
  if (!ROOT_KINDS.includes(rootKind as ConfigRootKind) || markedPath.length === 0) {
    return null;
  }
  const dynamicSegments: string[] = [];
  const path = markedPath
    .split('.')
    .map((segment) => {
      if (segment.endsWith('~')) {
        const name = segment.slice(0, -1);
        if (name.length === 0) {
          return null;
        }
        dynamicSegments.push(name);
        return name;
      }
      return segment;
    })
    .join('.');
  if (path.includes('~') || markedPath.startsWith('.') || markedPath.endsWith('.')) {
    return null;
  }
  return {
    root: rootKind as ConfigRootKind,
    project: project.length > 0 ? project : null,
    version,
    path,
    dynamicSegments,
  };
}

export type ConfigFieldIdentityKind = 'fixed' | 'dynamic-extension' | 'dynamic-segment-child';

export interface ConfigFieldProvenance {
  path: string;
  /** 定义层:defaults 快照含该路径 / custom 项目树含该路径 */
  definedInDefaults: boolean;
  definedInCustom: boolean;
  /** custom 覆盖了 defaults 同名字段(defaults+custom 同在) */
  overriddenByCustom: boolean;
  kind: ConfigFieldIdentityKind;
  /** dynamic-extension/segment-child 时:路径中 defaults 不存在的段名(按序) */
  dynamicSegments: readonly string[];
}

function childByName(node: ConfigXmlNode, name: string): ConfigXmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

/**
 * parseConfigXml 产物是空名合成文档节点(真 <root> 是其子)——归一到
 * <root> 节点;调用方直接传 <root> 节点则原样返回。
 */
function normalizeRootNode(tree: ConfigXmlNode): ConfigXmlNode {
  if (tree.name === '') {
    const rootChild = childByName(tree, 'root');
    if (rootChild !== undefined) {
      return rootChild;
    }
  }
  return tree;
}

/** 路径逐段下行;走到头返回节点,任一段缺失返回 undefined */
function descend(node: ConfigXmlNode, segments: string[]): ConfigXmlNode | undefined {
  let current: ConfigXmlNode | undefined = node;
  for (const segment of segments) {
    if (current === undefined) {
      return undefined;
    }
    current = childByName(current, segment);
  }
  return current;
}

function segmentsOf(path: string): string[] {
  return path.split('.').filter((segment) => segment.length > 0);
}

/**
 * 单字段溯源分类。动态段=路径中**首个** defaults 快照缺失的段(其后代
 * 段不再重复登记——它们是动态段的子字段,不是新的动态段)。
 */
export function classifyConfigField(
  defaultsTree: ConfigXmlNode,
  customTree: ConfigXmlNode | null,
  path: string,
): ConfigFieldProvenance {
  const defaultsRoot = normalizeRootNode(defaultsTree);
  const segments = segmentsOf(path);
  const dynamicSegments: string[] = [];
  let defaultsCursor: ConfigXmlNode | undefined = defaultsRoot;
  let defaultsLost = false;
  let lostAtIndex = -1;
  segments.forEach((segment, index) => {
    if (defaultsLost) {
      return;
    }
    const next = defaultsCursor === undefined ? undefined : childByName(defaultsCursor, segment);
    if (next === undefined) {
      dynamicSegments.push(segment);
      defaultsLost = true;
      lostAtIndex = index;
      defaultsCursor = undefined;
    } else {
      defaultsCursor = next;
    }
  });
  const definedInDefaults = dynamicSegments.length === 0;
  const customNode = customTree === null ? undefined : descend(normalizeRootNode(customTree), segments);
  const definedInCustom = customNode !== undefined;
  // 动态段不是路径末端 → 其子字段:段子字段(非新动态段)
  const parentDynamic = dynamicSegments.length > 0 && lostAtIndex < segments.length - 1;
  const kind: ConfigFieldIdentityKind = parentDynamic
    ? 'dynamic-segment-child'
    : dynamicSegments.length > 0
      ? 'dynamic-extension'
      : 'fixed';
  return {
    path,
    definedInDefaults,
    definedInCustom,
    overriddenByCustom: definedInDefaults && definedInCustom,
    kind,
    dynamicSegments,
  };
}

/** 树的全部叶子+容器路径(点分;跳过 <root> 与合成文档包裹;item 列表计容器)。 */
export function collectConfigTreePaths(node: ConfigXmlNode, prefix = ''): string[] {
  const rootNode = prefix === '' ? normalizeRootNode(node) : node;
  const paths: string[] = [];
  for (const child of rootNode.children) {
    const childPath = prefix.length > 0 ? `${prefix}.${child.name}` : child.name;
    if (child.children.length === 0) {
      paths.push(childPath);
    } else if (child.children.every((grandchild) => grandchild.name === 'item')) {
      // <item> 列表:容器本身是字段(与 CFG-02 list 记录同口径)
      paths.push(childPath);
    } else {
      paths.push(childPath, ...collectConfigTreePaths(child, childPath));
    }
  }
  return paths;
}

export interface ConfigFieldIdentityScan {
  fields: readonly ConfigFieldProvenance[];
  fixed: number;
  dynamicExtension: number;
  dynamicSegmentChild: number;
  overridden: number;
}

/** 双树全量对扫:合并 defaults 可枚举字段与 custom 独有字段,逐条溯源。 */
export function scanConfigFieldIdentities(
  defaultsTree: ConfigXmlNode,
  customTree: ConfigXmlNode | null,
): ConfigFieldIdentityScan {
  const pathSet = new Set<string>(collectConfigTreePaths(normalizeRootNode(defaultsTree)));
  if (customTree !== null) {
    for (const path of collectConfigTreePaths(normalizeRootNode(customTree))) {
      pathSet.add(path);
    }
  }
  const fields = [...pathSet]
    .sort()
    .map((path) => classifyConfigField(defaultsTree, customTree, path));
  return {
    fields,
    fixed: fields.filter((f) => f.kind === 'fixed').length,
    dynamicExtension: fields.filter((f) => f.kind === 'dynamic-extension').length,
    dynamicSegmentChild: fields.filter((f) => f.kind === 'dynamic-segment-child').length,
    overridden: fields.filter((f) => f.overriddenByCustom).length,
  };
}
