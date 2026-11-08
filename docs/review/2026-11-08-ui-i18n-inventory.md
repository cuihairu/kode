# 主要用户路径的国际化盘点

范围：首次使用、工作台、快速执行、玩家数据、克隆和监控；以当前源码的用户可见入口为依据，不以检索到多少中文字符串代替调用路径核对。尚未运行真实 VS Code 语言切换；本文件不代表全插件已覆盖。

## 现有机制

扩展清单使用 `package.nls.json` 与 `package.nls.zh-cn.json`；Tree、通知和 QuickPick 可通过 `src/nlsRuntime.ts` 的 `l10nText` 读取 `l10n/bundle.l10n*.json`；Webview 使用 `src/webviewStrings.ts`，并通过 `kbengine.webviewLocale` 决定语言。这些机制各自有效，但缺少统一的路径级验收：同一任务可在 Tree 中显示中文、QuickPick 中显示英文或硬编码中文。

| 路径 | 已接入 | 硬编码及未完成范围 |
|---|---|---|
| 首次使用/项目识别 | 清单视图标题有双语 | 尚无完整引导；`src/activate/utilityCommands.ts` 发现报告、`src/projectImport.ts` 对话和提示主要写死中文，新入口必须同时提供中英文与失败态 |
| 工作台 | `src/activate/monitoring.ts` 的分组、名称、说明已走 `l10nText` | 调用后的项目诊断/服务器查询等下游命令仍有硬编码中文；保留详情中的稳定专业术语用于搜索 |
| 快速执行 | `src/quickActionTree.ts` 的组、空态和提示已走 `l10nText` | `src/quickActions.ts` 的无工作区、扫描选择/结果、运行确认及错误多处写死中文；配置解析警告也需追踪来源并翻译，不能只翻译最外层 |
| 玩家数据只读查询 | 清单标题与部分其他服务器视图已本地化 | `src/playerDataPanel.ts` 树节点/结果、`src/activate/serverControls.ts` DBID 输入和通知写死中文；需保留只读与引擎配置来源语义 |
| 玩家克隆 | `src/playerDataCloneCommands.ts` 的连接配置和导出前源库配置入口已注入翻译函数 | 连接测试、归档、导出、导入预演/两次确认、事务和审计结果仍混合中文与英语；尤其重复导入、提交结果不确定和已提交但审计失败的恢复提示不能简化失真 |
| 监控及运行时面板 | `src/monitoringWebViewHtml.ts`、`src/databaseManagementWebViewHtml.ts`、`src/runtimeQueryWebView.ts` 多数文案走 `webviewStrings`；监控筛选标签已覆盖中英文 | 面板控制器发出的通知、错误和部分其他面板的初始化状态仍需逐条核对；不能从字符串表的存在推断整个用户路径已本地化 |

配置键、文件名、数据库表名、命令 ID、用户输入、服务器返回的诊断与路径属于数据或稳定技术标识，不应按自然语言自动翻译。可翻译其周围的标题、解释和操作。需要参数的消息使用命名占位符，避免翻译后丢失目标库、记录数或错误原因。控制流程必须使用稳定值，不应依赖用户看到的语言字符串；对于目前仅支持字符串选项的接口，需要在迁移前增加 label/value 映射或保证比较的值来自同一次本地化结果。

验证顺序：先对每条操作在英文默认及中文环境下检查输入、按钮、成功、空值、失败与取消；确认安全关键提示语义和日志无密码；再使用实际 VS Code 安装包切换语言走查。其他语言目前按产品既有回退行为处理，不宣称已翻译。
