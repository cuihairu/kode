# 实体回调时序总图

本图的机读数据核是 `src/backend/hookSequencing.ts`(`HOOK_SEQUENCING`,
`src/hooks.ts` 每条回调一项,外加语料佐证但未收录的 `onLoseCell`)。本文
所有引擎 `file:line` 均逐字取自 `src/hooks.ts` 的 `sourceLocation` 或
[实体生命周期与引用释放](../../knowledge/entity-lifecycle-reference.md)、
[Baseapp 模块面 API 参考](../../knowledge/api-baseapp.md) §2、
[共享概念](../../knowledge/api-core-concepts.md) §3 中已固化的锚,不新造锚。

悬停面(钩子 hover、`self.<def 属性>` hover)渲染同一份紧凑时序段;本页
是全图。

## 创建与 def 属性注入(阶段: creation)

```
createEntity* / createEntityLocally        api-baseapp.md §2
  → def 属性注入                           params dict 键覆盖 .def 默认;
  → cellData 就位                          cell 属性键路由进 cellData,
                                            cell 实体创建时才生效
    (未指定键保持 .def 默认)
```

def 属性在**任何脚本逻辑运行之前**就位——引擎在实体构造时注入 `.def`
默认值与 `params` 覆盖;cell 部分的值暂存在 `cellData`
(`api-core-concepts.md` §3,cellData keeps the would-be cell attributes)。

## cell 挂载链(阶段: cell-attach)

```
base 侧 (baseapp/entity.cpp,entity-lifecycle-reference.md Cell state table):
  createCellEntity / createCellEntityInNewSpace / restoreCell (异步请求)
    ├── onGetCell              :1032  — cell 落地;cellData 属性即刻删除(:1024)
    │     ├── onLoseCell       :1059,1065 — cell 释放(S_RELEASE),base 仍活;
    │     │     cellData 永不复活(保持已删除)
    │     └── onClientGetCell  proxy.cpp:248 — 客户端即将被交给 cell 实体
    └── onCreateCellFailure    :884   — 分支端,无 cell

cell 侧 (cellapp/entity.cpp):
  onEnteringCell :3847 → onEnteredCell :3839     (进入:前 → 后)
  onLeavingCell  :3855 → onLeftCell   :3863     (离开:前 → 后)
```

## 空间(阶段: space)

```
onEnterSpace  cellapp/entity.cpp:3823   cell 实体进入 space 之后
onLeaveSpace  cellapp/entity.cpp:3831   离开之前
onSpaceGone   cellapp/entity.cpp:387    space 本身被销毁
                                      (与 onLeaveSpace 不同源)
```

## 视野与观察(阶段: witness-view)

```
onGetWitness :2180 → onUpdateBegin ⇄ onUpdateEnd (每轮同步) → onLoseWitness :2218
                     witness.cpp:753 / :899
onWitnessed      :1486,1531   被观察状态翻转
onEnteredView    :1786        实体进入某 witness 视野
onLoseControlledBy :1513      被控制权绑定解除
```

## 移动与传送(阶段: movement, teleport)

```
onMove :2946 → onMoveOver :2964 | onMoveFailure :2982    (分支端)
onTurn :3098

onTeleport :3786 → onTeleportSuccess :3814 | onTeleportFailure :1558/3797
                    ↑ 目标 space/位置已就位;cellapp 侧附带附近实体
                      (可能为 None),baseapp 侧流程收尾无参调用
```

## 陷阱(阶段: trap)

```
onEnterTrap :1759 → onLeaveTrap :1768 | onLeaveTrapID :1777
                     (离开实体仍可用 | 实体已不可用,只给 ID)
```

## 持久化(阶段: persistence)

```
恢复 (baseapp 崩溃恢复):
  restore 流程 cell 先到 → onRestore :1083 (cellapp 侧 :3871)

归档周期:
  onPreArchive :1298 → onWriteToDB :1405 (base) / :1262 (cell)
```

## 客户端连接、定时器、销毁(阶段: client-link, cross-cutting, destruction)

```
onClientEnabled proxy.cpp:178
onClientDeath   entity.cpp:1048 / proxy.cpp:237 → onLogOnAttempt proxy.cpp:189,205
onStreamComplete proxy.cpp:832

onTimer   cellapp:4358 / baseapp:1662   任何阶段可触发;addTimer 不持强引用,
                                        销毁时全部取消
onDestroy baseapp:169 / cellapp:211     销毁前收尾,base/cell 双侧
```

## 入口脚本 SPI(kbemain,模块级)

见[入口脚本 SPI 方法](../../knowledge/entry-script-spi-methods.md)(七阶段
P0..P7)。cellapp 空间/导航链:`onSpaceGeometryLoaded → onAllSpaceGeometryLoaded`;
`onSpaceData` 由 set/del 独立触发。

下一篇: [实体生命周期与引用释放](../../knowledge/entity-lifecycle-reference.md) ·
[共享概念](../../knowledge/api-core-concepts.md)
