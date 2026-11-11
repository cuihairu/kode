# Demo 热更新：HTTP/xreload 与 KBEngine 官方通道

日期：2026-11-11。目标运行版本：**CPython 3.7.3**。两条通道使用不同执行器，不能以 HTTP 200、控制台连接或命令回显代替加载证据。

## 1. 审核发现与本次修复

1. demo 原先没有 `/hotfix` 接收服务；扩展发请求不代表游戏收到或执行了更新。
2. 默认部署通道使用 `module_name` 表单，缺少文件集、目标和冻结指纹，无法匹配逐文件回执；现在默认发送 JSON，自动携带 `targetId` 和 `sender_digests`。
3. 台账即使收到核验成功的 applied，状态栏仍显示未确认；现在全批核验成功显示“已应用”，部分失败显示失败，不用整批成功遮盖局部失败。
4. 官方预设端口原为 2560，与本次引擎 `kbengine@3082ab5` 的 Baseapp 默认 40000 不符；预设改为 40000，默认密码沿用引擎 `pwd123456`，已有显式设置优先。
5. 官方发送先切 `:python`，订阅响应后再发命令，并等待每次请求独有的执行结果标记；普通回显不是完成标记，分片 JSON 必须收齐。异常回显记失败。
6. 两方案对 common 导入的常量都需要处理。HTTP/xreload 刷新可解析的直接 `from module import name` 绑定；官方先重载指定 common/user_type 模块，再调用原生 reloadScript 更新实体脚本。

原有 `docs/hotreload/current-implementation.md` 是历史审计快照，不能据此判断今天的接收端或状态栏能力。

## 2. HTTP/xreload 链路

`扩展文件事件 → JSON POST :8090/hotfix → Base 接收器路由 → 引擎主线程 descriptor 回调 → xreload(已加载模块) → 文件指纹核对 → 逐文件回执 → 扩展冻结指纹核验 → 状态栏已应用`。

- Base 在 `kbemain.onInit` 启动 `127.0.0.1:8090`；Cell 在自己的 `onInit` 启动 `127.0.0.1:8091`。
- HTTP 线程只负责请求、等待和转发。Python 脚本更新在 `KBEngine.registerReadFileDescriptor` 注册的引擎线程回调中执行；不在 HTTP 工作线程操作实体。
- Base 文件留在 Base；Cell 文件转发 Cell；common/user_type 文件两侧都更新，任一侧失败则该文件整体不显示 applied。
- 本 demo 只支持一个 Baseapp 和一个 Cellapp。多实例需要独立端口、实例身份和路由，不能复制默认端口后宣称覆盖所有进程。
- `KODE_HOT_RELOAD_BASE_PORT`、`KODE_HOT_RELOAD_CELL_PORT` 可修改默认端口；对应修改扩展 profile URL。监听仅绑定 loopback。
- `onFini` 关闭服务。服务状态放在 KBEngine 模块上，脚本 reload 不重复创建监听器。

HTTP **只使用 xreload**，不通过 `KBEngine.reloadScript` 偷换执行方案。未加载模块、错误进程、目录外文件、语法/执行错误及指纹不匹配明确返回失败。入口脚本和重载器本身修改需重启。

## 3. xreload 的 Python 3.7.3 适配

来源：[Guido 原版](https://svn.python.org/projects/sandbox/trunk/xreload/xreload.py)。源码位置为 `templates/demo-game/scripts/common/xreload.py`，同步到 demo 夹具同路径；不需要在引擎里安装 pip 包。

保留原版“在原模块 globals 中执行并原位修补函数/类”的机制，移除 `imp`、`types.ClassType`、`im_func` 等旧接口。适配 import 元数据、函数默认值/关键字默认值/注解、普通/静态/类方法、property、相同布局 slots、同模块继承和 `super()`；保留已有函数、类和实例身份，读取源码而非依赖 pyc 的时间戳缓存。

支持模块声明 `__reload_preserve__ = ("state",)`，保留列出的模块全局对象。demo 的 `Spaces.spaceByIndex` 已声明保留，避免重载 Spaces 时丢失世界注册表。未声明的可变全局量仍按原版规则替换。

### 明确边界

- 结构性 def、修改类基类/slots 布局、自定义元类和闭包布局/捕获值迁移需要重启或专门迁移，不能称任意程序均可热更。
- 活跃栈帧、生成器和已经注册的 native 回调不自动重启；新调用才执行更新后的代码。
- 任意模块顶层副作用不是事务，执行出错后不能回滚已发生的外部写入。恢复模块字典不等于业务状态回滚。
- 原版不更新依赖模块。demo 仅补直接顶层 from-import 的绑定刷新；动态导入、复杂再导出图、闭包里捕获的旧不可变值不保证自动刷新。
- 删除函数后，其他位置已持有的旧引用不会自动失效。
- 远端部署没有自动上传文件或路径映射；接收器必须能访问该实例实际加载的源码。不能只改开发机文件就认为远端进程已更新。

## 4. 官方通道

`扩展 → 指定进程 telnet → :python → 官方执行命令 → KBEngine.reloadScript(fullReload)`。

引擎依据：`baseapp.cpp:5196`、`cellapp.cpp:1826`；`entity_app.h:1452` 在重载后调用入口 `onInit(1)`。官方通道不调用 xreload。

在带本次 demo observer 的进程上，控制台命令调用 `KodeHotReload.official_reload`：预检文件/指纹，必要时刷新 common/user_type，调用官方 API，检查 `onInit(True)` 确认，再返回带文件/指纹/修订号的结果。扩展仍要核对冻结指纹才能显示已应用。

未安装 demo observer 的普通 KBEngine 项目继续执行原生 API，但只有命令执行层证据，保持未确认，不虚构逐文件已应用。内建 API 不提供完整事务成功回执，源码/回调确认也不能证明所有业务状态已正确迁移。

**官方通道只控制配置的那个进程。** Base 默认端口 40000、Cell 默认 50000（端口占用时引擎可能顺延）；分别配置实际实例与密码。向 Base 控制台发送 Cell 文件会明确失败，不借 Base 的回执证明 Cell 更新。需要 Base+Cell 自动路由可使用 demo HTTP 入口。

## 5. 使用和确认

新创建的 demo 包含接收器；既有 demo 需要同步 common 的 `KodeHotReload.py`/`xreload.py`、Base/Cell 的 `kbemain.py`，以及 Spaces 的保留状态声明，然后重启 Base/Cell 一次以安装监听器。

启动日志应出现：

```text
[kode-hot-reload] base listening http://127.0.0.1:8090/hotfix pid=...
[kode-hot-reload] cell listening http://127.0.0.1:8091/hotfix pid=...
```

检查状态（GET 不执行重载）：

```sh
curl http://127.0.0.1:8090/status
curl http://127.0.0.1:8091/status
```

在真实 demo 的 common/DemoConsts.py 修改战斗常量，保存后默认 HTTP 通道发送。也可手工请求（替换为实际绝对路径）：

```sh
curl -X POST http://127.0.0.1:8090/hotfix \
  -H 'Content-Type: application/json' \
  -d '{"files":["/absolute/demo/scripts/common/DemoConsts.py"]}'
```

结果包含 `status`、`file`、`digest`、`revision`、`method` 和 `processes`；common 文件要求 processes 覆盖 base/cell。再次 GET /status 可查看最近回执。旧 `module_name` 表单仍兼容，但缺少发送时冻结指纹，不能获得扩展同等级的确认。

扩展核验整批成功显示“热更: 已应用”；日志命令 `kbengine.hotReload.showLog` 查看目标和文件数量。失败、超时、未加载、需要重启或仅送达都不显示已应用。改动 def 结构继续走已有重启闸。

## 6. 验证记录

本次在 `/tmp` 从 python.org 的 Python-3.7.3 源码构建独立解释器，没有更改系统 Python。`--version` 确认 `Python 3.7.3`。

```sh
/path/to/python3.7.3 -B tests/python/test_xreload_py37.py
/path/to/python3.7.3 -B tests/python/test_demo_hot_reload.py
/path/to/python3.7.3 -B tests/python/test_demo_official_reload.py
```

截至本记录：xreload 19 项、真实回环 HTTP + 引擎 descriptor 仿真 7 项、官方 API 适配仿真 3 项通过。HTTP 测试修改源码并验证已有实例、事先保存的方法及函数引用运行结果改变，覆盖快速等长保存、双进程路由、common 两侧确认和失败路径。官方测试验证调用原生 API 及 observer 条件，禁止误用 xreload。

全部热更及模板 TypeScript 回归已通过 50 文件、622 项。类型检查和涉及源文件 ESLint 通过。**这些包含引擎替身测试，尚未在完整运行的 KBEngine demo 游戏中验收双通道；不能将上述数字标成真实游戏运行验证。** 当前本机引擎二进制链接 Python 3.14，也不能替代 Python 3.7.3 嵌入式引擎验证。
