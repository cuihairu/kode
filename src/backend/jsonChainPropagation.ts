/**
 * KSEM-SER-10:JSON dumps/loads 链传播(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md SEM-026,旧 KSEM-SER-10):仅对有绑定或可证明来源
 * 的 dumps/loads 链传播结构;处理 JSON key/tuple/数值转换,来源不明则
 * 未知。
 *
 * 消费契约(SER-08 设计 §4,docs/review/2026-11-14-ksem-ser-08-project-
 * schema-design.md):
 *  - dumps(obj) 仅当 obj 来源可证明(SER-09 dictFormatDerivation 推导 /
 *    本模块链面 loads 结果 / 字典字面量实参)才传播;来源不明 → 未知;
 *  - loads(path) 仅 schema 绑定命中才给结构;.kbengine/serialization.json
 *    的解析见 parseSerializationSchema(标量族真源 = CELL-08
 *    SCALAR_FAMILIES,src/backend/scalarFamilies.ts);
 *  - JSON 语义转换:dumps 方向 tuple→list;key 恒 str(非字符串键在
 *    SER-09 模型内本是动态键 → 开放宇宙,字符串键面天然成立);数值
 *    int/float 与 bool/None 经 Python json 往返同型,不谎报转换;
 *  - 无 schema / 绑定未命中 / 来源不明 → 零声称(未知不是诊断,静默
 *    即诚实,SER-08 §3 三禁;schema 校验失败明细经 errors 返回,诊断
 *    装配属 configContract 车道,本核心不发诊断)。
 *
 * 推导模型(模块作用域 v1,行序流敏感):
 *  - 链状态按行序推进:carrier(dumps 产物,JSON 串)/ value(loads 产物
 *    或别名)/ dead;任何其他赋值/增量写/条件体内赋值 → dead(条件体
 *    可能不执行,不能声称);def/class 体绝不落入(SER-09 同律);
 *  - import 证据才绑定调用形:`import json`/`import json as X` →
 *    `X.dumps/loads`;`from json import dumps as D, loads` → 裸名(含
 *    括号续行形态);绑定名被重绑定即死;
 *  - 调用实参 v1 收紧:单实参(顶层逗号=关键字/多实参形态 → 未知)、
 *    闭括号在同一行、调用后有后缀(方法链/三元)→ 未知;
 *  - dumps 实参解析:裸名查链状态(value 可传,carrier 是串不传)→
 *    SER-09 map 兜底(代码事实侧,流不敏感 v1);`{` 字典字面量实参
 *    (含多行,matchDictBraces 配对)走 classifyValue;非字典顶层
 *    (串/列表/元组字面量、调用)不声称——本 map 只承载 dict 结构面;
 *  - loads 实参解析:引号串字面量 → schema 绑定 fnmatch(Python
 *    fnmatch 语义,`*` 跨目录),恰一命中才声称,歧义/零命中 → 未知;
 *    裸名 → 链 carrier;其余(f 串/拼接/调用)→ 未知。
 *
 * raw/masked 双行口径同族(SER-04/05/06/09):形状判定走掩码行(注释/
 * 字符串位天然不中),串实参内容走原文行(掩码抹引号成 '_'),列对齐。
 */

import { pythonCodeLines } from './pythonParser';
import { matchDictBraces } from './fixedDictConstructCheck';
import {
  deriveDictFormats,
  classifyValue,
  isQuotedLiteral,
  type DictFormat,
  type DictValueKind
} from './dictFormatDerivation';
import { SCALAR_FAMILIES } from './scalarFamilies';

// ── schema 文件(.kbengine/serialization.json,SER-08 设计 §2.1)──

/** 字段类型:标量族名(SCALAR_FAMILIES)/ [元素类型] 数组 / type 引用。 */
export type SchemaFieldType =
  | { kind: 'scalar'; family: string }
  | { kind: 'list'; element: SchemaFieldType }
  | { kind: 'ref'; type: string };

/** 解析后的 schema:types(type id → 字段表)+ json.loads 绑定表。 */
export interface SerializationSchema {
  /** schema_version(项目作者维护;缺失/非整数 → null,仅展示不推断)。 */
  version: number | null;
  types: ReadonlyMap<string, ReadonlyMap<string, SchemaFieldType>>;
  loadsBindings: ReadonlyArray<{ path: string; type: string }>;
}

export interface SchemaParseResult {
  /** null = 无 schema 可用(非 JSON/顶层形状不对;零声称)。部分字段
   * 校验失败时 schema 仍带有效部分,失败明细在 errors(诊断车道展示)。 */
  schema: SerializationSchema | null;
  errors: string[];
}

/** schema 解析(校验失败明细在 errors;装配面应记诊断,本核心不发)。 */
export function parseSerializationSchema(text: string): SchemaParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { schema: null, errors: ['schema is not valid JSON'] };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { schema: null, errors: ['schema top level must be an object'] };
  }
  const root = doc as Record<string, unknown>;
  const errors: string[] = [];
  const sv = root['schema_version'];
  const version = typeof sv === 'number' && Number.isInteger(sv) ? sv : null;
  if (version === null) {
    errors.push('schema_version must be an integer');
  }
  // 先收全 type id(引用可前向;环检测在建字段表后统一做)
  const rawTypes = root['types'];
  const knownTypes = new Set<string>();
  if (rawTypes !== undefined &&
      (rawTypes === null || typeof rawTypes !== 'object' || Array.isArray(rawTypes))) {
    errors.push('types must be an object');
  } else if (rawTypes !== undefined) {
    for (const id of Object.keys(rawTypes as Record<string, unknown>)) {
      knownTypes.add(id);
    }
  }
  const fieldsOf = new Map<string, Map<string, SchemaFieldType>>();
  if (rawTypes !== undefined && typeof rawTypes === 'object' && !Array.isArray(rawTypes)) {
    for (const [id, entry] of Object.entries(rawTypes as Record<string, unknown>)) {
      const fieldsRaw = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)['fields']
        : undefined;
      if (fieldsRaw === undefined || fieldsRaw === null ||
          typeof fieldsRaw !== 'object' || Array.isArray(fieldsRaw)) {
        errors.push(`type ${id}: fields must be an object`);
        continue;
      }
      const fields = new Map<string, SchemaFieldType>();
      for (const [fname, spec] of Object.entries(fieldsRaw as Record<string, unknown>)) {
        const resolved = schemaFieldTypeFrom(spec, knownTypes, `type ${id} field ${fname}`, errors);
        if (resolved !== null) {
          fields.set(fname, resolved);
        }
      }
      fieldsOf.set(id, fields);
    }
  }
  // 环:ref 闭包含环的 type 造不出闭字面量,整 type 淘汰(级联:
  // 引用它的 type 字段解析不出 → 消费面零声称)
  const wellFounded = wellFoundedTypes(fieldsOf);
  for (const id of [...fieldsOf.keys()]) {
    if (!wellFounded.has(id)) {
      errors.push(`type ${id}: cyclic or unresolved type reference`);
      fieldsOf.delete(id);
    }
  }
  // bindings:仅消费 'json.loads' 键(v1;json.load/module.func 是设计
  // 预留后续车道键,不报错不消费)
  const loadsBindings: Array<{ path: string; type: string }> = [];
  const rawBindings = root['bindings'];
  if (rawBindings !== undefined &&
      (rawBindings === null || typeof rawBindings !== 'object' || Array.isArray(rawBindings))) {
    errors.push('bindings must be an object');
  } else if (rawBindings !== undefined) {
    const loadsRaw = (rawBindings as Record<string, unknown>)['json.loads'];
    if (loadsRaw !== undefined) {
      if (!Array.isArray(loadsRaw)) {
        errors.push('bindings["json.loads"] must be an array');
      } else {
        const seen = new Set<string>();
        for (const item of loadsRaw) {
          const path = item !== null && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>)['path'] : undefined;
          const type = item !== null && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>)['type'] : undefined;
          if (typeof path !== 'string' || path.length === 0 || typeof type !== 'string') {
            errors.push('binding entry must be {path, type}');
            continue;
          }
          if (!fieldsOf.has(type)) {
            errors.push(`binding ${path}: unknown type ${type}`);
            continue;
          }
          const dupKey = `${path}\u0000${type}`;
          if (seen.has(dupKey)) {
            continue; // 全同条目去重(同 path 同 type 不算歧义)
          }
          seen.add(dupKey);
          loadsBindings.push({ path, type });
        }
      }
    }
  }
  return {
    schema: { version, types: fieldsOf, loadsBindings },
    errors
  };
}

/** 字段类型解析(标量族名 → SCALAR_FAMILIES;其余串 → type 引用)。 */
function schemaFieldTypeFrom(
  spec: unknown,
  knownTypes: ReadonlySet<string>,
  where: string,
  errors: string[]
): SchemaFieldType | null {
  if (typeof spec === 'string') {
    if (SCALAR_FAMILIES.has(spec)) {
      return { kind: 'scalar', family: spec };
    }
    if (knownTypes.has(spec)) {
      return { kind: 'ref', type: spec };
    }
    errors.push(`${where}: unknown type name ${spec}`);
    return null;
  }
  if (Array.isArray(spec)) {
    if (spec.length !== 1) {
      errors.push(`${where}: list spec must be [type]`);
      return null;
    }
    const element = schemaFieldTypeFrom(spec[0], knownTypes, `${where}[]`, errors);
    return element !== null ? { kind: 'list', element } : null;
  }
  errors.push(`${where}: field spec must be a string or [type]`);
  return null;
}

/** 不动点:ref 全部落在良基 type 上的 type 才可造闭字面量。 */
function wellFoundedTypes(
  fieldsOf: ReadonlyMap<string, ReadonlyMap<string, SchemaFieldType>>
): Set<string> {
  const valid = new Set<string>();
  let changed = true;
  const refsValid = (fields: ReadonlyMap<string, SchemaFieldType>): boolean => {
    for (const ft of fields.values()) {
      let probe: SchemaFieldType | null = ft;
      while (probe !== null && probe.kind === 'list') {
        probe = probe.element;
      }
      if (probe !== null && probe.kind === 'ref' && !valid.has(probe.type)) {
        return false;
      }
    }
    return true;
  };
  while (changed) {
    changed = false;
    for (const [id, fields] of fieldsOf) {
      if (!valid.has(id) && refsValid(fields)) {
        valid.add(id);
        changed = true;
      }
    }
  }
  return valid;
}

// ── 链传播推导 ──

/** 链状态:carrier = dumps 产物(JSON 串,值结构 fmt);value = loads
 * 产物/别名(dict 结构 fmt);dead = 不可证明。 */
type ChainState =
  | { kind: 'carrier'; fmt: DictFormat }
  | { kind: 'value'; fmt: DictFormat }
  | { kind: 'dead' };

interface BindingFlags {
  from: number;
  killed: boolean;
}

/**
 * JSON 链结构推导入口:模块作用域变量 → dict 结构 map(只含可证明的
 * loads 产物/别名;carrier 是 JSON 串不声称 dict,不入 map)。
 */
export function deriveJsonChainStructures(
  text: string,
  schema: SerializationSchema | null
): Map<string, DictFormat> {
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);
  const dictFormats = deriveDictFormats(text);
  const states = new Map<string, ChainState>();
  const attrJson = new Map<string, BindingFlags>();   // import json [as X]
  const bareDumps = new Map<string, BindingFlags>();  // from json import dumps [as X]
  const bareLoads = new Map<string, BindingFlags>();
  const scopeIndents: number[] = [];
  const blockIndents: number[] = [];
  const bound = (
    table: ReadonlyMap<string, BindingFlags>,
    name: string,
    line: number
  ): boolean => {
    const flag = table.get(name);
    return flag !== undefined && !flag.killed && flag.from <= line;
  };
  const killName = (name: string): void => {
    states.set(name, { kind: 'dead' });
    const a = attrJson.get(name);
    if (a) {
      a.killed = true;
    }
    const d = bareDumps.get(name);
    if (d) {
      d.killed = true;
    }
    const l = bareLoads.get(name);
    if (l) {
      l.killed = true;
    }
  };
  const killTargets = (targetText: string): void => {
    for (const piece of targetText.split(',')) {
      const name = /^([A-Za-z_]\w*)$/.exec(piece.trim());
      if (name) {
        killName(name[1]);
      }
    }
  };
  /** dumps 实参 → 结构:裸名(value 可传 / SER-09 兜底)或字典字面量
   * (含多行);其余(串字面量/调用/非字典顶层)→ null 不声称。 */
  const dumpsArgFormat = (argMaskedTrim: string, line: number): DictFormat | null => {
    if (/^[A-Za-z_]\w*$/.test(argMaskedTrim)) {
      const state = states.get(argMaskedTrim);
      if (state && state.kind === 'value') {
        return state.fmt; // loads 产物/别名可传
      }
      return dictFormats.get(argMaskedTrim) ?? null; // SER-09 代码事实侧
    }
    if (!argMaskedTrim.startsWith('{')) {
      return null; // 串字面量/调用/其他 → 顶层非字典或不可证明
    }
    const real = realLines[line] ?? '';
    const realIndent = real.length - real.trimStart().length;
    const braceAt = realIndent + real.trim().indexOf('{');
    const matched = matchDictBraces(realLines, line, braceAt);
    if (!matched) {
      return null;
    }
    const literal = sliceLines(realLines, line, braceAt, matched.endLine, matched.endColumn);
    const classified = classifyValue(literal);
    return classified.kind === 'dict' ? classified.dict : null; // 非字典顶层不声称
  };

  let line = 0;
  while (line < masked.length) {
    const m = masked[line] ?? '';
    if (m.trim().length === 0) {
      line += 1;
      continue;
    }
    const indent = m.length - m.trimStart().length;
    while (scopeIndents.length > 0 && scopeIndents[scopeIndents.length - 1] >= indent) {
      scopeIndents.pop();
    }
    while (blockIndents.length > 0 && blockIndents[blockIndents.length - 1] >= indent) {
      blockIndents.pop();
    }
    const trimmed = m.trim();
    if (/^(async\s+)?(def|class)\s/.test(trimmed)) {
      scopeIndents.push(indent);
      line += 1;
      continue;
    }
    if (/^(if|elif|else|for|while|try|except|finally|with)\b/.test(trimmed)) {
      if (scopeIndents.length === 0) {
        blockIndents.push(indent);
      }
      line += 1;
      continue;
    }
    if (scopeIndents.length > 0) {
      line += 1; // 函数体:模块链面不入(同名跨作用域合流是谎报)
      continue;
    }
    const conditional = blockIndents.length > 0;

    // ── import 证据(含分支体内 try:import——用到了就必然已导入)──
    const impAttr = /^import\s+json(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(trimmed);
    if (impAttr) {
      attrJson.set(impAttr[1] ?? 'json', { from: line, killed: false });
      line += 1;
      continue;
    }
    const impFrom = /^from\s+json\s+import\s+(.+)$/.exec(trimmed);
    if (impFrom) {
      let itemsText = impFrom[1];
      let endLine = line;
      if (itemsText.includes('(') && !itemsText.includes(')')) {
        // 括号续行:收整到闭括号行(有界 8 行;未闭 → 无绑定诚实)
        let closed = false;
        while (!closed && endLine - line < 8) {
          endLine += 1;
          const nextLine = masked[endLine] ?? '';
          itemsText += ` ${nextLine.trim()}`;
          if (nextLine.includes(')')) {
            closed = true;
          }
        }
        if (!closed) {
          line += 1;
          continue;
        }
        itemsText = itemsText.slice(itemsText.indexOf('(') + 1, itemsText.lastIndexOf(')'));
      }
      for (const itemRaw of itemsText.split(',')) {
        const item = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(itemRaw.trim());
        if (!item) {
          continue;
        }
        const boundName = item[2] ?? item[1];
        if (item[1] === 'dumps') {
          bareDumps.set(boundName, { from: line, killed: false });
        } else if (item[1] === 'loads') {
          bareLoads.set(boundName, { from: line, killed: false });
        }
      }
      line = endLine + 1;
      continue;
    }

    // ── NAME = 调用(json.loads/dumps 属性形或绑定裸名;其余调用 =
    // 不可证明写点 → 作废)──
    const callAssign =
      /^([A-Za-z_]\w*)\s*(?::[^=]*?)?=(?![=>])\s*(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    if (callAssign) {
      const [, name, attr, fn] = callAssign;
      const parenAt = callAssign[0].length - 1;
      const argSpan = topLevelParenSpan(trimmed, parenAt);
      // 绑定判定与实参形状解耦(跨行实参也要先认出 dumps/loads 角色)
      let role: 'loads' | 'dumps' | null = null;
      if (attr !== undefined) {
        if (fn === 'loads' && bound(attrJson, attr, line)) {
          role = 'loads';
        } else if (fn === 'dumps' && bound(attrJson, attr, line)) {
          role = 'dumps';
        }
      } else if (bound(bareLoads, fn, line)) {
        role = 'loads';
      } else if (bound(bareDumps, fn, line)) {
        role = 'dumps';
      }
      if (role === null) {
        killName(name); // 绑定不成立:写点作废
        line += 1;
        continue;
      }
      if (argSpan !== null && trimmed.slice(argSpan.end + 1).trim().length !== 0) {
        killName(name); // 调用带后缀(方法链/三元):写点作废
        line += 1;
        continue;
      }
      if (argSpan === null) {
        // 跨行调用:仅 dumps 的多行字典字面量实参展开(matchDictBraces
        // 配对,闭括号须随字面量同行收口);其余跨行形态 v1 未知
        if (role !== 'dumps') {
          killName(name);
          line += 1;
          continue;
        }
        const real = realLines[line] ?? '';
        const realIndent = real.length - real.trimStart().length;
        const relBrace = real.trim().indexOf('{', parenAt);
        const matched = relBrace >= 0
          ? matchDictBraces(realLines, line, realIndent + relBrace)
          : null;
        const tailOk = matched !== null &&
          /^\)\s*;?\s*$/.test((masked[matched.endLine] ?? '').slice(matched.endColumn).trim());
        const literal = matched !== null && tailOk
          ? sliceLines(realLines, line, realIndent + relBrace, matched.endLine, matched.endColumn)
          : null;
        const classified = literal !== null ? classifyValue(literal) : null;
        const fmt = classified !== null && classified.kind === 'dict' ? classified.dict : null;
        if (conditional || fmt === null) {
          killName(name);
        } else {
          states.set(name, { kind: 'carrier', fmt: jsonFormat(fmt) });
        }
        line = matched !== null && tailOk ? matched.endLine + 1 : line + 1;
        continue;
      }
      const argMaskedTrim = trimmed.slice(argSpan.start + 1, argSpan.end).trim();
      if (role === 'loads') {
        let fmt: DictFormat | null = null;
        if (argMaskedTrim.startsWith('_')) {
          // 串字面量实参:掩码行首 '_' = 引号位,路径内容走原文行
          const argRealTrim = (realLines[line] ?? '').trim().slice(argSpan.start + 1, argSpan.end);
          if (isQuotedLiteral(argRealTrim.trim())) {
            fmt = schemaPathFormat(argRealTrim.trim().slice(1, -1), schema);
          }
        } else if (/^[A-Za-z_]\w*$/.test(argMaskedTrim)) {
          // 链 carrier(loads 只吃串;value/dict 名不是 JSON 串不传)
          const state = states.get(argMaskedTrim);
          fmt = state && state.kind === 'carrier' ? state.fmt : null;
        }
        if (conditional || fmt === null) {
          killName(name);
        } else {
          states.set(name, { kind: 'value', fmt });
        }
      } else {
        // 单实参收紧:顶层逗号 = 关键字/多实参形态 → 未知
        const hasKwargs = topLevelHasComma(argMaskedTrim);
        const fmt = hasKwargs ? null : dumpsArgFormat(argMaskedTrim, line);
        if (conditional || fmt === null) {
          killName(name);
        } else {
          states.set(name, { kind: 'carrier', fmt: jsonFormat(fmt) }); // dumps 方向转换
        }
      }
      line += 1;
      continue;
    }

    // ── NAME = 裸名(别名透传;carrier 别名仍是 carrier)──
    const alias = /^([A-Za-z_]\w*)\s*(?::[^=]*?)?=(?![=>])\s*([A-Za-z_]\w*)$/.exec(trimmed);
    if (alias) {
      const [, name, of] = alias;
      const state = states.get(of);
      if (conditional) {
        killName(name);
      } else if (state && state.kind !== 'dead') {
        states.set(name, state);
      } else if (dictFormats.has(of)) {
        states.set(name, { kind: 'value', fmt: dictFormats.get(of) as DictFormat });
      } else {
        killName(name);
      }
      line += 1;
      continue;
    }

    // ── 其余赋值/写点/删除:目标一律作废 ──
    const generic = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::[^=]*?)?=(?![=>])/.exec(trimmed);
    if (generic) {
      killTargets(generic[1]);
      line += 1;
      continue;
    }
    const aug = /^([A-Za-z_]\w*)\s*(?:\+|-|\*|\/|%|\||&|\^|>>|<<|\/\/|\*\*)=(?!=)/.exec(trimmed);
    if (aug) {
      killName(aug[1]);
      line += 1;
      continue;
    }
    const subWrite = /^([A-Za-z_]\w*)\s*\[.*\]\s*=(?![=>])/.exec(trimmed);
    if (subWrite) {
      killName(subWrite[1]);
      line += 1;
      continue;
    }
    const mutate = /^([A-Za-z_]\w*)\s*\.\s*(update|setdefault|append|add)\s*\(/.exec(trimmed);
    if (mutate) {
      killName(mutate[1]);
      line += 1;
      continue;
    }
    const delLine = /^del\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (delLine) {
      killName(delLine[1]);
      line += 1;
      continue;
    }
    line += 1;
  }
  const out = new Map<string, DictFormat>();
  for (const [name, state] of states) {
    if (state.kind === 'value') {
      out.set(name, state.fmt);
    }
  }
  return out;
}

/** schema 绑定解析:fnmatch 恰一命中 → type 结构;零命中/歧义/无
 * schema → null 零声称(三禁:不凭名字/路径推定)。 */
function schemaPathFormat(path: string, schema: SerializationSchema | null): DictFormat | null {
  if (schema === null) {
    return null;
  }
  let hit: string | null = null;
  for (const binding of schema.loadsBindings) {
    if (fnmatchToRegExp(binding.path).test(path)) {
      if (hit !== null) {
        return null; // 歧义:不取第一条、不取最长 glob(SER-08 §2.2)
      }
      hit = binding.type;
    }
  }
  if (hit === null) {
    return null;
  }
  return schemaTypeFormat(hit, schema, new Set());
}

/** schema type → 闭字面量格式(字段全必有;环/未定义 → null 零声称)。 */
function schemaTypeFormat(
  typeId: string,
  schema: SerializationSchema,
  visiting: ReadonlySet<string>
): DictFormat | null {
  const fields = schema.types.get(typeId);
  if (!fields || visiting.has(typeId)) {
    return null;
  }
  const next = new Set(visiting);
  next.add(typeId);
  const required = new Map<string, DictValueKind>();
  for (const [fname, ft] of fields) {
    const kind = schemaFieldKind(ft, schema, next);
    if (kind === null) {
      return null; // 字段解析失败 → 整 type 零声称(不半声称)
    }
    required.set(fname, kind);
  }
  return { kind: 'literal', required, optional: new Map() };
}

function schemaFieldKind(
  ft: SchemaFieldType,
  schema: SerializationSchema,
  visiting: ReadonlySet<string>
): DictValueKind | null {
  if (ft.kind === 'scalar') {
    return scalarFamilyKind(ft.family);
  }
  if (ft.kind === 'list') {
    const element = ft.element.kind === 'scalar'
      ? scalarFamilyKind(ft.element.family)
      : ft.element.kind === 'ref'
        ? refFieldKind(ft.element.type, schema, visiting)
        : null;
    return { kind: 'list', element }; // null = 元素宇宙开放,list 本身仍真
  }
  return refFieldKind(ft.type, schema, visiting);
}

function refFieldKind(
  typeId: string,
  schema: SerializationSchema,
  visiting: ReadonlySet<string>
): DictValueKind | null {
  const inner = schemaTypeFormat(typeId, schema, visiting);
  return inner !== null ? { kind: 'dict', dict: inner } : null;
}

/** 标量族 → JSON 值面(bytes 非 JSON 值不声称;vector 是数值序列,
 * 定长/元素面不声称——整数混入不谎报 float)。 */
function scalarFamilyKind(family: string): DictValueKind | null {
  const familyEntry = SCALAR_FAMILIES.get(family);
  if (!familyEntry) {
    return null;
  }
  switch (familyEntry.kind) {
    case 'integer':
      return { kind: 'scalar', scalar: 'int' };
    case 'float':
      return { kind: 'scalar', scalar: 'float' };
    case 'str':
      return { kind: 'scalar', scalar: 'str' };
    case 'bytes':
      return { kind: 'unknown' };
    case 'vector':
      return { kind: 'list', element: null };
  }
}

/** dumps 方向 JSON 语义转换:tuple→list;list/dict 递归;标量同型
 * (int→int/float→float/bool/None/str;Python json 往返不谎报转换);
 * key 恒 str 在模型内天然成立(SER-09 非字符串键=动态键→开放宇宙)。 */
function jsonFormat(fmt: DictFormat): DictFormat {
  if (fmt.kind === 'literal') {
    return {
      kind: 'literal',
      required: mapValues(fmt.required, jsonValueKind),
      optional: mapValues(fmt.optional, jsonValueKind)
    };
  }
  if (fmt.kind === 'open') {
    return { kind: 'open', observed: mapValues(fmt.observed, jsonValueKind) };
  }
  return fmt;
}

function jsonValueKind(kind: DictValueKind): DictValueKind {
  if (kind.kind === 'tuple') {
    return { kind: 'list', element: kind.element !== null ? jsonValueKind(kind.element) : null };
  }
  if (kind.kind === 'list') {
    return { kind: 'list', element: kind.element !== null ? jsonValueKind(kind.element) : null };
  }
  if (kind.kind === 'dict') {
    return { kind: 'dict', dict: jsonFormat(kind.dict) };
  }
  return kind;
}

function mapValues<K, V, R>(
  source: ReadonlyMap<K, V>,
  transform: (value: V) => R
): Map<K, R> {
  const out = new Map<K, R>();
  for (const [key, value] of source) {
    out.set(key, transform(value));
  }
  return out;
}

/** 实参文本顶层逗号(掩码行串内容已抹空,深度扫描即可;有关键字/
 * 多实参形态 → true)。 */
function topLevelHasComma(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      return true;
    }
  }
  return false;
}

/** trimmed 文本中 parenAt 起 top-level 闭括号位(掩码行串内容已抹空,
 * 引号内括号不计数;未闭 → null)。 */
function topLevelParenSpan(
  trimmed: string,
  parenAt: number
): { start: number; end: number } | null {
  let depth = 0;
  for (let i = parenAt; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return ch === ')' ? { start: parenAt, end: i } : null;
      }
    }
  }
  return null;
}

/** 多行字面量切片(自 startLine/startColumn 至 endLine/endColumn,
 * '\n' 接行——classifyValue 的行号口径)。 */
function sliceLines(
  realLines: readonly string[],
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number
): string {
  if (endLine === startLine) {
    return realLines[startLine].slice(startColumn, endColumn);
  }
  const parts = [realLines[startLine].slice(startColumn)];
  for (let i = startLine + 1; i < endLine; i += 1) {
    parts.push(realLines[i]);
  }
  parts.push(realLines[endLine].slice(0, endColumn));
  return parts.join('\n');
}

// ── Python fnmatch 语义(design §5:path glob 与 .kbengine/ 既有用法
// 一致;`*` 跨目录无路径语义)──

const fnmatchCache = new Map<string, RegExp>();

function fnmatchToRegExp(pattern: string): RegExp {
  const cached = fnmatchCache.get(pattern);
  if (cached) {
    return cached;
  }
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) {
        out += '\\[';
        continue;
      }
      let cls = pattern.slice(i + 1, close);
      i = close;
      if (cls.startsWith('!')) {
        cls = '^' + cls.slice(1);
      }
      out += cls.length > 0 ? `[${cls}]` : '\\[\\]';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const re = new RegExp(`^${out}$`);
  fnmatchCache.set(pattern, re);
  return re;
}
