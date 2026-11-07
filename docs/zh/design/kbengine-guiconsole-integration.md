# KBEngine guiconsole 接入可行性 · 深度源码分析

> 状态:取证完成(2026-11-07)。本文只记录 kbengine 引擎源码树中真实存在的
> guiconsole 通信链、开启条件与可集成面,并给出单条接入建议;不代表扩展已
> 实现任何新能力。英文版:`docs/design/kbengine-guiconsole-integration.md`。
>
> 取证树:`/home/cui/workspaces/kbengine` @ `3082ab5`(kode 仓 `../kbengine`
> 兄弟目录)。下文所有 `file:line` 均为该树实测行号。姊妹文档:
> `docs/zh/design/space-viewer-watcher.md`(Watcher/SpaceViewer 协议取证,
> 本文不重复其结论,只引用)。

## 0. 结论先行

**可以接入:kode 已在同一条协议链上落地了四个面。** guiconsole 不是一条
独立服务,它是「machined UDP 发现 + 组件内部 TCP 直连」这条协议面的
MFC C++ 原生客户端;kode 扩展的 `src/kbengineProtocol.ts`(965 行)已经
在同一条链上运行——已落地面:UDP 组件发现
(`discoverLocalComponents`,`kbengineProtocol.ts:702-772`,经
`monitoringCollector.ts:177-191` 周期轮询)、watcher 查询(41001-41008
→ 65502,`:775`)、SpaceViewer(50003 → 65503,`:949`)、profile
(`:932`)。因此正确姿势是**扩展现有 TS 协议模块**,不引入 webconsole、
不移植 MFC(guiconsole 是 Windows-only MFC 应用,无法在 Linux/扩展宿主
里直接跑)。

**建议先做**:日志实时 tail(Logger::registerLogWatcher `702` → 回执
`65501`)进 IDE Output,并把输出流接到已交付的 IDE-LIV-007
异常→源码跳转(`src/exceptionSourceLocator.ts`),形成
「实时日志 → 异常行 → 点击跳源码」闭环。

## 1. 完整通信链(①)

guiconsole 的一切先经 machined 发现,再直连各组件。

### 1.1 组件发现:UDP 广播,固定端口 20086

- guiconsole 启动后用三个定时器驱动(`guiconsoleDlg.cpp:422-424`):
  timer1(10ms)主循环处理通道、timer2(100ms)一次性按组件类型发起发现
  (`guiconsoleDlg.cpp:863-872`,LOGGER/BASEAPP/CELLAPP/BASEAPPMGR/
  CELLAPPMGR/LOGINAPP/DBMGR/BOTS 八类)、timer3(20s)对每个已连通道发
  `onAppActiveTick` 保活(`guiconsoleDlg.cpp:878-898`)。
- 发现请求 = UDP 广播 `MachineInterface::onFindInterfaceAddr`(id=1,
  `messages_fixed_defaults.xml:10-13`),监听端口取 `KBE_PORT_START +
  rand()%1000`(`guiconsoleDlg.cpp:177`),字段序:uid/username/
  componentType(CONSOLE_TYPE)/componentID/findComponentType/finderAddr/
  finderRecvPort(`guiconsoleDlg.cpp:192-195`)。
- machined 侧绑定 UDP **20086** 收广播:`KBE_MACHINE_BROADCAST_SEND_PORT =
  KBE_PORT_START + 86`(`common.h:100`;三个 bind:broadcast 地址/
  本机广播地址/LOCALHOST,`machine.cpp:713/:743/:771`)。
- machined 应答:每命中一个组件回一条 `onBroadcastInterface` Args25,
  含 uid/username/componentType/componentID/globalOrder/groupOrder/gus/
  intaddr/intport/extaddr/extport/externalAddressEx/pid/cpu/mem/usedmem/
  state/extradata×4(`machine.cpp:219-228`)——**组件列表与
  cpu/mem/usedmem/state 负载快照就在发现应答里**,guiconsole 的
  StatusWindow 列(uid/type/id/cpu/memory/entities/proxies/clients/cells/
  address,`StatusWindow.cpp:258-268`)直接吃这份广播。
- kode 侧已实现同面查询:`kbengineProtocol.ts:51`
  `MACHINE_MSG_QUERY_ALL_INTERFACES = 4`(`onQueryAllInterfaceInfos`,
  `messages_fixed_defaults.xml:25-28`),目标端口
  `MACHINE_BROADCAST_PORT = 20086`(`kbengineProtocol.ts:58`),
  `monitoringCollector.ts:177-191` 周期轮询发现结果。

### 1.2 连接:TCP 直连组件内部端口,无握手无鉴权

- `connectTo()` 对**选中的树节点**(即发现到的组件 intaddr:intport)直接
  `EndPoint::connect`(`guiconsoleDlg.cpp:1405`),以
  `Channel::INTERNAL` 语义初始化并 registerChannel
  (`guiconsoleDlg.cpp:1418-1442`)。**没有任何 hello/鉴权报文**;
  保活靠 timer3 的 `onAppActiveTick`(id 55100-55107,
  `messages_fixed_defaults.xml:487-541`),携带 CONSOLE_TYPE;
  服务端对 CONSOLE/CLIENT 豁免组件表查询(`serverapp.cpp:428`)。
- 每个组件进程**默认都**监听内部 TCP 端口:`kbeMainT` 构造
  NetworkInterface 时传入 intlisteningPort_min/max(`kbemain.h:182-185`;
  默认 0 声明在 `kbemain.h:145`),各服务组件进程实际传参均 ≥0(cellapp
  `main.cpp:61` 传 0、machined 传自身端口段),故 listener 必建;
  传 `-1` 的跳过分支存在(`network_interface.cpp:73-79`)但进程侧未用。
  listener 绑不上会 assert 崩(`network_interface.cpp:81`)。

### 1.3 消息集:XML 静态段 + 代码强制段两源合一

- 固定消息表:`kbe/res/server/messages_fixed_defaults.xml`(542 行)。
  console 相关族:
  - watcher 查询 `41001`-`41008` 按进程类型(`:407-445`;dbmgr 41006/
    loginapp 41003/baseappmgr 41004/cellappmgr 41005/cellapp 41002/
    baseapp 41001/logger 41008/interfaces 41007)→ 回执 **65502**;
  - 负载/SpaceViewer `50001`-`50005`(`:447-470`)→ 回执 **65503**;
  - 日志 `702` registerLogWatcher / `703` deregisterLogWatcher /
    `704` writeLog(`:354-385`)→ 回执 **65501**;
  - python 远程执行 `55001`(Baseapp)/`55002`(Cellapp)/`55003`(Bots)
    onExecScriptCommand(`:472-485`)→ 回执 **65500**;
  - 心跳 `55100`-`55107`(`:487-541`);进程管理 `2`/`3`/`6`
    (`:15-38`)。
- **四条 console 回执 ID 是代码硬编码强制,不在 XML 里**:
  `CONSOLE_COMMANDCB_MSGID 65500` / `CONSOLE_LOG_MSGID 65501` /
  `CONSOLE_WATCHERCB_MSGID 65502` / `CONSOLE_PROFILECB_MSGID 65503`
  (`console_helper.h:9-12`),各 handler 在 `onInstall()` 里强制覆盖
  msgID(`:65/:123/:175/:227`)。解码侧消息表必须两源合并,只读 XML 会
  漏掉 65500-65503。(65502/65503 的双线分工与收侧注册口径已在
  `docs/zh/design/space-viewer-watcher.md` §1 取证,本文沿用。)

### 1.4 日志流:guiconsole → logger 注册,logger 推回

- guiconsole 对 **logger 组件**(地址来自发现)TCP 发
  `Logger::registerLogWatcher`(702),按**写入点** `LogWindow.cpp:381-433`
  的实际顺序:uid(i32)/logtypes(u32)/globalOrder(i32)/groupOrder(i32)/
  date(str)/keyStr(str)/count(i8)+ n×componentType(**每项 int32**,
  `Bundle::operator<<(COMPONENT_TYPE)` 按 int32 序列化,
  `bundle.h:227-231`,写入点 `LogWindow.cpp:421-423`)+ isfind/first
  (bool,`bundle.h:241`)。注意:XML 里该消息把组件过滤声明为
  `UINT8_ARRAY`(`messages_fixed_defaults.xml:354-366`),与 guiconsole
  实际写法不一致——解码器以写入点为准,这正是「以实现核对声明」的典型
  案例。注销 deregisterLogWatcher 703:`LogWindow.cpp:439`。
- logger 端 `LogWatcher` 按 uid/logtype/globalOrder/groupOrder/组件位图/
  日期/关键字过滤后,把命中的 logstream 以 BLOB 塞进
  `CONSOLE_LOG_MSGID 65501` **推回同一 TCP 通道**
  (`logwatcher.cpp:85-113`,推送点 `:104-112`)。日志源头是各组件的
  `Logger::writeLog`(704,`messages_fixed_defaults.xml:373-385`)。
- 即:**tail 是一条长连推流**——注册后 logger 持续推,连接关闭即断流。
  kode 现有 `queryWatcherPath` 是一问一答短连模式
  (`kbengineProtocol.ts:775`),tail 需要新增长连 + 按消息 ID 分发。

### 1.5 组件管理与其它面

- 进程启停:`Machine::startserver`(id=2)/`stopserver`(3)/`killserver`(6)
  (`messages_fixed_defaults.xml:15-38`);guiconsole 经 UDP 广播发送
  (`guiconsoleDlg.cpp:1678/:1744`,`StartServerWindow.cpp:156/:288`),
  machined 实现 `machine.cpp:846/:917/:1107`,可按 componentID 停单个
  组件(`machine.cpp:928-930`)。
- python 远程执行:guiconsole 按组件类型发 55001/55002/55003
  (`guiconsoleDlg.cpp:597-601`);服务端 `EntityApp::onExecScriptCommand`
  仅校验「内部通道」(`entity_app.h:1321`),`run_simpleString` 执行后经
  65500 回执返回(`entity_app.h:1345-1350`)。
- profile:每进程 `X::startProfile` 接口(pyprofile/cprofile/eventprofile/
  networkprofile 四类,`guiconsoleDlg.cpp:1786-1811`),回执 65503;
  kode 侧 `startProfileQuery` 已有实现(`kbengineProtocol.ts:932`)。

## 2. 开启条件(②)

**没有开关——这条链默认就是开的。** 逐条核对:

- kbengine_defaults.xml(`kbe/res/server/kbengine_defaults.xml`,942 行)
  中**不存在**任何 console 专用键;每个服务组件进程启动时默认都会建
  内部 TCP listener(见 1.2,`kbemain.h:182-185`)。
- 前提只有两个:①machined(machine 进程)在运行——它是发现广播的
  唯一应答者,webconsole 文档同口径「此工具所有的操作都源于 Machine,
  必须确保 machine 进程正确运行」(`docs/zh/guide/webconsole.md:51`);
  ②目标组件的内部 TCP 端口网络可达( listener 存在性见 1.2:
  服务组件进程默认必建,`kbemain.h:182-185`)。
- 相邻可对比的配置面是 per-app `telnet_service`(有密码,默认
  `pwd123456`:interfaces `:261-267`、dbmgr `:423-430`、cellapp `:545`
  附近)——**console 链路没有任何对应键,也没有鉴权**(见 §5)。
- 端口事实:广播固定 20086(`common.h:100`);`KBE_MACHINE_TCP_PORT =
  20088`(`common.h:102`)是 machined 自己的 TCP 面;组件内部端口自动
  分配(`network_interface.cpp:168-196` 端口扫描),具体值由发现应答带出。

## 3. webconsole 对比(③)

| 面 | webconsole | guiconsole | kode 现状 |
|---|---|---|---|
| 宿主 | Django 1.8.9 Web 应用(`docs/zh/guide/webconsole.md:9-11`) | Windows MFC C++ 二进制 | VS Code 扩展(TS) |
| 协议 | 同一 Machine 面(HTTP 轮询,无 WebSocket 实时推) | 同一 Machine 面 + 组件直连 | **已在同一条链上**(`kbengineProtocol.ts`) |
| 功能 | 用户管理/集群管理/性能分析/实时日志/状态图/Python 控制台/Watcher/SpaceViewer(`:113-185`) | 同域 + 图表/布局 | 发现/watcher/spaces/profile 已接,tail/启停/exec 未接 |
| 维护态 | 遗留(Django 1.8.9 已 EOL) | Windows-only | 活跃 |

**结论:两个对比对象都不是「接入目标」。** webconsole 没有扩展宿主需要的
实时推送面(HTTP 轮询),引入它等于背上一个 Django 遗留栈;guiconsole
二进制不可跨平台。对 VS Code 扩展唯一合理路径是**直接说 guiconsole 的
协议**:kode 已有的 TS 实现覆盖了发现/watcher/spaces/profile
(`kbengineProtocol.ts:702/:775/:932/:949`,
`monitoringCollector.ts:177-191`),差的是 tail/启停/远程执行三块。

## 4. 集成机会清单(④,按价值排序)

| # | 功能 | 消息 | 依赖 | 工作量 | 说明 |
|---|---|---|---|---|---|
| 1 | **日志实时 tail 进 IDE Output** | 702/703 → 65501 | logger 地址(发现已给);新增长连客户端+按 ID 分发 | **M**(~100-150 行 TS) | 价值最高;65501 BLOB 内 logstream 字节格式未取证,需真机对拍 |
| 2 | **异常→源码跳转**(接 IDE-LIV-007) | 复用 #1 的输出流 | `exceptionSourceLocator.ts:27/:52/:79` 已交付 | **S**(纯接线) | 与 #1 打包:tail 每行过 parse→resolve→可点击跳转 |
| 3 | **组件状态面板增强** | 发现广播 Args25 | 已有雏形(`monitoringCollector.ts`) | S | state/extradata(entities/proxies/cells)已随发现带回,只差呈现 |
| 4 | **进程启停/重启按钮** | 2/3/6(UDP 广播) | machined;组帧字段序(`machine.cpp:846-916`) | M | 破坏性操作:须二次确认+审计;排后 |
| 5 | **负载曲线** | 50001/50002 → 65503 | **queryAppsLoads 回执字段未取证**(space-viewer-watcher 取证已标注) | M-L | 依赖真机对拍;呈现可先吃发现广播里的 cpu/mem |
| 6 | **python 远程执行** | 55001-3 → 65500 | 无新依赖 | S-M | 调试价值高但=任意代码注入面,与既有 telnet_service 重叠;后置 |

codec 复用口径:全部走 `src/kbengineProtocol.ts` 的 TS 实现即可
(`buildFrame`/`BufferCursor`/常量体系已备,65502/65503 常量已带引擎行号
口径 `kbengineProtocol.ts:54-55`)。**kode-kbengine-protocol crate 不是
本路径的依赖**——它是离线取证/抓包分析面(schema/decode/capture,
`crates/kode-kbengine/src/cli.rs:40-93` 无在线客户端子命令),实时面由
TS 模块承载;新常量(702/703/65501/55001-3/65500)按 IDE-LIV-002 先例进
`watcherProtocolAudit.ts` 审计咬合面。

## 5. 风险与边界(⑤)

- **协议版本耦合**:四条回执 ID 硬编码在头文件(`console_helper.h:9-12`),
  不随 XML 漂移反而是稳定点;真正的漂移面是 XML 静态段与引擎版本——
  引擎树固定 @3082ab5,kode 侧已用「审计表+逐条咬合」机制锁协议号
  (IDE-LIV-002 先例),新增消息号必须进同一审计面,不沿用未验证常量。
- **fork-only 变更**:本树相对上游 kbengine 的差异未逐文件比对;接入面
  只依赖上表消息号,均为上游老协议,漂移风险低,但上线前仍以目标引擎树
  的实测行号为准(审计表带 repoUrl+commit)。
- **安全面(全链无鉴权)**:①发现应答对自称 CONSOLE_TYPE 的请求**绕过
  uid 过滤**(`machine.cpp:168-175`「如果不是 guiconsole 发出的…则不理会」
  的豁免分支,`:200-204` 同)——任何能发广播的进程都能拿到全组件清单与
  负载;②python 执行只校验内部通道(`entity_app.h:1321`);③startserver/
  killserver 无口令(`machine.cpp:846` 起)。**结论:该链只应限本机**
  (kode 现有发现目标默认 `127.0.0.1`,`kbengineProtocol.ts:703`);跨机
  接入须显式配置并在文档警示「等于交出全集群控制权」。进程启停按钮落地
  时按破坏性操作规范加二次确认。
- **信道形态**:65501 tail 是长连推流,与现有短连查询模式不同源;连接
  生命周期(重连/退避/断流提示)是 tail 功能的主要工程量,不是协议解码。
- **已识别未取证项**(如实标注):65501 BLOB 内 logstream 字节格式、
  queryAppsLoads(50001/50002)回执字段——均需真机对拍后才可写解码器。

## 6. 最小验证佐证

本机无运行中引擎,取离线佐证:用 kode 仓**已编译的现有 codec**
(`out/kbengineProtocol.js`,零新写协议层)组 702 请求帧并按 TCP 粘包
拆解 65501 回执流。脚本如下,可复跑(需先在 kode 仓 `pnpm compile`
生成 `out/kbengineProtocol.js`):

```js
const p = require('./out/kbengineProtocol.js');     // kode 仓根目录下运行
const cstr = s => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
// 702 请求帧:字段序对齐 LogWindow.cpp:381-433(组件项 int32,bundle.h:227-231)
const frame702 = p.buildFrame(702, Buffer.concat([
  i32(1000), i32(0x1f), i32(0), i32(0),             // uid / logtypes / globalOrder / groupOrder
  cstr(''), cstr(''),                                // date / keyStr
  Buffer.from([2]), i32(3), i32(4),                  // count=2 + 2×COMPONENT_TYPE(int32)
  Buffer.from([0, 1]),                               // isfind / first (bool)
]));
// 65501 回执流(msgID u16LE + len u16LE + BLOB),按粘包切两段解帧
const receipt = line => { const blob = cstr(line);
  const b = Buffer.alloc(4 + blob.length);
  b.writeUInt16LE(65501, 0); b.writeUInt16LE(blob.length, 2);
  blob.copy(b, 4); return b; };
const stream = Buffer.concat([receipt('ERROR cellapp Avatar.py:21 onTimer Traceback ...'),
                              receipt('WARNING baseapp loginapp sync ok')]);
let buf = Buffer.alloc(0); const out = [];
for (const chunk of [stream.subarray(0, 20), stream.subarray(20)]) {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const id = buf.readUInt16LE(0), len = buf.readUInt16LE(2);
    if (buf.length < 4 + len) break;
    const payload = buf.subarray(4, 4 + len); buf = buf.subarray(4 + len);
    if (id === 65501) out.push(payload.slice(0, -1).toString('utf8'));
  }
}
console.log('[702] len=%d', frame702.length, '[65501]', out);
```

实测输出(**演示性证据**:帧构造与粘包拆帧路径打通;65501 payload 的
logstream 字节序仍以 §5 标注的真机对拍为准,此处回执体为合成数据):

```
[702] len=33 [65501] [
  'ERROR cellapp Avatar.py:21 onTimer Traceback ...',
  'WARNING baseapp loginapp sync ok' ]
```

## 7. 决策记录与交叉引用

- **定了什么**:接入链选「machined UDP 发现 + 组件直连 TCP」既有链,
  扩展 `src/kbengineProtocol.ts`;先做 #1+#2(日志 tail + 异常跳转接线)。
  驳回选项:接 webconsole(遗留栈、无实时推)、移植 guiconsole(MFC
  不可跨平台)、经 kode-kbengine-protocol 另起 Rust 实时客户端(该 crate
  定位是离线取证,TS 面已在跑,重复实现)。本决策为代决,效果后审。
- 交叉引用:`docs/zh/design/space-viewer-watcher.md`(65502/65503 双线
  取证与收侧注册口径)、`src/exceptionSourceLocator.ts`(IDE-LIV-007)、
  `src/watcherProtocolAudit.ts`(协议号审计咬合)、`src/monitoringCollector.ts`
  (发现轮询现状)、`docs/zh/guide/webconsole.md`(对比对象,引擎树内)。
