# DEMO-GAME-002 验收证据:怪物 AI 状态机真引擎跑通(游走/仇恨/追击/近身攻击/脱战回巢 + 伤害)

- 日期:2026-11-07
- 环境:Linux 本机,引擎仓 `~/workspaces/kbengine-build`,数据库 `192.168.5.5:3306/kode_demo`
- 命令链:`KBE_ROOT=$HOME/workspaces/kbengine-build sh scripts/run-demo-engine.sh start` → sleep 35 → `bots` → sleep 75(+60 观察脱战回巢)
- 验收锚:同 001 的 `KBE_DEMO_EVIDENCE`→`evidence.log` 落文件链;AI 迁移/出手/伤害全部走锚

## 1. 状态迁移(全状态面,3 Monster 全员走完闭环)

```
Monster[2001] AI IDLE -> WANDER (pos=10.0,0.0,10.0)
Monster[2002] AI IDLE -> WANDER (pos=-10.0,0.0,10.0)
Monster[2003] AI IDLE -> WANDER (pos=0.0,0.0,-15.0)
Monster[2001] AI WANDER -> CHASE (pos=6.8,0.0,7.8)      # 游走进入 AGGRO_RANGE(12)拾到 Avatar
Monster[2003] AI WANDER -> CHASE (pos=-0.1,0.0,-11.1)
Monster[2001] AI CHASE -> ATTACK (pos=1.0,0.0,1.5)      # 追进攻击距离(2)
Monster[2003] AI CHASE -> ATTACK (pos=-0.3,0.0,-1.8)
Monster[2002] AI WANDER -> CHASE (pos=-8.5,0.0,7.9)
Monster[2002] AI CHASE -> ATTACK (pos=-1.2,0.0,1.3)
Monster[2003] AI ATTACK -> RETURN (pos=-0.3,0.0,-1.8)   # 目标死绝脱战回巢
Monster[2001] AI ATTACK -> RETURN (pos=1.0,0.0,1.5)
Monster[2002] AI ATTACK -> RETURN (pos=-1.2,0.0,1.3)
Monster[2001] AI RETURN -> IDLE (pos=9.7,0.0,9.7)       # 归巢(±10,10)/(0,-15)转 IDLE
Monster[2002] AI RETURN -> IDLE (pos=-9.8,0.0,9.8)
Monster[2003] AI RETURN -> IDLE (pos=0.0,0.0,-15.0)
```

## 2. 近身周期攻击与伤害

```
Monster[2001] ATTACK hit Avatar[13] dmg=10 targetHp=90
Avatar[13].receiveDamage dmg=10 attacker=2001 hp=90
...
Avatar[13] DIED (killer=2003)
```

本轮窗口统计:`ATTACK hit` 86 次、`receiveDamage` 86 次、`DIED` 10 次(10 个 bot Avatar 全部被打到 hp=0;随后 3 Monster 脱战回巢)。冷却由纯函数 `monster_ai.decide` 的 `since_attack >= ATTACK_PERIOD(2s)` 驱动。

## 3. 起服进程表(9 进程,同 001 口径)

machine/logger/interfaces/dbmgr/baseappmgr/cellappmgr/baseapp/cellapp/loginapp + bots,`cellapp.out` 全程 0 条 S_ERROR。

## 4. AI 决策纯函数测试绿

- `tests/kbengineDemoAi.test.ts`:①夹具内容契约(monster_ai.py 零 KBEngine import、常量面、Monster.py 决策/执行分离与锚点);②`spawnSync('python3')` 直跑 `monster_ai.decide` 全迁移表(IDLE/WANDER/CHASE/ATTACK/RETURN 各分支、leash 一票否决、攻击滞回 ATTACK_DROP_RANGE、冷却出手)、`choose_wander_point` 落点界、`dist`。

## 5. 本轮真引擎取证发现(逐项修掉)

1. `entitiesInRange` 是**实体方法**不是模块函数(`KBEngine.entitiesInRange` → AttributeError)→ 改 `self.entitiesInRange(radius, "Avatar")`(engine utype 精确匹配,entity_coordinate_node.cpp:237,Monster 继承 Avatar 不自相仇恨)。
2. 引擎移动控制器逐 tick 回调与 ROLE 接口方法**同名冲突**:接口声明 `onMove(position)`(1 参)与引擎回调 `onMove(controllerId, userData)`(2 参,entity.cpp:2936)不可共存;checkDefMethod(entitydef.cpp:1877)用 `inspect.getfullargspec` 校验参数个数必须与 def 一致 → ROLE.def/ROLE.py/cell 侧 onMove 统一双参 `(position, userData=None)`,一份签名兼容两路调用面。
3. Avatar.def `hp` 无 `<Default>` → 引擎默认 0,AI 活体过滤 `hp > 0` 把全部 Avatar 当尸体跳过 → 补 `<Default> 100 </Default>`(真机日志立现 CHASE/ATTACK)。

## 6. 边界说明(onDamaged 反击)

`Monster.onDamaged(attackerId)`(Monster.def CellMethods + cell/Monster.py 实现,受击立仇恨目标)已实现并有夹具内容测试锁;其真机触发面是「Avatar 攻击 Monster」,攻击入口(Avatar 侧 reqAttack/武器)属 DEMO-GAME-003 战斗件,002 验收口径(引擎日志可见状态迁移与伤害 + 纯函数测试绿)已全部满足,故本项不在本轮真机证据内,003 接入攻击面后自然闭环。
