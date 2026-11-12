# KBEngine Python 调试版本锁定

核查日期：2026-11-11。**引擎使用 Python 3.7.3 时，固定 `debugpy==1.7.0` 和 `ms-python.debugpy@2024.0.0`。不能把开发机 Python 更高当作引擎也能用新版 debugpy 的依据。**

## 1. 官方依据和锁定表

Microsoft 的 [Python Debugger 兼容表](https://github.com/microsoft/vscode-python-debugger#limited-support-for-deprecated-python-versions) 将 Python 3.7 对应到 2024.0.x 扩展及 debugpy 1.7.0；Python 3.8 对应到 2024.2.x/1.8.1，Python 3.9 对应到 2025.5.x/1.8.13。表中是扩展支持线，不代表同表 debugpy 包的最低 Python 版本。

| 对象 | Python 3.7.3 项目固定值 | 证据/含义 |
| --- | --- | --- |
| 引擎内 debugpy 包 | **1.7.0**，严格等号 | [PyPI 1.7.0](https://pypi.org/project/debugpy/1.7.0/) 要求 Python ≥3.7；[1.8.0](https://pypi.org/project/debugpy/1.8.0/) 已要求 ≥3.8。不要使用 `>=1.7.0`。 |
| Python Debugger 扩展 | **ms-python.debugpy@2024.0.0** | 选定 2024.0.x 的确切版本；[该版本 manifest](https://github.com/microsoft/vscode-python-debugger/blob/v2024.0.0/package.json) 要求 VS Code ^1.78.0。它是实际调试适配器扩展，不是 pip 包。 |
| Python 扩展 | **ms-python.python@2024.0.1**，作为本项目的复现基线 | [该版本 manifest](https://github.com/microsoft/vscode-python/blob/v2024.0.1/package.json) 要求 VS Code ^1.82.0。这是本项目选择的固定配套版本，**不是官方声明的 Python 3.7 最后支持版本**。 |
| VS Code 宿主 | 至少 **1.82.0**，实际采用版本应登记 | 同时满足 Kode 和上面 Python 扩展 manifest；不宣称任意未来宿主都验证过，也不要求仅为旧 Python 降级整个 VS Code。 |
| Pylance 等分析扩展 | 本文不指定一个未经验证的强制版本 | 分析器与调试器不同；如需整体环境锁定，另外登记安装版本和验证结果。不能用 Pylance 版本代替 debugpy 兼容检查。 |

Python 扩展与 Python Debugger 已拆分，[2024.0.0 官方 README](https://github.com/microsoft/vscode-python-debugger/blob/v2024.0.0/README.md#purpose) 明确说明可独立保留旧调试器。因此，必须锁的是调试器支持线；上面同时固定 Python 扩展是为了可复现，不是说新版 Python 扩展一律不能配旧调试器。

## 2. 安装 VS Code 扩展并禁止自动漂移

建议为旧引擎建立独立 VS Code Profile，避免影响现代 Python 项目。先安装 Python 扩展，最后安装固定的调试器，避免依赖安装过程重新带入新版 debugger：

```sh
code --profile KBEngine-Py37 --install-extension ms-python.python@2024.0.1 --force
code --profile KBEngine-Py37 --install-extension ms-python.debugpy@2024.0.0 --force
code --profile KBEngine-Py37 --list-extensions --show-versions
```

确认输出中两项精确匹配。UI 可用 **Install Another Version**；离线机器使用对应平台的固定 VSIX，并保存文件 SHA-256 和内含 `extension/package.json` 版本。安装方式见 [VS Code 官方扩展管理文档](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#install-an-extension)。若历史版本列表不显示，Microsoft 兼容表说明可以临时切换预发布列表查找旧版；装好后仍须确认最终固定版本。

在扩展菜单关闭这两项的 Auto Update。旧版 VS Code 没有单扩展开关时，在这个 Profile 的**用户设置**配置：

```json
{
  "extensions.autoUpdate": false
}
```

不要把用户级设置当作一定会在工作区生效的锁。`.vscode/extensions.json` 的 recommendations 只推荐 ID，**不能锁定版本**。Settings Sync、远程 SSH/容器宿主、手工“全部更新”和重新安装扩展包也可能改变有效版本；在实际运行调试器的宿主重新检查。VSIX 安装和单项更新开关的行为参见 [官方自动更新说明](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#extension-auto-update)。

## 3. 安装引擎端 debugpy 包

仓库提供 [固定 requirements](https://github.com/cuihairu/kode/blob/main/scripts/requirements/debugpy-py37.txt)。在与引擎相同版本、架构和目标平台的独立 Python 环境中执行：

```sh
/path/to/python3.7 -c "import sys; print(sys.version, sys.executable)"
/path/to/python3.7 -m pip install --force-reinstall -r scripts/requirements/debugpy-py37.txt
/path/to/python3.7 -c "import debugpy; print(debugpy.__version__, debugpy.__file__)"
```

引擎为 3.7.3 时，核对真实解释器输出，而不仅看文件名 `python3.7`。可固定在专用 venv；不要为了调试旧引擎覆盖其他项目环境。

禁止对这条目标环境使用裸 `pip install -U debugpy`、`--ignore-requires-python` 或从现代解释器直接复制 debugpy 包。包版本、CPython ABI、操作系统和架构都要匹配；不同目标的原生 vendored pydevd 扩展不能混用。更高版本引擎另走自己的版本组合，不要反向覆盖这个 requirements 文件。

## 4. 当前 Kode 自动路径的明确阻塞

截至本次检查，以下代码仍有旧假设，**本次仅核实版本并更新文档，没有将它们伪装成已经修复**：

- `src/autoDebugpy.ts` 的 `EMBEDDED_PYTHON_VERSION='3.12.13'`、`MIN_DEBUGPY_VERSION='1.8.0'` 会错误拒绝 Python 3.7 所需的 1.7.0。
- `src/backend/debugpyPreflight.ts` 共用该门槛；`debugpyPortProbe.ts` 的一键安装和手工提示仍使用 `-U debugpy`，没有以引擎目标版本选包。
- 资产树包存在时的放行仅检查存在性，不证明它对 Python 3.7 可导入。

因此 Python 3.7.3 项目目前**不要使用一键升级/自动包同步来建立这个锁定环境**。先按固定 requirements 准备正确包，再手工部署到 `<assets>/scripts/common/debugpy`。已有目录先备份到监视树之外；在空的暂存目录复制整个 debugpy 包后替换目标目录，不能把 1.7.0 与旧的 1.8.x 残留文件合并。用固定 Python 环境查询 `debugpy.__file__` 找源目录，不从现代系统 Python 或最新 VS Code 扩展目录取包。

在目标引擎 telnet 的 Python 层检查实际导入来源：

```python
import sys, debugpy
print(sys.version)
print(debugpy.__version__)
print(debugpy.__file__)
debugpy.listen(("127.0.0.1", 5678))
```

输出必须是 3.7.3 / 1.7.0，且路径指向已部署的包。同步包不等于监听已启动，端口可连也不等于断点已命中。新开进程验证，避免旧模块缓存影响结果。

## 5. launch.json 与跨版本隔离

```json
{
  "name": "KBEngine Py37 attach",
  "type": "debugpy",
  "request": "attach",
  "connect": { "host": "127.0.0.1", "port": 5678 },
  "justMyCode": false
}
```

远程/路径不同添加实际 `pathMappings`；不同进程使用不同监听端口。本节不保证 PID 注入对任意嵌入式引擎 ABI 都可用，先采用引擎内明确 `listen` 的 connect 路径。

现代开发机的工具 Python、VS Code adapter 所用 Python、引擎内 Python 是三个角色。升级其中一个不会自动升级另外两个；不要因宿主是 Python 3.12/3.14 就给 3.7.3 引擎同步新版包。

## 6. 更高 Python 版本的处理

Python 3.8 可参考官方 2024.2.x / debugpy 1.8.1 支持线，Python 3.9 可参考 2025.5.x / 1.8.13 支持线；新工程仍需从实际版本 manifest、包元数据和运行验证选定确切版本，不把 `x` 写成安装命令。

[debugpy 1.8.13 的 PyPI 元数据](https://pypi.org/project/debugpy/1.8.13/) 仍写 Python ≥3.8，而当前扩展表对 2025.5.x 写 ≥3.9：这是**不同组件的支持条件**，不能混为一条最低 Python 约束。“升级 Python 后可选更高版本”成立，但不是任意 Python 版本都可以无条件安装最新 debugpy 和最新 VS Code 扩展。

## 7. 本次验证和未验证项

- 已核实官方兼容表、debugpy 1.7.0/1.8.0 元数据及两个固定扩展的 manifest。
- 在临时目录下载 cp37-cp37m Linux x86-64 wheel，用精确 CPython 3.7.3 导入成功，输出 `3.7.3 1.7.0`；没有修改系统 Python 包或 VS Code 已安装扩展。
- 进一步运行 `debugpy.listen`：本机临时构建的 CPython 3.7.3 + cp37 Linux wheel 进程退出码为 **139**；关闭 `PYDEVD_USE_CYTHON`/`PYDEVD_USE_FRAME_EVAL` 后同样退出，原因尚未定位，不能归因于某个加速模块，也不能据此声称所有 Python 3.7.3 安装均失败。这组本机环境目前**只确认导入，未确认监听可用**。
- 真实 VS Code 断点、目标 Windows 引擎、多进程及 PID 注入仍待验证；未完成项不能用导入成功抵扣。
- 自动安装、预检、同步和扩展版本诊断的修复见 TODO 中 `DBG-COMPAT-*`，不能只改一条 pip 命令就标整链完成。
