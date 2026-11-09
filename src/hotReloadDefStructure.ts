/**
 * 将结构性 def 变更标记需重启(IDE-HOT-005):结构指纹=序列化面
 * (Properties 段逐属性 {Type,Flags,Persistent,Utype}+属性名集合)+RPC 面
 * (三方法段 BaseMethods/CellMethods/ClientMethods 逐方法的 Arg 类型签名
 * +方法名集合)+装载面(IDE-AUD-014:Parent 名/接口集/组件槽——继承、
 * 接口合并、组件装载都改有效结构,核验=结构性)。指纹变化=结构性 →
 * 需重启,不作为普通 Python reload 自动发送;注释/空白/顺序重排/描述
 * 文本/默认值不进指纹=非结构性。未建模顶段(如 DetailLevels/Volatile,
 * 分类器无核验结论)=保守:其规范化结构(去注释/空白、子序无序)变则按
 * 结构性处理,注释/空白/重排单独变化仍可通过。任一侧解析不了=保守按
 * 结构性处理(证明不了无结构变化就不自动发)。def 自动应用的总闸(书
 * §19.4)随热更管道接线另行落地,本模块只做结构判定。
 */

import { createHash } from 'crypto';

import { DEF_METHOD_SECTIONS, parseDefDocument, type DefElementNode } from './backend/defParser';

export interface DefChangeVerdict {
  /** true=影响序列化或 RPC 参数,需重启 */
  structural: boolean;
  /** 与 restartRequired 同义(标注面用) */
  restartRequired: boolean;
  /** 结构性原因逐条(属性/方法点名) */
  reasons: string[];
}

interface DefStructuralFingerprint {
  /** 属性名 → `${Type}|${Flags}|${Persistent}|${Utype}` */
  properties: Map<string, string>;
  /** `${段}.${方法名}` → Arg 类型签名(逗号连接,无 Arg=空串) */
  methods: Map<string, string>;
  /** 装载面(IDE-AUD-014):`parent`/`interface.<名>`/`component.<槽>` → 形状 */
  loading: Map<string, string>;
  /** 未建模顶段:段名 → 规范化结构序列化(变则保守按结构性) */
  unmodeled: Map<string, string>;
}

const childElements = (element: DefElementNode): DefElementNode[] =>
  element.children.filter((child): child is DefElementNode => child.kind === 'element');

/** 指名子元素的文本(DEF 里 Type/Flags 是子元素不是 XML 属性) */
const childElementText = (element: DefElementNode, name: string): string => {
  const child = childElements(element).find(candidate => candidate.name === name);
  return child ? descendantTextTrimmed(child) : '';
};

/** 元素内全部文本拼接去空白(Arg 的 <Type>X</Type> 提取用) */
const descendantTextTrimmed = (element: DefElementNode): string => {
  let text = '';
  for (const child of element.children) {
    if (child.kind === 'text') {
      text += child.text.trim();
    } else {
      text += descendantTextTrimmed(child);
    }
  }
  return text;
};

/**
 * 未建模顶段的规范化结构序列化(IDE-AUD-014 未知结构保守处理):递归
 * 元素名+文本,去注释/空白,子序排序——注释/空白/子段重排不产生差异
 * (仍可通过),结构或文本变则差异(保守按结构性)。顺序无关与属性段
 * 口径一致(重排=非结构性)。
 */
const structuralNodeFingerprint = (element: DefElementNode): string => {
  const parts: string[] = [];
  for (const child of element.children) {
    if (child.kind === 'text') {
      const text = child.text.trim();
      if (text) {
        parts.push(text);
      }
    } else {
      parts.push(`${child.name}{${structuralNodeFingerprint(child)}}`);
    }
  }
  return parts.sort().join('|');
};

/** 顶段白名单:已建模(序列化面/RPC 面/装载面);其余=未建模保守处理 */
const MODELED_SECTIONS = new Set([
  'Properties',
  'Parent',
  'Interfaces',
  'Components',
  ...DEF_METHOD_SECTIONS
]);

function buildStructuralFingerprint(text: string): DefStructuralFingerprint | null {
  const document = parseDefDocument(text);
  const root = document.root;
  if (!root) {
    return null;
  }
  const fingerprint: DefStructuralFingerprint = {
    properties: new Map(),
    methods: new Map(),
    loading: new Map(),
    unmodeled: new Map()
  };
  for (const section of childElements(root)) {
    // 未建模顶段(白名单外):无核验结论,变则保守按结构性处理(IDE-AUD-014)。
    if (!MODELED_SECTIONS.has(section.name)) {
      fingerprint.unmodeled.set(section.name, structuralNodeFingerprint(section));
      continue;
    }
    if (section.name === 'Properties') {
      for (const property of childElements(section)) {
        fingerprint.properties.set(
          property.name,
          // IDE-AUD-014:Persistent(DB 持久化)与 Utype(线上类型号)同为核验
          // 结构性——写进序列化面形状,变则结构性。
          `${childElementText(property, 'Type')}|${childElementText(property, 'Flags')}|${childElementText(property, 'Persistent')}|${childElementText(property, 'Utype')}`
        );
      }
      continue;
    }
    if ((DEF_METHOD_SECTIONS as readonly string[]).includes(section.name)) {
      for (const method of childElements(section)) {
        const argSignature = childElements(method)
          .filter(arg => arg.name === 'Arg')
          .map(descendantTextTrimmed)
          .join(',');
        fingerprint.methods.set(`${section.name}.${method.name}`, argSignature);
      }
      continue;
    }
    if (section.name === 'Parent') {
      // 继承根:改父类=有效属性/方法集变化,结构性(IDE-AUD-014)。
      fingerprint.loading.set('parent', descendantTextTrimmed(section));
      continue;
    }
    if (section.name === 'Interfaces') {
      // 接口集:每接口名一条(集合语义,顺序无关)。
      for (const iface of childElements(section)) {
        const name = descendantTextTrimmed(iface);
        fingerprint.loading.set(`interface.${name}`, name);
      }
      continue;
    }
    if (section.name === 'Components') {
      // 组件槽:每槽一条(<槽名><Type>…</Type><Persistent>…</Persistent></槽名>),
      // 槽名+组件类型+持久化,顺序无关。
      for (const slot of childElements(section)) {
        fingerprint.loading.set(
          `component.${slot.name}`,
          `${childElementText(slot, 'Type')}|${childElementText(slot, 'Persistent')}`
        );
      }
      continue;
    }
  }
  return fingerprint;
}

/**
 * 结构语义指纹的稳定哈希(IDE-REV-027 semanticHash 证据):对序列化面
 * (属性 {Type,Flags,Persistent,Utype})+RPC 面(方法 Arg 签名)+装载面
 * (Parent/接口/组件)+未建模顶段(保守)的指纹行做 sha256——注释/空白/
 * 顺序/描述文本不进指纹,值不随它们变;解析不了=null(如实无语义指纹,
 * 不造一个)。现成原语 node:crypto,不自创哈希。
 */
export function structuralFingerprintHash(text: string): string | null {
  let fingerprint: DefStructuralFingerprint | null;
  try {
    fingerprint = buildStructuralFingerprint(text);
  } catch {
    // 解析抛错与解析不出同口径:证明不了结构面,如实无语义指纹
    return null;
  }
  if (!fingerprint) {
    return null;
  }
  const lines = [
    ...[...fingerprint.properties].sort().map(([name, shape]) => `P ${name}=${shape}`),
    ...[...fingerprint.methods].sort().map(([name, signature]) => `M ${name}(${signature})`),
    ...[...fingerprint.loading].sort().map(([name, shape]) => `L ${name}=${shape}`),
    ...[...fingerprint.unmodeled].sort().map(([name, shape]) => `U ${name}=${shape}`)
  ];
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/** 结构指纹对比:序列化面+RPC 面+装载面+未建模段,变化逐条点名 */
export function classifyDefChange(beforeText: string, afterText: string): DefChangeVerdict {
  const before = buildStructuralFingerprint(beforeText);
  const after = buildStructuralFingerprint(afterText);
  if (!before || !after) {
    return {
      structural: true,
      restartRequired: true,
      reasons: ['def 解析失败(保守按结构性处理:证明不了无结构变化就不自动发)']
    };
  }
  const reasons: string[] = [];
  for (const [name, shape] of before.properties) {
    const afterShape = after.properties.get(name);
    if (afterShape === undefined) {
      reasons.push(`属性删除: ${name}(序列化面)`);
    } else if (afterShape !== shape) {
      reasons.push(`属性结构变化: ${name}(${shape} → ${afterShape},序列化面)`);
    }
  }
  for (const name of after.properties.keys()) {
    if (!before.properties.has(name)) {
      reasons.push(`属性新增: ${name}(序列化面)`);
    }
  }
  for (const [name, signature] of before.methods) {
    const afterSignature = after.methods.get(name);
    if (afterSignature === undefined) {
      reasons.push(`方法删除: ${name}(RPC 面)`);
    } else if (afterSignature !== signature) {
      reasons.push(`方法签名变化: ${name}(${signature || '无参数'} → ${afterSignature || '无参数'},RPC 面)`);
    }
  }
  for (const name of after.methods.keys()) {
    if (!before.methods.has(name)) {
      reasons.push(`方法新增: ${name}(RPC 面)`);
    }
  }
  for (const [name, shape] of before.loading) {
    const afterShape = after.loading.get(name);
    if (afterShape === undefined) {
      reasons.push(`装载面移除: ${name}(Parent/接口/组件)`);
    } else if (afterShape !== shape) {
      reasons.push(`装载面变化: ${name}(${shape} → ${afterShape},Parent/接口/组件)`);
    }
  }
  for (const name of after.loading.keys()) {
    if (!before.loading.has(name)) {
      reasons.push(`装载面新增: ${name}(Parent/接口/组件)`);
    }
  }
  for (const [section, shape] of before.unmodeled) {
    const afterShape = after.unmodeled.get(section);
    if (afterShape === undefined) {
      reasons.push(`未建模段移除: ${section}(保守按结构性:分类器无核验结论)`);
    } else if (afterShape !== shape) {
      reasons.push(`未建模段变化: ${section}(保守按结构性:分类器无核验结论)`);
    }
  }
  for (const section of after.unmodeled.keys()) {
    if (!before.unmodeled.has(section)) {
      reasons.push(`未建模段新增: ${section}(保守按结构性:分类器无核验结论)`);
    }
  }
  return { structural: reasons.length > 0, restartRequired: reasons.length > 0, reasons };
}

/** 标注文案:结构性=需重启+原因;非结构性=可走普通 reload 路径 */
export function defChangeVerdictDetail(verdict: DefChangeVerdict): string {
  if (verdict.structural) {
    return `需重启:${verdict.reasons.join(';')}(不作为普通 Python reload 自动发送)`;
  }
  return '非结构性 def 变更(序列化面/RPC 参数/装载面无变化,未建模段也无变化),可走普通 reload 路径';
}
