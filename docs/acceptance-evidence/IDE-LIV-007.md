# IDE-LIV-007 验收证据:运行异常关联源码定位(真实日志行跳转 + 无源码保留原始信息)

- 日期:2026-11-07;环境与命令链同 `IDE-LIV-003.md`
- 异常来源:imac 真引擎 cellapp 运行日志 `C:\work\liv-run\logs-proc\cellapp.out`(stdout 直写,KBEngine S_ERROR 通道)。异常由**一次性探针**触发:仅写入运行目录副本 `scripts/cell/Avatar.py` 的 onTimer 首轮 `raise RuntimeError("LIV-PROBE one-shot intentional exception for IDE-LIV-007 source-jump evidence")`(仓库夹具不含此改动;探针为真实引擎异常,非伪造日志行)

## 1. 引擎日志原始行(真实 traceback)

```
cellapp01: [S_ERROR]: Traceback (most recent call last):
  File "/mnt/c/work/liv-run/scripts/cell/Avatar.py", line 21, in onTimer
    raise RuntimeError("LIV-PROBE one-shot intentional exception for IDE-LIV-007 source-jump evidence")
cellapp01: [S_ERROR]: RuntimeError: LIV-PROBE one-shot intentional exception for IDE-LIV-007 source-jump evidence
```

## 2. 解析 → 工作区落点 → 跳转(mocha 断言通过)

```
LIV-007 引擎日志来源: cellapp.out File "/mnt/c/work/liv-run/scripts/cell/Avatar.py", line 21, in onTimer
LIV-007 解析: file=/mnt/c/work/liv-run/scripts/cell/Avatar.py line=21 qualifier=traceback
LIV-007 结论: 已测; /mnt/c/work/liv-run/scripts/cell/Avatar.py:21 → /home/cui/liv-ws/scripts/cell/Avatar.py 光标行=21(1 基)
```

- 部署机绝对路径(/mnt/c/...)在联验机不存在 → `resolveExceptionSource` 截取 `scripts/cell/Avatar.py` 段落进工作区(workspace=引擎资产根副本 `/home/cui/liv-ws`),命中真实文件
- 光标落在第 21 行(1 基),且**落点行语义核对**通过:该行文本确为 `raise RuntimeError("LIV-PROBE ...")`(防止行号数值巧合);跳转动作与生产命令同款(`editor.selection` 落行)
- 同名脚本防落错:候选序为「/scripts/ 段相对路径」先于 basename 兜底,`scripts/base/Avatar.py`(同名不同目录)不会被误选

## 3. 无源码面(如实保留原始信息,不猜)

```
LIV-007 无源码面: 异常文件行 scripts/base/LIV7Ghost.py:9 在当前工作区未找到源码,原始信息:File "scripts/base/LIV7Ghost.py", line 9, in nowhere
```

`resolveExceptionSource` 对工作区不存在的文件返回 null(`unresolved === null` 断言),文案原样携带原始行,不做任何改写。

## 命令链

`node out/test/electron/runTest.js --live`(mocha 5 passing / 0 failing,exit 0;LIV-007 全绿含跳转+无源码两断言面)。
