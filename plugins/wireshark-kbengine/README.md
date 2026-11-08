# wireshark-kbengine

KBEngine 线协议的 Wireshark dissector 插件（todo PA-006）。把 KBEngine 客户端↔服务端
TCP 流解码成可读的 Info 列摘要（消息名 + 参数个数），组帧/解码核心复用仓库
`crates/kode-kbengine-protocol`（PA-003 验收面），本 crate 只是 Wireshark 宿主适配层，
零解析逻辑。

## 架构边界

- **解析单源**：三种长度形态（2 字节 LE / 65535 扩展 4 字节 LE）、TCP 粘包/拆包、
  静态 + 登录动态导入消息表、每流独立状态机、内存上限与错误复位语义全部在
  `kode-kbengine-protocol`（`Flow::feed_direction`）。插件不 `tcp_framing()`
  （不走 `tcp_dissect_pdus`），每包整段 TCP 载荷直接喂协议 crate。
- **首遍语义**：会话状态只在 Wireshark 首遍推进（`is_first_pass`）；重放遍
  （选中/过滤触发的重解剖）只复述首遍摘要缓存，不重复喂流。
- **不编造**：未配置静态表或 id 未装表时如实标 `id=0x…(unknown)`，与 CLI
  `kode-kbengine capture analyze --defaults` 缺省口径一致；组帧出错如实标
  `framing reset`（协议 crate 出错即自身复位，后续包从干净状态重新同步）。
- **端口绑定**：首选项 `loginapp_port`（默认 20013）/`baseapp_port`（默认 20015，
  0 = 不绑）；首选项变化即重挂载绑定。pcap 用非默认端口时
  `-o kbengine.loginapp_port:<port>` 覆盖。

## 构建

本 crate 是**独立 GPL workspace**（不进仓库根 workspace，不随 Apache VSIX 分发）。
依赖本仓库相邻 path crate（`crates/kode-kbengine-protocol`、
`crates/kode-kbengine-schema`），因此需在仓库检出内构建：

```sh
cd plugins/wireshark-kbengine
cargo build --release
# 产物: target/release/libwireshark_kbengine.so
```

链接本机 libwireshark（`libwireshark-sys` build.rs 自动发现本机安装并按主版本选
bundled 头 bindgen）——**产物与宿主 Wireshark 主/次版本耦合**（`plugin_want_major/
minor`），每 OS × 每 Wireshark 版本一份产物；4.6 插件不进 4.4 宿主。

## 安装（落盘目录由宿主扫描 dlopen）

| 系统 | 个人目录 | 系统目录 |
|---|---|---|
| Linux | `~/.local/lib/wireshark/plugins/<maj.min>/epan/` | `/usr/lib/<multiarch>/wireshark/plugins/<maj.min>/epan/` |
| Windows | `%APPDATA%\Wireshark\plugins\<maj.min>\epan\` | Wireshark 安装目录 plugins |
| macOS | 同 Linux 个人目录 | `/Applications/Wireshark.app/.../plugins` |

**发行版加固注意（本机 Ubuntu 26.04 实证）**：

- tshark 带 AppArmor 强制档案（`/etc/apparmor.d/tshark`）时**个人插件目录被拦**
  （openat EACCES），必须 root 装系统目录或写本地档案覆盖；
- 插件目录 group/world-writable 时宿主拒扫（实测 775 被拒，需 ≤755）；
- tshark 同档案也拦 home 目录文件读取，pcap 先拷 `/tmp` 再 `-r`。

装完重启 tshark/Wireshark 生效：`tshark -G plugins | grep kbengine`。

## 验收样例

`docs/samples/kbengine-wire-samples/` 有合成 login 流 pcap（端口 1001↔2001，
6 帧）。当前 tshark 只出 Info 列摘要面；有类型字段树是下一增量：

```sh
sudo install -m 644 target/release/libwireshark_kbengine.so \
  /usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6/epan/
tshark -r /tmp/kbengine-login-flow.pcap -Y kbengine \
  -o kbengine.loginapp_port:2001
sudo rm /usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6/epan/libwireshark_kbengine.so
```

无插件的环境零 ABI 兜底：`kode-kbengine capture analyze` 直接吃 pcap（PA-004）。

## License

GPL-3.0-or-later。**独立于仓库其余部分的许可证边界**：本 crate 依赖的
`kode-kbengine-protocol`/`kode-kbengine-schema` 是 Apache-2.0；依赖方向只允许
GPL 插件 → Apache crate（合法），Apache crate 不得反向依赖 GPL（现无，单向干净）。
本目录产物不得进 Apache VSIX / 根 workspace 发布面。
