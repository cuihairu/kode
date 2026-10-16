# kode 快速执行动作 与 属性→数据库设计（六条已拍板 2026-10-14 · 七项已代决 2026-10-15）


> 状态：**快速执行动作六条已拍板，四项决策已代决（见 1.7）；属性→数据库八条已拍板，2.4 三项已代决（SQL 模板两问 + MySQL 访问通道）**。代决依用户 2026-10-14 授权（待拍板设计可代拍板并标已代决），全部取本文「建议」首选项；**用户可推翻后回滚**，实现按推翻后口径调整。Marketplace 发布不在代决范围（红线，等用户明确说发版并给版本号）。本文是权威设计口径；实现须逐条对照，命名沿用本仓既有词，不造新词。
> 来源：用户 2026-10-14 多轮口径，已登记于 `todo.md`（带来源日期）。

## 现状（实现前先核对，别另起一套）

- **VSCode 扩展**（`.vsix`、`vscode:prepublish`）
- 已注册 **31 个命令**：含 `kbengine.server.start/stop/restart/showLogs`、`kbengine.database.simulate/exportSimulation`、`kbengine.logs.connect/disconnect/clear/showViewer`
- 已有 **`src/debugConfig.ts`**：`KBEngineDebugConfig` / `ComponentDebugConfig` / `DebugConfigFile`
- 已有 **`src/databaseSchema.ts`**（块19 数据库 Schema 查看）、**`src/databaseSimulator.ts`**
- 已有 1 个侧边栏 view + `view/title` 菜单 2 项

---

# 一、快速执行动作

## 1.1 已拍板的六条

1. **配置驱动动作注册**（方案 A）——动作由配置定义，**不硬编码进 `contributes.commands`**；加新动作**不改代码、不重打包**
2. **配置跟 KBEngine 工程走**，不跟编辑器走——动作是 KBEngine 工程属性（换人/换机随工程携带）。落点**复用既有 `kbengine_debug.json` 那套配置**（`debugConfig.ts` 已解析）
3. **路径绝不写死**——每人打开的目录不同，必须支持变量替换（`${workspaceFolder}` / `${env:XXX}` 等）
4. **按钮要能出现在面板上**——侧边栏 view 标题栏与编辑器右上角（`editor/title`）两处都要能挂
5. **首次安装自动扫描 `.bat` 自动生成配置**——装完即有用，不要求用户手写配置
6. **本地脚本范围已明确**：基本就是**启停服务器**与**导配置表**两类，扫描与配置模型按这两类设计，**不做泛化**

## 1.2 三类动作的执行后端（统一模型）

| 类型 | 执行方式 | 已有基础 |
|---|---|---|
| `command` | 调 VSCode 命令 | server.start/stop/restart 已有 |
| `script` | `child_process` 跑 bat（启停 / 导配置表） | 需新增 |
| `http` | `fetch` 打 HTTP（自研本地热更） | 需新增 |

KBEngine 自带热更新 → 走 `command`（可复用 server 那组）。

## 1.3 明确排除的两条边界

- **不用 `launch.json` 承载**：它只能启动 debug 会话，热更/跑脚本不是调试；语义错位。`debugConfig.ts` 的解析能力可复用，但不要把动作塞进 debug 配置类型。
- **不做"万能命令执行"**：动作是**白名单式**的（类型固定为 `command`/`script`/`http`），不开放任意 shell —— 那等于在编辑器里开任意执行入口。

## 1.4 首装自动扫描（细节为分析建议，未拍板）

- 扫描范围按**启停服务器 / 导配置表**两类的常见命名识别，命中即生成动作项
- **建议**：扫描结果**先提示用户确认再写入**配置文件，避免污染工程文件（未拍板，实现时按此做并在文档说明）

细节（2026-10-15 已代决取「建议」列，用户可推翻后回滚）：

| 细节 | 已代决 | 备选（未取） |
|---|---|---|
| 扫描范围 | 只扫 `${workspaceFolder}` 下一层 `.bat`，不递归 | 递归限深 2 层（会扫进 assets/ 与引擎源码树，噪音大） |
| 识别口径 | 命名词表：启停类 `start/stop/restart/boot/server`、导表类 `export/convert/导表`，命中即候选 | 全部 bat 都列给用户勾（无词表，候选多） |
| 去重 | 「绝对路径 + 类别」为键；配置已登记的路径不再生成；同路径命中两类只出一条 | 按动作名去重（重名易撞） |
| 扫描时机 | 激活且工作区是 KBEngine 工程时后台扫一次；**仅当配置里还没有任何动作时**弹确认清单（quick pick 多选，勾完写入）；用户取消后本工作区不再自动弹（memento 记忆） | 每次激活都提示（打扰） |
| 写入形态 | 写进 `kbengine_debug.json` 同套配置文件的新键（动作数组），逐条带来源注记（扫描生成） | 独立动作配置文件（与拍板 #2「复用既有配置」相悖，不推荐） |

## 1.5 变量替换与作用域（分析落档口径，随 1.7 #1-4 代决一并生效）

- **支持集（建议）**：`${workspaceFolder}`、`${workspaceFolder:Name}`、`${env:XXX}`——即拍板 #3 点名的两族，另加多根限定形态。**不支持** `${config:}` / `${command:}`（把动作耦合进编辑器状态，违背「工程属性」定位）；`${file}` / `${line}` 等编辑器变量也不进动作（动作是工程级，不随选区变）。
- **解析时机（建议）**：执行时解析，不在扫描/注册时解析——同一份配置换机打开仍按当次工作区解析，「路径绝不写死」由此落实。
- **作用域（建议）**：`${workspaceFolder}` 取包含 KBEngine 工程的那个根（与 `kbengine.assetsRoot` 发现链同源取值）；多根含多个 KBEngine 工程时取活动资源所在根，取不到回落首根并弹提示。
- **未知变量（建议）**：执行前校验，未知变量或解析失败 → 动作不执行、错误提示指明变量名；**不做静默空串替换**——空串会拼出错误路径，脚本类落到错误目录是危险行为。

## 1.6 错误处理与日志去向（2026-10-15 已代决取本节口径，用户可推翻后回滚）

- **破坏性动作确认（建议）**：热更/重启/停服类在动作配置加 `confirm: true` 才弹确认框，确认框带动作名与目标（脚本路径 / HTTP 地址）；**建议默认弹**，首装扫描生成的动作一律带 confirm。
- **统一流水出口**：OUTPUT 面板专用通道（命名「KBEngine 快速执行动作」，与「KBEngine HTTP 快捷请求」同形态）；每条流水含动作名、时间、结果（退出码 / HTTP 状态码）。
- **失败呈现**：OUTPUT 逐行流水 + 一次性错误弹窗（与 HTTP 请求同款「✗ 标记 + 错误弹窗」），不新增 webview。
- **`script` 后端**：bat 子进程跑，stdout/stderr 原样进流水；非零退出码即失败，退出码写进流水。启服类长跑脚本**不等待退出**，标记「已启动」后流水继续，停止入口复用既有 `kbengine.server.stop` 命令组。
- **`http` 后端**：非 2xx 即失败；超时上限建议 10 秒（本地热更不应更久），超时原因写明。
- **`command` 后端**：复用被调命令自身的报错路径，动作层不二次包装（避免双重提示）。
- **日志去向（建议）**：只进 OUTPUT 通道，不落日志文件——工程目录不新增文件污染；需要留档时整段复制（与发现报告同形态）。备选：可选开关落 `${workspaceFolder}/.kbengine/actions.log`（默认关）。

## 1.7 决策记录（已代决 2026-10-15，用户可推翻后回滚）

以下四项原「待拍板」，2026-10-15 由巡检依用户 2026-10-14 授权（待拍板设计可代拍板并标已代决）代决，全部取上文「建议」首选项。**用户可推翻后回滚**：推翻后改本表与对应小节，已实现部分按推翻后口径调整。

| # | 决策点 | 已代决 |
|---|---|---|
| 1 | 自动扫描的范围与时机 | 1.4 表「已代决」列（一层 `.bat` / 词表 / 路径+类别去重 / 仅无动作时提示确认 / 取消后 memento 记忆不再弹） |
| 2 | 扫描结果是否确认后写入 | quick pick 多选，用户勾完才写进配置 |
| 3 | 破坏性动作是否加确认 | 默认弹确认框（带动作名与目标）；首装扫描生成的动作一律 confirm |
| 4 | 动作失败的输出与日志去向 | OUTPUT 专用通道 + 一次性错误弹窗，不落文件 |

## 1.8 实现方案 · 数据结构（待用户确认后开工）

动作配置落在既有 `.kbengine/debug.json`（拍板 #2 同套配置文件），新增顶层键 `quickActions`，`debug` 段原样保留：

```json
{
  "version": "1.0.0",
  "debug": { "…既有调试配置，不动…" : 0 },
  "quickActions": [
    { "name": "start_server", "type": "script",
      "script": "${workspaceFolder}/start_server.bat",
      "background": true, "confirm": true,
      "source": "scan", "category": "server" },
    { "name": "重启 baseapp", "type": "command",
      "command": "kbengine.server.restart", "args": ["baseapp"],
      "confirm": true, "source": "manual" },
    { "name": "本地热更", "type": "http",
      "url": "http://127.0.0.1:9000/reload", "method": "POST",
      "confirm": false, "source": "manual" }
  ]
}
```

类型定义（`src/quickActionConfig.ts`）：

```ts
export type QuickActionType = 'command' | 'script' | 'http';      // 白名单,拍板 1.3
export type QuickActionSource = 'scan' | 'manual';                // 来源注记
export type QuickActionCategory = 'server' | 'export';            // 扫描识别类别

export interface QuickActionConfig {
  name: string;              // 显示名,必填
  type: QuickActionType;     // 必填,白名单外整条剔除
  command?: string;          // type=command 必填,VS Code 命令 id
  args?: unknown[];          // command 参数,原样透传(字符串项支持变量)
  script?: string;           // type=script 必填,支持变量
  cwd?: string;              // script 工作目录,支持变量,缺省工作区根
  background?: boolean;      // script 专用,缺省 false;true=不等待退出(启服类)
  url?: string;              // type=http 必填,支持变量
  method?: 'GET' | 'POST';   // http 专用,缺省 POST
  body?: string;             // http 专用
  confirm?: boolean;         // 执行前确认,缺省 true(代决#3 默认弹)
  source?: QuickActionSource;// 缺省 manual
  category?: QuickActionCategory; // 仅扫描生成时写
}
```

## 1.9 实现方案 · 接口与目录结构（待用户确认后开工）

新增文件（三个源 + 三个测试，均在受影响路径门禁内）：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `src/quickActionConfig.ts` | 纯函数层：配置解析校验、变量替换、词表分类、扫描条目构造 | `parseQuickActionConfigs(raw): { actions, invalidCount }`；`resolveActionVariables(text, folders): string`（未知变量 throw，指名变量）；`classifyBatchScript(fileName): QuickActionCategory \| null`；`buildScannedActions(candidates, workspaceRoot): QuickActionConfig[]` |
| `src/quickActionScanner.ts` | 一层 `.bat` 扫描（注入 `readDir` 便于测试，不直接碰磁盘 API） | `scanBatchScripts(workspaceRoot, readDir): BatchScriptCandidate[]`（`{path, category}`，去重键=绝对路径+类别） |
| `src/quickActions.ts` | `QuickActionManager`：动作清单 quick pick、三后端执行、确认框、OUTPUT 通道、首装扫描写入 | 类 `QuickActionManager(context, deps?)`；方法 `show()` / `run(action)` / `offerScanOnActivate()`；依赖注入 `deps.runScript` / `deps.runHttp`（默认真实现 `child_process.spawn` / `fetch`+10s 超时） |

修改文件：

| 文件 | 改动 |
|---|---|
| `src/extension.ts` | 注册命令 `kbengine.quickActions.show`（回调 `manager.show()`）；激活末尾 `manager.offerScanOnActivate()`；dispose 链 |
| `package.json` | `contributes.commands` 加 `kbengine.quickActions.show`（`Run Quick Actions`，图标 `$(run-all)`——Servers 视图标题栏已有 `kbengine.server.start` 占 `$(play)`，同栏不重复图标）；`menus.view/title` 挂 `view == kbengine.serverControl`；`menus.editor/title` 挂 `editorLangId == kbengine-def \|\| python \|\| xml`；`activationEvents` 补 `onCommand:` |
| `tests/extension.test.ts` | 装配一致性断言自动含新命令(`contributes.commands` ↔ 注册面),无需改列表；装配测试给的裸 context 没有 `workspaceState`，memento 缺省按「首次运行」处理（manager 侧容错，首装扫描只是提示，不该把激活链带崩） |
| `tests/quickActionConfig.test.ts` 等 | 新增（见 1.11） |
| `docs/guide/commands.md` `docs/guide/features.md` `docs/guide/configuration.md` | 新命令小节（docs 门禁强制）、工具面板清单、`.kbengine/debug.json` 的 `quickActions` 键说明与变量表 |

按钮两处落点（拍板 #4）：`view/title`（Servers 视图标题栏）+ `editor/title`（def/python/xml 编辑器右上角）；命令本体只有一个 `show`，弹出动作清单 quick pick，动作数量与内容全由配置驱动（方案 A：不逐动作硬编码 `contributes.commands`）。

## 1.10 实现方案 · 执行流程（待用户确认后开工）

`show()`：读配置 → 无动作则 info 提示（指路 `.kbengine/debug.json` 的 `quickActions` 与首装扫描）→ 有则 quick pick（label=名称，description=类型，detail=目标）→ 选中后 `run()`。

`run(action)`：
1. 变量替换（`script`/`cwd`/`url` 与 `args` 字符串项）：未知变量 → 错误弹窗指名变量，动作不执行（1.5 拒绝空串替换）
2. `confirm !== false`（缺省即弹，代决#3）→ modal 确认框「执行 <名称>：<目标>?」按钮「执行」；取消则中止
3. 按类型分发：`command` → `vscode.commands.executeCommand(command, ...args)`；`script` → 注入的 `runScript`（background=true 不等待退出，标记「已启动」）；`http` → 注入的 `runHttp`（非 2xx 失败，10s 超时）
4. 流水行进 OUTPUT 通道「KBEngine 快速执行动作」：`[HH:mm:ss] 名称 → ✓ exit 0` / `✗ exit 3` / `✗ HTTP 500`；script 的 stdout/stderr 原样进通道
5. 失败 → 一次性错误弹窗（动作名+原因）；`command` 后端复用被调命令自身报错，不二次包装

`offerScanOnActivate()`（激活期一次）：无工作区 → 返回；memento `kbengine.quickActions.scanDismissed` 为真 → 返回；配置已有动作 → 返回；扫描一层 `.bat` 零命中 → 返回；命中 → quick pick 多选确认（label=bat 名，description=类别）；空选/取消 → memento 记 true（此后不再自动弹）；勾选 → `buildScannedActions`（路径写 `${workspaceFolder}/x.bat` 变量形态；名含 `start/boot` → `background: true`；一律 `confirm: true`、`source: 'scan'`）→ 写回 `.kbengine/debug.json`（保留 `debug` 段，JSON 缩进 2）→ info 告知写入条数。

## 1.11 实现方案 · 测试计划（先补测试再写实现）

| 测试文件 | 覆盖 |
|---|---|
| `tests/quickActionConfig.test.ts` | 解析校验（三合法类型、非法 type/缺必填字段/字段类型错整条剔除并计数）；变量替换（`${workspaceFolder}`、`${workspaceFolder:Name}` 多根按名、`${env:XXX}`、未知变量抛错指名、嵌在路径中段）；词表分类（启停/导表词命中、大小写不敏感、不命中 null）；扫描条目构造（变量路径、start/boot→background、confirm/source/category 注记） |
| `tests/quickActionScanner.test.ts` | 注入目录读取：一层 `.bat` 收录、子目录与非 `.bat` 忽略、同文件命中两类只出一条（启停优先）、空目录、路径拼接 |
| `tests/quickActionManager.test.ts` | show（无动作提示/quick pick 取消/选中执行）；run（三后端各成败臂、background 不等待、confirm 缺省弹与 false 跳过、确认取消、未知变量中止、失败进通道+错误弹窗、stdout/stderr 进通道）；offerScanOnActivate（无工作区/已记忆取消/已有动作/零命中/多选确认写入且保留 debug 段/取消记 memento）；dispose |
| `tests/extension.test.ts` | 命令扫描补一行；`makeContext` memento |

覆盖率保持仓门禁 100%×4（三后端与文件 IO 全部经注入/内存 fs，无不可达防御臂）。

---

# 二、属性 → 数据库

## 2.1 已拍板的八条

1. **属性上提示它在数据库里是什么字段**
2. 点击跳转到**根据属性虚拟生成的数据库表设计**
3. **快速生成查询语句**，方便拿去**其他 MySQL 客户端**查询
4. **提示必须带表名**：给出完整 `db.table.column`，粘贴即用，不要只给列名
5. **必须读源码取大小限制**：类型在数据库中的大小限制**从 KBEngine 源码读出**，不能猜
6. **XML 配置的限制要显示具体数值**：def/xml 里配了限制（如长度上限）就显示该数值，不是只说"有限制"
7. **ARRAY/容器属性跳对应子表**：容器属性不在主表，提示说明去向，跳转直接落到正确的子表
8. **MySQL 连接直接读配置获取**：连接信息不必手填，**直接读 KBEngine 自身配置**（库地址/端口/账号/库名）

## 2.2 校验闭环（本设计的关键价值）

```
def 属性 ──推导──► 虚拟表结构 ──对比──► 真实表结构（读 MySQL）
                        │
                        └──► 不一致即报告漂移
```

**真实表结构可反向校验虚拟表结构**：既然连接能读到，就取真实表结构，校验由 def 推导的虚拟表，**发现不一致并报告**。

这条同时兜住了最大风险——**属性→字段映射若算错**（哪些属性进表、类型映射、容器拆子表、列名转换），会在这里被暴露，而不是让用户拿着错 SQL 去查不到数据。

附带价值：真实库无此表 = 该实体尚未走过建表流程；库有而 def 无 = 删属性后的残留表。

## 2.3 实现前必须先核对的映射规则

| 规则 | 说明 |
|---|---|
| 哪些属性进表 | 不是所有属性都落库，**`Persistent` 标记是关键** |
| 类型映射 | def 的 `UINT8`/`STRING`/`ARRAY`/`PY` → MySQL 列类型 |
| 容器拆表 | KBEngine 对数组通常建**子表**，这是最容易提示错的地方 |
| 列名转换 | 大小写、保留字、特殊字符是否转义 |

**要求**：`src/databaseSchema.ts` 与 `src/databaseSimulator.ts` 已有基础，**先核对可复用多少，不许另起一套映射规则**。

## 2.4 决策记录（已代决 2026-10-15，用户可推翻后回滚）

- SQL 模板覆盖范围：**JOIN（按 parentID）与按 Persistent 过滤都加**（提示批的最小 SELECT 保留）——已代决（巡检，2026-10-15）
- 自定义库表前缀：**支持可选配置**，缺省空 = 沿用引擎默认 `tbl_`；设了则 SELECT/JOIN 模板与 schema 视图表名同源替换——已代决（巡检，2026-10-15）
- 2.2 漂移校验的 MySQL 访问通道：**mysql2 npm 依赖**（不要求本机装 mysql 客户端；动 package.json，按门禁跑全套测试）——已代决（巡检，2026-10-15）

---

# 三、telnet

## 3.1 缺陷：连接后窗口无法输入

- 现象：telnet 连上 KBEngine 后**窗口无法输入**
- 要求：先复现并给根因 `file:line`。重点怀疑：输入焦点未落到会话、输入框未绑定该会话、PTY/流未接管输入、UI 状态机未切到"已连接"分支
- 提示：已有 `kbengine.logs.connect/disconnect/clear`；若 telnet 走同一套终端组件，**先核对连接成功后输入通道是否被接管**，别另起终端实现
- 修复后在**真实连接下**验证：能输入命令且收到回显

## 3.2 配套需求：退出快捷键

- 支持 **`Ctrl+]`**（telnet 标准转义符）与 **`Ctrl+D`** 退出
- **顶部同时给出入口**（快捷键 + 顶部菜单/按钮），不要只做快捷键——用户需要在顶部能看到并点击

---

# 四、实现顺序与批次（2026-10-15 更新：telnet 两项已交付 b2394ba，余下按此推进）

1. **快速执行动作**（1.8-1.11，方案落档待用户确认后开工）
2. **SQL 模板扩展 + 自定义前缀**（批B 简案见 4.1）
3. **MySQL 漂移校验**（批C 简案见 4.2；动 package.json → 全套门禁）

每步按本仓门禁：改动范围跑测试，全绿再推；单 commit 英文简短，rebase 后推，不打 tag。

## 4.1 批B 简案 · SQL 模板扩展 + 自定义前缀（已代决，方案待确认）

- `src/databaseSchema.ts`：在既有最小 SELECT 模板旁加两路模板——**子表 JOIN**（主表 `tbl_<Entity>` 按 `parentID` 关联子表 `tbl_<Entity>_<Property>`，取子表列集）与 **Persistent 过滤列集**（只列 `Persistent=true` 属性对应的列）；模板随 schema 视图行与悬停 SQL 一并产出
- 新增可选配置 `kbengine.db.tablePrefix`（string，缺省空 = 引擎默认 `tbl_`，出处 entity_table_mysql.cpp）；设了则 SELECT/JOIN 模板与 schema 视图表名同源替换（同一取值函数，不两处各写）
- 测试：`tests/databaseSchema.test.ts` 补 JOIN/过滤/前缀三组用例（前缀空=现状锁定、设值=全模板替换一致）
- docs：`docs/guide/database-schema.md`（若存在该名，以实际文件为准）与 `docs/guide/configuration.md` 补配置与模板说明

## 4.2 批C 简案 · MySQL 漂移校验（已代决 mysql2，方案待确认）

- 依赖：`package.json` 增 `mysql2`（dependencies，pnpm 安装；动依赖清单 → 跑全套门禁）
- 新增 `src/databaseDrift.ts`：查询执行器接口注入（`runQuery(sql): Promise<{columns: …}>`），默认实现 mysql2 连接——连接要素复用提示批已做的引擎配置读取（`<dbmgr><databaseInterfaces><default>`，dbmgr 端口 0→3306）；不真连即可测试
- 对比口径：虚拟表（复用 databaseSchema 推导，不另起映射——2.3 铁律）逐表对比真实 `SHOW COLUMNS`：列缺失/列多余/列型别不符三类漂移；真实库无表=未建表；库有 def 无=残留表；产出清单进输出面板 + schema 视图状态行
- 新命令 `kbengine.database.checkDrift`（title `Check Database Drift`）；docs/guide 三件套同步
- 测试：`tests/databaseDrift.test.ts`（注入查询执行器：一致/列缺失/列多余/型别不符/无表/残留/连接失败如实报错）；`package.json` 命令清单一致性由既有 docs 门禁锁

## 4.3 提交计划

- 批A 一个 feat commit（源+测试+package.json+docs 门禁三件）+ 一个 docs commit（todo 勾稽带 hash+测试数）
- 批B、批C 各自同构；批C 因动依赖清单跑全套（vitest coverage + lint + docs:build + compile + mocha smoke）
- Marketplace 发布不在此列（红线，等用户明确说发版并给版本号）
