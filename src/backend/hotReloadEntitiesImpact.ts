/**
 * RUST-399(HR-HASH-012):entities.xml 实体注册项变化 → 受影响实体标注与
 * 注册版本状态报告。注册表是引擎装载期结构面:Python reload 无法替代注册表
 * 变更(默认不发 Python 热更请求替代结构变更),本模块只出报告。
 *
 * 口径:
 * - 实体注册 = entities.xml <root> 的每个子元素(元素名 = 实体注册名;
 *   属性 hasBase/hasCell/hasClient/config 与子元素一并入形,注册属性变化
 *   即注册项变化)。
 * - 注册项变化 = 实体注册的增/删/形状变;形状 = 规范化结构序列化(与
 *   hotReloadDefStructure.structuralNodeFingerprint / RUST-398 同款纪律:
 *   去注释/空白、子序排序、属性入形)——注释/空白/重排非结构性。
 * - 版本状态 = 注册表级:注册项变化即引擎实体注册表版本变化(引擎按装载期
 *   读 entities.xml 定注册表,新增/注销/属性绑定变化均需重启加载,Python
 *   reload 不替代);受影响实体 = 变化集逐条点名,含注册属性变化 delta。
 * - 实体属性 hasBase/hasCell/hasClient 变化直接改变引擎对该实体部分存在性的
 *   判定(config 变化改绑默认配置集)——都按注册项变化标注。
 *
 * 纯逻辑无 vscode/fs 依赖,单测用例直驱;执行编排归 hotReload 管道调用方。
 */

import { getDirectChildElements, parseDefDocument, type DefElementNode } from './defParser';

export interface EntityRegistration {
  name: string;
  /** 规范化结构形状(属性+子元素,去注释/空白,子序排序):变=注册项变化 */
  shape: string;
  /** 注册属性快照(hadBase/hasCell/hasClient/config/...),报告回显 delta 用 */
  attributes: Readonly<Record<string, string>>;
}

export type EntityChangeKind = 'added' | 'removed' | 'changed';

export interface EntityRegistrationChange {
  name: string;
  change: EntityChangeKind;
  /** 变化说明(回显/报告同源,含注册属性变化 delta) */
  reason: string;
}

export interface EntitiesImpactReport {
  /** 实体注册项变化逐条(增/删/形状变) */
  readonly changedEntities: EntityRegistrationChange[];
  readonly totalEntityCount: number;
  readonly changedEntityCount: number;
  /** 任何注册项变化 → 引擎注册表版本变化,需重启,不自动热更 */
  readonly anyAffected: boolean;
  /** 注册表版本状态(装载期结构面,Python reload 不替代) */
  readonly versionStatus: string;
}

/** 注册属性快照(值为字符串;缺省属性记为 '(无)') */
const attributesOf = (element: DefElementNode): Record<string, string> => {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(element.attributes)) {
    attributes[key] = value;
  }
  return attributes;
};

/**
 * 规范化结构序列化(与 hotReloadTypesImpact.structuralShape 同款纪律):
 * 递归元素名+文本,去注释/空白,子序排序——注释/空白/重排不产生差异,
 * 结构、属性或文本变则差异。
 */
const structuralShape = (element: DefElementNode): string => {
  const parts: string[] = [];
  // 属性入形:`<Avatar config="kbengine_avatar_defaults"/>` 换 config 即改绑
  // 默认配置集,忽略属性会把注册变化判成未变。
  for (const [key, value] of Object.entries(element.attributes)) {
    parts.push(`${key}=${value}`);
  }
  for (const child of element.children) {
    if (child.kind === 'text') {
      const text = child.text.trim();
      if (text) {
        parts.push(text);
      }
    } else {
      parts.push(`${child.name}{${structuralShape(child)}}`);
    }
  }
  return parts.sort().join('|');
};

/** 注册属性变化 delta:两版属性表逐键对比,缺省记 '(无)' */
const attributeDelta = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>
): string => {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const deltas: string[] = [];
  for (const key of keys) {
    const beforeValue = before[key] ?? '(无)';
    const afterValue = after[key] ?? '(无)';
    if (beforeValue !== afterValue) {
      deltas.push(`${key}: ${beforeValue} → ${afterValue}`);
    }
  }
  return deltas.join(',');
};

/**
 * 解析 entities.xml → 实体注册表(注册名 → 注册项)。解析不出根 = 空表
 * (如实,不造注册);重复注册名首见保留(BTreeMap entry/or_insert 同口径)。
 */
export function parseEntityRegistrations(entitiesXml: string): Map<string, EntityRegistration> {
  const document = parseDefDocument(entitiesXml);
  const root = document.root;
  const table = new Map<string, EntityRegistration>();
  if (!root) {
    return table;
  }
  for (const child of getDirectChildElements(root)) {
    if (!table.has(child.name)) {
      table.set(child.name, {
        name: child.name,
        shape: structuralShape(child),
        attributes: attributesOf(child)
      });
    }
  }
  return table;
}

export interface EntitiesImpactInput {
  /** entities.xml 变更前原文 */
  readonly beforeEntitiesXml: string;
  /** entities.xml 变更后原文 */
  readonly afterEntitiesXml: string;
}

/**
 * entities.xml 实体注册项变化影响报告(HR-HASH-012)。变化集 = 增/删/形状变;
 * 版本状态 = 注册表级(任何注册项变化 = 引擎实体注册表版本变化,需重启加载,
 * Python reload 不替代注册表变更)。
 */
export function analyzeEntitiesImpact(input: EntitiesImpactInput): EntitiesImpactReport {
  const before = parseEntityRegistrations(input.beforeEntitiesXml);
  const after = parseEntityRegistrations(input.afterEntitiesXml);
  const names = new Set<string>([...before.keys(), ...after.keys()]);

  const changedEntities: EntityRegistrationChange[] = [];
  for (const name of [...names].sort()) {
    const beforeReg = before.get(name);
    const afterReg = after.get(name);
    if (!beforeReg) {
      changedEntities.push({
        name,
        change: 'added',
        reason: `实体注册新增: ${name}(引擎按装载期注册表创建/校验该类型,新增注册需重启加载)`
      });
    } else if (!afterReg) {
      changedEntities.push({
        name,
        change: 'removed',
        reason: `实体注册删除: ${name}(注册表不再含该类型,运行期实例与注册表脱离,需重启加载)`
      });
    } else if (beforeReg.shape !== afterReg.shape) {
      const delta = attributeDelta(beforeReg.attributes, afterReg.attributes);
      changedEntities.push({
        name,
        change: 'changed',
        reason: delta
          ? `实体注册变化: ${name}(注册属性 ${delta})`
          : `实体注册变化: ${name}(子元素注册结构变化)`
      });
    }
  }

  const versionStatus =
    '实体注册表版本变化(引擎装载期读 entities.xml 定注册表;Python reload 不替代注册表变更,需重启加载)';

  return {
    changedEntities,
    totalEntityCount: names.size,
    changedEntityCount: changedEntities.length,
    anyAffected: changedEntities.length > 0,
    versionStatus
  };
}

/** 影响报告回显行(详情面直显) */
export function formatEntitiesImpactReport(report: EntitiesImpactReport): string {
  if (report.changedEntities.length === 0) {
    return 'entities.xml 无实体注册项变化';
  }
  const lines = report.changedEntities.map(change => change.reason).join(';');
  return `entities.xml 注册变化: ${lines};受影响 ${report.changedEntityCount}/${report.totalEntityCount} 个实体(${report.versionStatus})`;
}
