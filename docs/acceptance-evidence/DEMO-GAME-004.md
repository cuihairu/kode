# DEMO-GAME-004 验收证据:bots 无头玩家完整玩法回路(登录→建角→走位→攻击→击杀→升级→死亡重生)

- 日期:2026-11-07
- 环境:Linux 本机,引擎仓 `~/workspaces/kbengine-build`,数据库 `192.168.5.5:3306/kode_demo`
- 命令链:`KBE_ROOT=$HOME/workspaces/kbengine-build sh scripts/run-demo-engine.sh start` → sleep 45 → `bots` → sleep 150
- 阵容:10 bots Avatar(出生 0,0,0)vs 8 Monster(刷怪表);bots 客户端零索敌面,入场/受击雷达由服务端推送、走位经 exposed `reqGoto` 服务端权威移动

## 0. Windows 真机复验(imac,同一回路从源码构建到跑通一局)

- 日期:2026-11-07;主机 imac(192.168.5.117,Windows,i9-10900K 20 线程);数据库同 `192.168.5.5:3306/kode_demo`
- 引擎:kbengine 仓 `855a06d` + 分支 `win-msvc-fix`(三处 Windows 构建修复,已推 GitHub cuihairu/kbengine),MSVC(VS 18 Enterprise,工具集 14.51)+ CMake Ninja + vcpkg 全量从源码构建,产物 9 服务端 exe + `bots`(420 target 全绿)
- 起服:`C:\tools\kbe-run.ps1`(夹具复制→kbengine.xml DB/网卡覆盖→schtasks 启 9 进程;SSH 直启会被 sshd 会话回收杀树,必须 schtask 落盘)+ `bots` 阶段;监听锚:loginapp 20013/baseapp 20015/machine 20099
- 引擎横幅(证据原文):`machine Version: 2.5.10. ScriptVersion: 0.1.0. Pythoncore: 3.12.13. Config: Release X64. Built: 10:57:26 Nov 7 2026`
- 阵容:10 bots Avatar vs 8 Monster;原始证据全文 `evidence/DEMO-GAME-004-imac-evidence.log`(380 行)
- 窗口统计:`Spaces created` 1、`space established` 1、`ENTERED WORLD` 19、`spawn done` 1、`radar ping nearest` 11、`onRadarPush client=set` 17、`radar push via base` 6、bots `target Monster` 15、`move toward` 11、cell `goto` 1、`arrived` 1、`reqAttack hit` 54、`KILLED by Avatar` 7、`LEVEL UP` 7、Avatar `DIED` 1、`RESPAWN` 1

完整生命周期样本(Avatar[16],证据原文,登录→雷达→走位→攻击→击杀升级→受击死亡→重生→再走位→再攻击):

```
Avatar[16] created, name=bot8 -> enterSpace(1)
Avatar[16].onClientEnabled: client handed over (giveClientTo done)
Avatar[16].onEnterSpace: ENTERED WORLD spaceID=1 pos=(0,0,0)
Avatar[16] radar ping nearest Monster[2001] dist=10.1          # 入场首推雷达
Avatar[16].onRadarPush attacker=2001 client=set                # 基座中继客户端可达
bots Avatar[16] target Monster[2001] radar=(9.2,4.2)
bots Avatar[16] move toward Monster[2001] from (0.0,0.0) dist=10.1
Avatar[16].reqAttack hit Monster[2001] dmg=15
Monster[2001] KILLED by Avatar[16] reward gold+=10 exp+=30
Avatar[16] LEVEL UP -> 1 (experience=30)                       # (随后再杀 2004 升 2 级)
Avatar[16].receiveDamage dmg=25 attacker=2006 hp=0
Avatar[16] DIED (killer=2006) -> respawn pending
Avatar[16] base respawn scheduled in 5.0s
Avatar[16] RESPAWN -> enterSpace(1) (fresh cell, full hp)
Avatar[16] radar ping nearest Monster[2008] dist=19.3          # 重入场雷达
bots Avatar[16] move toward Monster[2008] from (0.0,0.0) dist=19.3
Avatar[16] goto Monster[2008] (2.4,-19.1)                      # cell 收令:服务端权威走位
Avatar[16] arrived at (2.4,-19.1)                              # onMoveOver 到点
Avatar[16].reqAttack hit Monster[2008] dmg=15
```

### Windows 构建修复(三处,均在引擎仓 `win-msvc-fix` 分支)

1. `lib/helper/crashhandler.h`:`THREAD_HANDLE_CRASH` 宏的 wchar 缓冲传给 `wsprintf`/`MessageBox`,MSVC 未定义 UNICODE 时落窄版 `wsprintfA`/`MessageBoxA` 编译错(C2664)→ 显式 `wsprintfW`/`MessageBoxW`。
2. `lib/db_mysql/db_interface_mysql.cpp`:vcpkg libmariadb 3.4 默认校验服务器证书,自签证书 LAN MySQL 上 `mysql_errno=2026 certificate is NOT trusted` → `mysql_options(MYSQL_OPT_SSL_VERIFY_SERVER_CERT, 0)`(与 Linux libmysqlclient 默认不校验同面;libmariadb 3.4 无 `MYSQL_OPT_SSL_MODE`,勿用)。
3. `kbe/src/CMakeLists.txt`:`add_compile_definitions(PY_SSIZE_T_CLEAN)`——代码用 `"s#"/"u#"` PyArg 格式且变量已按 `Py_ssize_t` 声明,但宏从未定义;Python 3.12 下运行期 `SystemError("PY_SSIZE_T_CLEAN macro must be defined for '#' formats")` 全进程启动后即死。

### Windows 侧流程坑(复现必读)

- SSH 会话直启引擎进程:Win32-OpenSSH 会话关闭时回收整棵进程树(`-NoNewWindow` 与 `-WindowStyle Hidden` 皆如此)——启动/喂 bots 必须走 `schtasks /run` 落盘任务,SSH 只做观测。
- 独立探针实例残留会占 20086/20099 端口、锁运行目录,后续批量起服全灭;起服脚本须先 taskkill 全部引擎映像再重建运行目录。
- vcpkg 清单构建(x64-windows)产物 DLL(python312/libmariadb/openssl 等)需拷到 `kbe/bin/server/`;stdlib 部署按 `SCRIPT_PATH`(pyscript/script.h)布局:`Lib/`、`DLLs/` 落 `kbe/res/scripts/common/` 下。
- 多网卡机器上 machine 绑 UDP 首个适配器(Clash TUN 198.18.0.1),组件 external addr 可能落虚拟适配器;同机全栈(引擎+bots 同进程组)不受影响,跨机部署前需先把 internalInterface 适配器名对齐。

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
