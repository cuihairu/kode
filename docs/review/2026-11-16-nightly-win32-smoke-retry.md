# nightly win32-x64 打包冒烟冷启动重试(43817266345)

日期:2026-11-16
账本:todo.md RUST-056(旧 BUILD-007,平台构建与每平台真二进制冒烟)补注。
起因:nightly `workflow_dispatch` 43817266345(7 包 all-or-nothing)六平台腿全绿、
`Existing full correctness gate` 与 `linux-x64` 均绿(本会话 RUST-136 的
ruff spawn 暂态修复在 linux 侧生效),唯 `win32-x64` 腿红 → publish 与
「verify no version tags」按闸跳过。

## 归因(全部 cargo 测试通过,失败在打包冒烟)

win32-x64 腿内 `cargo test --locked --target` 全绿(kode-server 534 passed、
192/87/53/29/16 各套件 ok),失败点是 `scripts/platform-vsix.mjs` 的
`smokeBinaries` 末段:

```
Error: D:\a\kode\kode\bin\kode-mcp.exe failed (null):
  spawnSync D:\a\kode\kode\bin\kode-mcp.exe ETIMEDOUT
  at run (scripts/vsix-staging.mjs:9:11)
  at smokeBinaries (scripts/platform-vsix.mjs:88:15)
```

`kode-mcp` 冒烟步的 spawn 预算恰为 `timeout: 20000`(`platform-vsix.mjs`
mcp 段,与 LSP 段同值),runner 上冷启动撞上预算即抛。`kode-kbengine`
的 `--version` 只有 10 s,`kode-server` LSP 段先跑且过了——说明本腿此前
的 2m13s release 构建已把 runner 压满,首个尚未热身过的冷进程(kode-mcp)
启动超过 20 s。与既有 ruff spawn 暂态族(EMFILE/ENFILE + 四拍退避)同族。

同批暴露的归因缺陷:`vsix-staging.mjs` 的 `run()` 在 `result.error` 分支
拼错误串时**丢弃了 `result.stdout/stderr`**——冒烟子进程自己的输出从
不在 workflow 日志里,本例只能靠 `ETIMEDOUT` 一词推断。

## 修复(scripts/vsix-staging.mjs)

1. **冷启动暂态重试**:新增 `TRANSIENT_SPAWN_CODES = new Set(['ETIMEDOUT','ESRCH'])`
   与 `MAX_SPAWN_ATTEMPTS = 3`、`SPAWN_BACKOFF_MS = [20,60,150]`。
   `run()` 改为按 `maxAttempts`(默认 3)循环:`isTransientSpawnError(result.error)`
   为真且未耗尽才退避重试。永久失败(ENOENT/EACCES/非零退出码)**不重试**,
   避免把真缺陷掩盖成抖动。
2. **错误信息保留子进程输出**:`outputTail(result)` 取 stdout/stderr 各末
   4000 字符拼进错误串,后续失败可直接从日志归因。
3. 抛错对象挂 `code`(spawn 错误取 `result.error.code`,非零退出取
   `EXIT_<status>`),调用方可按码分流而不靠文案正则。
4. 退避用 `Atomics.wait`(同步,`run()` 本身同步,不能用 await)。

`run()` 是 `packageVsix`(vsce)、`smokeBinaries`(三二进制)、
`verify-platform-vsix` 的公共底座,一处修复全平台腿与 verify 链同吃;
nightly 经 platform-vsix.yml 复用同脚本自动生效。

## 测试与 prove-red

新 `tests/nativeSmokeRetry.test.ts` 5 例。行为面**驱动真脚本**:本套件
无 `.mjs` 导入先例(`platformPackageSet.test.ts` 同法规避),故在临时目录
生成 driver `.mjs`,`await import(pathToFileURL(...))` 载入真
`scripts/vsix-staging.mjs`,再 spawn 一个真 node 子程序当冒烟目标:

- 冷启动重试:子程序首拍阻塞、后续拍即返 → 断言 `RETRY_OUT:recovered on
  attempt 2` + `MARK:cold,warm`(证明重试真发生且回收了输出);
- 永久超时耗尽:断言 `EXHAUST_CODE:ETIMEDOUT` + 恰好 3 次尝试
  (`MARK:cold,warm,warm`),第 4 次不发生;
- 输出保留:非零退出子程序 → 错误串同时含 stdout/stderr 标记;
- 源级守卫:`TRANSIENT_SPAWN_CODES` 只含 ETIMEDOUT/ESRCH、
  `MAX_SPAWN_ATTEMPTS = 3`、退避表与 `sleepMs` 调用位不变。

prove-red 一靶双变异(cp 备份 + python 变异 + cmp 字节还原):
`maxAttempts = 1`(重试死)+ 两处 `outputTail` 调用删除 → 3 例红;还原后
5/5 绿。

## 门禁

pnpm lint 0;pnpm compile 0;pnpm test:unit 全量 846 文件 10353 + 8 skipped
RC=0(含新增 5 例);pnpm test:unit 前 RUST-137 批已跑 clippy 0 /
cargo test --workspace 167 suites RC=0 / xvfb demo 25 RC=0。真机验收面
=下一轮 nightly 六平台腿(尤其 win32-x64)在 `smokeBinaries` 段过闸。

## 诚实边界

- 未改冒烟 `timeout` 值(20000/10000):预算本身合理,问题是预算内的
  合法冷启动被当成失败;加重试而非抬预算,以免真挂死的进程被拖到
  整个 job 超时。
- win32 本例无法在本地复现(需 Windows runner 与 musl/msvc 目标),
  归因基于 workflow 日志原文与 spawn 预算算术;本批验证的是**重试与
  归因两面**在本地可测,平台腿真验收等下一轮 nightly。
- `ESRCH` 一并判暂态:spawn 后进程已被回收的边界情形,同族处理;若
  实测它掩盖真失败,收窄回单码即可(守卫测试同步)。
