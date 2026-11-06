# DEMO-GAME-001 验收证据:真引擎起服/刷怪/bots 进世界/MySQL 建表

- 日期:2026-11-07
- 环境:Linux 本机,引擎仓 `~/workspaces/kbengine-build`(已构建二进制),数据库 `192.168.5.5:3306/kode_demo`
- 命令链:`KBE_ROOT=$HOME/workspaces/kbengine-build sh scripts/run-demo-engine.sh start` → sleep 35 → `... run-demo-engine.sh bots` → sleep 30
- 验收锚落文件:脚本经 env `KBE_DEMO_EVIDENCE` 把 `[demo-evidence]` 锚行追加写入运行目录 `evidence.log`(引擎未编 log4cxx 时脚本层 INFO 只进 logger 转发面,stdout 看不到,故必须走落文件链;夹具锚点全部补齐 `evidenceLog()` 调用)

## 1. 起服进程表(9 进程)

`ps -eo pid,etime,args | grep kbengine-build/kbe/bin/server`(start 后 35s,值为本轮真机快照):

```
1204934 01:37 .../server/machine     --cid=2129652375332859700 --gus=1
1204937 01:37 .../server/logger      --cid=1129653375331859700 --gus=2
1204939 01:37 .../server/interfaces  --cid=1129652375332859700 --gus=3
1204940 01:37 .../server/dbmgr       --cid=3129652375332859700 --gus=4
1204943 01:37 .../server/baseappmgr  --cid=4129652375332859700 --gus=5
1204945 01:37 .../server/baseapp     --cid=6129652375332859700 --gus=7
1204946 01:37 .../server/cellappmgr  --cid=5129652375332859700 --gus=6
1204948 01:37 .../server/loginapp    --cid=8129652375332859700 --gus=9
1204949 01:37 .../server/cellapp     --cid=7129652375332859700 --gus=8
1209763 00:44 .../server/bots        (bots 阶段另起)
```

## 2. 刷怪(3 只 Monster 生成)

`evidence.log` 摘录(完整文件见下):

```
[demo-evidence] Spaces[2001] created (baseapp)
[demo-evidence] Space[2002].onGetCell: space established (index=1)
[demo-evidence] Avatar[1].onEnterSpace: ENTERED WORLD spaceID=1 pos=Vector3(10.000000, 0.000000, 10.000000), ref=true
[demo-evidence] Avatar[2].onEnterSpace: ENTERED WORLD spaceID=1 pos=Vector3(-10.000000, 0.000000, 10.000000), ref=true
[demo-evidence] Avatar[3].onEnterSpace: ENTERED WORLD spaceID=1 pos=Vector3(0.000000, 0.000000, -15.000000), ref=true
[demo-evidence] Space cell[2002] spawn done: [1, 2, 3] (spaceID=1)
```

三只 Monster 按出生点偏移 (10,0,10)/(-10,0,10)/(0,0,-15) 落地(Monster 脚本类继承 Avatar,锚行走 cell/Avatar.onEnterSpace)。

## 3. bots 登录建角进世界(10 bot 全回路)

`evidence.log` 摘录(以 bot2007 为例,其余 9 bot 同构):

```
[demo-evidence] bots Account[2007].onLoginOK: reqCreateAvatar
[demo-evidence] Account[2007].reqCreateAvatar: bot2007
[demo-evidence] Avatar[2013] created, name=bot2007 -> enterSpace(1)
[demo-evidence] Avatar[2013].onClientEnabled: client handed over (giveClientTo done)
[demo-evidence] Avatar[2013].onEnterSpace: ENTERED WORLD spaceID=1 pos=Vector3(0.000000, 0.000000, 0.000000), ref=true
...
[demo-evidence] bots Avatar[2013] client entity created (entity sync), pos=Vector3(0.000000, 0.000000, 0.000000), ref=true
```

本轮 10 个 bot(bot2003..bot2012)全部走完 登录→reqCreateAvatar→Avatar 建立→giveClientTo→onEnterSpace→client 实体同步(Avatar 2013..2022)。

## 4. MySQL 自动建表

`mysql --skip-ssl -h 192.168.5.5 -P 3306 -uroot -p*** -e "use kode_demo; show tables;"`:

```
kbe_accountinfos
kbe_email_verification
kbe_entitylog
kbe_serverlog
tbl_Account
tbl_Avatar
tbl_Avatar_bag
tbl_Avatar_bag_items
tbl_Avatar_skillSlots
tbl_Avatar_skillSlots_slot_list
tbl_EliteMonster
tbl_Inventory
tbl_Inventory_items
tbl_Monster
tbl_Monster_bag
tbl_Monster_bag_items
tbl_Monster_skillSlots
tbl_Monster_skillSlots_slot_list
tbl_Space
tbl_Spaces
tbl_TrainingAvatar
tbl_TrainingMonster
```

22 张表全部由 dbmgr 按实体 def 自动建出(库 kode_demo 运行前不存在业务表)。

## 附:本轮 evidence.log 全文锚行统计

- Spaces created: 1;Space onGetCell(space established): 1
- spawn done: 1 行,含 3 个非零实体 id
- bots onLoginOK: 10;reqCreateAvatar: 10;Avatar created: 10;onClientEnabled: 10;onEnterSpace(ENTERED WORLD): 13(3 Monster + 10 bot Avatar);bots client entity created: 10

## 本轮修复(相对上席遗留)

1. 夹具锚点原只有 `print`(引擎转发面吞掉 stdout),`evidenceLog()` 已定义但零调用 → 8 处锚点全部补 `evidenceLog(msg)`,`evidence.log` 实落文件。
2. `cell/Space.py` `KBEngine.createEntity(..., None)` 在本引擎构建上报 `args is not a dict`,刷怪失败 → 改传 `{}`,3 只 Monster 正常生成。
3. `base/Spaces.py` 锚行重复打印两遍 → 去重为单行。
