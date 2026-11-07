#!/usr/bin/env python3
"""kode 配置开关效果动图流水线（todo C-24，移植 oddsmaker/wingman 的 config-switch-gifs 模式）。

对每个开关：Xvfb 内起真实 VS Code（装 kode 扩展）+ KBEngine demo 资产工作区，
按 off/on 两态写工作区 .vscode/settings.json 后分别重启扩展宿主，摆出该开关
效果可见的界面姿态（打开文件/悬停/命令面板），抓取真实窗口截图，ffmpeg 缝合
off→on 动态 GIF。每张演示真实界面差异，不是假图；无头跑不通的项在 switches.json
里 capture:false，文档页留手动清单。

非破坏性：截图目标工作区在 /tmp 临时目录，仓库只产出 docs/public/config-switch-gifs/
下的 png/gif 与 manifest，不触碰工作区文件。

用法:
    python3 scripts/config-switch-gifs/generate.py --list
    python3 scripts/config-switch-gifs/generate.py --all
    python3 scripts/config-switch-gifs/generate.py --switch hover-show-tag-docs

前置: xvfb / xdotool / ImageMagick(import) / ffmpeg / VS Code(code CLI)，
扩展 vsix 由 --vsix 指定（缺省先在 /tmp/kode-gif 从 HEAD 干净构建，见 README）。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SWITCHES = ROOT / "scripts/config-switch-gifs/switches.json"
OUTPUT = ROOT / "docs/public/config-switch-gifs"
DEMO_ASSETS = ROOT / "tests/fixtures/kbengine-demo-assets"
CAP = Path("/tmp/kode-gif-capture")          # 截图工作区/帧目录（可 --keep 保留）
VSCODE_USER = CAP / "vscode-profile"
VSCODE_EXT = CAP / "vscode-ext"
DISPLAY = ":99"
SCREEN = "1600x1000x24"
GIF_DELAY_MS = 700

# 悬停坐标（1600x1000、editor.fontSize 18、隐藏 minimap、默认 Dark+ 校准值）：
# hover 目标 token 放在演示文件固定行列，像素位 = 常量，换主题/字号需重新校准
HOVER_XY = {
    # HoverDemo.def: <Flags> 标签 / BASE_AND_CLIENT 取值
    "tag": (660, 250),
    "value": (760, 250),
    # Monster.def: CellMethods 里的 onAggro 方法名
    "method": (700, 340),
}

USER_SETTINGS = {                      # application-scoped：写工作区会触发 VS Code 报错 toast，
    "update.mode": "none",             # 必须落到 user profile settings.json
    "extensions.autoUpdate": False,
    "extensions.autoCheckUpdates": False,
    "extensions.ignoreRecommendations": True,
    "security.workspace.trust.enabled": False,
    "telemetry.telemetryLevel": "off",
    "workbench.startupEditor": "none",
}

BASE_SETTINGS = {                      # window-scoped：可安全落工作区
    "workbench.editor.enablePreview": False,
    "editor.fontSize": 18,
    "editor.minimap.enabled": False,
    "editor.renderWhitespace": "none",
    "problems.autoReveal": False,
    "window.commandCenter": False,
    "kode.python.stubExport": False,   # 防止截图期间后台写 .pyi 产生通知
}


def sh(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def load_switches():
    return json.loads(SWITCHES.read_text())


def find_switch(key):
    for s in load_switches():
        if s["key"] == key:
            return s
    raise SystemExit(f"unknown switch: {key}")


# ---------------------------------------------------------------- Xvfb / VS Code
def ensure_xvfb():
    subprocess.run(["pgrep", "-f", f"Xvfb {DISPLAY}"], capture_output=True)
    if subprocess.run(["pgrep", "-f", f"Xvfb {DISPLAY}"], capture_output=True).returncode == 0:
        return
    subprocess.Popen(
        ["Xvfb", DISPLAY, "-screen", "0", SCREEN, "-nolisten", "tcp"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        if Path(f"/tmp/.X11-unix/X{DISPLAY[1:]}").exists():
            return
        time.sleep(0.2)
    raise SystemExit("Xvfb failed to start")


def env():
    e = dict(os.environ)
    e["DISPLAY"] = DISPLAY
    return e


def install_vsix(vsix):
    VSCODE_EXT.mkdir(parents=True, exist_ok=True)
    VSCODE_USER.mkdir(parents=True, exist_ok=True)
    done = VSCODE_EXT / ".vsix-installed"
    if done.exists() and done.read_text().strip() == str(vsix):
        return
    sh(["code", "--user-data-dir", str(VSCODE_USER), "--extensions-dir", str(VSCODE_EXT),
        "--install-extension", str(vsix)], env=env())
    done.write_text(str(vsix))


def kill_code():
    subprocess.run(["pkill", "-f", str(VSCODE_USER)], capture_output=True)
    deadline = time.time() + 10
    while time.time() < deadline:
        if subprocess.run(["pgrep", "-f", str(VSCODE_USER)], capture_output=True).returncode != 0:
            return
        time.sleep(0.3)
    subprocess.run(["pkill", "-9", "-f", str(VSCODE_USER)], capture_output=True)
    time.sleep(1)


def code_window():
    out = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", "Visual Studio Code"],
                         capture_output=True, text=True, env=env())
    ids = []
    for i in out.stdout.split():
        if not i.strip():
            continue
        try:
            geo = subprocess.run(["xdotool", "getwindowgeometry", i],
                                 capture_output=True, text=True, env=env()).stdout
            # 形如 "  Geometry: 1600x847"
            dims = geo.split("Geometry:")[1].split()[0] if "Geometry:" in geo else "0x0"
            w, h = (int(v) for v in dims.split("x"))
            if w > 600 and h > 400:
                ids.append((w * h, int(i)))
        except (ValueError, IndexError):
            continue
    return max(ids)[1] if ids else None


def launch_code(ws, open_path=None):
    kill_code()
    args = ["code", "--user-data-dir", str(VSCODE_USER), "--extensions-dir", str(VSCODE_EXT),
            "--disable-gpu", "--new-window", str(ws)]
    if open_path:
        args += ["--goto", str(open_path)]
    subprocess.Popen(args, env=env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):                      # 最多 30s 等窗口
        win = code_window()
        if win:
            subprocess.run(["xdotool", "windowactivate", "--sync", str(win)],
                           capture_output=True, env=env())
            return win
        time.sleep(0.3)
    raise SystemExit("VS Code window did not appear")


def key(*keys, delay=80):
    for k in keys:
        subprocess.run(["xdotool", "key", "--delay", str(delay), k],
                       capture_output=True, env=env())
        time.sleep(0.15)


def mouse(x, y):
    subprocess.run(["xdotool", "mousemove", str(x), str(y)], capture_output=True, env=env())


def screenshot(path, win, editor_region=True):
    """截窗；软件渲染下内容可能晚画，先等「编辑器区域」非空白（像素标准差阈值）。
    editor_region=True 时裁掉左侧活动栏/资源管理器（约 x>380），只看编辑器；
    False 保留整窗（状态栏/面板类效果需要）。"""
    deadline = time.time() + 40
    probe = str(path) + ".probe.png"
    check = str(path) + ".check.png"
    while time.time() < deadline:
        sh(["import", "-window", str(win), probe], env=env())
        if editor_region:
            sh(["convert", probe, "-crop", "890x790+389+5", "+repage", check])
        else:
            shutil.copy(probe, check)
        out = sh(["identify", "-format", "%[fx:standard_deviation]", check])
        if float(out.stdout.strip() or "0") > 0.02:
            shutil.move(probe, path)
            Path(check).unlink(missing_ok=True)
            return path
        time.sleep(1.5)
    shutil.move(probe, path)              # 超时也落盘，便于人工排查
    Path(check).unlink(missing_ok=True)
    return path


def command_palette(title_substr, enter=True):
    """Ctrl+Shift+P 输入命令并回车（取第一个匹配项）。"""
    key("ctrl+shift+p")
    time.sleep(0.8)
    subprocess.run(["xdotool", "type", "--delay", "70", title_substr],
                   capture_output=True, env=env())
    time.sleep(1.0)
    if enter:
        key("Return")


# ---------------------------------------------------------------- 工作区
def write_settings(ws, extra):
    settings_dir = ws / ".vscode"
    settings_dir.mkdir(exist_ok=True)
    merged = dict(BASE_SETTINGS)
    merged.update(extra)
    (settings_dir / "settings.json").write_text(json.dumps(merged, indent=2))


def write_user_settings():
    """application-scoped 基线设置落到 user profile，避免工作区写入报错 toast。"""
    user_dir = VSCODE_USER / "User"
    user_dir.mkdir(parents=True, exist_ok=True)
    (user_dir / "settings.json").write_text(json.dumps(USER_SETTINGS, indent=2))


def stage_workspace(name, extra_files=None):
    """从 demo 资产树复制一份干净工作区（/tmp，非破坏性）。
    资产树内容直接落在工作区根（res/server/kbengine.xml + scripts/ 必须在根，
    否则扩展识别不了 KBEngine 资产、不激活）。"""
    ws = CAP / name
    if ws.exists():
        shutil.rmtree(ws)
    shutil.copytree(DEMO_ASSETS, ws, ignore=shutil.ignore_patterns("*.pyc"))
    # 诊断演示文件（刻意带错误，仓库 fixture 保持干净）
    defs = ws / "scripts/entity_defs"
    (defs / "Broken.def").write_text(
        '<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> NOT_A_TYPE </Type>\n'
        '\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n')
    (defs / "Duplicate.def").write_text(
        '<root>\n\t<Properties>\n\t\t<level>\n\t\t\t<Type> UINT32 </Type>\n'
        '\t\t\t<Flags> BASE </Flags>\n\t\t</level>\n\t\t<level>\n\t\t\t<Type> UINT32 </Type>\n'
        '\t\t\t<Flags> BASE </Flags>\n\t\t</level>\n\t</Properties>\n</root>\n')
    (defs / "HoverDemo.def").write_text(
        '<root>\n\t<Properties>\n\t\t<name>\n\t\t\t<Type> STRING </Type>\n'
        '\t\t\t<Flags> BASE_AND_CLIENT </Flags>\n\t\t</name>\n\t</Properties>\n'
        '\t<CellMethods>\n\t\t<onAggro>\n\t\t\t<Arg> ENTITY_ID </Arg>\n'
        '\t\t</onAggro>\n\t</CellMethods>\n</root>\n')
    if extra_files:
        for rel, content in extra_files.items():
            p = ws / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
    return ws


# ---------------------------------------------------------------- 姿态（pose）
POSE_OPEN_WAIT = 9       # 激活+索引稳定等待（秒）
POSE_SETTLE = 2.5


def pose_file(win, ws, rel, line=None, problems=False, hover=None, settle=POSE_SETTLE):
    """打开 demo 文件（可选定位行列），可选开问题面板/悬停。"""
    target = ws / rel
    launch_path = f"{target}:{line}:1" if line else str(target)
    win = launch_code(ws, launch_path)
    time.sleep(POSE_OPEN_WAIT)
    key("ctrl+alt+b")                      # 关闭 Chat/副边栏，保持编辑器画面干净
    time.sleep(1.0)
    if problems:
        key("ctrl+shift+m")
        time.sleep(settle)
    if hover:
        mouse(*hover)
        time.sleep(settle)
    return win


def pose_command(win, ws, rel, cmd_substr, cursor_line=None, settle=6):
    """打开文件、光标定位后经命令面板执行命令。"""
    target = ws / rel
    launch_path = f"{target}:{cursor_line}:1" if cursor_line else str(target)
    win = launch_code(ws, launch_path)
    time.sleep(POSE_OPEN_WAIT)
    key("ctrl+alt+b")                      # 关闭 Chat/副边栏
    time.sleep(1.0)
    if cursor_line:
        pass                                   # code file:line:col 已定位光标
    command_palette(cmd_substr)
    time.sleep(settle)
    return win


# ---------------------------------------------------------------- 场景
def cap_vscode(switch, state_value, ws):
    s = state_value
    frames = CAP / "frames"
    frames.mkdir(parents=True, exist_ok=True)
    k = switch["key"]

    if k == "enable-diagnostics":
        ws_settings = {"kbengine.enableDiagnostics": s}
        write_settings(ws, ws_settings)
        win = pose_file(win=None, ws=ws, rel="scripts/entity_defs/Broken.def",
                        line=3, problems=True)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "check-duplicate-definitions":
        write_settings(ws, {"kbengine.enableDiagnostics": True,
                            "kbengine.enableStructureDiagnostics": True,
                            "kbengine.diagnostics.checkDuplicateDefinitions": s})
        win = pose_file(win=None, ws=ws, rel="scripts/entity_defs/Duplicate.def",
                        line=3, problems=True)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "hover-show-tag-docs":
        write_settings(ws, {"kbengine.hover.showTagDocs": s})
        win = pose_file(win=None, ws=ws, rel="scripts/entity_defs/HoverDemo.def",
                        line=4, hover=HOVER_XY["tag"])
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "hover-show-value-docs":
        write_settings(ws, {"kbengine.hover.showValueDocs": s})
        win = pose_file(win=None, ws=ws, rel="scripts/entity_defs/HoverDemo.def",
                        line=4, hover=HOVER_XY["value"])
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "hover-implemented-by":
        write_settings(ws, {"kbengine.hover.implementedBy": s})
        win = pose_file(win=None, ws=ws, rel="scripts/entity_defs/HoverDemo.def",
                        line=8, hover=HOVER_XY["method"])
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "codelens-rpc":
        write_settings(ws, {"kbengine.codeLens.rpc": s})
        win = pose_file(win=None, ws=ws, rel="scripts/cell/Monster.py", line=9)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "codelens-types-xml":
        write_settings(ws, {"kbengine.codeLens.typesXml": s})
        win = pose_file(win=None, ws=ws, rel="scripts/entity_defs/types.xml", line=1)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "inlay-type-data":
        write_settings(ws, {"kbengine.inlayHints.typeData": s,
                            "kbengine.python.builtinTypeInlayHints": True})
        win = pose_file(win=None, ws=ws, rel="scripts/cell/TrainingAvatar.py", line=31)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "inlay-def-params":
        write_settings(ws, {"kbengine.inlayHints.defParams": s})
        win = pose_file(win=None, ws=ws, rel="scripts/cell/Monster.py", line=9)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "hot-reload-enabled":
        # 效果面在状态栏热更项（watch-off ↔ 就绪），须整窗截图
        write_settings(ws, {"kbengine.hotReload.enabled": s,
                            "kbengine.hotReload.globs": "scripts/**/*.py"})
        win = pose_file(win=None, ws=ws, rel="scripts/cell/Monster.py", line=1)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win,
                          editor_region=False)

    if k == "call-chain-view":
        write_settings(ws, {"kbengine.python.callChainHints": True,
                            "kbengine.python.callChainView": s})
        win = pose_command(win=None, ws=ws, rel="scripts/cell/Monster.py",
                           cmd_substr="Show Call Chain", cursor_line=27, settle=2)
        # 命令先弹方法 QuickPick（onAggro 高亮在首位），再回车一次确认进入面板
        key("Return")
        time.sleep(10)                     # webview 渲染等待
        return screenshot(frames / f"{k}-{'graph' if s == 'graph' else 'text'}.png", win)

    raise SystemExit(f"no capture scenario for {k}")


def generate_switch(switch, vsix):
    k = switch["key"]
    ws = stage_workspace(k)
    frames = []
    if isinstance(switch["off"], bool):
        off_tag, on_tag = "off", "on"
    else:
        off_tag, on_tag = str(switch["off"]), str(switch["on"])
    frames.append(cap_vscode(switch, switch["off"], ws))
    frames.append(cap_vscode(switch, switch["on"], ws))

    out = OUTPUT
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy(frames[0], out / f"{k}-{off_tag}.png")
    shutil.copy(frames[1], out / f"{k}-{on_tag}.png")
    gif = out / f"{k}.gif"
    tmpdir = Path(tempfile.mkdtemp(prefix="kode-gif-"))
    try:
        for i, fp in enumerate(frames):
            shutil.copy(fp, tmpdir / f"{i:03d}.png")
        sh(["ffmpeg", "-loglevel", "error", "-y",
            "-framerate", str(1000 // GIF_DELAY_MS), "-i", str(tmpdir / "%03d.png"),
            "-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse",
            "-loop", "0", str(gif)])
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return {"key": k, "off": f"{k}-{off_tag}.png",
            "on": f"{k}-{on_tag}.png", "gif": f"{k}.gif"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--switch", help="key 或 key=state（单态调试，配合 --keep）")
    ap.add_argument("--vsix", help="扩展 vsix 路径（缺省 /tmp/kode-gif-capture/kode.vsix）")
    ap.add_argument("--keep", action="store_true", help="保留 /tmp 截图现场便于排查")
    args = ap.parse_args()

    ensure_xvfb()
    write_user_settings()
    vsix = Path(args.vsix) if args.vsix else CAP / "kode.vsix"
    if not vsix.exists():
        print(f"missing vsix: {vsix}\n先按 README 构建扩展包，或用 --vsix 指定", file=sys.stderr)
        raise SystemExit(2)
    install_vsix(vsix)
    CAP.mkdir(parents=True, exist_ok=True)

    if args.list:
        for s in load_switches():
            cap = s.get("capture", False)
            mark = "GIF" if cap is True else ("TRY" if cap else "MAN")
            print(f"{s['key']}\t{s.get('setting','')}\t{mark}\t{s.get('group_zh','')}\t{s.get('name_zh','')}")
        return

    targets = load_switches()
    if args.switch:
        targets = [find_switch(args.switch.split("=", 1)[0])]
    if args.all:
        targets = [s for s in targets if s.get("capture") is True or s.get("capture") == "pending-verify"]

    results = []
    for s in targets:
        if not (s.get("capture") is True or s.get("capture") == "pending-verify"):
            print(f"SKIP {s['key']} (manual)")
            continue
        try:
            r = generate_switch(s, vsix)
            results.append(r)
            print(f"OK {s['key']}: {r['gif']}")
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {s['key']}: {e}", file=sys.stderr)
            kill_code()

    if results and not args.keep:
        pass
    kill_code()
    manifest = OUTPUT / "manifest.json"
    existing = []
    if manifest.exists():
        try:
            existing = json.loads(manifest.read_text())
        except (ValueError, TypeError):
            existing = []
    by_key = {r["key"]: r for r in existing}
    for r in results:
        by_key[r["key"]] = r
    manifest.write_text(json.dumps([by_key[k] for k in by_key], indent=2, ensure_ascii=False))
    print(f"manifest: {manifest} ({len(by_key)} gifs)")


if __name__ == "__main__":
    main()
