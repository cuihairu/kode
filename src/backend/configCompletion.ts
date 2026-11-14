/**
 * KSEM-CFG-04 配置键与枚举补全(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md SEM-034,旧 KSEM-CFG-04):父路径限定可用 key,value
 * 按确定枚举/类型补全;已有 provider 复用,不重复注册冲突项。
 *
 * 三条来源(CFG-02/CFG-03 之上):
 *  - 键补全:CFG-03 字段身份扫描(scanConfigFieldIdentities)取父路径下
 *    恰一层子字段(fixed 与 dynamic-extension 都可建议——项目在已知段下
 *    加叶子是合法实践;详情挂 CFG-02 契约证据);
 *  - 值补全:**只按确定证据**——CFG-02 枚举块(默认 XML 注释)给逐值建议;
 *    `Type: Boolean` 注解给 true/false(布尔注解下仅此二值,安全);其余
 *    类型一律不给值建议(不回填默认值、不猜);
 *  - 上下文解析:纯文本栈扫描(注释掩码保持偏移,标签栈压弹),三种态:
 *    标签名补全('<xx')/元素文本内取值/属性区(无建议,诚实返回空)。
 *
 * provider 壳(src/configCompletionProvider.ts)只做开关读取+document→
 * 文本/偏移转换+CompletionItem 映射;注册面=配置 XML 文档选择器
 * (kbengine*.xml / messages_fixed*.xml),与既有 def/python/shell 补全
 * 选择器零交集,不重复注册冲突项。
 */
import type { ConfigContractExtraction, ConfigContractRecord } from './configContract';
import { contractRecordByPath } from './configContract';
import type { ConfigFieldIdentityScan } from './configFieldIdentity';

export interface ConfigCompletionContext {
  /** 光标所在元素的点分路径(''=根层) */
  parentPath: string;
  /** 标签名补全态:已键入的部分标签名('<xx' 形);否则 null */
  tagPrefix: string | null;
  /** 取值态:所在元素的完整路径;否则 null */
  valuePath: string | null;
  /** 当前词前缀(标签名或取值词;空串=光标前无词) */
  prefix: string;
}

export interface ConfigCompletionItem {
  label: string;
  kind: 'key' | 'enum-value' | 'boolean-value';
  /** 证据/语义详情(纯文本,映射到 CompletionItem.detail) */
  detail: string;
}

/**
 * 上下文解析:注释掩码(等长空格替换,偏移不失真)→ 标签栈扫描。
 * 属性区上下文('xx="yy"' 内)返回属性态——键值建议都不适用,由调用方
 * 落空(诚实无建议)。
 */
export function parseConfigCompletionContext(
  text: string,
  offset: number,
): ConfigCompletionContext {
  const masked = maskComments(text);
  const bounded = Math.max(0, Math.min(offset, masked.length));

  const stack: string[] = [];
  const tagPattern = /<(\/?)([A-Za-z_][\w.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let lastTagEnd = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagPattern.exec(masked)) !== null) {
    const [, closing, name, , selfClose] = tagMatch;
    const tagEnd = tagMatch.index + tagMatch[0].length;
    if (tagEnd > bounded) {
      // 光标在该标签内部:不压/不弹,交给尾部残段解析(标签名补全态)
      break;
    }
    if (name === 'root' && stack.length === 0) {
      // <root> 是配置根包裹段,不入路径(catalog/契约同口径)
      lastTagEnd = tagEnd;
      continue;
    }
    if (closing) {
      // 弹栈到同名开标签(良构配置精确命中;容忍错配多弹一层)
      const topIndex = stack.lastIndexOf(name);
      if (topIndex >= 0) {
        stack.length = topIndex;
      }
    } else if (!selfClose) {
      stack.push(name);
    }
    lastTagEnd = tagEnd;
  }

  // 光标与最后完整标签之间的残留:可能是不完整标签或元素文本
  const tail = masked.slice(lastTagEnd, bounded);
  const openBracket = tail.lastIndexOf('<');
  const closeBracket = tail.lastIndexOf('>');

  let tagPrefix: string | null = null;
  let valuePath: string | null = null;
  let prefix = '';

  if (openBracket > closeBracket) {
    // '<' 之后:标签名补全态;若已进属性区(出现空格/=)则无建议
    const partial = tail.slice(openBracket + 1);
    if (/^[A-Za-z_][\w.-]*$/.test(partial)) {
      tagPrefix = partial;
      prefix = partial;
    } else {
      return { parentPath: stack.join('.'), tagPrefix: null, valuePath: null, prefix: '' };
    }
  } else {
    // 元素文本内:取值态(栈非空才有元素;前缀=尾部词字符)
    const wordMatch = tail.match(/[A-Za-z_][\w.-]*$/);
    prefix = wordMatch ? wordMatch[0] : '';
    if (stack.length > 0) {
      valuePath = stack.join('.');
    }
  }

  return {
    parentPath: stack.join('.'),
    tagPrefix,
    valuePath,
    prefix,
  };
}

/** 注释掩码:<!-- --> 段等长替换为空格(偏移与文本其余部分保持稳定) */
function maskComments(text: string): string {
  const chars = text.split('');
  const commentPattern = /<!--[\s\S]*?-->/g;
  let match: RegExpExecArray | null;
  while ((match = commentPattern.exec(text)) !== null) {
    for (let i = match.index; i < match.index + match[0].length; i += 1) {
      if (chars[i] !== '\n') {
        chars[i] = ' ';
      }
    }
  }
  return chars.join('');
}

function recordDetail(record: ConfigContractRecord): string {
  const parts: string[] = [record.valueKind];
  if (record.unit !== null) {
    parts.push(`unit:${record.unit}`);
  }
  if (record.enumValues.length > 0) {
    parts.push(`${record.enumValues.length} 值枚举`);
  }
  parts.push(record.valueOnlyCandidate ? '仅值形态候选' : record.evidence);
  return parts.join(' · ');
}

/** 父路径限定键补全:CFG-03 扫描取恰一层子字段,CFG-02 记录挂详情,去重。 */
export function suggestConfigKeys(
  scan: ConfigFieldIdentityScan,
  extraction: ConfigContractExtraction,
  parentPath: string,
  prefix: string,
): ConfigCompletionItem[] {
  const childPrefix = parentPath.length > 0 ? `${parentPath}.` : '';
  const seen = new Set<string>();
  const items: ConfigCompletionItem[] = [];
  for (const field of scan.fields) {
    if (!field.path.startsWith(childPrefix)) {
      continue;
    }
    const rest = field.path.slice(childPrefix.length);
    if (rest.length === 0 || rest.includes('.')) {
      continue;
    }
    if (seen.has(rest)) {
      continue;
    }
    seen.add(rest);
    const record = contractRecordByPath(extraction, field.path);
    items.push({
      label: rest,
      kind: 'key',
      detail: record ? recordDetail(record) : 'section',
    });
  }
  const filtered = prefix.length > 0
    ? items.filter((item) => item.label.toLowerCase().startsWith(prefix.toLowerCase()))
    : items;
  return filtered.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * 值补全:只按确定证据——枚举块逐值;`Type: Boolean` 注解 true/false;
 * 其余类型空(不回填默认值,不猜)。
 */
export function suggestConfigValues(
  extraction: ConfigContractExtraction,
  valuePath: string,
  prefix: string,
): ConfigCompletionItem[] {
  const record = contractRecordByPath(extraction, valuePath);
  if (!record) {
    return [];
  }
  let items: ConfigCompletionItem[];
  if (record.enumValues.length > 0) {
    items = record.enumValues.map((entry) => ({
      label: entry.value,
      kind: 'enum-value' as const,
      detail: entry.meaning,
    }));
  } else if (record.evidence === 'defaults-type-annotation' && record.valueKind === 'boolean') {
    items = [
      { label: 'true', kind: 'boolean-value', detail: 'Type: Boolean 注解' },
      { label: 'false', kind: 'boolean-value', detail: 'Type: Boolean 注解' },
    ];
  } else {
    items = [];
  }
  return prefix.length > 0
    ? items.filter((item) => item.label.toLowerCase().startsWith(prefix.toLowerCase()))
    : items;
}

/** 入口(对齐 provideStartupScriptCompletions 形):文本+偏移→补全项。 */
export function provideConfigCompletions(
  text: string,
  offset: number,
  scan: ConfigFieldIdentityScan,
  extraction: ConfigContractExtraction,
): ConfigCompletionItem[] {
  const context = parseConfigCompletionContext(text, offset);
  if (context.tagPrefix !== null) {
    return suggestConfigKeys(scan, extraction, context.parentPath, context.prefix);
  }
  if (context.valuePath !== null) {
    return suggestConfigValues(extraction, context.valuePath, context.prefix);
  }
  return [];
}
