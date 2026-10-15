# Kode - 已完成功能列表

**版本**: 0.1.0（版本号冻结，发版由用户手动触发）
**状态**: 核心功能已完成
**总代码行数**: 28856 行（src/ TypeScript，实测）
**文件数量**: 47 个 TypeScript 文件（不含 src/test 烟测）

---

## 已完成功能 (27 个)

### 1. 语法高亮
- `.def` 整体委托内建 XML 语法 (text.xml) 着色：标签蓝、属性名浅蓝、标点灰、字符串橙，`<` `>` 参与括号配对着色，块注释 `<!-- -->`
- 引擎语义叠加（用户口径）：`Properties`=玩家属性(琥珀)、`BaseMethods`=BaseApp 可远程调用(绿)、`CellMethods`(青)、`ClientMethods`=回调客户端(紫)四区块粗体，`Exposed` 红、`Persistent` 橙、Flags 值如 `BASE_AND_CLIENT`(蓝)；全部对背景 ≥4.5:1 对比度
- 类型值/DetailLevel 值不再有专属着色（委托 XML 后为普通文本，对齐由诊断与补全承担）
- **源文件**: `syntaxes/kbengine.tmLanguage.json` + `syntaxes/kbengine-color-theme.json` + `language-configuration.json`

### 2. 智能提示 (IntelliSense)
- 类型自动补全
- Flags 智能提示
- DetailLevel 提示
- XML 标签提示
- 钩子方法自动补全 (36 hooks,全部带源码调用位置)
- **源代码**: `src/languageProviders.ts` (KBEngineCompletionProvider)

### 3. 代码片段
- 11 个常用模板(.def)+ 4 个 Python 热更模板(snippets/kbengine-python.json)+ 2 个 types.xml 类型别名模板
- kbe-prop, kbe-vector3, kbe-array(引擎 ARRAY/<of> 语法)等 def 模板
- types.xml 专用: kbe-fixed-dict / kbe-array-alias(TUPLE/内联 FIXED_DICT 无引擎源码依据,已剔除)
- kbe-prop-db, kbe-prop-detail
- kbe-client-method, kbe-base-method, kbe-cell-method, kbe-method-multi
- 热更(Python): kbe-hot-reload-entity, kbe-hot-reload-script, kbe-hot-reload-best-practice, kbe-is-reload
- **源文件**: `snippets/kbengine.json`(11) + `snippets/kbengine-python.json`(4) + `snippets/kbengine-types-xml.json`(2)

### 4. 悬停文档
- 类型详细说明
- Flags 用途解释
- 钩子完整文档（调用时机、函数签名、使用示例、源码位置）
- **源代码**: `src/languageProviders.ts` (KBEngineHoverProvider)

### 5. 跳转定义
- 从 entities.xml 跳转到 .def 文件
- **源代码**: `src/languageProviders.ts` (KBEngineDefinitionProvider)

### 6. 语法检查
- 实时语法验证
- 源码可证实的 Flags / DetailLevel / 必填字段校验
- 类型有效性检查
- **源代码**: `src/languageProviders.ts` (validateDocument)

### 7. 实体浏览器
- 侧边栏显示所有实体
- 实体类型标识（Cell/Base/Client）
- 快速导航到 .def 文件
- 混入接口面按引擎装载口径解析（`<Interfaces>` 只认 `interface`/`Interface`/`type`/`Type` 四拼写 wrapper，直取形态引擎静默跳过、浏览器不展示；批117 与 defRenamer 收敛为同一实现）
- **源代码**: `src/explorerProviders.ts` (EntityExplorerProvider)

### 8. 钩子系统
- 36 个 KBEngine 实体脚本回调（全部经引擎源码逐条核实）
- 10 个分类：生命周期、数据库与归档、移动、空间、传送、陷阱、Cell、视野、控制权、客户端
- **源文件**: `src/hooks.ts`

### 9. 热更新支持
- 4 个热更新代码片段(snippets/kbengine-python.json,贡献给 python 语言)
- KBEngine.reloadScript() 智能提示
- importlib.reload() Python 脚本热更新
- 重载相关悬停文档和示例
- **源代码**: `src/kbengineMetadata.ts`, `src/languageProviders.ts`
- **源文件**: `snippets/kbengine-python.json`

### 10. 服务器管理
- 10 个组件管理（machine, logger, dbmgr, baseappmgr, cellappmgr, loginapp, baseapp, cellapp, bots, interfaces）
- 启动/停止/重启控制
- 实时状态显示（停止/启动中/运行中）
- 进程 PID 显示
- 组件独立日志输出
- 状态栏集成
- **源文件**: `src/serverManager.ts`

### 11. 日志查看集成
- logger 连接入口与状态说明
- 日志解析器（文本和二进制格式）
- WebView 可视化界面
- 多级过滤（级别、组件、关键词）
- 正则表达式搜索
- 日志导出（txt/log/json）
- 彩色日志级别显示
- **源文件**: `src/logCollector.ts`, `src/logParser.ts`, `src/logWebView.ts`

### 12. Python 调试支持
- 自定义调试配置（.kbengine/debug.json）
- 组件特定调试设置
- 自动生成 launch.json 配置
- 支持启动调试和附加到进程
- 路径映射和环境变量
- **源文件**: `src/debugConfig.ts`

### 13. 监控面板
- 基于 machine + watcher 的运行态监控
- CPU、内存、实体数量与已核实 watcher 指标展示
- 系统概览卡片
- 组件详细指标卡片
- 可视化图表（Chart.js）
- 数据导出（JSON）
- **源文件**: `src/monitoringCollector.ts`, `src/monitoringWebView.ts`

### 14. Python [Def 双向跳转]
- 实体定义映射管理器
- 从生成的 Python 文件跳转回 .def 定义
- Python 文件智能提示（自动补全属性和方法）
- 自动扫描和建立映射关系
- 支持多个 Python 生成路径配置
- **源文件**: `src/entityMapping.ts`

### 15. 实体依赖关系图
- 自动分析实体继承关系
- 可视化实体依赖图（使用 Mermaid.js）
- 显示 Base/Cell/Client 实体类型标识
- 统计信息面板（实体数量、最大深度、最常引用实体）
- 从图跳转到实体定义文件
- 支持导出图表（PNG/SVG 格式）
- **源文件**: `src/entityDependency.ts`, `src/entityDependencyWebView.ts`

### 16. 代码生成器
- 实体创建向导（逐步引导）
- 10 个预定义模板（账号、角色、NPC、物品、怪物、场景、公会、队伍、邮件、空实体）
- 自动生成 .def 文件（符合 KBEngine XML 格式）
- 自动生成 Python 文件（包含钩子方法）
- 自动在 entities.xml 中注册实体
- 支持自定义属性和方法定义
- **源文件**: `src/codeGenerator.ts`

### 17. 重构支持（.def 属性/方法重命名）
- .def 文件内 F2 重命名属性或方法，自动更新定义与引用（原生 RenameProvider，无需命令）
- 符号解析：顶层 `Properties` 的属性（同名全部 Flags 作用域变体视为同一文本符号——引擎按 cell/base/client 三域分立建条目、同域同名复述即装载失败，改名不改变装载合法性）与 Base/Cell/Client 方法段的方法（段是命名空间，跨段同名互不相干）
- 引用面：同文件同名声明 + 后代 def 的同名复述，传播边对齐引擎装载路径（批96 引擎复核）：`Parent`/接口名取元素首个子节点（文本取文本、元素取标签名，同引擎 getKey；混合内容只看首子节点，换行缩进得空名不产生边）；实体父类解析到定义根、组件 def 的 Parent 在 components/ 内、接口固定 interfaces/ 子目录；接口文件不读 Parent（引擎 loadInterfaces 不走 loadParentClass）；`<Interfaces>` 只认 interface/Interface/type/Type 四种 wrapper 拼写，直取形态（如 `<MoveIface/>`）引擎不装载、不产生传播边；开标签与闭标签名字同步更新
- 定义根定位从目标文件向上找 `entities.xml` 推导（KBEngine 常规布局），无需打开工作区
- **如实边界**：
  - 仅覆盖 .def 定义与引用面；Python 侧 `self.x` / 方法调用、entities.xml、types.xml、数据库 schema 虚拟文档与资源管理器引用**不在**重命名范围
  - 在复述处发起重命名只更新该文件与其后代，不会回改祖先源头声明（按声明点向下传播）
  - 嵌套结构（FIXED_DICT 内层字段等）不是独立符号；找不到 entities.xml 时退化为仅同文件；非法新名（非 C 风格标识符）或与原名相同拒绝执行
  - 新名与既有方法/属性/组件同名不做装载校验（引擎侧为装载错误，可由功能 18 的同名检查项提示）
  - 文件枚举覆盖定义根整树（含未在 entities.xml 登记的 def），面向"会被编辑的文件"而非"本轮被装载的文件"
- **源文件**: `src/defRenamer.ts`（纯逻辑）、`src/languageProviders.ts`（KBEngineRenameProvider）

### 18. 性能分析建议（.def 静态分析）
- 工作区全量 `.def` 静态检查，命令面板 `Analyze Def Performance`（`kbengine.def.analyze`，批91）
- 7 个检查项（幻影类型/缺 Type/重复 Type/重广播开销/冗余 DetailLevel/Python 关键字标识符/方法属性同名），均为优化建议、与实时诊断错位；批96 引擎复核后各检查口径对齐源码（客户端可见旗标取 `ENTITY_CLIENT_DATA_FLAGS` 位集真值，装载失败类检查按引擎行为表述，关键字按"引擎不失败、脚本语法不可访问"表述，重复 `<Type>` 按引擎首取语义表述）；批99 增第 8 项引擎受限名，批116 增第 9 项继承链跨文件同名（`inherited-name-collision`，闭包口径与重命名传播一致）
- 报告写入「KBEngine Def 分析」输出面板，诊断落 `kbengine-def-analysis` 问题列表
- 如实边界：单文件同名检查只比本文件；继承链上的跨文件同名由 `inherited-name-collision` 覆盖（闭包沿 `Parent` 首边与 `<Interfaces>` 混入展开，与引擎 `loadParentClass`/`loadInterfaces` 装载路径同径；接口文件自身的 `Parent` 不产生边，对齐引擎 `loadInterfaces` 不走 `loadParentClass`）
- **源文件**: `src/defAnalyzer.ts`

### 19. 代码片段生成器（自定义代码片段）
- 选区生成自定义片段，命令面板 `Generate Snippet from Selection`（`kbengine.snippets.generateFromSelection`，批94）
- 片段语法转义（`$`/`\`）+ 公共缩进剥离，合并写入 `.vscode/kbengine-custom.code-snippets`，scope 取当前文档语言
- 同名条目覆盖有警告；手改出注释/坏 JSON 的片段文件拒绝改写并提示
- 片段文件读/写 IO 失败（权限、路径被目录/文件占位等）以错误提示呈现并带文件路径，不裸抛给宿主（批100）
- **源文件**: `src/snippetGenerator.ts`

### 20. Telnet 探测与会话联动
- 状态栏 + 服务器控制面板状态灯:已连接/已开启·未配密码/密码被拒/未开启/未配置,点击灯开面板
- 目标解析三级:设置项(kbengine.telnet.host/port)显式指定 → kbengine.xml `<telnet_service>` 段(经 kbengine.telnet.configXmlPath)→ 引擎七组件默认端口表;探测低频(默认 5s,单端口 1.5s 超时,探完即毁不占连接)
- 端口开启自动握手登录:密码走配置、只经 socket 提交,不进输出/日志面;引擎 PASSWD 态重提示识别为「密码被拒」如实亮灯
- 面板活化:命令输入走 enableCommands 白名单 ∪ 内置只读快捷命令(`:quit` 关停服务端进程,两层恒拒);快捷命令钮(实体数量/实体清单前50/全局数据键/帮助);输出流回显(上限 500 行)
- 未开启时面板如实提示并附 kbengine.xml `<telnet_service>` 开启配置片段,不空转;断线状态翻转提示、可重连,掉线不崩面板
- 批104:三层架构(协议客户端/服务/面板)依赖全注入,真 TCP localhost 仿真三态握手全测;重连竞态缺陷由测试咬出修复
- **源文件**: `src/telnetClient.ts`、`src/telnetService.ts`、`src/telnetWebView.ts`

### 21. HTTP 快捷请求
- 设置 `kbengine.httpRequests` 列表:名称/URL 模板/method/请求头/请求体/启停/键位展示串;内置示例一条(默认停用,与 package.json 默认值由测试锁同步)
- 模板变量四枚(URL/请求体/请求头值通用,按字面替换、不做 URL 编码):`${module}`(工作区相对模块路径 `entities/fight/FightAI.py` → `entities.fight.FightAI`,不在工作区退文件名去 `.py`)/`${file}`/`${line}`(光标行 1 起)/`${sel}`;无活动编辑器各值如实空串
- 触发两路:命令面板 quick pick(显示 method URL 与键位详情)或为 `kbengine.httpRequest.run` 配 `args.name` 键位直发(VS Code 无运行时注册键位 API,经 keybindings.json 绑定,文档附示例)
- 执行流水进 OUTPUT「KBEngine HTTP 快捷请求」:`▶` 请求行 → `✓` 状态·耗时·回包(超 4000 字符截断标注全长);失败 `✗` 标记+错误弹窗(OUTPUT 通道无着色 API,engines 1.50 基线,不做红色字面)
- 默认 transport 走 node http/https:URL 解析与协议守卫、超时到点中止(默认 10s)、大回包接收窗口 16KB 截顶;连接拒绝/响应中断/超时如实回执不悬挂
- 批105:三层架构(纯逻辑/服务/装配)依赖全注入,真 TCP localhost 仿真全测(成功/POST 体/ECONNREFUSED/坏 URL/ftp 协议/大回包分块截顶/响应中断/超时)
- **源文件**: `src/httpRequests.ts`、`src/httpRequestService.ts`

### 22. 最终配置视图
- 服务端配置三层合并（本地 `kbengine.xml` → 组件 `kbengine.xml` → 引擎 defaults）后的最终生效视图，字段悬浮可看作用说明；`kbengine.autoRefreshFinalConfig` 默认开，defaults 或元件 `kbengine.xml` 保存后自动重算
- **源文件**: `src/serverConfigMerge.ts`、`src/serverConfigHover.ts`

### 23. 数据库 Schema 查看器
- 按 `Persistent` 属性与 `types.xml` 别名链展开建表语义（表前缀 `tbl_`、`sm_<name>` 列、`VECTOR2/3/4` 三展开列、`FIXED_DICT` 键链、`ARRAY` 子表），以 `kbengine-db-schema:` 虚拟文档展示完整建表 SQL
- **源文件**: `src/databaseSchema.ts`

### 24. kbe 模块符号桩导航
- 引擎 C++ 侧 kbe 模块符号桩索引，为引擎内建符号（无对应声明文件）提供导航与补全落点
- **源文件**: `src/kbeModuleIndex.ts`

### 25. 数据库模拟
- 在 schema 快照之上模拟行数据与增改删预览：`.dbsim` 虚拟文档一体展示 DDL、模拟行 JSON、INSERT 语句与引擎差异清单；写库语义对齐引擎 MySQL 后端（dbid>0 走 UPDATE、子表行 parentID、`sm_autoLoad` 首写 0 已有 -1、UNIQUE 仅 MySQL 索引判定）
- **源文件**: `src/databaseSimulator.ts`

### 26. 配置自动发现
- 路径类配置零配置可用：显式配置 → 约定布局 → 有界深扫描（限深 7 层/2 万条目，剪 `node_modules`/`.git`/`out`/`dist`）→ 唯一命中即用，多候选激活期弹一次 quick pick 并按工作区记忆；`types.xml`、`messages_fixed(_defaults).xml`、引擎 defaults 源码根兜底纯发现无配置项；`pythonOutputPath` 为默认值时从发现出的 def 根推导
- **源文件**: `src/workspaceDiscovery.ts`

### 27. RPC 方法标记
- Python 实现脚本里，方法名命中实体 def 方法声明（`BaseMethods`/`CellMethods`/`ClientMethods`）的函数在声明行上方出一行可点 CodeLens（`RPC · <区块> · [Exposed ·] <来源 def 文件名>`），点击跳回 def 声明行；未在 def 声明的普通函数不出 lens。按方法名匹配，同名辅助函数也会出 lens（边界见语言能力页）
- **源文件**: `src/rpcCodeLens.ts`

### 28. def 图形化架构流程图
- `kbengine.flow.show` 打开 webview，展示一个实体从客户端到 baseapp/cellapp 的方法调用与属性自动同步关系：边上按属性 Flags 位标注语义并逐边列出引擎出处（文件:行号）与成员声明位置，点击成员行回跳 `.def` 声明处；未 `Exposed` 的 `BaseMethods` 单列「客户端调不到的方法」；刷新重读磁盘上的 def/entities.xml；导出 Markdown（直写文件）与 SVG/PNG（经 webview 渲染导出）。实体名缺省取活动 `.def` 编辑器
- **源文件**: `src/entityFlowGraph.ts`、`src/entityFlowWebView.ts`

### 29. 快速执行动作
- `kbengine.quickActions.show`（`Run Quick Actions`；Servers 视图标题栏按钮 + def/Python/XML 编辑器标题栏按钮）执行工作区 `.kbengine/debug.json` 顶层 `quickActions` 数组定义的动作清单——跟着 KBEngine 工程走，不进 VS Code 设置、不进 `launch.json`。三类白名单后端：`command`（VS Code 命令 id + `args` 原样透传）、`script`（执行配置显式声明的脚本，`background: true` 起服类不等退出码）、`http`（只请求配置写死的 URL，不接受运行时拼接）；不提供任意 shell 执行入口。路径变量 `${workspaceFolder}`/`${workspaceFolder:名字}`/`${env:变量名}` 执行期替换，未知变量报错中止并指名变量（不静默空串替换）。动作缺省弹 modal 确认（`confirm: false` 跳过），流水进 OUTPUT 面板「KBEngine 快速执行动作」并原样留 stdout/stderr，失败一次性弹窗（动作名 + 退出码/状态码/原因）；非法配置条目逐条剔除并计数，不整表失败。首装扫一层工作区根的 `.bat`，命中「启停服务器 / 导配置表」词表的多选登记，取消后本工作区不再自动弹
- **源文件**: `src/quickActions.ts`、`src/quickActionConfig.ts`、`src/quickActionScanner.ts`

### 30. SQL 模板扩展与自定义表前缀
- 容器属性不落主表，故在既有最小 SELECT 之外补两路模板：按 `parentID` 关联子表的 `LEFT JOIN`（`tbl_<Entity>_<Property>`，保住空元素的属性行）与只列 `Persistent=true` 属性的列集；子表 JOIN 同样出现在 ARRAY/组件属性的悬停行里。新增可选配置 `kbengine.db.tablePrefix`（缺省空 = 沿用引擎默认 `tbl_`，出处 `entity_table_mysql.cpp`），SELECT/JOIN 模板与 schema 视图表名走同一取值函数替换，两处不各写一份；不改前缀的工程留空即行为不变
- **源文件**: `src/databaseSchema.ts`

### 31. 数据库漂移校验
- `kbengine.database.checkDrift` 拿真实 MySQL 表结构反向校验由 `.def` 推导的虚拟表结构——哪些属性进表、类型映射、容器拆子表、列名转换四段映射算错时唯一能暴露的地方。逐表报五类：缺表（该实体或容器属性未走过建表流程）、缺列（属性新增后未同步建表）、多列、型别不符（显示宽度差异不计：`bigint unsigned` ≡ `bigint(20) unsigned`）、残留表（属性删了表还留着）。报告整段写进 OUTPUT 面板「KBEngine 数据库漂移」可整段复制回传，有问题弹警告、无漂移弹信息提示。连接信息直读 KBEngine 引擎配置（合成后的 `<dbmgr><databaseInterfaces><default>`，端口 `0` → 3306），不新增任何设置项；账号密码需明文存放（`<encrypt>false</encrypt>`），引擎默认 RSA 密文读不出明文时如实降级「未校验」而非报错。只读双保险：语句白名单只放行 SELECT/SHOW/DESCRIBE/EXPLAIN（INSERT/UPDATE/DELETE/DDL/GRANT/TRUNCATE/多语句一律拒绝并说明原因）+ 建连即 `SET SESSION TRANSACTION READ ONLY`，即便读到的配置是读写账号也写不进去
- **源文件**: `src/databaseDrift.ts`

---

## 项目结构

```
kode/
├── src/                          # 47 个 TypeScript 文件，28856 行
│   ├── extension.ts              # 扩展入口（命令装配/注册面）
│   ├── languageProviders.ts      # 补全/悬停/诊断/跳转/重命名 Provider
│   ├── defParser.ts              # .def 解析与文本定位
│   ├── defRenamer.ts             # .def 重命名纯逻辑
│   ├── defAnalyzer.ts            # 性能分析静态检查
│   ├── snippetGenerator.ts       # 自定义片段生成纯逻辑
│   ├── definitionSemantics.ts    # 定义语义与继承合并
│   ├── definitionWorkspace.ts    # 定义工作区解析
│   ├── databaseSchema.ts         # 数据库 schema 虚拟文档
│   ├── databaseSimulator.ts      # 数据库行模拟(纯逻辑+虚拟文档提供器)
│   ├── explorerProviders.ts      # 树视图与导航
│   ├── kbengineMetadata.ts       # KBEngine 元数据
│   ├── kbengineProtocol.ts       # machine 发现与 watcher 协议编解码
│   ├── hooks.ts                  # 钩子数据 (36 hooks,含源码调用位置)
│   ├── serverManager.ts          # 服务器管理器
│   ├── serverCommandTarget.ts    # 服务器命令目标解析
│   ├── serverConfigHover.ts      # 服务端配置字段悬浮
│   ├── serverConfigMerge.ts      # 服务端配置三层合并
│   ├── logCollector.ts           # 日志收集器
│   ├── logParser.ts              # 日志解析器
│   ├── logWebView.ts             # 日志 WebView
│   ├── debugConfig.ts            # 调试配置管理器
│   ├── monitoringCollector.ts    # 监控数据收集器
│   ├── monitoringWebView.ts      # 监控面板 WebView
│   ├── navigationLog.ts          # 导航流水日志
│   ├── entityMapping.ts          # Python-Def 映射管理器
│   ├── kbeModuleIndex.ts         # kbe 模块符号桩索引(导航/补全)
│   ├── pythonLanguageUtils.ts    # Python 补全上下文工具
│   ├── rpcCodeLens.ts            # RPC 方法标记 CodeLens 纯逻辑
│   ├── entityDependency.ts       # 实体依赖分析器
│   ├── entityDependencyWebView.ts # 依赖图 WebView
│   ├── codeGenerator.ts          # 代码生成器 (10 模板)
│   ├── workspacePath.ts          # 跨平台路径工具
│   ├── workspaceDiscovery.ts     # 工作区自动发现(纯逻辑)
│   ├── telnetClient.ts           # KBEngine telnet 协议客户端
│   ├── telnetService.ts          # telnet 探测/会话服务
│   ├── telnetTree.ts             # telnet 独立树视图
│   ├── telnetWebView.ts          # Telnet 面板 WebView
│   ├── httpRequests.ts           # HTTP 快捷请求纯逻辑(条目解析/模板变量)
│   ├── httpRequestService.ts     # HTTP 快捷请求执行层(transport/流水)
│   ├── messageTable.ts           # 网络包结构生成(属性/方法/槽位占号)
│   ├── entityFlowGraph.ts        # def 架构流程图纯逻辑(边语义/Flags 出处)
│   ├── entityFlowWebView.ts      # 架构流程图 WebView
│   ├── quickActionConfig.ts      # 快速执行动作纯层(解析/变量/词表)
│   ├── quickActionScanner.ts     # 快速执行动作首装扫描纯层
│   ├── quickActions.ts           # 快速执行动作装配层(三后端/扫描写入)
│   ├── databaseDrift.ts          # 数据库漂移校验(只读白名单/比对报告)
│   └── test/                     # mocha 编译产物烟测 (11 用例)
├── syntaxes/
│   ├── kbengine.tmLanguage.json  # 语法高亮规则
│   └── kbengine-color-theme.json # 主题
├── snippets/
│   ├── kbengine.json             # def 代码片段 (11个)
│   ├── kbengine-python.json      # Python 热更片段 (4个)
│   └── kbengine-types-xml.json   # types.xml 类型别名片段 (2个)
├── tests/                        # vitest 测试 (120 文件 1872 用例)
└── package.json                  # 扩展配置
```

---

## 统计数据

| 指标 | 数量 |
|------|------|
| TypeScript 文件 | 47 个（src/，不含 src/test，实测） |
| 钩子数量 | 36 个 |
| 代码片段 | 11 def + 4 Python + 2 types.xml |
| 预定义实体模板 | 10 个 |
| 文档页数 | 28 个 Markdown（根 9 + docs/ 16 + resources/docs 3） |
| 总行数 | 28856 行（src/ TypeScript，实测） |
| 已完成功能 | 31 个 |

---

## 下一步计划

### MVP 完善
- [x] 测试所有功能(批88 逐项验证:17 项已完成功能全部有自动化用例覆盖,
      末项「语法高亮」以 tests/tmLanguage.test.ts 16 用例收口,见 TESTING.md 批88)
- [x] 修复发现的问题(批88:tmLanguage 语法与引擎注册表对齐——补 UNICODE、
      删 5 个引擎未注册类型名、删 2 个引擎未注册旗标,均带回归锁)
- [x] 添加单元测试(vitest 功能层 + mocha 编译烟测层双层,共 1166 个用例;
      原 test-electron 集成层已在重构阶段4移除,批88 假设口径)
- [x] 优化性能(批92:基准先行——tests/perf/defPerf.bench.ts 对 173.4KB
      确定性大 .def 测解析/诊断/高亮三路径;不改变行为优化三处——语法规则
      fixed-entity-tag 消除扫描器重建、validateDocument 单次解析、
      computeLineStarts 原生跳转;validateDocument −46%、全文件分词 −17%,
      行为以 tests/perfRegression.test.ts 四份 golden 摘要逐位锁定,
      见 TESTING.md 批92)

### 发布准备
- [x] 创建扩展图标(已由用户设计资产 resources/logo.png 满足:package.json
      Marketplace 图标与 README 展示均接线该文件;批89 擅自生成代餐被用户
      点名撤销,批90 恢复用户资产口径并锁回归,见 TESTING.md 批90)
- [x] 准备 Marketplace 截图（docs/screenshots/ 6 张实机截图已落：
      def-highlighting / def-intellisense / entity-explorer /
      dependency-graph / log-viewer / monitoring-panel，commit 8c3ffec 起
      陆续落地，README 截图节已引用）
- [x] 完善文档(批106:guide 功能概览/快速开始/文档索引对齐当前功能面
      ——补 Telnet 探测、调试支持、HTTP 快捷请求三节与索引条目;CHANGELOG
      [Unreleased] 补批94 后变更(1166 用例/八检查/telnet/HTTP/安全钉/
      nightly);CONTRIBUTING 清虚构(不存在的 Issue 模板、Discussion)与
      表情装饰;禁词/死链扫描零命中,见 TESTING.md 批106)
- [ ] 发布到 VSCode Marketplace

### 未来增强功能
- [x] 重构支持（重命名属性/方法，自动更新所有引用）→ 已落地为 .def 面重命名（见「已完成功能 17」，Python 侧等全局引用面为后续扩展方向）
- [x] 性能分析建议(批91:src/defAnalyzer.ts 静态检查 + `kbengine.def.analyze`
      命令,报告入输出面板、诊断落问题列表,+22 用例;批96 引擎复核修正各
      检查口径)。检查项定案(与语言侧实时诊断错位,只出「优化建议」):
      ① phantom-type——引擎未注册类型(BOOL/BOOLEAN/TUPLE/MAP/FIXED_ARRAY),
      加载必失败;
      ② missing-type——属性缺 <Type> 或值为空,实体加载会失败;
      ③ duplicate-type-tag——同属性多个 <Type>,引擎 enterNode 只装载首个、
      其余被忽略,按首取语义提示保留一个;
      ④ heavy-sync-broadcast——ALL_CLIENTS + 大负载类型(STRING/UNICODE/BLOB/
      容器/PY_*/VECTOR*)对全体客户端高频同步,建议收窄旗标或降粒度;
      ⑤ redundant-detail-level——DetailLevel 配在无客户端可见旗标的属性上,
      纯冗余字段(客户端可见旗标集取引擎 common.h ENTITY_CLIENT_DATA_FLAGS
      真值:ALL_CLIENTS/CELL_PUBLIC_AND_OWN/OWN_CLIENT/BASE_AND_CLIENT/
      OTHER_CLIENTS;引擎旗标共 8 个、无 ANY_CLIENT,CELL_PUBLIC 为纯 cell
      广播位——批96 修正了旧名单的漏项与幻影项);
      ⑥ invalid-identifier——属性/方法名为 Python 关键字:引擎 C 层 setattr
      不报错、装载不失败,但 Python 脚本语法无法用 self.X 访问该成员
      (标识符字符集由 def 标签语法保证,故仅关键字可触发);
      ⑦ method-property-collision——方法与属性同名:引擎装载时按名冲突直接
      拒绝(scriptdef_module),实体加载会失败(非"Python 类中互相覆盖")。
      ⑧ engine-limited-name(批99)——属性/方法名/组件槽名命中引擎受限名
      清单(entitydef/common.h ENTITY_LIMITED_PROPERTYS,def 属性注册、
      脚本类构造与 loadComponents 三处经 validDefPropertyName 共用):
      实体加载会失败。清单按引擎 C 字面拼接语义收录("component" 行尾缺
      逗号与 "databaseID" 拼成单条目 "componentdatabaseID",两名单独不被
      拒);"interface" 在名单内;FIXED_DICT 键不受限(引擎明写放开)。
      引擎另拒绝 KBEngine.Entity 既有属性名(运行时查询),该属性面不在
      引擎仓静态可推导,本检查只收受限名单臂;
      范围注记:重复定义等结构校验已由语言侧实时诊断覆盖,本功能不重复;
      自定义 types.xml 类型为引擎合法扩展,故不做「未知类型」误报。
      ⑨ inherited-name-collision(批116)——继承链跨文件同名:沿实体 def
      的 `Parent` 首边与 `<Interfaces>` 混入递归展开闭包(不含入口自身),
      把祖先/接口的属性(按 Flags 解析域位并集)、组件槽(经
      addComponentProperty 与属性同注册面)与方法(按段)并入一张名字面,
      再与入口自身声明判冲突;判重矩阵对齐引擎单模块装载语义
      (entitydef.cpp L339-395 loadDefInfo 令子/父/接口描述装入同一
      ScriptDefModule):属性 vs 祖先方法/组件槽名全局拒绝
      (scriptdef_module.cpp L537/L545)、属性 vs 祖先属性/组件槽按域位
      相交拒绝(L588-592 "is exist",异域位同名引擎可共存)、方法 vs 祖先
      属性/组件全局拒绝(L860/868、L923/931、L988/996)、方法 vs 祖先方法
      仅同段拒绝(base/cell/client 三段独立命名空间)、组件槽 vs 任何祖先
      同名无条件拒绝(组件槽经 addComponentProperty 走 addPropertyDescription,
      entitydef.cpp L742/810/L821);边解析同引擎路径——父类到定义根平铺、
      组件 def 的 Parent 在 components/ 内、接口到 interfaces/、接口文件
      自身 Parent 不产生边(entitydef.cpp L551-640 loadInterfaces 不走
      loadParentClass)、Parent/接口名取首边;闭包对畸形/空文档祖先跳过,
      悬空 Parent 静默,不虚构祖先面;报告来源列表至多列 3 个命中祖先
- [x] 实体模板库（更多预设模板）(批93:预设模板 5→10——新增怪物/场景/
      公会/队伍/邮件,类型与旗标仅取引擎注册表,队伍成员数组用
      `ARRAY<of>UINT64</of>` 内联语法;全库 10 模板生成 .def 经实时诊断与
      defAnalyzer 建议双侧零命中锁回归,见 TESTING.md 批93)
- [x] 代码片段生成器（自定义代码片段）(批94:命令面板「Generate Snippet
      from Selection」——选区文本做片段语法转义(`$`/`\`)并去公共缩进为
      片段体,经名称/前缀/描述三步输入后合并写入工作区
      `.vscode/kbengine-custom.code-snippets`,scope 取当前文档语言,同名
      覆盖有警告,手改出注释/坏 JSON 拒绝改写并提示;片段文件读/写 IO 失败
      落错误通道提示并带文件路径(批100,见 TESTING.md 批100);假设注明:选区
      按字面收录不自动推断占位符,用户可在片段文件内自行加 `${1:...}`,
      见 TESTING.md 批94)

---

**项目地址**: https://github.com/cuihairu/kode
**当前版本**: 0.1.0（版本号冻结，发版由用户手动触发）
**许可证**: Apache-2.0
