/**
 * KSEM-CFG-06 配置来源面(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md SEM-036,旧 KSEM-CFG-06):代码配置读取 key 跳有效值及
 * schema/默认声明;hover 展示覆盖来源和单位,敏感值脱敏。
 *
 * 三块能力:
 *  - `configSourceInfo`:一条配置路径的覆盖来源层(custom 覆盖 / 引擎默认)、
 *    生效值(.custom 叶优先,回落 defaults 叶)、单位(CFG-02 注释单位证据)、
 *    敏感键判定与脱敏;
 *  - `renderSourceEvidenceBlock`:悬停证据块(来源/生效值/单位,敏感值只给
 *    脱敏形态,明文永不入悬停文本),双语;
 *  - `configPathAtText`:文本+偏移→配置点分路径(复用 CFG-04 上下文解析:
 *    标签名态/取值态/闭标签行恢复;属性区 null)。
 *
 * 跳转面(默认声明=kbengine_defaults.xml 行、生效值=最终配置虚拟文档行)
 * 的行号定位复用 CFG-05 的 configPathLineIndex(注释掩码保偏移,首现行)。
 */
import { contractRecordByPath } from './configContract';
import type { ConfigContractExtraction } from './configContract';
import { normalizeRootNode } from './configFieldIdentity';
import { parseConfigCompletionContext } from './configCompletion';
import { configPathLineIndex } from './configValueValidation';
import type { ConfigXmlNode } from '../serverConfigMerge';

/** 敏感叶子键(password/passwd/pwd/secret/token/credential/access·api key) */
const SENSITIVE_LEAF = /(?:password|passwd|pwd|secret|token|credential|access_?key|api_?key)/i;

export function isSensitiveConfigKey(path: string): boolean {
  const leaf = path.split('.').pop() ?? '';
  return SENSITIVE_LEAF.test(leaf);
}

/** 脱敏形态:保留首字符(长度>1),其余一律 ***;空/单字符整体 *** */
export function maskSensitiveValue(value: string): string {
  if (value.length <= 1) {
    return '***';
  }
  return `${value[0]}***`;
}

export type ConfigSourceLayer = 'custom' | 'defaults';

export interface ConfigSourceInfo {
  path: string;
  /** 两棵树都找不到该路径=false(诚实面:不存在就不渲染块) */
  exists: boolean;
  /** 生效值(custom 覆盖优先;容器段/空文本为 null) */
  effectiveValue: string | null;
  /** 覆盖来源层:custom=元件 kbengine.xml 覆盖;defaults=引擎默认生效 */
  sourceLayer: ConfigSourceLayer | null;
  /** CFG-02 注释单位证据(秒/毫秒/…),无证据 null */
  unit: string | null;
  /** 敏感键(悬停只给脱敏形态) */
  sensitive: boolean;
}

function leafAtPath(tree: ConfigXmlNode, path: string): ConfigXmlNode | null {
  let node = normalizeRootNode(tree);
  for (const segment of path.split('.')) {
    const child = node.children.find((candidate) => candidate.name === segment);
    if (child === undefined) {
      return null;
    }
    node = child;
  }
  return node;
}

/**
 * 一条配置路径的来源信息。extraction 仅用于单位证据(CFG-02 记录);
 * 无记录/无单位证据时 unit=null,不猜。
 */
export function configSourceInfo(
  path: string,
  customTree: ConfigXmlNode | null,
  defaultsTree: ConfigXmlNode | null,
  extraction: ConfigContractExtraction | null,
): ConfigSourceInfo {
  const customLeaf = customTree !== null ? leafAtPath(customTree, path) : null;
  const defaultsLeaf = defaultsTree !== null ? leafAtPath(defaultsTree, path) : null;
  const effectiveNode = customLeaf ?? defaultsLeaf;
  const text = effectiveNode !== null ? effectiveNode.text.trim() : '';
  const record = extraction !== null ? contractRecordByPath(extraction, path) : undefined;
  return {
    path,
    exists: effectiveNode !== null,
    effectiveValue: effectiveNode !== null && text.length > 0 ? text : null,
    sourceLayer: customLeaf !== null ? 'custom' : defaultsLeaf !== null ? 'defaults' : null,
    unit: record?.unit ?? null,
    sensitive: isSensitiveConfigKey(path),
  };
}

/** 悬停证据块文案(纯格式化,双语言;敏感值只出现脱敏形态) */
export function renderSourceEvidenceBlock(
  info: ConfigSourceInfo,
  language: 'en' | 'zh',
): string | null {
  if (!info.exists || info.sourceLayer === null) {
    return null;
  }
  const lines: string[] = ['---'];
  if (language === 'en') {
    lines.push(
      info.sourceLayer === 'custom'
        ? 'Source: overridden by the project `kbengine.xml` (engine default superseded)'
        : 'Source: engine default (`kbengine_defaults.xml` in effect, no project override)',
    );
    if (info.effectiveValue !== null) {
      const shown = info.sensitive
        ? `${maskSensitiveValue(info.effectiveValue)} (masked)`
        : `\`${info.effectiveValue}\``;
      lines.push(`Effective value: ${shown}`);
    }
    if (info.unit !== null) {
      lines.push(`Unit: ${info.unit}`);
    }
  } else {
    lines.push(
      info.sourceLayer === 'custom'
        ? '来源:元件配置 `kbengine.xml` 覆盖(引擎默认被顶替)'
        : '来源:引擎默认生效(`kbengine_defaults.xml`,未被元件配置覆盖)',
    );
    if (info.effectiveValue !== null) {
      const shown = info.sensitive
        ? `${maskSensitiveValue(info.effectiveValue)}(已脱敏)`
        : `\`${info.effectiveValue}\``;
      lines.push(`生效值:${shown}`);
    }
    if (info.unit !== null) {
      lines.push(`单位:${info.unit}`);
    }
  }
  return lines.join('\n');
}

/**
 * 文本+偏移→配置点分路径(去 <root>)。三态:取值态=valuePath;标签名态=
 * parentPath.tagPrefix;光标在闭标签行尾(parentPath 弹栈后)按行内闭标签
 * 名恢复;属性区/无上下文=null。
 */
export function configPathAtText(text: string, offset: number): string | null {
  const context = parseConfigCompletionContext(text, offset);
  // 闭标签行恢复先行:光标在 `</name>` 之后时栈已弹出 name,取值态会把
  // 父路径误当 valuePath——按行内闭标签补回 name 再返回
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const before = text.slice(lineStart, offset);
  const closeMatch = /<\/([\w.-]+)>\s*$/.exec(before);
  if (closeMatch !== null) {
    const name = closeMatch[1];
    return context.parentPath.length > 0 ? `${context.parentPath}.${name}` : name;
  }
  if (context.valuePath !== null) {
    return context.valuePath;
  }
  if (context.tagPrefix !== null && context.tagPrefix.length > 0) {
    // 悬停/跳转语义:标签已完整写在文档里,光标落在名字中间时按行内完整
    // 标签名取(补全语义的光标前缀 ≠ 悬停语义的整标签)
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const line = text.slice(lineStart);
    const tagMatch = /<([\w.-]+)/.exec(line);
    const name = tagMatch !== null && context.tagPrefix.length > 0
      && tagMatch[1].startsWith(context.tagPrefix)
      ? tagMatch[1]
      : context.tagPrefix;
    return context.parentPath.length > 0 ? `${context.parentPath}.${name}` : name;
  }
  return null;
}

/**
 * 跳转行定位:defaults 原文/最终配置渲染文里的路径行(1 基;复用 CFG-05
 * 行号表,注释掩码保偏移,首现开标签行)。找不到=null,不猜。
 */
export function configDeclarationLine(text: string, path: string): number | null {
  return configPathLineIndex(text).get(path) ?? null;
}
