import {
  FIXED_DICT_TYPE_NAME,
  KBENGINE_TYPES
} from './kbengineMetadata';
import {
  getDirectChildElements,
  parseDefDocument,
  type DefElementNode,
  type DefTextNode
} from './defParser';

/**
 * types.xml structure integrity check (RUST-177/KBE-007 diagnostic face, pure core, zero vscode):
 * alias forward references/cycles, `_` reserved prefix, alias redefinition, ARRAY `<of>`
 * chain missing/unknown target, FIXED_DICT structure (missing Properties/no fields/field
 * missing Type/unknown field type) and FD field ENTITYCALL silent persistence demotion —
 * all verified item by item against the engine's real loading source.
 *
 * Engine source anchors (kbengine kbe/src local tree, verified item by item, re-checked 2026-11-17):
 * - Load entry DataTypes::loadTypes (datatypes.cpp:105-187) is **single-pass
 *   order-sensitive**: processes entries in document order; an entry's directive = the
 *   FirstChild's getValStr (xml.cpp:121-128 only reads **text nodes**; tinyxml2 collapses
 *   whitespace-only text, so the directive = the first non-whitespace child node —
 *   whitespace-only text nodes do not exist engine-side).
 *   · Directive text == "FIXED_DICT" (exact case) → FixedDictType branch
 *     (datatypes.cpp:135-151);
 *   · Directive text == "ARRAY" → FixedArrayType branch (:152-168);
 *   · Any other text → getDataType(directive) resolution (:169-181);
 *   · FirstChild is an **element** → getValStr yields the empty string → getDataType("")
 *     misses → ERROR "can't fount type" + return false → startup aborted (:169-178);
 *   · Entry has no (non-whitespace) child node → engine **silently skips** the whole
 *     entry (no registration, no log; the if(childNode != NULL) at loadTypes :132 has
 *     no else arm).
 * - Name semantics: alias-name table lookup is a **case-sensitive exact match**
 *   (getDataType uses the exact dataTypes_ table, datatypes.cpp:221-236); redefinition
 *   dedup is the case-insensitive dataTypesLowerName_ (addDataType datatypes.cpp:190-218:
 *   hit → ERROR "name {} exist." + return false — but all three loadTypes call sites
 *   (:141/:158/:180) discard the return value, loading continues, **first registration
 *   wins** (dataTypes_ is not overwritten). Redefinition is "engine logs but non-fatal"
 *   level → this check reports Warning.
 * - `_` reserved prefix: validTypeName (datatypes.cpp:43-50) only forbids a leading `_`;
 *   loadTypes checks **before** reading the directive (:124-130) → ERROR + return false → abort.
 * - Parse failure/structure failure are both ERROR + return false → **startup aborted**
 *   (loadTypes branches :145-150/:162-167/:171-177). The engine has no cycle detection:
 *   alias cycles/self-references/forward references in a single pass necessarily land on
 *   some entry's "unknown at this moment", taking the same abort path. This check
 *   therefore judges target resolvability in **document order**; when a target name only
 *   appears later in the document, the message notes "forward reference/cycle".
 * - ARRAY (datatype.cpp FixedArrayType::initialize :1658-1719): the engine passes the
 *   directive text node in; `enterNode(directive node, "of")` scans along the **sibling
 *   chain** (xml.cpp enterNode :72-93 scans this node and following siblings, returning
 *   the first child of the hit) — `<of>` sits at the same level as the directive text.
 *   `<of>` missing → ERROR "not found of" + false → abort (:1662-1667); `<of>` directive
 *   == "ARRAY" → nesting: **the next sibling `<of>`** (keeps walking the sibling chain,
 *   not child nesting, :1671-1690); directive == "FIXED_DICT" or unresolvable → ERROR
 *   "did not find type" + false → abort (:1694-1706); nesting depth is bounded by the
 *   number of same-level XML child nodes; cycles only exist at the alias layer.
 * - FIXED_DICT (datatype.cpp FixedDictType::initialize :2048-2196): missing
 *   `<Properties>` → ERROR + false → abort (:2050-2055); field missing `<Type>` →
 *   ERROR "no label[\"Type\"] ... will be ignored" **but loading continues and the field
 *   is silently dropped, non-fatal** (:2161-2165); unknown field type → ERROR "did not
 *   find type" + false → abort (:2151-2158); the FD field type can only be a builtin
 *   name/registered alias/ARRAY (FIXED_DICT is a keyword, not a registered name; as a
 *   field type it likewise falls into the "did not find type" abort); all fields dropped
 *   (or no fields under Properties) → keyTypes_ empty → ERROR "no keys" + false →
 *   abort (:2187-2193). Any fatal → loadTypes ERROR "parse FIXED_DICT error" → abort
 *   (:145-150; ARRAY same shape :162-167).
 * - FD field persistence read: `<Persistent>` text == 'false' **case-sensitive** to turn
 *   off (:2068-2075, defaults to true — different from the .def property face's
 *   tolower+'true' semantics, see the persistentEntityCallCheck header comment).
 * - FD field ENTITYCALL silent persistence demotion: when the field type (ARRAY fields by
 *   the terminal element type) resolves to ENTITYCALL, **persistent=false is set silently
 *   with no log** — ARRAY field arm (:2104-2107), plain type arm (:2141-2144). The user
 *   believes the field is persisted while the engine silently drops persistence; when
 *   `<Persistent>false` is written explicitly there is no gap, so nothing is reported.
 * - Honest boundary (known differences between the check face and engine behavior, not
 *   claimed isomorphic):
 *   · The engine returns false and aborts at the first fatal error; later entries are
 *     never loaded at all. This check keeps scanning to report all findings in one pass,
 *     but **failed entries never enter the registered table** (the registration ledger
 *     matches the engine: fatal entries never reach addDataType; later entries, under
 *     the "resolvable only if registered before this entry" semantics, still honestly
 *     detect forward references).
 *   · Entry attributes (`type="X"` etc.) are never read by the engine; this repo's
 *     parser (compositionRoots parseTypesXml) absorbs attribute-style fall back per the
 *     PR-012 gate §1.3-① and registers into the def-side type table — that is the
 *     parser-face semantics; this check follows the engine source and **does not honor
 *     attribute style** (entries without child nodes are silently skipped by the
 *     engine); that gap is a known boundary.
 *   · The implementedBy load-failure face (loadImplModule, cellapp/baseapp/client
 *     components :2174-2181) belongs to the existing implementedBy lane, not repeated here.
 *   · Value-range/alias-chain deep semantics belong to the scalarAssign/cellData lanes
 *     respectively.
 */

/** Engine builtin type-name registry (same source as DataTypes::initialize :58-98, derived from the kbengineMetadata calibration table; exact case) */
const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set(KBENGINE_TYPES.map(item => item.name));

export type TypesXmlStructureCode =
  | 'kbengine.types.reservedPrefix'
  | 'kbengine.types.forwardRef'
  | 'kbengine.types.duplicateAlias'
  | 'kbengine.types.arrayOf'
  | 'kbengine.types.fixedDictStructure'
  | 'kbengine.types.fieldType'
  | 'kbengine.types.fieldNoType'
  | 'kbengine.types.fdEntityCallPersistent';

export interface TypesXmlStructureFinding {
  code: TypesXmlStructureCode;
  severity: 'error' | 'warning';
  /** 0-based character offset (same coordinate system as defParser; the wiring layer converts to ranges via document.positionAt) */
  offset: number;
  length: number;
  message: string;
}

/** Registered alias snapshot (the registry built by the engine's single-pass load; target = the collapsed form of that alias's directive text) */
interface KnownAlias {
  name: string;
  target: string;
}

/** Load registration ledger pair (engine twin tables): known keys = exact names (getDataType dataTypes_ semantics), knownLower = lowercase name set (addDataType dataTypesLowerName_ dedup semantics) */
type KnownTables = {
  known: Map<string, KnownAlias>;
  knownLower: Set<string>;
};

/** Whole-document name context (read-only, independent of the load ledger): routes the "forward reference/case variant" hints */
type NameContext = {
  /** All entry names in the document (original case after whitespace folding) */
  allExact: ReadonlySet<string>;
  /** Lowercase set of all entry names in the document */
  allLower: ReadonlySet<string>;
};

/**
 * Routed message for a target unresolvable at this moment (case variant/forward
 * reference/purely unknown). The engine's error-and-abort behavior is identical in all
 * three cases (getDataType misses → ERROR + return false); only the fix guidance
 * differs — a case typo points at the name comparison, a forward reference points at
 * moving the declaration order, and the rest honestly says "unresolvable at this moment".
 */
function unresolvableTargetMessage(
  subject: string,
  directive: string,
  shown: string,
  names: NameContext,
  tables: KnownTables,
  engineNote: string
): string {
  const variant = [...names.allExact].find(
    candidate => candidate.toLowerCase() === directive.toLowerCase() && candidate !== directive
  );
  if (variant) {
    return `${subject}「${shown}」与本文档已知名「${variant}」仅大小写不同：引擎 getDataType 按精确名字查表（dataTypes_，datatypes.cpp:221-236），大小写不一致不命中——${engineNote}`;
  }
  const forward = names.allLower.has(directive.toLowerCase())
    && !tables.known.has(directive)
    && !BUILTIN_TYPE_NAMES.has(directive);
  if (forward) {
    return `${subject}「${shown}」在本文档后文才声明（前向引用/循环）：引擎单遍装载此刻未知，${engineNote}——把「${directive}」的定义移到本条目之前`;
  }
  return `${subject}「${shown}」此刻不可解（引擎按精确名字查表，只认内建类型与先于本条声明的别名）：${engineNote}`;
}

/** Directive text folding (tinyxml2 collapses whitespace-only text + kbe_trim: internal whitespace runs collapse to a single space) */
function collapseDirectiveText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Engine FirstChild equivalent read: the first child that is "non-whitespace-only text
 * or an element" (defParser produces no comment child nodes, matching tinyxml2's
 * visible order of whitespace folding / comment skipping).
 */
function firstNonWhitespaceChild(node: DefElementNode): DefTextNode | DefElementNode | undefined {
  return node.children.find(child =>
    child.kind === 'element' || (child.kind === 'text' && child.text.trim().length > 0)
  );
}

/** Entry/`<of>`/`<Type>` directive read: text → folded text; element → empty string (engine getValStr yields ""); none → null (engine skips the whole entry) */
function directiveText(node: DefElementNode): string | null {
  const first = firstNonWhitespaceChild(node);
  if (!first) {
    return null;
  }
  if (first.kind === 'text') {
    return collapseDirectiveText(first.text);
  }
  return '';
}

/** Span of the element name inside the open tag (the Name segment of `<Name`) */
function elementNameSpan(node: DefElementNode): { offset: number; length: number } {
  return { offset: node.tagStart + 1, length: node.name.length };
}

/** Span of the first non-whitespace direct text (falls back to the whole element range when absent) */
function firstTextSpan(node: DefElementNode): { offset: number; length: number } {
  const first = firstNonWhitespaceChild(node);
  if (first && first.kind === 'text') {
    return { offset: first.startOffset, length: Math.max(1, first.endOffset - first.startOffset) };
  }
  return { offset: node.tagStart, length: Math.max(1, node.closeTagEnd - node.tagStart) };
}

/** Name resolvability at this moment: builtin name or registered alias — **case-sensitive exact match** (engine getDataType exact-table dataTypes_ semantics) */
function isResolvableName(name: string, tables: KnownTables): boolean {
  return BUILTIN_TYPE_NAMES.has(name) || tables.known.has(name);
}

/** Resolve a name to the end of its alias chain (exact case; bounded visited set guards cycles — a cyclic chain aborts engine loading anyway) */
function resolveAliasChainEnd(name: string, tables: KnownTables): string | null {
  let current = name;
  const visited = new Set<string>();
  while (current.length > 0 && !visited.has(current)) {
    visited.add(current);
    if (BUILTIN_TYPE_NAMES.has(current)) {
      return current;
    }
    const alias = tables.known.get(current);
    if (!alias) {
      return null;
    }
    current = alias.target;
  }
  return null;
}

/**
 * ARRAY `<of>` sibling-chain reduction (engine enterNode semantics: `<of>` sits at the
 * same level as the directive text; a nested ARRAY = the **next** sibling `<of>` at the
 * same level, not child nesting). Returns the terminal element type name (null when
 * unresolvable); FD-field callers use it to detect the ENTITYCALL silent persistence
 * demotion; a top-level ARRAY alias has no persistence semantics and ignores the return
 * value. The finding code is uniformly kbengine.types.arrayOf.
 */
function resolveArrayOfChain(
  container: DefElementNode,
  ownerLabel: string,
  tables: KnownTables,
  findings: TypesXmlStructureFinding[],
  names: NameContext
): string | null {
  const ofElements = getDirectChildElements(container).filter(node => node.name === 'of');
  for (let index = 0; index < ofElements.length; index += 1) {
    const ofElement = ofElements[index];
    const ofSpan = firstTextSpan(ofElement);
    const directive = directiveText(ofElement);
    if (directive === null) {
      // <of> has no (non-whitespace) child node → getValStr yields the empty string → getDataType("") misses
      findings.push({
        code: 'kbengine.types.arrayOf',
        severity: 'error',
        offset: ofSpan.offset,
        length: ofSpan.length,
        message: `${ownerLabel} 的 <of> 没有元素类型指引：引擎 getValStr 读得空类型后 getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:1694-1706）`
      });
      return null;
    }
    if (directive === 'ARRAY') {
      if (index + 1 >= ofElements.length) {
        findings.push({
          code: 'kbengine.types.arrayOf',
          severity: 'error',
          offset: ofSpan.offset,
          length: ofSpan.length,
          message: `${ownerLabel} 的 <of> 指引是 ARRAY（嵌套数组）但同层级没有下一个 <of> 兄弟节点：引擎沿兄弟链找下一个 <of>（不是子节点嵌套），找不到即报 not found "of" 并中止启动（datatype.cpp:1662-1667）`
        });
        return null;
      }
      continue; // the nested layer is handled by the next sibling <of> iteration
    }
    if (directive === FIXED_DICT_TYPE_NAME) {
      findings.push({
        code: 'kbengine.types.arrayOf',
        severity: 'error',
        offset: ofSpan.offset,
        length: ofSpan.length,
        message: `${ownerLabel} 的 <of> 目标是 FIXED_DICT：这是声明关键字不是已注册类型名，引擎 getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:1694-1706）`
      });
      return null;
    }
    if (directive.length === 0 || !isResolvableName(directive, tables)) {
      const shown = directive.length > 0 ? directive : '<空>';
      findings.push({
        code: 'kbengine.types.arrayOf',
        severity: 'error',
        offset: ofSpan.offset,
        length: ofSpan.length,
        message: unresolvableTargetMessage(
          `${ownerLabel} 的 <of> 目标`,
          directive,
          shown,
          names,
          tables,
          'getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:1694-1706）'
        )
      });
      return null;
    }
    return resolveAliasChainEnd(directive, tables);
  }
  findings.push({
    code: 'kbengine.types.arrayOf',
    severity: 'error',
    offset: elementNameSpan(container).offset,
    length: elementNameSpan(container).length,
    message: `${ownerLabel} 的 ARRAY 缺少 <of> 子节点：引擎 FixedArrayType::initialize 报 not found "of" 即出错并中止启动（datatype.cpp:1662-1667）`
  });
  return null;
}

/**
 * FIXED_DICT field traversal (engine FixedDictType::initialize :2048-2196 semantics).
 * Returns false = FD fatal (initialize failed; the engine aborts loading and the entry
 * is not registered); a field missing Type is a non-fatal Warning (the field is silently
 * dropped); when field resolution is complete, checks the ENTITYCALL silent persistence
 * demotion (Warning).
 */
function checkFixedDictFields(
  aliasNode: DefElementNode,
  ownerLabel: string,
  tables: KnownTables,
  findings: TypesXmlStructureFinding[],
  names: NameContext
): boolean {
  const propertiesNode = getDirectChildElements(aliasNode).find(node => node.name === 'Properties');
  if (!propertiesNode) {
    const span = elementNameSpan(aliasNode);
    findings.push({
      code: 'kbengine.types.fixedDictStructure',
      severity: 'error',
      offset: span.offset,
      length: span.length,
      message: `${ownerLabel} 缺少 <Properties> 子节点：引擎 FixedDictType::initialize 报 not found "Properties" 并中止启动（datatype.cpp:2050-2055）`
    });
    return false;
  }
  const fields = getDirectChildElements(propertiesNode);
  let resolvedFieldCount = 0;
  let fatal = false;
  for (const field of fields) {
    const fieldLabel = `FD 字段「${field.name}」`;
    const typeElement = getDirectChildElements(field).find(node => node.name === 'Type');
    if (!typeElement) {
      const span = elementNameSpan(field);
      findings.push({
        code: 'kbengine.types.fieldNoType',
        severity: 'warning',
        offset: span.offset,
        length: span.length,
        message: `${ownerLabel} 的${fieldLabel}缺少 <Type> 子节点：引擎报 no label["Type"] 后继续装载、该字段被静默丢弃——字段实际不存在（datatype.cpp:2161-2165）`
      });
      continue;
    }
    const typeSpan = firstTextSpan(typeElement);
    const directive = directiveText(typeElement);
    if (directive === null) {
      // <Type> has no (non-whitespace) child node → getValStr yields the empty string → getDataType("") misses → abort
      findings.push({
        code: 'kbengine.types.fieldType',
        severity: 'error',
        offset: typeSpan.offset,
        length: typeSpan.length,
        message: `${ownerLabel} 的${fieldLabel}的 <Type> 没有类型指引：引擎 getValStr 读得空类型后 getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:2151-2158）`
      });
      fatal = true;
      continue;
    }
    // The FD field <Persistent> defaults to true; explicit shutoff is the **case-sensitive** 'false'
    // (datatype.cpp:2068-2075; an element-form directive makes getValStr yield the empty string → treated as not shut off, engine semantics)
    const persistentElement = getDirectChildElements(field).find(node => node.name === 'Persistent');
    const persistentDirective = persistentElement ? directiveText(persistentElement) : null;
    const persistentOff = persistentDirective === 'false';
    if (directive === 'ARRAY') {
      const elementType = resolveArrayOfChain(typeElement, `${ownerLabel} 的${fieldLabel}`, tables, findings, names);
      if (elementType === null) {
        fatal = true; // ARRAY field load failure → FD initialize false → abort
        continue;
      }
      resolvedFieldCount += 1;
      if (elementType === 'ENTITYCALL' && !persistentOff) {
        findings.push({
          code: 'kbengine.types.fdEntityCallPersistent',
          severity: 'warning',
          offset: typeSpan.offset,
          length: typeSpan.length,
          message: `${ownerLabel} 的${fieldLabel}的 ARRAY 元素类型解析到 ENTITYCALL：引擎对该字段无日志静默置 persistent=false——以为在持久化其实不会持久化（datatype.cpp:2104-2107）`
        });
      }
      continue;
    }
    if (directive === FIXED_DICT_TYPE_NAME) {
      findings.push({
        code: 'kbengine.types.fieldType',
        severity: 'error',
        offset: typeSpan.offset,
        length: typeSpan.length,
        message: `${ownerLabel} 的${fieldLabel}的类型是 FIXED_DICT：这是声明关键字不是已注册类型名（FD 字段类型只能内建名/已注册别名/ARRAY），引擎 getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:2151-2158）`
      });
      fatal = true;
      continue;
    }
    if (directive.length === 0 || !isResolvableName(directive, tables)) {
      const shown = directive.length > 0 ? directive : '<空>';
      findings.push({
        code: 'kbengine.types.fieldType',
        severity: 'error',
        offset: typeSpan.offset,
        length: typeSpan.length,
        message: unresolvableTargetMessage(
          `${ownerLabel} 的${fieldLabel}的类型`,
          directive,
          shown,
          names,
          tables,
          'getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:2151-2158）'
        )
      });
      fatal = true;
      continue;
    }
    resolvedFieldCount += 1;
    if (resolveAliasChainEnd(directive, tables) === 'ENTITYCALL' && !persistentOff) {
      findings.push({
        code: 'kbengine.types.fdEntityCallPersistent',
        severity: 'warning',
        offset: typeSpan.offset,
        length: typeSpan.length,
        message: `${ownerLabel} 的${fieldLabel}的类型解析到 ENTITYCALL：引擎对该字段无日志静默置 persistent=false——以为在持久化其实不会持久化（datatype.cpp:2141-2144）`
      });
    }
  }
  // Any fatal field → FD initialize false → abort; all fields dropped / no fields →
  // keyTypes_ empty → "no keys" abort (datatype.cpp:2187-2193)
  if (fatal) {
    return false;
  }
  if (resolvedFieldCount === 0) {
    const span = elementNameSpan(aliasNode);
    findings.push({
      code: 'kbengine.types.fixedDictStructure',
      severity: 'error',
      offset: span.offset,
      length: span.length,
      message: `${ownerLabel} 没有可装载的字段（全部字段缺 <Type> 被丢弃，或 <Properties> 下没有字段）：引擎 keyTypes_ 为空即报 FIXED_DICT no keys 并中止启动（datatype.cpp:2187-2193）`
    });
    return false;
  }
  return true;
}

/**
 * Preloaded registry names (the loading context for KODE-SYN-003 alias.xml document-scope
 * validation): the engine's single pass loads types.xml before alias.xml, so when
 * validating alias.xml the already-registered types.xml names are preloaded, with their
 * directives, into the registration ledger — types.xml names are resolvable inside the
 * alias document scope, matching the engine's load order.
 */
export interface PreloadedRegistryName {
  name: string;
  /** Load directive (collapsed form, e.g. UINT32/FIXED_DICT/ARRAY/another alias name) */
  target: string;
}

/**
 * Full computation: types.xml structure integrity findings. Pure function (text in,
 * findings out). The `known` table accumulates strictly in the engine's single-pass load
 * order — when checking this entry's target the table **does not contain this entry**
 * (the engine's addDataType registers only after the target resolves successfully), so
 * self-references and forward references both land on "unknown at this moment". The
 * engine aborts at the first fatal error and later entries are not loaded; this check
 * keeps scanning to report all findings, but fatal entries never enter the table (the
 * registration ledger matches the engine, see the header-comment boundary).
 * `preloaded` = names already registered before this document (KODE-SYN-003: when
 * validating alias.xml, pass the types.xml registration face). Names with a `_` prefix
 * are not preloaded (validTypeName rejects them before registration, so the engine never
 * enters them into the table); duplicate preloaded names keep the first (engine first
 * registration wins).
 */
export function computeTypesXmlStructureFindings(
  text: string,
  preloaded?: ReadonlyArray<PreloadedRegistryName>
): TypesXmlStructureFinding[] {
  // The parser throws on malformed XML (assignNodePositions fails to locate); this
  // document face only claims on parseable documents, parse failure = zero findings
  let document;
  try {
    document = parseDefDocument(text);
  } catch {
    return [];
  }
  if (!document.root) { return []; }
  const findings: TypesXmlStructureFinding[] = [];
  const tables: KnownTables = { known: new Map<string, KnownAlias>(), knownLower: new Set<string>() };
  if (preloaded) {
    for (const entry of preloaded) {
      if (entry.name.startsWith('_') || tables.known.has(entry.name)) {
        continue;
      }
      tables.known.set(entry.name, { name: entry.name, target: entry.target });
      tables.knownLower.add(entry.name.toLowerCase());
    }
  }
  const items = getDirectChildElements(document.root);
  const names: NameContext = {
    allExact: new Set(items.map(item => item.name.trim())),
    allLower: new Set(items.map(item => item.name.trim().toLowerCase()))
  };
  for (const item of items) {
    const name = item.name.trim();
    const nameSpan = elementNameSpan(item);
    if (name.startsWith('_')) {
      // validTypeName only forbids a leading _, loadTypes checks before reading the directive → abort, entry not registered
      findings.push({
        code: 'kbengine.types.reservedPrefix',
        severity: 'error',
        offset: nameSpan.offset,
        length: nameSpan.length,
        message: `别名「${name}」以 _ 开头：引擎 validTypeName 只禁首字符 _（内部临时结构保留前缀），loadTypes 在读指引之前先查，命中即报错并中止启动（datatypes.cpp:43-50/124-130）`
      });
      continue;
    }
    const directive = directiveText(item);
    if (directive === null) {
      // Entry has no (non-whitespace) child node: engine childNode == NULL silently skips the whole entry (no registration, no log)
      continue;
    }
    let branchOk = false;
    if (directive === FIXED_DICT_TYPE_NAME) {
      branchOk = checkFixedDictFields(item, `FIXED_DICT「${name}」`, tables, findings, names);
    } else if (directive === 'ARRAY') {
      const elementType = resolveArrayOfChain(item, `别名「${name}」`, tables, findings, names);
      branchOk = elementType !== null;
    } else if (directive.length === 0) {
      // Directive reads as the empty string (first child is an element): getDataType("") misses → abort
      findings.push({
        code: 'kbengine.types.forwardRef',
        severity: 'error',
        offset: firstTextSpan(item).offset,
        length: firstTextSpan(item).length,
        message: `别名「${name}」的目标是元素形态：引擎 getValStr 只认文本节点（xml.cpp:121-128），读得空类型后 getDataType 查不到即报错并中止启动（datatypes.cpp:169-178）`
      });
      branchOk = false;
    } else if (!isResolvableName(directive, tables)) {
      findings.push({
        code: 'kbengine.types.forwardRef',
        severity: 'error',
        offset: firstTextSpan(item).offset,
        length: firstTextSpan(item).length,
        message: unresolvableTargetMessage(
          `别名「${name}」的目标`,
          directive,
          directive,
          names,
          tables,
          'getDataType 查不到即报「can\'t fount type」并中止启动（datatypes.cpp:169-178）'
        )
      });
      branchOk = false;
    } else {
      branchOk = true;
    }
    if (!branchOk) {
      continue; // fatal: engine aborts, entry not registered (addDataType never reached)
    }
    // addDataType: case-insensitive dedup hit → ERROR + false, but loadTypes discards
    // the return value → loading continues, first registration wins (this entry takes no
    // effect, report Warning)
    if (tables.knownLower.has(name.toLowerCase())) {
      findings.push({
        code: 'kbengine.types.duplicateAlias',
        severity: 'warning',
        offset: nameSpan.offset,
        length: nameSpan.length,
        message: `别名「${name}」重名（引擎大小写不敏感查重）：addDataType 打「name exist」日志后返回值被 loadTypes 丢弃——装载继续、先注册者胜，本条不会生效（datatypes.cpp:198-203，调用点 :141/:158/:180 丢弃返回）`
      });
      continue;
    }
    tables.knownLower.add(name.toLowerCase());
    tables.known.set(name, { name, target: directive });
  }
  return findings;
}
