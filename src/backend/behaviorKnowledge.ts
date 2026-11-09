/**
 * C-23 交付①:KB-001 知识条目结构化(坑→lint/code action/hover 流水线的
 * 单一事实源)。每条知识带 appliesTo(适用属性类型/API)/detection(可静态
 * 检测的代码模式;detection 非空的条目自动成为 lint 规则候选)/fix(正确
 * 姿势);中英双语文案供 hover 注记(交付③)按「双语」口径一次渲染。
 *
 * 条目与 docs/knowledge/traps-index.md(en)/docs/zh/knowledge/traps-index.md
 * (zh)的数据行一一对应(trapZh/trapEn 即表格 Trap 列原文),tests/
 * behaviorKnowledge.test.ts 逐行锁步——本模块加条目必须同笔改两树索引页,
 * 反之亦然;索引页永不引入本模块没有的论断(KB-001 桶④纪律的机器可读面)。
 *
 * detection 非空 ⟺ 存在静态检测面(src/behaviorLints.ts 按稳定 code 对账);
 * 检测语义一律以 KB 文章 grounding 为准,与知识冲突的形态绝不报(零误导)。
 */

/** 静态检测描述:detection 非空的条目自动成为 lint 规则候选 */
export interface BehaviorDetection {
  /** 诊断稳定 code(与 behaviorLints.ts 常量同源,测试对账) */
  code: string;
}

/** 结构化行为知识条目(KB-001 陷阱索引行的机器可读形态) */
export interface BehaviorKnowledgeEntry {
  /** 稳定 id(kebab-case;测试与诊断消息引用) */
  id: string;
  /** 索引页 Trap 列原文(zh 树;锁步对账面) */
  trapZh: string;
  /** 索引页 Trap 列原文(en 树;锁步对账面) */
  trapEn: string;
  /** 适用面:属性类型/API/回调名(中文描述) */
  appliesToZh: string;
  appliesToEn: string;
  /** hover 注记可挂靠的词法符号(方法/属性名;空=不按词挂靠) */
  symbols: readonly string[];
  /** 现象(中文)=hover 注记正文 */
  symptomZh: string;
  symptomEn: string;
  /** 正确姿势(中文)=hover 注记修复段 */
  fixZh: string;
  fixEn: string;
  /** 静态检测面;null=该条不可静态检测(只有 hover/文档通道) */
  detection: BehaviorDetection | null;
  /** 依据:引擎源码锚点或 KB 文章引用 */
  sources: readonly string[];
}

/** C-23 交付②三条规则的稳定诊断 code(behaviorLints.ts 同源对账) */
export const FIXED_DICT_NESTED_MUTATION_CODE = 'kbengine.fixedDictNestedMutation';
export const DESTROYED_ENTITY_REFERENCE_CODE = 'kbengine.destroyedEntityReference';
export const TIMER_LEAK_ON_DESTROY_CODE = 'kbengine.timerLeakOnDestroy';

export const BEHAVIOR_KNOWLEDGE_ENTRIES: readonly BehaviorKnowledgeEntry[] = [
  {
    id: 'destroyed-entity-held',
    trapZh: '闭包/列表持有已销毁实体',
    trapEn: 'Holding a destroyed entity in a closure/list',
    appliesToZh: '实体引用存入模块级容器/闭包',
    appliesToEn: 'Entity references stored into module-level containers/closures',
    symbols: [],
    symptomZh: '`garbages` 不清空;3600 秒后引擎记泄漏警告',
    symptomEn: '`garbages` is not emptied; after 3600 s the engine logs a leak warning',
    fixZh: '在 `onDestroy` 清引用;用 `KBEngine.entities.garbages.items()` 定位持有者',
    fixEn: 'Drop references in `onDestroy`; query `KBEngine.entities.garbages.items()` to find holders',
    detection: { code: DESTROYED_ENTITY_REFERENCE_CODE },
    sources: ['entity-lifecycle-reference.md §注册表/Registry']
  },
  {
    id: 'destroy-during-init',
    trapZh: '`__init__` 期间 `destroy()`',
    trapEn: '`destroy()` during `__init__`',
    appliesToZh: '实体 destroy 调用时序',
    appliesToEn: 'Entity destroy call timing',
    symbols: [],
    symptomZh: 'AssertionError "initing, reject the request"',
    symptomEn: 'AssertionError "initing, reject the request"',
    fixZh: '销毁推迟到初始化之后',
    fixEn: 'Defer destruction to after init',
    detection: null,
    sources: ['entity-lifecycle-reference.md §守卫/Guards']
  },
  {
    id: 'method-call-on-destroyed',
    trapZh: '对已销毁实体调方法(本地)',
    trapEn: 'Method call on a destroyed entity (local)',
    appliesToZh: '本地实体引用的方法调用',
    appliesToEn: 'Method calls on local entity references',
    symbols: ['isDestroyed'],
    symptomZh: 'AssertionError "is destroyed"',
    symptomEn: 'AssertionError "is destroyed"',
    fixZh: '先查 `entity.isDestroyed`',
    fixEn: 'Guard with `entity.isDestroyed`',
    detection: null,
    sources: ['entity-lifecycle-reference.md §守卫/Guards']
  },
  {
    id: 'remote-call-to-destroyed',
    trapZh: '远程调用发往已销毁实体',
    trapEn: 'Remote call targeting a destroyed entity',
    appliesToZh: 'EntityCall 远程方法调用',
    appliesToEn: 'EntityCall remote method calls',
    symbols: [],
    symptomZh: '调用方无异常——接收端记 `ERROR_MSG`/`WARNING_MSG`,消息丢弃',
    symptomEn: 'No exception at the caller — a logged `ERROR_MSG`/`WARNING_MSG` at the receiver, message dropped',
    fixZh: '远程调用按尽力而为对待;重要结果走回调确认',
    fixEn: 'Treat remote fire-and-forget as best-effort; confirm via callback if it matters',
    detection: null,
    sources: ['entity-lifecycle-reference.md §守卫/Guards', 'entity-migration-and-cross-process-references.md §规则/Rules']
  },
  {
    id: 'functor-worry',
    trapZh: '担心 BigWorld 式「Functor」引用泄漏',
    trapEn: 'Worrying about BigWorld-style "Functor" reference leaks',
    appliesToZh: '引擎侧异步回调持有机制',
    appliesToEn: 'Engine-side async callback holding mechanism',
    symbols: [],
    symptomZh: 'KBEngine 无 `Functor` 类;异步回调持有者是 `PY_CALLBACKMGR`——每条未决回调一个强引用,应答/超时/终结即释放',
    symptomEn: 'No `Functor` class exists in KBEngine; the async-callback holder is `PY_CALLBACKMGR` — one strong ref per pending callback, released on answer/timeout/finalise',
    fixZh: '未决回调活不过超时,也保活不了已销毁实体',
    fixEn: 'Pending callbacks cannot outlive the timeout nor keep a destroyed entity alive',
    detection: null,
    sources: ['entity-lifecycle-reference.md §Functor']
  },
  {
    id: 'ghost-teleport',
    trapZh: 'ghost 不能 `teleport`',
    trapEn: 'Ghost cannot `teleport`',
    appliesToZh: 'cell 面 teleport 调用',
    appliesToEn: 'cell-side teleport calls',
    symbols: ['teleport'],
    symptomZh: 'AssertionError "not is real entity"',
    symptomEn: 'AssertionError "not is real entity"',
    fixZh: '从 real 实体发起传送',
    fixEn: 'Teleport from the real entity',
    detection: null,
    sources: ['entity-migration-and-cross-process-references.md §teleport']
  },
  {
    id: 'trap-micro-jump',
    trapZh: 'trap 内微跳',
    trapEn: 'Micro-jump inside a trap',
    appliesToZh: 'trap 区域内的传送/瞬移',
    appliesToEn: 'Teleports/micro-jumps inside a trap area',
    symbols: ['onEnterTrap', 'onLeaveTrap'],
    symptomZh: 'trap 离开**和**进入回调都触发(teleport 一律按瞬移处理)',
    symptomEn: 'Trap leave **and** enter callbacks both fire (teleport counts as instant move)',
    fixZh: '任何传送都预期两个回调,与距离无关',
    fixEn: 'Expect both callbacks on any teleport, regardless of distance',
    detection: null,
    sources: ['entity-migration-and-cross-process-references.md §teleport']
  },
  {
    id: 'teleport-wrong-ref',
    trapZh: '`teleport` 传错引用类型(如 base EntityCall)',
    trapEn: 'Wrong ref type to `teleport` (e.g. a base EntityCall)',
    appliesToZh: 'teleport 目标引用参数',
    appliesToEn: 'teleport target reference argument',
    symbols: ['teleport'],
    symptomZh: '`onTeleportFailure`',
    symptomEn: '`onTeleportFailure`',
    fixZh: '传 **cell-real** 的 EntityCall(或实体本身 / None)',
    fixEn: 'Pass a **cell-real** EntityCall (or the entity itself / None)',
    detection: null,
    sources: ['entity-migration-and-cross-process-references.md §teleport']
  },
  {
    id: 'old-cell-ondestroy-after-teleport',
    trapZh: '以为跨 cellapp 传送后旧 cell 会跑 `onDestroy`',
    trapEn: 'Assuming old cell\'s `onDestroy` runs after cross-cellapp teleport',
    appliesToZh: '跨 cellapp 传送后的清理时机',
    appliesToEn: 'Cleanup timing after a cross-cellapp teleport',
    symbols: ['onTeleportSuccess', 'onTeleportFailure'],
    symptomZh: '永不触发——旧实体以 `callScript=false` 销毁;`onTeleportSuccess` 在**新** cell 触发,`onTeleportFailure` 在**旧** cell 恢复',
    symptomEn: 'It never fires — the old entity is destroyed with `callScript=false`; `onTeleportSuccess` fires on the **new** cell, `onTeleportFailure` restores the **old** one',
    fixZh: '按 space 的清理放 `onLeaveSpace`,不要押注 `onDestroy`',
    fixEn: 'Put per-space cleanup in `onLeaveSpace`, not `onDestroy`-assumptions',
    detection: null,
    sources: ['entity-migration-and-cross-process-references.md §收尾/Completion']
  },
  {
    id: 'stale-entitycall-copy',
    trapZh: '迁移后单独持有的 EntityCall 副本过期',
    trapEn: 'Stale separately-held EntityCall copy after migration',
    appliesToZh: '缓存的 EntityCall 句柄',
    appliesToEn: 'Cached EntityCall handles',
    symbols: [],
    symptomZh: '消息在旧 cellapp 被静默丢弃(`WARNING_MSG entityID ... not found`)',
    symptomEn: 'Message silently dropped at the old cellapp (`WARNING_MSG entityID ... not found`)',
    fixZh: '用时现读 `self.cell`/`self.base`,不缓存句柄',
    fixEn: 'Re-read `self.cell`/`self.base` at use time instead of caching the handle',
    detection: null,
    sources: ['entity-migration-and-cross-process-references.md §规则/Rules']
  },
  {
    id: 'celldata-while-cell-alive',
    trapZh: 'cell 存活期间读 `self.cellData`',
    trapEn: 'Reading `self.cellData` while the cell lives',
    appliesToZh: 'base 面 cellData 属性',
    appliesToEn: 'base-side cellData attribute',
    symbols: ['cellData'],
    symptomZh: 'AttributeError(属性已删;值本就是默认值或最后一次脏备份)',
    symptomEn: 'AttributeError (attribute is deleted; values are defaults or last dirty backup anyway)',
    fixZh: '走 `self.cell.<方法>` 调用;`cellData` 只当无 cell 期快照',
    fixEn: 'Use `self.cell.<method>` calls; treat `cellData` as a no-cell-era snapshot only',
    detection: null,
    sources: ['entity-migration-and-cross-process-references.md §cellData']
  },
  {
    id: 'deltimer-stale-id',
    trapZh: '`delTimer` 传过期 id 以为会报错',
    trapEn: '`delTimer` with a stale id expecting an error',
    appliesToZh: '实体/模块 delTimer 调用',
    appliesToEn: 'Entity/module delTimer calls',
    symbols: ['delTimer'],
    symptomZh: '静默返回 `-1`(fork);3.7 材料称会报错',
    symptomEn: 'Returns `-1` silently (fork); the 3.7 material claims an error',
    fixZh: '检查返回值',
    fixEn: 'Check the return value',
    detection: null,
    sources: ['api-cellapp.md §偏差表/deviations', 'entity_macro.h:1478-1482']
  },
  {
    id: 'cancel-timers-in-ondestroy-unnecessary',
    trapZh: '以为要在 `onDestroy` 里注销定时器',
    trapEn: 'Expecting to cancel timers in `onDestroy`',
    appliesToZh: '实体级 addTimer 的销毁语义',
    appliesToEn: 'Entity-level addTimer destroy semantics',
    symbols: ['addTimer'],
    symptomZh: '没必要——`destroy()` 全量取消(`scriptTimers_.cancelAll()`)',
    symptomEn: 'Unnecessary — `destroy()` cancels all timers (`scriptTimers_.cancelAll()`)',
    fixZh: '`delTimer` 只在存活期内提前取消时用',
    fixEn: 'Only `delTimer` matters for early cancel while alive',
    detection: null,
    sources: ['entity-lifecycle-reference.md §定时器/Timers', 'cellapp/entity.cpp:4002']
  },
  {
    id: 'cancelcontroller-string',
    trapZh: '`cancelController("SomeType")`',
    trapEn: '`cancelController("SomeType")`',
    appliesToZh: 'cell 面 cancelController 参数',
    appliesToEn: 'cell-side cancelController argument',
    symbols: ['cancelController'],
    symptomZh: 'TypeError——只认精确字符串 `"Movement"`',
    symptomEn: 'TypeError — only the exact string `"Movement"` is accepted',
    fixZh: '其他控制器按句柄取消',
    fixEn: 'Cancel by handle for other controllers',
    detection: null,
    sources: ['api-cellapp.md §偏差表/deviations']
  },
  {
    id: 'trackentity-turntoyaw-missing',
    trapZh: '调 `trackEntity` / `turnToYaw`',
    trapEn: 'Calling `trackEntity` / `turnToYaw`',
    appliesToZh: 'cell 面移动/转向 API',
    appliesToEn: 'cell-side movement/turn APIs',
    symbols: ['trackEntity', 'turnToYaw'],
    symptomZh: 'fork 里没有这两个方法',
    symptomEn: 'No such methods in the fork',
    fixZh: '用 `moveToEntity` / `addYawRotator`',
    fixEn: 'Use `moveToEntity` / `addYawRotator`',
    detection: null,
    sources: ['api-cellapp.md §偏差表/deviations']
  },
  {
    id: 'entitycall-engine-method',
    trapZh: '经 EntityCall 调引擎方法',
    trapEn: 'Calling an engine method through an EntityCall',
    appliesToZh: 'EntityCall 可达面',
    appliesToEn: 'EntityCall reachability',
    symbols: [],
    symptomZh: '不可达——EntityCall 只能调 `.def` 文件声明的方法',
    symptomEn: 'Not reachable — an EntityCall only invokes methods declared in the `.def` file',
    fixZh: '方法进 def,或引擎 API 用本地实体引用调',
    fixEn: 'Declare the method in def, or use a local entity reference for engine APIs',
    detection: null,
    sources: ['api-core-concepts.md §1.1']
  },
  {
    id: 'project-onxxx-not-engine',
    trapZh: '项目自定义 `onXxx` 被当成引擎回调',
    trapEn: 'Project-defined `onXxx` handlers mistaken for engine callbacks',
    appliesToZh: 'onXxx 命名回调认定',
    appliesToEn: 'onXxx-named callback attribution',
    symbols: [],
    symptomZh: '真实树中约 1/3 的 `def onXxx` 是项目约定,引擎从不调用',
    symptomEn: '~1/3 of `def onXxx` definitions in real trees are project conventions; the engine never calls them',
    fixZh: '先对照回调表再认定名字是引擎调用',
    fixEn: 'Check the callback tables before assuming a name is engine-called',
    detection: null,
    sources: ['api-usage-stats.md', 'entry-script-spi-methods.md']
  },
  {
    id: 'onreadyforlogin-return',
    trapZh: '`onReadyForLogin` 返回值语义',
    trapEn: '`onReadyForLogin` return-value semantics',
    appliesToZh: 'loginapp onReadyForLogin 回调',
    appliesToEn: 'loginapp onReadyForLogin callback',
    symbols: ['onReadyForLogin'],
    symptomZh: '不是「≥ 1.0 即就绪」——`True` 即就绪;浮点到 `>= 0.9999` 完成;无回调则立即完成',
    symptomEn: 'Not "≥ 1.0 means ready" — `True` → ready; float completes at `>= 0.9999`; no callback → immediately complete',
    fixZh: '按 fork 语义返回 `True`/浮点进度',
    fixEn: 'Return a `True`/float progress per the fork semantics',
    detection: null,
    sources: ['api-cellapp.md §偏差表/deviations']
  },
  {
    id: 'embedded-client-ondestroy',
    trapZh: '期望内嵌客户端触发 `onDestroy`',
    trapEn: 'Expecting `onDestroy` on the embedded client',
    appliesToZh: '内嵌 client/bots 实体销毁回调',
    appliesToEn: 'Embedded client/bots entity destroy callback',
    symbols: [],
    symptomZh: '永不分发(C++ 覆写为空;远程销毁 `callScript=false`)',
    symptomEn: 'Never dispatched (empty C++ override, `callScript=false` on remote destroy)',
    fixZh: '客户端侧清理放别处',
    fixEn: 'Handle client-side cleanup elsewhere',
    detection: null,
    sources: ['api-client.md §偏差表/deviations']
  },
  {
    id: 'kbengine-login-client-functions',
    trapZh: '把 `KBEngine.login/createAccount/...` 当客户端 Python 函数',
    trapEn: '`KBEngine.login/createAccount/...` as client Python functions',
    appliesToZh: '客户端 KBEngine 模块面',
    appliesToEn: 'Client-side KBEngine module surface',
    symbols: [],
    symptomZh: '`kbe/src` 任何 Python 面都未注册(插件层,本仓库之外)',
    symptomEn: 'Not registered on any Python surface in `kbe/src` (plugin-layer, outside this repo)',
    fixZh: '用插件 SDK 的函数,不是引擎模块',
    fixEn: 'Use the plugin SDK\'s functions, not the engine module',
    detection: null,
    sources: ['api-client.md §偏差表/deviations']
  },
  {
    id: 'kbengine-findentity',
    trapZh: '`KBEngine.findEntity(id)`',
    trapEn: '`KBEngine.findEntity(id)`',
    appliesToZh: '客户端实体查找',
    appliesToEn: 'Client-side entity lookup',
    symbols: ['findEntity'],
    symptomZh: '无此注册',
    symptomEn: 'No such registration',
    fixZh: '`KBEngine.entities[entityID]`',
    fixEn: '`KBEngine.entities[entityID]`',
    detection: null,
    sources: ['api-client.md §偏差表/deviations']
  },
  {
    id: 'chm-python2-examples',
    trapZh: '照抄 3.7 CHM 示例',
    trapEn: 'Copying examples from the 3.7 CHM',
    appliesToZh: '3.7 官方材料示例代码',
    appliesToEn: '3.7 official-material example code',
    symbols: [],
    symptomZh: 'Python 2 语法(`print "..."`)在 3.12 跑不起来',
    symptomEn: 'Python 2 syntax (`print "..."`) does not run on 3.12',
    fixZh: '示例重写;材料表格当线索,fork 源码当事实',
    fixEn: 'Rewrite snippets; treat material tables as leads, the fork source as truth',
    detection: null,
    sources: ['api-cellapp.md §偏差表/deviations']
  },
  {
    id: 'fixed-dict-nested-mutation',
    trapZh: 'FIXED_DICT 属性子键赋值不同步',
    trapEn: 'FIXED_DICT sub-key assignment does not sync',
    appliesToZh: 'FIXED_DICT 类型 def 属性',
    appliesToEn: 'FIXED_DICT-typed def properties',
    symbols: [],
    symptomZh: '`self.<FIXED_DICT属性>[子键] = 值` 只改本地 pyDict_,引擎无通知面,不触发属性同步(客户端/其他侧看不到)',
    symptomEn: '`self.<FIXED_DICT property>[subKey] = value` only mutates the local pyDict_; the engine has no notification hook there, so the property never syncs',
    fixZh: '整体重赋习语:`d = self.<属性>` → 改子键 → `self.<属性> = d`(顶层赋值才走同步)',
    fixEn: 'Whole-reassign idiom: `d = self.<prop>` → mutate sub-key → `self.<prop> = d` (only top-level assignment syncs)',
    detection: { code: FIXED_DICT_NESTED_MUTATION_CODE },
    sources: ['fixeddict.cpp:272-308 mp_ass_subscript(仅 PyDict_SetItem 本地字典,无 owner 通知)', 'api-core-concepts.md §1.5']
  },
  {
    id: 'kbengine-module-timer-leak',
    trapZh: '模块级 `KBEngine.addTimer` 自绑定回调泄漏',
    trapEn: 'Module-level `KBEngine.addTimer` with a self-bound callback leaks',
    appliesToZh: '模块级 KBEngine.addTimer(interval, repeat, callback)',
    appliesToEn: 'Module-level KBEngine.addTimer(interval, repeat, callback)',
    symbols: ['addTimer'],
    symptomZh: 'app 级 timer 强持回调对象(`self.onTick` 即强持实体),实体 `destroy()` 只取消实体自身 scriptTimers_,**不会**取消它——回调持续触发/实体进 garbages 泄漏',
    symptomEn: 'The app-level timer holds a strong reference to the callback object (`self.onTick` strongly refs the entity); entity `destroy()` cancels only the entity\'s own scriptTimers_, never this one — the callback keeps firing / the entity leaks into garbages',
    fixZh: '句柄存成员,`onDestroy` 里 `KBEngine.delTimer(句柄)`(实体级 `self.addTimer` 无此问题,destroy 自动全量取消)',
    fixEn: 'Store the handle and call `KBEngine.delTimer(handle)` in `onDestroy` (entity-level `self.addTimer` is safe — destroy auto-cancels all)',
    detection: { code: TIMER_LEAK_ON_DESTROY_CODE },
    sources: ['python_app.cpp:721-748 __py_addTimer(ScriptTimerHandler 强持 pyCallback)', 'cellapp/entity.cpp:4002(destroy 仅 scriptTimers_.cancelAll)', 'entity-lifecycle-reference.md §定时器/Timers']
  }
];

/** detection 非空的条目(detection 非空自动成为 lint 规则候选) */
export const DETECTABLE_BEHAVIOR_ENTRIES: readonly BehaviorKnowledgeEntry[] =
  BEHAVIOR_KNOWLEDGE_ENTRIES.filter(entry => entry.detection !== null);

/** 检测 code → 条目(behaviorLints 消息文案按此取,单一事实源) */
export function behaviorEntryByCode(code: string): BehaviorKnowledgeEntry | undefined {
  return BEHAVIOR_KNOWLEDGE_ENTRIES.find(entry => entry.detection?.code === code);
}

/** 词法符号 → 注记条目(一个符号可挂多条,如 addTimer 挂两条:实体级安全/模块级泄漏) */
export function behaviorEntriesForSymbol(word: string): readonly BehaviorKnowledgeEntry[] {
  return BEHAVIOR_KNOWLEDGE_ENTRIES.filter(entry => entry.symbols.includes(word));
}

/**
 * hover 行为注记段(C-23 交付③,双语):中英并排一次渲染,与环境语言无关
 * (验收口径「hover 注记双语」)。挂在既有 hover 尾部(`---` 分隔)。
 */
export function behaviorNoteMarkdown(entry: BehaviorKnowledgeEntry): string {
  return `\n\n---\n\n⚠ 行为注记:${entry.symptomZh}\n\nBehavior note: ${entry.symptomEn}`
    + `\n\n正确姿势: ${entry.fixZh}\n\nCorrect pattern: ${entry.fixEn}`
    + `\n\n依据/Evidence: ${entry.sources.join('; ')}`;
}

/** FIXED_DICT 属性 hover 注记(自属性 defTypeName===FIXED_DICT 时挂) */
export function fixedDictBehaviorNoteMarkdown(): string {
  const entry = behaviorEntryByCode(FIXED_DICT_NESTED_MUTATION_CODE);
  return entry ? behaviorNoteMarkdown(entry) : '';
}

/** 多条注记合并(同符号多条按序拼接) */
export function behaviorNotesMarkdown(entries: readonly BehaviorKnowledgeEntry[]): string {
  return entries.map(behaviorNoteMarkdown).join('');
}

