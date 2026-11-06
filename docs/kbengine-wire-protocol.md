# KBEngine Wire Protocol Specification（PA-001 Phase 0 协议源码取证）

> 状态：Phase 0 取证产出。所有结论均给出 KBEngine 引擎源码 `file:line` 引用（基准 commit
> `bf1a9cd6f4a82dd715fcf4a69697382ed531b4c0`，2026-11-05，已验证 `kbe/src/lib/network`、
> `kbe/src/lib/common`、`kbe/src/lib/entitydef`、`kbe/src/lib/client_lib` 自该 commit 至
> 引擎仓库 HEAD `2f8b1a6` 无改动，引用行号在两端一致）。取证无法覆盖的问题统一标注
> **TODO**，不编造。测试报文与 PCAP 样本见 §12（合成样本，格式逐字节对齐本文规则）。

---

## 1. 基线引擎版本

| 项 | 值 | 依据 |
|---|---|---|
| 引擎仓库 | `~/workspaces/kbengine`（kbengine fork） | — |
| 取证基准 commit | `bf1a9cd6f4a82dd715fcf4a69697382ed531b4c0`（2026-11-05） | `git log -1 bf1a9cd6` |
| 引擎版本号 | 2.5.10（`2.5.10`，`hello` 握手明文上报） | `kbe/src/lib/common/kbeversion.h:10-12` |
| 传输层 | TCP（默认）/ UDP+RUDP / KCP / WebSocket | `kbe/src/lib/network/packet_reader.h:19-24`（`PACKET_READER_TYPE_SOCKET=0 / WEBSOCKET=1 / KCP=2`） |

---

## 2. 分层模型

```
应用消息（MessageHandler / EntityMethod / EntityProperty）
    │  Bundle（消息聚合、长度回填）
    ▼
Packet（≤1460B TCP / 1472B UDP，kbe/src/lib/network/common.h:81-83）
    │  PacketSender（+ 可选 PacketFilter：Blowfish / WebSocket）
    ▼
TCP / UDP / KCP / WebSocket socket
    │  PacketReceiver（+ 可选解密 filter）
    ▼
PacketReader（服务端与 C++/JS/Unity 客户端各自一份，状态机拆帧）
```

- 发送侧聚合：`Bundle::newMessage`（`kbe/src/lib/network/bundle.cpp:273-312`）在一个
  `Bundle` 内连续打包多条消息，随 TCP 流发出；单条消息可跨多个 `Packet`。
- 接收侧拆帧：`PacketReader::processMessages`（`kbe/src/lib/network/packet_reader.cpp:31-250`）
  循环从字节流中取出 `msgID → msgLen → body`，不完整时挂起分片等下一个包
  （`writeFragmentMessage`/`mergeFragmentMessage`，`packet_reader.cpp:253-289`）。

---

## 3. 字节序与标量编码

- **线序 = 小端（little-endian）**。默认编译宏 `KBENGINE_ENDIAN = KBENGINE_LITTLE_ENDIAN`
  （`kbe/src/lib/common/platform.h:128-136`），此时 `EndianConvert()` 为空操作
  （`kbe/src/lib/common/memorystream_converter.h:44-48`）——即 `MemoryStream` 直接按宿主
  小端写入。只有显式定义 `USE_BIG_ENDIAN` 才翻转为大端（无已知部署使用，见 §13 TODO-1）。
- `MemoryStream::append<T>` 先 `EndianConvert` 再原样追加
  （`kbe/src/lib/common/memorystream.h:139-143`）；读取对称（`read<T>`，`operator>>`
  各标量重载，`memorystream.h:253-317`）。
- 标量宽度：`int8/uint8` 1B、`int16/uint16` 2B、`int32/uint32` 4B、`int64/uint64` 8B、
  `float` 4B、`double` 8B；`bool` 按 `int8` 存取（`memorystream.h:224-227,253-257`）；
  `COMPONENT_TYPE`、`ENTITYCALL_TYPE` 均按 `int32` 存取（`memorystream.h:347-358`）。
- `ENTITY_ID` = `int32`（`kbe/src/lib/common/platform.h:342`）。
- `ArraySize`（所有"带长度的数组/块"前缀）= `uint32`（`platform.h:353`）。

### 3.1 字符串与块

| 类型 | 线格式 | 依据 |
|---|---|---|
| STRING（协议参数 `std::string`） | UTF-8 字节 + **NUL 终止符**，无长度前缀；写入 `append(str)` 含 `\0`（`memorystream.h:566-568`），读端逐字节读到 `\0` 或非 ASCII 停止（`memorystream.h:319-332`） | `datatype.cpp:1050-1062`（`StringType::addToStream` 用 `<< s`） |
| UNICODE（EntityDef） | `u32 字节长 + UTF-8 字节`（无 NUL） | `datatype.cpp:1129-1143`；`appendBlob`/`readBlob` `memorystream.h:543-565,425-441` |
| BLOB | `u32 字节长 + 原始字节` | `datatype.cpp:1448-1463` |
| PYTHON / PY_DICT / PY_TUPLE / PY_LIST | `u32 长度 + pickle 字节流`（CPython pickle 透传） | `datatype.cpp:1225-1242`（`script::Pickler::pickle`） |
| VECTOR3 | 3 × f32 连续（无前缀）；`VECTOR2/VECTOR4` 同理 2/4 × f32 | `datatype.cpp:841-858,946-963` |
| ARRAY（FixedArray） | `u32 元素数 + 逐元素递归编码` | `datatype.cpp:1837-1856` |
| FIXED_DICT | 按声明序逐 key 编码，**无键名** | `datatype.cpp:2592+`（`FixedDictType::addToStreamEx`） |
| ENTITYCALL | 见 §13 TODO-2（属性携带的 ENTITYCALL 线格式未逐字节取证；`operator<<(ENTITYCALL_TYPE)` 按 int32，`memorystream.h:351-354`） | — |

注意 STRING 与 UNICODE 是**两套编码**：协议参数里的 `std::string` 走 NUL 结尾
（读端遇非 ASCII 即停，中文 UTF-8 首字节 ≥0x80 也会提前截断，`memorystream.h:326-330`），
EntityDef 属性的 UNICODE 走长度前缀。这也是 C-15 需要区分两套 String 布局的原因。

---

## 4. 消息帧格式（核心）

### 4.1 帧结构

```
+-------------+---------------------+---------------------+---------+
| u16 msgID   | [u16 msgLen]        | [u32 extLen]        | payload |
+-------------+---------------------+---------------------+---------+
  恒存在          仅变长消息存在          仅 msgLen==65535 时存在
```

- `MessageID` = `uint16`（`kbe/src/lib/network/common.h:17`）。
- `MessageLength` = `uint16`，`MessageLength1` = `uint32`
  （`common.h:21-22`）；`NETWORK_MESSAGE_MAX_SIZE = 65535`
  （`common.h:91-92`）。
- 长度常量：`NETWORK_VARIABLE_MESSAGE = -1`（变长），`NETWORK_FIXED_MESSAGE = 0`
  （定长，长度在注册期计算）（`common.h:111-115`）。

### 4.2 三种长度形态

1. **定长（fixed）**：`msgLen >= 0`。线上**没有长度字段**，接收端直接查静态表得长度。
   `MessageHandlers::add`（`kbe/src/lib/network/message_handler.cpp:140-229`）：
   声明 `msgLen == 0` 时用 `args->dataSize()` 计算（`message_handler.cpp:194-196`）；
   参数类型含 `std::string` 的强制降级为变长（`message_handler.cpp:201-215`）；
   `ENTITY` 类消息再 `+= sizeof(ENTITY_ID)`（即 +4，`message_handler.cpp:218`）。
2. **变长（variable）**：线上 `u16 msgLen` = **payload 字节数，不含 2B msgID 与 2B 长度
   头本身**。发送端先写 0 占位再回填，回填值明确减去
   `NETWORK_MESSAGE_ID_SIZE + NETWORK_MESSAGE_LENGTH_SIZE`
   （`bundle.cpp:301-308` 占位，`bundle.cpp:346-347` 减头，`bundle.cpp:371-377` 回填）；
   接收端直接读 `>> currlen` 作为 body 长度（`packet_reader.cpp:98-119`）。
3. **扩展长度（extended）**：变长消息 payload `>= 65535` 时，2B 长度字段写哨兵值
   `65535`，随后紧跟 `u32 实际长度`（头外 4 字节）。发送端
   `bundle.cpp:358-368`（`currMsgLength_ >= NETWORK_MESSAGE_MAX_SIZE` → 写 65535 +
   `insert` 4B 实长）；接收端 `packet_reader.cpp:116-118`（读到 65535 置哨兵
   `NETWORK_MESSAGE_MAX_SIZE1`）→ `packet_reader.cpp:130-167`（再读 u32，
   超过 `MemoryStream::MAX_SIZE` 直接 condemn 通道）。
   注意：**外网（external）服务端通道拒绝解码出 >65535 的消息**
   （`packet_reader.cpp:165-186`，BOTS/CLIENT 组件除外）——扩展长度实际只用于
   内部进程间通道与客户端接收方向。

### 4.3 packetAlwaysContainLength

- 默认 `false`：`kbe/src/lib/helper/debug_option.cpp:11`。
- 服务端读 `kbengine[_defaults].xml` 的 `<packetAlwaysContainLength>`
  （`kbe/src/lib/server/serverconfig.cpp:132-134`）；C++ 客户端读
  `kbe/src/lib/client_lib/config.cpp:72-74`。
- 置 true 后**所有消息注册为变长**（`msgLen` 强制改 `-1`，
  `message_handler.cpp:173-175`）——即线上每条消息都带 u16 长度字段，包括原本定长的。
  这是解析器必须做成可配置项（而非硬编码"定长无长度字段"）的直接依据。

### 4.4 一个 TCP 包多条消息

`Bundle` 可连续 `newMessage(...)` 多条消息后一次发送，消息首尾相接、无包级帧头，
靠 id/长度自分段；单条消息跨包时由接收端分片重组（`packet_reader.cpp:31,253-289`）。
`Packet` 容量上限：TCP 1460B、UDP 1472B（`common.h:81-83`；
`GAME_PACKET_MAX_SIZE_TCP` 再减去 id+len+加密预留，`common.h:95-98`）。

---

## 5. 消息 ID 分配机制

### 5.1 静态 fixed defaults

- 每个 `MessageHandlers` 实例构造时加载两份 XML：
  1. `server/messages_fixed_defaults.xml`（引擎内置，`notFoundError=true`）
  2. `server/messages_fixed.xml`（项目覆盖，`notFoundError=false` 可缺失）
  （`kbe/src/lib/network/message_handler.cpp:40-41`；
  引擎内置表：`kbe/res/server/messages_fixed_defaults.xml`，共 80 个 `<id>` 条目。）
- 解析规则：XML 元素名 = `组件::消息名`（如 `Loginapp::login`），子元素 `<id>` =
  固定 ID（`kbe/src/lib/network/fixed_messages.cpp:29-74`，映射存 `_infomap[msgname]`）。
- 注册消息时：命中固定表 → 用表内 ID（`message_handler.cpp:168-171`）；未命中 →
  从 1 起自增分配，**跳过已被固定表占用的 ID**（`message_handler.cpp:152-166`）。

引擎内置静态表样例（真实值，`kbe/res/server/messages_fixed_defaults.xml`）：

| 消息 | ID | 行号 |
|---|---|---|
| `Loginapp::login` | 3 | xml:58-65 |
| `Loginapp::hello` | 4 | xml:67-70 |
| `Loginapp::importClientMessages` | 5 | xml:72-75 |
| `Client::onImportClientMessages` | 518 | xml:303-309 |
| `Client::onLoginSuccessfully` | 502 | xml:170-177 |
| `Client::onHelloCB` | 521 | xml:325-328 |

JS SDK 内置表仅硬编码以上少量消息，其余全部依赖动态导入
（`kbe/res/sdk_templates/client/js/kbengine.js:1406-1409`）。

### 5.2 登录期动态导入（关键：静态表在真实连接不成立）

未列入固定表的消息 ID 是**各服务进程启动时自增分配的**，同一进程每次启动分配结果
一致（注册顺序确定），但**跨进程、跨项目不保证一致**。客户端必须在登录后向
loginapp / baseapp 各拉取一次消息表：

- 上行 `importClientMessages`（fixed，args0）：
  - 对 loginapp：`kbe/src/server/loginapp/loginapp_interface.h:32-33`（exposed + fixed）。
  - 对 baseapp：`kbe/src/server/baseapp/baseapp_interface.h:35-36`。
- 下行 `onImportClientMessages`（id=518，变长）：
  - loginapp 返回 **ClientInterface 全部消息 + Loginapp exposed 消息**
    （`kbe/src/server/loginapp/loginapp.cpp:1416-1506`）。
  - baseapp 仅返回 **Baseapp exposed 消息**
    （`kbe/src/server/baseapp/baseapp.cpp:4965-5020`）。
- 每条消息记录的线格式（`loginapp.cpp:1471-1481` 写入序 = JS 读入序
  `kbengine.js:3841-3863`）：

```
u16 count
count × {
  u16  msgID
  i16  msgLen        // -1=变长；>=0=定长（含 ENTITY 消息 +4 的语义）
  str  msgName       // STRING：NUL 结尾，`::` 已替换为 `_`
  i8   argsType      // -1=变长参数 / 0=定长参数
  u8   argsize
  u8[argoutsize]     // 每个 payload 字段的 datatype2id 类型 ID
}
```

- 类型 ID 由 `datatype2id()` 生成（`kbe/src/lib/server/common.h:208`）。

### 5.3 服务端错误描述导入

`importServerErrorsDescr`（loginapp，fixed，args0，`loginapp_interface.h:36-37`）→
下行 `onImportServerErrorsDescr`：`u16 count + count × (u16 id, str name, str descr)`
（写入 `loginapp.cpp:1507-1536`；JS 读 `kbengine.js:3451-3466`）。

### 5.4 SDK 导入

`importClientSDK`（变长，`loginapp_interface.h:40-41`，处理
`loginapp.cpp:1539+`）：分块回传 SDK 生成文件（`i32 remainingFiles, str fileName,
i32 fileSize, blob fileDatas`，JS 读 `kbengine.js:3468-3473`）。

---

## 6. 登录 → 协议导入 → EntityDef 导入 完整流程

以 JS 客户端（官方 SDK 模板）为准，C++ client_lib 语义一致：

1. **建立连接** loginapp（TCP/WebSocket/KCP；KCP 需先 UDP 握手，见 §10.2）。
2. **hello 握手**（可发生于协议导入前或导入后，JS 在导入完成后发送）。
   上行 `Loginapp::hello`（id=4，变长）：
   `str verInfo + str scriptVerInfo + blob encryptedKey`
   （服务端解析 `kbe/src/lib/server/serverapp.cpp:504-539`；客户端发送
   `kbengine.js` `hello()`，key 逻辑同 `kbe/src/lib/client_lib/clientapp.cpp:648-664`）。
   版本不一致 → `onVersionNotMatch`（`serverapp.cpp:536-537`）。
3. 下行 `Client::onHelloCB`（id=521，变长）：
   `str serverVersion + str scriptVersion + str messagesDigest +
   str entityDefDigest + i32 componentType`
   （`kbe/src/server/loginapp/loginapp.cpp:1361-1377`；该包标记已加密跳过二次加密，
   `loginapp.cpp:1374-1376`）。客户端比对两个 digest 决定是否重新导入。
4. **协议导入**：上行 `Loginapp::importClientMessages`（id=5，无 body）
   （JS `kbengine.js:3487-3494`）→ 下行 `onImportClientMessages`（§5.2）。
5. **错误表导入**：上行 `importServerErrorsDescr` → 下行
   `onImportServerErrorsDescr`（§5.3；JS `kbengine.js:3533-3541`）。
6. **登录**：上行 `Loginapp::login`（id=3，变长）：
   `i8 clientType + blob clientDatas + str accountName + str password +
   str entityDefMd5Digest`
   （C++ `kbe/src/lib/client_lib/clientobjectbase.cpp:604-637`；digest 允许服务端
   校验客户端 def 一致性，`allowEmptyDigest` 仅 BOTS 跳过，604-627）。
7. 下行 `Client::onLoginSuccessfully`（id=502，fixed：STRING STRING UINT16
   UINT8_ARRAY）：`str accountName + str baseappIP + u16 baseappTcpPort +
   blob serverDatas`（`clientobjectbase.cpp:690-708`；字段类型见
   `messages_fixed_defaults.xml:170-177`）。失败 → `onLoginFailed`（i32 错误码 +
   blob，`clientobjectbase.cpp:710-723`）。
8. **连接切换（loginapp → baseapp）**：客户端断开 loginapp，连接 baseapp，先
   `hello`（变长：`str verInfo + str scriptVer + blob blowfishKey(可空)`，
   `clientapp.cpp:399-415`）→ 服务端回 `onHelloCB` 并按 key 挂 Blowfish filter
   （`baseapp.cpp:4899-4936`）。
9. **baseapp 协议导入 + EntityDef 导入**：上行
   `Baseapp::importClientMessages`（id=207，`baseapp_interface.h:35-36`；JS
   `kbengine.js:3523-3555`）→ 下行 `onImportClientMessages`（§5.2，仅 exposed）；
   随后上行 `Baseapp::importClientEntityDef`（id=208，fixed args0，
   `baseapp_interface.h:39-40`）。
10. 下行 `Client::onImportClientEntityDef`（变长）：
    - 别名段：`u16 aliassize + aliassize × (u16 uid, str name, str aliasName)`；
      `FIXED_DICT` 类型追加 `u8 keysize + str moduleName + keysize × (str key,
      u16 keyUid)`；`ARRAY` 类型追加 `u16 元素类型 uid`
      （写入 `baseapp.cpp:5042-5080`；JS 读 `kbengine.js:3570-3630`）。
    - 模块段：逐 `hasClient` 脚本模块：`str name + u16 utype +
      u16 propertysize(含 position/direction/spaceID 3 个内置属性) +
      u16 clientMethodSize + u16 baseMethodSize + u16 cellMethodSize` +
      逐属性描述 + 逐方法描述（写入 `baseapp.cpp:5084-5110+`；JS 读
      `kbengine.js:3636-3699`）。
    - 完成后客户端进入正常游戏消息流（JS `kbengine.js:3560+`）。
11. **断线重连**：`Baseapp::reloginBaseapp`（变长）：
    `str name + str password + u32 rndUUID + i32 entityID`
    （`clientobjectbase.cpp:655-670`；成功回 `onReloginBaseappSuccessfully`
    读 `u32 rndUUID`，754-758）。

---

## 7. 实体消息与远程方法调用

- 客户端 → 服务端实体方法：`EntityCallAbstract::newCall_` 按 target 选消息：
  base 方法 → `Baseapp::onRemoteMethodCall`，cell 方法 →
  `Baseapp::onRemoteCallCellMethodFromClient`
  （`kbe/src/lib/entitydef/entitycallabstract.cpp:104-121`；声明
  `baseapp_interface.h:170-171`），随后写 `i32 entityID`
  （`entitycallabstract.cpp:120`）+ 逐参数（`MethodDescription::addToStream`，
  `kbe/src/lib/entitydef/remote_entity_method.cpp:62-88`）。
- 服务端 → 客户端实体消息：`ENTITY` 类消息的定长语义已包含 +4 entityID
  （§4.2，`message_handler.cpp:218`）。
- 属性同步（baseapp/cellapp → client）的字段级格式（别名 ID vs utype 选择、
  volatile 位置压缩 `readPackXYZ` 等）：§13 TODO-3。

---

## 8. 加密

外网通道（external channel）支持 Blowfish 对称加密：

- 客户端在 hello 的 blob 字段携带随机密钥（C++ 侧 `clientapp.cpp:405-411` 生成
  `BlowfishFilter` 并 `appendBlob(key)`；空 blob = 不加密）。
- 服务端校验版本后，若 `g_channelExternalEncryptType > 0` 且 key 长度 >3，
  用该 key 创建 filter 挂到通道（`loginapp.cpp:1380-1386`；
  `Network::createEncryptionFilter`，`kbe/src/lib/network/encryption_filter.h`）。
- **加密帧格式**：`u16 encryptedLen + u8 padSize + Blowfish-ECB 密文`。
  发送端：明文按块填充，`encryptedLen = 明文长 + 1`，
  `padSize = 填充字节数`（`encryption_filter.cpp:56-66`）；接收端按同格式拆帧解密，
  `wpos -= padSize` 还原（`encryption_filter.cpp:95-250`）。最小加密帧要求
  `PACKET_LENGTH_SIZE + 1 + BLOCK_SIZE` 字节（`encryption_filter.cpp:139`）。
- `ENCRYPTTION_WASTAGE_SIZE = 8`（加密预留 1B 长度扩展 + 7B 块填充，
  `common.h:77`）——计入 `GAME_PACKET_MAX_SIZE_TCP`（`common.h:95-98`）。
- WebSocket 通道走 RFC6455 帧过滤（`kbe/src/lib/network/websocket_packet_filter.*`）；
  WSS/TLS 证书配置 `g_sslCertificate/g_sslPrivateKey`（`common.h:56-57`）。
- 内网（internal）通道不加密。

## 9. 压缩

**协议层不存在任何压缩**。对 `kbe/src/lib/network` 全目录检索
`zlib/lzo/lz4/deflate/compress` 无功能命中（仅 trace 调试输出）。KBEngine 线协议
消息正文不做压缩，解析器无需解压层。**TODO-4**：若历史版本（BigWorld 系）曾有
压缩选项，本基准引擎已确认不存在，无需兼容。

## 10. 连接与传输

### 10.1 TCP（默认）

消息按 §4 自分段，无包级帧头；`Packet` 上限 1460B 仅影响发送分片，不影响解析。

### 10.2 UDP / KCP 握手

- KCP/UDP 通道首包必须是握手字符串 `UDP_HELLO =
  "62a559f3fa7748bc22f8e0766019d498"`（`kbe/src/lib/network/common.cpp:41-42`），
  服务端回 `UDP_HELLO_ACK = "1432ad7c829170a76dd31982c3501eca" + str version +
  u32 channelId`（`kbe/src/lib/network/channel.cpp:1099-1116`）。
- 握手通过后通道切换为 `KCPPacketReader`（`channel.cpp:1111-1116`），其后消息格式
  与 TCP 相同（`kcp_packet_reader.*`）。

### 10.3 连接切换

loginapp → baseapp 切换见 §6 第 8 步；断线重连见 §6 第 11 步。切换时**必须重新走
hello + 协议导入**（baseapp 与 loginapp 的消息表相互独立）。

---

## 11. 客户端 MessageReader / 服务端 PacketReader 对照

| 侧 | 实现 | 关键差异 |
|---|---|---|
| 服务端 C++ | `kbe/src/lib/network/packet_reader.cpp:31-250` | 查不到 msgID → ERROR + condemn 通道（73-79）；外网长度上限检查（165-186）；扩展长度上限 `MemoryStream::MAX_SIZE`（141-163） |
| JS 客户端 | `kbe/res/sdk_templates/client/js/kbengine.js:3185-3350`（`Client_onImportClientMessages` 导入期专用路径 3899-3944） | 查不到 msgID 仅报错并 break（3207-3212）；扩展长度判定 `== MESSAGE_MAX_SIZE`（3239） |
| Unity C# | `kbe/res/sdk_templates/client/unity/MessageReaderTCP.cs`（`MessageReaderBase.cs` 定义接口）、`MessageReaderKCP.cs` | 扩展长度判定 `>= 65535`（MessageReaderTCP.cs:109） |
| UE4 C++ | `kbe/res/sdk_templates/client/ue4/Source/KBEnginePlugins/Engine/MessageReader.cpp` | 同状态机（§13 TODO-5：未逐行比对） |

三端状态机一致：`READ_ID → (READ_LEN → READ_LEN_EX) → READ_BODY`，支持任意字节
边界分片。

---

## 12. 测试报文与 PCAP 样本

目录 `docs/samples/kbengine-wire-samples/`。**合成样本**：由
`generate_samples.py` 按本文规则生成并经独立解码器 round-trip 校验，消息 ID 取自
引擎真实静态表（§5.1）；**非真实服务器抓包**。

| 文件 | 内容 | 首字节 hex |
|---|---|---|
| `sample-01-fixed-noargs.bin` | 定长无参消息 `Loginapp::importClientMessages`（id=5，无长度字段） | `05 00` |
| `sample-02-variable-login.bin` | 变长 `Loginapp::login`（id=3，len=54） | `03 00 36 00` |
| `sample-03-extended-length.bin` | 扩展长度消息：u16=65535(`ff ff`) + u32 实长 70000(`70 11 01 00`) | `06 02 ff ff 70 11 01 00` |
| `sample-04-import-client-messages.bin` | `onImportClientMessages`（id=518）1 条协议表项 | `06 02 17 00` |
| `sample-05-type-encodings.bin` | STRING(`61 62 63 00`)/UNICODE/BLOB/VECTOR3 编码样本 | `06 02 22 00` |
| `sample-06-on-login-successfully.bin` | `Client::onLoginSuccessfully`（id=502） | `f6 01 1a 00` |
| `sample-07-blowfish-frame.bin` | 加密帧：`u16 encLen + u8 padSize + Blowfish-ECB`（56 字节测试 key，密文可解） | `09 00 06` |
| `kbengine-login-flow.pcap` | 合成 TCP 会话 6 帧：hello→onHelloCB→importClientMessages→onImportClientMessages→login→onLoginSuccessfully（Eth/IP/TCP 头为合成值） | pcap |

复现：`python3 docs/samples/kbengine-wire-samples/generate_samples.py`
（依赖 `cryptography` 仅用于样本 07 的真实 Blowfish-ECB）。

---

## 13. C-15 需修订点清单（线格式编解码器）

1. **静态消息表假设不成立（最重要）**。C-15 现有 `decode_message_frame` 依赖预置
   消息表；真实连接中除 5 个内置 fixed id（§5.1）外，**所有消息 ID 都是进程启动期
   自增分配、且登录期经 `onImportClientMessages` 动态下发**（§5.2）。修订：
   消息表必须建模为"静态 defaults + 项目 overrides + 动态导入合并"三段，
   id↔(name,msgLen,argtypes) 映射只能来自导入帧，不能来自静态推断。
2. **定长消息长度不可静态计算的场景**：`packetAlwaysContainLength=true` 时全部消息
   变长（§4.3）；schema 需携带该开关，且 `std::string` 参数强制变长
   （`message_handler.cpp:201-215`）、ENTITY 消息 +4（:218）两条规则影响定长推断。
3. **STRING 双编码**：协议参数 `std::string` = NUL 结尾无前缀；EntityDef UNICODE =
   u32 前缀（§3.1）。C-15 若用单一 String 布局会在协议参数与实体属性两个语境出错；
   读端"遇非 ASCII 提前停止"的行为（`memorystream.h:326-330`）也需复刻才能与引擎
   逐字节对拍。
4. **变长长度语义**：u16 长度 = payload，不含 id+len 头（§4.2）——与部分
   BigWorld 文档"含头"表述相反，C-15 回填/校验逻辑需明确按引擎为准
   （`bundle.cpp:346-347`）。
5. **扩展长度只允许部分方向**：外网服务端解码 >65535 直接 condemn
   （`packet_reader.cpp:165-186`）；C-15 若对齐线上行为，超长帧在 external 语境
   应判非法而非尝试解码。
6. **加密是通道属性不是消息属性**：加密帧 `u16 encLen + u8 padSize + 密文` 包在
   消息流**外层**（§8）；C-15 的 decode 入口需先按通道加密态剥帧，padSize 参与
   明文还原。
7. **无压缩层**（§9）：C-15 不需要、也不应引入解压钩子。

---

## 14. TODO 清单（未取证 / 无法静态取证）

- **TODO-1**：大端编译（`USE_BIG_ENDIAN`）实际部署是否存在及各字段翻转语义——仅
  从宏定义推断（`platform.h:128-136`），未找到官方使用证据。
- **TODO-2**：ENTITYCALL 作为 EntityDef 属性值时的完整线格式（id/type/utype 字段
  序）——`EntityCallType::addToStream`（`datatype.cpp:1512+`）未逐行取证；
  C-15 现有"16B 定长 id+cid+type+utype"说法未与本基准源码对拍。
- **TODO-3**：服务端 → 客户端属性同步流（别名 ID vs utype 双模式、volatile 位置
  位打包 `readPackXYZ`，`memorystream.h:443-452`）的字段级帧格式——属 PA-002
  Schema 引擎范围，Phase 0 未展开。
- **TODO-4**：历史 BigWorld 版本是否曾有压缩选项（本基准 v2.5.10 确认无）。
- **TODO-5**：UE4 `MessageReader.cpp` 与 JS/Unity 端的逐行一致性比对。
- **TODO-6**：真实服务器报文抓包样本（需可运行的 KBEngine 部署 + tcpdump/Wireshark），
  用于替换 §12 合成样本做黄金校验（与 C-15 wire-probe 先例一致：合成推导样本为
  当前权威，真实样本落地后替换）。
- **TODO-7**：`messages_fixed_defaults.xml` 全部 80 条固定 ID 的完整抄录表
  （PA-002 解析该 XML 自动生成，此处仅摘引关键 6 条）。
- **TODO-8**：WebSocket 通道内消息帧与 raw TCP 的差异细节（RFC6455 帧边界外是否
  有 KBEngine 自身附加头）——`websocket_packet_filter.*` 未逐行取证。

---

*产出：PA-001（todo.md）。取证日期 2026-11-06；引擎基准 bf1a9cd6（v2.5.10）。*
