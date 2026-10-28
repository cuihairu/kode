/**
 * 将结构性 def 变更标记需重启(IDE-HOT-005):结构指纹=序列化面
 * (Properties 段逐属性 {Type,Flags}+属性名集合)+RPC 面(三方法段
 * BaseMethods/CellMethods/ClientMethods 逐方法的 Arg 类型签名+方法名
 * 集合)。指纹变化=结构性 → 需重启,不作为普通 Python reload 自动发
 * 送;注释/空白/顺序重排/描述文本/默认值不进指纹=非结构性。任一侧解
 * 析不了=保守按结构性处理(证明不了无结构变化就不自动发)。def 自动
 * 应用的总闸(书 §19.4)随热更管道接线另行落地,本模块只做结构判定。
 */

import { DEF_METHOD_SECTIONS, parseDefDocument, type DefElementNode } from './defParser';

export interface DefChangeVerdict {
  /** true=影响序列化或 RPC 参数,需重启 */
  structural: boolean;
  /** 与 restartRequired 同义(标注面用) */
  restartRequired: boolean;
  /** 结构性原因逐条(属性/方法点名) */
  reasons: string[];
}

interface DefStructuralFingerprint {
  /** 属性名 → `${Type}|${Flags}` */
  properties: Map<string, string>;
  /** `${段}.${方法名}` → Arg 类型签名(逗号连接,无 Arg=空串) */
  methods: Map<string, string>;
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

function buildStructuralFingerprint(text: string): DefStructuralFingerprint | null {
  const document = parseDefDocument(text);
  const root = document.root;
  if (!root) {
    return null;
  }
  const fingerprint: DefStructuralFingerprint = { properties: new Map(), methods: new Map() };
  for (const section of childElements(root)) {
    if (section.name === 'Properties') {
      for (const property of childElements(section)) {
        fingerprint.properties.set(property.name, `${childElementText(property, 'Type')}|${childElementText(property, 'Flags')}`);
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
    }
  }
  return fingerprint;
}

/** 结构指纹对比:序列化面+RPC 面,变化逐条点名 */
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
  return { structural: reasons.length > 0, restartRequired: reasons.length > 0, reasons };
}

/** 标注文案:结构性=需重启+原因;非结构性=可走普通 reload 路径 */
export function defChangeVerdictDetail(verdict: DefChangeVerdict): string {
  if (verdict.structural) {
    return `需重启:${verdict.reasons.join(';')}(不作为普通 Python reload 自动发送)`;
  }
  return '非结构性 def 变更(序列化面与 RPC 参数无变化),可走普通 reload 路径';
}
