#!/usr/bin/env python3
"""kbe-api-scan.py — KB-001 bucket ③: KBEngine script API usage scanner.

Scans KBEngine script trees (Python) and counts API usage:

  1. ``KBEngine.<attr>`` module-function accesses (AST, not regex);
  2. calls to ``self.<method>`` / ``<entity>.<method>`` where ``<method>`` is a
     member of the kode API-docs library (``--library``, default: the C-21
     embedded JSON in this repo) — classified per domain;
  3. lifecycle callback definitions (``def onXxx(...)`` in entity classes).

Output: JSON (``--json PATH``) plus a deterministic Markdown report on stdout.
Stdlib only; deterministic ordering everywhere (sorted keys, sorted files).

Usage:
    python3 scripts/kbe-api-scan.py tests/fixtures/kbengine-demo-assets \
        templates/demo-game --json docs/knowledge/api-usage-stats.json
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from collections import Counter
from pathlib import Path

# 回调分类:名字取自本仓库已 grounding 的知识页(engine-called 才入组;
# entry-script-spi-methods.md / api-core-concepts.md / 机制文),其余
# def onXxx(...) 一律归 project-defined(项目自定义 handler,引擎不调用)。
CALLBACK_GROUPS = {
    "entity lifecycle": [
        "onCreate", "onDestroy", "onGetCell", "onLoseCell", "onRestore",
        "onTeleport", "onTeleportSuccess", "onTeleportFailure",
        "onEnterSpace", "onLeaveSpace", "onEnterWorld", "onLeaveWorld",
        "onEnteredCell", "onEnteringCell", "onLeavingCell", "onLeftCell",
    ],
    "client/proxy lifecycle": [
        "onClientEnabled", "onClientDeath", "onLogOnAttempt",
    ],
    "timer/trigger": ["onTimer", "onTrap"],
    "db/archive": ["onWriteToDB", "onPreArchive"],
    "global/space data": [
        "onGlobalData", "onGlobalDataDel", "onBaseAppData", "onBaseAppDataDel",
        "onCellAppData", "onCellAppDataDel", "onSpaceData",
    ],
    "entry script SPI": [
        "onInit", "onFini", "onFinish", "onStart", "onTick",
        "onReadyForLogin", "onReadyForShutDown", "onShutdownBegin",
        "onShutdownEnd", "onTargetChanged", "onAutoLoadEntityCreate",
        "onAllSpaceGeometryLoaded", "onSpaceGeometryLoaded",
        "onBaseAppReady", "onBaseAppShutDown", "onDBMgrReady",
        "onDBMgrShutDown", "onLoginAppReady", "onLoginAppShutDown",
        "onLoggerAppReady", "onLoggerAppShutDown", "onInterfaceAppReady",
        "onInterfaceAppShutDown", "onLogWrote", "onLoseLogin",
        "onLoseChargeCB", "onRequestAccountLogin", "onRequestLogin",
        "onRequestCharge", "onRequestCreateAccount", "onCreateAccountCallbackFromDB",
        "onLoginCallbackFromDB", "onSelectAccountDBInterface",
    ],
}


def load_library(path: Path) -> dict[str, list[dict]]:
    """api-docs JSON → member → [entries](域/owner 多面同名保留全部)。"""
    if not path.exists():
        raise SystemExit(f"library not found: {path}")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    members: dict[str, list[dict]] = {}
    for entry in manifest.get("entries", []):
        members.setdefault(entry["member"], []).append(entry)
    return members


def scan_file(path: Path, library: dict[str, list[dict]]) -> dict:
    """单文件扫描:AST 解析失败如实记 parseError,不中断整体。"""
    text = path.read_text(encoding="utf-8", errors="replace")
    out = {
        "kbengineModule": Counter(),   # KBEngine.<attr>
        "entityApi": Counter(),        # 库成员的 self.X / obj.X 调用(按 member)
        "entityApiDomains": Counter(), # member@domain 计数
        "callbacks": Counter(),        # def onXxx(...)
        "parseError": None,
    }
    try:
        tree = ast.parse(text, filename=str(path))
    except SyntaxError as error:
        out["parseError"] = str(error)
        return out

    class Visitor(ast.NodeVisitor):
        def visit_Attribute(self, node: ast.Attribute) -> None:
            # KBEngine.<attr>(任意上下文:调用或取值都算使用)
            if isinstance(node.value, ast.Name) and node.value.id == "KBEngine":
                out["kbengineModule"][node.attr] += 1
            # <obj>.<member> 其中 member 在库中:计一次使用。
            # self.X 为主;其他接收者也计(如 other.cellData 读取)。
            if node.attr in library:
                out["entityApi"][node.attr] += 1
                for entry in library[node.attr]:
                    out["entityApiDomains"][f'{node.attr}@{entry["domain"]}'] += 1
            self.generic_visit(node)

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            if node.name.startswith("on") and len(node.name) > 2 and node.name[2].isupper():
                out["callbacks"][node.name] += 1
            self.generic_visit(node)

        # async def 同口径。
        visit_AsyncFunctionDef = visit_FunctionDef

    Visitor().visit(tree)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("roots", nargs="+", type=Path, help="script tree roots to scan")
    parser.add_argument(
        "--library",
        type=Path,
        default=Path(__file__).resolve().parent.parent
        / "crates/kode-server/assets/api-docs.json",
        help="api-docs library JSON (default: C-21 embedded manifest)",
    )
    parser.add_argument("--json", type=Path, help="optional JSON output path")
    args = parser.parse_args()

    library = load_library(args.library)
    per_tree: dict[str, dict] = {}
    kbengine_total: Counter = Counter()
    entity_api_total: Counter = Counter()
    entity_api_domains_total: Counter = Counter()
    callbacks_total: Counter = Counter()
    parse_errors: list[str] = []
    total_files = 0

    for root in args.roots:
        files = sorted(p for p in root.rglob("*.py") if p.is_file())
        tree_stats = {
            "files": len(files),
            "kbengineModule": Counter(),
            "entityApi": Counter(),
            "entityApiDomains": Counter(),
            "callbacks": Counter(),
        }
        for path in files:
            total_files += 1
            result = scan_file(path, library)
            if result["parseError"]:
                parse_errors.append(f"{path}: {result['parseError']}")
            for key in ("kbengineModule", "entityApi", "entityApiDomains", "callbacks"):
                tree_stats[key] += result[key]
        per_tree[str(root)] = {
            "files": tree_stats["files"],
            "kbengineModule": dict(sorted(tree_stats["kbengineModule"].items())),
            "entityApi": dict(sorted(tree_stats["entityApi"].items())),
            "entityApiDomains": dict(sorted(tree_stats["entityApiDomains"].items())),
            "callbacks": dict(sorted(tree_stats["callbacks"].items())),
        }
        kbengine_total += tree_stats["kbengineModule"]
        entity_api_total += tree_stats["entityApi"]
        entity_api_domains_total += tree_stats["entityApiDomains"]
        callbacks_total += tree_stats["callbacks"]

    payload = {
        "totalFiles": total_files,
        "trees": per_tree,
        "kbengineModule": dict(sorted(kbengine_total.items())),
        "entityApi": dict(sorted(entity_api_total.items())),
        "entityApiDomains": dict(sorted(entity_api_domains_total.items())),
        "callbacks": dict(sorted(callbacks_total.items())),
        "parseErrors": parse_errors,
    }
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    # ---- Markdown 报告(stdout,确定性排序) ----
    w = sys.stdout.write
    w(f"# KBEngine API usage scan\n\nScanned {total_files} Python files across "
      f"{len(args.roots)} trees.\n\n")
    w("## `KBEngine.<function>` module usage\n\n| function | count |\n| --- | --- |\n")
    for name, count in sorted(kbengine_total.items(), key=lambda kv: (-kv[1], kv[0])):
        w(f"| `{name}` | {count} |\n")
    if not kbengine_total:
        w("| (none) | 0 |\n")

    w("\n## Entity API usage (library members)\n\n| member | count |\n| --- | --- |\n")
    for name, count in sorted(entity_api_total.items(), key=lambda kv: (-kv[1], kv[0])):
        w(f"| `{name}` | {count} |\n")
    if not entity_api_total:
        w("| (none) | 0 |\n")

    w("\n## Callbacks defined (engine-known vs project-defined)\n\n| callback | count |\n| --- | --- |\n")
    for name, count in sorted(callbacks_total.items(), key=lambda kv: (-kv[1], kv[0])):
        group = next(
            (g for g, names in CALLBACK_GROUPS.items() if name in names),
            "project-defined",
        )
        w(f"| `{name}` ({group}) | {count} |\n")
    if not callbacks_total:
        w("| (none) | 0 |\n")

    if parse_errors:
        w("\n## Parse errors\n\n")
        for line in parse_errors:
            w(f"- {line}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
