# TODO

> 完成项一行证据（commit + 测试数）；未完成项一句需求。版本号冻结 0.1.0，发版由用户手动触发。

## 未完成

- [ ] 发布到 VSCode Marketplace（仅用户手动执行；不打版本号 tag、不建正式 Release、不跑发版 workflow）
- [ ] 批123 网络包结构生成：从 def 树产出客户端可见方法的参数序列、utype 序列与消息编号表（机读 json + 人读 markdown），规格与冲突报错对齐引擎装载语义，复用现有 def 解析
- [ ] 批124 def 图形化架构流程图：webview 内展示 client 通知到 baseapp/cellapp 的调用与属性自动同步关系，边语义按 Flags 位带引擎出处，支持导出
- [ ] 法宣工程配置目录无法定位时给出可见诊断（当前失败静默：多候选宁缺勿猜回落到不存在的约定路径，或激活期 quick pick 取消后不记忆）
- [ ] `kbengine.configPath` 补约定发现（telnet 已有 `res/server/kbengine.xml` 探测链，可复用）

## 已完成

- [x] Marketplace 截图准备 — 6 张实机截图落 `docs/screenshots/`，README 双语引用 — commit `8c3ffec`（截图批）/ `b683108`（README 引用）
- [x] KBENGINE_SOURCE_AUDIT_PLAN 13 个功能块逐块复核 — 块4 检查项 9 项补记 `8252760`；块8 文本形态 Parent 收口 `f76bdca`（纯函数 8 例 + 锁定用例）；块12 日志定案 b 不支持（计划文档块 12 已记）；其余 10 块已对照无漂移
- [x] 导航与配置在途派单 4 条 — 默认开启 `dbd65c5`、逐字段重写与 telnet 纠错 `00f2cf3`、导航四档收口 `3b45b67`
- [x] 批116 继承链跨文件同名检查 — `8252760`（+7 用例）
- [x] 批117 Interfaces 装载语义对齐 — `c1d8ba4`
- [x] 批118 导航布局补齐（bots/单数 interface/平铺/角色目录嵌套）— `353b837`、`8fa4b07`
- [x] 批119 依赖图继承边认文本形态 Parent — `f76bdca`（纯函数 8 例 + 锁定用例）
- [x] 批120 Persistent 属性悬停展示数据库落点 — `e96a586`
- [x] 批121 片段生成去公共缩进改 tabSize 列语义 — `6a89ecc`（+6 用例）
- [x] 批122 数据库模拟 — `b683108`（+2 测试文件，全套 1517 用例绿，coverage 100%×4）
- [x] 批125 配置自动发现与精简 — `b683108`（+1 测试文件，配置对照表入 configuration.md，干净工作区零配置可用核心功能）
- [x] 批126 RPC 方法标记 CodeLens — `b683108`（+1 测试文件 28 例，全套 1517 用例绿，coverage 100%×4）
- [x] 文档-源码一致性审计 23 项修复 — 见 `docs/审计-文档一致性.md`（超前 5 / 滞后 7 / 不符 11）
