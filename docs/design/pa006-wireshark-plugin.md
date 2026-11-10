# PA-006 技术选型：libwireshark Rust 绑定实勘与跨系统加载（2026-11-08）

PA-006（todo.md：Wireshark/TShark 集成）第一增量：对 todo 记录的
「libwireshark Rust 绑定（现 alpha 0.0.0，按 Wireshark 版本分别构建）六项能力」
做编译级实测，产出路线判定与跨系统交付矩阵。**本批只收选型与加载证据；
插件本体（字段树/解析/PCAP 验收）是后续批次，PA-006 不因此勾账。**

## 实勘结论：六项能力全部有一等 API 面，路线判定 = Rust 插件（不需要 C Thin Adapter）

| # | 能力 | 绑定 API | 实测证据 |
|---|---|---|---|
| ① | 协议/dissector 注册（端口/启发式表） | `Dissector` trait + `Binding::tcp_port/udp_port/heuristic`（偏好变化时重挂载） | spike 编译通过 |
| ② | 报文字节访问 | `PacketView`：捕获字节 `&[u8]`、端序感知整型读、Info 列 | spike 编译通过 |
| ③ | 协议树字段节点 + 显示过滤字段 | `#[derive(Header)]`（结构体即字段集，含类型化字段与过滤名，自动挂树） | README/API 面（真实插件批次落字段） |
| ④ | TCP 重组（粘包/拆包） | `TcpFraming::new(header_len, message_len: fn(&[u8]) -> Option<usize>)`——自定义长度函数，**KBEngine 65535 扩展长度形态（2 字节 LE=65535 标记 + 4 字节 LE 实长）可在此函数内处理**（spike 已按此形态实现） | spike 编译通过；`tcp_dissect_pdus` 语义 |
| ⑤ | 首选项（端口配置） | `#[derive(Preferences)]`（结构体即偏好集，变化即重挂载） | README/API 面 |
| ⑥ | 会话级状态（登录动态协议导入映射） | per-conversation state（`Dissector` 关联状态） | README/API 面 |

上游还带：`Expert`（专家信息=诊断面）、`Tap`（`tshark -z` 统计=分析面）、
`FilterFunction`（4.4+）、`FileType`（4.6+，capture 格式）、`Codec`（4.6+）。

## 编译与加载证据链（本机 tshark 4.6.4 / Ubuntu resolute / rustc 1.99.0）

1. crate 实存（crates.io 2026-11-08 查询）：`libwireshark 0.0.0-alpha.0`
   （GPL-2.0-or-later，MSRV 1.89，edition 2024）+ `libwireshark-sys
   0.0.0-alpha.0`（bundled 头 wireshark-3-0.h..4-6.h，bindgen 生成）+
   `libwireshark-derive` + `cargo-wireshark` 子命令。
2. 依赖链编译干净：26.5s（bindgen + libclang-21 + 链接本机
   `libwireshark.so.19`）。`build.rs` 自动发现本机安装 → 按 4.6 选
   bundled 头 → 生成绑定 —— **todo 记录的「按 Wireshark 版本分别构建」
   即此机制，已核实**。
3. KBEngine 线格式 spike（2 字节 LE 长度 + 65535 扩展标记 + 4 字节 LE 实长，
   `TcpFraming::new(6, kbengine_message_len)`，TCP/23500 绑定）编译出
   cdylib；导出符号 `plugin_describe/plugin_register/plugin_want_major=4/
   plugin_want_minor=6`（ABI 正确）。
4. **真实 tshark 4.6.4 加载成功**：`tshark -G plugins` 列出
   `kbengine_spike.so 0.1.0 dissector`（装→验→删，可逆验证）。
5. spike 位于 /tmp/kode-ws-spike（GPL 产物，不入本仓库 Apache 代码基）。

## 跨系统加载矩阵（回答「不同系统的 Rust 二进制怎么加载」）

**两类 Rust 二进制必须分开：**

| | kode-server（LSP 面） | Wireshark 插件（PA-006） |
|---|---|---|
| 进程形态 | 独立进程，stdio 管道 | cdylib 被 Wireshark `dlopen` 进宿主进程 |
| ABI 耦合 | 无（管道协议隔离） | 有：链接宿主 `libwireshark.so.19`/`.dll`/`.dylib` |
| 版本耦合 | 无 | 有：`plugin_want_major/minor` 必须匹配宿主（4.6 插件不进 4.4 宿主） |
| 交付产物 | 每 OS 一个独立二进制 | **每 OS × 每 Wireshark 版本**矩阵产物（`.so`/`.dll`/`.dylib`） |
| 加载方 | kode 扩展拉起 | 用户已装的 Wireshark/tshark 启动时扫描插件目录 |

**插件落盘目录（版本化子目录，由宿主扫描 dlopen）：**

- Linux 个人：`~/.local/lib/wireshark/plugins/<maj.min>/epan/`；
  系统级：`/usr/lib/<multiarch>/wireshark/plugins/<maj.min>/epan/`
- Windows：`%APPDATA%\Wireshark\plugins\<maj.min>\epan\`
- macOS：`~/.local/lib/wireshark/plugins/<maj.min>/epan/`

**本机实证的发行版加固差异（部署矩阵必收）**：Ubuntu 26.04 给 tshark 配了
AppArmor 强制档案（/etc/apparmor.d/tshark），**只放行系统插件目录，个人
插件目录（~/.local/...）openat EACCES 被拦**——此类发行版上个人目录装了
也不加载，必须 root 装全局目录或 `local/tshark` 档案覆盖。另：插件目录
group/world-writable 时 Wireshark 拒扫（安全加固，实测 775 被拒，需 ≤755）。

**交付策略（PA-007 的「Wireshark/TShark/插件版本检测」即为此设）**：
检测宿主版本 → 按 OS × 宿主版本取预编译产物（发版资产按矩阵出，
属正式版本面，受用户发版红线管辖）→ 落对应目录 → 重启 tshark 生效；
检测不到/版本不匹配 → **纯 CLI 兜底零 ABI 耦合**（PA-004 已交付：
`kode-kbengine capture analyze` 直接吃 pcap，任何系统只需 kode 二进制
本身能跑，不依赖插件）。

## 挂账风险（后续批次处置）

- alpha 0.0.0 非稳定 API：上游升级可能破坏编译/行为；锁定版本，
  升级走显式对拍。
- 构建矩阵 = OS × Wireshark 版本，产物量随宿主版本线增长；nightly
  每日构建面（允许的交付面）覆盖主版本线即可，冷门版本线按需补。
- GPL-2.0-or-later 传染面：插件独立 crate（license 不得混入本仓库
  Apache VSIX/其余 crates）；解析核心复用本仓库 `kode-kbengine-protocol`
  属 Apache 侧——**边界协议**：插件 crate 以依赖方式引入解析核心需
  Apache crate 保持无 GPL 依赖反向干净（Rust 依赖单向：GPL 插件 →
  Apache crate 合法，Apache crate 不依赖 GPL 插件），C Thin Adapter
  路线已裁撤无需此考虑的备份，保留该边界为发版前核对项。

## 后续批次（PA-006 余量，勾账条件）

1. 正式插件 crate（独立仓库或本仓库独立 workspace 成员，GPL 标注）：
   ~~会话状态接登录动态协议导入、Expert 诊断面~~（2026-11-08 第二增量已交付，
   见下节）、~~全字段树（Header derive 落 KBEngine 消息字段）~~（同日第三
   增量已交付，见下节；手工 Header impl，derive 不适用动态区间）。
2. ~~真实 KBEngine 报文 pcap 样本端到端：`tshark -r sample.pcap -Y kbengine`
   命中断言~~（2026-11-08 第二增量已交付，见下节）。
3. ~~Windows 实机加载验证~~（2026-11-10 imac 已验，见下节「Windows 实机
   加载验证」）；macOS 不适用（KBEngine 不支持 macOS，按用户口径不再开
   macOS 验证）。

## 第二增量：正式插件 crate + 真实 pcap 端到端验收（2026-11-08）

**crate**：`plugins/wireshark-kbengine/`——独立 GPL-3.0-or-later workspace
（清单内空 `[workspace]` 表切断根推断；不进根 members，不随 Apache VSIX），
cdylib，依赖本仓库 `kode-kbengine-protocol`/`-schema`（path 依赖，依赖方向
GPL→Apache 单向）。`cargo build`（14s）+ `cargo clippy --all-targets` 0 警告；
release 产物 1.0MB，导出 `plugin_describe/plugin_register/plugin_want_major=4/
plugin_want_minor=6/plugin_version`。

**架构（解析单源，插件零解析逻辑）**：`tcp_framing() -> None`（不走
`tcp_dissect_pdus`）——组帧/解码全在 `kode-kbengine-protocol` 的
`Flow::feed_direction`（三种长度形态、65535 扩展、内存上限、错误复位、
动态导入副作用两方向共享）。插件每包整段 TCP 载荷直接喂协议 crate，
出 `Vec<DecodedMessage>` 转 Info 列摘要。首遍语义：会话状态只在
`is_first_pass` 推进，重放遍复述 `summaries` 缓存不重复喂流。
首选项：`loginapp_port`（默认 20013）/`baseapp_port`（默认 20015，0=不绑）/
`defaults_xml`（空=空表全 unknown，与 CLI `--defaults` 缺省同口径）。
Expert 面：`framing_error`（Malformed/Warning）+ `unknown_message`
（Undecoded/Note），按摘要文本置位。

**真实 pcap 端到端（docs/samples/kbengine-wire-samples/kbengine-login-flow.pcap，
6 帧，端口 1001↔2001 需 `-o kbengine.loginapp_port:2001` 覆盖）**：
装全局 epan（AppArmor 拦个人目录，见上节）→ `tshark -G plugins` 列出
dissector → `-Y kbengine` **两模式均 6/6 命中** → `sudo rm` 干净移除
（grep kbengine = 0，装→验→删可逆闭环）。

### Windows 实机加载验证（2026-11-10，imac）

**宿主**：Windows 10.0.26300（imac，LAN 192.168.5.117）。**Wireshark**：
4.6.4 portable（`WiresharkPortable64_4.6.4.paf.exe`，7z 解到
`C:\Users\cui\pa006\ws\App\Wireshark\`，含 libwireshark.dll + tshark.exe）。

**构建**（`plugins/wireshark-kbengine`，rust-version 1.97 满足）：
`rustc 1.99.1`（scoop 真实 exe，shim 坏）+ MSVC vcvars64（VS18 企业版）+
`llvm-readobj`（scoop llvm current）→ `set WIRESHARK_DLL=<ws>\libwireshark.dll`
→ `cargo build --release` RC=0，产物 `wireshark_kbengine.dll`（721,920 字节）。
libwireshark-sys 在 Windows 未发现 `libwireshark.lib` 时自动
`llvm-readobj --coff-exports` 生成导入库——实证路径即此。

**加载+端到端**：DLL 落
`%APPDATA%\Wireshark\plugins\4.6\epan\wireshark_kbengine.dll` →
`tshark -G plugins` 列出 `wireshark_kbengine.dll 0.1.0 dissector`（加载成功）
→ `tshark -r <pcap> -o kbengine.loginapp_port:2001 -Y kbengine` → **6/6 命中**，
6 帧协议栈均 `eth:ethertype:ip:tcp:kbengine`，RC=0（与 Linux 同 `-o` 覆盖口径：
默认端口 20013≠pcap 2001，裸 `-Y kbengine` 0 命中为预期，非缺陷）。

**与 CLI 面同源对照（插件忠实转发协议 crate 行为，零行为差异）**：

| 模式 | 插件（tshark） | CLI（`capture analyze --flow-map loginapp=2001`） |
|---|---|---|
| named（带 defaults） | 4 帧解码出消息名（`Loginapp::hello(3)`/`Client::onHelloCB(4)`/`Loginapp::importClientMessages(0)`/`Client::onLoginSuccessfully(4)`）+ 2 帧 `framing reset` | 4 records + 2 anomalies（`unexpected_eof`/`memory_limit`） |
| unknown（无 defaults） | 6 帧 `framing reset: UnknownMessageId` | 0 records + 6 anomalies（`unknown_message_id`） |

**帧 4/5 reset 归因（挂账，非插件回归）**：合成 pcap 的 s2c 帧 4
（onImportClientMessages id 518）与 c2s 帧 5（login id 3）在 CLI 面同样
anomalies——样本 body 与静态表签名既有不一致（PA-003/PA-004 遗留面），
插件与 CLI 逐帧一致；真实引擎流量不受影响（动态导入后再解码）。

**PA-006 余量**：有类型字段树（Header derive）；Windows/macOS 实机加载。

## 第三增量：有类型字段树（2026-11-08）

**数据面（协议 crate 单一来源，插件零解析逻辑）**：`kode-kbengine-protocol`
新增 `decode_spans`/`SpanKind`/`ValueSpan`（additive，不参与值解码路径）——
`decode_inner` 的跨度镜像：同 Cursor 读序、同 Budget/深度/数组最小元素
预检、同错误文本；唯一差异=记录消费区间而非值。EntityCall/Unresolved 同
值解码不推进游标，Raw 跨度覆盖剩余字节。对拍锁定：`tests/span_units.rs`
8 例（标量偏移/CString 含 NUL 高字节截断/带前缀块两层/Vector+Array 嵌套/
FIXED_DICT 嵌套偏移/Raw 不推进游标/全语料 Ok-Err+消费字节数对拍/深度上限
同错），全绿。

**渲染面（插件）**：手工 `Header` impl（derive 面不适用——字段是运行时
解码结果的动态区间，非静态结构体；框架允许手写 `fields()`+`add_to()`）。
18 个注册字段：帧头 `msg_id`(U16 Hex)/`msg_len`(U16)/`msg_len_ext`(U32)，
参数 `arg_bool`/`arg_u8..u64`/`arg_i8..i64`(LE 整数)/`arg_f32b`/`arg_f64b`
(FT_BYTES 字节面——libwireshark alpha 未暴露 FT_FLOAT/FT_DOUBLE，不解值
不编造)/`arg_str`(FT_STRING UTF-8)/`arg_bytes`/`arg_raw`/`arg_group`
(FT_NONE 容器递归)。帧树缓存 `MsgTreeEntry{base,id,length_spec,payload_len,
spans}` 按帧号缓存，重放遍复述（纯渲染无副作用）。

**偏移真校验（错误复位脱节面）**：协议 crate 错误复位清缓冲不动
`abs_base`，流内偏移与喂入字节数脱节；插件按方向记 `fed` 计数，帧 tvb
偏移=`stream_offset-fed`，渲染前校验 tvb 帧头 2 字节==id 小端——失真帧
如实不出树（摘要照旧），不猜偏移。

**真实 pcap 验收（同第二增量样本与流程，装→验→删闭环）**：named 模式
`-V` 树 4 帧（msg_id×4/msg_len×3（Variable 形态）/arg_str×7/arg_group×2/
arg_u32×2/arg_bytes×2）；`-T fields -e kbengine.msg_id -e kbengine.arg_str`
提取帧 1=`0x0004|18|2.5.10,2.5.10`、帧 6=`0x01f6|26|player1,127.0.0.1`
（字段值与样本语义一致）；复位帧 4/5 如实无树；unknown 模式（无
defaults_xml）全帧无树=0。回归：两模式 `-Y kbengine` 仍 6/6。

**诚实边界**：dict 键名/array 下标不出树（libwireshark alpha 无
proto_item_set_text 绑定，标签是注册期静态的）；浮点按字节面展示不解值；
EntityCall/Python pickle 保持 Raw 不编造；0 长度体（空 BLOB）显示
`<MISSING>`（Wireshark 对 0 字节项的固有展示）。

**验收门**：`cargo build`+`cargo clippy --all-targets` 0 警告（debug/release
双形态）；`kode-kbengine-protocol` 32+11+13+8 全绿；`kode-kbengine`/
`-schema` 回归 35+12+29+1 绿；tshark 真机装→验→删可逆闭环。

**PA-006 余量**：Windows/macOS 实机加载（CI 或用户机，无机器挂账）。
