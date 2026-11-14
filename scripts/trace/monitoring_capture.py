#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FLOW-024 已验证来源采集器:CPython sys.monitoring(PEP 669,3.12+)。

用法:
    python3 scripts/trace/monitoring_capture.py --out session.json --max-events 100000 workload.py

窗口 = 目标模块 main() 全程(装载模块本身不采集)。事件面(2026-11-14 本机
3.14.4 实测,见 FLOW-022 报告附录):
  - PY_START/PY_RETURN/PY_UNWIND → call/return(UNWIND=异常驱动返回,记注);
  - RAISE/EXCEPTION_HANDLED → 异常位置与传播(实测 setprofile 在 3.14 对
    Python 帧**不发** exception 事件,sys.monitoring 才是异常位置的真实来源);
  - 帧=code 对象:file/co_firstlineno(def 声明行,1 基,稳定跳源码锚)/
    co_name;类名取 co_qualname 的限定前缀(推不出=null);file 换采集
    cwd 基准(cwd 下=相对路径,工件可移植)。

诚实边界:实体身份在纯 Python 负载里观察不到=恒 null;offset→行经 co_lines;
异常按 exception 对象 id 归组,首 RAISE 为位置,propagated=跨帧展开后捕获。
目标引擎为 3.7.3 时无 sys.monitoring(该面 3.12+),采集走 settrace/setprofile
混合属 FLOW-025 决策,本脚本不冒充可用。

有界:max-events 打满即停并把溢出记 drops(buffer-full)。输出 JSON 即
trace 协议(traceEventModel)导入面的输入形态。本脚本是最小采集面;受控开关
/开始结束丢弃计数的完整产品入口是 FLOW-025。
"""

import argparse
import importlib.util
import json
import os
import sys
import threading
import time
from sys import monitoring


def load_module(path):
    spec = importlib.util.spec_from_file_location("trace_workload", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalize_path(path):
    """帧文件路径统一采集 cwd 基准:cwd 下=相对路径(工件可移植),
    cwd 外=绝对路径。不猜、不改名,只换表达。"""
    try:
        if os.path.commonpath([os.getcwd(), os.path.abspath(path)]) == os.getcwd():
            return os.path.relpath(os.path.abspath(path), os.getcwd())
    except ValueError:
        pass
    return os.path.abspath(path)


def qualname_class(code):
    qual = getattr(code, "co_qualname", None)
    if not qual or "." not in qual:
        return None
    head, _, tail = qual.rpartition(".")
    if head.endswith(".<locals>") or head == "":
        return None
    return head


def line_at(code, offset):
    for start, end, lineno in code.co_lines():
        if start <= offset < end:
            return lineno
    return code.co_firstlineno


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-events", type=int, default=100000)
    parser.add_argument("workload")
    args = parser.parse_args()

    # 工具位 0=默认保留,1..5 先到先得(0-5 都合法;探针期用 6 撞上限)。
    tool_id = None
    for candidate in (5, 4, 3, 2, 1):
        try:
            monitoring.use_tool_id(candidate, "kode-trace")
            tool_id = candidate
            break
        except ValueError:
            continue
    if tool_id is None:
        sys.exit("no free sys.monitoring tool id (0-5 all taken)")

    started_epoch_ms = int(time.time() * 1000)
    t0 = time.monotonic_ns()
    events = []
    drops = []
    call_stack = []  # [seq, ...] 仅 Python call(同线程;负载单线程)
    open_exc = None  # 展开中的异常:{'event', 'crossed_frames': int, 'ident': id}
    overflowed = 0

    def now_ms():
        return (time.monotonic_ns() - t0) / 1e6

    def full():
        return len(events) >= args.max_events

    def on_start(code, offset):
        nonlocal open_exc, overflowed
        if full():
            overflowed += 1
            return
        if open_exc is not None and call_stack:
            open_exc["event"]["propagated"] = open_exc["crossed_frames"] > 0
            open_exc = None
        seq = len(events)
        events.append({
            "kind": "call",
            "timestamp": now_ms(),
            "processId": "py-1",
            "threadId": threading.current_thread().name,
            "entityId": None,
            "frame": {
                "file": normalize_path(code.co_filename),
                "line": code.co_firstlineno,
                "function": code.co_name,
                "className": qualname_class(code),
            },
            "parentSeq": call_stack[-1] if call_stack else None,
        })
        call_stack.append(seq)

    def on_return(code, offset, retval, unwound):
        nonlocal overflowed
        if call_stack:
            call_stack.pop()
        if full():
            overflowed += 1
            return
        if unwound and open_exc is not None:
            open_exc["crossed_frames"] += 1
        events.append({
            "kind": "return",
            "timestamp": now_ms(),
            "processId": "py-1",
            "threadId": threading.current_thread().name,
            "entityId": None,
            "unwound": bool(unwound),
        })

    def py_return(code, offset, retval):
        on_return(code, offset, retval, False)

    def py_unwind(code, offset, exc):
        on_return(code, offset, exc, True)

    def on_raise(code, offset, exc):
        nonlocal open_exc, overflowed
        if open_exc is None:
            if full():
                overflowed += 1
                return
            event = {
                "kind": "exception",
                "timestamp": now_ms(),
                "processId": "py-1",
                "threadId": threading.current_thread().name,
                "entityId": None,
                "atSeq": call_stack[-1] if call_stack else None,
                "exceptionType": type(exc).__name__ if exc is not None else None,
                "message": str(exc) if exc is not None else None,
                "propagated": None,
            }
            events.append(event)
            open_exc = {"event": event, "crossed_frames": 0, "ident": id(exc)}

    def on_handled(code, offset, exc):
        nonlocal open_exc
        if open_exc is not None:
            open_exc["event"]["propagated"] = open_exc["crossed_frames"] > 0
            open_exc = None

    ev = monitoring.events
    monitoring.register_callback(tool_id, ev.PY_START, on_start)
    monitoring.register_callback(tool_id, ev.PY_RETURN, py_return)
    monitoring.register_callback(tool_id, ev.PY_UNWIND, py_unwind)
    monitoring.register_callback(tool_id, ev.RAISE, on_raise)
    monitoring.register_callback(tool_id, ev.EXCEPTION_HANDLED, on_handled)

    module = load_module(args.workload)
    monitoring.set_events(tool_id, ev.PY_START | ev.PY_RETURN | ev.PY_UNWIND | ev.RAISE | ev.EXCEPTION_HANDLED)
    try:
        module.main()
    finally:
        monitoring.set_events(tool_id, 0)
        for name in ("PY_START", "PY_RETURN", "PY_UNWIND", "RAISE", "EXCEPTION_HANDLED"):
            monitoring.register_callback(tool_id, getattr(ev, name), None)
        monitoring.free_tool_id(tool_id)
        if open_exc is not None:
            open_exc["event"]["propagated"] = open_exc["crossed_frames"] > 0

    if overflowed:
        drops.append({
            "timestamp": now_ms(),
            "processId": None,
            "reason": "buffer-full",
            "count": overflowed,
            "note": "max-events=%d 打满(FLOW-025 有界缓冲口径)" % args.max_events,
        })

    payload = {
        "meta": {
            "collector": "sys-monitoring",
            "monitoringToolId": tool_id,
            "pythonVersion": sys.version.split()[0],
            "interpreter": sys.executable,
            "windowNote": "workload main() 全程(装载不采集;sys.monitoring PY_START/PY_RETURN/PY_UNWIND/RAISE/EXCEPTION_HANDLED)",
            "clock": "process-mono",
            "startedAtEpochMs": started_epoch_ms,
        },
        "processes": [{
            "processId": "py-1",
            "role": "unknown",
            "name": sys.argv[0],
            "enginePythonVersion": None,
        }],
        "threads": [{
            "threadId": "MainThread",
            "processId": "py-1",
            "name": "MainThread",
        }],
        "events": events,
        "drops": drops,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    sys.stderr.write(
        "captured %d events (%d calls, %d returns, %d exceptions), drops %d\n"
        % (
            len(events),
            sum(1 for e in events if e["kind"] == "call"),
            sum(1 for e in events if e["kind"] == "return"),
            sum(1 for e in events if e["kind"] == "exception"),
            len(drops),
        )
    )


if __name__ == "__main__":
    main()
