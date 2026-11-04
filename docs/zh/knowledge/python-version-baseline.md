# Python 版本口径：3.7 源料 vs fork 3.12

> KB-001 · KB-API-001（P0）版本口径篇。官方 KBEngine `docs/api` 源料（kbengine
> fork `docs/api/`，CHM 转换产物）按 3.7 时代嵌入式运行时口径撰写；fork 的
> Windows 构建已指向 CPython 3.12。本页固定版本口径基准，KB-API-002~008 各篇
> 的差异小节统一按本页标注。grounding 分两个取证域，每条断言标注所属域：
> - **fork 域**：`kbe/src`，路径 `/home/cui/workspaces/kbengine`
>   （fork HEAD `6d12b8f`；grounding 基准 `c2a3b8f` 为 HEAD 祖先，下方全部
>   file:line 已于 2026-11-04 在 HEAD 逐一复核）。
> - **Python 域**：CPython 官方发行注记（`docs.python.org`，逐条附 URL）。
>   vendored `kbe/src/lib/python/` 树既不在 git 也不在盘上，3.7→3.12 偏差
>   **一律不以 3.7 源码反推**——官方 3.12 变更记录是唯一参照。
>
> 关联篇目：[实体生命周期与引用释放](entity-lifecycle-reference.md)、
> [固定目录与路径解析链](fixed-directories-and-path-resolution.md)。

## 1. 版本时间线

| 时间 | 事实 | 证据 |
| --- | --- | --- |
| 上游 KBEngine（官方 v3.x 线） | 嵌入运行时为 vendored CPython **3.7.3**，路径 `kbe/src/lib/python` | fork 文档 `docs/zh/guide/engineering/python-3.12-upgrade.md:7-9`（声明基线；fork 曾翻转 locale 布局——`docs/guide/engineering/python-3.12-upgrade.md` 是指向该 zh 页的跳转 stub）；vendored 树本身未入库（见 §2.4） |
| 2026-09-25 | fork 导入提交 `0bc93d5`（仓库根提交，单一根，共 95 个提交）**已带 3.12 构建胶水**：9 个 Windows `.vcxproj` 链 `python312(_d).lib`，`script.cpp` 含 3.11+ `PyConfig` 初始化路径 | `git rev-list --max-parents=0 HEAD` = `0bc93d5`；`kbe/src/server/baseapp/baseapp.vcxproj:118`（`python312_d.lib`）、`:174`（`python312.lib`）；`kbe/src/lib/pyscript/script.cpp:26-88` |
| 2026-11-02 | Linux 构建与全量起服**按 Python 3.7.17 验证通过**（deadsnakes `libpython3.7m.so`，CMake `Python3_LIBRARY`/`Python3_INCLUDE_DIR`）；9 个服务进程全部存活、建表成功 | `BUILD-NOTES.md`，随 `855a06d` 提交（基线提交 `a3c481d`）；该文件 **HEAD 已不在树上**——读法 `git show 855a06d:BUILD-NOTES.md` |
| 2026-11-02 | grounding 基准提交 `c2a3b8f` | `git show -s c2a3b8f` |
| 2026-11-04（HEAD `6d12b8f`） | 构建文件 **零** `python37` 残留；Unix `Makefile` 版本无关（探测 `libpython*.a`）；升级指南页仍写 3.7.3 基线——文档漂移，见 §2.2 | `grep -rl python37 kbe/src` = 0；`kbe/src/lib/Makefile:46`；`docs/zh/guide/engineering/python-3.12-upgrade.md:8` |

**仓库内不存在 3.7→3.12 的过渡提交**：fork 历史从 `0bc93d5` 起点已带 3.12
胶水，3.7 vendored 源码从未入库。仓库内 3.7 状态的唯一在案记录是 fork 自身
文档与 `BUILD-NOTES.md` 构建日志。

## 2. 运行时基线：四条已验事实

1. **Windows 工程已链 3.12。** 九个 `.vcxproj` 引用 `python312_d.lib` /
   `python312.lib`——如 `kbe/src/server/baseapp/baseapp.vcxproj:118` 与
   `:174`；完整清单：baseapp、cellapp、dbmgr、loginapp、bots、guiconsole、
   interfaces、kbcmd、logger。`grep -rl python37 kbe/src
   --include=*.vcxproj` 为空。
2. **fork 自身升级文档滞后（源仓文档漂移）。**
   `docs/zh/guide/engineering/python-3.12-upgrade.md:8` 仍写「当前 vendored
   版本是 3.7.3」，`:18-21` 所列阻塞项（旧 `Makefile` 库名、
   `PyEval_InitThreads`、硬编码 `python37`）在 HEAD 已全部解决（Makefile
   已版本无关：`kbe/src/lib/Makefile:46`；其余见 §3）。`docs/
   python-3.12-upgrade-notes.md` 与 `docs/zh/python-3.12-upgrade-notes.md`
   为兼容 stub 页，指向该指南页。按任务口径，此漂移**只在本页如实记录、
   不在本任务内修**——那是 kbengine 仓的事。
3. **`script.cpp:255` 仍留有 `PyEval_InitThreads()` 调用**，但该调用点在
   3.11+ 构建下已被中和：`scriptstdouterrhook.h:11-15`（经 `script.h:11`
   引入）在 `PY_VERSION_HEX >= 0x030B0000` 时把 `PyEval_InitThreads()` 定义
   为 `((void)0)`。3.12 构建下 `script.cpp:255` 的文本级调用展开为空操作——
   无运行时调用、无弃用告警。官方状态
   （[Python 域](https://docs.python.org/3/whatsnew/3.13.html#c-api-changes)）：
   3.7 起为空操作、3.9 起弃用、3.13 移除（3.13 beta 又以弃用态恢复，
   [gh-117929](https://github.com/python/cpython/issues/117929)）。
4. **vendored `kbe/src/lib/python/` 树不可从 fork 取回**：HEAD 及所有历史
   提交中 `git ls-files kbe/src/lib/python` = 0（`git log --diff-filter=A`
   为空），目录不在盘上，且无任何 `.gitignore` 规则排除它——是单纯从未
   入库。结论：一切 3.7→3.12 偏差须引官方 Python 变更记录；3.7 `docs/api`
   CHM 源料不得当作源码真相。

## 3. 嵌入层 C API 审计（`kbe/src/lib/pyscript` + `lib/server`）

扫描模式：`Py_UNICODE`、legacy `PyUnicode_*` wstr API、`PyString_*`、
`PyEval_Call*`、`Py_SetProgramName`、`Py_SetPythonHome`、`Py_SetPath`、
`Py_SetProgramFullPath`、`PySys_SetArgv(Ex)`、`PySys_SetPath`、
`PyEval_InitThreads`、`Py_InitModule`、`PyOS_AfterFork`，以及
`PyArg_ParseTuple` 已移除格式符 `u` / `Z`。结果：`lib/server` 与
`lib/client_lib` **干净（0 命中）**；`lib/pyscript` 恰好四个符号：

| 符号 | 位置（fork 域） | 3.12 下 | 3.13+ 下 | 结论 |
| --- | --- | --- | --- | --- |
| `PyEval_InitThreads()` | `script.cpp:255`（调用文本） | 编译为空操作——被 `scriptstdouterrhook.h:11-15` 宏遮蔽；官方口径为弃用空操作（[Python 域](https://docs.python.org/3/whatsnew/3.13.html#c-api-changes)） | 宏守卫同样覆盖 3.13（3.13 移除后以弃用态恢复，[gh-117929](https://github.com/python/cpython/issues/117929)） | **无需动作**——死文本留存，行为正确 |
| `Py_SetPythonHome()` | `script.cpp:203`——**无条件调用**（不在任何版本守卫内） | 3.11 起弃用，仍存在、仍可用（[Python 域](https://docs.python.org/3/whatsnew/3.13.html#c-api-changes)） | **3.13 已移除** → 该行对 3.13 头文件无法编译 | **任何 3.13 目标前必须改**（改用 `PyConfig.home`，3.11+ 分支已在 `script.cpp:38` 这样做） |
| `PySys_SetArgvEx(0, NULL, 0)` | `script.cpp:239`——**无条件调用** | 3.11 起弃用，仍存在（[Python 域](https://docs.python.org/3/whatsnew/3.13.html#c-api-changes)） | **3.13 已移除** → 对 3.13 头文件编译失败 | **任何 3.13 目标前必须改**（`PyConfig.argv`，`script.cpp:31` 已设 `config.parse_argv = 0`） |
| `Py_SetPath()` | `script.cpp:226`——位于 `#if PY_VERSION_HEX >= 0x030B0000` 的 `#else` 分支（`script.cpp:215-235`） | **不参与编译**——3.12 构建下是死代码 | 同（该分支仅限 pre-3.11） | **无需动作**——当前目标下为死代码 |

legacy Unicode 扫描：`kbe/src` 全树 `Py_UNICODE` / `PyUnicode_AS_UNICODE` /
`PyUnicode_FromUnicode` / `PyUnicode_GET_SIZE` / `PyString_*` **零命中**
——PEP 623 移除（[Python 域](https://docs.python.org/3/whatsnew/3.12.html#porting-to-python-3-12)）
对本代码库无影响。`PyArg_ParseTuple` 已移除格式符 `u`/`Z`（同一官方出处）：
零命中。

## 4. 脚本层 3.7→3.12 偏离清单骨架

范围：仅限影响 KBEngine Python API 整合各篇的子集。服务端脚本可见的
stdlib 移除项已对 fork 自身可部署模板（`kbe/res/sdk_templates/`、
`kbe/res/scripts/`）扫描：

| 条目 | 官方记录（Python 域） | fork 侧核查（fork 域） | 状态 |
| --- | --- | --- | --- |
| `distutils` 移除（PEP 632） | [What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html) | 模板/脚本 `import distutils`：0 命中 | 已取证——未触发偏离 |
| `asynchat` / `asyncore` 移除 | [What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html#removed) | `import asyncore`/`import asynchat`：0 命中 | 已取证——未触发偏离 |
| `imp`：3.11 弃用，预告 3.12 移除 | [What's New 3.11](https://docs.python.org/3/whatsnew/3.11.html) | `import imp`：0 命中 | 已取证——未触发偏离 |
| int↔str 转换位数上限（默认 4300，进制≠2/4/8/16/32） | [3.11 changelog，CVE-2020-10735 缓解](https://docs.python.org/release/3.11.1/whatsnew/changelog.html) | 脚本侧最大整数为 `genUUID64` = 无符号 64 位 → ≤ 20 位（`script.cpp:106` `PyLong_FromUnsignedLongLong`）；实体整数属性为 INT8..INT64 声明域（`datatypes.cpp:58` `UINT64`、`:64` `INT64`） | 已取证推断——对 KBEngine API 面无影响 |
| 其余 str/bytes/迭代器语义差异 3.8→3.12 | 官方 What's New 3.8–3.12 | — | **待取证**——取证途径：各篇撰写时按 KB-API 主题逐版本扫官方 What's New 3.8/3.9/3.10/3.11/3.12，再用 3.12 构建对官方 `python_assets` 脚本实测。不得从 3.7 CHM 文本反推（见 §2.4） |
| 上表四项之外的嵌入层 C API 偏差 | 官方 What's New 3.12/3.13 | — | **待取证**——取证途径：fork 每声明一个新 CPython minor，重跑 §3 扫描；当前无其他命中 |

## 5. 对 kode 插件用户（脚本作者）的影响面

只列 fork 已落地/已声明的事实；不推测未实现的迁移步骤：

- **双轨构建现实**：Windows 构建钉死 CPython 3.12（`baseapp.vcxproj:118`
  等 9 处，§2.1）；Linux 构建链 `find_package(Python3 ... Development)`
  解析到的任意版本——2026-11-02 已验证 3.7.17 构建可跑
  （`git show 855a06d:BUILD-NOTES.md`）。脚本应同时兼容 **3.7 与 3.12**；
  引擎源码仅存在一条版本分界 `PY_VERSION_HEX >= 0x030B0000` 的条件路径
  （`script.cpp:26`、`:215`）。
- **嵌入解释器环境是封闭的**：3.11+ 初始化路径设 `site_import = 0`、
  `use_environment = 0`、`parse_argv = 0`、`install_signal_handlers = 0`
  （`script.cpp:31-36`）；pre-3.11 分支设 `Py_NoSiteFlag = 1`、
  `Py_IgnoreEnvironmentFlag = 1`（`script.cpp:223-224`）。对两条基线的
  共同实践读法：`PYTHONPATH`/环境变量不影响嵌入运行时、`sys.argv` 为空、
  无 `site-packages`、引擎不安装 Python 信号处理器。
- **stdlib 布局由引擎主导**：模块搜索路径来自 `SCRIPT_PATH` 派生的引擎
  脚本目录（`script.cpp:200` `APPEND_PYSYSPATH`、`PyConfig.
  module_search_paths` `:35-74`；legacy `Py_SetPath` `:226`）。引擎期望
  `kbe/res/scripts/common/` 就是部署布局的 stdlib 根目录（声明见
  `git show 855a06d:BUILD-NOTES.md` 坑 7）——stdlib 部署到该处；不得假设
  系统级 Python 安装可用。
- **C 边界上脚本层再无其他变化**：§3 审计未发现 legacy Unicode 用法、
  已移除格式符，且 3.12 下初始化路径已是 `PyConfig`——按官方 3.7 文档
  写的服务端脚本走同一条 `Script::install()` 注册路径
  （`script.cpp:197-289`），与基线无关。

## 6. 与官方 KBEngine v3.7 源料的口径关系

- fork **不是**官方 KBEngine v3.7：上游嵌入运行时为 vendored 3.7.3，fork
  Windows 构建目标 3.12、Linux 构建与解释器无关（§1、§2.1）。
- 知识库 grounding 以 **本 fork** 为准（`c2a3b8f`，HEAD `6d12b8f` 之
  祖先）。官方 3.7 时代 `docs/api` CHM 源料与 fork 不一致处，**以 fork
  为准**，并将分歧显式标注，不得静默抹平。
- 源仓升级指南页（`docs/zh/guide/engineering/python-3.12-upgrade.md:8`）仍写
  「vendored 3.7.3」，按源仓文档漂移如实记录（§2.2）；KB 各篇不得引该页
  作为运行时基线的权威出处——引本页 §2。
- 修该漂移页属 kbengine 仓任务，**不在 KB-API-001 范围内**。

## 7. KB-API-002~008 统一差异标注模板

每篇 KB-API 文末固定格式差异小节（保留标题、填行；表为空时显式写
「无偏离 / No deviation」——不得整节省略）：

```markdown
## 3.7 源料 vs fork 3.12 差异

| 条目 | 官方 3.7 源料口径 | fork 3.12 实际 | 取证域 | 证据 |
| --- | --- | --- | --- | --- |
| <API/行为> | <docs/api CHM 文本主张> | <已验证的 fork 行为，或「相同——无偏离」> | Fork / Python / 插件层 | `kbe/src file:line` 或 CPython 官方 URL 或「插件层（本仓库外）」 |
```

规则：
1. 每行引且仅引一个证据域，在**取证域**列标注：`Fork`（`kbe/src`
   file:line）、`Python`（`docs.python.org` 官方 URL）、`插件层`
   （实现不在 `kbe/src`——客户端 SDK API 按 KB-API-002 口径使用）。
2. 未取证行写 **待取证** 并写明取证途径（跑哪条 grep、查哪个官方页面、
   做哪个运行时实测）——不得留空，不得用似是而非的文字填充。
3. 本页 §4 已是「已取证——未触发偏离」的条目，各篇用指针引用
   （「见 python-version-baseline §4」）即可，不必逐篇重新取证。
4. en 篇为 canonical（行号漂移检查基准）；zh 镜像同主张同引用。

## 参考出处

- fork：`kbe/src/lib/pyscript/script.cpp`（`:26-88`、`:197-289`）、
  `scriptstdouterrhook.h:10-15`、`script.h:11`、`kbe/src/lib/Makefile:46`、
  `kbe/src/server/baseapp/baseapp.vcxproj:118`、`:174`、
  `kbe/src/lib/entitydef/datatypes.cpp:53-64`
- fork 历史：根提交 `0bc93d5`（2026-09-25）、`855a06d`（2026-11-02，
  `BUILD-NOTES.md`）、`c2a3b8f`（grounding 基准）、HEAD `6d12b8f`
- fork 文档：`docs/zh/guide/engineering/python-3.12-upgrade.md`（滞后基线；
  `docs/guide/engineering/python-3.12-upgrade.md` 为跳转 stub）、
  `docs/python-3.12-upgrade-notes.md` / `docs/zh/python-3.12-upgrade-notes.md`
  （stub 页）
- Python：[What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html)
  （PEP 623、PEP 632、移除项）、
  [What's New 3.13 · Removed C APIs](https://docs.python.org/3/whatsnew/3.13.html#c-api-changes)、
  [gh-117929 PyEval_InitThreads 恢复](https://github.com/python/cpython/issues/117929)、
  [3.11 changelog：int↔str 位数上限](https://docs.python.org/release/3.11.1/whatsnew/changelog.html)
