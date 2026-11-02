import { inferSelfAttributeFlow, type SelfAttributeFlowOptions } from './selfAttributeFlowTypes';

/**
 * LANG-NAR-1 语义引擎流敏感窄化(用户令 2026-11-02)——诊断面:
 * 用户自管属性 self.<attr>(非 .def 声明、非内建 receiver)的成员访问/方法调用,
 * 当该属性流敏感类型含 None 且无判空守卫时报 Warning(镜像 receiverNone 的
 * 判定语义:有 None 证据才报,窄化生效即不报)。
 *
 * 与 receiverNone 的边界:receiverNone 只查 self.cell/base/client(引擎 getter
 * 可为 None);本诊断查任意自管属性——凡流类型含 None(如 __init__ `= None`
 * 且未被后续赋值覆盖、或类级 `X = None`)且查询位未窄化即报。def 声明属性
 * 经 GEN-DEF-1a/1b 口径恒非 Optional,流引擎无 None 证据自然不报(无需特判)。
 *
 * 纯函数面(文本 + 可选回调),零 vscode 依赖,供诊断调度器同步/异步消费。
 */

export const ATTRIBUTE_NONE_DIAGNOSTICS_ENABLED_DEFAULT = true;
export const ATTRIBUTE_NONE_DIAGNOSTIC_CODE = 'kbengine.attributeNone';

/** 内建 receiver 属性(receiverNone 专责,此处跳过避免重复/口径分叉) */
const BUILTIN_RECEIVERS = new Set(['cell', 'base', 'client']);

export interface SelfAttributeNoneFinding {
  /** 0 起行(成员访问所在行) */
  line: number;
  /** 0 起列(成员 token 起) */
  character: number;
  attr: string;
  member: string;
  message: string;
}

/** `self.<attr>.<member>`(成员访问/方法调用;attr 非内建 receiver) */
const SELF_MEMBER_ACCESS = /\bself\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;

function buildMessage(attr: string, member: string): string {
  return `self.${attr} 可能为 None:${member} 访问/调用前应判空`
    + `(自管属性,__init__/类级声明含 None 且当前位未窄化)`;
}

/**
 * 全量计算:无判空窄化的自管属性成员访问(Warning)。纯函数(文本 + 回调)。
 * 逐访问按 (行, 属性) 记忆化流类型——同一访问行同属性只推一次。
 */
export function computeSelfAttributeNoneFindings(
  source: string,
  options?: SelfAttributeFlowOptions
): SelfAttributeNoneFinding[] {
  const lines = source.split(/\r?\n/);
  const findings: SelfAttributeNoneFinding[] = [];
  const memo = new Map<string, boolean>();
  SELF_MEMBER_ACCESS.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SELF_MEMBER_ACCESS.exec(source)) !== null) {
    const attr = match[1];
    if (BUILTIN_RECEIVERS.has(attr)) {
      continue;
    }
    // 行内计算匹配的 0 起行号与成员列
    const line = source.slice(0, match.index).split('\n').length - 1;
    const member = match[2];
    // 成员列 = 匹配起点 + `self.<attr>.` 长度
    const memberCharacter = match.index + match[0].indexOf(member);
    const key = `${line}\u0000${attr}`;
    if (!memo.has(key)) {
      const flow = inferSelfAttributeFlow(lines, line, attr, options);
      memo.set(key, flow !== null && flow.hasNone);
    }
    if (memo.get(key)) {
      findings.push({
        line,
        character: memberCharacter,
        attr,
        member,
        message: buildMessage(attr, member)
      });
    }
  }
  return findings;
}

/** 测试面:诊断数据项(免 vscode 依赖;开关门由调用方控制) */
export function attributeNoneDiagnosticItems(
  source: string,
  options?: SelfAttributeFlowOptions
): SelfAttributeNoneFinding[] {
  return computeSelfAttributeNoneFindings(source, options);
}
