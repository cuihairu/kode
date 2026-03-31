# 配置说明

本页整理 Kode 当前支持的所有 `kbengine.*` 配置项，并补充使用场景、推荐值和常见组合。

## 配置方式

在 VSCode 的 `settings.json` 中配置：

```json
{
  "kbengine.enableDiagnostics": true,
  "kbengine.hover.showTagDocs": false,
  "kbengine.entityDefsPath": "scripts/entity_defs"
}
```

## 推荐配置模板

### 低噪音日常开发

```json
{
  "kbengine.enableDiagnostics": true,
  "kbengine.enableStructureDiagnostics": true,
  "kbengine.diagnostics.checkUnknownTypes": true,
  "kbengine.diagnostics.checkUnknownFlags": true,
  "kbengine.diagnostics.checkUnknownDetailLevels": true,
  "kbengine.diagnostics.checkFlagConflicts": true,
  "kbengine.diagnostics.checkDuplicateDefinitions": false,
  "kbengine.diagnostics.checkInvalidChildren": false,
  "kbengine.diagnostics.checkMissingPropertyFields": false,
  "kbengine.hover.showTagDocs": false,
  "kbengine.hover.showValueDocs": true,
  "kbengine.hover.showSymbolDocs": true
}
```

### 严格校验模式

```json
{
  "kbengine.enableDiagnostics": true,
  "kbengine.enableStructureDiagnostics": true,
  "kbengine.diagnostics.checkUnknownTypes": true,
  "kbengine.diagnostics.checkUnknownFlags": true,
  "kbengine.diagnostics.checkUnknownDetailLevels": true,
  "kbengine.diagnostics.checkFlagConflicts": true,
  "kbengine.diagnostics.checkDuplicateDefinitions": true,
  "kbengine.diagnostics.checkInvalidChildren": true,
  "kbengine.diagnostics.checkMissingPropertyFields": true,
  "kbengine.hover.showTagDocs": true,
  "kbengine.hover.showValueDocs": true,
  "kbengine.hover.showSymbolDocs": true
}
```

## 配置总览

| 配置项 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `kbengine.enableDiagnostics` | `boolean` | `true` | 总开关，控制 `.def` 诊断是否启用 |
| `kbengine.enableStructureDiagnostics` | `boolean` | `true` | 控制结构化校验是否启用 |
| `kbengine.diagnostics.checkUnknownTypes` | `boolean` | `true` | 检查未知类型 |
| `kbengine.diagnostics.checkUnknownFlags` | `boolean` | `true` | 检查未知 Flags |
| `kbengine.diagnostics.checkUnknownDetailLevels` | `boolean` | `true` | 检查未知 DetailLevel |
| `kbengine.diagnostics.checkFlagConflicts` | `boolean` | `true` | 检查 `BASE` 与 `CELL_*` 冲突 |
| `kbengine.diagnostics.checkDuplicateDefinitions` | `boolean` | `true` | 检查重复属性和重复方法 |
| `kbengine.diagnostics.checkInvalidChildren` | `boolean` | `true` | 检查错误的子标签位置 |
| `kbengine.diagnostics.checkMissingPropertyFields` | `boolean` | `true` | 检查属性缺少 `Type` / `Flags` |
| `kbengine.hover.showTagDocs` | `boolean` | `true` | 悬停标签时显示说明 |
| `kbengine.hover.showValueDocs` | `boolean` | `true` | 悬停类型、Flags、等级值时显示说明 |
| `kbengine.hover.showSymbolDocs` | `boolean` | `true` | 悬停自定义属性或方法时显示摘要 |
| `kbengine.entityDefsPath` | `string` | `"scripts/entity_defs"` | 实体定义目录 |
| `kbengine.entitiesXmlPath` | `string` | `"scripts/entities.xml"` | `entities.xml` 路径 |
| `kbengine.binPath` | `string` | `"${workspaceFolder}/../kbe/bin/server"` | KBEngine 二进制目录 |
| `kbengine.configPath` | `string` | `"${workspaceFolder}/server"` | 服务器配置目录 |
| `kbengine.autoStart` | `string[]` | `["machine","logger","dbmgr"]` | 自动启动组件 |
| `kbengine.loggerPort` | `number` | `20022` | 日志端口 |
| `kbengine.logAutoConnect` | `boolean` | `true` | 启动服务器时自动连接日志 |
| `kbengine.maxLogEntries` | `number` | `10000` | 日志最大缓存数 |
| `kbengine.pythonDefsPath` | `string[]` | `["assets/scripts/entity_defs","scripts/entity_defs"]` | Python 定义搜索路径 |
| `kbengine.enablePythonNavigation` | `boolean` | `true` | 启用 Python 到 `.def` 的导航 |
| `kbengine.generator.defOutputPath` | `string` | `"scripts/entity_defs"` | 代码生成器 `.def` 输出目录 |
| `kbengine.generator.pythonOutputPath` | `string` | `"scripts"` | 代码生成器 Python 输出目录 |
| `kbengine.generator.generatePython` | `boolean` | `true` | 代码生成器是否生成 Python 文件 |
| `kbengine.generator.registerInEntitiesXml` | `boolean` | `true` | 生成后自动注册到 `entities.xml` |

## 逐项说明

### `kbengine.enableDiagnostics`

- 类型：`boolean`
- 默认值：`true`
- 作用：`.def` 诊断总开关

关闭后，类型错误、Flags 冲突、结构问题都不会再提示。

### `kbengine.enableStructureDiagnostics`

- 类型：`boolean`
- 默认值：`true`
- 作用：控制结构化检查

结构化检查主要包括：

- 重复属性或方法
- 错误的子标签位置
- 缺少 `Type` / `Flags`
- 属性内部重复定义多个 `Type` / `Flags`

### 诊断子项

#### `kbengine.diagnostics.checkUnknownTypes`

检查 `<Type>` 中未识别的类型名。

当前规则已经按 KBEngine 的真实模型区分两类类型：

- 内建基础类型：直接视为合法，不会去 `types.xml` 或 `user_type` 校验
- 用户自定义类型：先在 `types.xml` 注册，再到 `user_type/*.py` 查找对应 Python 文件

从上层 `kbengine` 源码看，类型定义是按 `entity_defs/types.xml` 体系加载的，而 `user_type` 会加入脚本路径。因此扩展当前按这些路径优先查找：

- `entity_defs/types.xml`
- `scripts/entity_defs/types.xml`
- `assets/scripts/entity_defs/types.xml`
- `user_type/<Type>.py`
- `scripts/user_type/<Type>.py`
- `assets/scripts/user_type/<Type>.py`

#### `kbengine.diagnostics.checkUnknownFlags`

检查 `<Flags>` 中未识别的标志值。

#### `kbengine.diagnostics.checkUnknownDetailLevels`

检查 `<DetailLevel>` 中非法值。

#### `kbengine.diagnostics.checkFlagConflicts`

检查 `BASE` / `BASE_CLIENT` 与 `CELL_*` 混用。

#### `kbengine.diagnostics.checkDuplicateDefinitions`

检查同一区块下的重名属性和方法。

#### `kbengine.diagnostics.checkInvalidChildren`

检查非法子标签，例如：

```xml
<BaseMethods>
  <moveTo>
    <Flags>BASE_CLIENT</Flags>
  </moveTo>
</BaseMethods>
```

这里的 `<Flags>` 会被识别为方法区块中的非法标签。

#### `kbengine.diagnostics.checkMissingPropertyFields`

检查属性缺少 `Type` / `Flags`，以及重复声明多个 `Type` / `Flags`。

### Hover 子项

#### `kbengine.hover.showTagDocs`

控制是否在悬停 `<Type>`、`<Flags>`、`<Properties>` 这类标签时显示说明。

#### `kbengine.hover.showValueDocs`

控制是否在悬停 `UINT32`、`BASE_CLIENT`、`HIGH` 这类值时显示说明。

#### `kbengine.hover.showSymbolDocs`

控制是否在悬停自定义属性名或方法名时显示摘要。

例如在 `<HP>`、`<moveTo>` 上悬停时，可以显示当前定义的 `Type`、`Flags`、`Arg` 等上下文。

### 路径相关配置

#### `kbengine.entityDefsPath`

实体定义目录，用于：

- 实体浏览器打开定义
- `entities.xml` 跳转到实体定义
- 代码生成器输出 `.def`

#### `kbengine.entitiesXmlPath`

`entities.xml` 路径。适合项目拆分目录、把实体注册文件放到自定义位置时使用。

#### `kbengine.binPath`

KBEngine 二进制目录。当前默认值已经调整为更贴近项目实际使用习惯的：

```json
{
  "kbengine.binPath": "${workspaceFolder}/../kbe/bin/server"
}
```

支持：

- `${workspaceFolder}`
- `${env:VAR}`

#### `kbengine.configPath`

服务器配置目录，通常是 `server/`。

### 服务器与日志配置

#### `kbengine.autoStart`

控制点击启动时自动拉起哪些组件。

可选值：

- `machine`
- `logger`
- `dbmgr`
- `baseappmgr`
- `cellappmgr`
- `loginapp`
- `baseapp`
- `cellapp`
- `bots`

#### `kbengine.loggerPort`

日志收集器连接端口，默认 `20022`。

#### `kbengine.logAutoConnect`

启动服务器时自动连接日志端口。

#### `kbengine.maxLogEntries`

日志 WebView 最大缓存条数。日志量很大时，可以适当降低。

### Python 导航

#### `kbengine.pythonDefsPath`

扩展会在这些目录里查找生成的 Python 定义文件，从而支持 Python 到 `.def` 的跳转和补全。

#### `kbengine.enablePythonNavigation`

控制是否启用 Python 与 `.def` 之间的双向导航。

### 调试配置文件

KBEngine 调试不再通过工作区设置项拼 Python 启动参数，而是统一读取工作区下的 `.kbengine/debug.json`。

这个文件只描述两类信息：

- telnet 地址、端口和开启调试命令
- PID attach 所需的 `pathMappings`

推荐结构如下：

```json
{
  "version": "1.0.0",
  "debug": {
    "defaultTelnetHost": "127.0.0.1",
    "defaultTelnetPort": 0,
    "components": {
      "baseapp": {
        "telnetHost": "127.0.0.1",
        "telnetPort": 0,
        "telnetEnableCommands": [
          "# 先连接 telnet",
          "# 再输入项目实际使用的开启调试命令"
        ],
        "pathMappings": [
          {
            "localRoot": "${workspaceFolder}",
            "remoteRoot": "${workspaceFolder}"
          }
        ]
      }
    }
  }
}
```

### 代码生成器

#### `kbengine.generator.defOutputPath`

控制生成器输出 `.def` 的目录。

#### `kbengine.generator.pythonOutputPath`

控制生成器输出 Python 文件的目录。

#### `kbengine.generator.generatePython`

是否在创建实体时同时生成 Python 文件。

#### `kbengine.generator.registerInEntitiesXml`

是否在生成实体后自动写入 `entities.xml`。

## 常见问题

### 为什么设置改了没有立刻生效？

当前扩展已经监听了 `kbengine.*` 配置变化。正常情况下修改后会即时生效。

如果没有刷新：

- 确认修改的是工作区或用户设置
- 确认当前打开的是 `.def` 文件
- 极端情况下手动关闭并重新打开文件

### 哪些配置最值得先调？

如果你觉得提示过多，优先调这四项：

```json
{
  "kbengine.hover.showTagDocs": false,
  "kbengine.diagnostics.checkDuplicateDefinitions": false,
  "kbengine.diagnostics.checkInvalidChildren": false,
  "kbengine.diagnostics.checkMissingPropertyFields": false
}
```

## 调试模型说明

### KBEngine 调试模型

KBEngine 组件是 C++ 进程内嵌 Python 运行时，不是由扩展直接启动一个 Python 脚本。因此调试模型必须是：

1. 先通过 telnet 向组件输入项目实际使用的开启调试命令
2. 再使用 `debugpy` 的 `processId` 方式附加到目标进程

这也是扩展当前生成的唯一调试配置形式。

### Attach 报错排查

如果 `Attach to Component` 或 `Start Debugging` 失败，建议按下面顺序排查：

1. 目标组件是否已经通过 telnet 成功开启调试
2. 输入的 PID 是否就是目标组件本身
3. `.kbengine/debug.json` 中的 `telnetEnableCommands` 是否与项目真实命令一致
4. `.kbengine/debug.json` 中的 `pathMappings` 是否映射到当前源码目录
5. 本机是否已安装 `ms-python.debugpy`，并且 VS Code 能正常使用它进行 PID attach

旧的 `kbengine.pythonPath`、`kbengine.debugPort`、`kbengine.autoAttachDebug` 已经移除，避免继续误导成“启动 Python 文件调试”。
