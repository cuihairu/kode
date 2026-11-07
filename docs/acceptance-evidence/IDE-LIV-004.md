# IDE-LIV-004 验收证据:真实空间列表查询(空间与组件身份可与运行引擎对账)

- 日期:2026-11-07;环境与命令链同 `IDE-LIV-003.md`(imac WSL2 真引擎 + `--live` 真机套件跨机联验)
- 查询目标:cellappmgr(type=4/cellappmgr, id=5129652375332859700, addr=192.168.5.117:47573),走生产 querySpaces 实现

## 证据原文

```
[LIV-004] 空间列表联验 2026-11-07T04:44:40.828Z
查询目标身份: cellappmgr (type=4/cellappmgr, id=5129652375332859700, addr=192.168.5.117:47573)
空间: spaceID=1 cellappID=7129652375332859700 geomapping=未知 scriptModule=Space cells=未知 → cellapp 对账一致(cellapp1@192.168.5.117:48383)
协议引据: kbe/res/server/messages_fixed_defaults.xml <Cellappmgr::querySpaces><id>50003;回包 65503 kbe/src/lib/helper/console_helper.h;引擎 https://github.com/kbengine/kbengine@f85ad81
快照数: 1
LIV-004 结论: 已测,快照 cellappID 与发现身份逐条对账一致
```

## 对账口径

- 快照 spaceID=1 的 cellappID=7129652375332859700,与广播发现的 cellapp1 身份(type=5, id 同值, addr 192.168.5.117:48383)逐字段一致 → verdict=matched
- 引擎未回传的字段(geomapping/cells)如实标「未知」,不猜测(scriptModule=Space 来自空间实体脚本面,非引擎字段)
- 佐证:运行目录 `C:\work\liv-run\evidence.log` 起服锚 `[demo-evidence] Spaces[1] created (baseapp)` / `Space[2].onGetCell: space established (index=1)`,与快照 spaceID=1 对应

## 命令链

`KBE_ROOT=~/kbengine sh scripts/run-demo-engine.sh start`(imac WSL)→ bots 进世界 → `node out/test/electron/runTest.js --live`(192.168.5.188,`KODE_LIV_DISCOVERY_HOST=255.255.255.255`),mocha 5 passing / 0 failing(exit 0)。
