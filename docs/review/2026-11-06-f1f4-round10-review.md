# F1–F4 第十轮复审：R9 收口验证

审查对象：`46e1bb3c17841494753d1bd22d0d508855132254`，基线 `50aef64`。仅检查指定三点及 735aa4a 格式抽检。

## 1. 暂存命名空间隔离：PASS

- `scripts/hot-reload-receiver/referenceReceiver.mjs:555-573` 在任何逐文件读写之前拒绝第一段为 `.staged` 的源路径；`613-619` 把失败返回给整批。因此同批 `X.py` 和 `.staged/X.py` 不会进入暂存复制。回归 `tests/hotReloadReceiverRoundtrip.test.ts:873-903` 同时检查两源文件原样和无产物。
- 同文件 `581-602` 对已有源的 realpath 与暂存树比较；解析失败时检查文件自身和祖先 symlink（`415-432`），整批拒绝悬空别名。回归 `tests/hotReloadReceiverRoundtrip.test.ts:936-964,972-999,1048-1070` 覆盖已有别名、批内补齐的悬空祖先别名和悬空文件链接。
- 同文件 `372-405,434-451,643-658` 在暂存写前检查最深现存祖先的包含性和相对路径一致性，拒绝目标 symlink。检查与 mkdir/copy 间仍有已记录的竞态窗口（`docs/design/hot-reload-design.md:229-237`），本结论不声称消除该窗口。

## 2. inode 比对清理：PASS

- `scripts/hot-reload-receiver/referenceReceiver.mjs:810-820` 在 `wx` 成功后通过 fd 的 fstat 捕获 dev/ino；`199-224` 清理前 lstat，身份缺失或不符时不 unlink；`233-247` 将跳过如实写入 `rollback_skipped`。
- `tests/hotReloadReceiverHelpers.test.ts:94-115` 先创建两个不同 inode，再 rename 替换，验证替换文件内容保留且返回 skipped；`135-148` 验证身份捕获缺失。此次独立运行助手文件通过（12 个测试包含该组）。lstat 到 unlink 仍有已记录的竞态窗口（`referenceReceiver.mjs:196-198`）。

## 3. 证据绑定：FAIL

- 六份收尾门禁日志如 `docs/review/evidence/r9-full-cargo.log:2`、`r9-full-fmt-clippy.log:2`、`r9-full-vitest-1.log:2` 均记录 `735aa4afca89c14658cff48dfb098060a8763d80`，不是要求的 `46e1bb3c17841494753d1bd22d0d508855132254`。日志起始时间及命令见各文件第 3–4 行。46e1bb3 只新增文档和日志，故这提供了对同一代码树的间接支持，但不是对指定 HEAD 的门禁证据。
- `docs/perf/2026-11-06-win-roundtrip-r9.txt:2-5` 声称被测 9a5c7ee，探针输出从第 7 行开始，未展示运行时 `git rev-parse HEAD`、工作树状态或被测脚本哈希的原始输出，不能验证 commit 标注确为随运行采集而非事后注释；也不能据此证明 Windows 实际执行的字节。仓库中 9a5c7ee 与 46e1bb3 的接收端脚本确实无差异，但不能替代运行时绑定。该缺口不等于证明记录被伪造。
- 最小修法：固定被测提交 46e1bb3，在干净检出上重跑门禁；运行包装器在同一原始日志中先记录 `git rev-parse HEAD`、工作树状态、命令与退出码，Windows 探针还记录所执行接收端脚本的哈希和提交号。将生成证据存入后续证据提交或外部不可变 CI artifact，并明确被测提交与证据提交的关系；不能要求一个提交内的文件自含该提交自身哈希。

## 735aa4a 格式抽检

**并非纯格式改动。** 例如 `crates/kode-mcp/tests/units.rs:60-62` 将恒真断言改为实际断言不包含 `TrainingMonster`，改变了测试行为；`crates/kode-corpus/src/encoding.rs:239,345-350`、`crates/kode-parser/src/config.rs:199,215,234` 也有 clippy 驱动的表达式替换。抽查生产代码替换语义相当，不能据此声称全 44 文件仅格式变化，也未对全部变更作完整逻辑等价证明。

## 本轮验证限制

执行 `pnpm exec vitest run tests/hotReloadReceiverHelpers.test.ts tests/hotReloadReceiverRoundtrip.test.ts`：助手文件通过；回环文件在启动监听 `127.0.0.1` 时被当前沙箱以 `EPERM` 拒绝，34 项无法执行，不能计为产品回归失败或本轮回环通过。第一项结论依代码与既有回归证据；Windows 日志的来源限制见第 3 项。未修改 `todo.md`。
