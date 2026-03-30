# 命令与面板

本页整理 Kode 在 VSCode 中暴露的主要命令、入口位置和适用场景。

## 命令面板中的命令

你可以通过 `Cmd/Ctrl + Shift + P` 打开命令面板，输入 `KBEngine` 或 `Kode` 查找相关命令。

## 实体浏览器

### `kbengine.refreshExplorer`

- 标题：`Refresh`
- 作用：刷新实体浏览器列表
- 入口：
  - 实体浏览器标题栏按钮
  - 命令面板

### `kbengine.entity.open`

- 标题：`Open Entity Definition`
- 作用：打开指定实体的 `.def` 文件
- 入口：
  - 点击实体浏览器中的实体项
  - 命令调用

## 服务器控制

### `kbengine.server.start`

- 标题：`Start Server`
- 作用：
  - 传入组件时启动单个组件
  - 不传组件时按 `kbengine.autoStart` 启动一组组件

### `kbengine.server.stop`

- 标题：`Stop Server`
- 作用：
  - 传入组件时停止单个组件
  - 不传组件时停止全部组件

### `kbengine.server.restart`

- 标题：`Restart Server`
- 作用：重启单个组件

### `kbengine.server.showLogs`

- 标题：`Show Logs`
- 作用：聚焦某个组件的日志上下文

## 日志相关

### `kbengine.logs.showViewer`

- 标题：`Show Log Viewer`
- 作用：打开日志 WebView

### `kbengine.logs.connect`

- 标题：`Connect to Logger`
- 作用：连接 KBEngine logger 端口

### `kbengine.logs.disconnect`

- 标题：`Disconnect from Logger`
- 作用：断开日志连接

### `kbengine.logs.clear`

- 标题：`Clear Logs`
- 作用：清空当前日志面板缓存

### `kbengine.logs.export`

- 标题：`Export Logs`
- 作用：导出日志内容

## 调试相关

### `kbengine.debug.updateLaunchJson`

- 标题：`Update launch.json`
- 作用：根据当前 KBEngine 配置生成或更新 VSCode 调试配置

### `kbengine.debug.createConfig`

- 标题：`Create Debug Config Template`
- 作用：创建示例调试配置文件

### `kbengine.debug.start`

- 标题：`Start Debugging`
- 作用：启动指定组件的调试流程

### `kbengine.debug.attach`

- 标题：`Attach to Component`
- 作用：附加到已有组件进程

## 可视化面板

### `kbengine.monitoring.show`

- 标题：`Show Monitoring Panel`
- 作用：打开监控面板

### `kbengine.dependency.show`

- 标题：`Show Entity Dependency Graph`
- 作用：打开实体依赖关系图

依赖图面板支持：

- 刷新依赖图
- 在图中打开实体定义
- 导出 SVG
- 导出 PNG

## 代码生成器

### `kbengine.generator.wizard`

- 标题：`Create Entity from Wizard`
- 作用：通过向导逐步创建实体

### `kbengine.generator.templates`

- 标题：`Create Entity from Template`
- 作用：从预定义模板快速生成实体

## 典型使用流程

### 新建实体

1. 运行 `Create Entity from Wizard`
2. 选择输出配置
3. 生成 `.def` 与 Python 文件
4. 自动写入 `entities.xml`
5. 在实体浏览器中点击打开并继续编辑

### 查看线上行为

1. 启动服务器控制面板中的组件
2. 打开日志查看器
3. 打开监控面板观察资源变化
4. 使用依赖图查看实体结构关系

### 调试某个组件

1. 先配置 `kbengine.pythonPath` 与调试端口
2. 运行 `Update launch.json`
3. 执行 `Start Debugging` 或 `Attach to Component`

## 命令是否支持配置联动

支持。很多命令会读取 `kbengine.*` 设置，例如：

- 实体导航读取 `kbengine.entityDefsPath`
- 服务器启动读取 `kbengine.autoStart`
- 日志面板读取 `kbengine.loggerPort`
- 调试流程读取 `kbengine.pythonPath`、`kbengine.debugPort`
- 生成器读取 `kbengine.generator.*`
## 调试命令兼容说明

### `Attach to Component`

在旧版开发环境中：

- VSCode 1.50.x
- ms-python.python 2020.8.109390
- Python 3.7.3

`Attach to Component` 依赖旧版 Python 扩展的调试配置格式。生成的 `launch.json` 应保持为：

```json
{
  "type": "python",
  "request": "attach",
  "pythonPath": "python",
  "host": "localhost",
  "port": 5678
}
```

不要将其写成较新的配置形式：

```json
{
  "type": "debugpy",
  "request": "attach",
  "connect": {
    "host": "localhost",
    "port": 5678
  }
}
```

在旧版 Python 扩展里，后者可能无法被正确识别，并在附加时出现误导性的提示：

```text
Test discovery err,please check the configuration settings for the tests
```

### 推荐使用顺序

1. 先配置 `kbengine.pythonPath` 和 `kbengine.debugPort`
2. 运行 `Update launch.json`
3. 确认目标进程已经监听调试端口
4. 再执行 `Attach to Component`

### 报错说明

如果出现：

```text
Test discovery err,please check the configuration settings for the tests
```

优先检查以下内容：

1. Python 扩展选中的解释器是否就是项目使用的 Python 3.7.3
2. 当前工作区是否误开启了 `python.testing.*`
3. 目标进程是否真的已打开调试端口
4. `launch.json` 是否仍包含不兼容旧版扩展的 `debugpy` / `connect` / `python` 字段

这条错误多数情况下并不是真正的“测试发现配置错误”，而是旧版 Python 扩展在调试配置解析、解释器调用或模块导入失败后的统一兜底提示。
