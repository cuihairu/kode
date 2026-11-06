# 设计先行项形态调研（2026-11-05）

> 范围：todo.md 中「前置：无（调研先行）/形态待调研后定」的五项。本文档是**形态调研**，
> 只确定各功能的形态（架构/数据面/控制面/边界），**不实现代码**。所有路径为真实路径；
> 「建议形态」为提案，实现前仍需逐项验收定案。

调研对象（todo.md 行号 / 优先级）：

| 项 | 行 | 优先级 | 一句话 |
|---|---|---|---|
| IDE-BOT-001 | 801 | P1 | KBEngine 机器人框架支持与多机管理 |
| IDE-PROP-001 | 802 | P2 | 属性先于 `__init__` 装载的可见化 |
| IDE-DB-001 | 803 | P2 | 持久化字段数据库类型大小限制提示 |
| IDE-I18N-002 | 804 | P2 | hover 提示国际化配置 |
| IDE-PYSPY-001 | 805 | P2 | py-spy 火焰图集成与定时采集 |

---

## 1. IDE-PROP-001 属性先于 `__init__` 装载的可见化

**验收原文**：实体类定义/`__init__` 处出一行 CodeLens 说明「属性先于 `__init__` 装载·来自
Entity.def」（与既有 `PropertyCodeLensProvider` 同面，独立开关）；`self.hp` 在 `__init__` 内
F12 已可导航（`provideDefinitionTraced` 四档锚点：类定义行→`__init__` 行→首个类行→脚本首行，
引擎在 `__init__` 前装载属性故无同名赋值也定位），确认不回归；文档同步。

### 现状（已实现面）

- **语义注释**（"属性先于 `__init__` 装载"）：`src/languageProviders.ts:3697-3720`。
- **属性导航四档锚点**（F12 已实现，本次仅需确认不回归）：
  - `findPropertyScriptLocationInDef` `src/languageProviders.ts:3703` —— 从 `.def` 沿引擎装载链
    收集候选脚本（本 def 角色脚本 → 接口 def 的 `scripts/interfaces/` → `<Parent>` 链各层角色
    脚本），逐脚本找落点。
  - `resolvePropertyLandingLine` `src/languageProviders.ts:3722` —— 四档：与 def 同名的类定义行
    → `__init__` 行 → 首个类行（类名与 def 不一致时）→ 脚本首行。
  - 接线点 `src/languageProviders.ts:3113`（`propertyScriptLocation = findPropertyScriptLocationInDef(document)`）。
- **既有 CodeLens 面**：
  - `PropertyCodeLensProvider` `src/languageProviders.ts:5475` —— 对 `self.<属性>` 访问点出镜，
    经 `entityMappingManager.resolvePropertyDefinitionInfo` 解析到 def 定义，点击走
    `kbengine.source.reveal`。受独立开关 `kbengine.codeLens.property`（默认 true）控制。
  - 开关读取：`src/languageProviders.ts:312` `config.get<boolean>('codeLens.property', true)`。
  - 注册：`src/extension.ts:1172-1177`（`registerCodeLensProvider` 挂 Python 文档）、
    `fireConfigurationChanged` `src/extension.ts:2128`（配置变更刷新）。
  - 配置 schema：`package.json:1155` `kbengine.codeLens.property`（boolean，默认 true）。

### 建议形态

- **新开关**：`kbengine.codeLens.propertyPreInit`（boolean，默认 true），schema 沿
  `package.json:1155` 同款；读取加在 `src/languageProviders.ts:312` 邻位
  （`config.get<boolean>('codeLens.propertyPreInit', true)`）。
- **新 CodeLens 面**：扩展现有 `PropertyCodeLensProvider`（或同文件新增一个轻量 provider），
  当文档是 KBEngine 实体脚本时，在 `resolvePropertyLandingLine` 返回的落点（类定义行/`__init__`
  行）出一行 CodeLens，标题 `属性先于 __init__ 装载·来自 Entity.def`。该行与既有 per-access
  镜不同：它是**类级语义说明**，不绑定具体 `self.<属性>` 访问，点击行为建议为
  `kbengine.source.reveal` 定位到 def 的 `<Properties>` 段（或 `none` 纯说明）。
- **实体脚本判定**：沿用 `findPropertyScriptLocationInDef` 的候选链（`collectPropertyCandidateScripts`）
  或反查（脚本 basename 与工作区 def 同名）。CodeLens 只在 `resolvePropertyLandingLine` 非空时出。
- **不回归确认**：`provideDefinitionTraced`（`src/languageProviders.ts:4514`）不动；验收加一条
  `self.hp` 在 `__init__` 内 F12 的既有用例回归断言。
- **边界**：不动 `src/dependencyGraph.ts` / `extension.ts` 既有注册；只加一枚开关 + 一处 CodeLens
  生成。`EntityMappingManager` 复用不新增解析面。

---

## 2. IDE-I18N-002 hover 提示国际化配置

**验收原文**：hover 文案可配置语言（默认英文，可选中/中文）；检测到中文系统或 UTC+8 时区时
默认中文；安装时生成配置（settings 默认值），既有英文 hover 不回退；形态待调研后定（沿用
`vscode.l10n` 机制或独立配置项）。

### 现状

- **I18N-001 已完成**（655494a）：quick fix 标题走 `vscode.l10n` + `l10n/` 目录，默认英文，
  中文环境出中文。`package.json:145` `"l10n": "./l10n"`；`l10n/bundle.l10n.json`（英文）+
  `l10n/bundle.l10n.zh-cn.json`（中文）。
- **l10n 用法**：`src/quickActions.ts:58` `vscode.l10n.t(...)` 等；`src/languageProviders.ts` 有
  7 处 `l10n.t(` 但 **~99 处 hover 相关引用基本仍为硬编码英文**——hover 文案绝大部分未国际化。
- **vscode.l10n 的局限**：`vscode.l10n.t()` 的取词由 VS Code 当前 UI 语言（`vscode.env.language`）
  自动决定，**无法按扩展配置覆盖**。因此「hover 可配置语言」单靠 `vscode.l10n` 不够，需独立配置项。

### 建议形态

- **独立配置项**：`kbengine.hover.language`（`'auto' | 'en' | 'zh'`，默认 `'auto'`）。配置声明沿
  `package.json` 的 `contributes.configuration`；默认值即「settings 默认值」，不写 install 时
  写 settings.json（package.json 默认值已满足「settings 默认值」语义，用户在设置 UI 可见可改）。
- **解析器**：`resolveHoverLocale(config, env)`：
  - `'en'` → en；`'zh'` → zh；
  - `'auto'`（默认）→ `vscode.env.language` 以 `zh` 开头 **或** `new Date().getTimezoneOffset()
    === -480`（UTC+8）→ zh，否则 en。
- **文案面**：新建 hover 文案表 `hoverTexts: Record<key, { en: string; zh: string }>`，提供
  `hoverText(key)` 按解析语言取值；**未迁移键回退英文**（`en` 恒有值）→ 既有英文 hover 不回退。
- **迁移范围**：`src/languageProviders.ts` 的 **用户可见 hover markdown 字符串**（非内部函数名）
  逐条迁入 `hoverTexts`，增量做；每批迁移后既有 `l10n.t`（quick fix）不动。
- **检测面**：`zh` 系统检测用 `vscode.env.language`（VS Code UI 语言）+ `Intl`/`process.env.LANG`
  兜底；UTC+8 用 `getTimezoneOffset()`。纯函数便于单测。

---

## 3. IDE-PYSPY-001 py-spy 火焰图集成与定时采集

**验收原文**：`py-spy record --format flamegraph` 出火焰图（既有 py-spy dump 面已集成）；支持
定时/周期采集（如每 N 秒采 X 次）；使用傻瓜化（默认参数/一键采集）；UI 需单独设计（采集配置+
图展示）。

### 现状

- **既有 dump 面**：`src/pyspyDump.ts`（IDE-PDBG-003）—— `py-spy dump` 把目标组件进程调用栈写进
  输出通道；含 pip 自动安装（本机未装 py-spy 时按解释器装，失败如实报）、ptrace 权限指引
  （`kernel.yama.ptrace_scope`=1 需 ptrace_scope=0 或 sudo/cap，容器 `--cap-add=SYS_PTRACE`）、
  spawn 超时组杀（`killProcessTree`）、`SpawnRunner` 注入面（`defaultSpawnRunner`）。
- **远程面（并发会话 IDE-PDBG-004/005 在途）**：`src/remoteConnection.ts:60`（py-spy 探测/安装/
  dump 经 ssh 跑远端）、`src/sshConfig.ts`（ssh 配置解析）、`src/remoteServerTree.ts`（本地/远端
  分派目标）、`src/remoteProcessList.ts:13`（复用 `defaultSpawnRunner`）。**PYSPY-001 的远程部分
  应复用此面，不重造**。
- **webview 既有模式**：`src/runtimeQueryWebView.ts`、`src/monitoringWebView.ts` 等——`randomNonce`
  自 `webviewSecurity`，JSON 安全形态过边界（bigint 转换等），`postMessage` 协议。
- **py-spy record 无既有引用**：仓库内无 `record`/`flamegraph`/`--duration`/`--rate` 引用——全新面。
  `py-spy` 本机不在 PATH（调研时刻）；record 调用形态按标准 CLI
  `py-spy record --format flamegraph --output <file> --pid <pid> --duration <sec> --rate <hz>`，
  **实现时须对已装版本验证 flag**（`--format` 值 `flamegraph|raw|speedscope`、`--native` 可选）。

### 建议形态

- **数据/控制面**：`src/pyspyRecord.ts`（新，沿 `pyspyDump.ts` 结构）——`pySpyRecord({ pid,
  outputPath, durationSec, rateHz })` 构建 `record` 命令；复用 `defaultSpawnRunner`/`SpawnRunner`
  注入与 ptrace 权限指引；`--format flamegraph` 输出 SVG。
- **定时采集**：`collectFlamegraph({ pid, durationSec, rateHz, intervalSec, count })` —— 跑
  `count` 次 record，每次 `durationSec` 秒，间隔 `intervalSec` 秒；结果逐次落
  `docs/../py-spy/` 或临时目录；可取消（复用取消令牌）。
- **傻瓜化默认**：duration 5s、rate 99Hz、interval 30s、count 3（提案，验收定案）。
- **UI**：新 webview `flamegraphWebView.ts`（沿 `runtimeQueryWebView` 模式）——采集配置表单
  （pid 复用既有组件选择器、duration/rate/interval/count）+ 火焰图 SVG 展示（webview 内嵌 SVG
  或打开浏览器）；一键采集。
- **边界**：远程分派（IDE-PDBG-004/005 在途）落地后，`pySpyRecord` 经 `remoteConnection` 的
  py-spy 分派面跑远端；**本项实现须等并发会话的远程面合入后再接**，先做本地面。
- **风险**：`py-spy record` 的 SVG 生成依赖 py-spy 版本；定时采集的进程生命周期（每组杀树）
  须复用 `killProcessTree` 防残留。

---

## 4. IDE-BOT-001 KBEngine 机器人框架支持与多机管理

**验收原文**：分析 kbe 自带 bot 框架（`kbe/src/lib/bot` 与 bot 脚本/实体，`createBot` 接口）
支持方式；能管理机器人（创建/启停/状态/数量）；能多台机器协同跑机器人（远程编排/汇总）；
形态待调研后定（是否走 Rust 核心编排 + TS 管理 UI）。

### 现状（引擎侧源码证据，`/home/cui/workspaces/kbengine/kbe/`）

- **bots 是独立可执行工具**：`src/server/tools/bots/`（构建产物 `bots` 二进制），非 lib/bot。
  入口 `main.cpp:59-63`（`g_componentType = BOTS_TYPE` → `kbeMainT<Bots>`）。
- **进程 = 一个机器人池**：`Bots : ClientApp`（`bots.h:40`）持 `CLIENTS clients_`
  （`bots.h:103-104`，`map<Channel*, ClientObject*>`）；每个机器人 = `ClientObject : ClientObjectBase`
  （`clientobject.h:20`），是标准 client_lib 客户端（TCP/KCP 收发器，loginapp→baseapp 握手链在
  `clientobject.cpp:132-411`、`clientobjectbase.cpp:604-652`）。
- **生命周期**：7 态 `C_STATE_INIT/CREATE/LOGIN/LOGIN_BASEAPP_CREATE/LOGIN_BASEAPP/PLAY/DESTROYED`
  （`clientobject.h:37-46`），转移在 `ClientObject::gameTick()`（`clientobject.cpp:446-498`）。
- **"createBot" 等价入口（无字面 createBot）**：计数驱动——
  - RPC `Bots::addBots`（`bots.cpp:321-341`，`bots_interface.h:48`）与 Python `KBEngine.addBots()`
    （`bots.cpp:344-389`）只累加 `reqCreateAndLoginTotalCount_/TickCount_/TickTime_`；
  - 实际实例化在 `CreateAndLoginHandler::handleTimeout`（`create_and_login_handler.cpp:37-62`），
    每 tick 按 `tickCount` 增量、`tickTime` 限速，`new ClientObject(prefix+cid+"_"+accountID++, ...)`
    （`create_and_login_handler.cpp:56-60`）。
- **配置**：`bots` 无自有 XML；配置来自 `res/server/kbengine_defaults.xml` `<bots>` 段
  （**833-902 行**，`entryScriptFile=kbemain`、`host=localhost`、`port_min=20013`、`defaultAddBots`
  `totalCount=10/tickTime=0.1/tickCount=5`、`account_infos.account_name_prefix=bot_`、
  `telnet_service.port=51000` 等）+ `kbengine.xml` 覆盖。CLI 仅 `--cid`/`--gus`（`kbemain.h:147-204`）。
- **Python 驱动**：C++ 驱动连接/状态机，Python 驱动游戏逻辑——入口 `scripts/bots/kbemain.py`
  （`bots.cpp:174-239` 导入），实体 `Account.py`（`class Account(KBEngine.Entity)`，SDK 模板
  `res/sdk_templates/server/python_assets/scripts/bots/`）。全局 `bots`（PyBots）可
  `len/keys/values/items`（`pybots.cpp:56-172`）。
- **多机协同（可行，非内建 master/slave）**：集群原语已存在——`tools/server/pycommon/Machines.py`
  `startServer/stopServer/killServer`（239-286，UDP 广播到 kbemachine 20086）、`queryAllInterfaces`
  （211）/`queryMachines`（225）；`src/server/machine/machine_interface.h:95-107`；
  `tools/server/pycluster/cluster_controller.py:48`（bots 列入组件枚举）；官方 guiconsole 已用
  `BotsInterface::onExecScriptCommand`/`queryWatcher`/`lookApp` 控 bots（guiconsoleDlg.cpp:601,1206）。
- **控制面（现成 RPC，无需改引擎）**：`BotsInterface`——`onExecScriptCommand`（任意 Python 执行，
  `bots_interface.h:40`、`bots.cpp:467-497`）、`addBots`（:48）、`queryWatcher`（:51）、`lookApp`
  （:34）、`startProfile`（:54）、`reqCloseServer/reqKillServer`（`bots.cpp:430-464`）；另 TelnetServer
  REPL（端口 51000）。

### 建议形态

- **进程编排（控制面生命周期，多机）**：复用 `Machines.py` 的 `startServer/stopServer/killServer`
  （`componentType=BOTS_TYPE`，每机一个 `cid` 兼作账号后缀，`targetIP=该机 kbemachine`）拉起/停止
  `bots` 进程；kode 侧包装 `tools/server/pycommon/`（kbemachine UDP 协议、组件发现已含）。
- **进程内机器人数量**：复用 `BotsInterface::addBots` / `KBEngine.addBots(total, tickCount, tickTime)`。
- **运行时遥控**：`onExecScriptCommand`（最通用，逐机器人/全局 Python）+ `queryWatcher`。
- **数据面（状态/数量）**：引擎无结构化 JSON API——kode 用 `onExecScriptCommand` 下发探测
  （`len(KBEngine.bots)`、`[(b.appID(), b.state) for b in KBEngine.bots]`）+ `queryWatcher` 聚合；
  面板渲染「机器人数/各机汇总」。
- **形态定案建议**：**TS 管理 UI（机器人管理面板）为主**；引擎侧 `Machines.py`/`BotsInterface` 已够
  创建/启停/状态/数量/多机拉起，**无需 Rust 核心编排、无需 fork 引擎**（细粒度"每机器人独立启停"
  才需引擎扩展 ClientObject stop/destroy RPC——非首期范围）。
- **依赖**：引擎源码路径（`kbengine/`，KBENGINE_ROOT 未设——实现须可配置引擎根）；`Machines.py`
  依赖 `kbe_res_path/kbe_bin_path` 参数。

---

## 5. IDE-DB-001 持久化字段数据库类型大小限制提示

**验收原文**：对 def/types.xml 持久化字段提示数据库类型/长度/上限（形态待调研后定）。

### 现状

- **引擎权威映射**（本源码树唯一映射表）：`EntityTableMysql::createItem()`
  （`kbengine/kbe/src/lib/db_mysql/entity_table_mysql.cpp:505-763`），按 `DataType::getName()` 产出列 DDL：
  - INT8→tinyint / INT16→smallint / INT32→int / INT64→bigint；UINT8..UINT64 同 +`unsigned`；
    FLOAT→float / DOUBLE→double；STRING/UNICODE→`varchar(@DATALEN@)`；PYTHON/PY_DICT/PY_TUPLE/PY_LIST/BLOB→blob。
  - VECTOR2/3/4→2/3/4 个 `float`（`CLIENT_NO_FLOAT` 时 `int`）列，列名 `sm_<i>_<item>`。
  - ARRAY→无父表列，建子表 `tbl_<entity>_<prop>`（元素列 `value`）。
  - FIXED_DICT→无父表列，展开为每持久键一列（键名带 FD 前缀逐级累加）。
  - ENTITY_COMPONENT→子表；ENTITYCALL→`syncToDB` no-op，**不建列**。
  - ⚠ docs 提及的 `property_mapping.cpp:231-304` 在本源码树**不存在**（find 无结果），
    是陈旧文档引用，**不可作为复刻依据**。
- **DatabaseLength 语义**：未声明=0（`entitydef.cpp:1114`/`datatype.cpp:2077`）；建表时 STRING/UNICODE
  `if (length<=0) length=255`（`entity_table_mysql.cpp:1829-1833`/`1899-1903`）；数字类型 length≤0 时
  移除 `(@DATALEN@)` 显示宽度（:1643-1655）。FIXED_DICT 键默认持久（`datatype.cpp:2065-2081`）。
- **无写死上限**：引擎无 VARCHAR/BLOB 硬上限；`SYSTEM_CHARSET_MBMAXLEN=3`
  （`db_interface_mysql.h:16-18`）仅用于「已存在列」长度比对，不约束建表。实际上限由 MySQL
  行 65535 字节决定：默认字符集 utf8mb4（`kbengine_defaults.xml:368`，代码回退 utf8
  `serverconfig.cpp:1125-1129`）→ 单列 VARCHAR 约 16383 字符（utf8mb4）/ 21845（utf8）。
- **kode 已有面**（IDE-RUST-008 已交付）：`crates/kode-server/src/database_schema.rs` 的
  `resolveDbTypeLabel`/`resolveEffectiveDatabaseLength`（Rust 权威）；TS 侧 `src/databaseSchemaCore.ts`：
  `SIMPLE_DB_TYPE_LABELS`(:182-201) 已覆盖标量/字符串/blob/ENTITYCALL，`resolveDbTypeLabel`(:1398)/
  `resolveEffectiveDatabaseLength`(:1403)/`expandColumnNames`(:1365) 已正确复刻 VECTOR `sm_N_` 与 FD 前缀。
- **缺口**：
  1. `SIMPLE_DB_TYPE_LABELS` 缺 VECTOR2/3/4、ARRAY、FIXED_DICT、ENTITY_COMPONENT → `resolveDbTypeLabel`
     回落成小写原名（如 "vector2"），与引擎实际不符。
  2. ENTITYCALL 在 TS 标成 'blob'，但引擎 `syncToDB` no-op **不建列**——标注误导。
  3. 无任何 UI 面展示这些（CodeLens/hover/诊断均无该提示）。

### 建议形态

- **提示载体**：Hover/CodeLens（信息级）为主，挂在 def/types.xml 持久字段或 `<DatabaseLength>` 节点上，
  展示「有效类型 · VARCHAR(N) · 字符集 · 默认/上限」。因省略 DatabaseLength 是合法写法，用**信息性**
  提示，非 warning。
- **诊断（error 级）**：仅当显式 `DatabaseLength > 上限`（按配置字符集字节宽折算）或受限类型非法时给。
- **映射数据面**：优先复用 Rust `resolveDbTypeLabel`/`resolveEffectiveDatabaseLength`；补全
  `SIMPLE_DB_TYPE_LABELS` 缺项（VECTOR2/3/4→float 多列、ARRAY/FIXED_DICT/ENTITY_COMPONENT→「子表/展开」、
  ENTITYCALL→「不建列」）。
- **字符集**：取 kode 配置（缺省 utf8mb4，与引擎默认对齐）；提示注明引擎内部用 `/3` 比对
  （`entity_table_mysql.cpp:42-43`）这一潜在不一致。
- **数字类型**：未声明→无显示宽度 `int`；声明 N→`int(N)`（:1643-1655）。

### 依赖

- 引擎源码路径（`kbengine/`，KBENGINE_ROOT 未设——实现须可配置引擎根）；`entity_table_mysql.cpp`
  权威映射表（:505-763）；字符集配置 `kbengine_defaults.xml:368`。

