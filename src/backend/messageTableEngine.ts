/**
 * Network packet structure generation -- the engine-load simulation half
 * (SRC-012, moved out of messageTable.ts as a pure move).
 *
 * Contents: engine constant tables (g_entityFlagMapping / three-domain bit
 * sets / component type numbers / primitive utype table / reserved property
 * names / utype upper bound / aliasID constants / method load order), the
 * ModuleAssembly assembly state, and the step-by-step simulation of engine
 * load semantics (loadDefIntoModule, loadSourceDef, loadTypesXml,
 * simulateProperty, allocatePropertyUtype, registerComponentSlot,
 * simulateMethod, parseMethodArg, assignAliasIds, etc.).
 *
 * For the functional spec and engine semantics cited item by item
 * (file:line), see the messageTable.ts module header; this file does not
 * repeat the spec narrative, and function-level comments are carried over
 * verbatim from their original position. The type vocabulary (MessageTable /
 * entry / DefTreeSource, etc.) is type-only imported from messageTable, so
 * there is no runtime cycle (same policy as messageTableRender.ts); the
 * public entry buildMessageTable in messageTable.ts is driven through the
 * assembly functions exported here (PRIMITIVE_TYPE_UTYPES seeding ->
 * loadTypesXml -> loadDefIntoModule -> assignAliasIds).
 */

import {
  DefDocument,
  DefMethodSection,
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  getLineNumberAt,
  parseDefDocument
} from './defParser';
import {
  DefinitionArgType,
  DefinitionComponentRef,
  DefinitionMethod,
  DefinitionProperty,
  LocalDefinitionSemantics
} from './definitionSemantics';
import { FIXED_DICT_TYPE_NAME } from './kbengineMetadata';
import type {
  DefTreeSource,
  MessageArgEntry,
  MessageMethodEntry,
  MessagePropertyEntry,
  MessageTableIssue,
  MessageTableIssueKind,
  TypeUtypeEntry
} from './messageTable';

// g_entityFlagMapping, 12 entries (entitydef.cpp L161-174); values are
// EntityDataFlags bits (common.h L19-30). Lookup applies toupper first (the
// engine's std::transform), so it is case-insensitive.
// Note: this is the **bit-set fact** for utype registration (the common.h
// L19-30 bit set) and a distinct engine fact from the visibility-domain bit
// table (single source: Rust src/generated/flagDomains.ts) -- e.g. OWN_CLIENT
// (0x10) appears in both ENTITY_CELL_DATA_FLAGS and ENTITY_CLIENT_DATA_FLAGS,
// while the domain bit table only gives ['client']. The two cannot be derived
// from each other; do not merge them.
const PROPERTY_FLAG_BITS: Record<string, number> = {
  CELL: 0x01,
  CELL_AND_CLIENT: 0x08,
  CELL_AND_CLIENTS: 0x04,
  CELL_AND_OTHER_CLIENTS: 0x80,
  BASE_AND_CLIENT: 0x20,
  BASE: 0x40,
  CELL_PUBLIC: 0x01,
  CELL_PRIVATE: 0x02,
  ALL_CLIENTS: 0x04,
  CELL_PUBLIC_AND_OWN: 0x08,
  OTHER_CLIENTS: 0x80,
  OWN_CLIENT: 0x10
};

// common.h L141-147: three-domain bit sets
const ENTITY_BASE_DATA_FLAGS = 0x40 | 0x20;
const ENTITY_CELL_DATA_FLAGS = 0x01 | 0x02 | 0x04 | 0x08 | 0x80 | 0x10;
const ENTITY_CLIENT_DATA_FLAGS = 0x20 | 0x04 | 0x08 | 0x80 | 0x10;

// Component type numbers (common.h L78-82); addPropertyDescription conflict
// errors print per domain
const DOMAIN_COMPONENT_TYPE: Record<'cell' | 'base' | 'client', number> = {
  cell: 5,
  base: 6,
  client: 7
};

// Primitive type utype table: DataTypes::initialize order (datatypes.cpp
// L54-79). All are constructed with did=0; the DataType constructor allocates
// by _g_dataTypeUID++ (initial value 1) (datatype.cpp L87-92), so utype = the
// position in that order.
export const PRIMITIVE_TYPE_UTYPES: ReadonlyArray<readonly [string, number]> = [
  ['UINT8', 1],
  ['UINT16', 2],
  ['UINT64', 3],
  ['UINT32', 4],
  ['INT8', 5],
  ['INT16', 6],
  ['INT32', 7],
  ['INT64', 8],
  ['STRING', 9],
  ['UNICODE', 10],
  ['FLOAT', 11],
  ['DOUBLE', 12],
  ['PYTHON', 13],
  ['PY_DICT', 14],
  ['PY_TUPLE', 15],
  ['PY_LIST', 16],
  ['ENTITYCALL', 17],
  ['BLOB', 18],
  ['VECTOR2', 19],
  ['VECTOR3', 20],
  ['VECTOR4', 21]
];

// Engine-reserved property names (common.h L125-155 ENTITY_LIMITED_PROPERTYS,
// the static-table part): a validDefPropertyName hit reports limited and
// fails. Two adjacent string literals in the original table are missing a
// comma ("component" "databaseID", "interface" ""), so under C++ literal
// concatenation semantics the engine actually compares "componentdatabaseID"
// and "interface"; recorded as the engine effectively behaves. The other arm
// (runtime comparison against KBEngine.Entity Python attribute names) is not
// statically reproducible and is not included in the table.
const LIMITED_PROPERTY_NAMES: ReadonlySet<string> = new Set<string>([
  'id',
  'position',
  'direction',
  'spaceID',
  'autoLoad',
  'cell',
  'base',
  'client',
  'cellData',
  'className',
  'componentdatabaseID',
  'isDestroyed',
  'shouldAutoArchive',
  'shouldAutoBackup',
  '__ACCOUNT_NAME__',
  '__ACCOUNT_PASSWORD__',
  'clientAddr',
  'clientEnabled',
  'hasClient',
  'roundTripTime',
  'timeSinceHeardFromClient',
  'allClients',
  'hasWitness',
  'isWitnessed',
  'otherClients',
  'topSpeed',
  'topSpeedY',
  'interface'
]);

// ENTITY_METHOD_UID upper bound: uint16; beyond it the engine reports overflow
// (entitydef.cpp L1372-1378)
const METHOD_UTYPE_MAX = 65535;
// aliasID: 1 byte; properties start at 4 (common.h
// ENTITY_BASE_PROPERTY_ALIASID, 1-3 reserved for position/direction/spaceID);
// beyond 255 fall back to -1
const ALIAS_ID_PROPERTY_BASE = 4;
const ALIAS_ID_MAX = 255;

const METHOD_LOAD_ORDER: ReadonlyArray<DefMethodSection> = [
  'CellMethods',
  'BaseMethods',
  'ClientMethods'
];

/** Assembly state: simulation of the engine's global counters and the names already registered inside the module */
export interface ModuleAssembly {
  /** Name of the entity being loaded ({module} in engine ERROR_MSG always refers to it, not to each def's source name) */
  entityName: string;
  usedUtypes: Set<number>;
  autoCounter: number;
  /** Method utype -> holder (used to name the holder in conflict errors) */
  holders: Map<number, { name: string }>;
  /** Property utype space (g_propertyUtypeAuto/g_propertyUtypes, independent of methods) */
  propertyUsedUtypes: Set<number>;
  propertyAutoCounter: number;
  propertyHolders: Map<number, { name: string; domains: Set<'cell' | 'base' | 'client'> }>;
  /** The three method-name tables (scriptdef_module.cpp methodXxxDescr_) */
  methodNamesBySection: Record<DefMethodSection, Set<string>>;
  /** hasMethodName: any of the three sections (scriptdef_module.cpp L1049-1055) */
  allMethodNames: Set<string>;
  /** Three-domain property-name tables (addPropertyDescription checks duplicates per domain) */
  propertyDomains: Record<'cell' | 'base' | 'client', Set<string>>;
  /** hasPropertyName: any of the three domains (scriptdef_module.cpp L1041-1046) */
  allPropertyNames: Set<string>;
  /** hasComponentName: component slot names, accumulated in assembly order */
  componentNames: Set<string>;
  registry: Map<string, number>;
  /** Component type names that already claimed an EntityComponentType (engine module-cache semantics; repeated references do not claim again) */
  seenComponentTypes: Set<string>;
  types: TypeUtypeEntry[];
  issues: MessageTableIssue[];
  /** _g_dataTypeUID equivalent: continuation point for def inline types (after the types.xml user types) */
  nextTypeUtype: number;
  methods: MessageMethodEntry[];
  properties: MessagePropertyEntry[];
  sources: Array<{ name: string; kind: 'own' | 'interface' | 'parent'; filePath: string }>;
  visited: Set<string>;
  /**
   * Interface load path (KR-AUD-67): after an interface recurses into its own
   * Interfaces, a cycle is possible (the engine's loadInterfaces has no dedup,
   * mutually-referencing interfaces recurse forever); the path guard truncates.
   * Duplicate declarations (diamonds) do not go through this guard; they are
   * reported faithfully via name-collision conflicts (consistent with the
   * engine).
   */
  interfacePath: Set<string>;
}

/**
 * Merge a single def into the module (engine loadDefInfo recursion unit):
 * properties -> Cell -> Base -> Client methods -> interfaces in declaration
 * order recursion -> component slot names -> (non-interface) parent recursion.
 * An interface origin walks the same Interfaces recursion + component slot
 * registration as an entity (the engine's loadInterfaces calls loadComponents
 * and recursively loadInterfaces for each interface, entitydef.cpp L598-638),
 * but skips the parent (the loadInterfaces path does not call loadParentClass).
 * The parent chain is linear (each def has a single parent); re-entering the
 * same file means the parent chain cycles (the engine recurses forever; kode
 * truncates).
 */
export function loadDefIntoModule(
  moduleName: string,
  local: LocalDefinitionSemantics,
  originKind: 'own' | 'interface' | 'parent',
  source: DefTreeSource,
  assembly: ModuleAssembly
): void {
  const visitKey = normalizeSourceKey(local.owner.filePath);
  // The cycle guard covers both recursions (neither engine recursion dedups;
  // re-entering the same file is a cycle; kode truncates and reports an error):
  // 1. Entity own + parent chain: parent-cycle.
  // 2. An interface recursing into its own Interfaces (KR-AUD-67):
  //    interface-cycle, via the path guard (push/pop). Diamond duplicate
  //    declarations bypass this guard -- the engine fully loads every
  //    duplicate declaration, and the second name collision reports
  //    [X] is exist!; kode reports it faithfully through the existing
  //    name-collision conflict.
  if (originKind === 'interface') {
    if (assembly.interfacePath.has(visitKey)) {
      assembly.issues.push({
        kind: 'interface-cycle',
        fatal: true,
        line: local.parentLine ?? null,
        message: `接口链成环:${assembly.entityName} 装载中重入接口 ${moduleName}(引擎 loadInterfaces 递归无法终止,kode 截断该分支)`
      });
      return;
    }
    assembly.interfacePath.add(visitKey);
  } else if (assembly.visited.has(visitKey)) {
    assembly.issues.push({
      kind: 'parent-cycle',
      fatal: true,
      /* istanbul ignore next -- a re-entrant always arrives via the parent chain, so parentLine is always defined; the null arm is unreachable */
      line: local.parentLine ?? null,
      message: `父类链成环:${assembly.entityName} 装载中重入 ${moduleName}(引擎递归装载无法终止,kode 截断该分支)`
    });
    return;
  }
  assembly.sources.push({ name: moduleName, kind: originKind, filePath: local.owner.filePath });
  if (originKind !== 'interface') {
    assembly.visited.add(visitKey);
  }

  const rootName = local.document.root?.name ?? '';
  for (const property of local.properties) {
    simulateProperty(moduleName, property, originKind, rootName, assembly);
  }

  for (const section of METHOD_LOAD_ORDER) {
    for (const method of local.methodsBySection[section]) {
      simulateMethod(moduleName, method, originKind, assembly);
    }
  }

  // Interfaces recursion in declaration order (an interface origin likewise
  // recurses into its own Interfaces, engine L628-638)
  for (const interfaceRef of local.interfaces) {
    const interfaceLocal = loadSourceDef(interfaceRef.name, 'interface', source, assembly);
    if (!interfaceLocal) {
      continue;
    }
    loadDefIntoModule(interfaceRef.name, interfaceLocal, 'interface', source, assembly);
  }

  // Component slot registration (loadComponents runs after interfaces and
  // before the parent; an interface origin registers too, engine L617-625):
  // a slot is one property (addComponentProperty -> addPropertyDescription
  // across the three domains), it claims a property utype, and hasClient
  // counts toward aliasID. The component def tree itself is a separate module
  // and is not merged in (see the module header).
  for (const component of local.components) {
    registerComponentSlot(moduleName, component, source, assembly);
  }

  // The engine's loadInterfaces path does not call loadParentClass: an
  // interface origin stops here
  if (originKind !== 'interface' && local.parentName) {
    const parentLocal = loadSourceDef(local.parentName, 'entity', source, assembly);
    if (!parentLocal) {
      return;
    }
    loadDefIntoModule(local.parentName, parentLocal, 'parent', source, assembly);
  }

  if (originKind === 'interface') {
    assembly.interfacePath.delete(visitKey);
  }
}

function loadSourceDef(
  name: string,
  kind: 'entity' | 'interface',
  source: DefTreeSource,
  assembly: ModuleAssembly
): LocalDefinitionSemantics | null {
  const local = source.loadDef(name, kind);
  if (!local) {
    // Engine openSection failure -> return false; the outer layer reports
    // failed to load ... interface/parentClass
    const outer = kind === 'interface' ? 'interface' : 'parentClass';
    assembly.issues.push({
      kind: kind === 'interface' ? 'interface-file-missing' : 'parent-file-missing',
      fatal: true,
      line: null,
      message: `EntityDef::loadDefInfo: failed to load entity:${name} ${outer}.`
    });
  }
  return local;
}

/**
 * types.xml load simulation (datatypes.cpp loadTypes L107-186): the child
 * elements of root are alias names, in document order. FIXED_DICT/ARRAY are
 * direct child elements of the alias element (not text); creating a user type
 * claims a new utype (construction precedes initialize, so it is claimed even
 * on failure); an alias shares the target utype; duplicate names
 * (case-insensitive) report an error but loading continues; an underscore
 * prefix / unknown target -> loadTypes fails.
 */
export function loadTypesXml(origin: string, typesXml: string, assembly: ModuleAssembly): void {
  let document: DefDocument;
  try {
    document = parseDefDocument(typesXml);
  } catch {
    assembly.issues.push({
      kind: 'types-parse-error',
      fatal: true,
      line: null,
      message: 'DataTypes::loadTypes: types.xml 解析失败(非法 XML)'
    });
    return;
  }
  const root = document.root;
  if (!root) {
    return;
  }

  for (const aliasNode of getDirectChildElements(root)) {
    const aliasName = aliasNode.name;
    const line = getLineNumberAt(document, aliasNode.tagStart);
    if (aliasName.startsWith('_')) {
      assembly.issues.push({
        kind: 'invalid-type-alias-name',
        fatal: true,
        line,
        message: `DataTypes::loadTypes: Not allowed to use the prefix "_"! aliasName=${aliasName}`
      });
      continue;
    }

    const fixedDictNode = getDirectChildElement(aliasNode, FIXED_DICT_TYPE_NAME);
    const arrayNode = getDirectChildElement(aliasNode, 'ARRAY');
    const childText = getElementText(aliasNode).trim();
    // addDataType checks for duplicates case-insensitively
    // (dataTypesLowerName_); duplicate names report an error but loading
    // continues: the FIXED_DICT/ARRAY utype was already consumed by the
    // constructor (registered in uid_dataTypes_) and the name is not
    // overwritten; an alias creates no new type and claims no number
    if (hasAliasName(assembly, aliasName)) {
      assembly.issues.push({
        kind: 'duplicate-type-alias',
        fatal: false,
        line,
        message: `DataTypes::addDataType(name): name ${aliasName} exist.`
      });
      if (fixedDictNode) {
        consumeUserType(aliasName, line, 'fixed-dict');
      } else if (arrayNode) {
        consumeUserType(aliasName, line, 'array');
      }
      continue;
    }

    if (fixedDictNode) {
      const propertiesNode = getDirectChildElement(fixedDictNode, 'Properties');
      if (!propertiesNode) {
        assembly.issues.push({
          kind: 'types-parse-error',
          fatal: true,
          line,
          message: 'FixedDictType::initialize: not found "Properties".'
        });
        assembly.issues.push({
          kind: 'types-parse-error',
          fatal: true,
          line,
          message: `DataTypes::loadTypes: parse FIXED_DICT [${aliasName}] error!`
        });
        // Engine: the new FixedDictType constructor claims the number first,
        // so the alias is not registered after an initialize failure
        consumeUserType(aliasName, line, 'fixed-dict');
        continue;
      }
      registerUserType(aliasName, line, 'fixed-dict', null);
      continue;
    }
    if (arrayNode) {
      const ofNode = getDirectChildElement(arrayNode, 'of');
      if (!ofNode) {
        assembly.issues.push({
          kind: 'array-of-missing',
          fatal: true,
          line,
          message: 'FixedArrayType::initialize: not found "of".'
        });
        assembly.issues.push({
          kind: 'types-parse-error',
          fatal: true,
          line,
          message: `DataTypes::loadTypes: parse ARRAY [${aliasName}] error!`
        });
        // Engine: type construction already claimed the number, so the alias
        // is not registered after an initialize failure
        consumeUserType(aliasName, line, 'array');
        continue;
      }
      const ofName = getElementText(ofNode).trim();
      const ofUtype = lookupType(ofName, assembly);
      if (ofUtype === null) {
        assembly.issues.push({
          kind: 'array-of-unknown-type',
          fatal: true,
          line,
          message: `FixedArrayType::initialize: key[ARRAY] did not find type[${ofName}]!`
        });
        assembly.issues.push({
          kind: 'types-parse-error',
          fatal: true,
          line,
          message: `DataTypes::loadTypes: parse ARRAY [${aliasName}] error!`
        });
        consumeUserType(aliasName, line, 'array');
        continue;
      }
      registerUserType(aliasName, line, 'array', null);
      continue;
    }

    const targetUtype = lookupType(childText, assembly);
    if (targetUtype === null) {
      assembly.issues.push({
        kind: 'unknown-aliased-type',
        fatal: true,
        line,
        message: `DataTypes::loadTypes: can't fount type ${childText} by alias[${aliasName}].`
      });
      continue;
    }
    registerUserType(aliasName, line, 'alias', childText);
  }

  function hasAliasName(asm: ModuleAssembly, name: string): boolean {
    const lower = name.toLowerCase();
    for (const known of asm.registry.keys()) {
      if (known.toLowerCase() === lower) {
        return true;
      }
    }
    return false;
  }

  function registerUserType(
    name: string,
    line: number,
    kind: 'fixed-dict' | 'array' | 'alias',
    aliasedTo: string | null
  ): void {
    const utype = aliasedTo === null ? assembly.nextTypeUtype++ : lookupType(aliasedTo, assembly)!;
    assembly.registry.set(name, utype);
    assembly.types.push({ name, utype, kind, aliasedTo, line, origin });
  }

  // Claim a number without registering a name (present in the engine's
  // uid_dataTypes_ but the name is unreachable)
  function consumeUserType(name: string, line: number, kind: 'fixed-dict' | 'array'): void {
    const utype = assembly.nextTypeUtype++;
    assembly.types.push({ name, utype, kind, aliasedTo: null, line, origin });
  }
}

function lookupType(name: string, assembly: ModuleAssembly): number | null {
  const utype = assembly.registry.get(name);
  return utype === undefined ? null : utype;
}

/**
 * Property load simulation (loadDefPropertys L1097-1311 load order):
 * reserved-name check -> flags validation (required / table lookup / must
 * contain a base or cell bit) -> Type validation (missing reports an error,
 * unregistered fails silently; an ARRAY inline type claims a number) ->
 * property utype allocation (calcDefPropertyUType, independent space) ->
 * cell->base->client domain addition (name conflicts: method name /
 * component slot name / same-domain duplicate; after the internal error the
 * outer layer appends one more addPropertyDescription summary error).
 */
function simulateProperty(
  moduleName: string,
  property: DefinitionProperty,
  originKind: 'own' | 'interface' | 'parent',
  rootName: string,
  assembly: ModuleAssembly
): void {
  const origin = originLabel(moduleName, originKind);
  const entry: MessagePropertyEntry = {
    name: property.name,
    typeName: property.typeName ?? null,
    flags: '',
    hasClient: false,
    utype: null,
    declaredUtype: null,
    aliasID: null,
    persistent: null,
    origin,
    originKind,
    line: property.line
  };
  assembly.properties.push(entry);

  if (LIMITED_PROPERTY_NAMES.has(property.name)) {
    assembly.issues.push({
      kind: 'property-name-limited',
      fatal: true,
      line: property.line,
      message: `EntityDef::loadDefPropertys: '${property.name}' is limited, in module(${assembly.entityName})!`
    });
    return;
  }

  // An empty Flags text and a missing Flags node are indistinguishable at
  // the parse layer (getScalarChildValue yields undefined for both), so both
  // report as a missing node (the engine routes empty text through the
  // not fount flags[] arm)
  if (property.flags === undefined) {
    assembly.issues.push({
      kind: 'property-flags-missing',
      fatal: true,
      line: property.line,
      message: `EntityDef::loadDefPropertys: not fount flagsNode, is ${assembly.entityName}.${property.name}!`
    });
    return;
  }
  const flagsText = property.flags.trim().toUpperCase();
  entry.flags = flagsText;
  const flagBits = PROPERTY_FLAG_BITS[flagsText];
  if (flagBits === undefined) {
    assembly.issues.push({
      kind: 'property-flags-unknown',
      fatal: true,
      line: property.line,
      message: `EntityDef::loadDefPropertys: not fount flags[${flagsText}], is ${assembly.entityName}.${property.name}!`
    });
    return;
  }
  // The engine keeps this arm (hasBaseFlags<=0 && hasCellFlags<=0 reports an
  // error), but all 12 g_entityFlagMapping entries fall within the base
  // (0x60) ∪ cell (0x9F) bit sets (including OWN_CLIENT=0x10, counted under
  // cell+client), so every successful lookup passes this check and the arm
  // is actually unreachable inside the engine; kept to preserve the shape
  /* istanbul ignore start */
  if ((flagBits & ENTITY_BASE_DATA_FLAGS) <= 0 && (flagBits & ENTITY_CELL_DATA_FLAGS) <= 0) {
    assembly.issues.push({
      kind: 'property-flags-no-base-cell',
      fatal: true,
      line: property.line,
      message: `EntityDef::loadDefPropertys: not fount flags[${flagsText}], is ${assembly.entityName}.${property.name}!`
    });
    return;
  }
  /* istanbul ignore stop */
  entry.hasClient = (flagBits & ENTITY_CLIENT_DATA_FLAGS) > 0;
  const registeredDomains = (['cell', 'base', 'client'] as const).filter(
    domain => (flagBits & domainBitsOf(domain)) > 0
  );

  if (property.typeName === undefined) {
    assembly.issues.push({
      kind: 'property-type-missing',
      fatal: true,
      line: property.line,
      message: `EntityDef::loadDefPropertys: not fount TypeNode, is ${assembly.entityName}.${property.name}!`
    });
    return;
  }
  if (property.typeName === 'ARRAY') {
    // Engine-inline FixedArrayType: the {module}_{property} name is not
    // registered, and construction claims the number immediately. On the
    // property side the parse layer does not carry out the <of> chain
    // (counted as a single level); the method-argument side recurses fully
    assembly.types.push({
      name: `${assembly.entityName}_${property.name}`,
      utype: assembly.nextTypeUtype++,
      kind: 'inline-array',
      aliasedTo: null,
      line: property.line,
      origin
    });
  } else if (lookupType(property.typeName, assembly) === null) {
    assembly.issues.push({
      kind: 'property-type-unknown',
      fatal: true,
      line: property.line,
      message: `属性 ${property.name} 的类型 ${property.typeName} 未注册(types.xml 与基元表均无),引擎静默 return false(无 ERROR_MSG)`
    });
    return;
  }

  // Property utype (calcDefPropertyUType L1018-1094): explicit registration /
  // overflow / conflict (reported per registered domain of the holder) /
  // automatic allocation taking the smallest unused value; allocation
  // precedes the three name checks (engine order)
  const declared = property.utype !== undefined && property.utype !== null && property.utype > 0
    ? property.utype
    : null;
  entry.declaredUtype = declared;
  entry.utype = allocatePropertyUtype(
    declared,
    property.name,
    registeredDomains,
    property.line,
    assembly
  );
  if (entry.utype === null) {
    return;
  }

  // addPropertyDescription three name checks (scriptdef_module.cpp
  // L533-599), triggered as each domain is added: method name (a parent
  // property loaded later collides with an already-loaded child method) ->
  // component slot name -> same-domain duplicate. After the internal error
  // the engine's outer layer appends the summary error (entitydef.cpp
  // L1287-1292). registeredDomains is never empty (anything passing the
  // base/cell bit check lands in at least one domain)
  const firstDomain = registeredDomains[0] as 'cell' | 'base' | 'client';
  const reportAddFailure = (kind: MessageTableIssueKind, message: string): void => {
    assembly.issues.push({ kind, fatal: true, line: property.line, message });
    assembly.issues.push({
      kind,
      fatal: true,
      line: property.line,
      message: `EntityDef::addPropertyDescription(${assembly.entityName}): ${rootName}.`
    });
  };

  if (assembly.allMethodNames.has(property.name)) {
    reportAddFailure(
      'property-method-name-conflict',
      `ScriptDefModule::addPropertyDescription: There is a method[${property.name}] name conflict! componentType=${DOMAIN_COMPONENT_TYPE[firstDomain]}.`
    );
    return;
  }
  if (assembly.componentNames.has(property.name)) {
    reportAddFailure(
      'property-component-name-conflict',
      `ScriptDefModule::addPropertyDescription: There is a component[${property.name}] name conflict!`
    );
    return;
  }

  let nameRejected = false;
  for (const domain of registeredDomains) {
    if (assembly.propertyDomains[domain].has(property.name)) {
      assembly.issues.push({
        kind: 'property-name-conflict',
        fatal: true,
        line: property.line,
        message: `ScriptDefModule::addPropertyDescription: [${property.name}] is exist! componentType=${DOMAIN_COMPONENT_TYPE[domain]}.`
      });
      nameRejected = true;
      continue;
    }
    assembly.propertyDomains[domain].add(property.name);
  }
  if (nameRejected) {
    assembly.issues.push({
      kind: 'property-name-conflict',
      fatal: true,
      line: property.line,
      message: `EntityDef::addPropertyDescription(${assembly.entityName}): ${rootName}.`
    });
    return;
  }
  assembly.allPropertyNames.add(property.name);
}

/**
 * Property utype allocation (calcDefPropertyUType L1018-1094): counters and
 * used set independent of method utypes. Conflicts are reported per
 * registered domain of the holder (the engine runs findPropertyDescription
 * per domain and emits one ERROR per hit); overflow and conflict alike do
 * not enter the used table (the engine pushes after the checks).
 */
function allocatePropertyUtype(
  declared: number | null,
  name: string,
  domains: ReadonlyArray<'cell' | 'base' | 'client'>,
  line: number,
  assembly: ModuleAssembly
): number | null {
  if (declared !== null) {
    if (declared > METHOD_UTYPE_MAX) {
      assembly.issues.push({
        kind: 'utype-overflow',
        fatal: true,
        line,
        message: `EntityDef::calcDefPropertyUType: 'Utype' has overflowed(${declared} > ${METHOD_UTYPE_MAX}), is ${assembly.entityName}.${name}!`
      });
      return null;
    }
    const holder = assembly.propertyHolders.get(declared);
    if (holder) {
      for (const domain of domains) {
        if (holder.domains.has(domain)) {
          assembly.issues.push({
            kind: 'utype-conflict',
            fatal: true,
            line,
            message: `EntityDef::calcDefPropertyUType: ${assembly.entityName}.${name}, 'Utype' ${declared} Conflict(${assembly.entityName}.${holder.name} 'Utype' ${declared})!`
          });
        }
      }
      return null;
    }
    assembly.propertyUsedUtypes.add(declared);
    assembly.propertyHolders.set(declared, { name, domains: new Set(domains) });
    return declared;
  }
  while (assembly.propertyUsedUtypes.has(assembly.propertyAutoCounter)) {
    assembly.propertyAutoCounter += 1;
  }
  const utype = assembly.propertyAutoCounter;
  assembly.propertyAutoCounter += 1;
  assembly.propertyUsedUtypes.add(utype);
  assembly.propertyHolders.set(utype, { name, domains: new Set(domains) });
  return utype;
}

/**
 * Component slot registration (loadComponents L650-820): a slot is one
 * three-domain property (BASE|CELL_PUBLIC| client bits) and claims a property
 * utype. The first time a component type name appears, an EntityComponentType
 * is constructed, claiming one DataType utype (module-cache semantics; repeated
 * references do not claim again). Name dedup reuses addPropertyDescription.
 * The component def tree (a separate ScriptDefModule) is not merged into the
 * entity module; see the module-header boundary note.
 */
/**
 * Component module domain surface (an approximation of the engine
 * isComponentModule ScriptDefModule's hasX checks). The script-file side of
 * autoMatchCompOwn (scripts/{base,cell}/components/<name>.py) is invisible to
 * a pure function, so it is approximated from the def sections: a non-empty
 * property domain / method section means the corresponding domain is present.
 * Isomorphic to Rust message_table.rs analyze_component_module
 * (TS/Rust cross-check agrees).
 */
interface ComponentModuleFace {
  hasBase: boolean;
  hasCell: boolean;
  hasClient: boolean;
  baseExposed: boolean;
  cellExposed: boolean;
}

function analyzeComponentModule(
  typeName: string,
  source: DefTreeSource,
  visited: Set<string>
): ComponentModuleFace | null {
  if (visited.has(typeName)) {
    return null;
  }
  const local = source.loadDef(typeName, 'component');
  if (!local) {
    return null;
  }
  visited.add(typeName);
  const face: ComponentModuleFace = {
    hasBase: false,
    hasCell: false,
    hasClient: false,
    baseExposed: false,
    cellExposed: false
  };
  for (const property of local.properties) {
    if (property.flags === undefined) {
      continue;
    }
    const bits = PROPERTY_FLAG_BITS[property.flags.trim().toUpperCase()];
    if (bits === undefined) {
      continue;
    }
    if ((bits & ENTITY_BASE_DATA_FLAGS) > 0) {
      face.hasBase = true;
    }
    if ((bits & ENTITY_CELL_DATA_FLAGS) > 0) {
      face.hasCell = true;
    }
    if ((bits & ENTITY_CLIENT_DATA_FLAGS) > 0) {
      face.hasClient = true;
    }
  }
  for (const method of local.methodsBySection.BaseMethods) {
    face.hasBase = true;
    if (method.exposed) {
      face.baseExposed = true;
    }
  }
  for (const method of local.methodsBySection.CellMethods) {
    face.hasCell = true;
    if (method.exposed) {
      face.cellExposed = true;
    }
  }
  for (const _method of local.methodsBySection.ClientMethods) {
    face.hasClient = true;
  }
  for (const iface of local.interfaces) {
    const iv = analyzeComponentModule(iface.name, source, visited);
    if (iv) {
      face.hasBase ||= iv.hasBase;
      face.hasCell ||= iv.hasCell;
      face.hasClient ||= iv.hasClient;
      face.baseExposed ||= iv.baseExposed;
      face.cellExposed ||= iv.cellExposed;
    }
  }
  if (local.parentName) {
    const pv = analyzeComponentModule(local.parentName, source, visited);
    if (pv) {
      face.hasBase ||= pv.hasBase;
      face.hasCell ||= pv.hasCell;
      face.hasClient ||= pv.hasClient;
      face.baseExposed ||= pv.baseExposed;
      face.cellExposed ||= pv.cellExposed;
    }
  }
  // autoMatchCompOwn L322-328 approximation: exposed base/cell methods
  // promote client onto the final hasX set
  if ((face.hasBase && face.baseExposed) || (face.hasCell && face.cellExposed)) {
    face.hasClient = true;
  }
  return face;
}

/** Engine loadComponents L793-808 fresh-load branch: derive the slot flags string (isomorphic to Rust). */
function deriveComponentSlotFlags(hasBase: boolean, hasCell: boolean, hasClient: boolean): string {
  const parts: string[] = [];
  if (hasBase) {
    parts.push('BASE');
  }
  if (hasCell) {
    parts.push('CELL_PUBLIC');
  }
  if (hasClient) {
    if (hasBase) {
      parts.push('BASE_AND_CLIENT');
    }
    if (hasCell) {
      parts.push('ENTITY_CLIENT_DATA_FLAGS');
    }
  }
  return parts.join('|');
}

/** Slot domain-bit registration set (engine addComponentProperty L864-874: cell->base->client, only hit domains are registered). */
function slotDomains(
  hasBase: boolean,
  hasCell: boolean,
  hasClient: boolean
): ('cell' | 'base' | 'client')[] {
  const domains: ('cell' | 'base' | 'client')[] = [];
  if (hasCell) {
    domains.push('cell');
  }
  if (hasBase) {
    domains.push('base');
  }
  if (hasClient) {
    domains.push('client');
  }
  return domains;
}

function registerComponentSlot(
  moduleName: string,
  component: DefinitionComponentRef,
  source: DefTreeSource,
  assembly: ModuleAssembly
): void {
  if (LIMITED_PROPERTY_NAMES.has(component.slotName)) {
    assembly.issues.push({
      kind: 'property-name-limited',
      fatal: true,
      line: component.line,
      message: `EntityDef::loadComponents: '${component.slotName}' is limited, in module(${assembly.entityName})!`
    });
    return;
  }

  // Component def domain surface (missing / structural error -> report an
  // issue plus the existing hardcoded three-domain fallback; the lenient
  // continue matches the missing parent/interface policy; isomorphic to Rust
  // register_component_slot).
  let flags: string;
  let hasClient: boolean;
  let domains: ('cell' | 'base' | 'client')[];
  const face = analyzeComponentModule(component.typeName, source, new Set<string>());
  if (face) {
    flags = deriveComponentSlotFlags(face.hasBase, face.hasCell, face.hasClient);
    hasClient = face.hasClient;
    domains = slotDomains(face.hasBase, face.hasCell, face.hasClient);
  } else {
    assembly.issues.push({
      kind: 'component-def-missing',
      fatal: true,
      line: component.line,
      message: `EntityDef::loadComponents: failed to load component:${component.typeName} (components/${component.typeName}.def).`
    });
    flags = 'BASE|CELL_PUBLIC|ENTITY_CLIENT_DATA_FLAGS';
    hasClient = true;
    domains = ['cell', 'base', 'client'];
  }

  const entry: MessagePropertyEntry = {
    name: component.slotName,
    typeName: component.typeName,
    flags,
    hasClient,
    utype: null,
    declaredUtype: null,
    aliasID: null,
    persistent: component.persistent ?? true,
    origin: originLabel(moduleName, 'own'),
    originKind: 'own',
    line: component.line
  };
  assembly.properties.push(entry);

  if (!assembly.seenComponentTypes.has(component.typeName)) {
    assembly.seenComponentTypes.add(component.typeName);
    assembly.types.push({
      name: component.typeName,
      utype: assembly.nextTypeUtype++,
      kind: 'entity-component',
      aliasedTo: null,
      line: component.line,
      origin: moduleName
    });
  }

  const declared = component.utype !== null && component.utype > 0 ? component.utype : null;
  entry.declaredUtype = declared;
  const utype = allocatePropertyUtype(declared, component.slotName, domains, component.line, assembly);
  if (utype === null) {
    return;
  }
  entry.utype = utype;

  // Engine order: addComponentProperty calls addPropertyDescription per
  // domain; if the three name checks hit, that domain is not registered
  // (each domain is attempted independently and a failure only ends that
  // domain). Then addComponentDescription does not check the
  // addComponentProperty return value and runs unconditionally (entitydef.cpp
  // L742-746), so the slot name registers into componentDescr_ even when the
  // three name checks fail -- a later (parent-chain) method with the same
  // name then reports a component conflict rather than a property conflict
  if (assembly.allMethodNames.has(component.slotName)) {
    assembly.issues.push({
      kind: 'property-method-name-conflict',
      fatal: true,
      line: component.line,
      message: `ScriptDefModule::addPropertyDescription: There is a method[${component.slotName}] name conflict! componentType=${DOMAIN_COMPONENT_TYPE.cell}.`
    });
  } else if (assembly.componentNames.has(component.slotName)) {
    assembly.issues.push({
      kind: 'property-component-name-conflict',
      fatal: true,
      line: component.line,
      message: `ScriptDefModule::addPropertyDescription: There is a component[${component.slotName}] name conflict!`
    });
  } else {
    let registered = false;
    for (const domain of domains) {
      if (assembly.propertyDomains[domain].has(component.slotName)) {
        assembly.issues.push({
          kind: 'property-name-conflict',
          fatal: true,
          line: component.line,
          message: `ScriptDefModule::addPropertyDescription: [${component.slotName}] is exist! componentType=${DOMAIN_COMPONENT_TYPE[domain]}.`
        });
        continue;
      }
      assembly.propertyDomains[domain].add(component.slotName);
      registered = true;
    }
    // The engine's hasPropertyName checks the per-domain property tables: a
    // property name counts as taken only when at least one domain registered
    // successfully
    if (registered) {
      assembly.allPropertyNames.add(component.slotName);
    }
  }
  assembly.componentNames.add(component.slotName);
}

/** common.h L141-147 three-domain bit sets: only property tables hit by a domain go through addPropertyDescription */
function domainBitsOf(domain: 'cell' | 'base' | 'client'): number {
  if (domain === 'cell') {
    return ENTITY_CELL_DATA_FLAGS;
  }
  return domain === 'base' ? ENTITY_BASE_DATA_FLAGS : ENTITY_CLIENT_DATA_FLAGS;
}

/**
 * Single-method load simulation (loadDef*Methods): argument sequence (Arg in
 * document order, ARRAY recursed) -> utype allocation (explicit registration /
 * conflict names the holder / automatic takes the smallest unused) -> three
 * name checks (property name / component slot name / duplicate within the
 * same section). Any fatal problem means the method is not added
 * (utype/name are not registered).
 */
function simulateMethod(
  moduleName: string,
  method: DefinitionMethod,
  originKind: 'own' | 'interface' | 'parent',
  assembly: ModuleAssembly
): void {
  const sectionLabel = sectionName(method.section);
  const origin = originLabel(moduleName, originKind);
  const entry: MessageMethodEntry = {
    name: method.name,
    section: method.section,
    direction: method.section === 'ClientMethods'
      ? 'server-to-client'
      : method.exposed ? 'client-to-server' : 'server-internal',
    visibleToClient: method.section === 'ClientMethods' || method.exposed,
    exposed: method.exposed,
    args: [],
    declaredUtype: null,
    utype: null,
    aliasID: null,
    status: 'ok',
    origin,
    originKind,
    line: method.line
  };
  assembly.methods.push(entry);

  let argsOk = true;
  for (const argType of method.argTypes) {
    const argEntry = parseMethodArg(method, argType, origin, assembly);
    entry.args.push(argEntry);
    if (argEntry.utype === null) {
      argsOk = false;
    }
  }
  if (!argsOk) {
    // Engine: return false, no utype is allocated and the method is not added
    entry.status = 'arg-load-failed';
    return;
  }

  // Three name checks (engine addXxxMethodDescription, order: property name ->
  // component slot name -> duplicate within the same section)
  if (assembly.allPropertyNames.has(method.name)) {
    assembly.issues.push({
      kind: 'method-property-name-conflict',
      fatal: true,
      line: method.line,
      message: `ScriptDefModule::add${sectionLabel}MethodDescription: There is a property[${method.name}] name conflict!`
    });
    entry.status = 'name-conflict';
    return;
  }
  if (assembly.componentNames.has(method.name)) {
    assembly.issues.push({
      kind: 'method-component-name-conflict',
      fatal: true,
      line: method.line,
      message: `ScriptDefModule::add${sectionLabel}MethodDescription: There is a component[${method.name}] name conflict!`
    });
    entry.status = 'name-conflict';
    return;
  }
  if (assembly.methodNamesBySection[method.section].has(method.name)) {
    assembly.issues.push({
      kind: 'method-name-conflict',
      fatal: true,
      line: method.line,
      message: `ScriptDefModule::add${sectionLabel}MethodDescription: [${method.name}] is exist!`
    });
    entry.status = 'name-conflict';
    return;
  }

  const declared = method.utype !== null && method.utype > 0 ? method.utype : null;
  entry.declaredUtype = declared;
  let resolvedUtype: number;
  if (declared !== null) {
    if (declared > METHOD_UTYPE_MAX) {
      assembly.issues.push({
        kind: 'utype-overflow',
        fatal: true,
        line: method.line,
        message: `EntityDef::loadDef${sectionLabel}Methods: 'Utype' has overflowed(${declared} > ${METHOD_UTYPE_MAX}), is ${assembly.entityName}.${method.name}!`
      });
      entry.status = 'utype-overflow';
      return;
    }
    // The engine pushes before checking, so duplicates also register (the
    // vector may contain duplicate values; Set semantics are equivalent)
    assembly.usedUtypes.add(declared);
    const holder = assembly.holders.get(declared);
    if (holder) {
      assembly.issues.push({
        kind: 'utype-conflict',
        fatal: true,
        line: method.line,
        message: `EntityDef::loadDef${sectionLabel}Methods: ${assembly.entityName}.${method.name}, 'Utype' ${declared} Conflict(${assembly.entityName}.${holder.name} 'Utype' ${declared})!`
      });
      entry.status = 'utype-conflict';
      return;
    }
    resolvedUtype = declared;
  } else {
    // Automatic allocation: the counter increments one step at a time,
    // skipping used values (engine while-loop semantics)
    while (assembly.usedUtypes.has(assembly.autoCounter)) {
      assembly.autoCounter += 1;
    }
    resolvedUtype = assembly.autoCounter;
    assembly.autoCounter += 1;
    assembly.usedUtypes.add(resolvedUtype);
  }
  entry.utype = resolvedUtype;

  assembly.holders.set(resolvedUtype, { name: method.name });
  assembly.methodNamesBySection[method.section].add(method.name);
  assembly.allMethodNames.add(method.name);
}

/**
 * Argument sequence parsing: plain text looks up the registry (case-sensitive);
 * ARRAY walks the <of> recursion. Engine error literals: unknown type
 * dataType[X] not found; missing of; the of type is unregistered; nested
 * failure Array is wrong. (level by level). An inline array type claims its
 * number at construction, and nested levels register the _{name}_ArrayType
 * name.
 */
function parseMethodArg(
  method: DefinitionMethod,
  argType: DefinitionArgType,
  origin: string,
  assembly: ModuleAssembly
): MessageArgEntry {
  const line = method.line;
  const sectionLabel = sectionName(method.section);
  if (argType.name !== 'ARRAY') {
    const utype = lookupType(argType.name, assembly);
    if (utype === null) {
      assembly.issues.push({
        kind: 'unknown-arg-type',
        fatal: true,
        line,
        message: `EntityDef::loadDef${sectionLabel}Methods: dataType[${argType.name}] not found, in ${method.name}!`
      });
    }
    return { name: argType.name, ofType: null, utype, line };
  }

  // ARRAY: the inline type claims its number at construction (engine
  // FixedArrayType constructor); the {module}_{method} name is not registered;
  // module takes the entity name being loaded (engine argument convention)
  const inlineName = `${assembly.entityName}_${method.name}`;
  const arrayUtype = assembly.nextTypeUtype++;
  assembly.types.push({
    name: inlineName,
    utype: arrayUtype,
    kind: 'inline-array',
    aliasedTo: null,
    line,
    origin
  });

  const ofType = argType.ofType ?? null;
  if (!ofType) {
    assembly.issues.push({
      kind: 'array-of-missing',
      fatal: true,
      line,
      message: 'FixedArrayType::initialize: not found "of".'
    });
    assembly.issues.push({
      kind: 'unknown-arg-type',
      fatal: true,
      line,
      message: `EntityDef::loadDef${sectionLabel}Methods: dataType[ARRAY] not found, in ${method.name}!`
    });
    return { name: 'ARRAY', ofType: null, utype: null, line };
  }

  const elementEntry = parseArrayOfType(
    method,
    ofType,
    inlineName,
    origin,
    assembly
  );
  if (elementEntry === null) {
    // Appended uniformly at the top level: the shared loadDef*Methods error
    // for an initialize failure
    assembly.issues.push({
      kind: 'unknown-arg-type',
      fatal: true,
      line,
      message: `EntityDef::loadDef${sectionLabel}Methods: dataType[ARRAY] not found, in ${method.name}!`
    });
    return { name: 'ARRAY', ofType: null, utype: null, line };
  }
  return {
    name: 'ARRAY',
    ofType: elementEntry,
    utype: arrayUtype,
    line
  };
}

/**
 * ARRAY <of> recursion: if the of text is ARRAY -> nested inline type (the
 * engine names it _{parent}_ArrayType and registers the name); otherwise look
 * up the registry. Only initialize-level errors are reported (the child reports
 * first, the parent appends Array is wrong.); the top-level loadDef*Methods
 * dataType[ARRAY] not found error is appended uniformly by parseMethodArg.
 */
function parseArrayOfType(
  method: DefinitionMethod,
  ofType: DefinitionArgType,
  parentName: string,
  origin: string,
  assembly: ModuleAssembly
): MessageArgEntry | null {
  const line = method.line;
  if (ofType.name === 'ARRAY') {
    // Nested array: construction claims the number immediately
    // (datatypes.cpp L1673-1683); childName is registered
    const childName = `_${parentName}_ArrayType`;
    const childUtype = assembly.nextTypeUtype++;
    assembly.types.push({
      name: childName,
      utype: childUtype,
      kind: 'inline-array',
      aliasedTo: null,
      line,
      origin
    });
    // Missing inner <of> node: the child initialize reports not found "of".
    // first (engine order)
    if (!ofType.ofType) {
      assembly.issues.push({
        kind: 'array-of-missing',
        fatal: true,
        line,
        message: 'FixedArrayType::initialize: not found "of".'
      });
    }
    const nested = ofType.ofType
      ? parseArrayOfType(method, ofType.ofType, childName, origin, assembly)
      : null;
    if (nested === null) {
      // This level's initialize fails because the child level failed: append
      // Array is wrong.
      assembly.issues.push({
        kind: 'array-init-failed',
        fatal: true,
        line,
        message: 'FixedArrayType::initialize: Array is wrong.'
      });
      return null;
    }
    return { name: 'ARRAY', ofType: nested, utype: childUtype, line };
  }

  const elementUtype = lookupType(ofType.name, assembly);
  if (elementUtype === null) {
    assembly.issues.push({
      kind: 'array-of-unknown-type',
      fatal: true,
      line,
      message: `FixedArrayType::initialize: key[ARRAY] did not find type[${ofType.name}]!`
    });
    return null;
  }
  return { name: ofType.name, ofType: null, utype: elementUtype, line };
}

/**
 * aliasID assignment (scriptdef_module.cpp onLoaded L116-196, only when
 * entitydefAliasID is enabled): hasClient properties start at 4 in
 * ascending name order; ClientMethods (all of which have been merged into the
 * module) start at 1 in ascending name order. If a counter exceeds 255,
 * every entry in that group falls back to -1 (silently disabled, no error).
 */
export function assignAliasIds(assembly: ModuleAssembly, aliasIdEnabled: boolean): void {
  if (!aliasIdEnabled) {
    return;
  }

  const clientProperties = assembly.properties
    .filter(property => property.hasClient)
    .sort((left, right) => compareByName(left.name, right.name));
  assignAliasRange(clientProperties, ALIAS_ID_PROPERTY_BASE);

  const clientMethods = assembly.methods
    .filter(method => method.section === 'ClientMethods')
    .sort((left, right) => compareByName(left.name, right.name));
  assignAliasRange(clientMethods, 1);
}

/** Sequential numbering; when the final number exceeds 255 the engine silently falls back to -1 for all entries (aliasID unused, no error) */
function assignAliasRange(entries: Array<{ aliasID: number | null }>, start: number): void {
  let next = start;
  for (const entry of entries) {
    entry.aliasID = next;
    next += 1;
  }
  if (entries.length > 0 && next - 1 > ALIAS_ID_MAX) {
    for (const entry of entries) {
      entry.aliasID = -1;
    }
  }
}

function compareByName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sectionName(section: DefMethodSection): string {
  if (section === 'CellMethods') {
    return 'Cell';
  }
  if (section === 'BaseMethods') {
    return 'Base';
  }
  return 'Client';
}

function originLabel(moduleName: string, originKind: 'own' | 'interface' | 'parent'): string {
  if (originKind === 'own') {
    return moduleName;
  }
  return `${moduleName}(${originKind === 'interface' ? '接口' : '父类'})`;
}

function normalizeSourceKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}
