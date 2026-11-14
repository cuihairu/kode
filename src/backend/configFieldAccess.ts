/**
 * KSEM-CFG-07 配置读取结果类型传播(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md SEM-037,旧 KSEM-CFG-07):给可确定配置 loader 和
 * 字段访问绑定 schema;dict/get/别名/嵌套访问保留类型及缺省值联合。
 *
 * 可确定配置 loader(经 .kbengine/serialization.json 声明绑定,SER-08
 * 机制;引擎对项目 JSON 零契约,SER-01 实测):
 *  - json.loads(串字面量)(SER-10 面延续,CFG-07 起附 type id);
 *  - json.load(open(串字面量))(CFG-07 起消费 bindings["json.load"])。
 * 字段访问面(读位点,同行链;raw/masked 双行口径同族):
 *  - dict 下标 cfg['k'];整数下标 lst[0](列表/元组元素);
 *  - .get('k') → 字段类型 + none 联合;get('k', d) → 字段类型 + d 类型
 *    联合(缺省值联合);链尾 get 才计联合,链中 get 按下标面处理;
 *  - 别名透传(链态 value 复制,同 SER-10);嵌套链 cfg['a']['b'] 逐段
 *    解析(ref 展开/列表元素/dict 字面量字段)。
 * 诚实边界(零声称,不硬造):
 *  - 变量键/关键字实参/跨行链/属性接收者(self.cfg 等)不入;
 *  - def 体访问按入体态解析,但参数遮蔽、体内写点(含嵌套 def)、模块
 *    级终态漂移(入体后全局重绑,运行期动态可见)任一命中即跳过;
 *  - 写位点(receiver[...] = / 增量)是写不是读,不入;
 *  - 开放结构(open fmt)与 unknown fmt 不声称键面;schema 联合歧义
 *    (glob 多命中)在 SER-10 面已死,不到这里。
 */

import { pythonCodeLines } from './pythonParser';
import { classifyValue, isQuotedLiteral, type DictFormat, type DictValueKind } from './dictFormatDerivation';
import type { SerializationSchema, SchemaFieldType } from './jsonChainPropagation';
import { deriveJsonChainTypedValues } from './jsonChainPropagation';

/** 字段访问解析出的类型面(scalar family:schema 侧=SCALAR_FAMILIES 名
 * (UINT32 等),derived 侧=py 标量 str/int/float/bool/none;消费面按
 * origin 区分词表)。 */
export type ConfigFieldType =
  | { kind: 'scalar'; family: string }
  | { kind: 'ref'; type: string }
  | { kind: 'list'; element: ConfigFieldType | null }
  | { kind: 'tuple'; element: ConfigFieldType | null }
  | { kind: 'dict'; fields: ReadonlyMap<string, ConfigFieldType> };

export interface ConfigFieldAccess {
  /** 0 基行 */
  line: number;
  /** 链基名(模块作用域链态名;别名透传后即别名) */
  receiver: string;
  /** 引号键链(整数下标段不记) */
  keys: string[];
  /** schema 绑定产物 / SER-09 推导字典 */
  origin: 'schema' | 'derived';
  /** schema 根 type id(origin==='schema' 才非 null) */
  typeId: string | null;
  /** 链终点类型;null = 接收者可证但键/段推不出(诚实缺口) */
  fieldType: ConfigFieldType | null;
  /** 链尾 get() 的 Python 语义联合成员(缺省值联合):无默认 → none;
   * 有默认 → 默认值类型(推不出则不追加,不硬造) */
  unionWith: ConfigFieldType[];
}

interface AccessSegment {
  key: string | null;
  index: number | null;
  isGet: boolean;
  /** get 默认实参原文(同列原文行切片,trim;null = 无默认/非 get) */
  defaultText: string | null;
}

interface AccessSite {
  line: number;
  receiver: string;
  startCol: number;
  endCol: number;
  segments: AccessSegment[];
}

interface DefInfo {
  line: number;
  indent: number;
  params: ReadonlySet<string>;
  /** 头行括号未闭合(多行参数表):参数集不完整,按保守口径处理 */
  headerUnparsed: boolean;
  headerReal: string;
  /** 体末行(不含;体= [line+1, bodyEnd)) */
  bodyEnd: number;
}

const KEYWORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'return', 'yield',
  'in', 'is', 'and', 'or', 'not', 'with', 'as', 'del', 'pass', 'raise',
  'try', 'except', 'finally', 'assert', 'lambda', 'import', 'from', 'def',
  'class', 'global', 'nonlocal'
]);

/** 链解析游标:schema 根/ schema 字段 / derived 字典格式 / derived 值类型。 */
type ChainCursor =
  | { src: 'schema-root'; typeId: string }
  | { src: 'schema'; ft: SchemaFieldType }
  | { src: 'derived-fmt'; fmt: DictFormat }
  | { src: 'derived'; vk: DictValueKind };

/** 一段下标/get 的字典面解析(失败 = null;get 的联合语义在外层算)。 */
function stepCursor(
  cursor: ChainCursor,
  key: string | null,
  index: number | null,
  schema: SerializationSchema | null
): ChainCursor | null {
  if (key === null && index === null) {
    return null;
  }
  const dictField = (fields: ReadonlyMap<string, SchemaFieldType>): ChainCursor | null => {
    if (key === null) {
      return null; // 整数下标打字典 → 不可证明
    }
    const ft = fields.get(key);
    return ft !== undefined ? { src: 'schema', ft } : null;
  };
  const fmtField = (fmt: DictFormat): ChainCursor | null => {
    if (fmt.kind !== 'literal' || key === null) {
      return null; // open/unknown 不声称键面;整数下标打字典 → 不可证明
    }
    const vk = fmt.required.get(key) ?? fmt.optional.get(key);
    return vk !== undefined ? { src: 'derived', vk } : null;
  };
  if (cursor.src === 'schema-root') {
    const fields = schema?.types.get(cursor.typeId);
    return fields !== undefined ? dictField(fields) : null;
  }
  if (cursor.src === 'schema') {
    if (cursor.ft.kind === 'ref') {
      const fields = schema?.types.get(cursor.ft.type);
      return fields !== undefined ? dictField(fields) : null;
    }
    if (cursor.ft.kind === 'list') {
      if (index === null) {
        return null;
      }
      return cursor.ft.element !== null ? { src: 'schema', ft: cursor.ft.element } : null;
    }
    return null; // scalar 基面再下标 → 不可证明
  }
  if (cursor.src === 'derived-fmt') {
    return fmtField(cursor.fmt);
  }
  // derived 值类型
  if (cursor.vk.kind === 'dict') {
    return fmtField(cursor.vk.dict);
  }
  if ((cursor.vk.kind === 'list' || cursor.vk.kind === 'tuple')) {
    if (index === null) {
      return null;
    }
    return cursor.vk.element !== null ? { src: 'derived', vk: cursor.vk.element } : null;
  }
  return null; // scalar 基面再下标 → 不可证明
}

/** schema 字段类型 → 配置类型面(CFG-08 结构注册表同用)。 */
export function mapSchemaType(ft: SchemaFieldType): ConfigFieldType {
  if (ft.kind === 'scalar') {
    return { kind: 'scalar', family: ft.family };
  }
  if (ft.kind === 'ref') {
    return { kind: 'ref', type: ft.type };
  }
  return { kind: 'list', element: ft.element !== null ? mapSchemaType(ft.element) : null };
}

function mapFmtFields(fmt: DictFormat): ReadonlyMap<string, ConfigFieldType> {
  const out = new Map<string, ConfigFieldType>();
  if (fmt.kind === 'literal') {
    for (const [k, vk] of fmt.required) {
      out.set(k, mapDictValueKind(vk));
    }
    for (const [k, vk] of fmt.optional) {
      if (!out.has(k)) {
        out.set(k, mapDictValueKind(vk));
      }
    }
  } else if (fmt.kind === 'open') {
    for (const [k, vk] of fmt.observed) {
      out.set(k, mapDictValueKind(vk));
    }
  }
  return out;
}

/** 推导值类型 → 配置类型面(unknown → 空字段面,不猜;CFG-08 同用)。 */
export function mapDictValueKind(vk: DictValueKind): ConfigFieldType {
  if (vk.kind === 'scalar') {
    return { kind: 'scalar', family: vk.scalar };
  }
  if (vk.kind === 'list') {
    return { kind: 'list', element: vk.element !== null ? mapDictValueKind(vk.element) : null };
  }
  if (vk.kind === 'tuple') {
    return { kind: 'tuple', element: vk.element !== null ? mapDictValueKind(vk.element) : null };
  }
  if (vk.kind === 'dict') {
    return { kind: 'dict', fields: mapFmtFields(vk.dict) };
  }
  return { kind: 'dict', fields: new Map() }; // unknown → 空字段面(不猜)
}

function cursorType(cursor: ChainCursor | null): ConfigFieldType | null {
  if (cursor === null) {
    return null;
  }
  if (cursor.src === 'schema-root') {
    return { kind: 'ref', type: cursor.typeId }; // 段链为 0 时兜底(正常 ≥1 段不会到这)
  }
  if (cursor.src === 'schema') {
    return mapSchemaType(cursor.ft);
  }
  if (cursor.src === 'derived-fmt') {
    return { kind: 'dict', fields: mapFmtFields(cursor.fmt) };
  }
  return mapDictValueKind(cursor.vk);
}

/** 掩码行内找匹配括号(嵌套计数;找不到 → -1;CFG-08 同用)。 */
export function matchBracket(line: string, openAt: number): number {
  const open = line[openAt];
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : null;
  if (close === null) {
    return -1;
  }
  let depth = 0;
  for (let i = openAt; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** 行内顶层逗号位置(括号深度 0;get 实参切分/CFG-08 路径扫描同用)。 */
export function topLevelCommas(s: string): number[] {
  const hits: number[] = [];
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      hits.push(i);
    }
  }
  return hits;
}

/** 同行链位点收集:接收者 + 逐段(引号键/整数下标/get±默认)。 */
function collectSites(maskedLine: string, realLine: string, line: number): AccessSite[] {
  const sites: AccessSite[] = [];
  const id = /[A-Za-z_]\w*/g;
  let m: RegExpExecArray | null;
  while ((m = id.exec(maskedLine)) !== null) {
    const receiver = m[0];
    const startCol = m.index;
    if (KEYWORDS.has(receiver)) {
      continue;
    }
    if (startCol > 0 && /[\w.]/.test(maskedLine[startCol - 1])) {
      continue; // 属性臂/标识符续段(self.cfg / x_cfg)
    }
    const segments: AccessSegment[] = [];
    let pos = id.lastIndex;
    let endCol = pos;
    let dead = false;
    while (!dead) {
      while (pos < maskedLine.length && /\s/.test(maskedLine[pos])) {
        pos += 1;
      }
      if (pos < maskedLine.length && maskedLine[pos] === '[') {
        const close = matchBracket(maskedLine, pos);
        if (close < 0) {
          break; // 未闭合(跨行链 v1 不入):保留已收段
        }
        const innerMasked = maskedLine.slice(pos + 1, close).trim();
        if (/^_+$/.test(innerMasked)) {
          const innerReal = realLine.slice(pos + 1, close).trim();
          segments.push({
            key: isQuotedLiteral(innerReal) ? innerReal.slice(1, -1) : innerReal,
            index: null,
            isGet: false,
            defaultText: null
          });
        } else if (/^\d+$/.test(innerMasked)) {
          segments.push({ key: null, index: Number.parseInt(innerMasked, 10), isGet: false, defaultText: null });
        } else {
          dead = true; // 变量键 → 链到此为止
        }
        pos = close + 1;
        endCol = pos;
        continue;
      }
      const getArm = /^\.\s*get\s*\(/.exec(maskedLine.slice(pos));
      if (getArm !== null) {
        const openAt = pos + getArm[0].length - 1;
        const close = matchBracket(maskedLine, openAt);
        if (close < 0) {
          break;
        }
        const innerMasked = maskedLine.slice(openAt + 1, close);
        const commas = topLevelCommas(innerMasked);
        const firstMasked = innerMasked.slice(0, commas.length > 0 ? commas[0] : innerMasked.length).trim();
        if (commas.length > 1 || !/^_+$/.test(firstMasked)) {
          dead = true; // 3+ 实参/关键字/变量键形态 → 不入
          break;
        }
        const firstReal = realLine.slice(openAt + 1, commas.length > 0 ? openAt + 1 + commas[0] : close).trim();
        if (!isQuotedLiteral(firstReal)) {
          dead = true; // 引号形态与掩码判定不符(容错拒绝,不猜)
          break;
        }
        segments.push({
          key: firstReal.slice(1, -1),
          index: null,
          isGet: true,
          defaultText: commas.length === 1
            ? realLine.slice(openAt + 1 + commas[0] + 1, close).trim()
            : null
        });
        pos = close + 1;
        endCol = pos;
        continue;
      }
      break;
    }
    if (dead && segments.length === 0) {
      continue;
    }
    if (segments.length > 0) {
      sites.push({ line, receiver, startCol, endCol, segments });
      // 已收站点后继续扫会重复命中链内标识符;跳过本链区间
      id.lastIndex = Math.max(id.lastIndex, endCol);
    }
  }
  return sites;
}

/** def/class 头与体域登记(缩进域;class 体也是执行作用域,类体赋值
 * 会遮蔽模块名,同 def 保守口径;参数集单行可解析才有)。 */
function collectDefs(masked: string[], realLines: string[]): DefInfo[] {
  const defs: DefInfo[] = [];
  for (let line = 0; line < masked.length; line += 1) {
    const m = /^(\s*)(?:async\s+)?(def|class)\s+[A-Za-z_]\w*/.exec(masked[line] ?? '');
    if (m === null) {
      continue;
    }
    const indent = m[1].length;
    const isDef = m[2] === 'def';
    const openAt = isDef ? (masked[line] ?? '').indexOf('(', m.index) : -1;
    const close = openAt >= 0 ? matchBracket(masked[line] ?? '', openAt) : -1;
    const params = new Set<string>();
    let headerUnparsed = false;
    if (!isDef) {
      headerUnparsed = false; // class 头无参数表;类基类里的名走体扫描
    } else if (close < 0) {
      headerUnparsed = true; // 多行参数表:保守口径
    } else {
      const inner = realLines[line]?.slice(openAt + 1, close) ?? '';
      for (const pieceRaw of splitPieces(inner)) {
        const piece = pieceRaw
          .replace(/=.*$/, '')
          .replace(/^\*+/, '')
          .split(':')[0]
          .trim();
        if (/^[A-Za-z_]\w*$/.test(piece)) {
          params.add(piece);
        }
      }
    }
    let bodyEnd = masked.length;
    for (let next = line + 1; next < masked.length; next += 1) {
      const text = masked[next] ?? '';
      if (text.trim().length === 0) {
        continue;
      }
      if (text.length - text.trimStart().length <= indent) {
        bodyEnd = next;
        break;
      }
    }
    defs.push({ line, indent, params, headerUnparsed, headerReal: realLines[line] ?? '', bodyEnd });
  }
  return defs;
}

function splitPieces(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      out.push(s.slice(at, i));
      at = i + 1;
    }
  }
  out.push(s.slice(at));
  return out;
}

/** 体内写点/遮蔽粗扫:receiver 作为参数、赋值目标、增量、下标写、变异
 * 调用、for/with/import/del 目标任一命中 → 不可解析(诚实跳过)。 */
function shadowsReceiver(def: DefInfo, receiver: string, masked: string[], realLines: string[]): boolean {
  if (def.params.has(receiver)) {
    return true;
  }
  if (def.headerUnparsed && new RegExp(`\\b${receiver}\\b`).test(def.headerReal)) {
    return true; // 多行参数表保守口径:头行出现即视为可能遮蔽
  }
  const word = receiver;
  for (let line = def.line + 1; line < def.bodyEnd; line += 1) {
    const m = masked[line] ?? '';
    const trimmed = m.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const eq = firstStandaloneEquals(trimmed);
    if (eq >= 0) {
      const target = trimmed.slice(0, eq);
      for (const pieceRaw of splitPieces(target)) {
        const piece = pieceRaw.trim().replace(/^\*+/, '').split(':')[0].trim();
        if (piece === word) {
          return true;
        }
      }
      if (/^\w+\s*\[/.test(target) && new RegExp(`^${word}\\s*\\[`).test(target)) {
        return true; // receiver[...] = 下标写
      }
    }
    const aug = new RegExp(`^${word}\\s*(?:\\+|-|\\*|/|%|\\||&|\\^|>>|<<|//|\\*\\*)=`).test(trimmed);
    if (aug) {
      return true;
    }
    if (new RegExp(`^${word}\\s*\\.\\s*(update|setdefault|append|add|insert|pop|clear|extend|remove|del)\\s*\\(`).test(trimmed)) {
      return true; // 变异调用(结构可能漂移)
    }
    if (/^for\s+/.test(trimmed)) {
      const inAt = trimmed.search(/\s+in\s/);
      if (inAt > 0) {
        const targets = trimmed.slice(3, inAt);
        for (const pieceRaw of splitPieces(targets)) {
          const piece = pieceRaw.trim().replace(/^\*+/, '').split(':')[0].trim();
          if (piece === word) {
            return true;
          }
        }
      }
    }
    if (new RegExp(`\\bas\\s+${word}\\b`).test(realLines[line] ?? '')) {
      return true; // with ... as receiver / import x as receiver
    }
    if (/^(?:import|from)\s/.test(trimmed) && new RegExp(`(^|\\s)${word}\\s*(,|$|\\.)`).test(trimmed)) {
      return true;
    }
    if (/^del\s/.test(trimmed) && new RegExp(`(^|\\s)${word}\\b`).test(trimmed)) {
      return true;
    }
  }
  return false;
}

function firstStandaloneEquals(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === '=' && depth === 0 && s[i + 1] !== '=' && s[i - 1] !== '=' && s[i - 1] !== '!' && s[i - 1] !== '<' && s[i - 1] !== '>' && s[i - 1] !== '+') {
      return i;
    }
  }
  return -1;
}

/** 写位点判定:链起点在语句首且链后是(增量)赋值 → 这是写不是读。 */
function isWriteSite(maskedLine: string, site: AccessSite): boolean {
  if (maskedLine.slice(0, site.startCol).trim().length !== 0) {
    return false;
  }
  const tail = maskedLine.slice(site.endCol).trim();
  return /^(?:=(?![=>])|(?:\+|-|\*|\/|%|\||&|\^|>>|<<|\/\/|\*\*)=)/.test(tail);
}

/** 访问行落在哪个 def 体内(栈式:行缩进 ≤ def 缩进即出体)。 */
function enclosingDef(defs: DefInfo[], line: number, maskedLine: string): DefInfo | null {
  const text = maskedLine;
  if (text.trim().length === 0) {
    return null;
  }
  const indent = text.length - text.trimStart().length;
  let found: DefInfo | null = null;
  for (const def of defs) {
    if (def.line < line && indent > def.indent && line < def.bodyEnd) {
      if (found === null || def.indent > found.indent) {
        found = def; // 最内层 def
      }
    }
  }
  return found;
}

/**
 * 入口:全文件字段访问位点 → 类型面发现列表(行序)。
 * schema=null 时只有 SER-09 推导字典面(schema loader 面零声称)。
 */
export function deriveConfigFieldAccesses(
  text: string,
  schema: SerializationSchema | null
): ConfigFieldAccess[] {
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);
  const defs = collectDefs(masked, realLines);

  const sites: AccessSite[] = [];
  for (let line = 0; line < masked.length; line += 1) {
    for (const site of collectSites(masked[line] ?? '', realLines[line] ?? '', line)) {
      if (!isWriteSite(masked[line] ?? '', site)) {
        sites.push(site);
      }
    }
  }
  if (sites.length === 0) {
    return [];
  }

  const lastLine = masked.length;
  const interest = [...new Set([...sites.map((s) => s.line), lastLine])];
  const typed = deriveJsonChainTypedValues(text, schema, interest);
  const endStates = typed.get(lastLine) ?? new Map();

  const out: ConfigFieldAccess[] = [];
  for (const site of sites) {
    const entering = typed.get(site.line)?.get(site.receiver);
    if (entering === undefined) {
      continue; // 链态不可证(未绑定/已死/局部名)
    }
    if (entering.typeId === null && entering.fmt.kind !== 'literal') {
      continue; // derived 面:开放/未知结构不声称键面
    }
    const def = enclosingDef(defs, site.line, masked[site.line] ?? '');
    if (def !== null) {
      if (shadowsReceiver(def, site.receiver, masked, realLines)) {
        continue; // 体内遮蔽/写点 → 不可证
      }
      const final = endStates.get(site.receiver);
      if (final === undefined || final.typeId !== entering.typeId || final.fmt !== entering.fmt) {
        continue; // 入体后模块级重绑(运行期动态可见)→ 不可证
      }
    }
    const origin: 'schema' | 'derived' = entering.typeId !== null ? 'schema' : 'derived';
    let cursor: ChainCursor | null = entering.typeId !== null
      ? { src: 'schema-root', typeId: entering.typeId }
      : { src: 'derived-fmt', fmt: entering.fmt };
    let dead = false;
    const keys: string[] = [];
    const unionWith: ConfigFieldType[] = [];
    const lastIdx = site.segments.length - 1;
    site.segments.forEach((seg, i) => {
      if (seg.key !== null) {
        keys.push(seg.key);
      }
      const next = cursor === null ? null : stepCursor(cursor, seg.key, seg.index, schema);
      if (next === null) {
        dead = true; // 键/段推不出:键仍记录,终点类型置空(诚实缺口)
      } else {
        cursor = next;
      }
      if (seg.isGet && i === lastIdx) {
        if (seg.defaultText === null) {
          unionWith.push({ kind: 'scalar', family: 'none' });
        } else {
          const dv = classifyValue(seg.defaultText);
          if (dv.kind !== 'unknown') {
            unionWith.push(mapDictValueKind(dv));
          }
        }
      }
    });
    out.push({
      line: site.line,
      receiver: site.receiver,
      keys,
      origin,
      typeId: entering.typeId,
      fieldType: dead ? null : cursorType(cursor),
      unionWith
    });
  }
  return out.sort((a, b) => a.line - b.line || a.receiver.localeCompare(b.receiver));
}
