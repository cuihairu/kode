// C-23 delivery (1): KB-001 behaviour knowledge as structured data (the
// data plane behind the trap -> lint / code action / hover pipeline).
// Sources = docs/knowledge/traps-index.md (KB-001 bucket 4, the semantic
// trap index) plus the background example from the C-23 task brief
// (2026-11-01 user example). Every entry carries the three fields
// applies_to / detection / fix: an entry with a non-null detection is a
// lint rule candidate (the delivery-(2) rules wire up on detectionKind),
// while a detection=null entry is honestly marked as not statically
// detectable and only feeds hover annotations / docs, never claiming to
// be detectable.
//
// This module is pure data + table lookups, and does not import vscode.
// The bilingual notes (noteZh/noteEn) feed the hover behaviour note
// section (delivery 3). Each source points at a knowledge-base article
// anchor, following the same discipline as traps-index ("this page
// introduces no claim beyond the article it cites").

/** Statically detectable pattern ids (entries with a non-null detection wire lint rules by this id) */
export type TrapDetectionKind =
  | 'fixed-dict-nested-mutation'
  | 'destroyed-entity-container-capture'
  | 'timer-cancel-on-destroy';

/** One structured behaviour-knowledge entry */
export interface TrapKnowledgeEntry {
  /** Entry id (numbered within the KB-001 domain) */
  id: string;
  /** Applicable surface: property types / engine APIs (comma-separated or free text) */
  appliesTo: string;
  /** Statically detectable code pattern; null = not statically detectable (no lint wiring, honestly marked) */
  detection: TrapDetectionKind | null;
  /** The correct pattern (fix code / habit) */
  fix: string;
  /** Source of truth (docs/knowledge article anchor or task-brief record) */
  source: string;
  /** Bilingual hover notes */
  noteZh: string;
  noteEn: string;
}

export const TRAP_KNOWLEDGE_ENTRIES: readonly TrapKnowledgeEntry[] = [
  {
    id: 'KB-001-TRAP-FD-001',
    appliesTo: 'FIXED_DICT 属性(子键赋值)',
    detection: 'fixed-dict-nested-mutation',
    fix: '整体重赋:`self.<prop> = {**self.<prop>, "<key>": <value>}`',
    source: 'C-23 任务书背景例(2026-11-01 用户例:属性修改只有顶层 key 才触发事件)',
    noteZh: '行为注记(KB-001):FIXED_DICT 属性只有顶层整体赋值才触发属性同步事件,子键赋值(点号/下标)不会同步——须整体重赋。',
    noteEn: 'Behavior note (KB-001): a FIXED_DICT property only syncs on a whole-property assignment; mutating a sub-key (attribute or subscript) does not trigger the property sync event — reassign the property as a whole.'
  },
  {
    id: 'KB-001-TRAP-LIFE-001',
    appliesTo: '实体引用滞留(self 存入模块级容器)',
    detection: 'destroyed-entity-container-capture',
    fix: 'onDestroy 里解除引用;排查滞留者用 `KBEngine.entities.garbages.items()`',
    source: 'docs/knowledge/traps-index.md §Memory & references(lifecycle §Registry)',
    noteZh: '行为注记(KB-001):把实体引用存入生命周期长于实体的模块级容器(列表/字典/集合),destroy 后引用滞留,引擎 3600 s 后打 garbages 泄漏告警——onDestroy 里解除引用。',
    noteEn: 'Behavior note (KB-001): storing an entity reference in a module-level container (list/dict/set) that outlives the entity keeps the destroyed entity alive; the engine logs a garbages leak warning after 3600 s — drop the reference in onDestroy.'
  },
  {
    id: 'KB-001-TRAP-TIMER-001',
    appliesTo: 'delTimer(addTimer 句柄注销)',
    detection: 'timer-cancel-on-destroy',
    fix: '存活期早取消才用 delTimer;销毁期清理交给引擎(onDestroy 内 delTimer 冗余)',
    source: 'docs/knowledge/traps-index.md §Timers & controllers(lifecycle §Timers)',
    noteZh: '行为注记(KB-001):destroy() 即 cancelAll——引擎销毁已取消本实体全部定时器,onDestroy 里 delTimer 是多余清理;且对陈旧 id 的 delTimer 静默返回 -1(fork 口径,不报错)。',
    noteEn: 'Behavior note (KB-001): destroy() already cancels all entity timers (scriptTimers_.cancelAll()) — delTimer inside onDestroy is redundant cleanup; delTimer with a stale id silently returns -1 (fork behavior, no error).'
  },
  {
    id: 'KB-001-TRAP-MIG-001',
    appliesTo: 'teleport(跨空间传送)',
    detection: null,
    fix: '从真身实体发起 teleport;EntityCall 参数必须是 cell-real',
    source: 'docs/knowledge/traps-index.md §Migration & teleport(migration §Teleport)',
    noteZh: '行为注记(KB-001):ghost 实体不能 teleport(「not is real entity」断言);EntityCall 参数必须是 cell-real 引用,传错走 onTeleportFailure。',
    noteEn: 'Behavior note (KB-001): a ghost entity cannot teleport (assertion "not is real entity"); the EntityCall argument must be cell-real, otherwise onTeleportFailure fires.'
  },
  {
    id: 'KB-001-TRAP-MIG-002',
    appliesTo: '跨 cellapp 迁移后的 onDestroy(onLeaveSpace)',
    detection: null,
    fix: '每空间清理放 onLeaveSpace,不放在 onDestroy 假设上',
    source: 'docs/knowledge/traps-index.md §Migration & teleport(migration §Completion)',
    noteZh: '行为注记(KB-001):跨 cellapp 迁移后旧 cell 的 onDestroy 不会执行(callScript=false 销毁)——每空间清理放 onLeaveSpace,别押在 onDestroy 上。',
    noteEn: 'Behavior note (KB-001): after a cross-cellapp teleport the old cell\'s onDestroy never fires (destroyed with callScript=false) — put per-space cleanup in onLeaveSpace, not in onDestroy assumptions.'
  },
  {
    id: 'KB-001-TRAP-EC-001',
    appliesTo: 'EntityCall(远端调用面)',
    detection: null,
    fix: '方法在 .def 声明;引擎 API 用本地实体引用',
    source: 'docs/knowledge/traps-index.md §EntityCall semantics(api-core-concepts §1.1)',
    noteZh: '行为注记(KB-001):EntityCall 只能调用 .def 声明的方法,经它调引擎方法不可达——引擎 API 走本地实体引用。',
    noteEn: 'Behavior note (KB-001): an EntityCall can only invoke methods declared in the .def file — engine methods are not reachable through it; use a local entity reference for engine APIs.'
  }
];

/** Look up entries by detection pattern (the wiring surface for lint rules / hover notes) */
export function getTrapEntryByDetection(
  detection: TrapDetectionKind
): TrapKnowledgeEntry | null {
  return TRAP_KNOWLEDGE_ENTRIES.find(entry => entry.detection === detection) ?? null;
}
