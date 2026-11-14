/**
 * KSEM-CFG-02 配置权威契约提取(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md SEM-032,旧 KSEM-CFG-02):提取配置权威契约——关联引擎
 * 读取源码、默认 XML、已有 schema;记录类型、枚举、单位、范围、可重复节点、
 * 动态键和版本,**不从默认值猜全部约束**。
 *
 * 证据分级(每条契约记录必须携带,测试锁死):
 *  - 'engine-read-site'        目录锚指向引擎读取点(serverconfig.cpp 等);
 *  - 'defaults-type-annotation' 默认 XML 注释内联 `Type: X` 声明(48 处);
 *  - 'defaults-enum-comment'    默认 XML 注释枚举块(`N: 含义` 行 ≥2);
 *  - 'defaults-comment'         其他注释证据(可重复节点、单位等);
 *  - 'defaults-value-only'      仅默认值形态——**候选,非约束**(验收诚实
 *    条款:单值形态不证明类型全貌,更不证明范围)。
 *
 * 不猜的面(每条记录 unproven 明示,永不虚称):
 *  - 范围:任何证据源都不证明数值上下界(注释里的 `(1400)` 是默认值提示
 *    不是上界),unproven 恒含 'range';
 *  - 动态键:引擎对未知子节点的迭代行为无本地证据,恒 false 且入 unproven;
 *  - 逐键版本:无 since-version 证据;版本维度=引擎默认配置快照钉死
 *    (extraction.baseline),不在逐键上编造。
 *
 * 纯逻辑模块:输入默认 XML 原文+已解析树(parseConfigXml 产物,KODE-CFG-002
 * Rust 核/TS 回落核单一事实源)+ 目录取证表(SERVER_CONFIG_ITEM_DOCS 的
 * path→source),输出契约记录;不读文件不读配置不 import vscode。
 */
import type { ConfigXmlNode } from '../serverConfigMerge';

export type ContractEvidenceKind =
  | 'engine-read-site'
  | 'defaults-type-annotation'
  | 'defaults-enum-comment'
  | 'defaults-comment'
  | 'defaults-value-only';

export type ContractValueKind =
  | 'integer'
  | 'integer8'
  | 'float'
  | 'boolean'
  | 'string'
  | 'enum'
  | 'list'
  | 'unknown';

export interface ContractEnumValue {
  value: string;
  meaning: string;
}

export interface ConfigContractRecord {
  /** 点分路径(去 <root> 包裹;与 serverConfigCatalog 键同口径) */
  path: string;
  valueKind: ContractValueKind;
  evidence: ContractEvidenceKind;
  /** 仅枚举注释块命中时非空 */
  enumValues: readonly ContractEnumValue[];
  /** 注释文本命名的单位(秒/毫秒/bit/…),无证据为 null */
  unit: string | null;
  /** `<item>` 子节点重复模式(trace_packet.disables 等) */
  repeatable: boolean;
  /** 动态键面(登记时点无引擎迭代证据,恒 false 且入 unproven) */
  dynamicKeys: boolean;
  /** 证据锚(注释文本摘录 / 目录 serverconfig.cpp 锚) */
  source: string;
  /** 本记录未证明的约束维度——诚实面,永不虚称已证 */
  unproven: readonly string[];
  /** true=仅默认值形态候选(非约束;不从默认值猜全部约束) */
  valueOnlyCandidate: boolean;
}

export interface ConfigContractBaseline {
  /** 引擎默认配置快照(版本维度钉死处) */
  file: string;
  /** 原文行数;null=运行时仅持解析树未读原文(快照行数未知,诚实标注) */
  lineCount: number | null;
  note: string;
}

export interface ConfigContractStats {
  total: number;
  typed: number;
  enumCommented: number;
  repeatableNodes: number;
  unitsNamed: number;
  valueOnly: number;
  engineReadSite: number;
}

export interface ConfigContractExtraction {
  records: readonly ConfigContractRecord[];
  baseline: ConfigContractBaseline;
  stats: ConfigContractStats;
}

/** 注释里可证的单位词(范围值如 `(1400)` 不入表——那是默认提示不是单位) */
const UNIT_WORDS = ['秒', '毫秒', '字节', 'bit', 'seconds', 'milliseconds', 'bytes'] as const;

const TYPE_ANNOTATION_MAP: Readonly<Record<string, ContractValueKind>> = {
  Integer: 'integer',
  Integer8: 'integer8',
  Float: 'float',
  Boolean: 'boolean',
  String: 'string',
};

function isLeaf(node: ConfigXmlNode): boolean {
  return node.children.length === 0;
}

function commentsText(node: ConfigXmlNode): string {
  return (node.sourceComments ?? []).join('\n');
}

/** 注释内联 `<!-- Type: X -->` 声明(值注解,如 `<!-- Type: Integer -->`) */
function typeAnnotation(comments: string): { kind: ContractValueKind; raw: string } | null {
  const match = comments.match(/Type:\s*(Integer8|Integer|Float|Boolean|String)/);
  if (!match) {
    return null;
  }
  return { kind: TYPE_ANNOTATION_MAP[match[1]], raw: match[0] };
}

/**
 * 注释枚举组,两种形态都收(trace_packet.debug_type、publish.state):
 *  - 匿名组:数值行不带 header(如 publish.state 的 `0 : debug` 紧跟
 *    `Type: Integer8` 之后),挂在**持有该注释的元素自身**;
 *  - 具名组:`debug_type:` header 行之后的数值行——常见于**父段注释块**,
 *    header 与直接子叶同名才传播到该子(trace_packet 注释里的 debug_type 组)。
 * 仅 1 条值行不算枚举(如 `false: disable congestion control` 是单值提示,
 * 不是枚举契约);header 组不足 2 条值行丢弃。
 */
export interface ContractEnumGroup {
  /** ''=匿名组(元素自身);具名=父段注释里 `name:` header */
  header: string;
  values: readonly ContractEnumValue[];
}

export function enumGroupsFromComments(comments: string): readonly ContractEnumGroup[] {
  const lines = comments.split('\n');
  const groups: ContractEnumGroup[] = [];
  let current: { header: string; values: ContractEnumValue[] } | null = null;
  const flush = () => {
    if (current !== null && current.values.length >= 2) {
      groups.push({ header: current.header, values: current.values });
    }
    current = null;
  };
  for (const line of lines) {
    const valueLine = line.match(/^\s*(\d+)\s*[:：]\s*(.+?)\s*$/);
    if (valueLine) {
      if (current === null) {
        current = { header: '', values: [] };
      }
      current.values.push({ value: valueLine[1], meaning: valueLine[2] });
      continue;
    }
    const headerLine = line.match(/^\s*([A-Za-z_]\w*)\s*:\s*$/);
    if (headerLine) {
      flush();
      current = { header: headerLine[1], values: [] };
      continue;
    }
    flush();
  }
  flush();
  return groups;
}

/** 元素自身注释的匿名枚举组(≥2 条值行)。 */
function ownEnumValues(comments: string): readonly ContractEnumValue[] {
  const anonymous = enumGroupsFromComments(comments).find((g) => g.header === '');
  return anonymous ? anonymous.values : [];
}

/** 注释文本命名的单位;括号内纯数字(如 `(1400)`)是默认提示,不采 */
function namedUnit(comments: string): string | null {
  for (const word of UNIT_WORDS) {
    const pattern = new RegExp(`[（(]([^）)]*${word}[^）)]*)[)）]`, 'i');
    const match = comments.match(pattern);
    if (match) {
      return match[0].replace(/^[（(]|[)）]$/g, '');
    }
  }
  return null;
}

/** 默认值形态候选(诚实:候选非约束,不回填任何范围断言) */
function valueShapeCandidate(text: string): ContractValueKind {
  const trimmed = text.trim();
  if (trimmed === 'true' || trimmed === 'false') {
    return 'boolean';
  }
  if (/^-?\d+$/.test(trimmed)) {
    return 'integer';
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return 'float';
  }
  return 'string';
}

interface WalkState {
  records: ConfigContractRecord[];
  catalogSources: Readonly<Record<string, string>>;
  engineReadSiteKeys: ReadonlySet<string>;
}

function recordForNode(
  path: string,
  node: ConfigXmlNode,
  state: WalkState,
  parentEnumValues?: readonly ContractEnumValue[],
): ConfigContractRecord {
  const comments = commentsText(node);
  const enumValues = parentEnumValues ?? ownEnumValues(comments);
  const typeAnn = typeAnnotation(comments);
  const unit = namedUnit(comments);
  const catalogSource = state.catalogSources[path];
  const engineReadSite = catalogSource !== undefined && state.engineReadSiteKeys.has(path);

  let valueKind: ContractValueKind;
  let evidence: ContractEvidenceKind;
  let valueOnlyCandidate = false;
  let source: string;

  if (enumValues.length > 0) {
    valueKind = 'enum';
    evidence = 'defaults-enum-comment';
    source = parentEnumValues !== undefined
      ? `父段注释枚举块:${enumValues.map((v) => `${v.value}:${v.meaning}`).join(' / ')}`
      : `注释枚举块:${enumValues.map((v) => `${v.value}:${v.meaning}`).join(' / ')}`;
  } else if (typeAnn !== null) {
    valueKind = typeAnn.kind;
    evidence = 'defaults-type-annotation';
    source = `注释类型声明:${typeAnn.raw}`;
  } else {
    valueKind = valueShapeCandidate(node.text);
    evidence = 'defaults-value-only';
    valueOnlyCandidate = true;
    source = '默认值形态候选(单值,非约束)';
  }

  if (engineReadSite) {
    // 目录锚指向引擎读取点:证据升档,注释侧证据文本保留(组合不覆盖)
    evidence = 'engine-read-site';
    source = `目录取证:${catalogSource};注释侧:${source}`;
  }

  const unproven: string[] = ['range'];
  if (valueKind === 'unknown' || valueOnlyCandidate) {
    unproven.push('type-full-picture');
  }
  unproven.push('dynamicKeys');
  unproven.push('version-per-key');

  return {
    path,
    valueKind,
    evidence,
    enumValues,
    unit,
    repeatable: false,
    dynamicKeys: false,
    source,
    unproven,
    valueOnlyCandidate,
  };
}

function walk(node: ConfigXmlNode, prefix: string[], state: WalkState): void {
  const here = node.name === 'root' ? [] : [...prefix, node.name];
  for (const child of node.children) {
    const childPath = [...here, child.name].join('.');
    const allItems = child.children.length > 0 && child.children.every((c) => c.name === 'item');
    if (allItems) {
      // 可重复节点:`<item>` 子节点列表(trace_packet.disables 等)
      const comments = commentsText(child);
      const unit = namedUnit(comments);
      state.records.push({
        path: childPath,
        valueKind: 'list',
        evidence: 'defaults-comment',
        enumValues: [],
        unit,
        repeatable: true,
        dynamicKeys: false,
        source: '子节点 <item> 重复模式(默认 XML 结构证据)',
        unproven: ['item-type', 'range', 'dynamicKeys', 'version-per-key'],
        valueOnlyCandidate: false,
      });
      continue;
    }
    if (isLeaf(child)) {
      // 父段注释里的具名枚举组(header 与子叶同名)传播给该子叶
      const parentEnum = enumGroupsFromComments(commentsText(node)).find(
        (group) => group.header === child.name,
      );
      state.records.push(recordForNode(childPath, child, state, parentEnum?.values));
      continue;
    }
    walk(child, here, state);
  }
}

/**
 * 提取契约(树入口;运行时 provider 只持解析树不读原文——baseline 行数
 * 如实传 null,勿编)。file/note 由调用方按其快照来源自述。
 */
export function extractConfigContractsFromTree(
  tree: ConfigXmlNode,
  catalogSources: Readonly<Record<string, string>>,
  baseline: ConfigContractBaseline,
): ConfigContractExtraction {
  const engineReadSiteKeys = new Set(
    Object.entries(catalogSources)
      .filter(([, source]) => source.includes('serverconfig.cpp'))
      .map(([path]) => path),
  );
  const state: WalkState = { records: [], catalogSources, engineReadSiteKeys };
  walk(tree, [], state);

  const stats: ConfigContractStats = {
    total: state.records.length,
    typed: 0,
    enumCommented: 0,
    repeatableNodes: 0,
    unitsNamed: 0,
    valueOnly: 0,
    engineReadSite: 0,
  };
  for (const record of state.records) {
    if (record.valueKind !== 'unknown' && record.evidence === 'defaults-type-annotation') {
      stats.typed += 1;
    }
    if (record.evidence === 'defaults-enum-comment') {
      stats.enumCommented += 1;
    }
    if (record.repeatable) {
      stats.repeatableNodes += 1;
    }
    if (record.unit !== null) {
      stats.unitsNamed += 1;
    }
    if (record.valueOnlyCandidate) {
      stats.valueOnly += 1;
    }
    if (record.evidence === 'engine-read-site') {
      stats.engineReadSite += 1;
    }
  }

  return { records: state.records, baseline, stats };
}

/**
 * 提取契约。defaultsXmlText 用于版本基线行数;tree 为 parseConfigXml 产物
 * (KODE-CFG-002 Rust 核或 TS 回落核,单一事实源);catalogSources 传
 * SERVER_CONFIG_ITEM_DOCS 的 path→source(目录取证,serverconfig.cpp 锚
 * 升档 engine-read-site)。
 */
export function extractConfigContracts(
  defaultsXmlText: string,
  tree: ConfigXmlNode,
  catalogSources: Readonly<Record<string, string>> = {},
): ConfigContractExtraction {
  const rawLines = defaultsXmlText.split('\n');
  const lineCount = rawLines.length > 0 && rawLines[rawLines.length - 1] === ''
    ? rawLines.length - 1
    : rawLines.length;
  return extractConfigContractsFromTree(tree, catalogSources, {
    file: 'tests/fixtures/config/kbengine_defaults.xml',
    lineCount,
    note: '契约版本=引擎默认配置快照钉死(仓库字节镜像);逐键 since-version 无证据不记(见 unproven.version-per-key)',
  });
}

/** 按点分路径取契约记录(补全/校验/悬停消费面入口)。 */
export function contractRecordByPath(
  extraction: ConfigContractExtraction,
  path: string,
): ConfigContractRecord | undefined {
  return extraction.records.find((record) => record.path === path);
}
