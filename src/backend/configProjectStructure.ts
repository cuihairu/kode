/**
 * KSEM-CFG-08 项目配置结构提取(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md SEM-038,旧 KSEM-CFG-08):提取项目配置结构。
 * 显式 schema 优先,其次静态构造和可证明读取约束;动态 key/多文件
 * 冲突保持开放并提供来源。
 *
 * 证据三级(todo 验收同序):
 *  - explicit-schema(显式 schema 优先):.kbengine/serialization.json
 *    绑定表(SER-08 机制)声明的 path glob → 结构条目(条目序也在前);
 *    同一 glob 跨 loads/load 两表声明不同 type → 不裁定,typeId 置空、
 *    条目开放 + binding-type 冲突来源;
 *  - static-construction(静态构造):SER-09 模块作用域字典字面量推导
 *    (dictFormatDerivation);跨文件同名:形状一致 → 合并来源;形状
 *    分歧 → 不裁定、条目开放 + literal-shape 冲突来源(同名跨模块本质
 *    是不同变量,合并面是项目配置视角的约定证据,v1 明示);终局
 *    unknown 的模块名不作结构证据(该模块自己都没判出来);
 *  - 可证明读取约束:代码内 json.loads(串字面量)/
 *    json.load(open(串字面量)) 具体路径(v1 同行、属性形态;裸名
 *    import 面 v1 不入)命中绑定 glob → 该条目 readers 登记;一个
 *    具体路径命中同表多个 glob 且 type 分歧 → pathConflicts 显式报出
 *    (CFG-07 类型面对此静默双 null,本面把它翻成显式冲突并给来源;
 *    命中 glob 条目的 readers 照登——命中事实为真,不因冲突抹掉)。
 *
 * 诚实边界:
 *  - fields 只收「各方一致」的键位(某方缺键/类型分歧 → 该键摘除,
 *    不取首见、不取多数);分歧整体面由 open + conflicts 表达;
 *  - 动态 key(open)条目只报已观测键,宇宙开放;
 *  - 变量路径/f 串/多实参 loads/跨行调用不入读取面(不猜);
 *  - schema=null 时仅静态构造面,读取面零声称;
 *  - SER-09/SER-08 的作用域与歧义纪律原样继承(同名跨作用域不合流、
 *    歧义不取首条)。
 */

import { pythonCodeLines } from './pythonParser';
import {
  deriveDictFormats,
  isQuotedLiteral,
  type DictFormat,
  type DictValueKind
} from './dictFormatDerivation';
import type { SchemaFieldType, SerializationSchema } from './jsonChainPropagation';
import { schemaGlobMatches } from './jsonChainPropagation';
import {
  mapSchemaType,
  mapDictValueKind,
  matchBracket,
  topLevelCommas,
  type ConfigFieldType
} from './configFieldAccess';

/** schema 声明侧来源文件(SER-08 固定约定路径;声明不带行号)。 */
const SCHEMA_FILE = '.kbengine/serialization.json';

/** 结构证据来源(代码文件名或 schema 约定路径;line 0 基,SER-09 推导
 * 与 schema 声明不带行号 → null)。 */
export interface ConfigStructureSource {
  file: string;
  line: number | null;
}

export interface ConfigStructureConflict {
  /** binding-type = 同一 glob 跨 loader 表声明不同 type;
   * literal-shape = 跨文件同名字面量形状分歧。 */
  kind: 'binding-type' | 'literal-shape';
  /** binding-type 分歧的各方 type id(排序去重;literal-shape 为空)。 */
  typeIds: string[];
  sources: ConfigStructureSource[];
}

export interface ConfigStructureEntry {
  /** 绑定 glob(face='path-binding')/ 变量名(face='dict-literal') */
  key: string;
  /** 显式 schema 优先(条目序在前),其次静态构造 */
  tier: 'explicit-schema' | 'static-construction';
  face: 'path-binding' | 'dict-literal';
  /** path-binding:绑定 type id(binding-type 分歧 → null) */
  typeId: string | null;
  /** 各方一致的键位类型面(分歧键摘除,不猜) */
  fields: ReadonlyMap<string, ConfigFieldType>;
  /** 动态 key / 形状分歧 → 开放(宇宙开放或裁定保留) */
  open: boolean;
  sources: ConfigStructureSource[];
  /** 代码内可证明读取点(face='path-binding' 才登记) */
  readers: ConfigStructureSource[];
  conflicts: ConfigStructureConflict[];
}

export interface ConfigPathConflict {
  /** 代码内具体路径字面量 */
  path: string;
  loader: 'json.loads' | 'json.load';
  /** 同表命中的各方(glob, type) */
  matches: ReadonlyArray<{ glob: string; typeId: string }>;
  /** 读取点来源 */
  sources: ConfigStructureSource[];
}

export interface ProjectConfigStructure {
  entries: ConfigStructureEntry[];
  pathConflicts: ConfigPathConflict[];
  /** 代码读取路径但无任何绑定 glob 覆盖(零约束声称;CFG-09 路径基准
   * 面消费:显式报出而非静默丢弃) */
  uncoveredReads: ReadonlyArray<{
    path: string;
    loader: 'json.loads' | 'json.load';
    sources: ConfigStructureSource[];
  }>;
}

/** 代码内路径读取点(收集期中间面)。 */
interface PathRead {
  path: string;
  loader: 'json.loads' | 'json.load';
  file: string;
  line: number;
}

/** 调用首实参为引号串字面量 → 串内容;否则 null(变量/f 串/掩码-原文
 * 形态不符 → 拒,不猜)。allowTrailing = 容忍首实参后的其余实参
 * (open('p', encoding=...) 面);loads 面单实参口径不容忍。 */
function firstArgLiteral(
  maskedLine: string,
  realLine: string,
  openAt: number,
  allowTrailing: boolean
): string | null {
  const close = matchBracket(maskedLine, openAt);
  if (close < 0) {
    return null; // 跨行调用 v1 不入
  }
  const innerMasked = maskedLine.slice(openAt + 1, close);
  const commas = topLevelCommas(innerMasked);
  if (!allowTrailing && commas.length > 0) {
    return null;
  }
  const firstEnd = commas.length > 0 ? commas[0] : innerMasked.length;
  const seg = innerMasked.slice(0, firstEnd);
  const trimmed = seg.trim();
  if (!/^_+$/.test(trimmed)) {
    return null; // 变量/f 串等非串字面量
  }
  // 掩码把串 token 折成单 '_' + 空格补位(列保持,长度不等):原文须按
  // 段全距切(CFG-07 同律),不能按 trimmed.length 切
  const lead = seg.length - seg.trimStart().length;
  const startAbs = openAt + 1 + lead;
  const argReal = realLine.slice(startAbs, openAt + 1 + firstEnd).trim();
  if (!isQuotedLiteral(argReal)) {
    return null; // 掩码判定后原文复核(容错拒绝,CFG-07 同律)
  }
  return argReal.slice(1, -1);
}

const JSON_CALL = /json\.(loads|load)\s*\(/g;

/** 代码内具体路径读取点(v1 同行、属性形态 json.loads/json.load;
 * 裸名 from json import 面 v1 不入——注册表只收零歧义的字面证据)。 */
function collectPathReads(file: string, text: string): PathRead[] {
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);
  const reads: PathRead[] = [];
  for (let line = 0; line < masked.length; line += 1) {
    const m = masked[line] ?? '';
    const real = realLines[line] ?? '';
    JSON_CALL.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = JSON_CALL.exec(m)) !== null) {
      const loader = hit[1] === 'loads' ? 'json.loads' : 'json.load';
      const callOpen = hit.index + hit[0].length - 1;
      if (loader === 'json.loads') {
        const path = firstArgLiteral(m, real, callOpen, false);
        if (path !== null) {
          reads.push({ path, loader, file, line });
        }
      } else {
        // json.load 面:首实参须 open(...) 形态,取 open 首实参串字面量
        const callClose = matchBracket(m, callOpen);
        if (callClose < 0) {
          continue;
        }
        const inner = m.slice(callOpen + 1, callClose);
        const om = /^\s*open\s*\(/.exec(inner);
        if (om === null) {
          continue;
        }
        const openParen = callOpen + 1 + om[0].length - 1;
        const path = firstArgLiteral(m, real, openParen, true);
        if (path !== null) {
          reads.push({ path, loader, file, line });
        }
      }
    }
  }
  return reads;
}

function mapSchemaFields(
  fields: ReadonlyMap<string, SchemaFieldType>
): ReadonlyMap<string, ConfigFieldType> {
  const out = new Map<string, ConfigFieldType>();
  for (const [k, ft] of fields) {
    out.set(k, mapSchemaType(ft));
  }
  return out;
}

function sameValueKind(a: DictValueKind, b: DictValueKind): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'scalar') {
    return a.scalar === (b as typeof a).scalar;
  }
  if (a.kind === 'unknown') {
    return true;
  }
  if (a.kind === 'list' || a.kind === 'tuple') {
    const ae = a.element;
    const be = (b as typeof a).element;
    return ae === null && be === null ? true : ae !== null && be !== null ? sameValueKind(ae, be) : false;
  }
  return sameFormat(a.dict, (b as typeof a).dict);
}

function sameFormat(a: DictFormat, b: DictFormat): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'unknown') {
    return true;
  }
  if (a.kind === 'open') {
    return sameKindMap(a.observed, (b as typeof a).observed);
  }
  return (
    sameKindMap(a.required, (b as typeof a).required) &&
    sameKindMap(a.optional, (b as typeof a).optional)
  );
}

function sameKindMap(
  a: ReadonlyMap<string, DictValueKind>,
  b: ReadonlyMap<string, DictValueKind>
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (bv === undefined || !sameValueKind(v, bv)) {
      return false;
    }
  }
  return true;
}

/** 形状的某键值面(literal required∪optional / open observed;无 → null)。 */
function fmtKeyKind(fmt: DictFormat, key: string): DictValueKind | null {
  if (fmt.kind === 'literal') {
    return fmt.required.get(key) ?? fmt.optional.get(key) ?? null;
  }
  if (fmt.kind === 'open') {
    return fmt.observed.get(key) ?? null;
  }
  return null;
}

/** 各方一致的键位类型面:键须每方都有且值类型全等(缺键/分歧 → 摘除,
 * 不取首见不取多数)。 */
function agreedFields(fmts: DictFormat[]): ReadonlyMap<string, ConfigFieldType> {
  const keys = new Set<string>();
  for (const fmt of fmts) {
    if (fmt.kind === 'literal') {
      for (const k of fmt.required.keys()) {
        keys.add(k);
      }
      for (const k of fmt.optional.keys()) {
        keys.add(k);
      }
    } else if (fmt.kind === 'open') {
      for (const k of fmt.observed.keys()) {
        keys.add(k);
      }
    }
  }
  const out = new Map<string, ConfigFieldType>();
  for (const key of [...keys].sort()) {
    let kind: DictValueKind | null = null;
    let agreed = true;
    for (const fmt of fmts) {
      const vk = fmtKeyKind(fmt, key);
      if (vk === null || (kind !== null && !sameValueKind(kind, vk))) {
        agreed = false;
        break;
      }
      if (kind === null) {
        kind = vk;
      }
    }
    if (agreed && kind !== null) {
      out.set(key, mapDictValueKind(kind));
    }
  }
  return out;
}

/** 字面量形状是否 ≥2 种(只比 literal 行彼此;literal 对 open 是开放
 * 面不是形状冲突;跨文件同名分歧 → 开放 + 冲突来源)。 */
function literalsDiverge(rows: Array<{ fmt: DictFormat }>): boolean {
  const lits = rows.filter((r) => r.fmt.kind === 'literal');
  if (lits.length <= 1) {
    return false;
  }
  const first = lits[0].fmt;
  return lits.slice(1).some((r) => !sameFormat(first, r.fmt));
}

/**
 * 入口:多文件项目 Python 源 + 解析后 schema → 项目配置结构注册表。
 * 条目序:explicit-schema 在前(显式 schema 优先),再按 key 序;
 * pathConflicts 按 path/loader 序。
 */
export function deriveProjectConfigStructure(
  files: ReadonlyArray<{ file: string; text: string }>,
  schema: SerializationSchema | null
): ProjectConfigStructure {
  const entries: ConfigStructureEntry[] = [];
  const pathConflicts: ConfigPathConflict[] = [];
  const uncoveredReads: Array<{
    path: string;
    loader: 'json.loads' | 'json.load';
    sources: ConfigStructureSource[];
  }> = [];

  // ── 显式 schema 优先:绑定 glob → 条目(跨 loader 表 type 分歧 → 开放)
  if (schema !== null) {
    const globTypes = new Map<string, Set<string>>();
    const visit = (table: ReadonlyArray<{ path: string; type: string }>): void => {
      for (const b of table) {
        let set = globTypes.get(b.path);
        if (set === undefined) {
          set = new Set<string>();
          globTypes.set(b.path, set);
        }
        set.add(b.type);
      }
    };
    visit(schema.loadsBindings);
    visit(schema.loadBindings);
    const source: ConfigStructureSource = { file: SCHEMA_FILE, line: null };
    for (const glob of [...globTypes.keys()].sort()) {
      const types = [...globTypes.get(glob)!].sort();
      if (types.length === 1) {
        const fields = schema.types.get(types[0]);
        entries.push({
          key: glob,
          tier: 'explicit-schema',
          face: 'path-binding',
          typeId: types[0],
          fields: fields !== undefined ? mapSchemaFields(fields) : new Map(),
          open: false,
          sources: [source],
          readers: [],
          conflicts: []
        });
      } else {
        // 同 glob 跨表不同 type:不裁定,开放 + 冲突来源
        entries.push({
          key: glob,
          tier: 'explicit-schema',
          face: 'path-binding',
          typeId: null,
          fields: new Map(),
          open: true,
          sources: [source],
          readers: [],
          conflicts: [{ kind: 'binding-type', typeIds: types, sources: [source] }]
        });
      }
    }
  }

  // ── 可证明读取约束:代码内具体路径 → readers 登记 / pathConflicts
  const reads: PathRead[] = [];
  for (const f of files) {
    reads.push(...collectPathReads(f.file, f.text));
  }
  const byPathLoader = new Map<string, PathRead[]>();
  for (const r of reads) {
    const key = `${r.loader}\u0000${r.path}`;
    let group = byPathLoader.get(key);
    if (group === undefined) {
      group = [];
      byPathLoader.set(key, group);
    }
    group.push(r);
  }
  for (const groupKey of [...byPathLoader.keys()].sort()) {
    const group = byPathLoader.get(groupKey)!;
    const { path, loader } = group[0];
    if (schema === null) {
      continue; // 无 schema:读取面零声称
    }
    const table = loader === 'json.loads' ? schema.loadsBindings : schema.loadBindings;
    const seen = new Set<string>();
    const matches: Array<{ glob: string; typeId: string }> = [];
    for (const b of table) {
      if (schemaGlobMatches(b.path, path)) {
        const mk = `${b.path}\u0000${b.type}`;
        if (!seen.has(mk)) {
          seen.add(mk);
          matches.push({ glob: b.path, typeId: b.type });
        }
      }
    }
    const sources: ConfigStructureSource[] = group.map((r) => ({ file: r.file, line: r.line }));
    if (matches.length === 0) {
      // 未绑定路径:零约束声称,但显式报出(CFG-09 路径基准面消费)
      uncoveredReads.push({ path, loader, sources });
      continue;
    }
    const distinctTypes = [...new Set(matches.map((m) => m.typeId))];
    if (distinctTypes.length > 1) {
      // CFG-07 类型面在此静默双 null;CFG-08 显式报出并给来源
      pathConflicts.push({ path, loader, matches, sources });
    }
    for (const glob of new Set(matches.map((m) => m.glob))) {
      const entry = entries.find((e) => e.face === 'path-binding' && e.key === glob);
      if (entry !== undefined) {
        for (const s of sources) {
          if (!entry.readers.some((r) => r.file === s.file && r.line === s.line)) {
            entry.readers.push(s);
          }
        }
      }
    }
  }

  // ── 静态构造:SER-09 逐文件模块作用域推导 → 跨文件同名合并
  const nameRows = new Map<string, Array<{ file: string; fmt: DictFormat }>>();
  for (const f of files) {
    const fmts = deriveDictFormats(f.text);
    for (const [name, fmt] of fmts) {
      if (fmt.kind === 'unknown') {
        continue; // 该模块终局不可判:不作结构证据(自己都没判出来)
      }
      let rows = nameRows.get(name);
      if (rows === undefined) {
        rows = [];
        nameRows.set(name, rows);
      }
      rows.push({ file: f.file, fmt });
    }
  }
  for (const name of [...nameRows.keys()].sort()) {
    const rows = nameRows.get(name)!;
    const sources: ConfigStructureSource[] = rows.map((r) => ({ file: r.file, line: null }));
    const diverged = literalsDiverge(rows);
    const open = rows.some((r) => r.fmt.kind === 'open') || diverged;
    const conflicts: ConfigStructureConflict[] = diverged
      ? [{ kind: 'literal-shape', typeIds: [], sources }]
      : [];
    entries.push({
      key: name,
      tier: 'static-construction',
      face: 'dict-literal',
      typeId: null,
      fields: agreedFields(rows.map((r) => r.fmt)),
      open,
      sources,
      readers: [],
      conflicts
    });
  }

  const rank = (e: ConfigStructureEntry): number => (e.tier === 'explicit-schema' ? 0 : 1);
  entries.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
  return { entries, pathConflicts, uncoveredReads };
}
