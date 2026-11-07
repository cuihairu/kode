KBEngine Python 资产导航与玩法验证样例
========

本目录是在仓库原有 KBEngine 服务端模板骨架上扩展的验收工程。它保留官方
`scripts/base|cell|client`、`entity_defs`、`entities.xml` 布局，并增加
TrainingAvatar、TrainingMonster、EliteMonster 和多组 mixin，用来验证跨文件
继承、C3 MRO、别名与重导出、同名类、实体角色隔离、覆盖方法、`.def` 往返跳转、
属性跳转、无效接收者以及注释/字符串过滤。

DEMO-GAME-001..004 起本目录同时承载迷你 ARPG demo 实体面（Spaces/Space/
Account/Avatar/Monster，登录建角 / 刷怪 / 服务端权威战斗 / 死亡重生），
在真实 KBEngine 九进程引擎上验证过；训练场玩法（Training*/Elite*，
`play_demo.py` 回合制验收）保留不动。

在仓库根目录运行：

```sh
pnpm demo:play                 # 交互式本地玩法样例
pnpm demo:verify               # 验证玩法规则和 Python 运行时 MRO
pnpm test:demo                 # demo:verify + 25 个跳转案例（navigation-cases.json）
xvfb-run -a pnpm test:demo:editor  # 可用 Linux 无头桌面跑真 VS Code F12
```

`navigation-cases.json` 是跳转验收清单；Vitest 和 Electron 都读取它，并逐项
比较 F12 返回的完整文件与行号集合。`play_demo.py --verify` 另外检查真实 Python
解释器看到的 MRO、战斗状态、奖励、治疗和移动边界。Electron 测试会把本目录复制
到临时目录再打开，测试结束后自动删除。

玩法脚本使用一个仅供本地验证的轻量 KBEngine adapter。它不会启动服务端，也不
替代真实 KBEngine 进程验收。

真引擎起服验证（DEMO-GAME-001..005）
--------

本仓验收不直跑本目录——仓库根的 `scripts/run-demo-engine.sh` 先把本目录完整
复制到独立运行目录（默认 `~/.cache/kode-demo-engine-run`），改写
`res/server/kbengine.xml`（MySQL 指向、网卡选择）后从运行目录起服：

```sh
KBE_ROOT=~/workspaces/kbengine scripts/run-demo-engine.sh start   # 复制夹具→起 9 进程
scripts/run-demo-engine.sh bots    # 起无头玩家 bots（登录→建角→进世界→战斗）
scripts/run-demo-engine.sh stop    # 杀掉本脚本起的全部引擎进程
scripts/run-demo-engine.sh clean   # stop + 删运行目录
```

环境变量与验收锚（起服后 grep 运行目录 logs/ 的关键行）见脚本头注释；
逐批引擎证据在 `docs/acceptance-evidence/DEMO-GAME-00N.md`（起服表、
spawn done、Avatar 进世界、击杀/升级/重生回路的原始日志节选）。
`KBE_DEMO_ASSETS` 可指向 `templates/demo-game`（DEMO-GAME-006 从本夹具
派生的脚手架模板）验证模板布局同构。

demo 模板（DEMO-GAME-006）
--------

扩展命令 `kbengine.project.createDemoGame`（或打开空目录时的提示）从
`templates/demo-game` 物化一个 demo 游戏项目；模板内容 = 本夹具去掉训练场
（Training*/Elite*、common/training/）、README、`.vscode/` 与验收清单后的
子集，排除账本见 `tests/demoGameTemplate.test.ts`。

原始模板脚本
--------

以下为官方 KBEngine 模板自带说明；直接在仓库夹具上跑它们不是本仓验收
路径（会用仓库内文件起服），请优先用上节 `run-demo-engine.sh`。

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
