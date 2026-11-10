# def 同名双域属性与 owner-only 旗标 — 现状分析与修复

用户报告(2026-11-10):

> 实际测试 def 文件中定义了 `<inUseVehicleId><Type>UINT32</Type><Flags>BASE</Flags><Persistent>true</Persistent></inUseVehicleId>`,
> 同时有 Flags 是 `ALL_CLIENTS` 的版本,都写在一个文件中 —— 分析源码目前如何处理,整理进文档,并正确修复当前的问题;
> 以及「CELL_PUBLIC_AND_OWN 的 Flags 还是没有正常处理」。

本文是源码优先的回答:引擎的真实判重模型(带 file:line 锚)、kode 各消费面的逐面现状、
真正的断裂点、以及本批修复范围。旗标位值/别名/广播掩码的完整真值表在
[def-flags](../knowledge/def-flags.md),本文不重复,只引结论。
引擎地面域:`kbe/src` @ `/home/cui/workspaces/kbengine` HEAD `3082ab5`。

## 1. 引擎地面真相:判重是「桶内按名唯一」,不是「按位交集」

一个属性按其 Flags 落进 0~3 个 componentType 桶(entitydef.cpp:1284-1297,`.def` 属性加载路径):

```cpp
if(hasCellFlags > 0)   ret = pScriptModule->addPropertyDescription(name, pd, CELLAPP_TYPE);
if(hasBaseFlags > 0)   ret = pScriptModule->addPropertyDescription(name, pd, BASEAPP_TYPE);
if(hasClientFlags > 0) ret = pScriptModule->addPropertyDescription(name, pd, CLIENT_TYPE);
if(!ret) { ERROR_MSG(...); return false; }          // entitydef.cpp:1300-1302 —— 任一桶注册失败,整个 def 拒载
```

每个桶内部按属性名唯一(scriptdef_module.cpp:585-593):

```cpp
if(f_propertyDescription) {          // findXxxPropertyDescription(attrName) 命中
    ERROR_MSG("... [{}] is exist! ...");
    return false;                    // → 上面收到 false → def 拒载
}
```

桶成员资格由三个掩码决定(common.h:41/43/45,见 def-flags §2):

| 桶 | 掩码成员 |
| --- | --- |
| base | BASE, BASE_AND_CLIENT |
| cell | CELL_PUBLIC, CELL_PRIVATE, ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OWN_CLIENT, OTHER_CLIENTS |
| client | BASE_AND_CLIENT, ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OWN_CLIENT, OTHER_CLIENTS |

由此得到同名双定义的完整判定表:

| 同名组合 | 桶集相交? | 引擎判定 |
| --- | --- | --- |
| `BASE`+Persistent vs `ALL_CLIENTS`(用户场景) | {base} ∩ {cell,client} = ∅ | **合法共存**——base 桶与 cell/client 桶各一条 description,各自独立 utype |
| `CELL_PUBLIC_AND_OWN` vs `ALL_CLIENTS` | {cell,client} ∩ {cell,client} ≠ ∅ | **def 拒载**(cell 桶与 client 桶双双撞名) |
| `CELL_PUBLIC_AND_OWN` vs `OWN_CLIENT` | 同上 | def 拒载 |
| `CELL_PUBLIC` vs `CELL_PRIVATE` | {cell} ∩ {cell} ≠ ∅ | def 拒载 |
| `BASE` vs `BASE_AND_CLIENT` | {base} 撞 | def 拒载 |
| 完全相同 Flags 写两遍 | 全桶撞 | def 拒载 |

运行期脚本侧解析按桶走:`findCellPropertyDescription` / `findBasePropertyDescription` /
`findClientPropertyDescription`(scriptdef_module.cpp:611 起,均按名查各自桶)——所以
`scripts/cell/Avatar.py` 里 `self.inUseVehicleId` 拿到的是 **cell/client 桶的 ALL_CLIENTS
版本**,`scripts/base/Avatar.py` 拿到的是 **base 桶的 BASE 版本**,同名不同义是引擎的原生形态。

owner-only(`CELL_PUBLIC_AND_OWN` / `OWN_CLIENT` / `BASE_AND_CLIENT`:只有拥有者的客户端可见)
与 `ALL_CLIENTS`(拥有者 + AOI 其他人)的区分由广播掩码承载(common.h:47/49/51),
与判重无关——判重只看桶集。

## 2. kode 逐面现状

**与引擎一致(不动):**

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 解析器(双语) | kode-parser `model.rs` extract_property(Vec 顺序 push)/ `defParser.ts` preserveOrder | 两条同名属性都保留 |
| 旗标表 | `normalize_flag_tokens` / `flag_domains`(model.rs)+ TS 镜像 `generated/flagDomains.ts`、`completion.ts` 三掩码 Set | 12 拼写 + 4 别名;`flag_domains` 的三桶映射与引擎掩码路由**同构**(ALL_CLIENTS/CELL_PUBLIC_AND_OWN/OWN_CLIENT/OTHER_CLIENTS → cell+client 正是引擎 CELL/CLIENT 桶成员) |
| 同名判重 lint | kode-server `lint/rules.rs` flag_scopes(经 normalize_flag_tokens 拆 `|`)+ TS `validation.ts` | 按三桶域位相交判 Warning——与「引擎拒载」同构:kode 报警的组合引擎必然拒载,**不是误报**;用户场景(∅ 相交)正确不报 |
| def_md5 | kode-server `def_md5/mod.rs` loadDefPropertyys | 文档序逐条流 `<Properties>` 子属性,重复项各得独立 utype——引擎字节序忠实 |
| message_table | kode-server `message_table/properties.rs` addPropertyDescription 重放 | 按桶名集判重,桶内撞名 fatal——与引擎拒载同构 |
| wire 布局 | kode-server `wire_codec/golden.rs` | 按 utype 键控,双条可各自编解码 |
| MCP 节点 | kode-mcp `extract.rs` def_xml_nodes | `#N` 去重命名,双条独立节点 |
| 定位类查询 | kode-server `hover.rs`/`definition.rs`(name+line 双限定)、kode-index 符号索引、TS `findDefSymbolInfo` | 位置限定,每条声明独立可寻址 |
| DB schema | kode-server `database_schema.rs` + TS `databaseSchemaCore.ts` | 仅 Persistent 进入列集——用户场景(BASE 持久 + ALL_CLIENTS 非持久)天然正确 |
| 实体流量图 | `src/backend/entityFlowGraph.ts` | 按**精确旗标**语义分流(broadcastOwnClient = BASE_AND_CLIENT/CELL_PUBLIC_AND_OWN/OWN_CLIENT/ALL_CLIENTS 与 broadcastOtherClients = OTHER_CLIENTS/ALL_CLIENTS 分组)——owner-only 区分在此面存在 |
| Python 侧解析 | `entityMapping.ts` collectPropertyDefinitions | 每条 entry 自带 `domains`(三桶列表) |

**有损面(本批修复):**

1. **effective 属性合并按名 first-wins**(`src/backend/definitionSemantics.ts:307-313` 本地、
   `:370-377` 接口、`:453-460` 父类,键 = `fullPath` = 根级裸属性名):
   第二条(ALL_CLIENTS)**静默丢失**,且父链上桶集不相交的同名属性也被错误遮蔽——引擎只在
   「桶集相交」时才拒载,不相交就该共存。下游实体索引/hover/nav/类型推断/CodeLens 全部继承此坍缩。
2. **`self.<prop>` 解析 first-wins**(`src/entityMapping.ts` findIndexedPropertyIn,`.find()` 按
   path):cell 脚本里引擎解析到 cell/client 桶的版本,kode 返回第一条(用户的场景 = BASE 版),
   hover/跳转/注解落错条。
3. **legacy mapping Record first-wins**(`src/entityMapping.ts` toLegacyMapping):实体 `.pyi`
   桩经它出表,重复项只剩一条;stub 注解又按 `symbolName` `.find()` 首条——桩面无法表达双域拆分。
4. **组合 Flags 静默跳过判重**(`src/languageProviders/validation.ts` getPropertyFlagScopes):
   对归一后的**整串**做 Set 成员判断,`BASE | ALL_CLIENTS` 这类组合串(引擎本不支持 `|` 组合,
   kode 宽容拆分——def-flags §traps)不中任何 Set → scopes 空 → 该属性的重复检查被跳过。
   而拆分用的 `normalizeFlagTokens` 就在同一文件 import 范围内。
5. **过时注释**(`crates/kode-server/src/lint/rules.rs` flag_scopes):「OWN_CLIENT/OTHER_CLIENTS
   仅 client,不入 cell」与 `flag_domains` 实际映射(cell+client,即引擎 CELL 桶成员)矛盾——
   表对注释错,注释修正不动行为。

**kode 宽于引擎的既定立场(不改):**引擎不支持 `|` 组合(解析失败按 UNKOWN 处理),kode 拆分
组合串逐 token 判域。此宽容度已在 def-flags 记档,lint 判重拆分后反而能覆盖引擎会拒载的组合,
方向一致。

## 3. CELL_PUBLIC_AND_OWN 专项结论

「没有正常处理」的溯源:上一批 FLAGS-AUDIT-1(ec35d1c7)已修正旗标表;本批复核,**桶路由、
判重、def_md5、流量图四个面它都是对的**——`CELL_PUBLIC_AND_OWN` → cell+client 桶、
broadcastOwnClient 分组、owner-only 掩码语义均与引擎一致。真正残留的问题有两个,都已在
§2 断裂点覆盖:同名双域在 name 键控面上被坍缩(它作为第二条被丢,或它作为首条把别人的
ALL_CLIENTS 版本挤掉),以及组合 Flags 串跳过判重。owner-only 与 ALL_CLIENTS 在
**展示层**的进一步细分(如树/悬浮提示里标注「仅拥有者可见」)不在本批,属既有文案面,
不产生错误行为。

## 4. 本批修复

1. `src/backend/definitionSemantics.ts`:effective 合并键从 `fullPath` 改为
   `fullPath + 桶集签名`(签名 = `propertyFlagDomainList(flags)` 排序拼接)——桶集不相交的
   同名属性共存(引擎形态),桶集相同时维持本地遮蔽接口/父类的既有语义(桶集相同即引擎拒载,
   lint 已报)。三个插入点(本地/接口/父类)同键。
2. `src/entityMapping.ts` findIndexedPropertyIn:同 path 多条时按脚本目录选域——
   `scripts/cell/` 选含 cell 域条、`scripts/base/`(及 interfaces)选含 base 域条,无匹配回退首条。
3. `src/entityMapping.ts` toLegacyMapping + `src/entityTypeStubs.ts` 桩注解 find:同 path 多条
   时优先含 client 域的条目(桩是客户端脚本面),无则首条。
4. `src/languageProviders/validation.ts` getPropertyFlagScopes:改走 `normalizeFlagTokens`
   (拆 `|` + 别名 + 遗留折叠)逐 token 对三掩码 Set 判桶,组合串不再静默漏检。
5. `crates/kode-server/src/lint/rules.rs` flag_scopes 注释修正(表对注释错,无行为变化)。

## 5. 验证与遗留

- 单测:合并共存(cell+client 与 base 双条都进 effectiveProperties)、同名同桶仍遮蔽(接口/
  父链语义不变)、cell 目录解析选 cell 域条 / base 目录选 base 域条、stub 首选 client 域条、
  组合 Flags 判重不再跳过。
- 遗留(已登记,不属本批):桶相同时 kode 仅 Warning 而引擎拒载——姿态正确(kode 提示,
  引擎兜底);`CELL_PUBLIC_AND_OWN`/`OWN_CLIENT` 的展示层 owner-only 标注(文案增强);
  client_sdk 组件属性合并的 name-only 去重(mod.rs:297-366)在桶集相交时与引擎一致、不相交时
  待域位化(现无触发场景:客户端可见面桶集必相交)。
