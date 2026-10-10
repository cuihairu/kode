# 配置说明

Kode 的配置分两摊:`kbengine.*` 设置项(VSCode `settings.json`)和服务端 XML 配置(`kbengine_defaults.xml`、元件 `kbengine.xml`)。本页逐项给出类型、默认值与出处、含义、改动影响和常见误配;服务端配置怎么分层合并、telnet 端口/密码从哪来,先读前两节。

设置项默认值均取自本扩展 package.json 贡献点,引擎侧取值取自 `kbengine_defaults.xml`;两处都查不到的,标「来源未考」。

## 服务端配置的三层

引擎装载服务端配置的规则:先读引擎默认配置,再读元件配置,同键覆盖。Kode 的 telnet 探测和「最终配置」视图都按这个口径取值。

| 层 | 文件 | 定位方式 |
| --- | --- | --- |
| 1 引擎默认 | `kbe/res/server/kbengine_defaults.xml` | 由 `kbengine.binPath`(指向 `kbe/bin/server`)向上推导 |
| 2 元件覆盖 | `kbengine.xml` | `kbengine.configPath` 下的 `kbengine.xml` 优先;未设时按约定路径探测工作区根:`kbengine.xml` → `res/server/kbengine.xml` → `assets/res/server/kbengine.xml`,取第一个存在的 |
| 3 最终生效 | (合成,不落盘) | 第 1 层先载,第 2 层同键覆盖 |

覆盖口径:

- 同名键两边都有:取元件配置的值;
- 只有默认有:保留默认;
- 只有元件有:新增;
- 容器段两边都有:递归下钻,子键按名字对齐;
- 重复名列表(如 `<addresses>` 下多个地址):元件配置整表替换,不与默认表交错。

前后对照:

| 键 | 引擎默认 | 元件 kbengine.xml | 最终生效 |
| --- | --- | --- | --- |
| `baseapp/telnet_service/port` | 40000 | 41000 | 41000(覆盖) |
| `baseapp/telnet_service/password` | `pwd123456` | (未写) | `pwd123456`(仅默认有,保留) |
| `baseapp/archivePeriod` | 300 | 600 | 600(覆盖) |
| `baseapp/externalAddress` | (未写) | `10.0.0.9` | 10.0.0.9(新增) |

### 查看最终配置

三个入口,内容相同,都是只读虚拟文档 `kbengine-final.xml`,不落盘:

- 侧栏 KBEngine → Config 视图的「最终配置」节点,点击即开;
- 命令面板 `Show Final Server Config`(`kbengine.config.showFinal`);
- 扩展激活且能定位 defaults 时自动在后台打开(设置 `kbengine.showFinalConfigOnOpen`,默认开;找不到 defaults 静默跳过)。

文档头部注释标明 defaults 与元件配置的来源路径。defaults 或元件 `kbengine.xml` 保存、新增、删除后自动重算(`kbengine.autoRefreshFinalConfig`,默认开)。对字段悬浮可看作用说明。

### telnet 端口/密码怎么读

telnet 没有独立一套参数,就是上面三层加一个显式设置层,按序取第一个非空值:

| 参数 | 取值顺序 |
| --- | --- |
| 端口 | 设置 `kbengine.telnet.port`(>0)→ 元件 `kbengine.xml` `<telnet_service>` 的 `port` → 引擎 defaults 该组件的端口 |
| 密码 | 设置 `kbengine.telnet.password` → 元件段 `password` → 引擎 defaults `password` → 空(不自动登录) |
| 主机 | 设置 `kbengine.telnet.host`,留空用 `127.0.0.1` |

两条边界:

- 元件 `kbengine.xml` 没有 `<telnet_service>` 段且设置没给端口 → 不探测,telnet 面板、状态灯、独立树视图都不出现。引擎 defaults 里虽有 `<telnet_service>` 段,但 defaults 只供数值回落,不会单独把 telnet「打开」;
- 元件段存在但没写端口 → 按引擎默认组件端口表逐组件探测:loginapp 31000 / dbmgr 32000 / interfaces 33000 / logger 34000 / baseapp 40000 / cellapp 50000 / bots 51000;defaults 里写了端口的组件以 defaults 为准。

`.kbengine/debug.json` 与这条链无关,它只服务调试流程(见「调试配置文件」一节)。

## kbengine.* 设置项总览

| 配置项 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `kbengine.enableDiagnostics` | boolean | `true` | `.def` 诊断总开关 |
| `kbengine.enableStructureDiagnostics` | boolean | `true` | 结构化校验开关 |
| `kbengine.diagnostics.checkUnknownTypes` | boolean | `true` | 检查未知类型名 |
| `kbengine.diagnostics.checkUnknownFlags` | boolean | `true` | 检查未知 Flags 值 |
| `kbengine.diagnostics.checkUnknownDetailLevels` | boolean | `true` | 检查非法 DetailLevel 值 |
| `kbengine.diagnostics.checkDuplicateDefinitions` | boolean | `true` | 检查重名属性/方法 |
| `kbengine.diagnostics.checkMissingPropertyFields` | boolean | `true` | 检查属性缺 `Type`/`Flags` 或字段重复 |
| `kbengine.hover.showTagDocs` | boolean | `true` | 悬停标签显示说明 |
| `kbengine.hover.showValueDocs` | boolean | `true` | 悬停类型/Flags/等级值显示说明 |
| `kbengine.hover.showSymbolDocs` | boolean | `true` | 悬停属性/方法名显示摘要 |
| `kbengine.entityDefsPath` | string | `scripts/entity_defs` | 实体定义目录 |
| `kbengine.entitiesXmlPath` | string | `scripts/entities.xml` | `entities.xml` 路径 |
| `kbengine.binPath` | string | `${workspaceFolder}/../kbe/bin/server` | 引擎二进制目录 |
| `kbengine.configPath` | string | `${workspaceFolder}/server` | 服务器资产目录 |
| `kbengine.showFinalConfigOnOpen` | boolean | `true` | 激活后自动打开最终配置视图 |
| `kbengine.autoRefreshFinalConfig` | boolean | `true` | 配置文件变更后自动刷新最终配置视图 |
| `kbengine.debug.remoteTargets` | array | `[]` | 远程调试目标列表 |
| `kbengine.autoStart` | string[] | `["machine","logger","dbmgr"]` | 自动启动的组件 |
| `kbengine.loggerPort` | number | `20022` | logger 端口 |
| `kbengine.logAutoConnect` | boolean | `true` | 激活时自动连日志 |
| `kbengine.maxLogEntries` | number | `10000` | 日志缓存上限(条) |
| `kbengine.generator.defOutputPath` | string | `scripts/entity_defs` | 生成器 `.def` 输出目录 |
| `kbengine.generator.pythonOutputPath` | string | `scripts` | 生成器 Python 输出目录 |
| `kbengine.generator.generatePython` | boolean | `true` | 生成器是否同时出 Python |
| `kbengine.generator.registerInEntitiesXml` | boolean | `true` | 生成后自动写 `entities.xml` |
| `kbengine.telnet.host` | string | `127.0.0.1` | telnet 目标主机 |
| `kbengine.telnet.port` | number | `0` | telnet 端口(0 = 未显式指定) |
| `kbengine.telnet.password` | string | 空 | telnet 登录密码 |
| `kbengine.telnet.enableCommands` | string[] | `[]` | telnet 面板命令白名单 |
| `kbengine.telnet.configXmlPath` | string | 空 | 元件 kbengine.xml 指定路径 |
| `kbengine.telnet.probeIntervalSeconds` | number | `5` | 探测轮询间隔(秒) |
| `kbengine.httpRequests` | array | 见下文 | HTTP 快捷请求列表 |

## 逐项说明

### 诊断

| 配置项 | 关掉会怎样 | 常见误配 |
| --- | --- | --- |
| `enableDiagnostics` | `.def` 的类型、Flags、结构问题全部不再提示 | 忘了重开,以为代码没写错 |
| `enableStructureDiagnostics` | 重复属性/方法、子标签位置错、缺 `Type`/`Flags`、字段重复定义都不报 | 与上一项搞混:这项只管结构,类型名拼错归 `checkUnknownTypes` |
| `diagnostics.checkUnknownTypes` | 类型名拼错不再报 | 自定义类型要能找到才不误报:先查 `entity_defs/types.xml`、`scripts/entity_defs/types.xml`、`assets/scripts/entity_defs/types.xml`,再到 `user_type/<Type>.py`、`scripts/user_type/<Type>.py`、`assets/scripts/user_type/<Type>.py` |
| `diagnostics.checkUnknownFlags` | Flags 拼错不再报 | — |
| `diagnostics.checkUnknownDetailLevels` | DetailLevel 非法值不再报 | — |
| `diagnostics.checkDuplicateDefinitions` | 真重名漏报 | 提示过多的项目可关,代价是漏掉真重名 |
| `diagnostics.checkMissingPropertyFields` | 缺 `Type`/`Flags` 的属性不报 | — |

诊断只在打开或编辑 `.def` 文件时触发,`kbengine.*` 配置变化后会重扫已打开的 `.def`。

### 悬停

三项都是 `boolean`,默认 `true`:

- `hover.showTagDocs`:`<Type>`、`<Flags>`、`<Properties>` 这类标签的说明;
- `hover.showValueDocs`:`UINT32`、`BASE_AND_CLIENT`、`FAR` 这类值的说明;
- `hover.showSymbolDocs`:自定义属性名/方法名悬停显示当前定义的 `Type`、`Flags`、`Arg` 等上下文。

全关后 `.def` 悬停只剩语法高亮。嫌提示多优先关 `showTagDocs`,它出现频率最高。

### 路径

#### `kbengine.entityDefsPath`

- 类型:string;默认 `scripts/entity_defs`(相对工作区根)
- 用途:实体浏览器列表、`entities.xml` 跳转、生成器 `.def` 输出
- 误配:指错目录则实体浏览器为空

#### `kbengine.entitiesXmlPath`

- 类型:string;默认 `scripts/entities.xml`
- 用途:依赖图读取与实体注册。项目把注册文件放在自定义位置时改这项

#### `kbengine.binPath`

- 类型:string;默认 `${workspaceFolder}/../kbe/bin/server`
- 支持占位符:`${workspaceFolder}`、`${env:VAR}`
- 用途:① 启动/停止组件进程;② 推导引擎根(`KBE_ROOT`)与引擎默认配置路径——把路径末尾的 `kbe/bin/server` 换成 `kbe/res/server/kbengine_defaults.xml`
- 误配:没指到 `kbe/bin/server` 这一级 → 服务器启动失败,最终配置视图和 defaults 数值回落也不可用;此时 `kbengine.config.showFinal` 会明示报错,激活自动打开则静默跳过

#### `kbengine.configPath`

- 类型:string;默认 `${workspaceFolder}/server`
- 这是服务器资产目录,三处生效:
  1. 组件进程的工作目录(cwd)——引擎按相对路径找资产时以这里为基准;
  2. 进程环境 `KBE_RES_PATH` 的项目侧条目:完整顺序为 `KBE_ROOT/kbe/res`、`configPath`、`configPath/res`、`configPath/scripts`;
  3. 元件 `kbengine.xml` 的首选定位处:`configPath/kbengine.xml`。
- 启动前会校验:空串、目录不存在、路径不是目录都会报错并中止启动
- 误配:指到仓库根而不是资产目录 → 引擎在 `res`/`scripts` 子目录下找不到脚本,组件起不来;或指错后元件 `kbengine.xml` 定位不到,telnet 与最终配置都退回纯默认

### 最终配置视图

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.showFinalConfigOnOpen` | boolean | `true` | 扩展激活且能定位 defaults 时,自动在后台打开 `kbengine-final.xml`(preview 标签,不抢焦点);定位失败静默跳过,不弹错。关闭后仍可用命令或侧栏 Config 视图的「最终配置」节点手动打开 |
| `kbengine.autoRefreshFinalConfig` | boolean | `true` | defaults 或元件 `kbengine.xml` 保存、新增、删除后,自动重算已打开的合成文档。关闭后需重开文档或重跑命令 |

### 远程调试目标 `kbengine.debug.remoteTargets`

- 类型:array;默认 `[]`
- 每个条目:

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 目标显示名(选择器里的标识) |
| `host` | string | 是 | 远端 IP 或主机名 |
| `port` | number | 否 | debugpy 监听端口,缺省 `5678` |

- 用途:`Attach to Remote Component` 命令的目标选择;`Update launch.json` 会把这些目标以 debugpy `connect` 形式追加进 `launch.json`
- 前提:远端组件先经 telnet 发开启调试命令,并起好 debugpy 监听;扩展以 `connect: {host, port}` 附加,不写 `pathMappings`
- 误配:`host` 填错 → 附加失败走错误通道;`port` 不对 → 连不上 debugpy;`name`/`host` 为空的条目不收录

### 服务器与日志

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.autoStart` | string[] | `["machine","logger","dbmgr"]` | 不带参数启动时拉起的组件。合法值取自组件注册表(`src/serverManager.ts`):`machine`、`logger`、`interfaces`、`dbmgr`、`baseappmgr`、`cellappmgr`、`loginapp`、`baseapp`、`cellapp`、`bots` |
| `kbengine.loggerPort` | number | `20022` | 日志收集器连接端口,须与引擎 logger 的监听端口一致;不一致时面板连不上(内部按间隔重连) |
| `kbengine.logAutoConnect` | boolean | `true` | 激活即尝试连接一次 logger;失败静默,走重连 |
| `kbengine.maxLogEntries` | number | `10000` | 日志 WebView 缓存上限(条)。日志量大调低省内存,想留更长历史调高 |

### 代码生成器

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.generator.defOutputPath` | string | `scripts/entity_defs` | 生成的 `.def` 写到哪 |
| `kbengine.generator.pythonOutputPath` | string | `scripts` | 生成的 Python 写到哪 |
| `kbengine.generator.generatePython` | boolean | `true` | 向导/模板创建实体时是否同时生成 Python 文件 |
| `kbengine.generator.registerInEntitiesXml` | boolean | `true` | 生成后自动写入 `entities.xml`(写的是 `entitiesXmlPath` 指向的文件) |

### telnet 探测

telnet 的展示面(独立树视图、状态灯、面板)只在配置显式开 telnet 时出现,取值链见「telnet 端口/密码怎么读」。

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.telnet.host` | string | `127.0.0.1` | 探测目标主机。远端机器填其 IP |
| `kbengine.telnet.port` | number | `0` | 显式端口。>0 时锁定单一目标(不再逐组件探测);0 = 未显式指定,按元件 `kbengine.xml` 段与 defaults 回落 |
| `kbengine.telnet.password` | string | 空 | 自动握手登录用,只写 socket 不写日志。留空则不自动登录,状态灯停「端口开·未配密码」 |
| `kbengine.telnet.enableCommands` | string[] | `[]` | telnet 面板可发送的命令白名单(精确匹配或「命令 + 空格 + 参数」前缀匹配)。内置只读快捷命令(实体数量/实体清单/全局数据键/`:help`)默认放行;`:quit` 会关闭服务端进程,配进白名单也恒被拒绝 |
| `kbengine.telnet.configXmlPath` | string | 空 | 显式指定元件 `kbengine.xml`(支持 `${workspaceFolder}`),优先于自动探测;设置显式端口 >0 时端口以设置为准 |
| `kbengine.telnet.probeIntervalSeconds` | number | `5` | 探测轮询间隔(秒),低于 1 按 1 秒执行 |

### HTTP 快捷请求 `kbengine.httpRequests`

类型:array;默认含一条停用的示例(热更新示例,`enabled: false`)。增删改走设置界面的列表编辑器,启停 = 条目 `enabled` 开关。每条字段:

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 请求名(quick pick 与日志标识),必填 |
| `url` | string | URL 模板,可含模板变量,必填 |
| `method` | string | HTTP 方法,缺省 `GET` |
| `headers` | object | 请求头(值同样走模板替换) |
| `body` | string | 请求体(非空才随请求发送,同样走模板替换) |
| `enabled` | boolean | 启停开关,缺省启用 |
| `keybinding` | string | 键位展示串(quick pick 详情列显示) |

模板变量(URL/请求体/请求头值通用,按字面替换、不做 URL 编码):

| 变量 | 含义 |
|------|------|
| `${module}` | 当前文件的工作区相对模块路径:`entities/fight/FightAI.py` → `entities.fight.FightAI`;不在工作区内退文件名去 `.py` |
| `${file}` | 文件名(`FightAI.py`) |
| `${line}` | 光标行(1 起) |
| `${sel}` | 选中文本 |

无活动编辑器时各变量替换为空串。

快捷键绑定:VS Code 无运行时注册键位的 API,在「键盘快捷方式」里为 `kbengine.httpRequest.run` 绑定按键并在 `args` 里带请求名:

```json
{
  "key": "ctrl+alt+h",
  "command": "kbengine.httpRequest.run",
  "args": { "name": "热更新(示例)" }
}
```

执行流水进 OUTPUT 面板「KBEngine HTTP 快捷请求」:`▶` 请求行 → `✓` 状态码 · 耗时 → 回包(超 4000 字符截断标注全长);失败以 `✗` 标记 + 错误弹窗呈现。

### 调试配置文件(`.kbengine/debug.json`)

这个文件只服务调试流程。telnet 探测、telnet 面板、状态灯、telnet 树视图都不读它。

| 字段 | 用途 |
| --- | --- |
| `debug.defaultTelnetHost` / `defaultTelnetPort` | `Start Debugging` 提示语里的 telnet 地址(仅提示,不参与实际探测) |
| `debug.components.<组件>.telnetHost` / `telnetPort` | 同上,按组件覆盖 |
| `debug.components.<组件>.telnetEnableCommands` | 提示语里列出的「开启调试命令」,提醒你先经 telnet 输入项目实际使用的命令 |
| `debug.components.<组件>.pathMappings` | `Update launch.json` 生成 attach 配置时写入的路径映射 |

本地 attach 不从这里拿进程号:`Attach to Component` 列出本机进程(匹配组件名的置顶标 ✓),选中即以 PID 组装配置。远程附加的目标来自设置 `kbengine.debug.remoteTargets`,也不读这个文件。

推荐结构:

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

## 常见问题

### 为什么设置改了没有立刻生效?

扩展监听 `kbengine.*` 配置变化,正常即时生效。没刷新时:确认改的是当前工作区或用户设置;确认当前打开的是 `.def` 文件;极端情况关闭再打开文件。

### 哪些配置最值得先调?

嫌提示多,先关这四项:

```json
{
  "kbengine.hover.showTagDocs": false,
  "kbengine.diagnostics.checkDuplicateDefinitions": false,
  "kbengine.diagnostics.checkUnknownDetailLevels": false,
  "kbengine.diagnostics.checkMissingPropertyFields": false
}
```

## 调试模型说明

KBEngine 组件是 C++ 进程内嵌 Python 运行时,不是扩展直接启动一个 Python 脚本。调试固定两步:

1. 先通过 telnet 向组件输入项目实际使用的开启调试命令(telnet 地址/端口/密码按「telnet 端口/密码怎么读」的三层链确认)
2. 再附加进程:本地组件用 `Attach to Component`(进程列表,匹配组件名的置顶标 ✓),远程组件用 `Attach to Remote Component`(目标来自 `kbengine.debug.remoteTargets`,debugpy `connect` 模式)

### Attach 报错排查

按这个顺序查:

1. 目标组件是否已经通过 telnet 真正开启调试(telnet 参数按三层链确认,与 `.kbengine/debug.json` 无关)
2. 进程列表里选的是否就是目标组件本身,而不是 machine/logger 等辅助进程
3. `.kbengine/debug.json` 中的 `telnetEnableCommands` 是否与项目真实命令一致(只影响提示语)
4. `.kbengine/debug.json` 中的 `pathMappings` 是否映射到当前源码目录(远程 connect 模式不写 `pathMappings`)
5. 本机是否已安装 `ms-python.debugpy`,VS Code 能否正常通过它附加进程

旧的 `kbengine.pythonPath`、`kbengine.debugPort`、`kbengine.autoAttachDebug` 已移除,`kbengine.pythonDefsPath`、`kbengine.enablePythonNavigation` 也已移除(导航走 `.def` 定义体系,见实体浏览器)。
