/**
 * 配置合并可视化投影(docs/design/config-visualization.md §4/§6,KODE-CFG-VIZ-001):
 * core `$/kode/config/resolve` 产出的 defaults/custom/merged 三棵树 → 每键
 * 「仅默认 / 被覆盖 / 仅覆盖文件新增」三态 DTO + 键详情装配。纯投影、零解析:
 * 本模块不读盘、不二次解析,一切数据出自 resolve 树;合成对齐语义镜像
 * config-first.md §2.1(与 Rust core resolve_config、tests/helpers/
 * configCoreContract.mergeConfigXml 同一口径):
 * - 子节点按名对齐;两侧皆单且皆容器 → 递归;
 * - 其余命中形态(单叶替换/形状替换)→ 覆盖侧整名替换;
 * - 重名子节点(重名 `<item>` 表)→ 整表替换(§4.2-2,表内条目全标覆盖)。
 * 重名兄弟用 `name[k]`(1-based)限定路径,保证同路径唯一寻址。
 */

import {
  renderConfigXml,
  type ConfigXmlNode
} from './serverConfigMerge';
import {
  configItemDocBody,
  findServerConfigItemDoc
} from './backend/serverConfigCatalog';

/** 键三态主轴(显式重申不扩主轴,restated 标注,§4.1) */
export type ConfigKeyState = 'defaults-only' | 'overridden' | 'custom-only';

/** 键列表长值截断阈值(§6.1:列表保扫读、详情保真相) */
export const CONFIG_VIZ_LIST_VALUE_LIMIT = 120;

/** 投影输入:ConfigResolvedState 的三树 + 双路径(§2 数据事实) */
export interface ConfigVizTreeInput {
  defaultsTree: ConfigXmlNode | null;
  customTree: ConfigXmlNode | null;
  merged: ConfigXmlNode | null;
  defaultsPath: string | null;
  customPath: string | null;
}

/** 键列表条目(轻量 DTO;详情/片段懒取) */
export interface ConfigVizKeyEntry {
  /** 段内相对点分路径;重名兄弟带 `name[k]` 限定(如 `disables.item[2]`) */
  path: string;
  name: string;
  state: ConfigKeyState;
  /** 覆盖值 === 默认值(显式重申) */
  restated: boolean;
  /** merged 叶值;超 CONFIG_VIZ_LIST_VALUE_LIMIT 截断 + 尾注(truncateNote) */
  finalValue: string;
}

/** 段清单(键全量随包,支撑本地搜索/筛选,§5.1) */
export interface ConfigVizSectionSummary {
  id: string;
  keyCount: number;
  /** 覆盖数(含显式重申) */
  overrideCount: number;
  customOnlyCount: number;
  keys: ConfigVizKeyEntry[];
}

/** resolveState 回包数据(§6;2026-11-11 修正:无 source 字段,数据一律出自 core) */
export interface ConfigVizSummary {
  /** customTree === null(诚实警示条,§5.3) */
  defaultsOnly: boolean;
  defaultsPath: string | null;
  customPath: string | null;
  groups: Array<{
    id: 'process' | 'global';
    sections: ConfigVizSectionSummary[];
  }>;
}

/** selectKey 回包数据:三值对照 + 出处 + 片段(§6) */
export interface ConfigVizKeyDetail {
  sectionId: string;
  path: string;
  state: ConfigKeyState;
  restated: boolean;
  /** 仅覆盖新增 → null */
  defaultValue: string | null;
  /** 仅默认 → null */
  overrideValue: string | null;
  finalValue: string;
  /** 该节点 sourceComments 原文(resolve 树自带,parse 期捕获) */
  sourceComments: string[];
  /** 文案库含义(按显示语言);未收录 → null(如实) */
  catalogDoc: string | null;
  /** 文案出处 file:line(kbengine_defaults.xml:618 形) */
  catalogSource: string | null;
  /** renderConfigXml 子树片段(复制用) */
  fragmentXml: string;
  /** 重名 `<item>` 整表替换标注(§4.2-2) */
  mergedByTableReplace?: boolean;
}

/** 引擎 10 进程段(kbengine_defaults.xml 段名 = 进程名;分组主轴见
 * serverConfigCatalog SERVER_CONFIG_GROUPS 的 process 条目)。顶层段按此
 * 分「进程段/全局段」两组呈现(设计 §3.1)。 */
const PROCESS_SECTION_NAMES: ReadonlySet<string> = new Set([
  'baseapp',
  'baseappmgr',
  'bots',
  'cellapp',
  'cellappmgr',
  'dbmgr',
  'interfaces',
  'logger',
  'loginapp',
  'machine'
]);

/** 内部叶记录(带 merged 节点引用,详情装配/片段渲染直接取用) */
interface ConfigVizLeaf {
  path: string;
  name: string;
  state: ConfigKeyState;
  restated: boolean;
  defaultValue: string | null;
  overrideValue: string | null;
  finalValue: string;
  sourceComments: string[];
  mergedByTableReplace: boolean;
  node: ConfigXmlNode;
}

/**
 * 段层定位(镜像 Rust find_among_layers 口径:伪根一层直挂组件段与
 * `<root>` 包裹二层都认)。真实 kbengine_defaults.xml/kbengine.xml 顶层是
 * `<root>` 包裹,resolve 伪根(name='')下单根名为 root → 返回包裹节点;
 * 测试手搓树直接以 root 为名 → 视作包裹本身;扁平形态原样返回。
 */
function sectionLayer(tree: ConfigXmlNode): ConfigXmlNode {
  if (tree.name === 'root') {
    return tree;
  }
  const [only] = tree.children;
  return tree.children.length === 1 && only.name === 'root' ? only : tree;
}

/** 路径段限定:同名兄弟 >1 时给 `name[k]`(1-based,occurrence 位次) */
function qualifySegment(name: string, sameNameCount: number, occurrence: number): string {
  return sameNameCount > 1 ? `${name}[${occurrence + 1}]` : name;
}

/** 解析路径段:`name[2]` → (name, 2);裸 name → (name, 1) */
function parseSegment(segment: string): { name: string; occurrence: number } {
  const match = /^(.*?)(?:\[(\d+)\])?$/.exec(segment);
  if (!match || (match[1].length === 0 && match[2] === undefined)) {
    return { name: segment, occurrence: 1 };
  }
  return {
    name: match[1],
    occurrence: match[2] !== undefined ? Number(match[2]) : 1
  };
}

/** 路径段还原为文案库查询用裸名(剥 `[k]` 限定) */
function unqualifySegment(segment: string): string {
  return parseSegment(segment).name;
}

/** 按(限定)路径段序列在树内寻址:重名段按 occurrence 位次取第 k 个 */
function navigate(root: ConfigXmlNode, segments: readonly string[]): ConfigXmlNode | null {
  let current: ConfigXmlNode | null = root;
  for (const segment of segments) {
    if (!current) {
      return null;
    }
    const { name, occurrence } = parseSegment(segment);
    current = current.children.filter(child => child.name === name)[occurrence - 1] ?? null;
  }
  return current;
}

/**
 * 三树对齐投影(镜像 mergeConfigXml 四分支,见文件头),递归收集 merged 树
 * 全部叶记录:
 * - defaults/custom 同名位次对齐(重名表按位次一一对应);
 * - 两侧皆单且皆容器 → 常规递归(表内叶按值相等算 restated);
 * - 同名多命中(任一侧)→ 整表替换:merged 子树 = 覆盖侧,表内条目全标
 *   覆盖(§4.2-2)+ mergedByTableReplace;表内 restated 仍按位次对齐的
 *   defaults 叶如实计算(重申不伪装成有效修改,§4.1);
 * - 单侧子树/形状替换:叶面按 defaults/custom 在位与否定三态——容器整名
 *   替换下 defaults 侧已有的名 = 覆盖,覆盖容器里的新名 = 新增(§4.2-1)。
 */
function collectLeaves(
  defaults: ConfigXmlNode | null,
  custom: ConfigXmlNode | null,
  merged: ConfigXmlNode,
  tableReplace: boolean,
  prefix: string,
  out: ConfigVizLeaf[]
): void {
  if (merged.children.length === 0) {
    const defaultsIsLeaf = defaults !== null && defaults.children.length === 0;
    const customIsLeaf = custom !== null && custom.children.length === 0;
    const bothLeaves = defaultsIsLeaf && customIsLeaf;
    let state: ConfigKeyState;
    if (tableReplace) {
      // §4.2-2:整表替换的表内条目全标覆盖(默认侧同位叶存在与否不影响主轴)
      state = 'overridden';
    } else if (custom === null) {
      state = 'defaults-only';
    } else if (defaults === null) {
      state = 'custom-only';
    } else {
      // 两侧都有:覆盖命中(merged = 覆盖侧产物);形状替换(容器换叶/叶换
      // 容器)同归覆盖——键在 defaults 里存在过,不装「纯新增」(§4.2-1)
      state = 'overridden';
    }
    out.push({
      path: prefix,
      name: merged.name,
      state,
      restated: bothLeaves && defaults!.text === custom!.text,
      defaultValue: defaultsIsLeaf ? defaults!.text : null,
      overrideValue: customIsLeaf ? custom!.text : null,
      finalValue: merged.text,
      sourceComments: merged.sourceComments ?? [],
      mergedByTableReplace: tableReplace,
      node: merged
    });
    return;
  }
  // merged 子节点按名分组(保持首次出现序;重名 = 表,位次对齐两侧同名位次)
  const mergedNames: string[] = [];
  for (const child of merged.children) {
    if (!mergedNames.includes(child.name)) {
      mergedNames.push(child.name);
    }
  }
  for (const name of mergedNames) {
    const mergedOnes = merged.children.filter(child => child.name === name);
    const defaultsOnes = defaults ? defaults.children.filter(child => child.name === name) : [];
    const customOnes = custom ? custom.children.filter(child => child.name === name) : [];
    const sameNameCount = mergedOnes.length;
    for (let k = 0; k < mergedOnes.length; k += 1) {
      const mergedChild = mergedOnes[k];
      const defaultsChild = defaultsOnes[k] ?? null;
      const customChild = customOnes[k] ?? null;
      const childPath =
        (prefix.length > 0 ? `${prefix}.` : '') + qualifySegment(name, sameNameCount, k);
      const recurseBothContainers =
        defaultsChild !== null &&
        customChild !== null &&
        defaultsOnes.length === 1 &&
        customOnes.length === 1 &&
        defaultsChild.children.length > 0 &&
        customChild.children.length > 0;
      if (defaultsOnes.length > 1 || customOnes.length > 1) {
        // 整表替换:merged 子树 = 覆盖侧,表内条目全标覆盖(§4.2-2);
        // defaults 同位叶仍随下传供 restated 如实对拍
        collectLeaves(defaultsChild, customChild, mergedChild, true, childPath, out);
      } else if (recurseBothContainers) {
        // 常规递归:两侧同名容器逐名对齐下钻(§4.1 merge 语义)
        collectLeaves(defaultsChild, customChild, mergedChild, tableReplace, childPath, out);
      } else {
        // 单侧子树(纯 defaults/custom 递归)或单命中形状替换:
        // 叶面按 defaults/custom 在位与否定三态
        collectLeaves(defaultsChild, customChild, mergedChild, tableReplace, childPath, out);
      }
    }
  }
}

/** 单段投影:merged 段 + 两侧同名段 → 叶记录集 */
function collectSectionLeaves(
  defaultsTree: ConfigXmlNode | null,
  customTree: ConfigXmlNode | null,
  mergedSection: ConfigXmlNode
): ConfigVizLeaf[] {
  const defaultsSection =
    defaultsTree
      ? sectionLayer(defaultsTree).children.find(child => child.name === mergedSection.name) ?? null
      : null;
  const customSection =
    customTree
      ? sectionLayer(customTree).children.find(child => child.name === mergedSection.name) ?? null
      : null;
  const leaves: ConfigVizLeaf[] = [];
  collectLeaves(defaultsSection, customSection, mergedSection, false, '', leaves);
  return leaves;
}

/** 叶记录 → 键列表条目(长值截断 + 尾注;详情区完整值不受影响,§6.1) */
function toKeyEntry(
  leaf: ConfigVizLeaf,
  truncateNote?: (chars: number) => string
): ConfigVizKeyEntry {
  let finalValue = leaf.finalValue;
  if (finalValue.length > CONFIG_VIZ_LIST_VALUE_LIMIT) {
    const note = truncateNote ? truncateNote(finalValue.length) : '';
    finalValue = finalValue.slice(0, CONFIG_VIZ_LIST_VALUE_LIMIT) + note;
  }
  return {
    path: leaf.path,
    name: leaf.name,
    state: leaf.state,
    restated: leaf.restated,
    finalValue
  };
}

/**
 * 全量投影:resolve 三树 → 段清单(§6 ConfigVizSummary)。
 * defaultsTree/merged 缺失返回 null(§8-4 无配置文件空态,不伪造三态);
 * customTree === null → defaultsOnly(§5.3 诚实警示条)。顶层段按引擎
 * 10 进程段分「进程段/全局段」两组(§3.1)。
 */
export function buildConfigVizSummary(
  input: ConfigVizTreeInput,
  options?: { truncateNote?: (chars: number) => string }
): ConfigVizSummary | null {
  const { defaultsTree, customTree, merged, defaultsPath, customPath } = input;
  if (!defaultsTree || !merged) {
    return null;
  }
  const process: ConfigVizSectionSummary[] = [];
  const global: ConfigVizSectionSummary[] = [];
  for (const section of sectionLayer(merged).children) {
    const entries = collectSectionLeaves(defaultsTree, customTree, section).map(leaf =>
      toKeyEntry(leaf, options?.truncateNote)
    );
    const summary: ConfigVizSectionSummary = {
      id: section.name,
      keyCount: entries.length,
      overrideCount: entries.filter(entry => entry.state === 'overridden').length,
      customOnlyCount: entries.filter(entry => entry.state === 'custom-only').length,
      keys: entries
    };
    if (PROCESS_SECTION_NAMES.has(section.name)) {
      process.push(summary);
    } else {
      global.push(summary);
    }
  }
  return {
    defaultsOnly: customTree === null,
    defaultsPath,
    customPath,
    groups: [
      { id: 'process', sections: process },
      { id: 'global', sections: global }
    ]
  };
}

/**
 * 键详情装配(§4.3/§6 ConfigVizKeyDetail):三值对照 + sourceComments 原文 +
 * 文案库含义(findServerConfigItemDoc 三级回落,未收录如实 null)+ 复制用
 * renderConfigXml 子树片段。键不在 merged 树内返回 null(前端保持原详情)。
 */
export function buildConfigVizKeyDetail(
  input: ConfigVizTreeInput,
  sectionId: string,
  path: string,
  language?: string
): ConfigVizKeyDetail | null {
  const { defaultsTree, customTree, merged } = input;
  if (!defaultsTree || !merged) {
    return null;
  }
  const section = sectionLayer(merged).children.find(child => child.name === sectionId);
  if (!section) {
    return null;
  }
  const segments = path.length > 0 ? path.split('.') : [];
  const node = navigate(section, segments);
  if (!node) {
    return null;
  }
  // 叶面三态/重申/整表标注优先取投影记录(与列表判定同源);容器路径
  // (不在叶清单里)按节点在位对齐兜底,不虚构值。
  const leaf =
    collectSectionLeaves(defaultsTree, customTree, section).find(
      entry => entry.path === path
    ) ?? null;
  const defaultsSection =
    sectionLayer(defaultsTree).children.find(child => child.name === sectionId) ?? null;
  const customSection = customTree
    ? sectionLayer(customTree).children.find(child => child.name === sectionId) ?? null
    : null;
  const defaultsNode = defaultsSection ? navigate(defaultsSection, segments) : null;
  const customNode = customSection ? navigate(customSection, segments) : null;
  const defaultsIsLeaf = defaultsNode !== null && defaultsNode.children.length === 0;
  const customIsLeaf = customNode !== null && customNode.children.length === 0;
  const state: ConfigKeyState = leaf
    ? leaf.state
    : customNode === null
      ? 'defaults-only'
      : defaultsNode === null
        ? 'custom-only'
        : 'overridden';
  const doc = findServerConfigItemDoc([sectionId, ...segments.map(unqualifySegment)]);
  return {
    sectionId,
    path,
    state,
    restated: leaf
      ? leaf.restated
      : defaultsIsLeaf && customIsLeaf && defaultsNode!.text === customNode!.text,
    defaultValue: leaf ? leaf.defaultValue : defaultsIsLeaf ? defaultsNode!.text : null,
    overrideValue: leaf ? leaf.overrideValue : customIsLeaf ? customNode!.text : null,
    finalValue: node.text,
    sourceComments: node.sourceComments ?? [],
    catalogDoc: doc ? configItemDocBody(doc, language) : null,
    catalogSource: doc ? doc.source : null,
    fragmentXml: renderConfigXml(node, 0),
    mergedByTableReplace: leaf?.mergedByTableReplace
  };
}
