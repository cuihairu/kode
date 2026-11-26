/**
 * Hover Markdown formatting (extracted under IDE-ARC-003): the string
 * assembly for the five render sites in languageProviders (inferred return
 * type / def-declared method / receiver call / builtin property / event
 * statistics) lives only in this module. Pure formatting layer: it reads no
 * files, reads no configuration, and does not import vscode — text goes in,
 * a markdown string comes out, and the existing hover text stays
 * character-for-character unchanged.
 */
import { basename } from 'path';
import {
  formatEntityBuiltinPropertyHeadline,
  type EntityBuiltinPropertyHit
} from './entityBuiltinProperties';
import { PYTHON_TYPE_STUB_FALLBACK, type SelfPropertyResolved } from './selfPropertyTypeInference';

/** Shared input for the def-declared method / receiver call faces: a present
 * receiver = receiver call face (the headline carries a receiver segment),
 * absent = declaration face; signature / declaration line / Exposed tail
 * segment are isomorphic across both faces. */
export interface EntityDefMethodHoverInput {
  methodName: string;
  section: string;
  signature: string;
  defFile: string;
  defLine: number;
  exposed: boolean;
  receiver?: string;
}

/** Full text of the "this function / this call is the entity's def-declared X method" annotation */
export function formatEntityDefMethodHover(input: EntityDefMethodHoverInput): string {
  const header = input.receiver === undefined
    ? `**${input.methodName}** — 此函数是实体 def 声明的 ${input.section} 方法\n\n`
    : `**${input.methodName}** — 此调用是实体 def 声明的 ${input.section} 方法(接收者 self.${input.receiver})\n\n`;
  const exposed = input.exposed ? '\n\n**Exposed**: 该方法可被客户端远程调用。' : '';
  return `${header}签名: \`${input.signature}\`\n\n声明: \`${basename(input.defFile)}:${input.defLine}\`${exposed}`;
}

/** Local variable return type inference annotation: `**target: annotation**` + source method segment */
export function formatInferredReturnHover(target: string, annotation: string, methodName: string): string {
  return `**${target}: ${annotation}**\n\n推导自 ${methodName}() 返回注解`;
}

/** Event statistics annotation: registration / trigger counts in the current file */
export function formatEventStatsHover(event: string, registrations: number, emits: number): string {
  return `**${event}**\n\n当前文件统计：${registrations} 处注册 · ${emits} 处触发`;
}

/** Builtin property annotation: the headline first line (name + type + face/read-write, reusing the pure formatting face) + registration source segment */
export function formatBuiltinPropertyHover(hit: EntityBuiltinPropertyHit): string {
  return `${formatEntityBuiltinPropertyHeadline(hit.property.name, hit.face, hit.property)}\n\n引擎注册面: \`${hit.property.source}\``;
}

/** TYP-ARRAY def property / array element annotation: the `**target: annotation**` first line + source segment + the honest Any reason (④) */
export function formatSelfPropertyTypeHover(resolved: SelfPropertyResolved): string {
  const headline = `**${resolved.expr}: ${resolved.annotation}**`;
  const source = resolved.kind === 'element'
    ? `元素类型推导自 \`self.${resolved.propertyName}\`(\`${basename(resolved.defFile)}:${resolved.defLine}\`)`
    : `def 属性声明: \`${basename(resolved.defFile)}:${resolved.defLine}\``;
  // The reason is two-meaning (TYP-DICTGET): when the annotation is Any it
  // carries the honest reason with an "unresolved" tail note; otherwise it is
  // an informational note (a dict.get key may not exist), quoted verbatim
  // with no Any tail.
  const reason = !resolved.reason
    ? ''
    : resolved.annotation === PYTHON_TYPE_STUB_FALLBACK
      ? `\n\n> ${resolved.reason}(类型未解析,如实 Any)`
      : `\n\n> ${resolved.reason}`;
  return `${headline}\n\n${source}${reason}`;
}

/** KSEM-STRUCT-02 FIXED_DICT sub-field key annotation input (key + value annotation + declaration location). */
export interface FixedDictKeyHoverInput {
  containerName: string;
  key: string;
  annotation: string;
  file: string;
  line: number;
}

/** FIXED_DICT sub-field key annotation: the `**key: annotation**` first line + the types.xml declaration segment. */
export function formatFixedDictKeyHover(input: FixedDictKeyHoverInput): string {
  return `**${input.key}: ${input.annotation}**\n\nFIXED_DICT \`${input.containerName}\` 字段声明: \`${basename(input.file)}:${input.line}\``;
}

/** KSEM-STRUCT-07 implementedBy subscript hover note input (container name + bound value). */
export interface ImplementedBySubscriptNoteInput {
  containerName: string;
  implementedBy: string;
}

/** String-subscript hover note for implementedBy FDs: the in-memory form is
 * the implementing class's structure and the keys are defined by the
 * implementing class; FIXED_DICT Properties only describe the
 * transport/storage form (restored across the getDictFromObj boundary), so
 * in-memory subscripting is not judged by it — this explains the mechanism
 * and never treats the implementing object as a TypedDict. */
export function formatImplementedBySubscriptNoteHover(input: ImplementedBySubscriptNoteInput): string {
  return `**${input.containerName}**:implementedBy 类型\n\n内存形式由实现类 \`${input.implementedBy}\` 重定义(键位/访问面由实现类定义);FIXED_DICT Properties 键位仅描述传输/存储形式(引擎经 getDictFromObj 还原后使用),不适用于内存下标。`;
}
