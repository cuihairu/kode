# `.def` 属性 Flags —— 引擎完整真值

> 用户报障（2026-11-09）：「Flags 很多都解析错误，CELL_PUBLIC_AND_OWN 也是解析错误的」——
> 本页是 source-first 的答案：引擎接受的所有 Flags 拼写、映射到位值、定义运行时语义的
> 关系掩码、两条解析路径（二者严格度不一致——大多数「解析错误」报障的根因）、以及 kode
> 对同一张表的消费。 grounding 域 = `kbe/src`，位于 `/home/cui/workspaces/kbengine`，
> HEAD `3082ab5`（2026-11-09 于 HEAD 核验）；每条论断带 `file:line` 锚点。补上
> [api-core-concepts](../knowledge/api-core-concepts.md) 记录的「flags 被引用但从未枚举」缺口。

## 1. 位值（`common.h:19-27`）

`EntityDataFlags` 就是普通位掩码。引擎自带的枚举拼写 `ED_FLAG_UNKOWN`（少个 S）原样
保留——`common.cpp:38-40` 的 `entityDataFlagsToString` 甚至返回字符串 `"UNKOWN"`。

| 位 | 名字 | 引擎注释 | 含义 |
| --- | --- | --- | --- |
| 0x00 | `ED_FLAG_UNKOWN` | 未定义 | 任何进程面都没有（解析失败哨兵值） |
| 0x01 | `ED_FLAG_CELL_PUBLIC` | 相关所有cell广播 | cellapp 注册，向相关 cellapp 跨机广播，任何客户端都收不到 |
| 0x02 | `ED_FLAG_CELL_PRIVATE` | 当前cell | cellapp 注册，仅当前 cellapp |
| 0x04 | `ED_FLAG_ALL_CLIENTS` | cell广播与所有客户端 | cellapp 注册 + 跨 cell 广播 + 所有客户端（拥有者 + AOI 其它） |
| 0x08 | `ED_FLAG_CELL_PUBLIC_AND_OWN` | cell广播与自己的客户端 | cellapp 注册 + 跨 cell 广播 + 仅拥有者客户端 |
| 0x10 | `ED_FLAG_OWN_CLIENT` | 当前cell和客户端 | cellapp 注册，仅拥有者客户端，不跨 cell 广播 |
| 0x20 | `ED_FLAG_BASE_AND_CLIENT` | base和客户端 | baseapp 注册 + 仅拥有者客户端，完全不经 cellapp |
| 0x40 | `ED_FLAG_BASE` | 当前base | 仅 baseapp 注册，无客户端面 |
| 0x80 | `ED_FLAG_OTHER_CLIENTS` | cell广播和其他客户端 | cellapp 注册 + 跨 cell 广播 + AOI 其它客户端，绝不含拥有者客户端 |

## 2. 关系掩码（`common.h:40-56`）

逐旗标的运行时语义**完全**等于掩码成员关系——引擎里没有任何「每旗标独立行为」代码。
`ED_FLAG_ALL`（`common.h:29-31`）是八位之并。

| 掩码 | 成员 | 消费位点 |
| --- | --- | --- |
| `ENTITY_BASE_DATA_FLAGS`（L41） | BASE, BASE_AND_CLIENT | 脚本模块 base 面 `setBase(true)`（`entitydef.cpp:1149-1152`） |
| `ENTITY_CELL_DATA_FLAGS`（L43） | CELL_PUBLIC, CELL_PRIVATE, ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OTHER_CLIENTS, OWN_CLIENT | 脚本模块 cell 面 `setCell(true)`（`entitydef.cpp:1153-1156`） |
| `ENTITY_CLIENT_DATA_FLAGS`（L45） | BASE_AND_CLIENT, ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OTHER_CLIENTS, OWN_CLIENT | 脚本模块 client 面 `setClient(true)`（`entitydef.cpp:1157-1160`）；clientprop 过滤（`py_entitydef.cpp:2245`） |
| `ENTITY_BROADCAST_CELL_FLAGS`（L47） | CELL_PUBLIC, ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OTHER_CLIENTS | 向其它 cellapp 的 ghost 同步（`cellapp/entity.cpp:689`） |
| `ENTITY_BROADCAST_OTHER_CLIENT_FLAGS`（L49） | OTHER_CLIENTS, ALL_CLIENTS | AOI 其它客户端扇出（`cellapp/entity.cpp:724/:800/:883`；`entity_macro.h:629`） |
| `ENTITY_BROADCAST_OWN_CLIENT_FLAGS`（L51） | ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OWN_CLIENT, BASE_AND_CLIENT | 经 witness 推给拥有者客户端（`cellapp/entity.cpp:854`） |
| `ENTITY_BASEAPP_ANDA_CLIENT_DATA_FLAGS`（L53） | BASE_AND_CLIENT | baseapp↔客户端耦合 |
| `ENTITY_CELLAPP_ANDA_CLIENT_DATA_FLAGS`（L55） | ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OTHER_CLIENTS, OWN_CLIENT | cellapp↔客户端耦合 |

三个广播掩码合读，每面旗标的客户端故事就出来了：

- **任何客户端都看不到**：CELL_PUBLIC、CELL_PRIVATE、BASE。
- **只有拥有者客户端看得到**：OWN_CLIENT、BASE_AND_CLIENT、CELL_PUBLIC_AND_OWN。
- **拥有者 + AOI 其它都看得到**：ALL_CLIENTS。
- **AOI 其它看得到，拥有者看不到**：OTHER_CLIENTS。

## 3. 名字表——引擎接受的 12 个拼写（`entitydef.cpp:161-174`）

`g_entityFlagMapping` 在 `EntityDef::initialize` 里一次性填好。八个规范名加四个旧式
别名，别名落到**同一位**：

| 拼写 | 位 | 说明 |
| --- | --- | --- |
| `CELL` | 0x01 | 别名 → CELL_PUBLIC（`entitydef.cpp:161`） |
| `CELL_AND_CLIENT` | 0x08 | 别名 → CELL_PUBLIC_AND_OWN（`entitydef.cpp:162`） |
| `CELL_AND_CLIENTS` | 0x04 | 别名 → ALL_CLIENTS（`entitydef.cpp:163`） |
| `CELL_AND_OTHER_CLIENTS` | 0x80 | 别名 → OTHER_CLIENTS（`entitydef.cpp:164`） |
| `BASE_AND_CLIENT` | 0x20 | 规范名（`entitydef.cpp:165`） |
| `BASE` | 0x40 | 规范名（`entitydef.cpp:166`） |
| `CELL_PUBLIC` | 0x01 | 规范名（`entitydef.cpp:168`） |
| `CELL_PRIVATE` | 0x02 | 规范名（`entitydef.cpp:169`） |
| `ALL_CLIENTS` | 0x04 | 规范名（`entitydef.cpp:170`） |
| `CELL_PUBLIC_AND_OWN` | 0x08 | 规范名（`entitydef.cpp:171`） |
| `OTHER_CLIENTS` | 0x80 | 规范名（`entitydef.cpp:173`） |
| `OWN_CLIENT` | 0x10 | 规范名（`entitydef.cpp:174`） |

引擎里不存在任何其它拼写；没有 `PERSISTENT`/`UNIQUE` 旗标——持久化是独立的
`<Persistent>` 节点（`entitydef.cpp:1178+`），唯一性是独立的 `<Index>`/`<Unique>`
机制。

## 4. 两条解析路径——以及它们为何不一致

这是大多数「这个 Flags 解析错了」报障的根因：**同一个名字可以在一条路径合法、在另一
条路径静默失效。**

### 4.1 XML `.def` 路径——宽松、报错响亮、认别名（`entitydef.cpp:1134-1176`）

对 `.def` 文件里每个 `<Property>`（`loadDefPropertys`）：

1. `<Flags>` 节点**必须存在**——缺失 → `ERROR_MSG` + `return false`，整个 def 模块
   加载失败（`entitydef.cpp:1170-1176`）。
2. 原文先整体转大写（`std::transform(... toupper)`，`entitydef.cpp:1138`），再作为
   **一整串**去 `g_entityFlagMapping` 查表（`entitydef.cpp:1140`）。`|` 组合值**不会**
   被拆开——`BASE|CELL` 直接查表失败。
3. 未知拼写 → `ERROR_MSG "not fount flags[...]"` + `return false`——实体加载失败
   （`entitydef.cpp:1141-1147`）。
4. 查表成功后立刻把 flags 投影到模块的 base/cell/client 三面
   （`entitydef.cpp:1149-1160`）。
5. 最后一道守卫要求 `hasBaseFlags > 0 || hasCellFlags > 0`（`entitydef.cpp:
   1162-1168`）；注意这一条实际上永远触发不了——12 个映射值全都带 base 或 cell 面，
   纯防御性代码。

所以 XML 里：大小写不敏感、认别名、未知即硬失败。

### 4.2 Python 装饰器路径——严格、静默、只认规范八名（`py_entitydef.cpp:2507` → `common.cpp:42-68`）

经 `@kbengine.onCommon.../onCell.../onBase...` 装饰器族注册的属性，收集到的
`propertyFlags` 走 `stringToEntityDataFlags`（`common.cpp:42-68`）——一个**精确、区分
大小写、只认 8 个名字的 `if` 链**：四个旧式别名缺席、没有 `toupper`、任何不匹配的值
——包括 `CELL`、`CELL_AND_CLIENT`、`cell_public`——都返回 `ED_FLAG_UNKOWN`（0x00）。
调用点（`py_entitydef.cpp:2507`）不检查 `ED_FLAG_UNKOWN`，于是写错的名字产出一个
**没有任何 base/cell/client 面**的属性——哪儿都不可见，且没有任何报错。后续的面检查
（`py_entitydef.cpp:532-536`）是对关系掩码做 `!= 0`，同样只是安静地不成立。

实际结论：**四个旧式别名只在 XML 里有效。** `CELL` 写在 `.def` 文件里能加载，写进
装饰器就是静默空操作。装饰器只接受恰好八个规范拼写、且大小写精确。

### 4.3 映射表同时暴露给 Python（`py_entitydef.cpp:2912-2926`）

`PyEntityDef::initialize()` 把 `g_entityFlagMapping` 的每个键作为字符串常量加到
`entitydef` 模块上（所以 `EntityDef.CELL == "CELL"`，与 `UNIQUE`、`INDEX`、
`CALLER_ID` 并排）。这就是别名拼写能作为模块属性 import 到的原因——它**并不会**让
别名变成合法的装饰器入参（§4.2 依然成立，因为装饰器路径从不查这张表）。

## 5. 逐旗标运行时语义（由 §2 推出，锚到消费位点）

| 旗标 | 注册在 | 跨 cell 广播 | 拥有者客户端 | AOI 其它客户端 |
| --- | --- | --- | --- | --- |
| CELL_PUBLIC (0x01) | cellapp | 是（L47；`cellapp/entity.cpp:689`） | 否 | 否 |
| CELL_PRIVATE (0x02) | cellapp | 否 | 否 | 否 |
| ALL_CLIENTS (0x04) | cellapp | 是 | 是（L51；`:854`） | 是（L49；`:724/:800`） |
| CELL_PUBLIC_AND_OWN (0x08) | cellapp | 是 | 是 | 否 |
| OWN_CLIENT (0x10) | cellapp | 否 | 是 | 否 |
| BASE_AND_CLIENT (0x20) | baseapp | 不适用（永不上 cellapp） | 是 | 否 |
| BASE (0x40) | baseapp | 不适用 | 否 | 否 |
| OTHER_CLIENTS (0x80) | cellapp | 是 | 否 | 是 |

## 6. 踩坑索引

1. **别名只在 XML 有效**（§4.2）——`CELL`/`CELL_AND_CLIENT`/`CELL_AND_CLIENTS`/
   `CELL_AND_OTHER_CLIENTS` 在 `.def` 里加载正常，走装饰器路径就静默变
   `ED_FLAG_UNKOWN`。
2. **`|` 组合从未被支持**——两条路径都把文本当一个查表键；`BASE|CELL` 在 XML 里是
   未知旗标、在装饰器里是 UNKOWN。要组合行为请选定唯一一个预先组合好的旗标。
3. **大小写只在装饰器里敏感**——XML 先转大写（`entitydef.cpp:1138`）；
   `stringToEntityDataFlags` 不转（`common.cpp:42-68`）。
4. **装饰器笔误是静默的**——`py_entitydef.cpp:2507` 从不检查 `ED_FLAG_UNKOWN`；
   该属性只是没有任何面。
5. **`UNKOWN` 是引擎自己的错拼**——枚举 `ED_FLAG_UNKOWN`（`common.h:19`）、字符串
   `"UNKOWN"`（`common.cpp:38-40`）。引用时不要「顺手修正」拼写。

## 7. kode 消费面（单一来源管线）

kode 精确镜像上面这张表，单一来源在 Rust 解析器、锁步对拍验证：

- **Rust 归一** `crates/kode-parser/src/model.rs normalize_flag_tokens`：trim +
  大写、四个旧式别名、遗留拼写折叠（空白/连字符/下划线变体）、未知保留大写、
  去重保序。
- **域投影** `kode_parser::model::flag_domains` + lint 消费端
  `crates/kode-server/src/lint/rules.rs:183-187`——§2 掩码的查表实现。
- **golden 快照** `crates/kode-server/tests/golden/flag-domains-parity.json`
  （重生成：`cargo run -p kode-server --bin dump-flag-domains-golden`）。
- **TS 镜像** `src/generated/flagDomains.ts`（派生物；禁手改）——
  `CANONICAL_FLAG_TOKENS` / `FLAG_TOKEN_DOMAINS` / `FLAG_DOMAIN_ALIAS` /
  `normalizeFlagTokens`，由 `tests/flagDomainsParity.test.ts` 对拍门禁锁死。
- **消费方**：重复定义作用域（`src/languageProviders/validation.ts
  normalizePropertyFlag`）、分析面（`src/backend/defAnalyzer.ts
  propertyFlagDomainList`）、补全集、hover 元数据（`src/kbengineMetadata.ts
  KBENGINE_FLAGS`）、消息表位（`src/messageTableEngine.ts PROPERTY_FLAG_BITS`）、
  依赖图与进程拓扑投影。

史注（2026-11-09）：本批之前，kode 两侧的别名处理都不完整——Rust 归一完全缺
`CELL`/`CELL_AND_*`（别名丢域面、被判未知），TS 校验器四个别名只归一三个。两侧现均
从上文同一张 12 项表派生；`tests/kbengineMetadata.test.ts` 把 hover 文档的逐旗标
声明对 `common.h` 掩码做机器核验，文档不再可能漂在源码之外。

## 8. 引擎版本注意

grounding 于 fork HEAD `3082ab5`（2026-11-09）。上游 BigWorld 衍生代码多年保持这套
12 项映射 + 8 关系掩码不变；fork 若前进，`tests/kbengineMetadata.test.ts`（引擎对账
测试，无引擎检出时自动跳过）会直接对着 `common.h` 重核枚举名与 §5 全部声明。
