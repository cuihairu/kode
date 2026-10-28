/**
 * hover Markdown 格式化(IDE-ARC-003 抽离):languageProviders 五处 render 位
 * (返回类型推导/def 声明方法/接收者调用/内建属性/事件统计)的字符串拼装
 * 只住本模块。纯格式化层:不读文件、不读配置、不 import vscode——文本
 * 输入进来,markdown 字符串出去,既有 hover 文本逐字不变。
 */
import { basename } from 'path';
import {
  formatEntityBuiltinPropertyHeadline,
  type EntityBuiltinPropertyHit
} from './entityBuiltinProperties';

/** def 声明方法/接收者调用共用输入:receiver 有值 = 接收者调用面(标题带
 * 接收者段),无值 = 声明面;签名/声明行/Exposed 尾段两面同构。 */
export interface EntityDefMethodHoverInput {
  methodName: string;
  section: string;
  signature: string;
  defFile: string;
  defLine: number;
  exposed: boolean;
  receiver?: string;
}

/** 「此函数/此调用是实体 def 声明的 X 方法」标注全文 */
export function formatEntityDefMethodHover(input: EntityDefMethodHoverInput): string {
  const header = input.receiver === undefined
    ? `**${input.methodName}** — 此函数是实体 def 声明的 ${input.section} 方法\n\n`
    : `**${input.methodName}** — 此调用是实体 def 声明的 ${input.section} 方法(接收者 self.${input.receiver})\n\n`;
  const exposed = input.exposed ? '\n\n**Exposed**: 该方法可被客户端远程调用。' : '';
  return `${header}签名: \`${input.signature}\`\n\n声明: \`${basename(input.defFile)}:${input.defLine}\`${exposed}`;
}

/** 局部变量返回类型推导标注:`**目标: 注解**` + 来源方法段 */
export function formatInferredReturnHover(target: string, annotation: string, methodName: string): string {
  return `**${target}: ${annotation}**\n\n推导自 ${methodName}() 返回注解`;
}

/** 事件统计标注:当前文件注册/触发计数 */
export function formatEventStatsHover(event: string, registrations: number, emits: number): string {
  return `**${event}**\n\n当前文件统计：${registrations} 处注册 · ${emits} 处触发`;
}

/** 内建属性标注:首行 headline(名称+类型+面/读写,复用纯格式化面)+ 注册来源段 */
export function formatBuiltinPropertyHover(hit: EntityBuiltinPropertyHit): string {
  return `${formatEntityBuiltinPropertyHeadline(hit.property.name, hit.face, hit.property)}\n\n引擎注册面: \`${hit.property.source}\``;
}
