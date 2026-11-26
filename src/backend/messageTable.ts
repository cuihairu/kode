/**
 * Network packet structure generation (batch 123)
 * Derives, from the def tree (entity -> Interfaces -> Parent recursion, all inside one
 * ScriptDefModule), the argument sequence of client-visible methods, the utype sequence and
 * the message-numbering table, with a machine-readable JSON + human-readable Markdown pair.
 *
 * The spec follows the engine's loading semantics (kbe/src/lib/entitydef):
 * - Module assembly order: loadDefInfo (entitydef.cpp L339-387) = this def's full description
 *   (Properties -> CellMethods -> BaseMethods -> ClientMethods, L927-975) ->
 *   Interfaces merged in declaration order (each interface: full description -> component slots
 *   -> recurse into its own Interfaces, L549-638; a parent class is never loaded on the
 *   interface path) -> Components (each an independent ScriptDefModule, globally cached,
 *   L650-780) -> Parent via recursive loadDefInfo.
 *   A component module is not merged into the entity module; its method utype consumption
 *   depends on the global entities.xml load order, which cannot be determined statically, so
 *   this table excludes component modules (numbering convention: the entity is the first
 *   module loaded in this run).
 * - Method utype: an explicit <Utype> registers into the global used set
 *   (g_methodCusUtypes); when unset (<=0) the smallest unused value is taken from
 *   g_methodUtypeAuto (initial 1); a duplicate within the same module (including methods
 *   merged in by inheritance/interfaces) -> an 'Utype' X Conflict error with return false;
 *   >65535 overflows (ENTITY_METHOD_UID is a uint16). The conflict search only scans this
 *   module's three method tables, so a duplicate across modules does not error. Simplification:
 *   <Utype> is handled inside the Arg loop, and a utype already claimed when an Arg fails is
 *   not reclaimed; this generator registers the utype only after all arguments pass, a
 *   difference that only affects later numbering in the hypothetical progression of a module
 *   that already failed.
 * - Method-name conflicts: addXxxMethodDescription first checks hasPropertyName (any of the
 *   three domains) / hasComponentName (component slot names, accumulated with assembly order)
 *   / a same-section same name, each erroring and failing
 *   (scriptdef_module.cpp L857-960); on the property side addPropertyDescription symmetrically
 *   checks hasMethodName/hasComponentName/a same-domain same name (L533-599).
 * - aliasID: only when entitydefAliasID is on (entitydef.h L189, off by engine default).
 *   hasClient properties start from ENTITY_BASE_PROPERTY_ALIASID_MAX (=4, with 1-3 reserved
 *   for position/direction/spaceID) and ClientMethods start from 1, both ascending by name
 *   (std::map keyed by name); a count over 255 falls back to -1 for all of them and aliasID
 *   is not used at all (scriptdef_module.cpp onLoaded L116-196, silently disabled with no
 *   error). Exposed Base/Cell methods are identified on the wire by utype and take no part in
 *   aliasID.
 * - Argument sequence: the direct text of <Arg> is the type name; ARRAY walks the <of>
 *   recursive chain; an unknown type / a missing of / an unregistered of type / a failed
 *   nesting are each collected with the engine's literal ERROR_MSG wording. Constructing an
 *   inline array type claims a utype right away (datatype.cpp L87-92); the method-argument
 *   level registers no name, while the nested level registers
 *   _{name}_ArrayType (datatypes.cpp L1671-1683).
 * - types.xml: the 21 primitives take utype 1-21 in DataTypes::initialize order
 *   (datatypes.cpp L54-79); user types run from 22 in document order (_g_dataTypeUID++);
 *   an alias shares the underlying DataType's utype (the lookup is case-sensitive,
 *   datatypes.cpp L262-266); a duplicate alias name (case-insensitive, addDataType
 *   dataTypesLowerName_) errors but loading continues; an underscore-prefixed alias name / an
 *   alias pointing at an unregistered type -> loadTypes fails.
 * - Properties: reserved names (the static ENTITY_LIMITED_PROPERTYS table; the dynamic
 *   KBEngine.Entity Python property-name comparison cannot be reproduced statically and is not
 *   in the table) -> Flags is mandatory and must be among the 12 entries of
 *   g_entityFlagMapping (entitydef.cpp L161-174, toupper before the lookup; all 12 entry
 *   values carry the base or the cell bit, so the engine's no-base/cell-bit arm is actually
 *   unreachable; all three engine spellings are "fount") -> a missing Type reports not fount
 *   TypeNode, while an unregistered type silently returns false (no ERROR_MSG) -> property
 *   utype (calcDefPropertyUType L1018-1094, with a counter/used set independent of the method
 *   utype; a conflict is reported entry by entry per holder registration domain, allocation
 *   first and the name check after) -> cell -> base -> client domain addition (the three
 *   checks for a method name / a component slot name / a same-domain same name, after the
 *   inner error the outer one appends addPropertyDescription({module}): {root}.)。
 * - Component slots (loadComponents L650-820): a slot = the three-domain properties
 *   (BASE|CELL_PUBLIC|client bit) taking property utypes and counting toward aliasID; the
 *   first sighting of a component type name constructs an EntityComponentType claiming one
 *   DataType utype (module cached, a repeated reference does not claim again); a component's
 *   def tree is an independent ScriptDefModule (with its own aliasID space) and is not merged.
 *
 * After a fatal problem (the engine's return false) the progression continues to the full
 * table: the used sets/counters/allocated tables keep evolving, so later methods receive the
 * numbering they "would have" gotten assuming loading went on, letting all conflicts be
 * located in one pass; loadFailed and issues state the engine's real outcome honestly.
 *
 * SRC-012 sharding: the rendering half lives in src/backend/messageTableRender.ts, the entity
 * assembly dispatch half in src/backend/messageTableEntity.ts, and the engine load-simulation
 * half (constant tables + ModuleAssembly + loadDefIntoModule/loadTypesXml/assignAliasIds and
 * the like) in src/backend/messageTableEngine.ts; this file is the hub of the type vocabulary
 * + the two build entries (the TS pure implementation and the Rust main path), with the public
 * import paths unchanged.
 */

import { DefMethodSection } from './defParser';
import { LocalDefinitionSemantics, parseLocalDefinition } from './definitionSemantics';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  assignAliasIds,
  loadDefIntoModule,
  loadTypesXml,
  type ModuleAssembly,
  PRIMITIVE_TYPE_UTYPES
} from './messageTableEngine';

export interface MessageTableOptions {
  /** The entitydefAliasID switch (off by engine default); when off, all aliasIDs are null */
  aliasIdEnabled?: boolean;
  /** The full types.xml text, optional; when given, user types claim utypes starting from 22 */
  typesXml?: string;
}

/** def tree source: the local semantics of entity/interface def files; the wiring layer adapts with DefinitionSemanticsLoader */
export interface DefTreeSource {
  loadDef(name: string, kind: 'entity' | 'interface' | 'component'): LocalDefinitionSemantics | null;
}

export type MessageTableIssueKind =
  | 'utype-conflict'
  | 'utype-overflow'
  | 'unknown-arg-type'
  | 'array-of-missing'
  | 'array-of-unknown-type'
  | 'array-init-failed'
  | 'method-name-conflict'
  | 'method-property-name-conflict'
  | 'method-component-name-conflict'
  | 'property-method-name-conflict'
  | 'property-component-name-conflict'
  | 'property-flags-missing'
  | 'property-flags-unknown'
  | 'property-flags-no-base-cell'
  | 'property-type-missing'
  | 'property-type-unknown'
  | 'property-name-conflict'
  | 'property-name-limited'
  | 'duplicate-type-alias'
  | 'invalid-type-alias-name'
  | 'unknown-aliased-type'
  | 'types-parse-error'
  | 'interface-file-missing'
  | 'interface-cycle'
  | 'parent-file-missing'
  | 'parent-cycle'
  | 'component-def-missing';

export interface MessageTableIssue {
  kind: MessageTableIssueKind;
  /** The engine's literal ERROR_MSG text (no line breaks); at an engine silent failure it is a kode-composed text, marked as such */
  message: string;
  /** The engine returns false at this problem (loading fails); continued loading such as a duplicate alias name is false */
  fatal: boolean;
  line: number | null;
}

export interface MessageArgEntry {
  /** The type name; 'ARRAY' at the ARRAY level */
  name: string;
  /** The element-type chain at the ARRAY level; always null for a non-ARRAY */
  ofType: MessageArgEntry | null;
  /** This level's type utype (ARRAY level = the inline array type's own utype); null on failure */
  utype: number | null;
  line: number;
}

export type MessageMethodStatus = 'ok' | 'utype-conflict' | 'utype-overflow' | 'arg-load-failed' | 'name-conflict';

export interface MessageMethodEntry {
  name: string;
  section: DefMethodSection;
  /** server-to-client = ClientMethods callbacks; client-to-server = the Exposed Base/Cell requests */
  direction: 'server-to-client' | 'client-to-server' | 'server-internal';
  visibleToClient: boolean;
  exposed: boolean;
  args: MessageArgEntry[];
  declaredUtype: number | null;
  utype: number | null;
  aliasID: number | null;
  status: MessageMethodStatus;
  /** The originating def of the method (this def / an interface name / a parent name), making the assembly order transparent */
  origin: string;
  originKind: 'own' | 'interface' | 'parent';
  line: number;
}

export interface MessagePropertyEntry {
  name: string;
  typeName: string | null;
  /** The flags text that passed validation (upper-cased normalization); a missing/unknown/client-only flag already errored at load time and is a placeholder empty string */
  flags: string;
  hasClient: boolean;
  /** The property utype (a space independent of the method utype); an explicit conflict/overflow/load failure is null */
  utype: number | null;
  declaredUtype: number | null;
  aliasID: number | null;
  /** A component slot's `<Persistent>` (defaults true); null for an ordinary property (not surfaced) */
  persistent: boolean | null;
  origin: string;
  originKind: 'own' | 'interface' | 'parent';
  line: number;
}

export type MessageTableTypeKind =
  | 'primitive'
  | 'alias'
  | 'fixed-dict'
  | 'array'
  | 'inline-array'
  | 'entity-component';

export interface TypeUtypeEntry {
  name: string;
  utype: number;
  kind: MessageTableTypeKind;
  /** The underlying type name the alias points at (an alias shares its utype); the engine-registered name at the nested-array level */
  aliasedTo: string | null;
  line: number | null;
  origin: string;
}

export interface MessageTable {
  module: string;
  generatedAt: string;
  aliasIdEnabled: boolean;
  /** true when any fatal problem exists (a module load failure under engine semantics) */
  loadFailed: boolean;
  fatalCount: number;
  /** The defs walked in assembly order (entity + interfaces + the parent chain) */
  sources: Array<{ name: string; kind: 'own' | 'interface' | 'parent'; filePath: string }>;
  methods: MessageMethodEntry[];
  /** The client-visible subset (all ClientMethods + the Base/Cell methods carrying Exposed) */
  clientMethods: MessageMethodEntry[];
  /** The full property set (including server-internal properties and component slots, the carrier of the property utype sequence) */
  properties: MessagePropertyEntry[];
  clientProperties: MessagePropertyEntry[];
  types: TypeUtypeEntry[];
  issues: MessageTableIssue[];
}

/**
 * Build the def-tree message-numbering table. A missing entity def returns null; the other
 * interface/parent defs that cannot be loaded record an issue (fatal) and then end that branch
 * per the engine's semantics.
 */
export function buildMessageTable(
  entityName: string,
  source: DefTreeSource,
  options: MessageTableOptions = {}
): MessageTable | null {
  const own = source.loadDef(entityName, 'entity');
  if (!own) {
    return null;
  }

  const assembly: ModuleAssembly = {
    entityName,
    usedUtypes: new Set<number>(),
    autoCounter: 1,
    holders: new Map<number, { name: string }>(),
    propertyUsedUtypes: new Set<number>(),
    propertyAutoCounter: 1,
    propertyHolders: new Map<number, { name: string; domains: Set<'cell' | 'base' | 'client'> }>(),
    methodNamesBySection: {
      BaseMethods: new Set<string>(),
      CellMethods: new Set<string>(),
      ClientMethods: new Set<string>()
    },
    allMethodNames: new Set<string>(),
    propertyDomains: {
      cell: new Set<string>(),
      base: new Set<string>(),
      client: new Set<string>()
    },
    allPropertyNames: new Set<string>(),
    componentNames: new Set<string>(),
    seenComponentTypes: new Set<string>(),
    registry: new Map<string, number>(),
    types: [],
    issues: [],
    nextTypeUtype: 1,
    methods: [],
    properties: [],
    sources: [],
    visited: new Set<string>(),
    interfacePath: new Set<string>()
  };

  for (const [name, utype] of PRIMITIVE_TYPE_UTYPES) {
    assembly.registry.set(name, utype);
    assembly.types.push({ name, utype, kind: 'primitive', aliasedTo: null, line: null, origin: '' });
  }
  assembly.nextTypeUtype = PRIMITIVE_TYPE_UTYPES.length + 1;
  if (options.typesXml !== undefined) {
    loadTypesXml(entityName, options.typesXml, assembly);
  }

  loadDefIntoModule(entityName, own, 'own', source, assembly);

  assignAliasIds(assembly, options.aliasIdEnabled ?? false);

  const methods = assembly.methods;
  return {
    module: entityName,
    generatedAt: new Date().toISOString(),
    aliasIdEnabled: options.aliasIdEnabled ?? false,
    loadFailed: assembly.issues.some(issue => issue.fatal),
    fatalCount: assembly.issues.filter(issue => issue.fatal).length,
    sources: assembly.sources,
    methods,
    clientMethods: methods.filter(method => method.visibleToClient),
    properties: assembly.properties,
    clientProperties: assembly.properties.filter(property => property.hasClient),
    types: assembly.types,
    issues: assembly.issues
  };
}

/** Raw def text source (for the Rust command-level RPC corpus): fetch a file's raw text + path by name. */
export interface DefRawText {
  content: string;
  filePath: string;
}

export interface DefRawSource {
  loadDefRaw(name: string, kind: 'entity' | 'interface' | 'component'): DefRawText | null;
}

/**
 * The main path: the Rust core builds the table (the single source of truth). When Rust is
 * unavailable (no gate / no serverPath / a failed call / an incomplete result shape) it returns
 * null, and the caller falls back to the TS pure implementation.
 *
 * Corpus passed through directly: TS only fetches the raw def text by name (entity + parent chain
 * + interface closure), and the Rust side owns all parsing and assembly; no dependence on the
 * mirror corpus or shadow mode. TS does not parse the raw text, only using
 * parseLocalDefinition's Parent/Interfaces references for closure discovery.
 */
export async function buildMessageTableInRust(
  entityName: string,
  rawSource: DefRawSource,
  options: MessageTableOptions = {}
): Promise<MessageTable | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }

  const defs: Record<string, string> = {};
  const paths: Record<string, string> = {};
  const ownRaw = rawSource.loadDefRaw(entityName, 'entity');
  if (!ownRaw) {
    return null;
  }

  // Closure discovery: a BFS over the entity parent chain (each entity's interface references +
  // its parent class), with interfaces recursing into their own Interfaces
  // (the engine's loadInterfaces recurses into each interface's own Interfaces,
  // entitydef.cpp L628-638; a Parent inside an interface is not loaded, the engine's
  // loadInterfaces path does not call loadParentClass), and an interface's Components go into
  // the component closure on the same terms as an entity's. A missing def is not collected; the
  // Rust side reports it honestly as parent-file-missing/interface-file-missing.
  const entityQueue: string[] = [entityName];
  const seenEntities = new Set<string>();
  const seenInterfaces = new Set<string>();
  const componentQueue: string[] = [];
  const enqueuedComponents = new Set<string>();
  const enqueueComponents = (local: LocalDefinitionSemantics): void => {
    for (const component of local.components) {
      if (!enqueuedComponents.has(component.typeName)) {
        enqueuedComponents.add(component.typeName);
        componentQueue.push(component.typeName);
      }
    }
  };
  const collectInterface = (name: string): void => {
    if (seenInterfaces.has(name)) {
      return;
    }
    seenInterfaces.add(name);
    const ifaceRaw = rawSource.loadDefRaw(name, 'interface');
    if (!ifaceRaw) {
      return;
    }
    defs[name] = ifaceRaw.content;
    paths[name] = ifaceRaw.filePath;
    let ifaceLocal: LocalDefinitionSemantics;
    try {
      ifaceLocal = parseLocalDefinition(ifaceRaw.content, 'interface', name, ifaceRaw.filePath);
    } catch {
      return;
    }
    // KR-AUD-67: an interface's own Interfaces recurse into the closure; an interface's Components go into the component closure
    for (const ref of ifaceLocal.interfaces) {
      collectInterface(ref.name);
    }
    enqueueComponents(ifaceLocal);
  };
  while (entityQueue.length > 0) {
    const name = entityQueue.shift()!;
    if (seenEntities.has(name)) {
      continue;
    }
    seenEntities.add(name);
    const raw = name === entityName ? ownRaw : rawSource.loadDefRaw(name, 'entity');
    if (!raw) {
      continue;
    }
    defs[name] = raw.content;
    paths[name] = raw.filePath;
    let local: LocalDefinitionSemantics;
    try {
      local = parseLocalDefinition(raw.content, 'entity', name, raw.filePath);
    } catch {
      continue;
    }
    if (local.parentName && !seenEntities.has(local.parentName)) {
      entityQueue.push(local.parentName);
    }
    for (const ref of local.interfaces) {
      collectInterface(ref.name);
    }
    enqueueComponents(local);
  }
  // The component-closure BFS (IDE-RUST-006): the component def raw text + its interfaces
  // (interface kind) + its parent class (component kind), recursed, for the Rust side's
  // component-module domain face and SDK component visibility.
  while (componentQueue.length > 0) {
    const name = componentQueue.shift()!;
    const raw = rawSource.loadDefRaw(name, 'component');
    if (!raw) {
      continue;
    }
    defs[name] = raw.content;
    paths[name] = raw.filePath;
    let local: LocalDefinitionSemantics;
    try {
      local = parseLocalDefinition(raw.content, 'component', name, raw.filePath);
    } catch {
      continue;
    }
    for (const ref of local.interfaces) {
      collectInterface(ref.name);
    }
    if (local.parentName && !enqueuedComponents.has(local.parentName)) {
      enqueuedComponents.add(local.parentName);
      componentQueue.push(local.parentName);
    }
    enqueueComponents(local);
  }

  const response = await gate.runInRust<MessageTable>('$/kode/messageTable/build', {
    entityName,
    defText: defs[entityName],
    typesXml: options.typesXml,
    defs,
    paths,
    aliasIdEnabled: options.aliasIdEnabled ?? false
  });
  if (!response.ok) {
    return null;
  }
  const table = response.result;
  if (!table || typeof table.module !== 'string' || !Array.isArray(table.methods)) {
    return null;
  }
  return table;
}

// ---------------------------------------------------------------------------
// Rendering: human-readable Markdown + machine-readable JSON (SRC-012 moved to src/backend/messageTableRender.ts)
// ---------------------------------------------------------------------------

export { renderMessageTableJson, renderMessageTableMarkdown } from './messageTableRender';
