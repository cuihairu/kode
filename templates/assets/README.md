# cultivation demo assets (KBEngine)

KBEngine 修仙 demo 的 Python 资产树(本体在仓库 `templates/assets`),配套引擎 fork
`templates/kbe`(cuihairu/kbengine,上游 0.1.2 基线;Linux/Windows 预编译二进制见
<https://github.com/cuihairu/kbengine/releases>)。

This is the cultivation-themed KBEngine demo asset tree. Engine fork lives in
`templates/kbe`; prebuilt binaries are on the fork's GitHub releases.

## 目录速览 / Layout

- `scripts/entity_defs/` 实体定义(Avatar/Monster/Pet/Item/Equipment/Talisman/Formation/Sect …)
- `scripts/base/` `scripts/cell/` 基座/cell 双面脚本;`scripts/common/` 纯函数核
  (`cultivation.py` 境界/五行/堆叠/阵法规则 + pytest 钉死:`tests/python/`)
- `scripts/bots/` 无头玩家回路;`scripts/client/` 客户端桩
- `res/server/kbengine.xml` 服务端配置;`res/server/log4cxx_properties/` 日志配置
- `res/spaces/` `scripts/data/` `scripts/server_common/` 占位目录(sdk 模板惯例,按需填充)

## MySQL 建库 / Database

引擎需要 MySQL。默认约定(与 `scripts/run-demo-engine.sh` 的 `KBE_DEMO_DB` 一致):

- 主机:`192.168.5.5:3306`(可用 `KBE_DEMO_DB` 覆盖)
- 库名:`kode_demo`(起服前先建库;`KBE_DEMO_DB_RESET=1` 时脚本会重建干净库)
- 账号/密码在 `res/server/kbengine.xml` 的 `<databaseInterfaces>` 节配置

The engine expects MySQL. Defaults: host `192.168.5.5:3306`, database
`kode_demo` (create it before the first start); credentials live in
`res/server/kbengine.xml`.

## 起服 / Run server

仓库自带真引擎起服脚本(复制资产到独立运行目录后起 9 进程,验收锚见脚本头注):

```sh
scripts/run-demo-engine.sh start    # 起服(KBE_DEMO_ASSETS=templates/assets 验证本模板)
scripts/run-demo-engine.sh bots     # 起无头玩家回路
scripts/run-demo-engine.sh stop     # 杀引擎进程
scripts/run-demo-engine.sh clean    # stop + 删运行目录
```

引擎二进制也可从 fork release 手动展开后直接用 `templates/assets/start_server.sh`
起服(`cd kbe && ./start_server.sh` 布局,见 fork release 说明)。

## bots(无头验收)

`scripts/run-demo-engine.sh bots` 会跑登录→建角→进世界→自动战斗回路;
脚本与 bots 实体逻辑在 `scripts/bots/`。

## Godot 客户端 / Godot client

规划中,尚未实现(见仓库 todo.md DEMO-GAME-027)。当前无 Godot 工程交付,
请勿把本节理解为已有客户端。

Planned (repo todo DEMO-GAME-027); no Godot project exists yet.

## kode 走查入口 / Walking the tree with kode

用 kode(VSIX)打开本仓库后:

- 资产根(assets root):`templates/assets`
- 引擎根(engine root):`templates/kbe`

即可对 `entity_defs`↔`base`/`cell` 脚本做跳转/诊断/引用走查。

With the kode extension installed, point the profile's assets root at
`templates/assets` and the engine root at `templates/kbe`.
