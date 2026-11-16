import { describe, expect, it } from 'vitest';
import type { RenderGraph, RenderNode } from '../src/entityDependencyGraphView';
import {
  createEntityRelationsViewModel,
  expandEntityRelations,
  relationFocusCandidates,
  relationsToRenderGraph,
  renderRelationsMermaid,
  resolveRelationsFocusId
} from '../src/backend/entityRelationsBrowser';

// RUST-178/KBE-008:实体关系浏览器纯核钉——聚焦双向邻接/懒展开幂等/子图
// 投影两源口径/relations mermaid 指令行(已展开=openFilePath,未展开=
// relationsExpand)。零 vscode,fake RenderGraph 夹具手工构造。

const node = (
  id: string,
  name: string,
  kind: RenderNode['kind'],
  filePath = `defs/${id}.def`,
  types?: string[]
): RenderNode => ({
  id,
  rawId: id,
  label: `${name}`,
  name,
  filePath,
  kind,
  ...(types ? { types } : {})
});

const rustGraph: RenderGraph = {
  nodes: [
    node('entity_Avatar', 'Avatar', 'entity', 'defs/Avatar.def', ['Base', 'Cell']),
    node('entity_Monster', 'Monster', 'entity', 'defs/Monster.def'),
    node('component_Bag', 'Bag', 'component', 'components/Bag.def'),
    node('type_ItemType', 'ItemType', 'type', 'types.xml'),
    node('interface_IMovement', 'IMovement', 'interface', 'interfaces/IMovement.def'),
    node('python_avatar', 'avatar.py', 'python', 'scripts/avatar.py')
  ],
  edges: [
    { from: 'entity_Avatar', to: 'entity_Monster', kind: 'inheritance' },
    { from: 'entity_Avatar', to: 'component_Bag', kind: 'has-a', label: 'bag' },
    { from: 'entity_Avatar', to: 'type_ItemType', kind: 'property-type', label: 'item' },
    // 第二条同 (from,to,kind) 重复边:可见边收集必须去重
    { from: 'entity_Avatar', to: 'type_ItemType', kind: 'property-type' },
    // 入向:Avatar 被 IMovement 实现(双向探索的「谁引用我」面)
    { from: 'interface_IMovement', to: 'entity_Avatar', kind: 'implements' },
    // 二层:Monster 的 python 实现,初始不可见
    { from: 'entity_Monster', to: 'python_avatar', kind: 'method-impl' }
  ],
  paths: { entitiesXml: 'entities/entities.xml', defsRoot: 'defs', typesXml: 'types.xml' },
  stats: {
    nodeCount: 6,
    edgeCount: 6,
    entityCount: 2,
    defCount: 0,
    interfaceCount: 1,
    componentCount: 1,
    typeCount: 1,
    pythonCount: 1
  },
  source: 'rust'
};

const tsGraph: RenderGraph = {
  nodes: [
    node('Avatar', 'Avatar', 'entity', 'defs/Avatar.def', ['Base']),
    node('Monster', 'Monster', 'entity', 'defs/Monster.def', ['Cell'])
  ],
  edges: [{ from: 'Avatar', to: 'Monster', kind: 'inheritance', label: 'parent' }],
  paths: null,
  stats: {
    nodeCount: 2,
    edgeCount: 1,
    entityCount: 2,
    defCount: 0,
    interfaceCount: 0,
    componentCount: 0,
    typeCount: 0,
    pythonCount: 0
  },
  legacyStats: {
    totalEntities: 2,
    baseEntities: 1,
    cellEntities: 1,
    clientEntities: 0,
    maxDepth: 1,
    mostReferenced: 'Monster'
  },
  source: 'ts'
};

const created = () => createEntityRelationsViewModel(rustGraph, 'entity_Avatar');

describe('entityRelationsBrowser create', () => {
  it('shows focus plus bidirectional direct neighbors; focus expanded, neighbors not', () => {
    const result = created();
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const ids = result.model.nodes.map(n => n.id);
    expect(ids).toContain('entity_Avatar');
    expect(ids).toContain('entity_Monster');
    expect(ids).toContain('component_Bag');
    expect(ids).toContain('type_ItemType');
    expect(ids).toContain('interface_IMovement');
    expect(ids).not.toContain('python_avatar');
    const byId = new Map(result.model.nodes.map(n => [n.id, n]));
    expect(byId.get('entity_Avatar')?.expanded).toBe(true);
    expect(byId.get('entity_Monster')?.expanded).toBe(false);
    expect(result.model.expandedIds).toEqual(['entity_Avatar']);
  });

  it('includes incoming edges (implements) in the visible edge set, deduped', () => {
    const result = created();
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const kinds = result.model.edges.map(e => e.kind);
    expect(kinds).toContain('implements');
    expect(kinds).toContain('has-a');
    // 重复 (from,to,kind) 去重:5 条候选中涉及 Avatar 的去重后 4 条
    expect(result.model.edges).toHaveLength(4);
  });

  it('counts neighbors in both directions for the lazy badge', () => {
    const result = created();
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const byId = new Map(result.model.nodes.map(n => [n.id, n]));
    expect(byId.get('entity_Avatar')?.neighborCount).toBe(4);
    expect(byId.get('interface_IMovement')?.neighborCount).toBe(1);
    expect(byId.get('python_avatar')).toBeUndefined();
  });

  it('assigns depth 0 to focus and 1 to direct neighbors', () => {
    const result = created();
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const byId = new Map(result.model.nodes.map(n => [n.id, n]));
    expect(byId.get('entity_Avatar')?.depth).toBe(0);
    expect(byId.get('entity_Monster')?.depth).toBe(1);
  });

  it('reports focus-not-found with entity-first sorted candidates', () => {
    const result = createEntityRelationsViewModel(rustGraph, 'entity_Ghost');
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.reason).toBe('focus-not-found');
    // localeCompare 口径:小写 avatar.py 依 ICU 排在 Bag 之前
    expect(result.candidates).toEqual(['Avatar', 'Monster', 'avatar.py', 'Bag', 'IMovement', 'ItemType']);
  });
});

describe('entityRelationsBrowser expand', () => {
  it('expands second layer bidirectionally with depth +1', () => {
    const result = created();
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const expansion = expandEntityRelations(result.model, rustGraph, 'entity_Monster');
    expect(expansion.expanded).toBe(true);
    expect(expansion.addedNodes).toBe(1);
    expect(expansion.addedEdges).toBe(1);
    const ids = expansion.model.nodes.map(n => n.id);
    expect(ids).toContain('python_avatar');
    const byId = new Map(expansion.model.nodes.map(n => [n.id, n]));
    expect(byId.get('entity_Monster')?.expanded).toBe(true);
    expect(byId.get('python_avatar')?.depth).toBe(2);
    expect(expansion.model.edges.some(e => e.kind === 'method-impl')).toBe(true);
  });

  it('is idempotent: re-expanding an expanded node returns the same model untouched', () => {
    const result = created();
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const first = expandEntityRelations(result.model, rustGraph, 'entity_Monster');
    const second = expandEntityRelations(first.model, rustGraph, 'entity_Monster');
    expect(second.expanded).toBe(false);
    expect(second.addedNodes).toBe(0);
    expect(second.addedEdges).toBe(0);
    expect(second.model).toBe(first.model);
  });

  it('refuses unknown and invisible nodes honestly', () => {
    const result = created();
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const unknown = expandEntityRelations(result.model, rustGraph, 'python_avatar');
    expect(unknown.expanded).toBe(false);
    expect(unknown.model).toBe(result.model);
    const ghost = expandEntityRelations(result.model, rustGraph, 'entity_Ghost');
    expect(ghost.expanded).toBe(false);
    expect(ghost.model).toBe(result.model);
  });
});

describe('entityRelationsBrowser focus resolution', () => {
  it('matches exact id first, then by name preferring entity kind', () => {
    expect(resolveRelationsFocusId(rustGraph, 'entity_Avatar')).toBe('entity_Avatar');
    expect(resolveRelationsFocusId(rustGraph, 'Avatar')).toBe('entity_Avatar');
    expect(resolveRelationsFocusId(rustGraph, 'avatar.py')).toBe('python_avatar');
    expect(resolveRelationsFocusId(rustGraph, 'Ghost')).toBeNull();
    expect(resolveRelationsFocusId(rustGraph, '')).toBeNull();
  });
});

describe('entityRelationsBrowser projection', () => {
  it('projects a subset RenderGraph with source/paths preserved and stats recomputed', () => {
    const result = created();
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const subset = relationsToRenderGraph(result.model, rustGraph);
    expect(subset.source).toBe('rust');
    expect(subset.paths).toEqual(rustGraph.paths);
    expect(subset.stats.nodeCount).toBe(5);
    expect(subset.stats.edgeCount).toBe(4);
    expect(subset.stats.entityCount).toBe(2);
    expect(subset.stats.interfaceCount).toBe(1);
    expect(subset.stats.componentCount).toBe(1);
    expect(subset.stats.typeCount).toBe(1);
    expect(subset.stats.pythonCount).toBe(0);
  });

  it('recomputes legacy stats from the visible subset, not the full graph', () => {
    const result = created();
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const subset = relationsToRenderGraph(result.model, rustGraph);
    expect(subset.legacyStats?.totalEntities).toBe(2);
    expect(subset.legacyStats?.baseEntities).toBe(1);
    expect(subset.legacyStats?.cellEntities).toBe(1);
    expect(subset.legacyStats?.clientEntities).toBe(0);
    expect(subset.legacyStats?.maxDepth).toBe(1);
    // Avatar 可见边入度最高(4 条全与它相关)
    expect(subset.legacyStats?.mostReferenced).toBe('Avatar');
    // 全图 legacyStats(若有)绝不带出子图冒充
    expect(subset.legacyStats).not.toBe(rustGraph.legacyStats);
  });

  it('ts-source subsets keep legacy stats honest for the visible view', () => {
    const view = createEntityRelationsViewModel(tsGraph, 'Avatar');
    expect(view.ok).toBe(true);
    if (!view.ok) { return; }
    const expanded = expandEntityRelations(view.model, tsGraph, 'Monster');
    const subset = relationsToRenderGraph(expanded.model, tsGraph);
    expect(subset.source).toBe('ts');
    expect(subset.legacyStats?.totalEntities).toBe(2);
    expect(subset.legacyStats?.baseEntities).toBe(1);
    expect(subset.legacyStats?.cellEntities).toBe(1);
    expect(subset.legacyStats?.maxDepth).toBe(1);
    expect(subset.legacyStats?.mostReferenced).toBe('Avatar');
  });
});

describe('entityRelationsBrowser mermaid', () => {
  it('rust source: kind arrows, openFilePath only for expanded, relationsExpand for the rest', () => {
    const result = created();
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const mermaid = renderRelationsMermaid(result.model, rustGraph);
    expect(mermaid).toContain('graph TD');
    // 边 kind 分箭头(has-a → --o,implements → ==>)
    expect(mermaid).toContain('entity_Avatar --o|bag| component_Bag');
    expect(mermaid).toContain('interface_IMovement ==> entity_Avatar');
    // 焦点已展开 → openFilePath;其余未展开 → relationsExpand
    expect(mermaid).toContain('click entity_Avatar openFilePath "defs/Avatar.def"');
    expect(mermaid).toContain('click entity_Monster relationsExpand "entity_Monster"');
    expect(mermaid).not.toContain('click entity_Monster openFilePath');
    // 未展开徽标 +N
    expect(mermaid).toContain('Monster＋2"]');
    // 焦点高亮
    expect(mermaid).toContain('classDef focusNode');
    expect(mermaid).toContain('class entity_Avatar focusNode;');
    // rust 源按 kind 出 classDef
    expect(mermaid).toContain('classDef entityNode');
    expect(mermaid).toContain('class component_Bag componentNode;');
  });

  it('after expansion the newly expanded node flips to openFilePath and deeper nodes get expand directives', () => {
    const result = created();
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const expansion = expandEntityRelations(result.model, rustGraph, 'entity_Monster');
    const mermaid = renderRelationsMermaid(expansion.model, rustGraph);
    expect(mermaid).toContain('click entity_Monster openFilePath "defs/Monster.def"');
    expect(mermaid).not.toContain('click entity_Monster relationsExpand');
    expect(mermaid).toContain('click python_avatar relationsExpand "python_avatar"');
    // 二层边可见,method-impl 虚线箭头
    expect(mermaid).toContain('entity_Monster -.-> python_avatar');
  });

  it('ts source: plain arrows, legacy face classes, expand directives', () => {
    const view = createEntityRelationsViewModel(tsGraph, 'Avatar');
    expect(view.ok).toBe(true);
    if (!view.ok) { return; }
    const mermaid = renderRelationsMermaid(view.model, tsGraph);
    expect(mermaid).toContain('Avatar -->|parent| Monster');
    expect(mermaid).toContain('classDef baseNode');
    expect(mermaid).toContain('class Avatar baseNode;');
    expect(mermaid).toContain('click Monster relationsExpand "Monster"');
    expect(mermaid).not.toContain('relationsExpand "Avatar"');
  });
});

describe('entityRelationsBrowser candidates', () => {
  it('lists entities first sorted, then other kinds sorted, deduped', () => {
    expect(relationFocusCandidates(rustGraph)).toEqual([
      'Avatar',
      'Monster',
      'avatar.py',
      'Bag',
      'IMovement',
      'ItemType'
    ]);
  });
});
