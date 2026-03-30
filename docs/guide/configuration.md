# 配置说明

本页整理了 Kode 当前支持的所有 `kbengine.*` 配置项，并补充了使用场景、推荐值和常见组合。

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
| `kbengine.hover.showSymbolDocs` | `boolean` | `true` | 悬停自定义属性/方法时显示摘要 |
| `kbengine.entityDefsPath` | `string` | `"scripts/entity_defs"` | 实体定义目录 |
| `kbengine.entitiesXmlPath` | `string` | `"scripts/entities.xml"` | `entities.xml` 路径 |
| `kbengine.binPath` | `string` | `"${workspaceFolder}/../kbengine/kbe/bin"` | KBEngine 二进制目录 |
| `kbengine.configPath` | `string` | `"${workspaceFolder}/server"` | 服务器配置目录 |
| `kbengine.autoStart` | `string[]` | `["machine","logger","dbmgr"]` | 自动启动组件 |
| `kbengine.loggerPort` | `number` | `20022` | 日志端口 |
| `kbengine.logAutoConnect` | `boolean` | `true` | 启动服务器时自动连日志 |
| `kbengine.maxLogEntries` | `number` | `10000` | 日志最大缓存数 |
| `kbengine.pythonPath` | `string` | `"python"` | 调试时使用的 Python 路径 |
| `kbengine.debugPort` | `number` | `5678` | Python 调试端口 |
| `kbengine.autoAttachDebug` | `boolean` | `false` | 启动组件后自动附加调试器 |
| `kbengine.pythonDefsPath` | `string[]` | `["assets/scripts/entity_defs","scripts/entity_defs"]` | Python 生成定义搜索路径 |
| `kbengine.enablePythonNavigation` | `boolean` | `true` | 启用 Python 到 `.def` 跳转 |
| `kbengine.generator.defOutputPath` | `string` | `"scripts/entity_defs"` | 代码生成器 `.def` 输出目录 |
| `kbengine.generator.pythonOutputPath` | `string` | `"scripts"` | 代码生成器 Python 输出目录 |
| `kbengine.generator.generatePython` | `boolean` | `true` | 代码生成器是否生成 Python |
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

如果你觉得提示过于频繁，优先关这个，而不是直接关闭全部诊断。

### 诊断子项

#### `kbengine.diagnostics.checkUnknownTypes`

检查 `<Type>` 中未识别的类型名。

适合保持开启，因为这类通常是真错误。

#### `kbengine.diagnostics.checkUnknownFlags`

检查 `<Flags>` 中未识别的标志值。

适合保持开启，因为拼写错误很常见。

#### `kbengine.diagnostics.checkUnknownDetailLevels`

检查 `<DetailLevel>` 中非法值。

#### `kbengine.diagnostics.checkFlagConflicts`

检查 `BASE` / `BASE_CLIENT` 与 `CELL_*` 混用。

这是 KBEngine 中很有价值的一条规则，建议开启。

#### `kbengine.diagnostics.checkDuplicateDefinitions`

检查同一区块下的重名属性和方法。

如果你的项目大量生成中间代码、或者还在频繁重构，这项可能会比较吵。

#### `kbengine.diagnostics.checkInvalidChildren`

检查非法子标签，例如：

```xml
<BaseMethods>
  <moveTo>
    <Flags>BASE_CLIENT</Flags>
  </moveTo>
</BaseMethods>
```

上面的 `<Flags>` 会被识别为方法区块中的非法标签。

#### `kbengine.diagnostics.checkMissingPropertyFields`

检查属性缺少 `Type` / `Flags`，以及重复声明多个 `Type` / `Flags`。

如果你经常写到一半保存，这项可能最容易打断流畅度。

### Hover 子项

#### `kbengine.hover.showTagDocs`

控制是否在悬停 `<Type>`、`<Flags>`、`<Properties>` 这类标签时显示说明。

如果你已经熟悉 `.def` 结构，建议关闭。

#### `kbengine.hover.showValueDocs`

控制是否在悬停 `UINT32`、`BASE_CLIENT`、`HIGH` 这类值时显示说明。

这项通常保留价值更高。

#### `kbengine.hover.showSymbolDocs`

控制是否在悬停自定义属性名或方法名时显示摘要。

例如在 `<HP>`、`<moveTo>` 上悬停时，可以显示当前定义的 `Type`、`Flags`、`Arg` 等上下文。

### 路径相关配置

#### `kbengine.entityDefsPath`

实体定义目录，用于：

- 实体浏览器打开定义
- `entities.xml` 跳转到实体定义
- 代码生成器输出 `.def`

默认适合标准 KBEngine 项目。如果你的目录结构不同，需要优先改这个。

#### `kbengine.entitiesXmlPath`

`entities.xml` 路径。适合项目拆分目录、把实体注册文件放到自定义位置时使用。

#### `kbengine.binPath`

KBEngine 的二进制目录，支持：

- `${workspaceFolder}`
- `${env:VAR}`

示例：

```json
{
  "kbengine.binPath": "${workspaceFolder}/../kbengine/kbe/bin"
}
```

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

示例：

```json
{
  "kbengine.autoStart": ["machine", "logger", "dbmgr", "baseappmgr", "cellappmgr"]
}
```

#### `kbengine.loggerPort`

日志收集器连接端口，默认 `20022`。

#### `kbengine.logAutoConnect`

启动服务器时自动连接日志端口。

#### `kbengine.maxLogEntries`

日志 WebView 最大缓存条数。日志量很大时，可以适当降低。

### Python 调试与导航

#### `kbengine.pythonPath`

Python 解释器路径，用于调试配置和启动调试。

#### `kbengine.debugPort`

Python 调试器端口，默认 `5678`。

#### `kbengine.autoAttachDebug`

启动组件时自动附加调试器。适合单人调试，不适合频繁启停的大型项目。

#### `kbengine.pythonDefsPath`

扩展会在这些目录里查找生成的 Python 定义文件，从而支持 Python 到 `.def` 的跳转和补全。

#### `kbengine.enablePythonNavigation`

控制是否启用 Python 与 `.def` 双向导航。

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

- 确认改的是工作区或用户设置，而不是无效的 JSON 文件
- 确认当前打开的是 `.def` 文件
- 极端情况下手动关闭并重新打开文件

### 哪些配置最值得先调？

如果你觉得“太吵”，优先调这四项：

```json
{
  "kbengine.hover.showTagDocs": false,
  "kbengine.diagnostics.checkDuplicateDefinitions": false,
  "kbengine.diagnostics.checkInvalidChildren": false,
  "kbengine.diagnostics.checkMissingPropertyFields": false
}
```

## 调试兼容性说明

### 旧版 VSCode / Python 扩展

如果项目运行环境固定为 Python 3.7.3，且开发环境需要兼容 VSCode 1.50，建议使用以下组合：

- VSCode 1.50.x
- ms-python.python 2020.8.109390
- Python 3.7.3

在这组环境下，`Attach to Component` 应使用旧版 Python 调试配置语义：

- `type: "python"`
- `request: "attach"`
- `pythonPath`
- `host`
- `port`

不要混用较新的字段形式：

- `type: "debugpy"`
- `python`
- `connect: { host, port }`

较新的字段在旧版 Python 扩展中可能无法被正确识别，最终表现为误导性的提示：

```text
Test discovery err,please check the configuration settings for the tests
```

这条报错通常不表示测试配置本身有问题，而是 Python 扩展在激活、解释器选择、调试配置解析或导入项目模块时失败后，统一回落成“测试发现失败”。

### 推荐测试设置

如果当前工作区不使用 VSCode 内置测试发现，建议在 `settings.json` 中显式关闭：

```json
{
  "python.testing.pytestEnabled": false,
  "python.testing.unittestEnabled": false,
  "python.testing.nosetestsEnabled": false
}
```

如果项目本身需要测试功能，再按实际使用的测试框架单独开启，不要同时开启多个测试框架。

### Attach 报错排查

当 `Attach to Component` 触发如下报错时：

```text
Test discovery err,please check the configuration settings for the tests
```

建议按下面顺序排查：

1. 确认 VSCode 选择的解释器就是目标 Python 3.7.3，而不是系统中的其他 Python。
2. 确认扩展生成的 `launch.json` 使用旧版字段：`type: "python"`、`pythonPath`、`host`、`port`。
3. 确认目标进程已经在对应调试端口监听，而不是仅启动了进程但未注入调试器。
4. 确认 `pathMappings` 与实际工程路径一致，避免附加后源码映射失败。
5. 如果未使用 VSCode 测试功能，关闭 `python.testing.*` 配置，避免旧版扩展在后台触发测试发现。
6. 打开 VSCode 的 `Output > Python` 查看真实异常。很多情况下，真正的根因是解释器错误、缺少依赖、导入失败或调试配置字段不兼容。
