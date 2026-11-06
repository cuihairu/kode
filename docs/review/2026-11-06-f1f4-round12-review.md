# F1–F4 第十二轮复审：R11 证据绑定

结论：**PASS**。四项均通过；本轮依据提交、探针代码与已记录日志核验，未重跑测试，尤其未运行监听 127.0.0.1 的回环测试。日志证明的是所记录的采集结果，并非本轮独立复现。

## 1. 终态代码提交的门禁日志 — PASS

`docs/review/evidence/r11-full-{cargo,fmt-clippy,eslint,tsc,vitest-1,electron}.log` 六份各自第 1–5 行均记录分支 `feat/kode-fix-f1f4`、HEAD `8411a7279ac6c366ef48a56678e72730cb3c9ede`、采集时 `git status --porcelain` 为空、开始时间及命令；各自末行记录结束时间和 `exit=0`。HEAD 字段记的是值，未在头部单独展示 `git rev-parse HEAD` 命令本身。

- cargo：`r11-full-cargo.log:1141` 退出 0；将日志中 94 条 `test result` 汇总为 558 passed、0 failed。
- fmt/clippy：`r11-full-fmt-clippy.log:7-11` 两项各 exit=0，包装器 exit=0。
- eslint：`r11-full-eslint.log:5-9` 无错误输出且 exit=0；tsc：`r11-full-tsc.log:5-11` 编译输出记录同一 build commit，exit=0。
- vitest：`r11-full-vitest-1.log:14-15,23` 为 6390 passed、20 skipped、无失败项，exit=0。
- VS Code：`r11-full-electron.log:30-33` 为 12 passing、exit=0。

上述输出与退出码自洽；cargo 和 vitest 日志也有警告，未呈现测试失败。

## 2. 运行时采集哈希 — PASS

探针 `scripts/hot-reload-receiver/winRoundtripProbe.mjs` 已在被测提交 `8411a72` 入库；其第 39–52、57–75 行运行时读取 Git 状态、文件字节并对 `git show HEAD:<path>` 的 blob 计算 SHA-256。

Linux 的 `docs/review/evidence/r11-winprobe-local-linux.log:8-21` 和 openclaw 的 `docs/perf/2026-11-06-win-roundtrip-r11.txt:8-21` 均记录 captured-at、运行时 HEAD `8411a72…`、空状态、两个运行时哈希、对应 HEAD blob 哈希与两个 `true` 一致标志。两端探针均为 `f3d36748e5f95483a2ea87d4c493ed66ad53f38aca079309a7cf5e80de100d75`，接收端均为 `b56b7ecae6e206d13019f97587743bc1e90e17dda206fe7823c3c3fe4fc317cd`；本地文件 SHA-256 复核亦相同。

两份日志各第 22–40 行显示八个场景的响应和检查、`FINAL_VERDICT=PASS`，第 42 行 `exit=0`。场景 5 和 8 的 HTTP 200 中业务状态为 `failed` 是预期的拒绝，配套检查显示未泄漏；不能仅凭 HTTP 状态判定通过。

## 3. 735aa4a 范围注记 — PASS

`docs/review/2026-11-05-pr-batch-review.md:350,378-381` 更正了纯格式说法，并列明测试断言和生产代码表达式替换，同时没有声称对全部 44 个文件证明逻辑等价。对照 `git show 735aa4a`，所列行号正确：`crates/kode-mcp/tests/units.rs:60-62` 将恒真断言改为不包含 `TrainingMonster`；`crates/kode-corpus/src/encoding.rs:239,345-350` 包含 `chunks_exact`/`as_chunks` 与奇偶判断替换；`crates/kode-parser/src/config.rs:199,215,234,323` 分别包含三处 `append` 和一处 `contains` 替换。

## 4. 被测提交与证据提交关系 — PASS

`git show --stat 9ffd2e2` 与文件清单显示该提交只改 9 个 docs 下的文档和日志文件，零代码改动。`docs/review/2026-11-05-pr-batch-review.md:360,376` 明确被测提交为 `8411a72`，并区分后续证据提交。上述六份门禁和两端探针记录均指向该被测提交。

补充抽检：`git ls-files` 未发现 `r11-capture.sh`；在工作区及 `/tmp` 搜索亦未发现该文件，因此可确认它未入库，但无法核验其当时的本地实现和日志写入路径。六份日志自身均记录采集时状态为空。
