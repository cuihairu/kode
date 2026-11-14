# KSEM-CFG-01 配置读取路径登记册(2026-11-14)

验收口径(todo.md SEM-031,旧 KSEM-CFG-01):登记引擎 defaults/custom/覆盖层、
项目 XML/JSON/JSONC/Python 配置对象及真实读取函数;区分 schema 已有和只存在
文档目录。

交付物:机器可读登记册纯核心 `src/backend/configReadPaths.ts`(7 条 lane,
状态判据与不变量测试锁死)+ `tests/configReadPaths.test.ts`(12 例,含
仓库锚点 fs 存在性门——杜绝虚构读取器)。本文为人类可读对账版。

## 登记总表

| lane | 配置对象 | 层序 | status | 关键读取锚 |
|---|---|---|---|---|
| `server-config` | 引擎服务端 XML | defaults `server/kbengine_defaults.xml` → custom `server/kbengine.xml` | schema-covered | 引擎 `kbemain.h:66-75`(`:71`/:74 两文件;docs/knowledge/startup-flow-and-stack.md:54)、`serverconfig.cpp:104`;Rust `kode-parser/src/config.rs:131 parse_config`/`:342 merge_config_xml`;TS `src/serverConfigResolve.ts:307` + `serverConfigFallbackCore.ts` + `serverConfigMerge.ts:201` + `serverConfigCatalog.ts:81` |
| `fixed-messages` | 固定消息表 | defaults `messages_fixed_defaults.xml`(必载)→ custom `messages_fixed.xml`(notFoundError=false 显式容忍) | schema-covered | 引擎 `fixed_messages.cpp:29-74`(docs/kbengine-wire-protocol.md:182)、`message_handler.cpp:40/41`;Rust `kode-kbengine-schema/src/messages.rs:107 build_message_table`;TS `$/kode/messageTable/build`(Rust-first,TS 兜底) |
| `client-config` | 客户端/机器人侧同构两文件 | defaults → custom(客户端资源树) | **not-covered** | 仅引擎锚:`client_lib/kbemain.h:57-102`(startup-flow-and-stack.md:60)、`client_lib/config.cpp:50`;扩展无 TS/Rust 读取面(2026-11-14 时点) |
| `project-defs` | 实体定义链 types.xml → alias → entities.xml → *.def | 单层(defs 树,merge 序 parent→interface→self) | schema-covered | Rust `kode-kbengine-schema/src/builder.rs`;TS `src/definitionWorkspace.ts`;defs-md5 喂点 property.cpp:53-64/method.cpp:28-30/datatype.cpp:95-96(compat.rs 头注,SER-13) |
| `extension-settings` | kbengine.* 设置(JSONC) | 单层(package.json 声明 + settings.json) | schema-covered | 声明 `package.json contributes.configuration.properties`(146 键);读取面 `getConfiguration("kbengine")`(如 `serverConfigResolve.ts:141`) |
| `serialization-schema` | 项目序列化结构 `.kbengine/serialization.json` | 单层(设计面) | **parser-core-only** | 纯核 `src/backend/jsonChainPropagation.ts:78 parseSerializationSchema`(内容级);文件发现/读取接线**只在文档**:docs/review/2026-11-14-ksem-ser-08-project-schema-design.md(SER-08)+ SER-10 收口注 |
| `python-resource-io` | Python 脚本配置读取原语 | 单层(脚本自选文件,经 KBEngine 资源 IO) | **not-covered** | 引擎原语 `KBEngine.open/hasRes/getResFullPath/listPathRes/matchPath`(docs/knowledge/api-core-concepts.md:56;baseapp/KBEngine.md:90-786);扩展 API 文档面覆盖函数文档,项目配置文件发现/解析面无 |

状态计数:schema-covered 4 / parser-core-only 1 / docs-only 0 / not-covered 2。

## 状态判据(测试锁死)

- `schema-covered`:引擎读取有对应扩展解析+消费面(rustCore/tsCore reader 齐
  且 schemaFaces 非空);
- `parser-core-only`:纯解析核在、文件发现/读取接线只存在于文档;
- `docs-only`:仅文档设计,无任何代码(登记时点无此 lane);
- `not-covered`:引擎读取但扩展无读取/解析面。

## 覆盖层登记

- 引擎侧:两文件 defaults→custom 覆盖(server config 与 fixed messages 同构;
  客户端变体同构)——第二次 loadConfig 逐键覆盖;
- 扩展侧:`ConfigResolveOverrides`(src/serverConfigMerge.ts:201 入参,资产根/
  自定义路径解析期覆写)+ 虚拟最终配置文档(KBEngine: Final Config 视图,
  `kbengine.showFinalConfigOnOpen`/`finalConfigComments`/`autoRefreshFinalConfig`)。

## 诚实条款

1. **引擎 C++ 锚点出处=仓库知识库与 registry 文档**(`docs/knowledge/
   startup-flow-and-stack.md:54/:60`、`docs/kbengine-wire-protocol.md:182`、
   KSEM-BAS-02 registry):C++ 源码本地未检出,行号以已核对的知识库条目为准,
   每个锚点括注出处;仓库锚点(path:line)由测试 fs 存在性门核验。
2. **虚构读取器不可通过**:登记册中所有 rustCore/tsCore 仓库锚点经
   `repoPathFromAnchor` 提取后逐一 fs 校验(本批开发中该门已实际抓出并纠正
   一处自造路径 `src/backend/definitionWorkspace.ts` → 真位
   `src/definitionWorkspace.ts`)。
3. **not-covered 不冒充**:client-config 与 python-resource-io 明确登记为
   not-covered,notes 声明「勿称已有」;serialization-schema 的纯核不冒充
   文件级读取器(note:勿称已有读取器)。
4. **required 语义**:defaults 层恒在;custom 层 required=false 表达的是
   扩展解析臂的回落容忍(serverConfigFallbackCore),引擎自身对
   `kbengine.xml` 缺失的容忍面未逐行核,不在登记册断言(fixed messages 的
   custom 层例外:引擎源码显式 notFoundError=false)。
5. **邮件服务勘误**:引擎告警文本把邮件服务称 `email_service.xml`,实为所载
   XML 的 section(serverconfig.cpp `_updateEmailInfos` ~:1710),无独立
   文件加载——登记于 server-config notes,防止按告警文本虚构一条 lane。

## 验收映射

- 「引擎 defaults/custom/覆盖层」→ server-config / fixed-messages 两 lane 的
  layers(层序+加载锚)+ 覆盖层登记节;
- 「项目 XML/JSON/JSONC/Python 配置对象」→ project-defs(XML)/
  serialization-schema(JSON)/ extension-settings(JSONC)/
  python-resource-io(Python 配置对象=资源 IO 原语面);
- 「真实读取函数」→ 每 lane readers(引擎 C++ 锚 + 仓库 path:line 真位);
- 「区分 schema 已有和只存在文档目录」→ status 四态判据 +
  schemaFaces/docsOnlyFaces 分列(测试锁死状态真值表与不变量)。

## 门禁

- eslint 0 / compile(tsc)0 / vitest 新套件 12/12 绿;
- prove-red:翻 `serialization-schema.status` 为 `schema-covered` 并删
  docsOnlyFaces → status truth table + invariants + honesty 三例红,还原后
  cmp 字节一致全绿(见 todo.md 勾行注)。
