# 日志查看


Kode 提供了一个面向 KBEngine logger 的日志查看 WebView，用于查看、过滤和导出日志。

当前 logger 协议适配尚未完成。扩展会明确提示该能力暂不支持，避免把未核实的协议实现当成可用能力。

## 能力概览

- 连接 logger 端口
- 查看连接状态与限制说明
- 级别过滤
- 组件过滤
- 关键词搜索
- 正则表达式搜索
- 导出日志
- 原始日志 ERROR 扫描（离线，不依赖 logger 连接）

## 相关命令

- `kbengine.logs.showViewer`
- `kbengine.logs.connect`
- `kbengine.logs.disconnect`
- `kbengine.logs.clear`
- `kbengine.logs.export`
- `kbengine.logs.scanErrors`

命令说明见 [命令与面板](./commands.md)。

## 相关配置

### `kbengine.loggerPort`

控制 logger 连接端口，默认 `20022`。

### `kbengine.logAutoConnect`

启动服务器时是否自动连接日志端口。

### `kbengine.maxLogEntries`

控制日志 WebView 最大缓存条数。

如果你发现：

- 面板变卡
- 滚动明显延迟
- 长时间运行后内存增加

可以优先降低这个值。

## 跳转决策路径日志

F12 跳转落空时,把「查了哪几层、每层命中还是落空、为什么放弃、耗时多少」全部打到输出面板,便于自行判断断在哪一层,也便于把现场直接贴给维护者。

### 开关

- 配置 key:`kbengine.jumpLog`
- 类型:boolean,可选值 `true` / `false`,默认 `false`(关闭)
- 关闭时零开销:日志消息以惰性(`() =>`)形式传入,开关判断在拼字符串之前,关闭时不产生任何字符串构建与输出
- 该开关是编辑器行为设置,**不挂在 `.kbengine/debug.json`**——那个文件承载的是调试启动动作(commands/scripts/cwd),日志开关走 VS Code 设置体系,改设置即时生效、无需改文件或重载窗口

开启方式二选一。

**方式一:VS Code 设置面板(搜索词 `jumpLog`)**

1. `Ctrl+,` 打开 Settings;
2. 搜索框输入 `jumpLog`,找到 **Kbengine: Jump Log**(描述为「跳转决策路径日志开关」的那一项);
3. 勾选即开,下一次 F12 生效。

**方式二:settings.json 片段**

用户级或工作区 `.vscode/settings.json`:

```json
{
  "kbengine.jumpLog": true
}
```

### 输出位置

1. 打开输出面板:`Ctrl+Shift+U`(菜单 视图 → 输出);
2. 右上角下拉选择通道:**KBEngine Navigation**;
3. 滤镜框输入过滤词:`[kode-jump]`。

关闭:把设置改回 `false`(或删掉该键),下一次跳转即停止输出,无需重载。

### 一次真实跳转失败的日志样本

来源:真实 KBEngine 工程 `scripts/common/Functor.py:20` 的 `self.func(*(self.args + args))` 按 F12。

```text
[kode-jump][info] F12 .../scripts/common/Functor.py:20:11 行="self.func(*(self.args + args))"
[kode-jump][info] 解析开始 query=func 文件=Functor.py:20 对象类=Functor
[kode-jump][info] def 全量索引完成 1 个 .def → 实体 1 个,10ms
[kode-jump][debug] def 索引[对象级] Functor → miss(负缓存)
[kode-jump][debug] def 索引[文件级] Functor.py → miss(无 owner 归属)
[kode-jump][info] 层1 entity-def 落空(property(func) object=Functor miss; property(func) file=Functor.py miss; method object=Functor miss; method file=Functor.py miss) 7ms
[kode-jump][info] py 查询 Functor.py:20 方法=func
[kode-jump][info] py 全仓索引完成 12 个文件 → 类 3 个,3ms(同会话缓存)
[kode-jump][debug] py ①静态类 MRO 未命中(enclosing=Functor)
[kode-jump][info] 组合根派生 1 根: [Account] 6ms
[kode-jump][debug] py 组合根收录 Functor → [无]
[kode-jump][info] py 落空: 静态类/组合根/反向后代均无 func(9ms)
[kode-jump][info] 层2 python-mro 落空(no provider in mro/composition-roots/descendants) 9ms
[kode-jump][info] 层3 file-scope 落空(class Functor (of 1 classes in file) does not define func) 0ms
[kode-jump][info] 跳转放弃: 三层全落空(query=func) 总耗时 17ms
```

逐行含义:

- `F12 …`:入口——文件、行:列、光标所在行文本;
- `解析开始 … 对象类=Functor`:本次查询的符号(query)与 `self` 所在类;
- `层1 entity-def 暂存方法声明，先查实现`:方法使用处已有 `.def` 声明，但继续寻找 Python 实现；实现查找失败才记录 `Python 实现未找到，回退 .def 声明`。追踪中的 `skip` 表示声明暂不作为最终落点，并非丢失声明。
- `def 全量索引完成 …`:层1 所需 `.def` 索引的建立耗时(同会话缓存,只建一次);
- `def 索引[对象级]/[文件级] …`:层1 的两个子探——按类名直取 `.def`、按文件归属取,双双 miss;
- `层1 entity-def 落空(…)`:层1 结束,括号里是每个子探的落空原因;
- `py 查询 …` 与 `py 全仓索引完成 …`:层2 开始;后者是「加载很久」的主要来源(首次全仓 `.py` 扫描,之后缓存);
- `py ①静态类 MRO 未命中`:层2 第一步——在静态类自身的继承链里找 `func`,没有;
- `组合根派生 …` 与 `py 组合根收录 … [无]`:层2 第二步——该类被哪些组合根(entities.xml × `.def` × Python 继承)收录;`Functor` 不属于任何组合根;
- `层2 python-mro 落空(…)`:层2 第三步——MRO、组合根、反向后代都没有 `func`;
  - 层2 有独立开关 `kbengine.python.enableMroJump`(默认开):关闭时上面这段 `py 查询`/`组合根派生` 日志整体不出现,只记一行 `层2 python-mro 跳过(设置关闭)`,层3 照常执行——跳转异常时先关它隔离变量;
- `层3 file-scope 落空(…)`:最后一层——当前文件的类作用域与本文件 MRO 也没有;
- `跳转放弃: 三层全落空 … 总耗时 …`:放弃点——三层全落空才返回 null。此例失败是预期的:`func` 是 `__init__` 里赋的属性,不是任何类的方法。

跳转命中时,对应层会打出 `层N … 命中 → 文件:行` 并直接跳过去。排查时把这一段面板输出贴出来,就能直接看出断在哪一层。


## 典型流程

### 日常查看

1. 启动 KBEngine 组件
2. 执行 `Show Log Viewer`
3. 连接 logger
4. 使用级别和组件过滤查看问题

### 排查问题

1. 打开日志面板
2. 用关键词定位实体名、组件名或错误片段
3. 必要时启用正则搜索
4. 导出日志用于二次分析

## 导出

日志支持导出为：

- `txt`
- `log`
- `json`

适合：

- 留存问题现场
- 提交给其他同事排查
- 结合脚本做离线分析

## 原始日志 ERROR 扫描

`kbengine.logs.scanErrors` 面向磁盘上的原始日志文件做离线扫描，不依赖 logger 端口连接。运行后选择文件或文件夹（文件夹只扫一层 `.log`/`.txt`/`.out`，按文件名排序），扩展把 `ERROR`/`CRITICAL` 行按「组件 + 归一签名」聚合计数，在 WebView 面板展示。

- 归一签名：把行内数字串折成 `N`、空白压缩、截到 160 字符，同一报错因 id/计数不同不会拆成多行
- 聚合表：计数（降序）/级别/组件/签名/最近出现时间；时间只取行内自带时间戳的格式，非标准行显示 `—`
- 点击命中行打开源文件并定位到该签名最早出现的行
- 「重新扫描」按钮按上一批文件重跑，不重新弹对话框
- 单文件超 64MB 读取上限、或读取失败时，该文件在扫描文件列表中标注失败原因，不中断其余文件
- 汇总条给出文件数、总行数、ERROR/CRITICAL 总条数与签名种数

扫描走与日志面板同一套解析器（logger 线格式 / 标准格式 / 非标准启发式），因此非标准行中含 `error`/`failed` 字样的也会计入。

## 使用建议

### 团队协作

建议统一 logger 端口配置，避免多人环境里“扩展能开，但日志接不上”。

### 大日志量环境

建议：

- 减少 `kbengine.maxLogEntries`
- 先用组件过滤
- 再叠加关键词搜索

## 当前边界

当前日志能力更偏“界面与导出层”，不是已经完成官方 logger 协议适配的稳定收集器。

还没有专门做到：

- 保存过滤器预设
- 多会话对比
- 按实体语义自动聚类
