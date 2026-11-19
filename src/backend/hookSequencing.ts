/**
 * KBEngine 钩子时序数据核(HOOK-TIMING-001)
 *
 * 每条实体回调(src/hooks.ts 全 36 条,另补录语料有名而 hooks.ts 未收录的
 * onLoseCell)标注生命周期阶段与前驱/后继时序边;非钩子时序锚点(def 属性
 * 注入、cellData 就位/删除、teleport 新 space 就位等)单独成表。
 *
 * 锚纪律:引擎 file:line 只取既有语料——src/hooks.ts 各条 sourceLocation
 * 与 docs/knowledge/entity-lifecycle-reference.md「Cell state table」/
 * api-baseapp.md §2「Entity creation family」/api-core-concepts.md §3
 * 生命周期总图中已固化的行号,不新造锚。边只填语料可依的前后关系,
 * 推不出的留空(诚实边界)。
 */

import { KBENGINE_HOOKS } from '../hooks';

/** 生命周期阶段(横切回调单列,不硬归某个阶段)。 */
export type HookPhase =
  | 'creation'      // 创建与 def 属性/cellData 注入
  | 'cell-attach'   // cell 挂载链(创建/失败/失去/进出)
  | 'space'         // 空间进出与消失
  | 'witness-view'  // 视野与观察
  | 'movement'      // 移动与转向
  | 'teleport'      // 传送
  | 'trap'          // 陷阱
  | 'persistence'   // 恢复/归档/写库
  | 'client-link'   // 客户端连接族(Proxy)
  | 'destruction'   // 销毁
  | 'cross-cutting'; // 横切(定时器等任何阶段可触发)

/** 钩子宿主侧。 */
export type HookSide = 'base' | 'cell' | 'both' | 'proxy';

/** 单条钩子的时序标注。 */
export interface HookSequencing {
  phase: HookPhase;
  side: HookSide;
  /** 前驱:钩子名或 TIMING_ANCHORS 键(带 `-` 连字符的为锚点)。 */
  before: string[];
  /** 后继:同上。分支语义(成功/失败)只把分支端列入边,不加概率。 */
  after: string[];
  /** 触发源(引擎动作描述)。 */
  trigger: string;
  /** 语料锚:hooks.ts sourceLocation 原文或知识档已固化行号。 */
  anchors: string[];
}

/** 非钩子时序锚点(def 属性注入等),hover 与时序图的共用节点。 */
export interface TimingAnchor {
  label: string;
  anchors: string[];
}

/**
 * 非钩子锚点表。
 * 锚来源:api-baseapp.md §2(params dict 键路由/.def 默认)、
 * entity-lifecycle-reference.md(Cell state table 的 baseapp/entity.cpp
 * 行号与 cellData 删除/永不复活语义、Timers 无强引用)、
 * api-core-concepts.md §3(cellData keeps the would-be cell attributes、
 * onGetCell fires on the base when it lands)。
 */
export const TIMING_ANCHORS: Record<string, TimingAnchor> = {
  'def-属性注入': {
    label: 'def 属性注入',
    anchors: [
      'docs/knowledge/api-baseapp.md §2 Entity creation family(params dict 键初始化 base 属性;未指定键保持 .def 默认)',
      'docs/knowledge/api-core-concepts.md §3(创建分层:not atomic)',
    ],
  },
  'cellData-就位': {
    label: 'cellData 就位(cell 属性暂存)',
    anchors: [
      'docs/knowledge/api-baseapp.md §2(cell 属性键路由进 cellData,cell 创建时才生效)',
      'docs/knowledge/api-core-concepts.md §3(baseapp/Entity.md:359-369 转述:cellData keeps the would-be cell attributes)',
    ],
  },
  'cellData-删除': {
    label: 'cellData 属性删除(cell 就位即刻)',
    anchors: [
      'kbe/src/server/baseapp/entity.cpp:1024(destroyCellData;docs/knowledge/entity-lifecycle-reference.md Cell state table)',
    ],
  },
  'cellData-永不复活': {
    label: 'cellData 在 onLoseCell 后不复活',
    anchors: [
      'docs/knowledge/entity-lifecycle-reference.md Cell state table(nothing reinstates cellData;Python attribute stays deleted)',
    ],
  },
  'teleport-新space就位': {
    label: '传送目标 space/位置就位',
    anchors: [
      'kbe/src/server/cellapp/entity.cpp:3814(onTeleportSuccess 附带目标点附近实体;src/hooks.ts 该条 sourceLocation)',
    ],
  },
  '定时器-无强引用': {
    label: 'addTimer 不持实体强引用',
    anchors: [
      'docs/knowledge/entity-lifecycle-reference.md Timers(no strong reference, cancelled on destroy)',
    ],
  },
  'restore-cell到达': {
    label: 'restore 流程 cell 先到',
    anchors: [
      'kbe/src/server/baseapp/restore_entity_handler.cpp:173,266(onRestore 在 cell 到达后触发;docs/knowledge/entity-lifecycle-reference.md Cell state table)',
    ],
  },
};

/**
 * 钩子时序表。键=钩子名;36 条 KBENGINE_HOOKS 全覆盖,另补录 onLoseCell
 * (entity-lifecycle-reference.md Cell state table 语料锚,hooks.ts 收录面
 * 的已知缺口,单独批补)。
 */
export const HOOK_SEQUENCING: Record<string, HookSequencing> = {
  // ==================== creation / cell-attach ====================
  onGetCell: {
    phase: 'cell-attach',
    side: 'base',
    before: ['def-属性注入', 'cellData-就位'],
    after: ['cellData-删除', 'onLoseCell', 'onClientGetCell'],
    trigger: 'createCellEntity / createCellEntityInNewSpace / restoreCell 的异步请求完成,cell 实体落地',
    anchors: [
      'kbe/src/server/baseapp/entity.cpp:1032(src/hooks.ts)',
      'kbe/src/server/baseapp/entity.cpp:1028,1030-1032(docs/knowledge/entity-lifecycle-reference.md Cell state table)',
    ],
  },
  onCreateCellFailure: {
    phase: 'cell-attach',
    side: 'base',
    before: ['def-属性注入'],
    after: [],
    trigger: 'createCellEntity 请求失败(分支端,与 onGetCell 二选一)',
    anchors: ['kbe/src/server/baseapp/entity.cpp:884(src/hooks.ts)'],
  },
  onLoseCell: {
    phase: 'cell-attach',
    side: 'base',
    before: ['onGetCell'],
    after: ['cellData-永不复活'],
    trigger: 'cell 实体释放(S_RELEASE);base 侧仍存活',
    anchors: [
      'kbe/src/server/baseapp/entity.cpp:1059,1065(docs/knowledge/entity-lifecycle-reference.md Cell state table;补录条目,hooks.ts 未收录)',
    ],
  },
  onEnteringCell: {
    phase: 'cell-attach',
    side: 'cell',
    before: [],
    after: ['onEnteredCell'],
    trigger: 'cell 实体进入新 cell 之前(创建或跨 cellapp 迁移)',
    anchors: ['kbe/src/server/cellapp/entity.cpp:3847(src/hooks.ts)'],
  },
  onEnteredCell: {
    phase: 'cell-attach',
    side: 'cell',
    before: ['onEnteringCell'],
    after: [],
    trigger: 'cell 实体(含迁移)完成进入新 cell 之后',
    anchors: ['kbe/src/server/cellapp/entity.cpp:3839(src/hooks.ts)'],
  },
  onLeavingCell: {
    phase: 'cell-attach',
    side: 'cell',
    before: [],
    after: ['onLeftCell'],
    trigger: 'cell 实体离开当前 cell 之前(迁移/销毁)',
    anchors: ['kbe/src/server/cellapp/entity.cpp:3855(src/hooks.ts)'],
  },
  onLeftCell: {
    phase: 'cell-attach',
    side: 'cell',
    before: ['onLeavingCell'],
    after: [],
    trigger: 'cell 实体完成离开当前 cell 之后',
    anchors: ['kbe/src/server/cellapp/entity.cpp:3863(src/hooks.ts)'],
  },

  // ==================== space ====================
  onEnterSpace: {
    phase: 'space',
    side: 'cell',
    before: [],
    after: [],
    trigger: 'cell 实体进入 space 之后',
    anchors: ['kbe/src/server/cellapp/entity.cpp:3823(src/hooks.ts)'],
  },
  onLeaveSpace: {
    phase: 'space',
    side: 'cell',
    before: [],
    after: [],
    trigger: 'cell 实体离开 space 之前',
    anchors: ['kbe/src/server/cellapp/entity.cpp:3831(src/hooks.ts)'],
  },
  onSpaceGone: {
    phase: 'space',
    side: 'cell',
    before: [],
    after: [],
    trigger: '所在 space 被销毁(与 onLeaveSpace 不同源:不是实体离开,是空间消失)',
    anchors: ['kbe/src/server/cellapp/entity.cpp:387(src/hooks.ts)'],
  },

  // ==================== witness-view ====================
  onGetWitness: {
    phase: 'witness-view',
    side: 'cell',
    before: [],
    after: ['onUpdateBegin', 'onEnteredView'],
    trigger: '实体获得第一个观察者(witness 建立)',
    anchors: ['kbe/src/server/cellapp/entity.cpp:2180(src/hooks.ts)'],
  },
  onLoseWitness: {
    phase: 'witness-view',
    side: 'cell',
    before: ['onUpdateEnd'],
    after: [],
    trigger: '实体失去全部观察者',
    anchors: ['kbe/src/server/cellapp/entity.cpp:2218(src/hooks.ts)'],
  },
  onWitnessed: {
    phase: 'witness-view',
    side: 'cell',
    before: [],
    after: [],
    trigger: '实体被观察状态变化(isWitnessed 翻转,参数为布尔)',
    anchors: [
      'kbe/src/server/cellapp/entity.cpp:1486; kbe/src/server/cellapp/entity.cpp:1531(src/hooks.ts)',
    ],
  },
  onEnteredView: {
    phase: 'witness-view',
    side: 'cell',
    before: ['onGetWitness'],
    after: [],
    trigger: '实体进入某 witness 的视野(进入即被同步给客户端)',
    anchors: ['kbe/src/server/cellapp/entity.cpp:1786(src/hooks.ts)'],
  },
  onUpdateBegin: {
    phase: 'witness-view',
    side: 'cell',
    before: ['onGetWitness'],
    after: ['onUpdateEnd'],
    trigger: '每轮视野同步开始(witness 持有期间循环触发)',
    anchors: ['kbe/src/server/cellapp/witness.cpp:753(src/hooks.ts)'],
  },
  onUpdateEnd: {
    phase: 'witness-view',
    side: 'cell',
    before: ['onUpdateBegin'],
    after: ['onLoseWitness'],
    trigger: '每轮视野同步结束',
    anchors: ['kbe/src/server/cellapp/witness.cpp:899(src/hooks.ts)'],
  },
  onLoseControlledBy: {
    phase: 'witness-view',
    side: 'cell',
    before: [],
    after: [],
    trigger: '实体失去被控制权(giveClientTo 控制绑定解除)',
    anchors: ['kbe/src/server/cellapp/entity.cpp:1513(src/hooks.ts)'],
  },

  // ==================== movement ====================
  onMove: {
    phase: 'movement',
    side: 'cell',
    before: [],
    after: ['onMoveOver', 'onMoveFailure'],
    trigger: '移动控制器每次推进(路径行进中反复触发)',
    anchors: ['kbe/src/server/cellapp/entity.cpp:2946(src/hooks.ts)'],
  },
  onMoveOver: {
    phase: 'movement',
    side: 'cell',
    before: ['onMove'],
    after: [],
    trigger: '路径走完(成功端,与 onMoveFailure 分支)',
    anchors: ['kbe/src/server/cellapp/entity.cpp:2964(src/hooks.ts)'],
  },
  onMoveFailure: {
    phase: 'movement',
    side: 'cell',
    before: ['onMove'],
    after: [],
    trigger: '移动失败(分支端)',
    anchors: ['kbe/src/server/cellapp/entity.cpp:2982(src/hooks.ts)'],
  },
  onTurn: {
    phase: 'movement',
    side: 'cell',
    before: [],
    after: [],
    trigger: '转向完成',
    anchors: ['kbe/src/server/cellapp/entity.cpp:3098(src/hooks.ts)'],
  },

  // ==================== teleport ====================
  onTeleport: {
    phase: 'teleport',
    side: 'cell',
    before: [],
    after: ['onTeleportSuccess', 'onTeleportFailure'],
    trigger: 'teleport 请求发出,传送开始',
    anchors: ['kbe/src/server/cellapp/entity.cpp:3786(src/hooks.ts)'],
  },
  onTeleportSuccess: {
    phase: 'teleport',
    side: 'both',
    before: ['onTeleport', 'teleport-新space就位'],
    after: [],
    trigger: 'cellapp 侧完成传送并附带目标点附近实体(可能为 None);baseapp 侧流程收尾无参调用',
    anchors: [
      'kbe/src/server/cellapp/entity.cpp:3814; kbe/src/server/baseapp/entity.cpp:1567(src/hooks.ts)',
    ],
  },
  onTeleportFailure: {
    phase: 'teleport',
    side: 'both',
    before: ['onTeleport'],
    after: [],
    trigger: '传送失败(分支端,baseapp 与 cellapp 双侧)',
    anchors: [
      'kbe/src/server/baseapp/entity.cpp:1558; kbe/src/server/cellapp/entity.cpp:3797(src/hooks.ts)',
    ],
  },

  // ==================== trap ====================
  onEnterTrap: {
    phase: 'trap',
    side: 'cell',
    before: [],
    after: ['onLeaveTrap', 'onLeaveTrapID'],
    trigger: '实体进入陷阱范围',
    anchors: ['kbe/src/server/cellapp/entity.cpp:1759(src/hooks.ts)'],
  },
  onLeaveTrap: {
    phase: 'trap',
    side: 'cell',
    before: ['onEnterTrap'],
    after: [],
    trigger: '实体离开陷阱范围(实体仍可用)',
    anchors: ['kbe/src/server/cellapp/entity.cpp:1768(src/hooks.ts)'],
  },
  onLeaveTrapID: {
    phase: 'trap',
    side: 'cell',
    before: ['onEnterTrap'],
    after: [],
    trigger: '离开陷阱但离开的实体已不可用(拿不到对象只给 ID)',
    anchors: ['kbe/src/server/cellapp/entity.cpp:1777(src/hooks.ts)'],
  },

  // ==================== persistence ====================
  onRestore: {
    phase: 'persistence',
    side: 'base',
    before: ['restore-cell到达'],
    after: [],
    trigger: 'baseapp 崩溃后恢复:onRestore 在恢复的 cell 到达之后触发',
    anchors: [
      'kbe/src/server/cellapp/entity.cpp:3871; kbe/src/server/baseapp/entity.cpp:1083(src/hooks.ts);docs/knowledge/entity-lifecycle-reference.md Cell state table(onRestore 在 cell 到达后)',
    ],
  },
  onPreArchive: {
    phase: 'persistence',
    side: 'base',
    before: [],
    after: ['onWriteToDB'],
    trigger: '每次归档前',
    anchors: ['kbe/src/server/baseapp/entity.cpp:1298(src/hooks.ts)'],
  },
  onWriteToDB: {
    phase: 'persistence',
    side: 'both',
    before: ['onPreArchive'],
    after: [],
    trigger: '写入数据库前(归档周期或销毁写库)',
    anchors: [
      'kbe/src/server/baseapp/entity.cpp:1405; kbe/src/server/cellapp/entity.cpp:1262(src/hooks.ts)',
    ],
  },

  // ==================== client-link (Proxy) ====================
  onClientEnabled: {
    phase: 'client-link',
    side: 'proxy',
    before: [],
    after: [],
    trigger: '客户端就绪(登入完成后可交互)',
    anchors: ['kbe/src/server/baseapp/proxy.cpp:178(src/hooks.ts)'],
  },
  onClientDeath: {
    phase: 'client-link',
    side: 'both',
    before: [],
    after: ['onLogOnAttempt'],
    trigger: '客户端断开(连接死;实体不一定销毁,等重连或超时)',
    anchors: [
      'kbe/src/server/baseapp/entity.cpp:1048; kbe/src/server/baseapp/proxy.cpp:237(src/hooks.ts)',
    ],
  },
  onLogOnAttempt: {
    phase: 'client-link',
    side: 'proxy',
    before: ['onClientDeath'],
    after: [],
    trigger: '重复登录尝试被转发到已存在实体(在此仲裁踢旧/拒新)',
    anchors: [
      'kbe/src/server/baseapp/proxy.cpp:189; kbe/src/server/baseapp/proxy.cpp:205(src/hooks.ts)',
    ],
  },
  onClientGetCell: {
    phase: 'client-link',
    side: 'proxy',
    before: ['onGetCell'],
    after: [],
    trigger: '客户端即将被交给 cell 实体(视野接管前)',
    anchors: ['kbe/src/server/baseapp/proxy.cpp:248(src/hooks.ts)'],
  },
  onStreamComplete: {
    phase: 'client-link',
    side: 'proxy',
    before: [],
    after: [],
    trigger: '数据流(文件/字符串)传输结束',
    anchors: ['kbe/src/server/baseapp/proxy.cpp:832(src/hooks.ts)'],
  },

  // ==================== cross-cutting / destruction ====================
  onTimer: {
    phase: 'cross-cutting',
    side: 'both',
    before: ['定时器-无强引用'],
    after: [],
    trigger: 'addTimer 注册的定时器到期(任何阶段可触发;销毁时全部取消)',
    anchors: [
      'kbe/src/server/cellapp/entity.cpp:4358; kbe/src/server/baseapp/entity.cpp:1662(src/hooks.ts)',
    ],
  },
  onDestroy: {
    phase: 'destruction',
    side: 'both',
    before: [],
    after: [],
    trigger: '实体销毁前(baseapp 与 cellapp 侧销毁都会触发;收尾清理定时器/保存)',
    anchors: [
      'kbe/src/server/baseapp/entity.cpp:169; kbe/src/server/cellapp/entity.cpp:211(src/hooks.ts)',
    ],
  },
};

/** 按钩子名取时序标注;未收录返回 undefined。 */
export function sequencingForHook(name: string): HookSequencing | undefined {
  return HOOK_SEQUENCING[name];
}

/**
 * 入口脚本 SPI 时序(src/backend/entryHooks.ts 3 条 cellapp 空间/导航件)。
 * 锚:entry-script-spi-methods.md 已固化——几何加载链
 * onSpaceGeometryLoaded → onAllSpaceGeometryLoaded(同一回调函数内先后),
 * onSpaceData 由 set/del 变更独立触发(与几何链无固定先后,不连边)。
 */
export const ENTRY_SPI_SEQUENCING: Record<string, { before: string[]; after: string[]; anchors: string[] }> = {
  onSpaceGeometryLoaded: {
    before: [],
    after: ['onAllSpaceGeometryLoaded'],
    anchors: [
      'kbe/src/server/cellapp/spacememory.cpp:308(src/backend/entryHooks.ts)',
      'docs/knowledge/entry-script-spi-methods.md(随后同一函数内会继续触发 onAllSpaceGeometryLoaded)',
    ],
  },
  onAllSpaceGeometryLoaded: {
    before: ['onSpaceGeometryLoaded'],
    after: [],
    anchors: ['kbe/src/server/cellapp/spacememory.cpp:336(src/backend/entryHooks.ts)'],
  },
  onSpaceData: {
    before: [],
    after: [],
    anchors: [
      'kbe/src/server/cellapp/spacememory.cpp:613; kbe/src/server/cellapp/spacememory.cpp:619(src/backend/entryHooks.ts)',
      'docs/knowledge/entry-script-spi-methods.md(set/del 路径独立触发;同一变更随后广播给空间内有 Witness 的实体)',
    ],
  },
};

/** KBENGINE_HOOKS 36 条是否全部有时序标注(收录完整性)。 */
export function coversAllKnownHooks(): boolean {
  return KBENGINE_HOOKS.every(hook => HOOK_SEQUENCING[hook.name] !== undefined);
}

/**
 * 渲染 hover 时序段(等宽箭头链)。
 * 入口 SPI(entryHooks.ts)与实体回调分属不同调用面,本表只管实体回调;
 * 入口 SPI 的七阶段见 docs/knowledge/entry-script-spi-methods.md Lifecycle。
 */
export function renderHookSequencingSection(name: string): string | null {
  const seq = HOOK_SEQUENCING[name];
  if (!seq) {
    return null;
  }
  const label = (key: string): string => TIMING_ANCHORS[key]?.label ?? key;
  const beforePart = seq.before.length > 0 ? seq.before.map(label).join(' → ') + ' → ' : '';
  const afterPart = seq.after.length > 0 ? ' → ' + seq.after.map(label).join(' / ') : '';
  const sideNote = seq.side === 'both' ? 'base/cell 双侧' : seq.side + ' 侧';
  const lines: string[] = [];
  lines.push('**时序**(阶段: ' + seq.phase + ', ' + sideNote + '):');
  lines.push('');
  lines.push('```');
  lines.push(beforePart + name + afterPart);
  lines.push('```');
  lines.push('');
  lines.push('触发: ' + seq.trigger);
  if (seq.anchors.length > 0) {
    lines.push('');
    lines.push(seq.anchors.map(a => '`' + a + '`').join('  \n'));
  }
  return lines.join('\n');
}

/** 渲染入口 SPI 时序段;未收录返回 null。 */
export function renderEntrySpiSequencingSection(name: string): string | null {
  const seq = ENTRY_SPI_SEQUENCING[name];
  if (!seq) {
    return null;
  }
  const beforePart = seq.before.length > 0 ? seq.before.join(' → ') + ' → ' : '';
  const afterPart = seq.after.length > 0 ? ' → ' + seq.after.join(' / ') : '';
  const lines: string[] = [];
  lines.push('**时序**(入口脚本 cellapp 空间/导航链):');
  lines.push('');
  lines.push('```');
  lines.push(beforePart + name + afterPart);
  lines.push('```');
  if (seq.anchors.length > 0) {
    lines.push('');
    lines.push(seq.anchors.map(a => '`' + a + '`').join('  \n'));
  }
  return lines.join('\n');
}

/**
 * def 属性 hover 时序注(HOOK-TIMING-001):
 * 属性注入时机(.def 默认/params 键先于脚本逻辑)与 cellData 路由语义。
 * 锚=TIMING_ANCHORS['def-属性注入']/['cellData-就位'],不区分 base/cell
 * 归属(归属判定是独立数据面,本注只给通用时机)。
 */
export function renderDefPropertyTimingNote(): string {
  const injection = TIMING_ANCHORS['def-属性注入'];
  const cellData = TIMING_ANCHORS['cellData-就位'];
  const lines: string[] = [];
  lines.push('---');
  lines.push('**注入时序**: 此属性由引擎在实体脚本逻辑运行前按 `.def` 注入——未指定键保持 `.def` 默认值,`createEntity*` 的 params dict 键可覆盖;cell 部分属性的值经 `cellData` 暂存,cell 实体创建时才生效。');
  lines.push('');
  lines.push(injection.anchors.map(a => '`' + a + '`').join('  \n'));
  lines.push('');
  lines.push(cellData.anchors.map(a => '`' + a + '`').join('  \n'));
  return lines.join('\n');
}
