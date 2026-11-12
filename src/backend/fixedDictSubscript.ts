/**
 * FIXED_DICT 子字段下标链(KSEM-STRUCT-02):`data["pos"]["x"]` /
 * `self.<FD 属性>.get("pos")["x"]` 形态的接收者+访问段探测与逐层类型解析。
 *
 * 引擎真源(fixeddict.h:pyscript::Map,2026-11-13 STRUCT-01 盘点锚定):
 * 运行时 FixedDict 是 dict 子类,mp_subscript 字符串下标与 items/keys/
 * values/get 字典方法是引擎实际支持的读取面;整数下标键型不符、字符串键
 * 打在数组上同理不追。探测只收这两形(`[...]` 下标与 `.get(...)`,内容
 * 为字符串字面量才是键段;数字/切片/表达式一律 index 段,解析期诚实断链)。
 *
 * 纯逻辑模块:不读文件不读配置不 import vscode——行文本+类型注册表
 * (definitionWorkspace CustomTypeInfo 快照)进来,上下文/解析结果出去。
 * 数据保真依托 CustomTypeInfo 高保真面(字段名/typeStructure 内联数组
 * 树/声明行),低保真 field_refs 面不承载布局(STRUCT-01 §4 约定)。
 */
import type { CustomTypeInfo, CustomTypePropertyInfo } from '../definitionWorkspace';
import { FIXED_DICT_TYPE_NAME } from './kbengineMetadata';
import {
  PYTHON_TYPE_STUB_FALLBACK,
  resolveAnnotationTypeWithReason,
  resolveCustomTypePropertyAnnotation
} from '../pythonTypeStubs';

/** 访问段:字符串键(subscript/get 两形)或下标(数字/切片/未知表达式)。 */
export type FixedDictChainSegment =
  | {
      kind: 'key';
      key: string;
      /** 键串内容区间(不含引号,0 基列):闭段 [keyStart, keyEnd);开段 keyEnd=null */
      keyStart: number;
      keyEnd: number | null;
      /** 访问形态:`[K]` 下标 / `.get(K)` 方法 */
      form: 'subscript' | 'get';
    }
  | {
      kind: 'index';
      /** 访问形态:`[i]` 下标 / `.get(i)` 方法(内容静态不可知,一律 index 段) */
      form: 'subscript' | 'get';
    };

/** 光标处下标链上下文。 */
export interface FixedDictSubscriptChainContext {
  /** 接收者表达式(`self.<属性>` 或裸局部名;空格已归一) */
  receiver: string;
  /** 接收者首列(0 基) */
  receiverStart: number;
  /** 光标前(含光标段)的访问段,按出现序 */
  segments: FixedDictChainSegment[];
  /** 光标态:开键串内(补全面)/键串内容上(悬停·跳转面) */
  cursor: 'open-key' | 'key';
  /** open-key 的替换起点(0 基列;终点=光标列) */
  replaceStart: number;
}

/** 行内注释位判定(与 isKeyInsideLineComment 家族同口径的行级启发):跟踪
 * 引号态,# 后即注释;三引号跨行形态不在行级探测面内。 */
function positionInsideLineComment(lineText: string, character: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < character; i += 1) {
    const ch = lineText[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return true;
    }
  }
  return false;
}

/** 跳过 i 列起的字符串字面量(到闭引号;支持 \\ 转义),返回闭引号后一列;
 * 行内未闭返回 -1(链解析放弃,诚实不猜)。 */
function skipStringLiteral(lineText: string, i: number): number {
  const quote = lineText[i];
  let j = i + 1;
  while (j < lineText.length) {
    const ch = lineText[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === quote) {
      return j + 1;
    }
    j += 1;
  }
  return -1;
}

/** 候选接收者:`self.<属性>` 整体形态或裸标识符;点号中段(属性路径)不作
 * 接收者。返回按出现序。 */
function receiverCandidates(lineText: string): Array<{ start: number; end: number }> {
  const candidates: Array<{ start: number; end: number }> = [];
  const identifier = /[A-Za-z_]\w*/g;
  let match: RegExpExecArray | null;
  while ((match = identifier.exec(lineText)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const name = match[0];
    const isSelfProp = name === 'self' && /^\.([A-Za-z_]\w*)/.test(lineText.slice(end));
    if (isSelfProp) {
      // self.<prop> 整体作接收者(仅一层属性:def 属性面;更深的点链引擎
      // 不支持属性透传,不收)
      const prop = /^\.([A-Za-z_]\w*)/.exec(lineText.slice(end)) as RegExpExecArray;
      candidates.push({ start, end: end + 1 + prop[1].length });
      identifier.lastIndex = end;
      continue;
    }
    // 前一非空白字符是 '.' → 属性中段(self 形态已在上面整体接管),跳过
    const before = lineText.slice(0, start).trimEnd();
    if (before.endsWith('.')) {
      continue;
    }
    candidates.push({ start, end });
  }
  return candidates;
}

interface ParsedChainAtom {
  segment: FixedDictChainSegment;
  /** 该段后一列(链解析继续位) */
  end: number;
  /** 开键串(行尾未闭)时的内容起点:键串片段自此到光标 */
  contentStart: number | null;
  /** 裸开段(`[`/`.get(` 后无引号无内容到行尾):仅光标紧跟开括号时才算
   * 键位(键入表达式片段不接管,防表达式位弹键补全) */
  bare: boolean;
}

/** 解析 pos 列起的一个访问段(`[K]` / `[i]` / `.get(K)`);不是访问段返回
 * null。开键串段(引号后无闭引号到行尾,或光标紧跟 `[`/`.get(` 的空段)
 * 记 contentStart,由调用方按光标分类。闭引号已打但收括号未打的行尾形态
 * 按闭段收(链不再向后延伸)——光标在键串内仍可分类。 */
function parseChainAtomAt(lineText: string, pos: number): ParsedChainAtom | null {
  // 形态一:`[ ... ]` 下标
  if (lineText[pos] === '[') {
    let i = pos + 1;
    while (i < lineText.length && /\s/.test(lineText[i])) {
      i += 1;
    }
    const quote = lineText[i];
    if (quote === '"' || quote === "'") {
      let j = i + 1;
      while (j < lineText.length && lineText[j] !== quote && lineText[j] !== '\\') {
        j += 1;
      }
      if (j < lineText.length && lineText[j] === quote) {
        let k = j + 1;
        while (k < lineText.length && /\s/.test(lineText[k])) {
          k += 1;
        }
        if (k >= lineText.length) {
          // 闭引号已打、`]` 未打的行尾形态:按闭段收,链止于行尾
          return {
            segment: { kind: 'key', key: lineText.slice(i + 1, j), keyStart: i + 1, keyEnd: j, form: 'subscript' },
            end: lineText.length,
            contentStart: null,
            bare: false
          };
        }
        if (lineText[k] !== ']') {
          return null;
        }
        return {
          segment: { kind: 'key', key: lineText.slice(i + 1, j), keyStart: i + 1, keyEnd: j, form: 'subscript' },
          end: k + 1,
          contentStart: null,
          bare: false
        };
      }
      // 开键串(行尾未闭)
      return {
        segment: { kind: 'key', key: '', keyStart: i + 1, keyEnd: null, form: 'subscript' },
        end: lineText.length,
        contentStart: i + 1,
        bare: false
      };
    }
    // 非字符串内容:数字/切片/表达式 → index 段(静态不可知,解析期断链)
    let depth = 1;
    let j = i;
    while (j < lineText.length) {
      const ch = lineText[j];
      if (ch === '[') {
        depth += 1;
      } else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      } else if (ch === '"' || ch === "'") {
        const after = skipStringLiteral(lineText, j);
        if (after < 0) {
          return null;
        }
        j = after;
        continue;
      }
      j += 1;
    }
    if (j >= lineText.length) {
      // `[` 未闭合:仅光标紧跟开括号(空片段)才算键位,表达式片段不接管
      return {
        segment: { kind: 'key', key: '', keyStart: i, keyEnd: null, form: 'subscript' },
        end: lineText.length,
        contentStart: i,
        bare: true
      };
    }
    return { segment: { kind: 'index', form: 'subscript' }, end: j + 1, contentStart: null, bare: false };
  }
  // 形态二:`.get(...)` 方法
  const getForm = /^\.get\s*\(/.exec(lineText.slice(pos));
  if (!getForm) {
    return null;
  }
  let i = pos + getForm[0].length;
  while (i < lineText.length && /\s/.test(lineText[i])) {
    i += 1;
  }
  const quote = lineText[i];
  if (quote === '"' || quote === "'") {
    let j = i + 1;
    while (j < lineText.length && lineText[j] !== quote && lineText[j] !== '\\') {
      j += 1;
    }
    if (j < lineText.length && lineText[j] === quote) {
      let k = j + 1;
      while (k < lineText.length && /\s/.test(lineText[k])) {
        k += 1;
      }
      if (k >= lineText.length) {
        // 闭引号已打、`)` 未打的行尾形态:按闭段收,链止于行尾
        return {
          segment: { kind: 'key', key: lineText.slice(i + 1, j), keyStart: i + 1, keyEnd: j, form: 'get' },
          end: lineText.length,
          contentStart: null,
          bare: false
        };
      }
      if (lineText[k] !== ')') {
        return null;
      }
      return {
        segment: { kind: 'key', key: lineText.slice(i + 1, j), keyStart: i + 1, keyEnd: j, form: 'get' },
        end: k + 1,
        contentStart: null,
        bare: false
      };
    }
    return {
      segment: { kind: 'key', key: '', keyStart: i + 1, keyEnd: null, form: 'get' },
      end: lineText.length,
      contentStart: i + 1,
      bare: false
    };
  }
  if (i >= lineText.length) {
    // 光标紧跟 `.get(` 的补全形态:空开段
    return {
      segment: { kind: 'key', key: '', keyStart: i, keyEnd: null, form: 'get' },
      end: lineText.length,
      contentStart: i,
      bare: true
    };
  }
  // .get(变量/表达式):键静态不可知 → index 段
  let depth = 1;
  let j = i;
  while (j < lineText.length) {
    const ch = lineText[j];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    } else if (ch === '"' || ch === "'") {
      const after = skipStringLiteral(lineText, j);
      if (after < 0) {
        return null;
      }
      j = after;
      continue;
    }
    j += 1;
  }
  if (j >= lineText.length) {
    return null;
  }
  return { segment: { kind: 'index', form: 'get' }, end: j + 1, contentStart: null, bare: false };
}

/**
 * 光标处的 FIXED_DICT 下标链上下文(同行探测,与 cellData 键位家族同口径):
 * 光标在键串内容上 → cursor='key'(悬停/跳转面);光标在开键串片段里 →
 * cursor='open-key'(补全面)。链上无键位(整数/表达式下标位、接收者本身、
 * 闭括号外)或位置在行内注释里 → null(不接管,交回既有链)。
 */
export function fixedDictSubscriptContextAt(
  lineText: string,
  character: number
): FixedDictSubscriptChainContext | null {
  if (character < 0 || character > lineText.length) {
    return null;
  }
  if (positionInsideLineComment(lineText, character)) {
    return null;
  }
  for (const candidate of receiverCandidates(lineText)) {
    // 从接收者尾起逐段解析
    const atoms: ParsedChainAtom[] = [];
    let pos = candidate.end;
    for (;;) {
      while (pos < lineText.length && /\s/.test(lineText[pos])) {
        pos += 1;
      }
      const atom = pos < lineText.length ? parseChainAtomAt(lineText, pos) : null;
      if (!atom) {
        break;
      }
      atoms.push(atom);
      if (atom.contentStart !== null) {
        break; // 开段必是行尾,链解析到此为止
      }
      pos = atom.end;
    }
    if (atoms.length === 0) {
      continue;
    }
    const receiver = lineText.slice(candidate.start, candidate.end).replace(/\s+/g, '');
    for (let s = 0; s < atoms.length; s += 1) {
      const atom = atoms[s];
      if (atom.segment.kind !== 'key') {
        continue;
      }
      if (atom.contentStart === null) {
        // 闭键串:光标落在内容区间 → key 态(此段为止,后续段与光标无关)
        if (character >= atom.segment.keyStart && character < (atom.segment.keyEnd ?? -1)) {
          return {
            receiver,
            receiverStart: candidate.start,
            segments: atoms.slice(0, s + 1).map(entry => entry.segment),
            cursor: 'key',
            replaceStart: -1
          };
        }
        continue;
      }
      // 开键串:光标在内容起点及之后、片段无引号反斜杠 → open-key;裸开段
      // (`[`/`.get(` 后无引号)只认空片段——键入中的表达式不接管
      if (character >= atom.contentStart) {
        const fragment = lineText.slice(atom.contentStart, character);
        const fragmentOk = atom.bare ? fragment.length === 0 : /^[^"'\\]*$/.test(fragment);
        if (fragmentOk) {
          return {
            receiver,
            receiverStart: candidate.start,
            segments: [
              ...atoms.slice(0, s).map(entry => entry.segment),
              { ...atom.segment, key: fragment, keyStart: atom.contentStart }
            ],
            cursor: 'open-key',
            replaceStart: character - fragment.length
          };
        }
      }
    }
  }
  return null;
}

/** 链内整数/切片/未知表达式下标段(数字下标的元素型推导面归 STRUCT-03)。 */

/** 解析中的链状态:FIXED_DICT 容器或元素为 FIXED_DICT 的数组。 */
type FixedDictChainState =
  | { kind: 'fd'; info: CustomTypeInfo }
  | { kind: 'array'; element: CustomTypeInfo };

/** Python 注解 → 链状态:FIXED_DICT 类名 → fd;FixedArray[X](X 为 FIXED_DICT
 * 类名)→ array;其余(标量/list/嵌套数组元素非 FD)→ null = 本面不接管。 */
function chainStateFromAnnotation(
  annotation: string,
  customTypes: readonly CustomTypeInfo[]
): FixedDictChainState | null {
  const fd = customTypes.find(
    info => info.name === annotation && info.aliasType === FIXED_DICT_TYPE_NAME
  );
  if (fd) {
    return { kind: 'fd', info: fd };
  }
  const array = /^FixedArray\[(.+)\]$/.exec(annotation);
  if (array) {
    const element = customTypes.find(
      info => info.name === array[1] && info.aliasType === FIXED_DICT_TYPE_NAME
    );
    if (element) {
      return { kind: 'array', element };
    }
  }
  return null;
}

/** 链深度有界(诚实上限:更深链是病态类型图,不追)。 */
const FIXED_DICT_CHAIN_MAX_SEGMENTS = 8;

/** 键解析结果:容器=键所在的 FIXED_DICT 类型;field/annotation 为键命中面。 */
export interface FixedDictKeyResolution {
  container: CustomTypeInfo;
  /** 键命中的字段(types.xml Properties 子元素);未命中 null(补全面给全
   * 字段,悬停/跳转面据此落空交回) */
  field: CustomTypePropertyInfo | null;
  /** 命中字段的 Python 注解(Any/解析不出 → null,能推才显) */
  annotation: string | null;
}

/**
 * 逐层解析下标链的键:prefixSegments 全部解析后须落在 FIXED_DICT 容器上,
 * 再查 key 字段。诚实边界:非 FD 根、链中未知键、FD 上的整数下标、数组上
 * 的字符串键(引擎 Map 键是串、数组下标是整数,两向都不追)、超深链 →
 * null;根/字段解析复用 pythonTypeStubs 单一解析链(别名环/内联数组树在
 * 那层已有环检测与 FixedArray 形状)。
 */
export function resolveFixedDictSubscriptKey(
  rootTypeName: string | null | undefined,
  prefixSegments: readonly FixedDictChainSegment[],
  key: string,
  customTypes: readonly CustomTypeInfo[]
): FixedDictKeyResolution | null {
  if (prefixSegments.length > FIXED_DICT_CHAIN_MAX_SEGMENTS) {
    return null;
  }
  const trimmedRoot = rootTypeName?.trim();
  if (!trimmedRoot) {
    return null;
  }
  const rootResolved = resolveAnnotationTypeWithReason(trimmedRoot, customTypes);
  let state = chainStateFromAnnotation(rootResolved.annotation, customTypes);
  for (const segment of prefixSegments) {
    if (!state) {
      return null;
    }
    if (segment.kind === 'key') {
      if (state.kind !== 'fd') {
        return null; // 数组上的字符串键:引擎不支持的访问,断链
      }
      const field = state.info.properties.find(property => property.name === segment.key);
      if (!field) {
        return null; // 链中未知键:诚实断链(开放世界键不猜)
      }
      const annotation = resolveCustomTypePropertyAnnotation(field, customTypes);
      state = chainStateFromAnnotation(annotation, customTypes);
    } else {
      if (state.kind !== 'array') {
        return null; // FIXED_DICT 上的整数/表达式下标:键型不符,断链
      }
      state = { kind: 'fd', info: state.element };
    }
  }
  if (!state || state.kind !== 'fd') {
    return null;
  }
  const field = state.info.properties.find(property => property.name === key) ?? null;
  if (!field) {
    return { container: state.info, field: null, annotation: null };
  }
  const annotation = resolveCustomTypePropertyAnnotation(field, customTypes);
  return {
    container: state.info,
    field,
    annotation: annotation === PYTHON_TYPE_STUB_FALLBACK ? null : annotation
  };
}

/** 别名接收者的向上回看行数上限(与赋值局部变量延续面同量级的有界窗口)。 */
export const FIXED_DICT_CHAIN_ALIAS_LOOKBACK_LINES = 200;

/** 别名间接深度上限(接收者 → 赋值源 → 再一层;更深诚实不追)。 */
const FIXED_DICT_CHAIN_ALIAS_MAX_DEPTH = 2;

/**
 * 接收者表达式 → 根类型名(def 属性 <Type> 直文本)。`self.<属性>` 直接
 * 定位;裸局部名向上找最近赋值(`x = self.<属性>` / `x = y` 一层间接),
 * RHS 带下标/调用的链式形态不追(数组下标别名面归 STRUCT-03)。定位器由
 * 调用方注入(EntityMappingManager.resolvePropertyDefinitionInfo),纯逻辑
 * 可测。
 */
export async function fixedDictChainRootType(
  receiver: string,
  lines: readonly string[],
  lineIndex: number,
  resolveSelfPropertyType: (propertyName: string) => Promise<string | null | undefined>,
  depth = 0
): Promise<string | null> {
  if (receiver.startsWith('self.')) {
    const propertyName = receiver.slice('self.'.length);
    if (!/^[A-Za-z_]\w*$/.test(propertyName)) {
      return null;
    }
    return (await resolveSelfPropertyType(propertyName)) ?? null;
  }
  if (depth >= FIXED_DICT_CHAIN_ALIAS_MAX_DEPTH || !/^[A-Za-z_]\w*$/.test(receiver)) {
    return null;
  }
  for (
    let line = Math.min(lineIndex, lines.length) - 1;
    line >= Math.max(0, lineIndex - FIXED_DICT_CHAIN_ALIAS_LOOKBACK_LINES);
    line -= 1
  ) {
    const assign = /^\s*([A-Za-z_]\w*)\s*=\s*(?!=)(.+?)\s*$/.exec(lines[line]);
    if (!assign || assign[1] !== receiver) {
      continue;
    }
    const rhs = assign[2];
    const selfProp = /^self\s*\.\s*([A-Za-z_]\w*)$/.exec(rhs);
    if (selfProp) {
      return (await resolveSelfPropertyType(selfProp[1])) ?? null;
    }
    // 一层别名间接(x = y 再向上追 y 的来源)
    if (/^[A-Za-z_]\w*$/.test(rhs)) {
      return fixedDictChainRootType(rhs, lines, line, resolveSelfPropertyType, depth + 1);
    }
    return null; // 链式/调用 RHS:不追(STRUCT-03 数组下标别名面再议)
  }
  return null;
}
