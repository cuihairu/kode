# 嵌入式 CPython 3.7.3

## 核对运行版本

以实际故障组件的启动日志和引擎内运行结果为准。在已获准的隔离调试环境，用目标进程中的 Python 控制台查看：

```python
import sys
import sysconfig
import KBEngine

print(sys.version)
print(sys.executable)
print(sysconfig.get_config_var("SOABI"))
print(KBEngine.component)
print(sys.path)
```

独立 `python3.7` 可做语法和普通单元测试。引擎内的 `KBEngine` 模块由宿主注入，实体创建、计时器、远端调用和生命周期要在引擎组件内实测。系统包版本、编译使用的头文件和实际加载的库需要分别核对。Linux 可用 `readelf -d` 查动态依赖，并检查所加载库的实际路径，静态链接以构建记录和组件启动日志为依据。

## 启动、导入与绑定

沿 `kbe/src/lib/server/python_app.cpp` 的解释器安装入口，追到 `kbe/src/lib/pyscript/script.cpp` 的 `Script::install`。核对资源根目录、显式脚本搜索路径、环境变量处理及当前组件安装的模块。导入失败时记录 `sys.path`、模块 `__file__` 和完整 traceback。验证应在故障进程对应的 Base、Cell 或其他组件执行。

维护原生扩展时，核对实参转换是否检查错误、返回值是否满足 Python C API 契约、引用所有权及跨线程调用。重点检查 `PyObject_Call*` 失败返回空指针后的异常传播，区分借用引用和新引用，以及任何离开游戏逻辑线程的回调是否正确交还调度器或持有 GIL。按同一 OS、架构和 3.7 ABI 构建扩展，并从目标进程验证其二进制依赖。

## 热重载

从 `PythonApp::reloadScript` 跟到实际组件的实体定义和脚本重载实现，核对重载范围、存量实例使用旧类或新类的方法、定时器和已注册回调。用存量实体与重载后新建实体各验证一次。涉及 `.def` 属性标记、方法参数、持久化字段或客户端 SDK 时，重新核对协议和 schema，再决定是否需要协调服务端及客户端发布。

## 语言边界

保留 Python 3.7 语法和标准库。遇到 `match`、`list[str]`、运行时类型联合 `X | Y`、`asyncio.to_thread` 或较新的 C API，使用 3.7 可运行的写法。脚本、引擎绑定和原生依赖各有独立的兼容性验证。

- [CPython v3.7.3 源码](https://github.com/python/cpython/tree/v3.7.3)
- [KBEngine 2.5.12 内嵌解释器版本头](https://github.com/kbengine/kbengine/blob/7d379b9f943d2731b09c45398855f98efe74d046/kbe/src/lib/python/Include/patchlevel.h)
