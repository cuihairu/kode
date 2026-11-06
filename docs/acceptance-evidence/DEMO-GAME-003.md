# DEMO-GAME-003 验收证据:无头完整一局(杀怪得金币经验/升级通知/可死亡重生)

- 日期:2026-11-07
- 环境:Linux 本机,引擎仓 `~/workspaces/kbengine-build`,数据库 `192.168.5.5:3306/kode_demo`
- 命令链:`KBE_ROOT=$HOME/workspaces/kbengine-build sh scripts/run-demo-engine.sh start` → sleep 35 → `bots` → sleep 150
- 阵容:10 bots Avatar(出生点 0,0,0)vs 8 Monster(刷怪表扩容,出生半径 14~20);Avatar 攻击 15 伤害/1.5s 冷却,Monster 25 伤害/2s 冷却(cell 自动战斗心跳拾射程内最近存活怪,bots 受击反击走 exposed `cell.reqAttack`)

## 1. 杀怪得金币经验(7 杀,奖励结算+升级+客户端通知全链)

```
Avatar[2021].reqAttack hit Monster[2] dmg=15
Monster[2].onDamaged attacker=Avatar[2021] -> counter-aggro     # 002 反击钩子真机闭环
Monster[2] KILLED by Avatar[2021] reward gold+=10 exp+=30       # 金币进 Inventory 组件
Avatar[2021] LEVEL UP -> 1 (experience=30)                      # 基座经验/升级结算
bots Avatar[2021] onLevelUp level=1                             # onLevelUp 通知客户端
Monster[1] KILLED by Avatar[2022] reward gold+=10 exp+=30
Avatar[2022] LEVEL UP -> 1 (experience=30)
bots Avatar[2022] onLevelUp level=1
Monster[4] KILLED by Avatar[2021] reward gold+=10 exp+=30
Avatar[2021] LEVEL UP -> 2 (experience=60)
bots Avatar[2021] onLevelUp level=2
...
```

窗口统计:`reqAttack hit` 49、`onDamaged` 49(反击仇恨全部触发)、`KILLED by Avatar` 7、`LEVEL UP` 7、bots `onLevelUp` 7。

## 2. 可死亡重生(完整一局含玩家倒地)

```
Monster[2004].onTimer ATTACK ... → Avatar[13].receiveDamage dmg=25 ... hp=0
Avatar[13] DIED (killer=2004) -> respawn pending
Avatar[13] base respawn scheduled in 5.0s        # 基座销 cell + 排计时
Avatar[13] RESPAWN -> enterSpace(1) (fresh cell, full hp)
Avatar[13].onEnterSpace: ENTERED WORLD spaceID=1 pos=Vector3(0.000000, 0.000000, 0.000000)
```

死亡→基座销 cell→5s 计时→回出生点(0,0,0)满血重建 cell,闭环走通(Monster 侧死亡则走 `KILLED by` 奖励结算后自毁,死亡锚按 className 区分:`Monster[2001] DIED (killer=22)` vs `Avatar[13] DIED`)。

## 3. 进程与错误面

9 进程 + bots;`cellapp.out`/`baseapp.out`/`bots.out` 全程 **0 条 S_ERROR**。

## 4. 本轮真引擎取证发现(逐项修掉)

1. `destroyCellEntity` 是**基座面 API**:cellapp 侧 Proxy 的 cell 半身脚本无此方法(AttributeError)→ 死亡只上报 `base.onAvatarDead()`,由基座 `destroyCellEntity()` + `addTimer` 重生。
2. 复活时序坑:`createCellEntity: N has a cell!` ——旧 cell 未销就重建即断言失败,先销后计时天然规避。
3. **bots 进程客户端实体无脚本计时器面**(bots.out `assertion failed: g_pApp ... at: addTimer`)→ bots 攻击改受击反击(onHPChanged → 射程内最近 Monster 回击);无头战斗主循环由 cell 侧 Avatar 自动战斗心跳(1.5s)驱动,reqAttack 保持 Exposed 供真实客户端调用。
4. **Monster(纯 cell 实体)继承 Avatar.receiveDamage 的死亡分支**,`self.base` 为 None 即 AttributeError 且吞掉击杀奖励 → 死亡分支 `getattr(self, "base", None)` 守卫,Monster 的死亡奖励/自毁在其 receiveDamage 覆写内完成。
5. 经验/等级放基座持有(BASE_AND_CLIENT):cell 死亡销毁后经验不丢;金币在 Inventory 组件(CELL_PUBLIC/Persistent)cell 侧结算。

## 5. 门禁

vitest 580 文件(新增 tests/kbengineDemoCombat.test.ts 内容契约)/tsc 0;golden 随 def 变更(Avatar.def experience/reqAttack/cellAddExperience/onAvatarDead/onLevelUp)全部再生成。
