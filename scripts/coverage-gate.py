#!/usr/bin/env python3
"""Rust 覆盖率两档门禁(CI rust-coverage job 消费)。

口径:lcov DA 行计数(cargo-llvm-cov --lcov,已按其 ignore 规则排除
tests/examples/benches 与 *_tests.rs)。分 crate 聚合:

- 第一档(硬门):核心 crate kode-server / kode-kbengine / kode-python
  行覆盖各 ≥ 98.0%,任一低于即退出码 1(job 红)。
- 第二档(底线不动):全仓合计只报数不设门——不新增全仓 fail-under,
  维持既有上传口径(任务书 2026-11-19 原文「全仓底线不动」)。

用法:coverage-gate.py <lcov.info 路径> [核心 crate 名 ...]
"""

import sys
from collections import defaultdict

# 核心 crate 清单(第一档);可用 argv 覆盖,便于本地定向验证。
CORE_CRATES = ["kode-server", "kode-kbengine", "kode-python"]
CORE_MIN_LINES = 98.0


def parse_lcov(path):
    """按 SF 记录聚合 DA 行命中;返回 {crate: (hit, total)} 与全仓合计。"""
    per = defaultdict(lambda: [0, 0])
    cur = None
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("SF:"):
                path_str = line[3:].strip()
                parts = path_str.split("/crates/")
                # /crates/<crate>/src/... → crate;仓库根文件归 "(root)"。
                cur = parts[1].split("/")[0] if len(parts) > 1 else "(root)"
            elif line.startswith("DA:") and cur is not None:
                count = int(line[3:].split(",")[1])
                per[cur][1] += 1
                if count > 0:
                    per[cur][0] += 1
    return per


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    lcov_path = sys.argv[1]
    core = sys.argv[2:] or CORE_CRATES

    per = parse_lcov(lcov_path)
    total_hit = sum(h for h, _ in per.values())
    total_lines = sum(t for _, t in per.values())

    print(f"{'crate':<28}{'lines':>10}{'miss':>8}{'cover':>9}")
    for crate in sorted(per):
        hit, total = per[crate]
        if total == 0:
            continue
        print(f"{crate:<28}{total:>10}{total - hit:>8}{100.0 * hit / total:>8.2f}%")
    if total_lines == 0:
        print("coverage gate: no DA lines found in lcov — malformed input?", file=sys.stderr)
        return 2
    print(
        f"{'(workspace)':<28}{total_lines:>10}{total_lines - total_hit:>8}"
        f"{100.0 * total_hit / total_lines:>8.2f}%  (第二档:只报数,不设门)"
    )

    failed = []
    for crate in core:
        if crate not in per:
            print(f"coverage gate: core crate {crate} missing from lcov", file=sys.stderr)
            failed.append(crate)
            continue
        hit, total = per[crate]
        pct = 100.0 * hit / total
        if pct < CORE_MIN_LINES:
            print(
                f"coverage gate: {crate} lines {pct:.2f}% < {CORE_MIN_LINES}%"
                f" ({hit}/{total})",
                file=sys.stderr,
            )
            failed.append(crate)

    if failed:
        return 1
    print(f"coverage gate: core crates {', '.join(core)} all >= {CORE_MIN_LINES}% lines — OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
