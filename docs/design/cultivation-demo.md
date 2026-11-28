# 修仙 MMO demo 需求与双覆盖矩阵(DEMO-GAME-007..042 战役总纲)

- 立项:2026-11-28 用户令。原 templates/demo-game 迷你 ARPG 骨架升格为**修仙类 MMO** demo,
  并要求「当成一个正常的游戏来创建」真实测试——不再拿残缺 demo 假测。
- 仓库布局(2026-11-28 落地,载体 01c8dd7a):
  - `templates/assets` —— assetsRoot(demo 游戏工程模板,随 VSIX 分发,`kbengine.project.createDemoGame` 物化);
  - `templates/kbe` —— engineRoot(引擎源树 res/src/tools,入仓但 `.vscodeignore` 排除,绝不进 VSIX);
  - 引擎二进制:linux/windows 两版,strip 后发 kbengine fork(cuihairu/kbengine),不入 git(2026-11-28 用户拍板,DEMO-GAME-030/031;正式版本号 release 须用户亲发)。**第一个版本已发**:tag `0.1.2`(打在未动的上游 commit 080fd4f0b)+release 三资产(DEMO-GAME-030/031 已勾);后续滚动走 nightly release 资产(DEMO-GAME-043 残项);
  - 真机验收链:`scripts/run-demo-engine.sh`(复制工程→改写 MySQL/网卡→真九进程起服→验收锚 grep)。

## 一、游戏需求书(逐系统)

| 系统 | 需求(用户令) | 载体 | 状态 |
|---|---|---|---|
| 玩家修士 | 个人属性(气血/灵力/攻防等)、境界(练气→化神)、五灵根(金木水火土) | `Avatar.def` attrs/spiritRoots/realm | 本战役 009-011 |
| 修炼成长 | 修炼得经验、境界突破、经验持久化 | `reqPractice` + `cellAddExperience` | 本战役 011 |
| 种族 | 建角双族:人族/妖族,只开两族 | race 属性+reqCreateAvatar Arg+cultivation.RACES/normalize_race | 本战役 069 |
| 配置表 | 配置用 Excel,导出为 py 常量模块 | config_tables/*.xlsx→scripts/export_game_tables.py→common/GameTables.py | 本战役 068 |
| 五行战斗 | 攻守灵根相生相克伤害乘数 | `cultivation.affinity` 纯函数接入攻击路径 | 本战役 008/012 |
| 战斗 | 近战/AOE、妖兽 AI、死亡重生(既有骨架,真机已验 DEMO-GAME-001..005) | `Monster`/`Avatar` cell 面 | 已有,扩展 012 |
| 技能 | 技能表/学习升级/冷却/消耗/AOE 与 buff;SKILL_SLOT 槽消费贯通 | `reqCastSkill` 扩真技能 | 本战役 039 |
| 储物袋组件 | 背包组件(gold 灵石+items) | `Inventory` 组件(已有)升级 ITEM_INFO 堆叠 | 本战役 013 |
| 容器物品 | 「背包系统就是有空间能力的物品」:储物袋/收纳戒/储物空间三档容器=物品 | `StorageBag`/`SpatialRing`/`StorageSpace`(Parent=Item)+capacity+contents 子表 | 本战役 038 |
| 物品 | 物品实体持久化 | `Item`(base-only 第四种实体形态) | 本战役 014 |
| 装备 | 穿戴槽/强化等级/属性加成生效 | `Equipment`(Parent=Item)+equipSlots | 本战役 015 |
| 符箓 | 使用消耗次数/AOE 效果 | `Talisman`(Parent=Item)+reqUseTalisman | 本战役 016 |
| 宠物 | 召唤/跟随/协战/名册持久化 | `Pet`(base+cell)+petList | 本战役 017 |
| 阵法 | 空间放置/范围效果/到期销毁 | `Formation`(base+cell) | 本战役 018 |
| 宗门 | 创建/加入/退出/成员名册持久化 | `Sect`(base-only) | 本战役 019 |
| 储物袋堆叠 | 背包 ITEM_INFO 堆叠合并+杀怪掉落入袋 | `Inventory items ARRAY<ITEM_INFO>`+`bag.addItem(merge_stack 核)` | 本战役 013 已勾 |
| 宗门组织 | 职位(宗主/长老/内门/外门)、权限矩阵、部门(战斗堂/丹药堂/任务堂) | MEMBER_INFO 扩 rank/dept+权限纯函数 | 本战役 033 |
| 任务 | 接任务系统(任务定义/接取/进度/交付/奖励),普通任务+宗门任务两类同面 | `Task` 实体+宗门任务榜 | 本战役 034 |
| NPC | 空间驻留 NPC、对话、发布任务 | `Npc` 实体+Exposed 交互 | 本战役 035 |
| 邮件 | 发件/收件/附件领取 | `Mail` 实体(base-only,附件 ARRAY 子表) | 本战役 037 |
| 活动 | 活动开关/时间窗/奖励(双倍掉落/双倍经验)/公告广播 | `Activity` 常驻 base 实体 | 本战役 040 |
| 排行榜 | Redis 榜(等级/战力,sorted set) | redis 连接面+双榜 | 本战役 041 |
| 跨服 | 必须有一种跨服玩法(双服务组互通) | 机制考证后落跨服演武/Boss | 本战役 036 |
| 合服 | 双服务组数据并组(ID 冲突/宗门名冲突) | 合服 DB 工具+验收 | 本战役 042 |
| 聊天 | 六频道:世界/宗门/私聊/组队/系统/走马灯(滚动横幅),防刷屏 | `CHAT_MSG`+reqChatMessage(Exposed)+定向推送 | 本战役 044 |
| 好友 | 名册持久化+在线位 | `friendList ARRAY<FRIEND_INFO>` 属性同步 | 本战役 045 |
| 交易 | **面对面**交易:距离闸+报价/锁定/双确认 | `Trade`(base-only 非持久化会话)+cell 面距离校验 | 本战役 046 |
| 商城 | 货目持久化,灵石购买 | `Mall`(base-only)+`MALL_GOODS`+reqBuyGoods | 本战役 047 |
| 宝石 | 装备嵌宝石,合成加成 | `GEM_INFO`+Equipment gems 孔位(随 015) | 本战役 048 |
| 副本组队 | 组队/副本实例/掉落分配/开始全员同意 | `Party`(base-only)+Space 实例化(spaceKind)+lootMode | 本战役 049 |
| 飞行器 | 御剑飞行(kind=0 飞剑)+其他飞行器,名册+当前坐骑+飞行速度 | `RIDE_INFO`+rides 名册+ridingId/flySpeed | 本战役 050 |
| 称号 | 称号收集+佩戴(成就/境界里程碑发放) | `titleList ARRAY<UINT16>`+curTitle+reqWearTitle | 本战役 051 |
| 道侣 | 求聘(近距)/接受-拒绝,双方互指持久化 | partnerDbid/partnerName+reqDaoProposal(CELL 距离闸) | 本战役 052 |
| 捏脸 | 建角外观自定义,旁人可见 | `APPEARANCE` FIXED_DICT+appearance(ALL_CLIENTS) | 本战役 053 |
| 时装 | 时装收集+穿着,旁人可见 | costumeList+curCostume+reqWearCostume | 本战役 054 |
| 修行流派 | 剑修/体修/魔修/阵法师/御兽师特点表+强化肉身(淬体) | path+bodyLevel+reqChoosePath/reqTemperBody | 本战役 055 |
| 轮回 | 被击杀即死亡→进轮回流(确认→结算→计数→新身) | reincarnations 计数+onReincarnateStart+reqReincarnate | 本战役 056 |
| 夺舍 | 魂迁入他人身体,可避轮回;原身死亡 | seizedByDbid+reqSeizeBody(CELL 闸)+onBodySeized/onSeizeResult | 本战役 057 |
| 强化 | 装备强化等级成长(消耗+成功率) | reqStrengthenEquip+onStrengthenResult(EQUIP_SLOT.strengthen 既有字段) | 本战役 058 |
| 排位赛 | 排位积分/段位/匹配进 arena 对战 | rankPoints+reqJoinRankedQueue/reqLeaveRankedQueue+onRankedMatchFound(spaceKind 2) | 本战役 059 |
| 装备库 | 纯装备寄存库(飞行器/技能/翅膀/宠物/图鉴/榜不入库) | `equipDepot ARRAY<EQUIP_SLOT>`+`reqDepotDeposit/reqDepotWithdraw` | 本战役 060 |
| 悬赏 | 发布(托管奖励)/接单/完成拿奖励 | reqPostBounty/reqAcceptBounty/reqTurnInBounty+onBountyPosted/onBountyResult | 本战役 061 |
| 佣兵 | 雇佣名册+召唤协战 | MERC_INFO/MERCS+mercList+hiredMercId+reqHireMerc/reqDismissMerc/reqSummonMerc | 本战役 062 |
| 货运战争/护送 | 护送目标任务+途中可劫(货运战争) | Task 面(034)扩展+护送目标实体(随 035) | 本战役 063 |
| 迷宫乱斗 | 迷宫空间混战+存活排名发奖 | Space 实例(spaceKind=3,复用 049 kit) | 本战役 064 |
| 挑战玩法组 | 世界boss/遗迹/暗域/远征/试炼 | Space 实例 kit(spaceKind 4..7)+世界boss 伤害榜 | 本战役 065 |
| 成就系统图 | 里程碑解锁+图鉴面,联动称号 | `achList ARRAY<UINT16>`+`onAchievementUnlocked` | 本战役 066 |
| 运营活动组 | 首充/月卡/VIP;任务型活动走 Task 面 | firstRechargeDone/monthlyCardUntil/vipLevel+三领取入口 | 本战役 067 |
| 服务器活动域 | 一个服的活动跟着这个服走:开服时间/世界等级/个人注册时间/物理时间/周期时间;有 server 对象承载 | Server 基座实体(开机单例)+五维活动时钟+activity_visible 纯函数核+globalData 广播位 | 本战役 070 |
| 日切/周切 | 周期重置:每日/每周界点重算,重置领取位与周常 | day_index/week_index 纯函数+Server 定时判界广播 onDayReset/onWeekReset | 本战役 071 |
| 客户端 | Godot 实现,**只展示数值和对象**(轻量面板) | `templates/godot-client`(GDScript TCP) | 本战役 027-029 |
| 无头验收 | bots 全回路(登录→建角→杀怪→修炼→穿戴→用符→召宠→布阵→入宗) | bots 脚本+demo-evidence 锚 | 本战役 023 |

## 二、KBEngine 特性覆盖矩阵(尽量铺满引擎用法)

| 引擎特性 | demo 载体 | 状态 |
|---|---|---|
| Proxy 实体(Account/Avatar) | 登录建角 | 已有 |
| Entity base+cell(Space/Pet/Formation) | 世界/宠物/阵法 | 已有+扩展 |
| cell-only(Monster/Npc) | 妖兽/NPC | 已有+扩展 |
| base-only(Item/Sect/Task/Mail/Activity) | 物品/宗门/任务/邮件/活动 | 本战役 |
| `Parent` 继承链+脚本镜像继承 | Monster→Avatar(已有);Equipment/Talisman→Item | 扩展 |
| `Interfaces` 接口混入 | ROLE(已有) | 已有 |
| `Components` 组件 | Inventory(已有,EntityComponent 基类坑已记) | 已有 |
| FIXED_DICT/ARRAY 嵌套 | SKILL_SLOT(已有)+SPIRIT_ROOTS/ATTRS/ITEM_INFO/EQUIP_SLOT/PET_INFO/MEMBER_INFO/contents | 本战役 010 |
| implementedBy user_type | SKILL_SLOT_DATA/POSITION_DATA(已有) | 已有 |
| types.xml 别名链 | ITEM_ID/ITEM_DESC(已有) | 已有 |
| Persistent/DatabaseLength/Index 索引列 | 全实体持久化+accountName 上 Index | 本战役 011/020 |
| Flags 全谱(BASE/CLIENT/BASE_AND_CLIENT/ALL_CLIENTS/CELL_PUBLIC/OWN_CLIENT) | 各实体散布+OWN_CLIENT 补例 | 已有+020 补 |
| Exposed 方法 | reqAttack 等(已有)+新系统入口 | 已有+扩展 |
| 定向 ClientMethod 推送(base→指定 client) | 宗门频道/私聊/交易事件/组队名册 | 本战役 044/046/049 |
| DetailLevels | Avatar NEAR/MEDIUM/FAR(已有) | 已有 |
| writeToDB/readFromDB 往返+deleteFromDB 位 | 修士/宠物/宗门/容器/邮件 | 本战役 024 |
| account_system(loginAutoCreate) | 登录建号(已有) | 已有 |
| bots 无头客户端 | 全回路验收 | 已有+023 扩 |
| kbcmd | SDK 生成/def 校验面 | 027 Godot 链用 |
| 多空间(副本位) | Space 单空间(已有)→宗门地图/跨服空间 | 020/036 |
| globalData 跨进程 | 宗门名全服唯一试金石 | 本战役 020 |
| Volatile 回调位 | 补例 | 本战役 020 |
| 跨服务组 | 双服务组起服互通 | 本战役 036 |
| Redis(dbmgr redis interface) | 排行榜 | 本战役 041 |

## 三、kode 功能走查矩阵(IDE 功能在真工程上逐项走查)

| kode 功能 | 走查载体 | 状态 |
|---|---|---|
| def↔py 跳转/F12 | 全实体 | 026 |
| 父类链 MRO 判存 | Monster→Avatar(已有)+Equipment/Talisman→Item 新链 | 026 |
| 读写引用分组 | 新实体属性读写点 | 026 |
| dict.get 值型 | FIXED_DICT 属性 .get 调用点 | 026 |
| FIXED_DICT 内联索引 | SPIRIT_ROOTS 等新类型 | 026 |
| 配置合并(kbengine.xml 覆盖 defaults) | demo kbengine.xml databaseInterfaces | 025/026 |
| createNamespace 创建向导/check_params | 新实体创建 API | 026 |
| 热更面板(KodeHotReload) | 既有回路 | 已有 |
| 数据库面板/导出链/dbid 查询 | 真库导出(SEM-016 自证) | 025 |
| base↔cell 同侧翻转切换 | 新实体双文件 | 026 |
| 实体创建 API params 检查 | createEntity 新类型调用点 | 026 |
| entities.xml 审计 | 新实体注册 | 026 |
| .def 原生格式化 | 新 def | 026 |

## 四、验收面总览

1. 真机起服:`run-demo-engine.sh` + `KBE_DEMO_ASSETS=templates/assets`,锚点全绿(022)。
2. bots 全回路:一键无头全玩法(023)。
3. DB 往返:kill 重启数据还在(024)。
4. kode 导出链真机自证(SEM-016 面,025)。
5. Godot 面板连真服展示数值与对象(027-029)。
6. 跨服双组互通(036)、合服并组(042)。

## 五、诚实边界

- 本矩阵登记**计划与载体**,实现状态以 todo.md 勾行为准;本文档不把未实现写成已实现(全局文档对账令)。
- 引擎二进制不入 git(nightly 产物面);`templates/kbe` 源树不进 VSIX(`.vscodeignore` 钉,tests/highlightRegistration.test.ts 锁集合)。
- 跨服/合服机制选型在 036/042 考证后回填本文档,考证前不预设结论。
