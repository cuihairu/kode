# RUST-198 验收纪要:执行命令安全四维——trust 闸落 manifest + 三维既有交付

日期:2026-11-17。本纪要对账 RUST-198(旧 EXEC-010,主 todo 排队项)的验收口径与交付证据。结论:**用户确认/机密遮蔽/默认不自动运行三项既有交付;workspace trust 为真实缺口,本批落 manifest 声明闸(untrustedWorkspaces supported=false)+2 测试钉后勾行。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| workspace trust(**本批落闸**) | manifest 层声明 `"untrustedWorkspaces": {"supported": false}`——扩展在未信任工作区不被启用,一切按工作区配置拉起引擎/Python 进程的面(引擎组件/快速动作/测试运行/调试)在信任门前零执行;描述文案两语言 nls 占位 | **本批** `package.json` capabilities + `package.nls.json` + `package.nls.zh-cn.json`;`tests/workspaceTrustManifest.test.ts`(2 例:声明存在且 false/描述占位两包同键非空);i18n 契约由既有 `tests/manifestI18n.test.ts` 全量门自动覆盖(键集全等+一键一引用) |
| 用户确认 | quickActions 面向用户动作态机:`resolve.confirm` 置位走确认对话框(showInformationMessage)后才执行;执行面全部用户显式触发(kbengine.server.start/stop/restart 命令、快速动作 quick pick、Test Controller 运行、F5 调试) | `src/quickActions.ts:704-706`;`src/activate/serverControls.ts:737-756` |
| 机密遮蔽 | playerData 面恒掩码:密码展示只出 `●●●●●●` 三态(RSA 密文不解读/明文仅连接/未配置),tooltip 与子项同掩码,明文零显示;DB 连接面密码仅宿主侧建连功能用途(mysql2 扩展宿主连接),不进 webview 展示面;RSA encrypt=true 密文 kode 不解读 | `src/playerDataPanel.ts:239-243`(掩码三态)/`:258`/`:271`;`src/databaseManagementWebView.ts:219`(连接执行器配置,非展示) |
| 默认不自动运行项目脚本 | 零激活期自动执行:引擎组件启动唯一入口=`kbengine.server.start` 用户命令(autoStart 配置只是该命令的组件过滤,不自动触发);热更语法闸=功能门控下的保存时 compile 检查(pythonExecService 常驻服务,非项目脚本);venv 扫描=只读文件系统 | `src/activate/serverControls.ts:743`(唯一触发点);`src/serverManager.ts:779`(autoStart 为命令内过滤);`src/hotReload.ts`(compile 面非脚本执行) |

## 本批增量

- `package.json` capabilities 增 `untrustedWorkspaces.supported=false`(VS Code 工作区信任机制的标准声明形态——未信任工作区扩展禁用,用户信任工作区即启用,无自定义确认流)。
- 两语言 nls 描述键;`tests/workspaceTrustManifest.test.ts` 2 例(声明钉+占位契约钉)。
- prove-red:`supported: false→true` 变异→测试红(RC=1)→cp+cmp 字节还原→复绿(RC=0)。

## 诚实条款

- 信任闸的形态是 **manifest 级整体禁用**(VS Code 标准机制),不是扩展内逐命令 trust 检查——前者是平台推荐形态(未信任=零激活零执行),后者自造闸面易漏;不冒充做过逐命令门。
- spawn 事件文本(`starting <command> <args>`)裸记命令行(processManager:203):现行调用面(引擎组件/解释器探针/pip 参数)无机密载体——密码经引擎配置文件与 RSA 加密流转,不进 argv;若未来出现带机密的调用面,遮蔽随面设计,本纪要如实登记现状。
- 用户确认的形态是**动作级确认**(快速动作 confirm 置位)+**显式触发面**(全部执行入口用户点选);没有全局「每次执行前确认」开关——如实登记,不宣称覆盖。
