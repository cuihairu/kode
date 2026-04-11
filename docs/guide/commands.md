# 命令与面板

本页整理 Kode 在 VSCode 中暴露的主要命令、入口位置和适用场景。

## 命令面板中的命令

可以通过 `Cmd/Ctrl + Shift + P` 打开命令面板，输入 `KBEngine` 或 `Kode` 查找相关命令。

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
  - 命令面板

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
- 作用：根据 `.kbengine/debug.json` 生成或更新 VSCode 的 PID attach 配置

### `kbengine.debug.createConfig`

- 标题：`Create Debug Config Template`
- 作用：创建示例调试配置文件 `.kbengine/debug.json`

### `kbengine.debug.start`

- 标题：`Start Debugging`
- 作用：显示目标组件的 telnet 调试提示，然后进入 PID attach 流程

### `kbengine.debug.attach`

- 标题：`Attach to Component`
- 作用：按 PID 附加到已开启调试的 KBEngine 组件进程

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
3. 生成 `.def` 与可选 Python 文件
4. 如果启用了 `kbengine.generator.registerInEntitiesXml`，写入 `entities.xml`
5. 在实体浏览器中继续编辑

### 查看线上行为

1. 启动需要观察的组件
2. 打开日志查看器
3. 打开监控面板观察资源变化
4. 使用依赖图查看实体关系

注意：
日志与监控都依赖 KBEngine 的协议交互。
日志协议适配当前尚未完成；监控面板在 watcher 无响应时只保留 machine 返回的基础状态。

### 调试某个组件

1. 先执行 `Create Debug Config Template`，生成 `.kbengine/debug.json`
2. 在 `.kbengine/debug.json` 里填写目标组件的 `telnetHost`、`telnetPort`、`telnetEnableCommands` 和 `pathMappings`
3. 运行 `Start Debugging` 查看提示，先通过 telnet 向目标组件输入项目实际使用的开启调试命令
4. 再执行 `Attach to Component`，输入目标组件进程 PID

## 命令是否支持配置联动

支持。很多命令会读取 `kbengine.*` 设置，例如：

- 实体导航读取 `kbengine.entityDefsPath`
- 服务器启动读取 `kbengine.autoStart`
- 日志面板读取 `kbengine.loggerPort`
- 依赖图读取 `kbengine.entitiesXmlPath` 和 `kbengine.entityDefsPath`
- 生成器读取 `kbengine.generator.*`

调试流程是例外。调试不再读取旧的 `kbengine.pythonPath`、`kbengine.debugPort`、`kbengine.autoAttachDebug`，而是统一读取 `.kbengine/debug.json`。

## 调试命令说明

### `Attach to Component`

KBEngine 的调试模型不是“启动一个 Python 文件”。这里的 Python 运行时是嵌在 C++ 组件进程里的，因此扩展只保留两步：

1. 通过 telnet 向目标组件输入项目实际使用的开启调试命令
2. 通过 `debugpy` 的 `processId` 方式附加到已开启调试的进程

扩展生成的 `launch.json` 会固定为 PID attach 形式：

```json
{
  "name": "KBEngine: Attach to baseapp",
  "type": "debugpy",
  "request": "attach",
  "processId": "${input:kbengineProcessId}",
  "justMyCode": false,
  "pathMappings": [
    {
      "localRoot": "${workspaceFolder}",
      "remoteRoot": "${workspaceFolder}"
    }
  ]
}
```

### 推荐使用顺序

1. 运行 `Create Debug Config Template`
2. 在 `.kbengine/debug.json` 中填写 telnet 地址、端口、开启调试命令和路径映射
3. 运行 `Update launch.json`
4. 运行 `Start Debugging` 查看提示并先开启调试
5. 运行 `Attach to Component`，输入 PID

### 排查要点

如果 `Attach to Component` 失败，优先检查这些点：

1. 目标 KBEngine 组件是否已经通过 telnet 真正开启调试
2. 输入的 PID 是否就是目标组件进程，而不是其他 manager 或辅助进程
3. `.kbengine/debug.json` 中的 `telnetEnableCommands` 是否与项目真实命令一致
4. `.kbengine/debug.json` 中的 `pathMappings` 是否映射到当前工作区源码目录
5. 当前机器里是否已经安装并启用 `ms-python.debugpy`
