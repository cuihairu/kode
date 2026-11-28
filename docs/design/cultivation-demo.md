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
| 宗门组织 | 职位(宗主/长老/内门/外门)、权限矩阵、部门(战斗堂/丹药堂/任务堂) | MEMBER_INFO 扩 rank/dept+权限纯函数 | 本战役 033 |
| 任务 | 接任务系统(任务定义/接取/进度/交付/奖励) | `Task` 实体+宗门任务榜 | 本战役 034 |
| NPC | 空间驻留 NPC、对话、发布任务 | `Npc` 实体+Exposed 交互 | 本战役 035 |
| 邮件 | 发件/收件/附件领取 | `Mail` 实体(base-only,附件 ARRAY 子表) | 本战役 037 |
| 活动 | 活动开关/时间窗/奖励(双倍掉落/双倍经验)/公告广播 | `Activity` 常驻 base 实体 | 本战役 040 |
| 排行榜 | Redis 榜(等级/战力,sorted set) | redis 连接面+双榜 | 本战役 041 |
| 跨服 | 必须有一种跨服玩法(双服务组互通) | 机制考证后落跨服演武/Boss | 本战役 036 |
| 合服 | 双服务组数据并组(ID 冲突/宗门名冲突) | 合服 DB 工具+验收 | 本战役 042 |
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
