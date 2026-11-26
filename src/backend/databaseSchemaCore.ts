/**
 * Pure schema derivation core (extracted per IDE-ARC-004): the full table/column
 * derivation pipeline -- type descriptors, def/types.xml parsing, alias
 * resolution, parent-chain/component merging, mysql table building. Zero vscode
 * dependency (no vscode import, no workspace/config reads; file reads go
 * through the shared snapshot service). VS Code collection/caching/rendering
 * stays in databaseSchema (adapter surface); the virtual document provider
 * lives in databaseSchemaPresentation (assembly/presentation surface).
 */
import * as path from 'path';
import * as fs from 'fs';
import {
  DefDocument,
  DefElementNode,
  DefNode,
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  getLineNumberAt,
  getScalarChildValue,
  parseDefDocument
} from './defParser';
import { normalizeFileIdentity } from './pathIdentity';
import { FIXED_DICT_TYPE_NAME } from './kbengineMetadata';

// R2-F24 (IDE-AUD-051): this module is self-sufficient in plain Node -- source
// access (def file discovery / entity registry / shared snapshot reads) is all
// injected via SchemaSourcePorts, and no module transitively depending on
// vscode is imported (definitionWorkspace/sharedFileSnapshot are wrapped by the
// adapter layer databaseSchemaSource). The types below mirror the
// corresponding shapes of those two modules.
export type DefinitionCategory = 'type' | 'entity' | 'interface' | 'component';

export interface RegisteredEntityInfo {
  name: string;
  hasCellDeclared: boolean;
  hasCell: boolean;
}

export interface SchemaInputSnapshot {
  readonly content: string;
  readonly source: 'document' | 'disk';
  readonly version: number | undefined;
}

export interface SchemaVersionRef {
  readonly source: 'document' | 'disk';
  readonly version: number | undefined;
}

export interface SchemaSourcePorts {
  findDefinitionFileByCategory(name: string, category: DefinitionCategory, workspaceRoot: string): string | null;
  findEntityDefinitionFile(name: string, workspaceRoot: string): string | null;
  getRegisteredEntities(workspaceRoot: string): RegisteredEntityInfo[];
  readInputFile(filePath: string): SchemaInputSnapshot | null;
}

/** resolveEntityHasCell only consumes entityScriptsRoot; passing the whole layout from the adapter is also structurally compatible */
export interface SchemaLayout {
  entityScriptsRoot: string | null;
}

/** Engine-default database table prefix (TABLE_PREFIX in entity_table_mysql.cpp) */
export const DB_TABLE_PREFIX = 'tbl_';
/** Engine-default column prefix */
export const DB_COLUMN_PREFIX = 'sm_';

export type RuntimeScope = 'base' | 'cell' | 'client';
export type DatabaseBackend = 'mysql' | 'redis';

export interface DefSourceRef {
  filePath: string;
  line: number;
  path: string;
  category: DefinitionCategory;
}

export interface PersistentPropertyDescriptor {
  name: string;
  typeName: string;
  /** Raw <Type> text at the property declaration site (aliases unresolved): the types.xml reverse scan matches usage sites by it */
  declaredType?: string;
  persistent: boolean;
  databaseLength?: number;
  defaultValue?: string;
  identifier: boolean;
  indexType?: string;
  flags?: string;
  scopes: RuntimeScope[];
  source: DefSourceRef;
  children?: PersistentPropertyDescriptor[];
  arrayElement?: PersistentPropertyDescriptor;
  componentTypeName?: string;
}

export interface TableFieldDescriptor {
  name: string;
  typeLabel: string;
  /** Raw <Type> text of the landed column property (aliases unresolved); synthetic engine columns have no declaration site */
  declaredType?: string;
  sourcePath: string;
  source: DefSourceRef;
  /** Effective database length (already folded to the engine default 255 for STRING/UNICODE when unconfigured) */
  databaseLength?: number;
  /** Whether DatabaseLength (>0) was explicitly configured at the declaration site -- the
   * capacity hint (IDE-DB-001) distinguishes "configured N" from
   * "unconfigured -> engine default 255"; the Rust-side FieldSchema mirrors this field */
  databaseLengthSpecified?: boolean;
  defaultValue?: string;
  indexType?: string;
  identifier: boolean;
  flags?: string;
  /** Engine structural columns (id / sm_autoLoad / parentID / the six
   * position-and-orientation columns): not derived from def properties; the
   * "property column set" SQL template uses this to strip them out */
  synthetic?: boolean;
}

export interface TableSchemaDescriptor {
  name: string;
  kind: 'entity' | 'array' | 'component';
  title: string;
  source: DefSourceRef;
  parentTableName?: string;
  propertyPath?: string;
  fields: TableFieldDescriptor[];
}
// types.xml alias entry (batch 98 aligns with DataTypes::loadTypes): the tag
// name of a direct child element of the root node is the alias, and its first
// text child node is the type directive -- "FIXED_DICT"/"ARRAY" are structural
// aliases (struct declared inline under the same element), other text is
// resolved against builtin types or alias chains.
export type TypeAliasEntry =
  | { kind: 'builtin'; target: string }
  | { kind: 'fixedDict'; node: DefElementNode; document: DefDocument; filePath: string }
  | { kind: 'array'; node: DefElementNode; document: DefDocument; filePath: string }
  | { kind: 'unresolved' };

type ResolvedAliasType =
  | { kind: 'builtin'; typeName: string }
  | { kind: 'fixedDict'; node: DefElementNode; document: DefDocument; filePath: string }
  | { kind: 'array'; node: DefElementNode; document: DefDocument; filePath: string }
  | { kind: 'unresolved' };

export interface BuildContext {
  workspaceRoot: string;
  entityDefsRoot: string;
  entityScriptsRoot: string | null;
  visitedDefinitions: Set<string>;
  componentCache: Map<string, PersistentPropertyDescriptor[]>;
  componentScopesCache: Map<string, RuntimeScope[]>;
  typeAliases: Map<string, TypeAliasEntry>;
  entityHasCell: boolean;
  /** IDE-SNP-006: shared snapshot inputs consumed at build time (fsPath -> origin domain + version), emitted with the snapshot */
  inputVersions: Map<string, SchemaVersionRef>;
  /** IDE-SCH-004: type registry file consumed by this build (types.xml path, or null when absent) */
  typeRegistryPath: string | null;
  /** IDE-SCH-004: consumed alias -> build-time resolution digest (emitted with the snapshot; registry changes are compared against consumption) */
  typeRegistryConsumed: Map<string, string>;
  /** R2-F24: source-access ports (file discovery / entity registry / snapshot reads), injected by the adapter layer */
  ports: SchemaSourcePorts;
}

/**
 * IDE-SNP-006: read build inputs through the shared snapshot and record version
 * references (manifest data surface);
 * a failed read records no entry -- file appearance/disappearance is ruled on by
 * the watcher event surface; the manifest only pins version drift.
 */
function readSchemaInputFile(filePath: string, context: BuildContext): string | null {
  const snapshot = context.ports.readInputFile(filePath);
  if (!snapshot) {
    return null;
  }
  context.inputVersions.set(filePath, { source: snapshot.source, version: snapshot.version });
  return snapshot.content;
}

// Flag -> runtime-scope membership map; the membership sets align with the
// three scope masks in the engine's common.h
// (ENTITY_BASE/CELL/CLIENT_DATA_FLAGS) and the 12 flag names in
// entitydef.cpp's g_entityFlagMapping (the CELL alias lands on the CELL_PUBLIC
// bit; scope membership is unchanged).
const FLAG_SCOPE_MAP: Record<string, RuntimeScope[]> = {
  BASE: ['base'],
  BASE_AND_CLIENT: ['base', 'client'],
  CELL: ['cell'],
  CELL_PUBLIC: ['cell'],
  CELL_PRIVATE: ['cell'],
  ALL_CLIENTS: ['cell', 'client'],
  CELL_PUBLIC_AND_OWN: ['cell', 'client'],
  OWN_CLIENT: ['cell', 'client'],
  OTHER_CLIENTS: ['cell', 'client'],
  CELL_AND_CLIENT: ['cell', 'client'],
  CELL_AND_CLIENTS: ['cell', 'client'],
  CELL_AND_OTHER_CLIENTS: ['cell', 'client']
};

const SIMPLE_DB_TYPE_LABELS: Record<string, string> = {
  INT8: 'tinyint',
  INT16: 'smallint',
  INT32: 'int',
  INT64: 'bigint',
  UINT8: 'tinyint unsigned',
  UINT16: 'smallint unsigned',
  UINT32: 'int unsigned',
  UINT64: 'bigint unsigned',
  FLOAT: 'float',
  DOUBLE: 'double',
  STRING: 'varchar',
  UNICODE: 'varchar',
  PYTHON: 'blob',
  PY_DICT: 'blob',
  PY_TUPLE: 'blob',
  PY_LIST: 'blob',
  BLOB: 'blob',
  ENTITYCALL: 'blob'
};

// The engine's EntityDef::loadInterfaces only accepts these four spellings for
// the wrapper layer and the inner element; the inner element's tag name is the
// interface name (getKey). No other spelling is accepted, and Parent is not
// followed.
const INTERFACE_SPELLINGS = new Set(['Interface', 'interface', 'Type', 'type']);

// Engine builtin types (DataTypes::getDataType registration names): the
// scalar/char/blob set and the vector set.
// When an alias chain points at them, the same builtin instance is reused
// (addDataType only changes aliasName; getName() keeps the builtin name), and
// the DB layer's createItem dispatches the mysql column type by that instance.
const BUILTIN_DB_TYPE_NAMES = new Set([
  ...Object.keys(SIMPLE_DB_TYPE_LABELS),
  'VECTOR2', 'VECTOR3', 'VECTOR4'
]);
/** IDE-SCH-001: pure derivation input -- explicit inputs already read by the collection surface (no defaults, no environment reads) */
export interface DatabaseSchemaDerivationInput {
  readonly entityName: string;
  readonly defFilePath: string;
  readonly properties: readonly PersistentPropertyDescriptor[];
  readonly hasCellContent: boolean;
  readonly tablePrefix: string;
}

export interface DatabaseSchemaDerivationResult {
  readonly tables: TableSchemaDescriptor[];
  readonly tableIndex: Map<string, TableSchemaDescriptor>;
}

/**
 * IDE-SCH-001: a schema derivation function that does not touch VS Code -- the
 * same explicit inputs always yield the same tables/columns; internally it reads
 * no config/files/workspace (input collection is the snapshot surface's job).
 * Database connection details (database) belong to the config surface, not to
 * table/column derivation, and stay on the snapshot surface.
 */
export function deriveDatabaseTables(
  input: DatabaseSchemaDerivationInput
): DatabaseSchemaDerivationResult {
  const { entityName, defFilePath, properties, hasCellContent, tablePrefix } = input;
  const entitySource: DefSourceRef = {
    filePath: defFilePath,
    line: 1,
    path: entityName,
    category: 'entity'
  };
  const tables = buildMysqlTableSchemas(entityName, entitySource, [...properties], hasCellContent, tablePrefix);
  const tableIndex = new Map<string, TableSchemaDescriptor>(tables.map(table => [table.name, table]));
  return { tables, tableIndex };
}
/** IDE-REV-039: types.xml read + manifest bookkeeping (separated from parsing --
 * the generator hands content parsing to the worker via
 * ParseDefPhase; the event surface / direct-call surface still go through the
 * full parseTypeAliases). */
export function readTypeAliasesContent(
  typesXmlPath: string | null,
  inputVersions?: Map<string, SchemaVersionRef>,
  readInputFile?: (filePath: string) => SchemaInputSnapshot | null
): { content: string; filePath: string } | null {
  if (!typesXmlPath) {
    return null;
  }

  // IDE-SNP-003: types.xml uses the same shared snapshot (unsaved alias edits
  // flow into the schema); R2-F24:
  // reads go through the injected port -- the adapter layer passes the
  // sharedFileSnapshot wrapper, Node direct calls pass their own reader
  const snapshot = readInputFile ? readInputFile(typesXmlPath) : null;
  if (!snapshot) {
    return null;
  }
  if (inputVersions) {
    inputVersions.set(typesXmlPath, { source: snapshot.source, version: snapshot.version });
  }
  return { content: snapshot.content, filePath: typesXmlPath };
}

export function parseTypeAliases(
  typesXmlPath: string | null,
  inputVersions?: Map<string, SchemaVersionRef>,
  readInputFile?: (filePath: string) => SchemaInputSnapshot | null
): Map<string, TypeAliasEntry> {
  const snapshot = readTypeAliasesContent(typesXmlPath, inputVersions, readInputFile);
  return snapshot
    ? parseTypeAliasesFromContent(snapshot.content, snapshot.filePath)
    : new Map<string, TypeAliasEntry>();
}

/** IDE-REV-039: parsed-document surface (called by the generator after the worker
 * parses via ParseDefPhase; same classification rules as
 * parseTypeAliasesFromContent). */
export function parseTypeAliasesFromDocument(
  document: DefDocument,
  filePath: string
): Map<string, TypeAliasEntry> {
  const aliases = new Map<string, TypeAliasEntry>();
  if (!document.root) {
    return aliases;
  }

  for (const item of getDirectChildElements(document.root)) {
    // Engine DataTypes::loadTypes: the alias = the entry's tag name, the type
    // directive = the first text child node
    // (getValStr(FirstChild)); "FIXED_DICT"/"ARRAY" go through structural
    // parsing, other text reuses the same instance of the already-registered
    // type (builtin or an earlier alias).
    const directive = getElementText(item).trim();
    if (directive === FIXED_DICT_TYPE_NAME) {
      aliases.set(item.name, { kind: 'fixedDict', node: item, document, filePath });
    } else if (directive === 'ARRAY') {
      aliases.set(item.name, { kind: 'array', node: item, document, filePath });
    } else if (directive) {
      aliases.set(item.name, { kind: 'builtin', target: directive });
    } else {
      aliases.set(item.name, { kind: 'unresolved' });
    }
  }

  return aliases;
}

/** IDE-SCH-004: content-surface parsing (reused for registry invalidation
 * comparison -- at event time, parse the current content once, with the same
 * classification rules as build time; nothing is written to disk and no
 * manifest entry is recorded) */
export function parseTypeAliasesFromContent(content: string, filePath: string): Map<string, TypeAliasEntry> {
  return parseTypeAliasesFromDocument(parseDefDocument(content), filePath);
}

/** IDE-SCH-004: stable digest of a structural alias -- element name + sorted
 * attributes + subtree (pure-whitespace text nodes are skipped, so reformatting
 * is not a false positive); when a dict/array alias's field set or element type
 * changes, the digest changes too. */
function defNodeDigest(node: DefNode): string {
  if (node.kind !== 'element') {
    const text = node.text.trim();
    return text ? `t:${text}` : '';
  }
  const attributes = Object.keys(node.attributes).sort()
    .map(key => `${key}=${node.attributes[key]}`)
    .join(',');
  const children = node.children
    .map(child => defNodeDigest(child))
    .filter(digest => digest !== '')
    .join('|');
  return `<${node.name} ${attributes}>${children}`;
}

/** IDE-SCH-004: resolution digest of an alias under a given alias table (the
 * sole authority for alias-change comparison):
 * b: builtin name / d: dict structural digest / a: array structural digest /
 * u: unresolved; an alias chain takes the chain-tail result, so when an
 * upstream alias changes its target, downstream consumers' digests drift too. */
export function aliasDigestInMap(aliasName: string, aliases: Map<string, TypeAliasEntry>, seen = new Set<string>()): string {
  const entry = aliases.get(aliasName);
  if (!entry || entry.kind === 'unresolved') {
    return 'u';
  }
  if (entry.kind === 'fixedDict') {
    return `d:${defNodeDigest(entry.node)}`;
  }
  if (entry.kind === 'array') {
    return `a:${defNodeDigest(entry.node)}`;
  }
  if (BUILTIN_DB_TYPE_NAMES.has(entry.target)) {
    return `b:${entry.target}`;
  }
  if (seen.has(entry.target)) {
    return 'u';
  }
  seen.add(aliasName);
  return aliasDigestInMap(entry.target, aliases, seen);
}

export function resolveAliasType(typeName: string, context: BuildContext, seen = new Set<string>()): ResolvedAliasType {
  if (typeName === 'ARRAY' || typeName === FIXED_DICT_TYPE_NAME) {
    return { kind: 'builtin', typeName };
  }

  const entry = context.typeAliases.get(typeName);
  if (!entry || entry.kind === 'unresolved') {
    // IDE-SCH-004: unresolved names also get an 'u' digest -- when the name
    // later appears in types.xml
    // (or the alias is deleted), the consumer's digest drifts and it
    // invalidates as usual (SNP-003 dirty-buffer-plus-alias semantics)
    if (context.typeRegistryPath) {
      context.typeRegistryConsumed.set(typeName, 'u');
    }
    return { kind: 'unresolved' };
  }

  // IDE-SCH-004: consumption-surface bookkeeping -- a hit alias records its
  // resolution digest (the chain-tail result), carried out with the snapshot
  // as the comparison axis for registry changes; repeated hits on the same
  // alias record the same value, so this is idempotent
  context.typeRegistryConsumed.set(typeName, aliasDigestInMap(typeName, context.typeAliases));

  if (entry.kind === 'fixedDict' || entry.kind === 'array') {
    return entry;
  }

  // The directive lands directly on a builtin type: reuse the same builtin instance
  // (the engine's getDataType only recognizes registration names)
  if (BUILTIN_DB_TYPE_NAMES.has(entry.target)) {
    return { kind: 'builtin', typeName: entry.target };
  }

  if (seen.has(entry.target)) {
    return { kind: 'unresolved' };
  }

  seen.add(typeName);
  return resolveAliasType(entry.target, context, seen);
}

// Effective type name under engine load semantics: an alias resolves to the
// same instance it points at (DataTypes::addDataType
// only changes aliasName, getName() keeps the builtin name, and the DB layer's
// createItem dispatches by getName()).
function resolveEffectiveTypeName(typeName: string, context: BuildContext): string {
  const resolved = resolveAliasType(typeName, context);
  if (resolved.kind === 'builtin') {
    return resolved.typeName;
  }
  if (resolved.kind === 'fixedDict') {
    return FIXED_DICT_TYPE_NAME;
  }
  if (resolved.kind === 'array') {
    return 'ARRAY';
  }
  return typeName;
}

/** IDE-AUD-013(F13): yield gauges computed inside a single-entity schema --
 * the async driver resets sliceStart and records bookkeeping after every
 * yield (phase gate / property gate); the generator only looks at budget to
 * decide whether to yield. The sync surface (schemaBuildPhases with no
 * progress) never triggers, matching the original monolithic behavior. */
export interface SchemaBuildProgress {
  /** Timestamp of the last yield (or build start) */
  sliceStart: number;
  /** Continuous execution budget (ms); Infinity = never yield on budget */
  budgetMs: number;
  /** Number of yields (gauge) */
  yields: number;
  /** Longest continuous run between two yields (gauge) */
  maxSliceMs: number;
}

/** IDE-AUD-013(F13): yield once the budget is exceeded -- the generator yields
 * 'phase-gate' here, and the driver decides whether to actually give up the
 * host (async surface awaits, sync surface passes straight through and
 * ignores). Without progress (sync surface) it never yields, matching the
 * original synchronous function. */
function* maybeYieldForBudget(progress: SchemaBuildProgress | undefined): Generator<'phase-gate', void, void> {
  if (progress && Date.now() - progress.sliceStart >= progress.budgetMs) {
    yield 'phase-gate';
  }
}

// IDE-REV-039: def XML parse phase (backfill slot, mirroring DerivePhase) --
// the generator hands the parse input
// to the driver (async driver awaits the worker to move it off the host, sync
// driver goes straight to parseDefDocument),
// the driver writes the document back into the slot and resumes the generator
// via next(), and the generator reads the document from the slot. One parse
// phase per build corresponds to exactly one parse, so the slot needs no
// sharing across builds. DefDocument is a plain-object graph
// (parent/document back-references form cycles), which structured clone
// supports.
export interface ParseDefPhase {
  parseDef: {
    text: string;
    label: string;
    result: { value: DefDocument | null };
  };
}

/** Yield phase of the schema build generator: phase gate or def parse (both are handled by the driver). */
export type SchemaYieldPhase = 'phase-gate' | ParseDefPhase;

export function* collectPersistentPropertiesForDefinition(
  definitionName: string,
  filePath: string,
  category: DefinitionCategory,
  context: BuildContext,
  progress?: SchemaBuildProgress
): Generator<SchemaYieldPhase, PersistentPropertyDescriptor[], void> {
  const normalizedPath = normalizePath(filePath);
  if (context.visitedDefinitions.has(normalizedPath)) {
    return [];
  }
  context.visitedDefinitions.add(normalizedPath);

  const content = readSchemaInputFile(filePath, context);
  if (!content) {
    return [];
  }

  // IDE-REV-039:def 解析移出宿主(异步驱动经 worker,同步驱动直通)——解析段
  // 是组件/接口递归内的非让路 CPU 块,交驱动解析后从槽读回文档。
  const documentSlot: ParseDefPhase['parseDef']['result'] = { value: null };
  yield { parseDef: { text: content, label: 'definition', result: documentSlot } };
  const document = documentSlot.value;
  const root = document?.root;
  if (!root) {
    return [];
  }

  const properties = new Map<string, PersistentPropertyDescriptor>();

  mergeProperties(properties, yield* parsePropertySection(
    getDirectChildElement(root, 'Properties'),
    document,
    filePath,
    category,
    definitionName,
    context,
    progress
  ));

  // 接口只装载自身 Properties 与方法段(loadAllDefDescriptions),不跟随
  // 自己的 Interfaces/Components/Parent;其余类目按引擎继续下钻。
  if (category !== 'interface') {
    yield* mergeInterfaces(properties, root, filePath, category, context, progress);

    // 此处类目只可能是 entity/component(接口在上方提前 return),而引擎
    // Components 段对这两类都装载(loadAllDefDescriptions)
    yield* mergeComponents(properties, root, document, filePath, category, context, progress);

    const parentNode = getDirectChildElement(root, 'Parent');
    const parentName = getTypeRefName(parentNode);
    if (parentName) {
      const parentCategory = category === 'component' ? 'component' : 'entity';
      const parentPath = context.ports.findDefinitionFileByCategory(parentName, parentCategory, context.workspaceRoot)
        || (parentCategory === 'entity' ? context.ports.findEntityDefinitionFile(parentName, context.workspaceRoot) : null);

      if (parentPath) {
        mergeProperties(
          properties,
          yield* collectPersistentPropertiesForDefinition(parentName, parentPath, parentCategory, context, progress)
        );
      }
    }
    // 深父链/组件链让路:跨定义递归(每层属性段可能为空)也在预算内让路
    yield* maybeYieldForBudget(progress);
  }

  return [...properties.values()];
}

function* mergeInterfaces(
  properties: Map<string, PersistentPropertyDescriptor>,
  root: DefElementNode,
  filePath: string,
  category: DefinitionCategory,
  context: BuildContext,
  progress?: SchemaBuildProgress
): Generator<SchemaYieldPhase, void, void> {
  const interfacesNode = getDirectChildElement(root, 'Interfaces');
  if (!interfacesNode) {
    return;
  }

  for (const interfaceWrapper of getDirectChildElements(interfacesNode)) {
    if (!INTERFACE_SPELLINGS.has(interfaceWrapper.name)) {
      continue;
    }

    // 引擎:enterNode(包装层,"Interface") 命中包装层自身,取其 FirstChild 的
    // getKey——文本优先,否则首个子元素标签名,即接口名。
    const interfaceName = getTypeRefName(interfaceWrapper);
    if (!interfaceName) {
      continue;
    }

    const interfacePath = context.ports.findDefinitionFileByCategory(interfaceName, 'interface', context.workspaceRoot);
    if (!interfacePath) {
      continue;
    }

    mergeProperties(
      properties,
      yield* collectPersistentPropertiesForDefinition(
        interfaceName,
        interfacePath,
        'interface',
        context,
        progress
      )
    );
    yield* maybeYieldForBudget(progress);
  }
}

function* mergeComponents(
  properties: Map<string, PersistentPropertyDescriptor>,
  root: DefElementNode,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  context: BuildContext,
  progress?: SchemaBuildProgress
): Generator<SchemaYieldPhase, void, void> {
  const componentsNode = getDirectChildElement(root, 'Components');
  if (!componentsNode) {
    return;
  }

  for (const componentNode of getDirectChildElements(componentsNode)) {
    const componentTypeName = getTypeRefName(getDirectChildElement(componentNode, 'Type'));
    if (!componentTypeName) {
      continue;
    }

    const scopes = getComponentModuleScopes(componentTypeName, context);
    // 组件槽 <Persistent> 与 Properties 段相反:引擎 loadComponents 默认持久,
    // 仅小写 "false" 关闭。
    const isPersistent = !isFalsePersistent(componentNode);
    const componentSource: DefSourceRef = {
      filePath,
      line: getLineNumberAt(document, componentNode.tagStart),
      path: componentNode.name,
      category
    };
    const children = isPersistent
      ? yield* getPersistentComponentProperties(componentTypeName, context, progress)
      : [];
    const descriptor: PersistentPropertyDescriptor = {
      name: componentNode.name,
      typeName: 'ENTITY_COMPONENT',
      persistent: isPersistent,
      identifier: false,
      indexType: undefined,
      databaseLength: undefined,
      flags: undefined,
      scopes,
      source: componentSource,
      componentTypeName,
      children
    };

    if (descriptor.persistent) {
      mergeProperties(properties, [descriptor]);
    }
    yield* maybeYieldForBudget(progress);
  }
}

function* parsePropertySection(
  sectionNode: DefElementNode | undefined,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  context: BuildContext,
  progress?: SchemaBuildProgress
): Generator<SchemaYieldPhase, PersistentPropertyDescriptor[], void> {
  if (!sectionNode) {
    return [];
  }

  const properties: PersistentPropertyDescriptor[] = [];
  for (const propertyNode of getDirectChildElements(sectionNode)) {
    const descriptor = yield* parsePropertyNode(
      propertyNode,
      document,
      filePath,
      category,
      definitionName,
      context,
      progress
    );
    if (descriptor?.persistent) {
      properties.push(descriptor);
    }
    // IDE-AUD-013(F13):6000 属性片长的 831ms 全在此循环——按预算在属性间让路
    yield* maybeYieldForBudget(progress);
  }
  return properties;
}

function* parsePropertyNode(
  propertyNode: DefElementNode,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  context: BuildContext,
  progress?: SchemaBuildProgress,
  parentPath = ''
): Generator<SchemaYieldPhase, PersistentPropertyDescriptor | null, void> {
  const rawTypeName = getScalarChildValue(propertyNode, 'Type');
  if (!rawTypeName) {
    return null;
  }

  const flags = getScalarChildValue(propertyNode, 'Flags');
  const scopes = getPropertyScopes(flags);

  // 不可达(批69 定性):parsePropertyNode 的唯一调用点是 parsePropertySection
  // (L透传),而 parsePropertySection 的唯一调用点未传 parentPath,落默认实参 ''
  // ⇒ 此处左操作数恒空串,模板串臂无触发路径(嵌套路径由 parseFixedDictChildren
  // 的 childPath 独立构造,不经此三目)。
  /* istanbul ignore start */
  const propertyPath = parentPath ? `${parentPath}.${propertyNode.name}` : propertyNode.name;
  /* istanbul ignore stop */
  const descriptor: PersistentPropertyDescriptor = {
    name: propertyNode.name,
    typeName: rawTypeName,
    declaredType: rawTypeName,
    // Properties 段的引擎装载语义:默认不持久,文本(忽略大小写)恰为 "true"
    // 才持久(loadDefPropertys)。
    persistent: isTruePersistent(propertyNode),
    databaseLength: parseOptionalNumber(getScalarChildValue(propertyNode, 'DatabaseLength')),
    defaultValue: getScalarChildValue(propertyNode, 'Default'),
    // Identifier 严格判定:引擎只认文本 "true"(忽略大小写),自闭合/空/其它
    // 值一律不算。
    identifier: getScalarChildValue(propertyNode, 'Identifier')?.trim().toLowerCase() === 'true',
    indexType: normalizeOptionalString(getScalarChildValue(propertyNode, 'Index'))?.toUpperCase(),
    flags,
    scopes,
    source: {
      filePath,
      line: getLineNumberAt(document, propertyNode.tagStart),
      path: propertyPath,
      category
    }
  };

  if (!descriptor.persistent) {
    return descriptor;
  }

  const resolved = resolveAliasType(rawTypeName, context);
  if (rawTypeName === 'ARRAY' || resolved.kind === 'array') {
    descriptor.typeName = 'ARRAY';
    const containerNode = resolved.kind === 'array' ? resolved.node : getDirectChildElement(propertyNode, 'Type');
    const containerDocument = resolved.kind === 'array' ? resolved.document : document;
    const containerFilePath = resolved.kind === 'array' ? resolved.filePath : filePath;
    descriptor.arrayElement = yield* parseArrayElementDescriptor(
      containerNode,
      containerDocument,
      containerFilePath,
      category,
      definitionName,
      context,
      propertyPath,
      descriptor,
      progress
    );
  } else if (rawTypeName === FIXED_DICT_TYPE_NAME || resolved.kind === 'fixedDict') {
    descriptor.typeName = FIXED_DICT_TYPE_NAME;
    const containerNode = resolved.kind === 'fixedDict' ? resolved.node : propertyNode;
    const containerDocument = resolved.kind === 'fixedDict' ? resolved.document : document;
    const containerFilePath = resolved.kind === 'fixedDict' ? resolved.filePath : filePath;
    descriptor.children = yield* parseFixedDictChildren(
      containerNode,
      containerDocument,
      containerFilePath,
      category,
      definitionName,
      context,
      propertyPath,
      descriptor,
      progress
    );
  } else if (resolved.kind === 'builtin') {
    descriptor.typeName = resolved.typeName;
  }

  return descriptor;
}

function* parseArrayElementDescriptor(
  containerNode: DefElementNode | undefined,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  context: BuildContext,
  propertyPath: string,
  parentDescriptor: PersistentPropertyDescriptor,
  progress?: SchemaBuildProgress
): Generator<SchemaYieldPhase, PersistentPropertyDescriptor | undefined, void> {
  const ofNode = getDirectChildElement(containerNode, 'of');
  const rawElementTypeName = getScalarChildValue(containerNode, 'of');
  if (!containerNode || !ofNode || !rawElementTypeName) {
    return undefined;
  }

  const resolved = resolveAliasType(rawElementTypeName, context);
  const elementDescriptor: PersistentPropertyDescriptor = {
    // 引擎:元素项名非 FIXED_DICT 时为 "value",FIXED_DICT 元素项名为空串
    // (空名使列名不带 value_ 前缀,且子表命名链跳过该层)。
    name: resolveEffectiveTypeName(rawElementTypeName, context) === FIXED_DICT_TYPE_NAME ? '' : 'value',
    typeName: rawElementTypeName,
    declaredType: rawElementTypeName,
    persistent: true,
    databaseLength: parentDescriptor.databaseLength,
    identifier: false,
    indexType: undefined,
    flags: parentDescriptor.flags,
    scopes: [...parentDescriptor.scopes],
    source: {
      filePath,
      line: getLineNumberAt(document, containerNode.tagStart),
      path: `${propertyPath}[]`,
      category
    }
  };

  // 元素类型分支按 raw 或解析后种类判定(镜像 parsePropertyNode):别名
  // FIXED_DICT/ARRAY 的结构分支与列层的 typeName 归一必须与顶层属性同规则,
  // 否则别名数组元素不建子表、别名 FD 元素不取 Properties。
  if (rawElementTypeName === 'ARRAY' || resolved.kind === 'array') {
    elementDescriptor.typeName = 'ARRAY';
    // 别名数组的元素类型定义在别名条目下(inline 嵌套数组极少见,保持一层)
    const nestedContainer = resolved.kind === 'array' ? resolved.node : ofNode;
    const nestedDocument = resolved.kind === 'array' ? resolved.document : document;
    const nestedFilePath = resolved.kind === 'array' ? resolved.filePath : filePath;
    elementDescriptor.arrayElement = yield* parseArrayElementDescriptor(
      nestedContainer,
      nestedDocument,
      nestedFilePath,
      category,
      definitionName,
      context,
      `${propertyPath}[]`,
      elementDescriptor,
      progress
    );
  } else if (rawElementTypeName === FIXED_DICT_TYPE_NAME || resolved.kind === 'fixedDict') {
    elementDescriptor.typeName = FIXED_DICT_TYPE_NAME;
    // 元素 FIXED_DICT 是别名时,Properties 挂在 types.xml 条目下(DataTypes::
    // loadTypes 先按条目建出 FixedDictType 实例,数组元素复用同一实例);
    // inline 数组则挂在 <of> 元素下。
    const fdContainer = resolved.kind === 'fixedDict' ? resolved.node : ofNode;
    const fdDocument = resolved.kind === 'fixedDict' ? resolved.document : document;
    const fdFilePath = resolved.kind === 'fixedDict' ? resolved.filePath : filePath;
    elementDescriptor.children = yield* parseFixedDictChildren(
      fdContainer,
      fdDocument,
      fdFilePath,
      category,
      definitionName,
      context,
      `${propertyPath}[]`,
      elementDescriptor,
      progress
    );
  } else if (resolved.kind === 'builtin') {
    elementDescriptor.typeName = resolved.typeName;
  }

  return elementDescriptor;
}

function* parseFixedDictChildren(
  containerNode: DefElementNode,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  context: BuildContext,
  propertyPath: string,
  parentDescriptor: PersistentPropertyDescriptor,
  progress?: SchemaBuildProgress
): Generator<SchemaYieldPhase, PersistentPropertyDescriptor[], void> {
  const propertiesNode = getDirectChildElement(containerNode, 'Properties');
  if (!propertiesNode) {
    return [];
  }

  const children: PersistentPropertyDescriptor[] = [];
  for (const childNode of getDirectChildElements(propertiesNode)) {
    const rawTypeName = getScalarChildValue(childNode, 'Type');
    if (!rawTypeName) {
      continue;
    }

    const effectiveTypeName = resolveEffectiveTypeName(rawTypeName, context);
    // FIXED_DICT 子键默认持久,仅 "false" 关闭(datatype.cpp FixedDictType::
    // initialize);键类型为 ENTITYCALL(含直接元素为 ENTITYCALL 的数组)时引擎
    // 强制持久=false,键项整体不落。
    const isEntityCallKey = effectiveTypeName === 'ENTITYCALL'
      || (
        effectiveTypeName === 'ARRAY'
        && arrayDirectElementTypeName(childNode, rawTypeName, context) === 'ENTITYCALL'
      );
    if (isEntityCallKey || isFalsePersistent(childNode)) {
      continue;
    }

    const childPath = `${propertyPath}.${childNode.name}`;
    const childDescriptor: PersistentPropertyDescriptor = {
      name: childNode.name,
      typeName: rawTypeName,
      declaredType: rawTypeName,
      persistent: true,
      databaseLength: parseOptionalNumber(getScalarChildValue(childNode, 'DatabaseLength')),
      identifier: false,
      indexType: undefined,
      flags: parentDescriptor.flags,
      scopes: [...parentDescriptor.scopes],
      source: {
        filePath,
        line: getLineNumberAt(document, childNode.tagStart),
        path: childPath,
        category
      }
    };

    const resolved = resolveAliasType(rawTypeName, context);
    if (effectiveTypeName === 'ARRAY') {
      childDescriptor.typeName = 'ARRAY';
      // inline 数组的 <of> 挂在 Type 元素下;别名数组则挂在 types.xml 条目下
      const containerNodeOfChild = resolved.kind === 'array'
        ? resolved.node
        : getDirectChildElement(childNode, 'Type');
      const containerDocument = resolved.kind === 'array' ? resolved.document : document;
      const containerFilePath = resolved.kind === 'array' ? resolved.filePath : filePath;
      childDescriptor.arrayElement = yield* parseArrayElementDescriptor(
        containerNodeOfChild,
        containerDocument,
        containerFilePath,
        category,
        definitionName,
        context,
        childPath,
        childDescriptor,
        progress
      );
    } else if (effectiveTypeName === FIXED_DICT_TYPE_NAME) {
      childDescriptor.typeName = FIXED_DICT_TYPE_NAME;
      const nestedContainer = resolved.kind === 'fixedDict' ? resolved.node : childNode;
      const nestedDocument = resolved.kind === 'fixedDict' ? resolved.document : document;
      const nestedFilePath = resolved.kind === 'fixedDict' ? resolved.filePath : filePath;
      childDescriptor.children = yield* parseFixedDictChildren(
        nestedContainer,
        nestedDocument,
        nestedFilePath,
        category,
        definitionName,
        context,
        childPath,
        childDescriptor,
        progress
      );
    } else if (resolved.kind === 'builtin') {
      childDescriptor.typeName = resolved.typeName;
    }

    children.push(childDescriptor);
    yield* maybeYieldForBudget(progress);
  }

  return children;
}

// inline/别名 ARRAY 的直接元素有效类型名(FixedDictType 强制规则只看直接元素;
// 数组套数组的元素是数组,不算 ENTITYCALL 键)。
function arrayDirectElementTypeName(
  propertyNode: DefElementNode,
  rawTypeName: string,
  context: BuildContext
): string | null {
  const resolved = resolveAliasType(rawTypeName, context);
  const ofOwner = resolved.kind === 'array' ? resolved.node : getDirectChildElement(propertyNode, 'Type');
  const rawElementTypeName = getScalarChildValue(ofOwner, 'of');
  if (!rawElementTypeName) {
    return null;
  }

  return resolveEffectiveTypeName(rawElementTypeName, context);
}

function* getPersistentComponentProperties(
  componentTypeName: string,
  context: BuildContext,
  progress?: SchemaBuildProgress
): Generator<SchemaYieldPhase, PersistentPropertyDescriptor[], void> {
  const cached = context.componentCache.get(componentTypeName);
  if (cached) {
    return clonePersistentProperties(cached);
  }

  const componentPath = context.ports.findDefinitionFileByCategory(componentTypeName, 'component', context.workspaceRoot);
  if (!componentPath) {
    return [];
  }

  const properties = yield* collectPersistentPropertiesForDefinition(
    componentTypeName,
    componentPath,
    'component',
    context,
    progress
  );
  context.componentCache.set(componentTypeName, clonePersistentProperties(properties));
  return clonePersistentProperties(properties);
}

// 组件模块 has*(loadComponents 计算槽旗标的依据):自身+接口+父类 def 内容
// (属性旗标域 + 非空方法段)∨ 脚本存在性(autoMatchCompOwn 只置真不清零)。
// client 域仅在同时具备 base 或 cell 时才落位(引擎按 hasBase/hasCell 分支拼位)。
function getComponentModuleScopes(componentTypeName: string, context: BuildContext): RuntimeScope[] {
  const cached = context.componentScopesCache.get(componentTypeName);
  if (cached) {
    return [...cached];
  }

  // 预填防环:组件父链互指时按无域处理
  context.componentScopesCache.set(componentTypeName, []);

  const has = { base: false, cell: false, client: false };
  // 独立 visited:has* 扫描先于属性收集执行,不得占用共享的
  // visitedDefinitions(否则同一 def 的属性收集会被短路成空)。
  const visitedScopes = new Set<string>();
  const componentPath = context.ports.findDefinitionFileByCategory(componentTypeName, 'component', context.workspaceRoot);
  if (componentPath) {
    collectDefinitionHasFlags(componentPath, 'component', context, has, visitedScopes);
  }

  if (componentScriptExists(context, 'base', componentTypeName)) {
    has.base = true;
  }
  if (componentScriptExists(context, 'cell', componentTypeName)) {
    has.cell = true;
  }

  const scopes: RuntimeScope[] = [];
  if (has.base) {
    scopes.push('base');
  }
  if (has.cell) {
    scopes.push('cell');
  }
  if (has.client && (has.base || has.cell)) {
    scopes.push('client');
  }

  context.componentScopesCache.set(componentTypeName, scopes);
  return [...scopes];
}

function collectDefinitionHasFlags(
  filePath: string,
  category: DefinitionCategory,
  context: BuildContext,
  has: { base: boolean; cell: boolean; client: boolean },
  visitedScopes: Set<string>
): void {
  const normalizedPath = normalizePath(filePath);
  if (visitedScopes.has(normalizedPath)) {
    return;
  }
  visitedScopes.add(normalizedPath);

  const content = readSchemaInputFile(filePath, context);
  if (!content) {
    return;
  }

  const document = parseDefDocument(content);
  const root = document.root;
  if (!root) {
    return;
  }

  const propertiesNode = getDirectChildElement(root, 'Properties');
  for (const propertyNode of getDirectChildElements(propertiesNode)) {
    for (const scope of getPropertyScopes(getScalarChildValue(propertyNode, 'Flags'))) {
      has[scope] = true;
    }
  }

  for (const methodSection of ['BaseMethods', 'CellMethods', 'ClientMethods'] as const) {
    const sectionNode = getDirectChildElement(root, methodSection);
    if (!sectionNode || getDirectChildElements(sectionNode).length === 0) {
      continue;
    }

    if (methodSection === 'BaseMethods') {
      has.base = true;
    } else if (methodSection === 'CellMethods') {
      has.cell = true;
    } else {
      has.client = true;
    }
  }

  if (category === 'interface') {
    return;
  }

  // 接口内容并入模块 has*(loadInterfaces → loadAllDefDescriptions 落同一模块)
  const interfacesNode = getDirectChildElement(root, 'Interfaces');
  if (interfacesNode) {
    for (const interfaceWrapper of getDirectChildElements(interfacesNode)) {
      if (!INTERFACE_SPELLINGS.has(interfaceWrapper.name)) {
        continue;
      }

      const interfaceName = getTypeRefName(interfaceWrapper);
      if (!interfaceName) {
        continue;
      }

      const interfacePath = context.ports.findDefinitionFileByCategory(interfaceName, 'interface', context.workspaceRoot);
      if (interfacePath) {
        collectDefinitionHasFlags(interfacePath, 'interface', context, has, visitedScopes);
      }
    }
  }

  const parentNode = getDirectChildElement(root, 'Parent');
  const parentName = getTypeRefName(parentNode);
  if (parentName) {
    // 不可达(批98 定性):has* 扫描只由 getComponentModuleScopes 以 'component'
    // 进入、接口类目在上方提前 return ⇒ 父臂类目恒为 'component','entity' 臂
    // 与 findEntityDefinitionFile 兜底(可达孪生在属性收集的父臂)无触发路径。
    /* istanbul ignore start */
    const parentCategory = category === 'component' ? 'component' : 'entity';
    const parentPath = context.ports.findDefinitionFileByCategory(parentName, parentCategory, context.workspaceRoot)
      || (parentCategory === 'entity' ? context.ports.findEntityDefinitionFile(parentName, context.workspaceRoot) : null);
    /* istanbul ignore stop */
    if (parentPath) {
      collectDefinitionHasFlags(parentPath, parentCategory, context, has, visitedScopes);
    }
  }
}

// 实体 has*(dbmgr 装载面):entities.xml 属性声明优先(autoMatchCompOwn 的
// assertion),否则 scripts/cell/<Name>.py(.pyc)存在性;def 内容旗标在
// autoMatchCompOwn 处被覆盖,不参与判定。
export function resolveEntityHasCell(
  entityName: string,
  workspaceRoot: string,
  layout: SchemaLayout,
  ports: SchemaSourcePorts
): boolean {
  const entityInfo = ports.getRegisteredEntities(workspaceRoot).find(entity => entity.name === entityName);
  if (entityInfo?.hasCellDeclared) {
    return entityInfo.hasCell;
  }

  return scriptExists(layout.entityScriptsRoot, 'cell', entityName);
}

function scriptExists(
  scriptsRoot: string | null,
  app: 'base' | 'cell',
  moduleName: string
): boolean {
  // 不可达(批64 定性):entityScriptsRoot 派生自恒非空的 entityDefsRoot,
  // 快照入口已守卫非空,此 null 臂无触发路径。
  /* istanbul ignore start */
  if (!scriptsRoot) {
    return false;
  }
  /* istanbul ignore stop */

  const appRoot = path.join(scriptsRoot, app);
  return fs.existsSync(path.join(appRoot, `${moduleName}.py`))
    || fs.existsSync(path.join(appRoot, `${moduleName}.pyc`));
}

function componentScriptExists(
  context: BuildContext,
  app: 'base' | 'cell',
  componentTypeName: string
): boolean {
  // autoMatchCompOwn 的组件分支:scripts/{base,cell}/components/<Name>.py
  // (组件模块不做 entities.xml 声明判定)
  return scriptExists(
    context.entityScriptsRoot,
    app,
    path.join('components', componentTypeName)
  );
}
export function buildMysqlTableSchemas(
  entityName: string,
  entitySource: DefSourceRef,
  properties: PersistentPropertyDescriptor[],
  hasCellContent: boolean,
  tablePrefix: string = DB_TABLE_PREFIX
): TableSchemaDescriptor[] {
  const tables: TableSchemaDescriptor[] = [];
  const rootTableName = `${tablePrefix}${entityName}`;
  const rootTable: TableSchemaDescriptor = {
    name: rootTableName,
    kind: 'entity',
    title: entityName,
    source: entitySource,
    propertyPath: entityName,
    fields: []
  };
  tables.push(rootTable);

  // 引擎建表:所有表固定 id(自增主键)+ sm_autoLoad(带索引),子表再加
  // parentID(带索引);实体 hasCell 时追加 position/direction 六列
  // (EntityTableMysql::initialize/syncToDB)。
  rootTable.fields.push(
    createSyntheticField('id', 'bigint unsigned', 'id', entitySource, 'PRIMARY'),
    createSyntheticField('sm_autoLoad', 'tinyint', 'autoLoad', entitySource, 'INDEX')
  );

  if (hasCellContent) {
    rootTable.fields.push(
      createSyntheticField('sm_0_position', 'float', 'position.x', entitySource),
      createSyntheticField('sm_1_position', 'float', 'position.y', entitySource),
      createSyntheticField('sm_2_position', 'float', 'position.z', entitySource),
      createSyntheticField('sm_0_direction', 'float', 'direction.roll', entitySource),
      createSyntheticField('sm_1_direction', 'float', 'direction.pitch', entitySource),
      createSyntheticField('sm_2_direction', 'float', 'direction.yaw', entitySource)
    );
  }

  for (const property of properties) {
    appendPropertyToTable(rootTable, tables, property, rootTableName, rootTableName, [], hasCellContent, '');
  }

  return tables;
}

function appendPropertyToTable(
  table: TableSchemaDescriptor,
  tables: TableSchemaDescriptor[],
  property: PersistentPropertyDescriptor,
  currentTableName: string,
  parentTableName: string,
  nameChain: string[],
  entityHasCell: boolean,
  fixedDictPrefix = ''
): void {
  if (!property.persistent) {
    return;
  }

  if (property.typeName === 'ARRAY') {
    // 子表名 = 当前表名 + 祖先项名链(非空段)+ 自身名;元素项落在子表顶层,
    // 链与 FD 前缀均重置(EntityTableItemMysql_ARRAY::initialize /
    // init_db_item_name 忽略 exstrFlag)。
    const tableName = buildArrayTableName(currentTableName, nameChain, property.name);
    const childTable = createArrayTable(tableName, currentTableName, property);
    tables.push(childTable);

    if (property.arrayElement) {
      appendPropertyToTable(
        childTable,
        tables,
        property.arrayElement,
        childTable.name,
        childTable.name,
        [],
        entityHasCell
      );
    }
    return;
  }

  if (property.typeName === 'ENTITY_COMPONENT') {
    // 引擎规则(组件表构建循环):实体无 cell 内容且组件槽旗标无 base 域时,
    // 组件连表一起跳过。
    if (!entityHasCell && !property.scopes.includes('base')) {
      return;
    }

    // 组件子表名 = 容器表名 + 组件名(不串 FD 链;FD 内组件项的父表即容器表)
    const childTableName = `${currentTableName}_${property.name}`;
    const childTable = createComponentTable(childTableName, currentTableName, property);
    tables.push(childTable);

    for (const childProperty of property.children || []) {
      appendPropertyToTable(
        childTable,
        tables,
        childProperty,
        childTable.name,
        childTable.name,
        [],
        entityHasCell
      );
    }
    return;
  }

  if (property.typeName === 'ENTITYCALL') {
    // ENTITYCALL 不落列(EntityTableItemMysql_ENTITYCALL 的 syncToDB 为空);
    // 顶层数组的子表照建,但元素列由本分支吞掉。
    return;
  }

  if (property.typeName === FIXED_DICT_TYPE_NAME) {
    // FD 键链:只有 FD 键名累积进前缀;FD 作数组元素时项名为空串,前缀不加段
    const nextPrefix = property.name
      ? `${fixedDictPrefix}${property.name}_`
      : fixedDictPrefix;
    // 不可达(批69 定性):FIXED_DICT 描述符的 children 由全部构造点恒赋为数组
    // (至少为 []),clone 路径亦保持数组 ⇒ 兜底右臂无触发路径。
    /* istanbul ignore start */
    for (const childProperty of property.children || []) {
    /* istanbul ignore stop */
      appendPropertyToTable(
        table,
        tables,
        childProperty,
        currentTableName,
        parentTableName,
        [...nameChain, property.name],
        entityHasCell,
        nextPrefix
      );
    }
    return;
  }

  for (const fieldName of expandColumnNames(property, fixedDictPrefix)) {
    if (table.fields.some(field => field.name === fieldName)) {
      continue;
    }

    table.fields.push({
      name: fieldName,
      typeLabel: resolveDbTypeLabel(property.typeName),
      declaredType: property.declaredType,
      sourcePath: property.source.path,
      source: property.source,
      databaseLength: resolveEffectiveDatabaseLength(property),
      // IDE-DB-001:有效长度已折算默认 255,声明与否单独留痕(容量提示用)
      databaseLengthSpecified:
        property.databaseLength !== undefined && property.databaseLength > 0,
      defaultValue: property.defaultValue,
      indexType: property.indexType,
      identifier: property.identifier,
      flags: property.flags
    });
  }
}

// 子表命名链:祖先项名的非空段(空段 = FD 作数组元素的那层)逐级拼 '_'
function buildArrayTableName(
  currentTableName: string,
  nameChain: string[],
  arrayName: string
): string {
  let tableName = currentTableName;
  for (const segment of nameChain) {
    if (segment) {
      tableName += `_${segment}`;
    }
  }

  // 不可达(批69 定性):数组自身名出自标签名或 'value',恒非空 ⇒ 右臂无触发路径。
  /* istanbul ignore start */
  return `${tableName}_${arrayName || 'values'}`;
  /* istanbul ignore stop */
}

function createArrayTable(
  tableName: string,
  parentTableName: string,
  property: PersistentPropertyDescriptor
): TableSchemaDescriptor {
  return {
    name: tableName,
    kind: 'array',
    title: property.source.path,
    source: property.source,
    parentTableName,
    propertyPath: property.source.path,
    fields: [
      createSyntheticField('id', 'bigint unsigned', 'id', property.source, 'PRIMARY'),
      createSyntheticField('parentID', 'bigint unsigned', 'parentID', property.source, 'INDEX'),
      createSyntheticField('sm_autoLoad', 'tinyint', 'autoLoad', property.source, 'INDEX')
    ]
  };
}

function createComponentTable(
  tableName: string,
  parentTableName: string,
  property: PersistentPropertyDescriptor
): TableSchemaDescriptor {
  return {
    name: tableName,
    kind: 'component',
    title: property.source.path,
    source: property.source,
    parentTableName,
    propertyPath: property.source.path,
    fields: [
      createSyntheticField('id', 'bigint unsigned', 'id', property.source, 'PRIMARY'),
      createSyntheticField('parentID', 'bigint unsigned', 'parentID', property.source, 'INDEX'),
      createSyntheticField('sm_autoLoad', 'tinyint', 'autoLoad', property.source, 'INDEX')
    ]
  };
}

export function expandColumnNames(property: PersistentPropertyDescriptor, fixedDictPrefix = ''): string[] {
  // 引擎向量命名:index 在前,FD 前缀夹在 index 与项名之间
  // (init_db_item_name: TABLE_ITEM_PERFIX"_%d_%s%s")。
  switch (property.typeName) {
    case 'VECTOR2':
      return [0, 1].map(index => `${DB_COLUMN_PREFIX}${index}_${fixedDictPrefix}${property.name}`);
    case 'VECTOR3':
      return [0, 1, 2].map(index => `${DB_COLUMN_PREFIX}${index}_${fixedDictPrefix}${property.name}`);
    case 'VECTOR4':
      return [0, 1, 2, 3].map(index => `${DB_COLUMN_PREFIX}${index}_${fixedDictPrefix}${property.name}`);
    default:
      return [`${DB_COLUMN_PREFIX}${fixedDictPrefix}${property.name}`];
  }
}

function createSyntheticField(
  name: string,
  typeLabel: string,
  sourcePath: string,
  source: DefSourceRef,
  indexType?: string
): TableFieldDescriptor {
  return {
    name,
    typeLabel,
    sourcePath,
    source,
    indexType,
    identifier: false,
    synthetic: true
  };
}

export function resolveDbTypeLabel(typeName: string): string {
  return SIMPLE_DB_TYPE_LABELS[typeName] || typeName.toLowerCase();
}

// STRING/UNICODE 未声明 DatabaseLength(或声明 ≤0)时按引擎默认 255 落列
function resolveEffectiveDatabaseLength(property: PersistentPropertyDescriptor): number | undefined {
  if (property.typeName === 'STRING' || property.typeName === 'UNICODE') {
    return property.databaseLength && property.databaseLength > 0 ? property.databaseLength : 255;
  }
  return property.databaseLength;
}

function getPropertyScopes(flags: string | undefined): RuntimeScope[] {
  const normalizedFlag = normalizeFlag(flags);
  if (!normalizedFlag) {
    return [];
  }

  return FLAG_SCOPE_MAP[normalizedFlag] || [];
}

function mergeProperties(
  target: Map<string, PersistentPropertyDescriptor>,
  properties: PersistentPropertyDescriptor[]
): void {
  for (const property of properties) {
    const existing = target.get(property.name);
    if (!existing) {
      target.set(property.name, clonePersistentProperty(property));
      continue;
    }

    if (property.identifier && !existing.identifier) {
      existing.identifier = true;
    }
    if (!existing.indexType && property.indexType) {
      existing.indexType = property.indexType;
    }
    if (existing.databaseLength === undefined && property.databaseLength !== undefined) {
      existing.databaseLength = property.databaseLength;
    }
  }
}

function clonePersistentProperties(properties: PersistentPropertyDescriptor[]): PersistentPropertyDescriptor[] {
  return properties.map(property => clonePersistentProperty(property));
}

function clonePersistentProperty(property: PersistentPropertyDescriptor): PersistentPropertyDescriptor {
  return {
    ...property,
    scopes: [...property.scopes],
    children: property.children ? clonePersistentProperties(property.children) : undefined,
    arrayElement: property.arrayElement ? clonePersistentProperty(property.arrayElement) : undefined
  };
}

// Properties 段:引擎默认非持久,仅文本(忽略大小写)"true" 持久
function isTruePersistent(node: DefElementNode): boolean {
  return getScalarChildValue(node, 'Persistent')?.trim().toLowerCase() === 'true';
}

// 组件槽与 FIXED_DICT 键:引擎默认持久,仅 "false" 关闭
// (loadComponents 忽略大小写;FixedDictType 精确比对,这里统一取宽松臂)
function isFalsePersistent(node: DefElementNode): boolean {
  return getScalarChildValue(node, 'Persistent')?.trim().toLowerCase() === 'false';
}

// 引擎 getKey(FirstChild) 语义:首个文本子节点内容优先,否则首个子元素标签名
// (组件 <Type> 与 <Parent> 均按此解)。
function getTypeRefName(node: DefElementNode | null | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  const text = getElementText(node).trim();
  if (text) {
    return text;
  }

  const firstChild = getDirectChildElements(node)[0];
  return firstChild?.name;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeFlag(flags: string | undefined): string | undefined {
  const normalizedFlag = flags?.trim().toUpperCase();
  if (!normalizedFlag) {
    return undefined;
  }

  switch (normalizedFlag) {
    case 'CELL_AND_CLIENT':
      return 'CELL_PUBLIC_AND_OWN';
    case 'CELL_AND_CLIENTS':
      return 'ALL_CLIENTS';
    case 'CELL_AND_OTHER_CLIENTS':
      return 'OTHER_CLIENTS';
    default:
      return normalizedFlag;
  }
}

export function normalizePath(filePath: string): string {
  // 2026-10-28 审核整改(SCH-002):不再一律 toLowerCase——POSIX 上仅大小写
  // 不同的路径是不同文件/不同根,一律折叠会让两根共用同一缓存键串缓存。
  // 走项目标准身份归一:POSIX 保留大小写;Windows 盘符/UNC 仍折叠。
  return normalizeFileIdentity(filePath);
}

export function dedupeSchemaTargets<T extends { tableName: string; fieldName?: string }>(
  targets: T[]
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const target of targets) {
    const key = `${target.tableName}::${target.fieldName || ''}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(target);
  }

  return deduped;
}
