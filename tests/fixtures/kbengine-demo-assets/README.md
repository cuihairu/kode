KBEngine Python 资产导航与玩法验证样例
========

本目录是在仓库原有 KBEngine 服务端模板骨架上扩展的验收工程。它保留官方
`scripts/base|cell|client`、`entity_defs`、`entities.xml` 布局，并增加
TrainingAvatar、TrainingMonster、EliteMonster 和多组 mixin，用来验证跨文件
继承、C3 MRO、别名与重导出、同名类、实体角色隔离、覆盖方法、`.def` 往返跳转、
属性跳转、无效接收者以及注释/字符串过滤。

在仓库根目录运行：

```sh
pnpm demo:play                 # 交互式本地玩法样例
pnpm demo:verify               # 验证玩法规则和 Python 运行时 MRO
pnpm test:demo                 # 用扩展 DefinitionProvider 验收 24 个跳转案例
xvfb-run -a pnpm test:demo:editor  # 可用 Linux 无头桌面跑真 VS Code F12
```

`navigation-cases.json` 是跳转验收清单；Vitest 和 Electron 都读取它，并逐项
比较 F12 返回的完整文件与行号集合。`play_demo.py --verify` 另外检查真实 Python
解释器看到的 MRO、战斗状态、奖励、治疗和移动边界。Electron 测试会把本目录复制
到临时目录再打开，测试结束后自动删除。

玩法脚本使用一个仅供本地验证的轻量 KBEngine adapter。它不会启动服务端，也不
替代真实 KBEngine 进程验收；当前样例主要验证插件导航和 Python 运行时行为。

##启动服务端

使用固定参数来启动：(参数的意义:http://www.kbengine.org/cn/docs/startup_shutdown.html)
	
	Linux:
		start_server.sh

	Windows:
		start_server.bat


##关闭服务端

快速杀死服务端进程:

	Linux:
		kill_server.sh

	Windows:
		kill_server.bat


如果是正式运营环境，应该使用安全的关闭方式，这种方式能够确保数据安全的存档，安全的告诉用户下线等等。

	Linux:
		safe_kill.sh

	Windows:
		safe_kill.bat
