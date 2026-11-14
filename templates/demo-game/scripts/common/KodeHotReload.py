# -*- coding: utf-8 -*-
"""Demo-only loopback HTTP bridge. Engine APIs run on its descriptor callback thread."""
import ast
import hashlib
import http.server
import importlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import socket
import sys
import threading
import urllib.parse
import urllib.request

import KBEngine
from xreload import xreload

_STATE = "_kode_demo_hot_reload"
MAX_BODY = 1024 * 1024


class ReloadServer:
    def __init__(self, role, port, peer_port):
        self.role = role
        self.root = Path(__file__).resolve().parents[1]
        self.peer_port = peer_port
        self.jobs = queue.Queue(maxsize=16)
        self.lock = threading.Lock()
        self.revision = 0
        self.reload_callbacks = 0
        self.last = []
        self.reader, self.writer = socket.socketpair()
        self.reader.setblocking(False)
        self.writer.setblocking(False)
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(5)

            def log_message(self, *_args):
                pass

            def reply(self, status, payload):
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self):
                if urllib.parse.urlsplit(self.path).path not in ("/hotfix", "/reload", "/status"):
                    return self.reply(404, {"error": "not found"})
                with owner.lock:
                    payload = {"role": owner.role, "pid": os.getpid(),
                               "revision": owner.revision, "receipts": list(owner.last)}
                self.reply(200, payload)

            def do_POST(self):
                if urllib.parse.urlsplit(self.path).path not in ("/hotfix", "/reload"):
                    return self.reply(404, {"error": "not found"})
                try:
                    self.connection.settimeout(5)
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= MAX_BODY or self.headers.get("Transfer-Encoding"):
                        raise ValueError("Content-Length must be between 1 and 1048576")
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise ValueError("incomplete request")
                    if "application/json" in self.headers.get("Content-Type", "") or raw.lstrip().startswith(b"{"):
                        payload = json.loads(raw)
                    else:
                        form = urllib.parse.parse_qs(raw.decode("utf-8"))
                        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                        payload = {"module_name": (form.get("module_name") or query.get("module_name") or [""])[0]}
                    if not isinstance(payload, dict):
                        raise ValueError("request must be an object")
                    receipts = owner.dispatch(payload)
                    self.reply(200, receipts)
                except (ValueError, TypeError, OSError, json.JSONDecodeError) as error:
                    self.reply(400, {"error": str(error)})

        class HTTPServer(http.server.ThreadingHTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        try:
            self.http = HTTPServer(("127.0.0.1", port), Handler)
            KBEngine.registerReadFileDescriptor(self.reader.fileno(), self.drain)
        except Exception:
            if hasattr(self, "http"):
                self.http.server_close()
            self.reader.close()
            self.writer.close()
            raise
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        print("[kode-hot-reload] %s listening http://127.0.0.1:%s/hotfix pid=%s" %
              (role, self.http.server_port, os.getpid()), flush=True)

    def stop(self):
        self.http.shutdown()
        self.http.server_close()
        KBEngine.deregisterReadFileDescriptor(self.reader.fileno())
        self.reader.close()
        self.writer.close()

    def local_request(self, payload):
        job = {"payload": payload, "event": threading.Event(), "cancelled": False, "started": False}
        try:
            self.jobs.put_nowait(job)
            try:
                self.writer.send(b"x")
            except BlockingIOError:
                pass  # An unread wake byte already exists.
        except queue.Full:
            return self.failed(payload, "engine reload queue is full")
        if not job["event"].wait(8):
            with self.lock:
                job["cancelled"] = not job["started"]
            return self.failed(payload, "engine response timed out; inspect /status before retrying")
        return job["result"]

    @staticmethod
    def failed(payload, reason):
        return [{"status": "failed", "file": f, "reason": reason,
                 **({"targetId": payload["targetId"]} if "targetId" in payload else {})}
                for f in payload.get("files", [])]

    def dispatch(self, payload):
        files = payload.get("files")
        if files is None:
            name = payload.get("module_name", "")
            if not isinstance(name, str) or not name or not all(p.isidentifier() for p in name.split(".")):
                raise ValueError("files or a valid module_name is required")
            # Compatibility for old single-module requests; JSON files are preferred.
            relative = Path(*name.split(".")).with_suffix(".py")
            matches = [self.root / section / relative for section in (self.role, "common", "user_type", "cell")]
            files = [str(next((p for p in matches if p.is_file()), self.root / self.role / relative))]
            payload = dict(payload, files=files)
        if not isinstance(files, list) or not files or len(files) > 64 or not all(isinstance(f, str) for f in files):
            raise ValueError("files must contain 1..64 paths")
        if "targetId" in payload and not isinstance(payload["targetId"], str):
            raise ValueError("targetId must be a string")
        if not isinstance(payload.get("sender_digests", {}), dict):
            raise ValueError("sender_digests must be an object")
        receipts = []
        local, remote = [], []
        for file in files:
            try:
                relative = Path(file).resolve().relative_to(self.root)
                section = relative.parts[0]
                if section not in ("base", "cell", "common", "user_type"):
                    raise ValueError("only base/cell/common/user_type Python scripts support demo hot reload")
                if Path(file).suffix != ".py" or Path(file).name in ("KodeHotReload.py", "xreload.py"):
                    raise ValueError("this file requires restart")
                (remote if self.role == "base" and section == "cell" else local).append(file)
                if self.role == "base" and section in ("common", "user_type"):
                    remote.append(file)
                if self.role == "cell" and section == "base":
                    raise ValueError("base script sent to cell endpoint")
            except ValueError as error:
                receipts.extend(self.failed(dict(payload, files=[file]), str(error)))
        # Validate routing before any execution.
        if receipts:
            return self.failed(payload, "batch rejected: " + receipts[0]["reason"])
        local_results = self.local_request(dict(payload, files=local)) if local else []
        remote_results = []
        if remote:
            try:
                request = urllib.request.Request(
                    "http://127.0.0.1:%s/hotfix" % self.peer_port,
                    data=json.dumps(dict(payload, files=remote)).encode(),
                    headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(request, timeout=10) as response:
                    remote_results = json.load(response)
                if not isinstance(remote_results, list):
                    raise ValueError("invalid cell receipt")
            except Exception as error:
                remote_results = self.failed(dict(payload, files=remote), "cell endpoint: " + str(error))
        for file in files:
            parts = [r for r in local_results + remote_results if r.get("file") == file]
            failure = next((r for r in parts if r.get("status") == "failed"), None)
            if failure:
                receipts.append(failure)
            elif parts and all(r.get("status") == "applied" for r in parts):
                receipts.append(dict(parts[0], revision=max(r["revision"] for r in parts),
                                     processes=[r["process"] for r in parts]))
            else:
                receipts.append(dict(parts[0], status="accepted") if parts else self.failed(dict(payload, files=[file]), "missing engine receipt")[0])
        with self.lock:
            self.last = receipts
        return receipts

    def drain(self, _fd):
        try:
            while self.reader.recv(4096):
                pass
        except BlockingIOError:
            pass
        # Bound each engine tick; leave the next wake byte for a following callback.
        if self.jobs.empty():
            return
        job = self.jobs.get_nowait()
        with self.lock:
            if job["cancelled"]:
                if not self.jobs.empty():
                    self.writer.send(b"x")
                return
            job["started"] = True
        try:
            job["result"] = self.apply(job["payload"])
        except Exception as error:
            job["result"] = self.failed(job["payload"], str(error))
        with self.lock:
            self.last = job["result"]
        job["event"].set()
        if not self.jobs.empty():
            self.writer.send(b"x")

    def refresh_imports(self, changed, previous):
        # xreload intentionally does not reload dependencies. Refresh direct from-import
        # bindings for constants without rerunning entity modules or resetting game state.
        for consumer in list(sys.modules.values()):
            filename = getattr(consumer, "__file__", None)
            if not filename or consumer is changed:
                continue
            try:
                path = Path(filename).resolve()
                path.relative_to(self.root)
                if path.suffix != ".py":
                    continue
                tree = ast.parse(path.read_bytes(), filename=str(path))
            except (ValueError, OSError, SyntaxError):
                continue
            for node in tree.body:
                if not isinstance(node, ast.ImportFrom):
                    continue
                name = node.module or ""
                if node.level:
                    try:
                        name = importlib.util.resolve_name("." * node.level + name, consumer.__package__)
                    except (ImportError, ValueError):
                        continue
                if name != changed.__name__:
                    continue
                for alias in node.names:
                    names = (getattr(changed, "__all__", [n for n in previous if not n.startswith("_")])
                             if alias.name == "*" else [alias.name])
                    for exported in names:
                        local = alias.asname or exported
                        if exported in previous and consumer.__dict__.get(local) is previous[exported]:
                            if exported in changed.__dict__:
                                consumer.__dict__[local] = changed.__dict__[exported]


    def apply(self, payload, method="xreload", full_reload=False):
        prepared = []
        # No mutations until the whole local batch passes syntax and fingerprint checks.
        for file in payload["files"]:
            path = Path(file).resolve()
            relative = path.relative_to(self.root)
            if relative.parts[0] not in (self.role, "common", "user_type") or path.suffix != ".py":
                raise ValueError("file does not belong to this process: " + file)
            if path.name in ("KodeHotReload.py", "xreload.py", "kbemain.py"):
                raise ValueError("reload infrastructure/entry changes require restart")
            raw = path.read_bytes()
            digest = hashlib.sha256(raw).hexdigest()
            expected = payload.get("sender_digests", {}).get(file)
            if expected is not None and expected != digest:
                raise ValueError("sender digest mismatch: " + file)
            code = compile(raw, str(path), "exec", dont_inherit=True)
            if path.name == "kbemain.py":
                raise ValueError("entry script changes require restart")
            matches = [m for m in list(sys.modules.values()) if getattr(m, "__file__", None)
                       and Path(m.__file__).resolve() == path]
            if not matches:
                raise ValueError("module is not loaded in this engine process: " + file)
            # Avoid timestamp/size pyc reuse on rapid same-size saves.
            cache = Path(importlib.util.cache_from_source(str(path)))
            if cache.exists():
                cache.unlink()
            prepared.append((file, path, raw, digest, code, matches))
        importlib.invalidate_caches()
        for _file, _path, _raw, _digest, _code, modules in prepared:
            for module in modules:
                # Patch existing functions/classes so live entities and bound methods update.
                exports = dict(module.__dict__)
                if method == "xreload":
                    xreload(module, source=_raw)
                    self.refresh_imports(module, exports)
                elif _path.relative_to(self.root).parts[0] in ("common", "user_type"):
                    importlib.reload(module)
        if method == "kbengine-official":
            before = self.reload_callbacks
            KBEngine.reloadScript(bool(full_reload))
            if self.reload_callbacks <= before:
                raise RuntimeError("reloadScript returned without onInit(True) confirmation")
        for _file, path, raw, _digest, _code, _modules in prepared:
            if path.read_bytes() != raw:
                raise RuntimeError("source changed during reload; result unverified: " + str(path))
        self.revision += 1
        result = [{"status": "applied", "file": file, "digest": digest,
                   "revision": self.revision, "process": self.role, "method": method,
                   **({"targetId": payload["targetId"]} if "targetId" in payload else {})}
                  for file, _path, _raw, digest, _code, _modules in prepared]
        print("[kode-hot-reload] applied role=%s revision=%s files=%s" %
              (self.role, self.revision, payload["files"]), flush=True)
        return result


# --- Idle-baseapp GIL heartbeat -------------------------------------------
# The engine C++ main loop holds the GIL while parked in epoll_wait (kbe/src
# has no Py_BEGIN_ALLOW_THREADS release point), so on an idle app our HTTP
# daemon threads never run. An entity timer keeps the main loop executing
# Python bytecode; the tiny sleep inside hands the GIL to those threads.
HEARTBEAT_INTERVAL = 0.2
HEARTBEAT_WINDOW = 0.01
HEARTBEAT_TIMER_ARG = 0x4B48  # "KH": no demo game timer uses this user arg
_HEARTBEAT_STATE = "_kode_demo_hot_reload_heartbeat"
_HEARTBEAT_TICKS = "_kode_demo_hot_reload_heartbeat_ticks"


def ensure_heartbeat(entity):
    """Register the receiver heartbeat on a long-lived entity (Spaces)."""
    if getattr(KBEngine, _HEARTBEAT_STATE, None):
        return
    timer_id = int(entity.addTimer(HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL, HEARTBEAT_TIMER_ARG))
    setattr(KBEngine, _HEARTBEAT_STATE, (entity, timer_id))
    return timer_id


def on_entity_timer(entity, timer_id, user_arg):
    """Spaces.onTimer delegate; returns True when this tick was ours."""
    if user_arg != HEARTBEAT_TIMER_ARG:
        return False
    state = getattr(KBEngine, _HEARTBEAT_STATE, None)
    if not state or state[0] is not entity:
        return False
    import os
    import time
    ticks = getattr(KBEngine, _HEARTBEAT_TICKS, 0) + 1
    setattr(KBEngine, _HEARTBEAT_TICKS, ticks)
    if ticks == 1 or ticks % 300 == 0:
        # First tick and every ~60s: prove the wakeup loop stays alive.
        path = os.environ.get("KBE_DEMO_EVIDENCE")
        if path:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write("[demo-evidence] hot-reload heartbeat tick %i (main loop GIL window)\n" % ticks)
    time.sleep(HEARTBEAT_WINDOW)
    return True


def stop_heartbeat(entity):
    """Drop the heartbeat registration when its host entity is destroyed."""
    state = getattr(KBEngine, _HEARTBEAT_STATE, None)
    if state and state[0] is entity:
        entity.delTimer(state[1])
        delattr(KBEngine, _HEARTBEAT_STATE)


def start(role, is_reload=False):
    server = getattr(KBEngine, _STATE, None)
    if server is not None:
        if is_reload:
            server.reload_callbacks += 1
        return server
    # State lives on KBEngine, so reloading script modules cannot lose the listener.
    base_port = int(os.environ.get("KODE_HOT_RELOAD_BASE_PORT", "8090"))
    cell_port = int(os.environ.get("KODE_HOT_RELOAD_CELL_PORT", "8091"))
    server = ReloadServer(role, base_port if role == "base" else cell_port, cell_port)
    setattr(KBEngine, _STATE, server)
    return server


def stop():
    server = getattr(KBEngine, _STATE, None)
    if server is not None:
        server.stop()
        delattr(KBEngine, _STATE)


def official_reload(payload, full_reload=True):
    """Called by the engine Python console, already on the engine main thread."""
    server = getattr(KBEngine, _STATE, None)
    if server is None:
        raise RuntimeError("demo reload observer is not initialized")
    try:
        receipts = server.apply(payload, "kbengine-official", full_reload)
    except Exception as error:
        receipts = server.failed(payload, str(error))
    with server.lock:
        server.last = receipts
    return receipts
