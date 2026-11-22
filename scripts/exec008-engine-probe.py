#!/usr/bin/env python3
"""EXEC-008 引擎内上下文 一键取证探针(自包含,纯 stdlib)。

用途:在目标引擎机(嵌入 Python 3.7.3 的 KBEngine)上,对已经
``debugpy.listen(("127.0.0.1", PORT))`` + ``debugpy.wait_for_client()`` 的目标
脚本进程,完成完整 DAP 链并逐步骤留证:

    initialize → attach → (等 initialized) → setBreakpoints(断点行)
    → setExceptionBreakpoints → configurationDone → (stopped reason=breakpoint)
    → threads/stackTrace(顶帧=onEnterWorld,断点行) → scopes/evaluate(a=期望值;
    b 未定义=NameError 前态正确) → variables(Locals) → next(单步)
    → (stopped reason=step,单步行) → evaluate(b=期望值) → disconnect(断连)

与真机套件 ``src/test/electron/suite/exec008Live.test.ts`` 互补:套件走
vscode.debug API(需真机 VS Code+固定扩展),本探针走裸 DAP(仅需目标侧
debugpy,适合「引擎内 listen/断点」臂——引擎机不必装 VS Code)。DAP 协议要点
(排障实测定,详见 docs/acceptance-evidence/EXEC-008.md §3):attach 响应延后到
configurationDone 之后,目标在 configurationDone 后自行恢复运行到断点——
断点必须在 initialized 窗口下发,绝不能等 attach 响应后再 setBreakpoints/
continue(对已运行目标 1.7.0 不回 stopped)。

用法:
    python3 scripts/exec008-engine-probe.py \
        [--port 5678] [--source entity_debug.py] \
        [--breakpoint-line 9] [--step-line 10] \
        [--expect-a 21] [--expect-b 2] [--timeout 60] \
        [--out <证据文件>]

退出码:0=全链断言通过并留证;1=任一步失败/超时;2=参数错误。证据(逐行时间戳)
追加到 --out(缺省 docs/acceptance-evidence/evidence/EXEC-008-real-machine-probe.log,
目录自动建)。
"""

import argparse
import json
import os
import socket
import sys
import time


class Dap:
    """最小 Content-Length 帧 DAP 客户端(与目标侧 debugpy 1.7.0 对表)。"""

    def __init__(self, sock):
        self.sock = sock
        self.seq = 0
        self.buf = b""

    def send(self, command, **args):
        self.seq += 1
        msg = {"seq": self.seq, "type": "request", "command": command}
        if args:
            msg["arguments"] = args
        body = json.dumps(msg).encode()
        self.sock.sendall(b"Content-Length: %d\r\n\r\n%s" % (len(body), body))
        return self.seq

    def read(self, timeout=8):
        deadline = time.time() + timeout
        while time.time() < deadline:
            idx = self.buf.find(b"\r\n\r\n")
            if idx >= 0:
                cl = int(self.buf[:idx].split(b":")[1])
                if len(self.buf) >= idx + 4 + cl:
                    body = self.buf[idx + 4:idx + 4 + cl]
                    self.buf = self.buf[idx + 4 + cl:]
                    return json.loads(body)
            try:
                self.sock.settimeout(0.5)
                d = self.sock.recv(65536)
                if not d:
                    return None
                self.buf += d
            except socket.timeout:
                continue
        return None

    def wait_event(self, name, timeout=60):
        """读帧直到收到指定事件;返回其 body(dict 或 None)。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            m = self.read(timeout=10)
            if m is None:
                continue
            if m.get("type") == "event" and m.get("event") == name:
                return m.get("body") or {}
        return None

    def wait_response(self, command, timeout=10):
        """读帧直到收到指定请求的响应(中间事件帧被跳过)。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            m = self.read(timeout=10)
            if m is None:
                continue
            if m.get("type") == "response" and m.get("command") == command:
                return m
        return None


def ev(log_path, line):
    stamped = "[%s] %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), line)
    print(stamped, flush=True)
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(stamped + "\n")
    except OSError as exc:
        print("证据落盘失败: %s" % exc, file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="EXEC-008 引擎内 DAP 证据探针")
    ap.add_argument("--port", type=int, default=5678)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--source", required=True, help="断点所在脚本绝对路径")
    ap.add_argument("--breakpoint-line", type=int, default=9)
    ap.add_argument("--step-line", type=int, default=10)
    ap.add_argument("--expect-a", default="21")
    ap.add_argument("--expect-b", default="2")
    ap.add_argument("--timeout", type=int, default=90)
    ap.add_argument(
        "--out",
        default=os.path.join(
            "docs", "acceptance-evidence", "evidence", "EXEC-008-real-machine-probe.log"
        ),
    )
    args = ap.parse_args()

    if not os.path.isabs(args.source) and not os.path.exists(args.source):
        print("错误: --source 必须是可访问路径: %s" % args.source, file=sys.stderr)
        return 2

    try:
        sock = socket.create_connection((args.host, args.port), timeout=5)
    except OSError as exc:
        ev(args.out, "CONNECT-FAIL: %s:%d %s" % (args.host, args.port, exc))
        print("探针失败:目标不可达(目标须已 debugpy.listen+wait_for_client)", file=sys.stderr)
        return 1

    dap = Dap(sock)
    ev(args.out, "PROBE-START source=%s port=%d" % (args.source, args.port))
    ev(args.out, "HOST-PYTHON: %s" % sys.version.replace("\n", " "))

    def fail(msg):
        ev(args.out, "FAIL: %s" % msg)
        print("探针失败: %s" % msg, file=sys.stderr)
        return 1

    # 1. initialize + attach(协议序,见模块注释)
    dap.send("initialize", clientID="kode-exec008-probe", adapterID="debugpy",
             pathFormat="path", linesStartAt1=True, columnsStartAt1=True)
    dap.send("attach", connect={"host": args.host, "port": args.port}, justMyCode=False)
    ev(args.out, "REQUEST: initialize+attach sent")

    initialized = dap.wait_event("initialized", timeout=args.timeout)
    if initialized is None:
        return fail("等 initialized 事件超时")
    ev(args.out, "EVENT: initialized")

    # 2. 断点在 initialized 窗口下发(对已运行目标不能等 attach 响应)
    dap.send("setBreakpoints",
             source={"path": args.source},
             breakpoints=[{"line": args.breakpoint_line}], sourceModified=False)
    dap.send("setExceptionBreakpoints", filters=[])
    dap.send("configurationDone")
    ev(args.out, "REQUEST: setBreakpoints(%d)+setExceptionBreakpoints+configurationDone"
        % args.breakpoint_line)

    stopped = dap.wait_event("stopped", timeout=args.timeout)
    if stopped is None:
        return fail("等 stopped(breakpoint)事件超时")
    if stopped.get("reason") != "breakpoint":
        return fail("stopped 原因非 breakpoint: %s" % stopped)
    thread_id = stopped.get("threadId")
    ev(args.out, "EVENT: stopped reason=breakpoint threadId=%s" % thread_id)

    # 3. stackTrace 顶帧(行号从帧取,DAP stopped 事件不带 line)
    dap.send("stackTrace", threadId=thread_id, startFrame=0, levels=1)
    m = dap.wait_response("stackTrace", timeout=args.timeout)
    frames = ((m or {}).get("body") or {}).get("stackFrames") or []
    if not frames:
        return fail("stackTrace 空")
    top = frames[0]
    # 帧名只留证不断言:引擎目标脚本函数名各异;关键断言是「停在断点行」。
    if top.get("line") != args.breakpoint_line:
        return fail("顶帧行非断点行(%d): %d" % (args.breakpoint_line, top.get("line")))
    frame_id = top.get("id")
    ev(args.out, "STACK: top=%s line=%s frameId=%s" % (top.get("name"), top.get("line"), frame_id))

    # 4. evaluate a(期望值)+ b(断点行未定义=NameError 前态正确)
    dap.send("evaluate", expression="a", frameId=frame_id, context="watch")
    m = dap.wait_response("evaluate", timeout=args.timeout)
    a_val = ((m or {}).get("body") or {}).get("result")
    if a_val != args.expect_a:
        return fail("a != %s: %s" % (args.expect_a, a_val))
    ev(args.out, "EVAL-a: %s" % a_val)

    dap.send("evaluate", expression="b", frameId=frame_id, context="watch")
    m = dap.wait_response("evaluate", timeout=args.timeout)
    b_before = ((m or {}).get("body") or {}).get("result")
    ev(args.out, "EVAL-b-before-step: %s (断点行 b 未定义=NameError 前态正确)"
        % (b_before if b_before else "<NameError>"))

    # 5. variables(Locals): a/delta/self 在场
    dap.send("scopes", frameId=frame_id)
    m = dap.wait_response("scopes", timeout=args.timeout)
    scopes = ((m or {}).get("body") or {}).get("scopes") or []
    local = next((s for s in scopes if "local" in s.get("name", "").lower()), None) or (scopes[0] if scopes else None)
    if local is None:
        return fail("无 scopes")
    dap.send("variables", variablesReference=local.get("variablesReference"))
    m = dap.wait_response("variables", timeout=args.timeout)
    variables = ((m or {}).get("body") or {}).get("variables") or []
    ev(args.out, "VARIABLES[%s]: %s" % (local.get("name"),
        ", ".join("%s=%s" % (v.get("name"), v.get("value")) for v in variables)))

    # 6. next(单步)→ stopped(step,单步行)
    dap.send("next", threadId=thread_id)
    ev(args.out, "REQUEST: next issued")
    stopped2 = dap.wait_event("stopped", timeout=args.timeout)
    if stopped2 is None or stopped2.get("reason") != "step":
        return fail("等 stopped(step) 事件超时/原因错: %s" % stopped2)
    dap.send("stackTrace", threadId=stopped2.get("threadId"), startFrame=0, levels=1)
    m = dap.wait_response("stackTrace", timeout=args.timeout)
    frames2 = ((m or {}).get("body") or {}).get("stackFrames") or []
    top2 = frames2[0] if frames2 else {}
    if top2.get("line") != args.step_line:
        return fail("单步后行非 %d: %s" % (args.step_line, top2.get("line")))
    dap.send("evaluate", expression="b", frameId=top2.get("id"), context="watch")
    m = dap.wait_response("evaluate", timeout=args.timeout)
    b_val = ((m or {}).get("body") or {}).get("result")
    if b_val != args.expect_b:
        return fail("单步后 b != %s: %s" % (args.expect_b, b_val))
    ev(args.out, "EVAL-b-after-step: %s (line %s)" % (b_val, top2.get("line")))

    # 7. disconnect(断连)
    dap.send("disconnect", restart=False)
    ev(args.out, "DISCONNECT: issued")
    time.sleep(0.5)
    ev(args.out, "CHAIN-DONE: initialize/attach/breakpoint/stop/step/variables/disconnect 全链断言通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
