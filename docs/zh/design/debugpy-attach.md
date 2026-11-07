# debugpy 早期附加设计（提案）

> 状态：**已实现（三批落地）** —— 方案②落地为一键命令 `kbengine.debug.debugpyInject`
>（KODE-DBG-001，受 `kbengine.debug.debugpyInject` 开关控制，默认开；
> src/debugpyInjectCommand.ts、tests/debugpyInjectCommand.test.ts）；方案①落地为
> `kbengine.debug.waitAtStartup` 引导块（on/off 命令，src/debugpyWaitAtStartup.ts）；
> 周边自动化——逐进程端口分配、launch.json attach 配置生成、
> 未注入/监听/已附加/失败状态板——已随 IDE-DBG-001..008 与 IDE-PDBG-001..006 先行交付。
> 方案③（`debugpy --pid`）按提案结论保持不用。以下引擎引用仍锚定 `kbengine@c2a3b8f`，
> 标注 `kbe/src` 的 `文件:行号` 以源码为据；提案原文保留作设计记录。

## 目标

KBEngine 服务（baseapp/cellapp 等多进程）启动后，尽可能早地开放 debugpy 监听端口，
让 VS Code / Kode 能在 Entity 脚本执行前接入调试器；并可由 Kode 自动化该过程
（端口分配、bootstrap 注入或控制台注入、attach 配置生成、状态展示）。

## 引擎侧事实（决定方案取舍，锚定源码）

1. **KBEngine 禁用了 `site` 模块**（两条 Python 初始化路径都关）：
   - Python ≥ 3.11（PyConfig 路径）：`config.site_import = 0` — `kbe/src/lib/pyscript/script.cpp:32`
   - Python < 3.11（Py_Initialize 路径）：`Py_NoSiteFlag = 1` — `kbe/src/lib/pyscript/script.cpp:223`
   - 推论：`sitecustomize.py` / `usercustomize.py` / `.pth` **不会被自动加载**。
2. **KBEngine 忽略 Python 环境变量**：`config.use_environment = 0` — `script.cpp:33`；
   `Py_IgnoreEnvironmentFlag = 1` — `script.cpp:224`。推论：`PYTHONSTARTUP`、`PYTHONPATH`
   等不生效；但 `os.environ` 在脚本内仍读得到进程环境，自定义 `KBE_DEBUGPY_*` 变量可用。
3. **Python 就绪点**：`Script::install()` — `script.cpp:197-294`（`Py_InitializeFromConfig` →
   注册 `KBEngine` 扩展模块 → 装 GC/Pickle/Profile 等）。返回时 Python 完全可用。
4. **首个业务脚本导入点**：`EntityApp::installPyModules` → `PyImport_Import(entryScript_)` —
   `kbe/src/lib/server/entity_app.h:509`，导入 `scripts/base/<entry>.py`（baseapp）或
   `scripts/cell/<entry>.py`（cellapp）。这是**不改引擎能到的最早用户代码点**。
5. **控制台可执行任意 Python**：`TelnetHandler::processPythonCommand` —
   `kbe/src/lib/server/telnet_handler.cpp:795`（经 `PyUnicode_DecodeUTF8` → 求值）。
   Kode 现有 `KBEngineTelnetClient`（发 `KBEngine.reloadScript(True)`）即走此面。
6. **debugpy 必须能被引擎自带 Python import 到**：`sys.path` 由
   `config.module_search_paths`（`script.cpp:60`）/ `Py_SetPath`（`script.cpp:226`）显式设死；
   debugpy 须放进引擎那份 Python 的 site-packages，或在 bootstrap 里 `sys.path.append`。

## 不改引擎的可行方案（按推荐序）

### ① 入口脚本顶部 bootstrap（最早、最实际）
在 `scripts/base/<entry>.py` 与 `scripts/cell/<entry>.py` **第 1 行**放 bootstrap：

```python
import os, sys
# 确保 debugpy 可见(可选):sys.path.append("<debugpy 目录>")
import debugpy
debugpy.listen(("127.0.0.1", int(os.environ.get("KBE_DEBUGPY_PORT", "5678"))))
```

- 覆盖：入口之后一切业务 import、模块初始化、Entity 初始化。
- 盲区：仅入口文件自身 bootstrap 之前几行。
- 需重启服务生效；`wait_for_client` 由 `KBE_DEBUGPY_WAIT=="1"` 显式开启（默认不阻塞启动）。

### ② 控制台运行时注入（零文件改动，Kode 现成能力）
经控制台发任意 Python：

```
import debugpy; debugpy.listen(("127.0.0.1", 5678))
```

- 时机：控制台就绪后任意时刻；抓不到已执行完的早期 import，适合"进程已启动、调试运行期"。
- 与①互补：①管早期，②管运行期。

### ③ debugpy `--pid` 注入（Linux，最脆弱，兜底）
`python -m debugpy --pid <PID> --listen 5678`（gdb/ptrace 注入运行中进程）。版本敏感，
抓不到启动期，仅作兜底。

## 明确走不通（不改引擎）
`sitecustomize.py` / `usercustomize.py` / `.pth` / `PYTHONSTARTUP` —— `site` 被禁用 +
Python 环境变量被忽略（见引擎侧事实 1/2），全不触发。

## 自动化形态（Kode 侧）

- **调试会话管理器**：按进程分配端口（baseapp01/02、cellapp01/02…各独占，不共享），
  分配结果写进程状态；绑 `127.0.0.1`，经 SSH 隧道/私有网络访问（调试端口=任意代码执行，
  不得暴露公网）。
- **Bootstrap 生成器**（方案①）：配置门控（`kbengine.debugpy.enabled` + port）下，
  服务启动前生成/预置 bootstrap 进入口脚本顶部；Kode 已有同类注入（pyi/stub、extraPathsSync）。
- **控制台注入命令**（方案②）：一条 Kode 命令「附加调试器」= 连控制台 → 发 listen 命令。
- **VS Code 启动配置生成**：attach + pathMapping + 断点，挂现有 debug 配置面。
- **状态机**：`Disabled → Listening → ClientAttached`。①由 bootstrap 上报（日志/状态文件）；
  ②由管理器从控制台回显判断。

## 建议
首选做②（纯自动化、无副作用、现成 telnet 客户端）；①作"启动即断"增强（需重启）；③不用。
