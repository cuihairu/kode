# G9 Space Viewer / Watcher 面板 · 引擎协议取证

> 状态：取证完成（2026-10-24）。本文只记录 kbengine 引擎源码树中真实存在的
> 消息面与收发两侧实现位置，供 C-2「最小查询面板」与 C-3「面板操作面」使用；
> 不代表扩展已实现任何面板能力。
>
> 取证树：`/home/cui/workspaces/kbengine`（`kode` 仓 `../kbengine` 兄弟目录，
> 与 `tests/helpers/engineTree.ts` 的兜底探测口径同源）。下文所有 `file:line`
> 均为该树实测行号。

## 1. 两条协议线

引擎的控制台观测面分两条互不复用的线：

| 线 | 请求消息族 | 回执 | 语义 |
|---|---|---|---|
| Watcher | `41001`–`41008`（按进程类型分号，共 8 个） | `65502` | 树状 watcher 值读取（`KBEngine.addWatcher` 注册的路径） |
| SpaceViewer | `50001`–`50005` | `65503` | Space/Cell 拓扑与实体分布快照 |

两条线**回执消息号不同**：watcher 线走 `CONSOLE_WATCHERCB_MSGID = 65502`
（`kbe/src/lib/helper/console_helper.h:11`、`Watcher.py:10`，服务端回执
`console_helper.h:175`），SpaceViewer / 组件负载线走
`CONSOLE_PROFILECB_MSGID = 65503`（`console_helper.h:12`、`:227`/`:249`/`:271`）。
客户端侧对应地各自注册：`Watcher.py:60` 注册 `65502`，
`SpaceViews.py:56`/`:128`/`:186` 与 `Component_Status.py:42` 注册 `65503`。
面板侧若同时收两条线，必须**两个回执都注册**——只注册 `65503` 会静默丢掉
watcher 回执，这是本表最早一版误记为「两条线共用 65503」的根因。

## 2. 消息号表（真实来源：`kbe/tools/server/pycommon/`）

Watcher 请求号，`kbe/tools/server/pycommon/Watcher.py:32-40`：

```python
CMD_ID_queryWatcher = {
    Define.BASEAPP_TYPE    : 41001,
    Define.CELLAPP_TYPE    : 41002,
    Define.LOGINAPP_TYPE   : 41003,
    Define.BASEAPPMGR_TYPE : 41004,
    Define.CELLAPPMGR_TYPE : 41005,
    Define.DBMGR_TYPE      : 41006,
    Define.INTERFACES_TYPE : 41007,
    Define.LOGGER_TYPE     : 41008,
    ...
}
```

SpaceViewer / 组件负载请求号：
`kbe/tools/server/pycommon/SpaceViews.py:33-37`（SpaceViewer）与
`kbe/tools/server/pycommon/Component_Status.py:33-34`（queryAppsLoads）：

| 消息号 | 消息名 | 目标进程 | 声明位置 |
|---|---|---|---|
| 50001 | `Baseappmgr::queryAppsLoads` | baseappmgr | `kbe/src/server/baseappmgr/baseappmgr_interface.h:116` |
| 50002 | `Cellappmgr::queryAppsLoads` | cellappmgr | `kbe/src/server/cellappmgr/cellappmgr_interface.h:91` |
| 50003 | `Cellappmgr::querySpaces` | cellappmgr | `kbe/src/server/cellappmgr/cellappmgr_interface.h:94` |
| 50004 | `Cellapp::querySpaceViewer`（单 Space 视图） | cellapp | `SpaceViews.py:142` 客户端直发 |
| 50005 | `Cellapp::querySpaces`（全量） | cellapp | `SpaceViews.py:36` 客户端直发 |

服务侧对应实现（同树实测）：
- `kbe/src/server/cellappmgr/cellappmgr.cpp:559` `Cellappmgr::querySpaces`
- `kbe/src/server/cellappmgr/cellappmgr.cpp:631` `Cellappmgr::setSpaceViewer`
- `kbe/src/server/cellapp/cellapp.cpp:2259` `Cellapp::setSpaceViewer`
- `kbe/src/server/cellapp/cellapp_interface.h:165` `setSpaceViewer` 消息声明
- `kbe/src/server/cellapp/cellapp_interface.h:135` `queryWatcher` 消息声明

回执号分两号（见 §1）：
- watcher 线 `CONSOLE_WATCHERCB_MSGID = 65502`——`Watcher.py:10`，
  服务端消息头 `kbe/src/lib/helper/console_helper.h:11`（客户端处理器
  `ConsoleWatcherCBMessageHandler`，消息名 `"console::queryWatcher"`，
  `console_helper.h:175` 强制 `msgID = CONSOLE_WATCHERCB_MSGID`）。
- SpaceViewer / 负载线 `CONSOLE_PROFILECB_MSGID = 65503`——`SpaceViews.py:13`、
  `Component_Status.py:13`、`Watcher.py:11` 三处同值定义，
  服务端 `console_helper.h:12`、`:227`/`:249`/`:271`。

注意 `Watcher.py` **两个常量都定义了**（`:10` 是 65502、`:11` 是 65503），
但实际注册回执的是 `:60` 的 65502；早先按「同一文件里两个常量都存在」
误记成回执为 65503。

## 3. 控制台连接时序

真实参考实现 = 引擎自带 webconsole 的 Python 客户端（面板可直接对照抄）：

1. **建连**：从 `Machines.ComponentInfo.{intaddr,intport}` 取目标进程地址，
   `ServerApp.connect(host, port)` 直连该进程（`SpaceViews.py:44-46` 用法样例注释）。
2. **注册回执**：`registerMsg(65503, onXxxMsg)`（`SpaceViews.py:56`）；
   watcher 线对应注册 `registerMsg(65502, onWatcherMsg)`（`Watcher.py:60`）。
3. **发请求**：`MessageStreamWriter(<请求号>)` 后 `self.send(msg)`
   （`SpaceViews.py:66-70`；SpaceViewer 请求体为空，只带消息号）。
4. **收回执**：流式读取，见 §4；读到 EOF 结束一轮。
5. **轮询**：webconsole 在 websocket 循环里重复 3-5（`views_spaceviewer.py:131-149`）。

`CellAppMgrViewer` 类另有 cellappmgr 侧拓扑视图（`SpaceViews.py:118-142`），
请求号 `50004`，回执同 `65503`。

## 4. 回执流格式（`kbe/tools/server/pycommon/SpaceViews.py:73-113`）

`onSpaceViewerMsg` 的真实读取顺序（**这是 C-2 解码面的唯一依据**）：

```python
componentType = streamReader.readInt32()      # 目标进程类型
componentID   = streamReader.readInt64()      # 目标进程组件 ID
while not streamReader.EOF():
    CellAppCID  = streamReader.readUint64()   # cellapp 组件 ID
    SpacesSize  = streamReader.readUint32()   # 该 cellapp 的 Space 数
    for i in range(SpacesSize):
        SpaceID        = streamReader.readUint32()
        SpacePath      = streamReader.readString()
        ScriptModuleName = streamReader.readString()
        SpaceCellSize  = streamReader.readUint32()
        for j in range(SpaceCellSize):
            CELL_ID = streamReader.readUint32()
```

即：**进程头（int32 + int64）→ 逐 cellapp 变长段 → 逐 Space 定长段 → 逐 Cell 定长段**。
`queryAppsLoads` 的回执走同一 `65503`，由 `Component_Status.py:42-54` 解码。

值类型枚举（watcher 线与 SpaceViewer 线共用同一套数值语义）：
`SpaceViews.py:15-30` 与 `Watcher.py:14-30` 均为 `UNKNOWN=0 … COMPONENT_TYPE=14`
（uint8/16/32/64、int8/16/32/64、float、double、char、string、bool、component_type）。

## 5. Watcher 注册面（面板「增删 watcher」C-3 的引擎侧依据）

脚本侧 API：`kbe/src/server/tools/guiconsole` 引用的 `KBEngine.addWatcher`
由 `kbe/src/lib/network/pywatcher.cpp` 实现：

- `pywatcher.cpp:28` `addWatcher(PyObject*, PyObject*)`：两形态
  `addWatcher(watcherName, deftype, pyCallable)` 与 `addWatcher(watcherPath, deftype, pyCallable)`；
  deftype 只认 `UINT8|UINT16|UINT32|UINT64|INT8|INT16|INT32|INT64|FLOAT|DOUBLE|CHAR|STRING`，
  传错即 `PyErr_Format`（`pywatcher.cpp:33,45,53,66,73,83`）。
- `pywatcher.cpp:93-137` 按 deftype 分派 `_addWatcher<T>`；
  `pywatcher.cpp:149-165` `delWatcher`；`pywatcher.cpp:184` 模块方法注册。
- 值对象与路径表：`pywatcher.h` / `pywatcher.inl`（`pywatcher.cpp:4-7` include）；
  watcher 定义本体在 `kbe/src/lib/helper/watcher.h`
  （`watcher.h:227` 直接监视一个值、`:260` 监视方法返回值、`:294` 监视成员函数返回值）。

## 6. 对 C-2「最小查询面板」的接口含义

面板最小闭环只需三件事：

1. **取地址**：复用 `Machines.ComponentInfo`（`Component_Status.py` 已有同源读法），
   得到 cellappmgr 的 `intaddr/intport`。
2. **发 50003**：空体请求 `Cellappmgr::querySpaces`，回执 `65503`。
3. **按 §4 顺序解码**：表格列 = `componentID`（进程）、`SpaceID`、`SpacePath`、
   `ScriptModuleName`、`CELL_ID[]`；空段（某 cellapp `SpacesSize=0`）如实显示空，
   不补默认行。

不依赖引擎 Python 运行时——`MessageStreamWriter` 的写出面只是「消息号 + 空体」，
扩展侧用自己的连接实现即可，但**解码顺序必须逐字段照抄 §4**，
否则 `readString` 错位会整帧废掉。

## 7. 边界与未取证项

- `queryAppsLoads`（50001/50002）回执字段构成未逐字段展开，只确认
  客户端入口在 `Component_Status.py:54`；C-2 若顺带做负载列需另取证。
- watcher 线的 `queryWatcher` 请求体字段（路径、深度等）未取证；
  C-3「面板操作面（增删 watcher）」开工前需补 `pywatcher` 侧读写配对。
- 本取证不涉及 `guiconsole`（MFC 桌面端）的实现细节，其
  `guiconsoleDlg.cpp:1206-1210` 只作为「同一消息族可被 C++ 客户端复用」的旁证。

## 8. V-08 边界注记：真实管理协议（外部条件）

C-2 / C-3 在仓库内的可验收面是 **mock 测试**，端到端真跑被一条外部条件卡住：
本文取证的 `41001`–`41008` / `50001`–`50005` / `65502` / `65503` 全部属于
引擎**运行期控制台观测协议**，只对正在运行的 KBEngine 服务端可达——
没有 `loginserver` / `cellappmgr` 进程实际监听在 `intaddr:intport` 上，
任何一帧都发不出去。仓库与 CI 不保证有这样一个实例，因此端到端断言进不了
门禁。这是外部条件，不是工程缺口，**不硬造实现**。

**重开触发条件**（三条同时满足才把 C-2 / C-3 从 mock 面推进到真协议面）：

1. **可达实例**：存在一个已知 `host:intport` 的在跑引擎（或容器化 fixture），
   且 `Machines.ComponentInfo` 里能读到 cellappmgr 条目。在此之前面板侧只能
   对连接层做 mock 测试。
2. **消息号表对账通过**：目标引擎版本的 `Watcher.py` / `SpaceViews.py` /
   `console_helper.h` 与本表逐条一致。这些号是引擎**内部常量、不是公开 ABI**，
   版本漂移直接打断解析，换引擎版本必须重跑一次取证核对而不是沿用。
3. **版本可判定**：`src/engineApiMetadata.ts` 能报出真实版本而不是 `unknown`。
   在 C-14 落地前本机树上它恒报 `unknown`，面板缺「版本不匹配就拒连」的依据，
   贸然连错版本的引擎只会解出乱帧。

**已经留好的钩子**（不需要外部条件，现状即可用）：

- 消息号走常量表而非写死在收发函数里：`src/kbengineProtocol.ts:54-58`
  （`CONSOLE_WATCHER_CB_MSG_ID` / `CONSOLE_PROFILE_CB_MSG_ID` /
  `CELLAPPMGR_QUERY_SPACES_MSG_ID` / `MACHINE_BROADCAST_PORT`）、
  `src/kbengineProtocol.ts:80-89` `WATCHER_QUERY_MSG_IDS`
  （按引擎进程类型映射 8 个 watcher 请求号，与 `Watcher.py:33-40` 逐条对应）。
  对账失败（条件 2）时可整表停用，不必逐处改。
- 组帧集中在 `src/kbengineProtocol.ts:283` `buildFrame`，
  连接层与业务解码分离：连接可 mock，业务解码按 §4 字段顺序逐字段断言。
- 面板开关默认关是 C-3 的任务口径；条件 1/2/3 未同时满足前，
  不得让面板随扩展启动自动建连。

C-1 完成的是**源码取证**，不是**协议可用性**；本节把这两者的边界画清。
`src/kbengineProtocol.ts` 的传输面（组帧 / 解帧 / UDP 发现）已按上述常量实现，
缺的是上面三条外部条件，不是代码。
