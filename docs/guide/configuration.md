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
  "kbengine.diagnostics.checkDuplicateDefinitions": false,
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
  "kbengine.diagnostics.checkDuplicateDefinitions": true,
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
| `kbengine.diagnostics.checkDuplicateDefinitions` | `boolean` | `true` | 检查重复属性和重复方法 |
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

#### `kbengine.diagnostics.checkDuplicateDefinitions`

检查同一区块下的重名属性和方法。

#### `kbengine.diagnostics.checkMissingPropertyFields`

检查属性缺少 `Type` / `Flags`。

### Hover 子项

#### `kbengine.hover.showTagDocs`

控制是否在悬停 `<Type>`、`<Flags>`、`<Properties>` 这类标签时显示说明。

#### `kbengine.hover.showValueDocs`

控制是否在悬停 `UINT32`、`BASE_AND_CLIENT`、`FAR` 这类值时显示说明。

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

KBEngine 二进制目录，默认值：

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

可选值（即 `src/serverManager.ts` 的组件注册表）：

- `machine`
- `logger`
- `interfaces`
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

### telnet 探测

telnet 相关内容（状态栏灯、服务器控制树中的 telnet 状态项、面板命令入口）只在配置显式开启 telnet 时展示：设置显式 `kbengine.telnet.port > 0`，或元件 kbengine.xml 里存在 `<telnet_service>` 段。两处都没有时不探测、不展示，也不再回落引擎默认端口表。

#### `kbengine.telnet.host`

telnet 探测目标主机，默认 `127.0.0.1`。

#### `kbengine.telnet.port`

telnet 探测端口。`0`（默认）表示未显式指定，改按元件 kbengine.xml 的 `<telnet_service>` 段；kbengine.xml 有该段但未写端口时，按引擎默认组件端口表逐个探测：loginapp 31000 / dbmgr 32000 / interfaces 33000 / logger 34000 / baseapp 40000 / cellapp 50000 / bots 51000。

#### `kbengine.telnet.password`

telnet 登录密码，仅用于自动握手写 socket，不写入日志。留空则不自动登录，状态灯停在「端口开·未配密码」。

#### `kbengine.telnet.enableCommands`

telnet 面板允许发送的命令白名单（精确匹配或「命令 + 空格 + 参数」前缀匹配）。内置只读快捷命令（实体数量/实体清单/全局数据键/`:help`）默认放行；`:quit` 会关闭服务端进程，即使误配进白名单也恒被拒绝。

#### `kbengine.telnet.configXmlPath`

可选。指向元件 kbengine.xml，解析其 `<telnet_service>` 段作为端口/密码回落（支持 `${workspaceFolder}`）。设置显式 `kbengine.telnet.port > 0` 时以设置优先。未设置时按约定路径探测工作区根：`kbengine.xml`、`res/server/kbengine.xml`、`assets/res/server/kbengine.xml`，取第一个存在的文件。

#### `kbengine.telnet.probeIntervalSeconds`

探测轮询间隔（秒），默认 `5`，低频探测。

### HTTP 快捷请求

#### `kbengine.httpRequests`

HTTP 快捷请求列表，增删改走设置界面的列表编辑器，启停 = 条目 `enabled` 开关。每条字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 请求名（quick pick 与日志标识），必填 |
| `url` | string | URL 模板，可含模板变量，必填 |
| `method` | string | HTTP 方法，缺省 `GET` |
| `headers` | object | 请求头（值同样走模板替换） |
| `body` | string | 请求体（非空才随请求发送，同样走模板替换） |
| `enabled` | boolean | 启停开关，缺省启用 |
| `keybinding` | string | 键位展示串（quick pick 详情列显示） |

模板变量（URL/请求体/请求头值通用，按字面替换、不做 URL 编码）：

| 变量 | 含义 |
|------|------|
| `${module}` | 当前文件的工作区相对模块路径：`entities/fight/FightAI.py` → `entities.fight.FightAI`；不在工作区内退文件名去 `.py` |
| `${file}` | 文件名（`FightAI.py`） |
| `${line}` | 光标行（1 起） |
| `${sel}` | 选中文本 |

无活动编辑器时各变量替换为空串。

内置示例一条（默认停用）：`http://127.0.0.1:8090/hotfix?module_name=${module}`——启用并把 `enabled` 改为 `true` 即可试跑。

实际快捷键绑定：VS Code 无运行时注册键位的 API，请在「键盘快捷方式」里为命令 `kbengine.httpRequest.run` 绑定按键并在 `args` 里带请求名（`keybindings.json` 示例）：

```json
{
  "key": "ctrl+alt+h",
  "command": "kbengine.httpRequest.run",
  "args": { "name": "热更新(示例)" }
}
```

执行流水进 OUTPUT 面板「KBEngine HTTP 快捷请求」：`▶` 请求行 → `✓` 状态码 · 耗时 → 回包（超 4000 字符截断标注全长）；失败以 `✗` 标记 + 错误弹窗呈现。

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
  "kbengine.diagnostics.checkUnknownDetailLevels": false,
  "kbengine.diagnostics.checkMissingPropertyFields": false
}
```

## 调试模型说明

### KBEngine 调试模型

KBEngine 组件是 C++ 进程内嵌 Python 运行时，不是由扩展直接启动一个 Python 脚本。因此调试模型必须是：

1. 先通过 telnet 向组件输入项目实际使用的开启调试命令
2. 再从 VS Code 内建进程选择器（`${command:pickProcess}`）里选目标进程，经 `debugpy` 附加

这也是扩展当前生成的唯一调试配置形式。

### Attach 报错排查

如果 `Attach to Component` 或 `Start Debugging` 失败，建议按下面顺序排查：

1. 目标组件是否已经通过 telnet 成功开启调试
2. 进程选择器里选的是否就是目标组件本身
3. `.kbengine/debug.json` 中的 `telnetEnableCommands` 是否与项目真实命令一致
4. `.kbengine/debug.json` 中的 `pathMappings` 是否映射到当前源码目录
5. 本机是否已安装 `ms-python.debugpy`，并且 VS Code 能正常通过它进行进程附加

旧的 `kbengine.pythonPath`、`kbengine.debugPort`、`kbengine.autoAttachDebug` 已经移除，避免继续误导成“启动 Python 文件调试”。
