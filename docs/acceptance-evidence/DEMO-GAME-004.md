# DEMO-GAME-004 验收证据:bots 无头玩家完整玩法回路(登录→建角→走位→攻击→击杀→升级→死亡重生)

- 日期:2026-11-07
- 环境:Linux 本机,引擎仓 `~/workspaces/kbengine-build`,数据库 `192.168.5.5:3306/kode_demo`
- 命令链:`KBE_ROOT=$HOME/workspaces/kbengine-build sh scripts/run-demo-engine.sh start` → sleep 45 → `bots` → sleep 150
- 阵容:10 bots Avatar(出生 0,0,0)vs 8 Monster(刷怪表);bots 客户端零索敌面,入场/受击雷达由服务端推送、走位经 exposed `reqGoto` 服务端权威移动

## 1. 完整回路样本(Avatar[2013] 一个生命周期,证据原文)

```
Avatar[2013] created, name=bot2007 -> enterSpace(1)          # 登录→建角→进空间
Avatar[2013].onClientEnabled: client handed over (giveClientTo done)
Avatar[2013].onEnterSpace: ENTERED WORLD spaceID=1 pos=(0,0,0)
Avatar[2013] radar ping nearest Monster[2] dist=9.3           # 入场首推雷达(cell→base 中继)
Avatar[2013].onRadarPush attacker=2 client=set                # 基座客户端可达,推 onMonsterNear
bots Avatar[2013] target Monster[2] radar=(-6.1,7.0)          # 客户端锁定目标
bots Avatar[2013] move toward Monster[2] from (0.0,0.0) dist=9.3   # 发出 reqGoto(登录窗口被引擎丢弃,见 §3-5)
Avatar[2013].reqAttack hit Monster[5] dmg=15                  # 贴身反击(exposed cell 方法)
Avatar[2013] DIED (killer=4) -> respawn pending               # 被怪击杀
Avatar[2013] base respawn scheduled in 5.0s                   # 基座销 cell + 排计时(003 面复用)
Avatar[2013] RESPAWN -> enterSpace(1) (fresh cell, full hp)   # 重生
Avatar[2013] radar ping nearest Monster[1] dist=5.9           # 重入场雷达
bots Avatar[2013] target Monster[1] radar=(5.6,2.1)
bots Avatar[2013] move toward Monster[1] from (0.0,0.0) dist=5.9
Avatar[2013] goto Monster[1] (5.6,2.1)                        # cell 收令:服务端权威走位
Avatar[2013] arrived at (5.6,2.1)                             # onMoveOver 到点(engine entity.cpp:2948)
```

击杀/升级样本(同窗):`Monster[5] KILLED by Avatar[2014] reward gold+=10 exp+=30` → `Avatar[2014] LEVEL UP` → `bots Avatar[2014] onLevelUp level=1`(2014 亦完成 goto/arrived:`goto Monster[7] (-20.3,-2.5)` → `arrived at (-20.3,-2.5)`)。

## 2. 窗口统计(150s bots 窗口)

`radar ping nearest` 12、`onRadarPush ... client=set` 21、bots `target Monster` 19、`move toward` 12、cell `goto` 2、`arrived` 2、`reqAttack hit` 49、`KILLED by Avatar` 7、`LEVEL UP` 6、`DIED` 9、`RESPAWN` 6。

## 3. 本轮真引擎取证发现(逐项修掉/绕开)

1. **cell 侧 `self.client` 依赖 witness 链,bots 真机恒 None**(cellapp/entity.cpp `pyGetClientEntityCall`):cell→client 直推死路 → 客户端推送改基座中继:`onRadarPush`(BaseMethods)→ `base.client.onMonsterNear`(giveClientTo 后必可达;onLevelUp 同路径佐证)。
2. **client_lib `moveToPoint` 的 0.1s ScriptCallbacks 计时器在 bots 进程不泵**(client_lib/entity.cpp:29 `pyMoveToPoint` 调用可受理,但调用后无 onMoveOver/onMoveFailure 回调)→ 客户端位移面死路,走位改服务端权威:exposed `reqGoto()` → cell `moveToPoint`(cellapp entity.cpp:2796,视图同步回推位置)。
3. **`entitiesInRange(radius, "Avatar")` 按 utype 族匹配,def `<Parent>` 继承使 Monster 同族命中**(真机:无 Avatar 在场时 8 怪自相残杀自尽)→ `_pickTarget` 补 className 敌我过滤;002 期"utype 精确匹配不会自相仇恨"的注释作废。
4. **怪物互杀触发击杀奖励面 AttributeError 吞掉 `destroy()`**(killer 是 Monster 时 `killer.bag.gold` 抛错)→ hp=0 尸体滞留 `KBEngine.entities`(雷达扫描 8/8 全 hp≤0)→ 击杀奖励加 Avatar className 闸 + `destroy()` 无条件执行。
5. **登录同步窗口内的 cell 面调用会被引擎丢弃**(真机:入场即发的 reqGoto 12 发仅 0 达;完整入场/重生后再发即达,goto 2/arrived 2 均来自重生后重发)→ bots 侧换目标即重置走位锁,下一推自动补发。

## 4. 修复面(夹具内,全部有测试契约)

- `cell/Avatar.py`:`reqRadarPing`(入场/重入场首推最近存活怪)+ `receiveDamage` 受击雷达(基座中继)+ `reqGoto`/`onMoveOver`/`onMoveFailure` 服务端走位组。
- `base/Avatar.py`:`onRadarPush` 基座中继(client 可达性真机证据 client=set)。
- `bots/Avatar.py`:雷达目标机(target/move toward/arrived 证据面)+ `reqGoto`/`reqAttack` 客户端入口;头部 4 点引擎取证注释。
- `entity_defs/Avatar.def`:ClientMethods `onMonsterNear`、BaseMethods `onRadarPush`、CellMethods `reqRadarPing`/`reqGoto(Exposed)`。
- `cell/Monster.py`:`_pickTarget` className 敌我过滤;`receiveDamage` 击杀者 Avatar 闸 + 无条件自毁。
- 契约:`tests/kbengineDemoCombat.test.ts` 雷达走位回路断言;`tests/pythonSymbolsParity.test.ts` 符号表随行号对账;6 件 golden 重生成。
