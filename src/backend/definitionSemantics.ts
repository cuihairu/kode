import { normalizeFileIdentity } from './pathIdentity';
import { propertyFlagDomainList } from './defAnalyzer';
import { readSharedFileSnapshot, readSharedFileSnapshotIdentity } from '../sharedFileSnapshot';
import {
  DefDocument,
  DefElementNode,
  DefMethodSection,
  DEF_METHOD_SECTIONS,
  getDirectChildElement,
  getDirectChildElements,
  getDirectChildElementsByName,
  getElementText,
  getLineNumberAt,
  getScalarChildValue,
  hasTruthyChildTag,
  parseDefDocument
} from './defParser';
import {
  DefinitionCategory,
  findDefinitionFileByCategory,
  findEntityDefinitionFile,
  getWorkspaceRootForDocument
} from '../definitionWorkspace';
import { getReferenceTargetName, INTERFACE_WRAPPER_NAMES } from './defRenamer';

export type DefinitionSemanticCategory = Exclude<DefinitionCategory, 'type'>;
export type DefinitionMemberSourceKind = 'local' | 'interface' | 'parent' | 'component';

export interface DefinitionOwnerRef {
  kind: DefinitionSemanticCategory;
  name: string;
  filePath: string;
}

export interface DefinitionMemberSource {
  kind: DefinitionMemberSourceKind;
  chain: string[];
  label: string;
}

export interface DefinitionInterfaceRef {
  name: string;
  line: number;
}

export interface DefinitionComponentRef {
  slotName: string;
  typeName: string;
  line: number;
  owner: DefinitionOwnerRef;
  /** Component slot <Utype> child value (batch 123); null = not declared, occupies the property utype space */
  utype: number | null;
  /** Component slot <Persistent> (IDE-RUST-006); undefined = omitted (engine default is true) */
  persistent?: boolean;
}

export interface DefinitionProperty {
  name: string;
  fullPath: string;
  line: number;
  typeName?: string;
  flags?: string;
  /** <Utype> child value (batch 123); null = not declared. Property utype and method utype are two independent spaces */
  utype?: number | null;
  persistent?: boolean;
  identifier?: boolean;
  indexType?: string;
  databaseLength?: number;
  detailLevel?: string;
  defaultValue?: string;
  owner: DefinitionOwnerRef;
  source: DefinitionMemberSource;
  children: DefinitionProperty[];
  arrayElement?: DefinitionProperty;
}

/**
 * Structured argument-sequence entry (batch 123). name = the direct text of
 * <Arg> (e.g. UINT8 / ARRAY); for ARRAY, ofType is the parsed <of> child, and
 * nested ARRAY recurses (matching the engine's FixedArrayType::initialize
 * <of> recursion chain).
 */
export interface DefinitionArgType {
  name: string;
  ofType?: DefinitionArgType;
}

export interface DefinitionMethod {
  name: string;
  line: number;
  section: DefMethodSection;
  args: string[];
  /** Structured argument sequence corresponding 1:1 to args (batch 123: includes the ARRAY of chain) */
  argTypes: DefinitionArgType[];
  exposed: boolean;
  /** <Utype> child value (batch 123); null = not declared. Engine semantics: <= 0 counts as unset, > 65535 overflows with an error */
  utype: number | null;
  /** <ReturnType> child value as direct text (user order 2026-10-27 task 2: the -> hint in definition-site inlay); null = not declared */
  returnType: string | null;
  owner: DefinitionOwnerRef;
  source: DefinitionMemberSource;
}

export interface LocalDefinitionSemantics {
  category: DefinitionSemanticCategory;
  owner: DefinitionOwnerRef;
  document: DefDocument;
  parentName?: string;
  parentLine?: number;
  interfaces: DefinitionInterfaceRef[];
  components: DefinitionComponentRef[];
  properties: DefinitionProperty[];
  methods: DefinitionMethod[];
  methodsBySection: Record<DefMethodSection, DefinitionMethod[]>;
}

export interface DefinitionInheritanceGroup {
  owner: DefinitionOwnerRef;
  label: string;
  properties: DefinitionProperty[];
  methodsBySection: Record<DefMethodSection, DefinitionMethod[]>;
}

export interface ResolvedDefinitionComponentSlot {
  slotName: string;
  typeName: string;
  line: number;
  owner: DefinitionOwnerRef;
  resolved: ResolvedDefinitionSemantics | null;
  source: DefinitionMemberSource;
}

export interface ResolvedDefinitionSemantics {
  category: DefinitionSemanticCategory;
  owner: DefinitionOwnerRef;
  local: LocalDefinitionSemantics;
  parentName?: string;
  inheritanceGroups: DefinitionInheritanceGroup[];
  effectiveProperties: DefinitionProperty[];
  effectiveMethodsBySection: Record<DefMethodSection, DefinitionMethod[]>;
  components: ResolvedDefinitionComponentSlot[];
}

/**
 * RUST-003: identity-set-based cache entry -- identitySet covers every file
 * consumed by this semantic resolution (normalized path key -> snapshot
 * {source,version} token). Before a hit, each file's token is re-probed; any
 * drift marks the entry stale and triggers a re-parse. The consumed file set
 * comes from ResolutionContext.visited (every def entered by the resolution
 * chain is registered), covering the entry file together with parent/interface
 * files -- validating only the entry would miss the "entry unchanged, parent
 * changed" window. Identity inside the key replaces invalidation calls; no
 * clear() is relied on.
 */
interface IdentityCachedEntry<T> {
  readonly identitySet: ReadonlyMap<string, string>;
  readonly value: T;
}

interface ResolutionContext {
  allowComponents: boolean;
  /** Cycle guard: registered on entry, unwound on exit (DFS backtracking); does NOT represent the consumed set */
  visited: Set<string>;
  /** RUST-003: consumption record -- every def file touched during resolution (add-only), the source of
   * truth for the cache identity set; visited is a cycle guard that unwinds and cannot serve as the
   * consumed set. */
  consumed: Set<string>;
  /** IDE-IDX-002: origin root of the resolution (carried by exact-path entries): parent/interface by-name resolution prefers this root, and the cache is partitioned per root */
  originRoot?: string;
}

export class DefinitionSemanticsLoader {
  // RUST-003: cache entries are identity-carrying -- the value is "identity tokens + semantics", not bare semantics.
  // Before a hit, the entry file's identity is re-probed; drift triggers a re-parse. Identity inside the key
  // replaces invalidation calls, and loader instances are short-lived (one query / one scan round), so a file
  // changed during the instance's lifetime cannot yield a stale value.
  private localCache = new Map<string, IdentityCachedEntry<LocalDefinitionSemantics | null>>();
  private resolvedCache = new Map<string, IdentityCachedEntry<ResolvedDefinitionSemantics | null>>();

  /** RUST-003: full re-probe of the identity set -- any consumed file's token drifting marks the entry stale. */
  private identitySetMatches(identitySet: ReadonlyMap<string, string>): boolean {
    for (const [pathKey, token] of identitySet) {
      if (this.identityTokenFor(pathKey) !== token) {
        return false;
      }
    }
    return true;
  }

  /** RUST-003: visited (the resolution-consumed file set) -> identity set; if any file's identity cannot be
   * probed (deleted, etc.), returns null so the caller skips the cache and re-parses each time (honest semantics). */
  private identitySetFromVisited(
    visited: ReadonlySet<string>
  ): ReadonlyMap<string, string> | null {
    const identitySet = new Map<string, string>();
    for (const pathKey of visited) {
      const token = this.identityTokenFor(pathKey);
      if (token === null) {
        return null;
      }
      identitySet.set(pathKey, token);
    }
    return identitySet;
  }

  /** Single root (existing contract) or multiple roots (workspace top level union assetsRoot; 2026-10-16 scan-root correction) */
  constructor(private readonly workspaceRoot: string | string[]) {}

  private get workspaceRoots(): string[] {
    return Array.isArray(this.workspaceRoot) ? this.workspaceRoot : [this.workspaceRoot];
  }

  /** RUST-003: lightweight identity token -- the snapshot {source,version} stringified; returns
   * null when it cannot be probed, and callers never cache on null (no identity, no memory; honest semantics). */
  private identityTokenFor(filePath: string): string | null {
    const identity = readSharedFileSnapshotIdentity(filePath);
    if (!identity) {
      return null;
    }
    return `${identity.source}:${identity.version ?? 'unknown'}`;
  }

  loadLocal(
    name: string,
    category: DefinitionSemanticCategory,
    originRoot?: string
  ): LocalDefinitionSemantics | null {
    const cacheKey = this.partitionedCacheKey(buildCacheKey(category, name), originRoot);
    const filePath = this.resolveDefinitionFile(name, category, originRoot);
    if (!filePath) {
      // Path-resolution failure does not record a negative cache entry: the root set is stable over the
      // loader's lifetime, so re-walking resolution only costs per-root existsSync calls, and in exchange a
      // file created later becomes visible in the same round (RUST-003 identity-carrying semantics).
      return null;
    }

    // RUST-003: before a hit, re-probe the entry file's identity -- a changed on-disk mtime or an advanced
    // buffer version both count as drift, and drift triggers a re-parse; when identity cannot be probed
    // (file gone), nothing is cached and every lookup reads fresh.
    const identityToken = this.identityTokenFor(filePath);
    const entryKey = normalizeLookupPath(filePath);
    const cached = this.localCache.get(cacheKey);
    if (
      cached !== undefined &&
      identityToken !== null &&
      cached.identitySet.get(entryKey) === identityToken
    ) {
      return cached.value;
    }

    // IDE-SNP-002: the text source of truth is the shared snapshot -- an open def prefers the editor buffer
    // (unsaved property/method declarations are visible); unopened files still load from disk as before.
    const content = readSharedFileSnapshot(filePath)?.content ?? null;
    if (!content) {
      // No content (disk read failure): record null only when identity could be probed -- retry this round
      // after identity drift
      if (identityToken !== null) {
        this.localCache.set(cacheKey, {
          identitySet: new Map([[entryKey, identityToken]]),
          value: null
        });
      }
      return null;
    }

    try {
      const parsed = parseLocalDefinition(content, category, name, filePath);
      if (identityToken !== null) {
        this.localCache.set(cacheKey, {
          identitySet: new Map([[entryKey, identityToken]]),
          value: parsed
        });
      }
      return parsed;
    } catch {
      if (identityToken !== null) {
        this.localCache.set(cacheKey, {
          identitySet: new Map([[entryKey, identityToken]]),
          value: null
        });
      }
      return null;
    }
  }

  /** Raw-text passthrough surface (for Rust command-level RPC corpora): fetch a file's raw text plus path
   * by name, without parsing. Shares the same source of truth as loadLocal (shared snapshot: open buffer
   * first, disk fallback when not open), but skips semantic parsing -- the Rust side owns parsing and the
   * TS side only collects raw text. */
  loadLocalRaw(
    name: string,
    category: DefinitionSemanticCategory,
    originRoot?: string
  ): { content: string; filePath: string } | null {
    const filePath = this.resolveDefinitionFile(name, category, originRoot);
    if (!filePath) {
      return null;
    }
    const content = readSharedFileSnapshot(filePath)?.content ?? null;
    if (content === null) {
      return null;
    }
    return { content, filePath };
  }

  loadResolved(
    name: string,
    category: DefinitionSemanticCategory,
    allowComponents = true
  ): ResolvedDefinitionSemantics | null {
    const cacheKey = `${buildCacheKey(category, name)}::${allowComponents ? 'components' : 'plain'}`;
    // RUST-003: full identity re-probe of the resolution-consumed set (entry + parent/interface/component
    // chain) -- visited is registered file-by-file along the resolution chain and is the complete consumed
    // set; identity drift triggers a re-parse.
    const cached = this.resolvedCache.get(cacheKey);
    if (cached && this.identitySetMatches(cached.identitySet)) {
      return cached.value;
    }

    const context: ResolutionContext = {
      allowComponents,
      visited: new Set<string>(),
      consumed: new Set<string>()
    };
    const resolved = this.loadResolvedInternal(name, category, context);
    const identitySet = this.identitySetFromVisited(context.consumed);
    if (identitySet !== null) {
      this.resolvedCache.set(cacheKey, { identitySet, value: resolved });
    }
    return resolved;
  }

  /**
   * IDE-IDX-001: load an entry by exact def path -- bypasses the name-resolution per-root first hit and
   * parses the specified file directly (with two same-named roots, the caller asking for B gets B). The
   * cache is partitioned per path and never cross-talks with the name cache; unreadable files / parse
   * failures return null rather than fabricating semantics.
   */
  loadResolvedAt(
    defPath: string,
    name: string,
    category: DefinitionSemanticCategory,
    allowComponents = true
  ): ResolvedDefinitionSemantics | null {
    const cacheKey = `at:${normalizeLookupPath(defPath)}::${buildCacheKey(category, name)}::${allowComponents ? 'components' : 'plain'}`;
    // RUST-003: same-named entry point -- full identity re-probe of the consumed set (entry file plus the chain's parents/interfaces).
    const cached = this.resolvedCache.get(cacheKey);
    if (cached && this.identitySetMatches(cached.identitySet)) {
      return cached.value;
    }
    const context: ResolutionContext = {
      allowComponents,
      visited: new Set<string>(),
      consumed: new Set<string>(),
      // IDE-IDX-002: origin root for exact-path entries -- parent/interface by-name resolution prefers this
      // root (the old internal fallback context builder carried it; now that context is always passed in, it
      // must be filled in here, otherwise same-named parent resolution across two roots degenerates to per-
      // root first hit and same-named A/B definitions cross roots)
      originRoot: this.originRootOf(defPath)
    };
    const resolved = this.loadResolvedAtInternal(defPath, name, category, allowComponents, context);
    const identitySet = this.identitySetFromVisited(context.consumed);
    if (identitySet !== null) {
      this.resolvedCache.set(cacheKey, { identitySet, value: resolved });
    }
    return resolved;
  }

  private loadResolvedAtInternal(
    defPath: string,
    name: string,
    category: DefinitionSemanticCategory,
    allowComponents: boolean,
    context?: ResolutionContext
  ): ResolvedDefinitionSemantics | null {
    // IDE-SNP-002: exact-path entries also go through the shared snapshot (open document buffer first).
    const content = readSharedFileSnapshot(defPath)?.content ?? null;
    if (!content) {
      return null;
    }
    try {
      const local = parseLocalDefinition(content, category, name, defPath);
      return this.resolveSemanticsFromLocal(local, context ?? {
        allowComponents,
        visited: new Set<string>(),
        consumed: new Set<string>(),
        originRoot: this.originRootOf(defPath)
      });
    } catch {
      return null;
    }
  }

  private loadResolvedInternal(
    name: string,
    category: DefinitionSemanticCategory,
    context: ResolutionContext
  ): ResolvedDefinitionSemantics | null {
    const local = this.loadLocal(name, category, context.originRoot);
    if (!local) {
      return null;
    }
    return this.resolveSemanticsFromLocal(local, context);
  }

  /**
   * IDE-IDX-001: resolve from already-located local semantics (shared by the name entry and the exact-path
   * entry); visited dedupes by owner file path and unwinds on exit.
   */
  /**
   * Effective merge key: property path + flag-bucket-set signature. The engine dedupes as "unique by name
   * within a bucket" (scriptdef_module.cpp:585-593; bucket routing entitydef.cpp:1284-1297) -- same-named
   * properties with disjoint bucket sets legitimately coexist (e.g. a BASE+Persistent entry and an
   * ALL_CLIENTS entry, each with its own utype); identical bucket sets make the engine refuse to load, and
   * here the first entry keeps its shadowing semantics (already reported by lint).
   * Analysis: docs/review/2026-11-10-def-duplicate-property-and-owner-only-flags.md.
   */
  // eslint-disable-next-line no-invalid-this -- stateless pure function; making it static would break this file's in-class layout convention
  private effectivePropertyKey(property: DefinitionProperty): string {
    const domains = propertyFlagDomainList(property.flags).slice().sort();
    return domains.length > 0
      ? `${property.fullPath}::${domains.join('+')}`
      : property.fullPath;
  }

  private resolveSemanticsFromLocal(
    local: LocalDefinitionSemantics,
    context: ResolutionContext
  ): ResolvedDefinitionSemantics | null {
    const category = local.owner.kind;
    const visitKey = normalizeLookupPath(local.owner.filePath);
    if (context.visited.has(visitKey)) {
      return null;
    }

    context.visited.add(visitKey);
    context.consumed.add(visitKey);
    try {
      const inheritanceGroups: DefinitionInheritanceGroup[] = [];
      const effectivePropertyMap = new Map<string, DefinitionProperty>();
      const effectiveMethodMaps: Record<DefMethodSection, Map<string, DefinitionMethod>> = createMethodMapRecord();
      const componentSlots: ResolvedDefinitionComponentSlot[] = [];
      const seenComponentSlots = new Set<string>();

      for (const property of local.properties) {
        if (!effectivePropertyMap.has(effectivePropertyKey(property))) {
          effectivePropertyMap.set(effectivePropertyKey(property), cloneProperty(property));
        }
      }

      for (const section of DEF_METHOD_SECTIONS) {
        for (const method of local.methodsBySection[section]) {
          if (!effectiveMethodMaps[section].has(method.name)) {
            effectiveMethodMaps[section].set(method.name, cloneMethod(method));
          }
        }
      }

      if (context.allowComponents) {
        for (const component of local.components) {
          const slotKey = component.slotName.toLowerCase();
          if (seenComponentSlots.has(slotKey)) {
            continue;
          }

          seenComponentSlots.add(slotKey);
          componentSlots.push({
            slotName: component.slotName,
            typeName: component.typeName,
            line: component.line,
            owner: component.owner,
            resolved: this.loadResolvedInternal(component.typeName, 'component', {
              allowComponents: false,
              visited: context.visited,
          consumed: context.consumed,
              originRoot: context.originRoot
            }),
            source: createSource('local')
          });
        }
      }

      const interfaceAllowComponents = context.allowComponents && category !== 'component';
      for (const interfaceRef of local.interfaces) {
        const interfaceResolved = this.loadResolvedInternal(interfaceRef.name, 'interface', {
          allowComponents: interfaceAllowComponents,
          visited: context.visited,
          consumed: context.consumed,
          originRoot: context.originRoot
        });
        if (!interfaceResolved) {
          continue;
        }

        inheritanceGroups.push({
          owner: interfaceResolved.owner,
          label: buildInheritanceLabel('Mixin', [interfaceRef.name]),
          properties: interfaceResolved.local.properties.map(property => cloneProperty(
            property,
            undefined,
            createSource('interface', [interfaceRef.name])
          )),
          methodsBySection: cloneMethodSectionRecord(
            interfaceResolved.local.methodsBySection,
            createSource('interface', [interfaceRef.name])
          )
        });

        for (const property of interfaceResolved.effectiveProperties) {
          if (!effectivePropertyMap.has(effectivePropertyKey(property))) {
            effectivePropertyMap.set(
              effectivePropertyKey(property),
              cloneProperty(property, undefined, createSource('interface', [interfaceRef.name]))
            );
          }
        }

        for (const section of DEF_METHOD_SECTIONS) {
          for (const method of interfaceResolved.effectiveMethodsBySection[section]) {
            if (!effectiveMethodMaps[section].has(method.name)) {
              effectiveMethodMaps[section].set(
                method.name,
                cloneMethod(method, undefined, createSource('interface', [interfaceRef.name]))
              );
            }
          }
        }

        if (context.allowComponents) {
          for (const component of interfaceResolved.components) {
            const slotKey = component.slotName.toLowerCase();
            if (seenComponentSlots.has(slotKey)) {
              continue;
            }

            seenComponentSlots.add(slotKey);
            componentSlots.push({
              slotName: component.slotName,
              typeName: component.typeName,
              line: component.line,
              owner: component.owner,
              resolved: component.resolved,
              source: createSource('interface', [interfaceRef.name])
            });
          }
        }

        for (const nestedGroup of interfaceResolved.inheritanceGroups) {
          const chain = [interfaceRef.name].concat(extractSourceChain(nestedGroup.properties, nestedGroup.methodsBySection));
          inheritanceGroups.push({
            owner: nestedGroup.owner,
            label: buildInheritanceLabel('Mixin', chain),
            properties: nestedGroup.properties.map(property => cloneProperty(
              property,
              undefined,
              createSource('interface', chain)
            )),
            methodsBySection: cloneMethodSectionRecord(
              nestedGroup.methodsBySection,
              createSource('interface', chain)
            )
          });
        }
      }

      // KR-AUD-72: the engine never calls loadParentClass for interface defs (entitydef.cpp:611-638 --
      // interfaces only go through loadAllDefDescriptions), so interface semantics must not merge Parent.
      if (local.parentName && category !== 'interface') {
        const parentCategory = category === 'component' ? 'component' : 'entity';
        const parentResolved = this.loadResolvedInternal(local.parentName, parentCategory, {
          allowComponents: context.allowComponents,
          visited: context.visited,
          consumed: context.consumed,
          originRoot: context.originRoot
        });

        if (parentResolved) {
          const parentChain = [local.parentName];
          inheritanceGroups.push({
            owner: parentResolved.owner,
            label: buildInheritanceLabel('Parent', parentChain),
            properties: parentResolved.local.properties.map(property => cloneProperty(
              property,
              undefined,
              createSource('parent', parentChain)
            )),
            methodsBySection: cloneMethodSectionRecord(
              parentResolved.local.methodsBySection,
              createSource('parent', parentChain)
            )
          });

          for (const property of parentResolved.effectiveProperties) {
            if (!effectivePropertyMap.has(effectivePropertyKey(property))) {
              effectivePropertyMap.set(
                effectivePropertyKey(property),
                cloneProperty(property, undefined, createSource('parent', parentChain))
              );
            }
          }

          for (const section of DEF_METHOD_SECTIONS) {
            for (const method of parentResolved.effectiveMethodsBySection[section]) {
              if (!effectiveMethodMaps[section].has(method.name)) {
                effectiveMethodMaps[section].set(
                  method.name,
                  cloneMethod(method, undefined, createSource('parent', parentChain))
                );
              }
            }
          }

          if (context.allowComponents) {
            for (const component of parentResolved.components) {
              const slotKey = component.slotName.toLowerCase();
              if (seenComponentSlots.has(slotKey)) {
                continue;
              }

              seenComponentSlots.add(slotKey);
              componentSlots.push({
                slotName: component.slotName,
                typeName: component.typeName,
                line: component.line,
                owner: component.owner,
                resolved: component.resolved,
                source: createSource('parent', parentChain)
              });
            }
          }

          for (const nestedGroup of parentResolved.inheritanceGroups) {
            const chain = parentChain.concat(extractSourceChain(nestedGroup.properties, nestedGroup.methodsBySection));
            inheritanceGroups.push({
              owner: nestedGroup.owner,
              label: buildInheritanceLabel('Parent', chain),
              properties: nestedGroup.properties.map(property => cloneProperty(
                property,
                undefined,
                createSource('parent', chain)
              )),
              methodsBySection: cloneMethodSectionRecord(
                nestedGroup.methodsBySection,
                createSource('parent', chain)
              )
            });
          }
        }
      }

      return {
        category,
        owner: local.owner,
        local,
        parentName: local.parentName,
        inheritanceGroups,
        effectiveProperties: [...effectivePropertyMap.values()],
        effectiveMethodsBySection: mapRecordValues(effectiveMethodMaps),
        components: componentSlots
      };
    } finally {
      context.visited.delete(visitKey);
    }
  }

  /** IDE-IDX-002: name cache key is partitioned per root (tagged when an origin root exists), so same-named A/B never cross-talk. */
  private partitionedCacheKey(base: string, originRoot?: string): string {
    return originRoot ? `${base}@${normalizeLookupPath(originRoot)}` : base;
  }

  /** Root the exact def path belongs to (under no root -> undefined, falls back to the unpartitioned semantics). */
  private originRootOf(defPath: string): string | undefined {
    const normalized = normalizeLookupPath(defPath);
    return this.workspaceRoots.find(
      root => normalized.startsWith(`${normalizeLookupPath(root)}/`)
    );
  }

  private resolveDefinitionFile(
    name: string,
    category: DefinitionSemanticCategory,
    originRoot?: string
  ): string | null {
    // Per-root resolution: the workspace top level and assetsRoot are each searched by their conventional
    // layout, first hit wins (in a multi-root project defs and scripts may live under two different roots);
    // since IDE-IDX-002, when there is an origin root for the resolution, that root takes priority (same-named
    // parent/interface resolves back to this root first), with the remaining roots still falling back in their
    // original order.
    for (const root of this.orderedRoots(originRoot)) {
      const found = category === 'entity'
        ? findEntityDefinitionFile(name, root)
        : findDefinitionFileByCategory(name, category, root);
      if (found) {
        return found;
      }
    }
    return null;
  }

  /** Moves the origin root to the front (remaining roots keep their original order; an unknown origin root is returned as-is). */
  private orderedRoots(originRoot?: string): string[] {
    if (!originRoot || !this.workspaceRoots.includes(originRoot)) {
      return this.workspaceRoots;
    }
    return [originRoot, ...this.workspaceRoots.filter(root => root !== originRoot)];
  }
}

export function createDefinitionSemanticsLoader(
  target?: string | string[] | Pick<{ fileName: string }, 'fileName'>
): DefinitionSemanticsLoader | null {
  const workspaceRoot = Array.isArray(target)
    ? target.filter(Boolean)
    : typeof target === 'string'
      ? target
      : getWorkspaceRootForDocument(target as { fileName: string } | undefined);

  if (Array.isArray(workspaceRoot)) {
    return workspaceRoot.length > 0 ? new DefinitionSemanticsLoader(workspaceRoot) : null;
  }
  return workspaceRoot ? new DefinitionSemanticsLoader(workspaceRoot) : null;
}

export function parseLocalDefinition(
  content: string,
  category: DefinitionSemanticCategory,
  name: string,
  filePath: string
): LocalDefinitionSemantics {
  const document = parseDefDocument(content);
  const root = document.root;
  const owner: DefinitionOwnerRef = { kind: category, name, filePath };
  const methodsBySection = createMethodRecord();

  if (!root) {
    return {
      category,
      owner,
      document,
      interfaces: [],
      components: [],
      properties: [],
      methods: [],
      methodsBySection
    };
  }

  const parentNode = getDirectChildElement(root, 'Parent');
  // Taking the Parent name mirrors the engine's enterNode/getKey (text -> text, element -> tag name);
  // the same implementation is shared with defRenamer's parseDefFileSemantics instead of writing two copies
  const parentName = parentNode ? getReferenceTargetName(parentNode) : '';
  const interfaceRefs = parseInterfaceRefs(document, getDirectChildElement(root, 'Interfaces'));
  const componentRefs = parseComponentRefs(document, getDirectChildElement(root, 'Components'), owner);
  const properties = parseProperties(document, getDirectChildElement(root, 'Properties'), owner);
  const methods = parseMethods(document, root, owner);

  for (const method of methods) {
    methodsBySection[method.section].push(method);
  }

  return {
    category,
    owner,
    document,
    parentName: parentName || undefined,
    parentLine: parentNode ? getLineNumberAt(document, parentNode.tagStart) : undefined,
    interfaces: interfaceRefs,
    components: componentRefs,
    properties,
    methods,
    methodsBySection
  };
}

function parseInterfaceRefs(
  document: DefDocument,
  interfacesNode?: DefElementNode
): DefinitionInterfaceRef[] {
  if (!interfacesNode) {
    return [];
  }

  const interfaces: DefinitionInterfaceRef[] = [];
  for (const child of getDirectChildElements(interfacesNode)) {
    // The engine's loadInterfaces (entitydef.cpp L559-561) only loads child elements whose wrapper tag is one of
    // the four spellings interface/Interface/type/Type (case-sensitive exact comparison); anything else is
    // skipped with continue -- the direct form (<MoveIface/>) is silently skipped by the engine and produces no
    // mixin. Name-taking semantics match <Parent>: the first non-comment child node, text -> text, element -> tag name
    if (!INTERFACE_WRAPPER_NAMES.has(child.name)) {
      continue;
    }
    const name = getReferenceTargetName(child);
    if (!name) {
      continue;
    }

    interfaces.push({
      name,
      line: getLineNumberAt(document, child.tagStart)
    });
  }

  return interfaces;
}

function parseComponentRefs(
  document: DefDocument,
  componentsNode: DefElementNode | undefined,
  owner: DefinitionOwnerRef
): DefinitionComponentRef[] {
  if (!componentsNode) {
    return [];
  }

  const components: DefinitionComponentRef[] = [];
  for (const child of getDirectChildElements(componentsNode)) {
    const typeName = getNodeValue(getDirectChildElement(child, 'Type'));
    if (!typeName) {
      continue;
    }

    components.push({
      slotName: child.name,
      typeName,
      line: getLineNumberAt(document, child.tagStart),
      owner,
      utype: parseUtypeValue(getScalarChildValue(child, 'Utype')),
      persistent: parseOptionalBoolean(getScalarChildValue(child, 'Persistent'))
    });
  }

  return components;
}

function parseProperties(
  document: DefDocument,
  sectionNode: DefElementNode | undefined,
  owner: DefinitionOwnerRef,
  prefixPath = ''
): DefinitionProperty[] {
  if (!sectionNode) {
    return [];
  }

  const properties: DefinitionProperty[] = [];
  for (const propertyNode of getDirectChildElements(sectionNode)) {
    const fullPath = prefixPath ? `${prefixPath}.${propertyNode.name}` : propertyNode.name;
    const typeName = getScalarChildValue(propertyNode, 'Type');
    const property: DefinitionProperty = {
      name: propertyNode.name,
      fullPath,
      line: getLineNumberAt(document, propertyNode.tagStart),
      typeName,
      flags: getScalarChildValue(propertyNode, 'Flags'),
      utype: parseUtypeValue(getScalarChildValue(propertyNode, 'Utype')),
      persistent: parseOptionalBoolean(getScalarChildValue(propertyNode, 'Persistent')),
      identifier: hasTruthyChildTag(propertyNode, 'Identifier'),
      indexType: getScalarChildValue(propertyNode, 'Index'),
      databaseLength: parseOptionalNumber(getScalarChildValue(propertyNode, 'DatabaseLength')),
      detailLevel: getScalarChildValue(propertyNode, 'DetailLevel'),
      defaultValue: getScalarChildValue(propertyNode, 'Default'),
      owner,
      source: createSource('local'),
      children: []
    };

    const childPropertiesNode = getDirectChildElement(propertyNode, 'Properties');
    if (childPropertiesNode) {
      property.children = parseProperties(document, childPropertiesNode, owner, fullPath);
    }

    const typeNode = getDirectChildElement(propertyNode, 'Type');
    const arrayOfType = typeNode ? getScalarChildValue(typeNode, 'of') : undefined;
    if (arrayOfType) {
      property.arrayElement = {
        name: 'value',
        fullPath: `${fullPath}[]`,
        line: property.line,
        typeName: arrayOfType,
        flags: property.flags,
        persistent: property.persistent,
        identifier: false,
        indexType: undefined,
        databaseLength: property.databaseLength,
        detailLevel: property.detailLevel,
        defaultValue: undefined,
        owner,
        source: createSource('local'),
        children: [],
        arrayElement: undefined
      };

      // Unreachable (batch 66 ruling): this sits inside the `if (arrayOfType)` block, and arrayOfType can only
      // come from the previous line's ternary taking the non-null arm of typeNode (getScalarChildValue yields a
      // truthy value only on a hit); typeNode is an immutable const, so the recheck always takes the true arm
      // and the `: undefined` false arm has no trigger path. The statement and its two branch entries are moved
      // out of the denominator via the range ignore (registered as-is per the TESTING.md denominator
      // contract); the true-arm behavior is already locked by the existing ARRAY of <Type> with nested
      // <Properties> recursion test case.
      /* istanbul ignore start */
      const nestedArrayPropertiesNode = typeNode ? getDirectChildElement(typeNode, 'Properties') : undefined;
      /* istanbul ignore stop */
      if (nestedArrayPropertiesNode) {
        property.arrayElement.children = parseProperties(
          document,
          nestedArrayPropertiesNode,
          owner,
          `${fullPath}[]`
        );
      }
    }

    properties.push(property);
  }

  return properties;
}

function parseMethods(
  document: DefDocument,
  root: DefElementNode,
  owner: DefinitionOwnerRef
): DefinitionMethod[] {
  const methods: DefinitionMethod[] = [];

  for (const section of DEF_METHOD_SECTIONS) {
    const sectionNode = getDirectChildElement(root, section);
    if (!sectionNode) {
      continue;
    }

    for (const methodNode of getDirectChildElements(sectionNode)) {
      // args and argTypes are produced in the same loop, guaranteeing 1:1 (an empty-text Arg is dropped consistently in both)
      const args: string[] = [];
      const argTypes: DefinitionArgType[] = [];
      for (const argNode of getDirectChildElementsByName(methodNode, 'Arg')) {
        // The engine's type-reading contract (entitydef.cpp:1625-1643 + xml.cpp:121-127 getValStr only
        // accepts text nodes; an element node's ToText() is NULL and returns an empty string): the first
        // child node of Arg must be direct text (`<Arg> STRING </Arg>`); with the element form
        // `<Arg><Type>STRING</Type>`, the first child is an element -> getValStr yields an empty string ->
        // dataType[] not found -> the engine aborts at startup. Empty direct text = not declared (empty-text
        // Args are dropped consistently in both places); the element form is not accepted (matching the engine
        // contract, so the parser does not accept a form the engine treats as fatal).
        const argName = getElementText(argNode).trim();
        if (!argName) {
          continue;
        }
        args.push(argName);
        argTypes.push(parseArgType(argNode, argName));
      }

      const utypeText = getScalarChildValue(methodNode, 'Utype');
      const returnTypeText = getScalarChildValue(methodNode, 'ReturnType');
      methods.push({
        name: methodNode.name,
        line: getLineNumberAt(document, methodNode.tagStart),
        section,
        args,
        argTypes,
        exposed: hasTruthyChildTag(methodNode, 'Exposed'),
        utype: parseUtypeValue(utypeText),
        returnType: returnTypeText ? returnTypeText.trim() || null : null,
        owner,
        source: createSource('local')
      });
    }
  }

  return methods;
}

// The engine's Arg parsing (entitydef.cpp loadDef*Methods): the direct text of <Arg> is the type name;
// "ARRAY" goes through FixedArrayType::initialize, reads the <of> child, and recurses for nesting. A missing
// <of> node and an empty <of></of> are preserved distinctly (ofType: {name:''}): the engine reports not found "of".
// for the former and key[ARRAY] did not find type[]! for the latter, and the generator side branches on that
function parseArgType(argNode: DefElementNode, name: string): DefinitionArgType {
  if (name !== 'ARRAY') {
    return { name };
  }
  const ofNode = getDirectChildElement(argNode, 'of');
  if (!ofNode) {
    return { name };
  }
  const ofName = getElementText(ofNode).trim();
  if (!ofName) {
    return { name, ofType: { name: '' } };
  }
  return { name, ofType: parseArgType(ofNode, ofName) };
}

// The engine's getValInt semantics: non-numeric text yields 0 (treated as unset and auto-assigned); the overflow
// check does not live in the parsing layer, the generator side enforces it as >65535 (uint16 truncation
// comparison, reported as an error at the engine layer)
function parseUtypeValue(text: string | undefined): number | null {
  if (text === undefined) {
    return null;
  }
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function getNodeValue(node?: DefElementNode): string {
  if (!node) {
    return '';
  }

  const text = getElementText(node).trim();
  if (text) {
    return text;
  }

  const firstChild = getDirectChildElements(node)[0];
  return firstChild ? firstChild.name.trim() : '';
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  return undefined;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function buildCacheKey(category: DefinitionSemanticCategory, name: string): string {
  return `${category}:${name}`;
}

/**
 * Effective merge key: property path + flag-bucket-set signature. The engine dedupes as "unique by name
 * within a bucket" (scriptdef_module.cpp:585-593; bucket routing entitydef.cpp:1284-1297) -- same-named
 * properties with disjoint bucket sets legitimately coexist (e.g. a BASE+Persistent entry and an ALL_CLIENTS
 * entry, each with its own utype); identical bucket sets make the engine refuse to load, and here the first
 * entry keeps its shadowing semantics (already reported by lint).
 * Analysis: docs/review/2026-11-10-def-duplicate-property-and-owner-only-flags.md.
 */
function effectivePropertyKey(property: DefinitionProperty): string {
  const domains = propertyFlagDomainList(property.flags).slice().sort();
  return domains.length > 0
    ? `${property.fullPath}::${domains.join('+')}`
    : property.fullPath;
}

function createSource(
  kind: DefinitionMemberSourceKind,
  chain: string[] = []
): DefinitionMemberSource {
  return {
    kind,
    chain: [...chain],
    label: kind === 'local'
      ? 'Own'
      : buildInheritanceLabel(kind === 'interface' ? 'Mixin' : 'Parent', chain)
  };
}

function buildInheritanceLabel(prefix: 'Mixin' | 'Parent', chain: string[]): string {
  // Unreachable (batch 62 ruling): the five call sites (L249/304/329/384 in this file plus createSource) all pass
  // a chain headed by a literal name ([interfaceRef.name] / [local.parentName] / parentChain
  // .concat(...)), so the length is always >= 1; createSource's default parameter [] only occurs together with
  // kind='local' calls (which take the 'Own' branch), so the empty-chain arm has no trigger path.
  /* istanbul ignore start */
  if (chain.length === 0) {
    return prefix;
  }
  /* istanbul ignore stop */

  return `${prefix} · ${chain.join(' / ')}`;
}

function cloneProperty(
  property: DefinitionProperty,
  owner?: DefinitionOwnerRef,
  source?: DefinitionMemberSource
): DefinitionProperty {
  return {
    ...property,
    owner: owner || property.owner,
    source: source || cloneSource(property.source),
    children: property.children.map(child => cloneProperty(child, owner, source)),
    arrayElement: property.arrayElement ? cloneProperty(property.arrayElement, owner, source) : undefined
  };
}

function cloneMethod(
  method: DefinitionMethod,
  owner?: DefinitionOwnerRef,
  source?: DefinitionMemberSource
): DefinitionMethod {
  return {
    ...method,
    args: [...method.args],
    owner: owner || method.owner,
    source: source || cloneSource(method.source)
  };
}

function cloneSource(source: DefinitionMemberSource): DefinitionMemberSource {
  return {
    kind: source.kind,
    chain: [...source.chain],
    label: source.label
  };
}

function createMethodRecord(): Record<DefMethodSection, DefinitionMethod[]> {
  return {
    BaseMethods: [],
    CellMethods: [],
    ClientMethods: []
  };
}

function createMethodMapRecord(): Record<DefMethodSection, Map<string, DefinitionMethod>> {
  return {
    BaseMethods: new Map<string, DefinitionMethod>(),
    CellMethods: new Map<string, DefinitionMethod>(),
    ClientMethods: new Map<string, DefinitionMethod>()
  };
}

function cloneMethodSectionRecord(
  source: Record<DefMethodSection, DefinitionMethod[]>,
  nextSource: DefinitionMemberSource
): Record<DefMethodSection, DefinitionMethod[]> {
  return {
    BaseMethods: source.BaseMethods.map(method => cloneMethod(method, undefined, nextSource)),
    CellMethods: source.CellMethods.map(method => cloneMethod(method, undefined, nextSource)),
    ClientMethods: source.ClientMethods.map(method => cloneMethod(method, undefined, nextSource))
  };
}

function mapRecordValues(
  source: Record<DefMethodSection, Map<string, DefinitionMethod>>
): Record<DefMethodSection, DefinitionMethod[]> {
  return {
    BaseMethods: [...source.BaseMethods.values()],
    CellMethods: [...source.CellMethods.values()],
    ClientMethods: [...source.ClientMethods.values()]
  };
}

function extractSourceChain(
  properties: DefinitionProperty[],
  methodsBySection: Record<DefMethodSection, DefinitionMethod[]>
): string[] {
  const firstProperty = properties[0];
  if (firstProperty?.source.chain.length) {
    return [...firstProperty.source.chain];
  }

  for (const section of DEF_METHOD_SECTIONS) {
    const firstMethod = methodsBySection[section][0];
    if (firstMethod?.source.chain.length) {
      return [...firstMethod.source.chain];
    }
  }

  return [];
}

export function normalizeLookupPath(targetPath: string): string {
  return normalizeFileIdentity(targetPath);
}
