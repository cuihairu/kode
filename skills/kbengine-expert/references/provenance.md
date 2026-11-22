# 版本与源码来源

| 项目 | 固定值 |
| --- | --- |
| 官方发行版 | KBEngine 2.5.12 |
| 提交 | `7d379b9f943d2731b09c45398855f98efe74d046` |
| 嵌入式解释器 | CPython 3.7.3，由随附 `kbe/src/lib/python/Include/patchlevel.h` 确认 |
| 下载归档 SHA-256 | `a28df7f22dd65c752a49ba022d9fc37aca9f3684c79fa4b0cdb507fbec8666d1` |
| 快照 | `references/source/` 中 1,066 个原始源码和资源文件，保留上游路径、文件内容及许可 |

- [官方发布页](https://github.com/kbengine/kbengine/releases/tag/2.5.12)
- [固定提交源码](https://github.com/kbengine/kbengine/tree/7d379b9f943d2731b09c45398855f98efe74d046)
- [固定提交归档](https://codeload.github.com/kbengine/kbengine/tar.gz/7d379b9f943d2731b09c45398855f98efe74d046)

## 快照范围

包含服务器进程、引擎核心库、客户端公共库、默认配置、服务器资产模板、构建入口以及 CPython 头文件与相关嵌入实现。省略上游二进制、完整第三方依赖树、密钥和其余 CPython 源码。编译引擎需使用同一提交的完整源码与对应业务资产。

宿主机可能同时存在不同的 KBEngine fork 或不同补丁版本的 Python 3.7。关联 fork 时，从其构建配置、引用的 Python 头文件和实际启动日志重新确定解释器版本。早期官方 `0.1.2` 的版本头是 3.2.5，不能单凭标签年代判断 Python 主版本。 [0.1.2 版本头](https://github.com/kbengine/kbengine/blob/080fd4f0b1fec20233c38a3600f8da3c26542444/kbe/src/lib/python/Include/patchlevel.h)

从技能目录运行 `python3 scripts/verify-source.py` 校验清单、每个源文件的内容及 CPython 版本宏。源文件保留上游条款。 [KBEngine 许可](source/LICENSE.txt) [CPython 许可](source/kbe/src/lib/python/LICENSE)
