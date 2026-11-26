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
# Screenshot workspace/frames directory (kept with --keep). When several sessions
# share this tree, or captures run concurrently, point KODE_GIF_CAP at a private
# directory per session so shared vscode-profile and staging areas do not step on
# each other (2026-11-07: another session also used /tmp/kode-gif-capture and both
# sides' kill_code killed the other's VS Code).
CAP = Path(os.environ.get("KODE_GIF_CAP", "/tmp/kode-gif-capture"))
VSCODE_USER = CAP / "vscode-profile"
VSCODE_EXT = CAP / "vscode-ext"
DISPLAY = os.environ.get("KODE_GIF_DISPLAY", ":99")
SCREEN = "1600x1000x24"
GIF_DELAY_MS = 700
# kode-server binary: show-final-config-on-open relies on KODE-CFG-009's
# `$/kode/config/resolve` (both trees are resolved by core, TS has no local
# fallback), so the vscode pose points kbengine.core.serverPath at it; the binary
# must contain config/resolve (older builds do not, checkable via strings).
# Defaults to the repo cargo artifact, overridable via KODE_SERVER_PATH.
KODE_SERVER_PATH = os.environ.get(
    "KODE_SERVER_PATH", str(ROOT / "target" / "debug" / "kode-server"))

# Hover coordinates (calibrated at 1600x1000, editor.fontSize 18, minimap hidden,
# default Dark+): the hover target token sits at a fixed row/column in the demo
# file, so the pixel position is a constant; recalibrate on theme/font-size change
HOVER_XY = {
    # HoverDemo.def: the <Flags> tag / the BASE_AND_CLIENT value
    "tag": (660, 250),
    "value": (760, 250),
    # Monster.def: the onAggro method name in CellMethods
    "method": (700, 340),
    # Middle of the word weapon_skill_slot_list_inst inside the comment at
    # SKILL_SLOT_DATA.py:2 (still to be calibrated; see the 2026-11-07 calibration
    # note: the window offset inside a 1600x1000 Xvfb is unmeasured, so assume (0,0))
    "implementedBy": (1051, 147),
}

BASE_SETTINGS = {
    # Workspace-scope keys only — application/window scope keys written into
    # .vscode/settings.json do not take effect and belong in PROFILE_SETTINGS
    # (2026-11-07 measurement: trust written in the workspace still left the /tmp
    # workspace in Restricted Mode, the extension declares no
    # capabilities.untrustedWorkspaces so it never activated, the exthost log has no
    # kode activation record at all, and off/on frames came out identical).
    "workbench.startupEditor": "none",
    "workbench.editor.enablePreview": False,
    "telemetry.telemetryLevel": "off",
    "editor.fontSize": 18,
    "editor.minimap.enabled": False,
    "editor.renderWhitespace": "none",
    "problems.autoReveal": False,
    "kode.python.stubExport": False,   # avoid background .pyi writes raising notifications during capture
}

# User level (User/settings.json) — fixed application/window scope items.
# Screenshot-dedicated profile: all keys written out in full, reruns overwrite the
# same values to stay consistent across machines.
PROFILE_SETTINGS = {
    "security.workspace.trust.enabled": False,   # /tmp workspace stays out of Restricted Mode
    "update.mode": "none",
    "extensions.autoUpdate": False,
    "extensions.autoCheckUpdates": False,
    "extensions.ignoreRecommendations": True,
    "window.commandCenter": False,
    "workbench.colorTheme": "Default Dark+",   # fixed theme so reruns stay pixel-comparable across machines
    "chat.commandCenter.enabled": False,
    # Suppress the first-launch welcome dialog (2026-11-07 measurement on a fresh
    # profile: writing only the workspace BASE_SETTINGS is not enough, a brand new
    # --user-data-dir still pops the "Welcome to VS Code" modal and covers every
    # screenshot; it must land in the profile's user-level settings.json)
    "workbench.startupEditor": "none",
}


def ensure_profile_settings():
    """把 application/window 作用域固定项写进截图 profile 的用户级 settings.json
    (install_vsix 后调用一次;幂等)。"""
    user_dir = VSCODE_USER / "User"
    user_dir.mkdir(parents=True, exist_ok=True)
    target = user_dir / "settings.json"
    merged = {}
    if target.exists():
        try:
            merged = json.loads(target.read_text())
        except ValueError:
            merged = {}
    merged.update(PROFILE_SETTINGS)
    target.write_text(json.dumps(merged, indent=2))


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
            # shaped like "  Geometry: 1600x847"
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
    for _ in range(100):                      # wait at most 30s for the window
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


# Frame-diff/blank checks crop the "editor text area" by default (calibrated at
# 1600x1000: skip the tab bar + breadcrumb, roughly y>170). Blank/diff checks look
# at the text area only — a full-window crop would count tab bar/side bar pixels
# and could pass by mistake when the editor never rendered (2026-11-07 false
# positive lesson).
# Hover cards render beside the cursor (near Ln 2 the card sits at y~45-140,
# 2026-11-07 keyboard-hover measurement), which the standard region cannot catch;
# hover-type switches use the taller region (including the top card slot; the title
# bar/tab strip is constant between off/on and contributes no frame difference).
TEXT_CROP = "890x600+389+170"
HOVER_CROP = "1040x700+389+30"


def text_crop(png, out_png, region=TEXT_CROP):
    sh(["convert", str(png), "-crop", region, "+repage", str(out_png)])
    return out_png


def screenshot(path, win, region=TEXT_CROP):
    """截窗；软件渲染下内容可能晚画，等「编辑器文字区」非空白（像素标准差阈值）。
    超时视为失败抛出——绝不把空白帧当成功（此前版本超时落盘，假阳性溜进 manifest）。
    region：渲染就绪判定区，默认标准文字区；短文件（如 6 行 defaults.xml）文字
    几乎全在 y<170，须传加高区（HOVER_CROP）否则就绪判定永不通过。"""
    deadline = time.time() + 60
    probe = str(path) + ".probe.png"
    check = str(path) + ".check.png"
    last = 0.0
    while time.time() < deadline:
        sh(["import", "-window", str(win), probe], env=env())
        text_crop(probe, check, region)
        out = sh(["identify", "-format", "%[fx:standard_deviation]", check])
        last = float(out.stdout.strip() or "0")
        if last > 0.02:
            shutil.move(probe, path)
            Path(check).unlink(missing_ok=True)
            return path
        time.sleep(1.5)
    Path(probe).unlink(missing_ok=True)
    Path(check).unlink(missing_ok=True)
    raise SystemExit(f"screenshot: editor text region still blank after 60s (std={last:.4f}): {path}")


def frames_differ(a, b, threshold=0.004, region=TEXT_CROP):
    """off/on 两帧文字区必须有可见差异（RMSE 归一值）——开关效果没生效/没画出来，
    两帧近乎相同即判失败。这一步让流水线兼作「开关有效性」回归检查。"""
    ca, cb = Path(str(a) + ".ta.png"), Path(str(b) + ".tb.png")
    text_crop(a, ca, region)
    text_crop(b, cb, region)
    r = subprocess.run(["compare", "-metric", "RMSE", str(ca), str(cb), "null:"],
                       capture_output=True, text=True, env=env())
    val = 0.0
    for tok in (r.stderr or "").replace("(", " ").replace(")", " ").split():
        try:
            val = float(tok)
        except ValueError:
            continue
    ca.unlink(missing_ok=True)
    cb.unlink(missing_ok=True)
    return val > threshold, val


def command_palette(title_substr, enter=True):
    """Ctrl+Shift+P 输入命令并回车（取第一个匹配项）。"""
    key("ctrl+shift+p")
    time.sleep(0.8)
    subprocess.run(["xdotool", "type", "--delay", "70", title_substr],
                   capture_output=True, env=env())
    time.sleep(1.0)
    if enter:
        key("Return")


def close_auxiliary():
    """关闭右侧 Chat 副栏，保持编辑器画面干净。走命令面板比 ctrl+alt+b 可靠
    （快捷键随版本/配置漂移，2026-11-07 假阳性截图里副栏就没关掉）。"""
    try:
        command_palette("View: Close Auxiliary Bar")
        time.sleep(1.0)
    except Exception:  # noqa: BLE001
        pass                                   # not fatal when already closed / command does not exist


# ---------------------------------------------------------------- workspace
def write_settings(ws, extra):
    settings_dir = ws / ".vscode"
    settings_dir.mkdir(exist_ok=True)
    merged = dict(BASE_SETTINGS)
    merged.update(extra)
    (settings_dir / "settings.json").write_text(json.dumps(merged, indent=2))


def stage_workspace(name, extra_files=None):
    """从 demo 资产树复制一份干净工作区（/tmp，非破坏性）。
    资产树内容直接落在工作区根（res/server/kbengine.xml + scripts/ 必须在根，
    否则扩展识别不了 KBEngine 资产、不激活）。"""
    ws = CAP / name
    if ws.exists():
        shutil.rmtree(ws)
    shutil.copytree(DEMO_ASSETS, ws, ignore=shutil.ignore_patterns("*.pyc"))
    # Diagnostics demo files (deliberately broken, so the repo fixture stays clean)
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
    # Inlay demo entity (short file fully visible, no scrolling / no reveal
    # difference; def declares hp/potions and the typeData inlay renders : UINT32
    # at the self.hp/self.potions accesses). Registered in entities.xml
    # (resolvePropertyDefinitionInfo goes through the entity mapping, unregistered
    # entities do not resolve).
    (defs / "InlayDemo.def").write_text(
        '<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n'
        '\t\t\t<Flags> ALL_CLIENTS </Flags>\n\t\t</hp>\n\t\t<potions>\n'
        '\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE_AND_CLIENT </Flags>\n'
        '\t\t</potions>\n\t</Properties>\n'
        '\t<CellMethods>\n\t\t<takePotion>\n\t\t\t<Arg> UINT32 </Arg>\n'
        '\t\t</takePotion>\n\t</CellMethods>\n</root>\n')
    ws_scripts = ws / "scripts"
    cell_dir = ws_scripts / "cell"
    cell_dir.mkdir(parents=True, exist_ok=True)
    # Single-segment self.id access (builtin face attribute, the
    # builtinTypeInlayHints surface; the negative assertion excludes multi-segment
    # forms like self.position.x, so it must be single-segment)
    (cell_dir / "InlayDemo.py").write_text(
        'class InlayDemo:\n'
        '\tdef reqTakePotion(self, count):\n'
        '\t\treturn self.takePotion(count)  # rpc: cell\n'
        '\n'
        '\tdef takePotion(self, count):\n'
        '\t\tif self.potions <= 0 or self.hp <= 0:\n'
        '\t\t\treturn self.hp\n'
        '\t\tself.potions -= count\n'
        '\t\tprint("potion used by", self.id)\n'
        '\t\treturn self.hp\n')
    (defs / "EventDemo.def").write_text(
        '<root>\n\t<ClientMethods>\n\t\t<onKnocked>\n'
        '\t\t\t<Arg> UINT32 </Arg>\n\t\t</onKnocked>\n'
        '\t</ClientMethods>\n</root>\n')
    # registerEvent(event name, callback): the resolver (eventApi.findEventCalls)
    # only recognises a callback as a named reference (self.onFoo) or a string
    # literal, and matches the def line by callback name
    (cell_dir / "EventDemo.py").write_text(
        'class EventDemo:\n'
        '\tdef __init__(self):\n'
        '\t\tself.registerEvent("onKnocked", self.onKnocked)\n'
        '\n'
        '\tdef onKnocked(self, attackerId):\n'
        '\t\tpass\n')
    # RPC mirror-chain demo entity: def declares onAggro (cell RPC
    # <Arg> UINT32), short file fully visible; the RPC CodeLens surface is the
    # implementation line of a method declared in def (EventDemo already carries
    # an event-callback mirror-chain demo, two chains in one frame would confuse
    # the shot, hence a separate RpcDemo).
    (defs / "RpcDemo.def").write_text(
        '<root>\n\t<CellMethods>\n\t\t<onAggro>\n'
        '\t\t\t<Arg> UINT32 </Arg>\n\t\t</onAggro>\n'
        '\t</CellMethods>\n</root>\n')
    (cell_dir / "RpcDemo.py").write_text(
        'class RpcDemo:\n'
        '\tdef onAggro(self, entityId):\n'
        '\t\treturn entityId\n')
    entities = ws_scripts / "entities.xml"
    if entities.exists():
        text = entities.read_text()
        additions = ""
        if "InlayDemo" not in text:
            additions += '\t<InlayDemo hasCell="true"></InlayDemo>\n'
        if "EventDemo" not in text:
            additions += '\t<EventDemo hasCell="true"></EventDemo>\n'
        if "RpcDemo" not in text:
            additions += '\t<RpcDemo hasCell="true"></RpcDemo>\n'
        if additions:
            text = text.replace("</root>", additions + "</root>")
            entities.write_text(text)
    if extra_files:
        for rel, content in extra_files.items():
            p = ws / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
    return ws


# ---------------------------------------------------------------- pose
POSE_OPEN_WAIT = 9       # wait for activation + index stabilisation (seconds)
POSE_SETTLE = 2.5


def goto_line(line, win=None):
    """显式定位到行(编辑器最终布局下居中)。两条实测教训:
    1) -g file:N 的 reveal 在文档刚打开、字体/布局未定时,两次启动能差出一行,
       off/on 视口错行会让帧差断言被滚动差淹没;
    2) ctrl+g 是编辑器快捷键——窗口刚激活时焦点常在侧栏,实测光标被甩到
       文件末尾(Ln 234)。改走命令面板 Go to Line/Column(窗口级命令,任何
       焦点下都可用),先点一下编辑器区保证落点。"""
    if win:
        # Click the middle of the editor using window-relative coordinates (the center
        # of the 890x600 text area calibrated at +389+170)
        subprocess.run(["xdotool", "mousemove", f"window:{win}", "834", "470", "click", "1"],
                       capture_output=True, env=env())
        time.sleep(0.6)
    command_palette("Go to Line/Column")
    time.sleep(0.5)
    subprocess.run(["xdotool", "type", "--delay", "70", str(line)],
                   capture_output=True, env=env())
    time.sleep(0.4)
    key("Return")


def goto_line_col(line, col, win=None):
    """定位到 行:列(Go to Line/Column 输入框接受 line:col)。同 goto_line 的
    教训:先点编辑器区,走窗口级命令面板;列定位让「键盘悬停」能精确落在
    目标 token 上,彻底摆脱像素标定(2026-11-07:窗口在 Xvfb 内有偏移,
    mouse() 屏幕坐标对不上窗口像素,逐次试坐标既慢又脆)。"""
    if win:
        subprocess.run(["xdotool", "mousemove", f"window:{win}", "834", "470", "click", "1"],
                       capture_output=True, env=env())
        time.sleep(0.6)
    command_palette("Go to Line/Column")
    time.sleep(0.5)
    subprocess.run(["xdotool", "type", "--delay", "70", f"{line}:{col}"],
                   capture_output=True, env=env())
    time.sleep(0.4)
    key("Return")


def hover_at(win, line, col, settle=POSE_SETTLE):
    """键盘悬停:光标定位到 (line,col) 后触发 editor.action.showHover。
    无鼠标、无像素标定,卡片一定出现在目标 token 上。"""
    goto_line_col(line, col, win)
    time.sleep(1.0)
    command_palette("Show Hover")
    time.sleep(settle)


def pose_file(win, ws, rel, line=None, problems=False, hover=None, settle=POSE_SETTLE,
              hover_col=None):
    """打开 demo 文件（可选定位行列），可选开问题面板/悬停。"""
    target = ws / rel
    launch_path = f"{target}:{line}:1" if line else str(target)
    win = launch_code(ws, launch_path)
    time.sleep(POSE_OPEN_WAIT)
    close_auxiliary()                      # close the Chat/auxiliary bar, keep the editor shot clean
    time.sleep(1.0)
    if line:
        goto_line(line, win)                # explicit centring, removes startup reveal scroll drift
        time.sleep(1.0)
    if problems:
        key("ctrl+shift+m")
        time.sleep(settle)
    if hover is not None:
        if hover_col is not None:
            hover_at(win, hover, hover_col, settle)
        else:
            # Calibration probe: the window's offset inside the Xvfb screen (mouse() uses
            # screen coordinates, the screenshot uses the window's own; the
            # difference is the offset; print it once while calibrating, do not
            # persist it)
            geo = subprocess.run(["xdotool", "getwindowgeometry", "--shell", str(win)],
                                 capture_output=True, text=True, env=env()).stdout
            print(f"HOVER-GEO key=hover win={win}\n{geo}", flush=True)
            mouse(*hover)
            time.sleep(settle)
    return win


def pose_command(win, ws, rel, cmd_substr, cursor_line=None, settle=6, pick=False):
    """打开文件、光标定位后经命令面板执行命令。pick=True 时命令后跟一个
    Return(命令弹 quick-pick 选单时选中第一项,如 Show Call Chain 的
    「Select an entity method」)。"""
    target = ws / rel
    launch_path = f"{target}:{cursor_line}:1" if cursor_line else str(target)
    win = launch_code(ws, launch_path)
    time.sleep(POSE_OPEN_WAIT)
    close_auxiliary()                      # close the Chat/auxiliary bar
    time.sleep(1.0)
    if cursor_line:
        goto_line(cursor_line, win)         # as in pose_file: explicit centring removes scroll drift
        time.sleep(1.0)
    command_palette(cmd_substr)
    if pick:
        time.sleep(1.0)
        key("Return")                       # pick the first quick-pick entry
        time.sleep(1.0)
    time.sleep(settle)
    return win


# ---------------------------------------------------------------- scenarios
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
        # Back-link hover surface = the symbol name referenced by implementedBy in
        # types.xml inside the user_type module
        # (SKILL_SLOT_DATA.weapon_skill_slot_list_inst): that word already appears
        # in the SKILL_SLOT_DATA.py:2 comment (word span cols 44-70, 1-based); the
        # keyboard hover (showHover) lands exactly on the word, on shows the
        # back-link card, off shows nothing; no mouse, no pixel calibration
        write_settings(ws, {"kbengine.hover.implementedBy": s})
        win = pose_file(win=None, ws=ws,
                        rel="scripts/user_type/SKILL_SLOT_DATA.py",
                        line=2, hover=2, hover_col=57)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "codelens-rpc":
        # RPC mirror-chain surface = the implementation line of a method declared in def
        # (RpcDemo.def CellMethods onAggro): RpcDemo.py is fully visible, the chain
        # renders above the def line, off is dark and on lights up
        write_settings(ws, {"kbengine.codeLens.rpc": s})
        win = pose_file(win=None, ws=ws, rel="scripts/cell/RpcDemo.py", line=2)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "codelens-types-xml":
        write_settings(ws, {"kbengine.codeLens.typesXml": s})
        win = pose_file(win=None, ws=ws, rel="scripts/entity_defs/types.xml", line=1)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "enable-structure-diagnostics":
        # Structure diagnostics switch (duplicate properties in Duplicate.def are
        # structure errors, not basic parse errors): basic diagnostics stay on,
        # flipping only this switch makes the duplicate-definition entries appear
        # and disappear in problems
        write_settings(ws, {"kbengine.enableDiagnostics": True,
                            "kbengine.enableStructureDiagnostics": s})
        win = pose_file(win=None, ws=ws, rel="scripts/entity_defs/Duplicate.def",
                        line=3, problems=True)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "codelens-property":
        # CodeLens at self.<def property> access sites (label = def type and visibility
        # scope, click jumps back to the declaring line): InlayDemo.py's
        # self.hp/self.potions walk the same resolution chain
        write_settings(ws, {"kbengine.codeLens.property": s})
        win = pose_file(win=None, ws=ws, rel="scripts/cell/InlayDemo.py", line=6)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "codelens-event-callbacks":
        # Event callback CodeLens: the surface is the label on the callback def line of
        # registerEvent/addEvent (the demo assets had no event calls, caught by
        # the 2026-11-07 frame-diff gate) — hence a dedicated EventDemo entity
        write_settings(ws, {"kbengine.codeLens.eventCallbacks": s})
        win = pose_file(win=None, ws=ws, rel="scripts/cell/EventDemo.py", line=6)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "builtin-type-inlay-hints":
        # Inline inlay for builtin attributes: the surface is single-segment
        # self.<builtin attribute> (id/position/...; the negative assertion
        # excludes multi-segment self.position.x — Monster.py:22 is all
        # multi-segment and was caught by the 2026-11-07 frame-diff gate).
        # InlayDemo.py:9 self.id is single-segment: on shows : int, off hides it
        write_settings(ws, {"kbengine.python.builtinTypeInlayHints": s})
        win = pose_file(win=None, ws=ws, rel="scripts/cell/InlayDemo.py", line=9)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "python-call-chain-hints":
        # Call Chain CodeLens at the top of method declaration lines (takePotion is
        # declared in InlayDemo.def CellMethods, so resolution hits); the lens
        # disappears when off
        write_settings(ws, {"kbengine.python.callChainHints": s})
        win = pose_file(win=None, ws=ws, rel="scripts/cell/InlayDemo.py", line=5)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "inlay-type-data":
        # Dedicated InlayDemo entity (6 lines, whole file visible): def declares
        # hp/potions: UINT32 and the self.hp/self.potions access sites get
        # : UINT32 inlays. The earlier Avatar.py:137 pose had two pitfalls —
        # the goto/reveal scroll position was uncertain, and extension activation
        # flung the viewport to the end of the file (2026-11-07 measurement); a
        # short file has no scrolling, removing both sources of uncertainty at the
        # root.
        write_settings(ws, {"kbengine.inlayHints.typeData": s,
                            "kbengine.python.builtinTypeInlayHints": True})
        win = pose_file(win=None, ws=ws, rel="scripts/cell/InlayDemo.py", line=3)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "inlay-def-params":
        # def parameter inlay surface = the def declaration line inside the block file
        # (InlayDemo.def CellMethods declares takePotion <Arg> UINT32;
        # count in InlayDemo.py:5 def takePotion(self, count) is unannotated →
        # on inlines : int after count, off hides it)
        write_settings(ws, {"kbengine.inlayHints.defParams": s})
        win = pose_file(win=None, ws=ws, rel="scripts/cell/InlayDemo.py", line=5)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "call-chain-view":
        # Show Call Chain first pops the "Select an entity method" quick-pick (listing
        # only def-declared methods: onAggro/onDamaged/...), and picking the first
        # entry onAggro opens the panel; callChainView decides whether the panel
        # opens as graph/text (the default opens mermaid rendering, which takes
        # time, so settle generously)
        write_settings(ws, {"kbengine.python.callChainHints": True,
                            "kbengine.python.callChainView": s})
        win = pose_command(win=None, ws=ws, rel="scripts/cell/Monster.py",
                           cmd_substr="Show Call Chain", cursor_line=91,
                           pick=True, settle=8)
        return screenshot(frames / f"{k}-{'graph' if s == 'graph' else 'text'}.png", win)

    if k == "runtime-query-enabled":
        write_settings(ws, {"kbengine.runtimeQuery.enabled": s})
        win = pose_command(win=None, ws=ws, rel="scripts/cell/Monster.py",
                           cmd_substr="Runtime Query", cursor_line=9, settle=5)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win)

    if k == "show-final-config-on-open":
        # What the switch really means (extension.ts activation path): on = activation
        # opens the final-config composite view in a background preview
        # (openFinalConfig(true); binPath derives the defaults path), off = it does
        # not.
        # Since CFG-009 both trees are resolved by core `$/kode/config/resolve`, and
        # TS has no local fallback → the pose must supply kbengine.core.serverPath
        # (without serverPath, runInRust synchronously returns no serverPath →
        # merged is empty → the command pops the misleading "cannot locate engine
        # default config" error and on/off has no frame diff). binPath is written as
        # an absolute path (computed by the pose, not relying on variable
        # expansion). The composite document text starts at the top of the editor,
        # so both the ready check and the frame diff use the taller region (a short
        # file's text is almost entirely at y<170, the standard region's std check
        # never passes)
        write_settings(ws, {"kbengine.showFinalConfigOnOpen": s,
                            "kbengine.binPath": f"{ws}/kbe/bin/server",
                            "kbengine.core.serverPath": KODE_SERVER_PATH})
        win = pose_file(win=None, ws=ws, rel="kbe/res/server/kbengine_defaults.xml", line=1)
        return screenshot(frames / f"{k}-{'on' if s else 'off'}.png", win, region=HOVER_CROP)

    raise SystemExit(f"no capture scenario for {k}")


FINAL_CONFIG_FILES = {
    "kbe/res/server/kbengine_defaults.xml":
        '<root>\n\t<baseapp>\n\t\t<externalIp> 127.0.0.1 </externalIp>\n\t</baseapp>\n</root>\n',
    "kbe/bin/server/.keep": "",
}


def generate_switch(switch, vsix, single_state=None):
    """single_state: 'off'/'on' 只捕单态（调试姿态用），跳过帧差断言。"""
    k = switch["key"]
    extra = FINAL_CONFIG_FILES if k == "show-final-config-on-open" else None
    ws = stage_workspace(k, extra)
    frames = []
    if isinstance(switch["off"], bool):
        off_tag, on_tag = "off", "on"
    else:
        off_tag, on_tag = str(switch["off"]), str(switch["on"])
    if single_state == "off":
        return {"key": k, "debug": cap_vscode(switch, switch["off"], ws)}
    if single_state == "on":
        return {"key": k, "debug": cap_vscode(switch, switch["on"], ws)}
    frames.append(cap_vscode(switch, switch["off"], ws))
    frames.append(cap_vscode(switch, switch["on"], ws))

    # Hover cards/CodeLens/inlay can render beside the cursor or at the file top (in
    # a short file the def line is up top and the lens sits just above it near
    # y~120, 2026-11-07 codelens-rpc measurement), which the standard region
    # (y>170) cannot crop → these types use the taller region; the title bar/tab
    # strip is constant between off/on and contributes no frame difference.
    region = HOVER_CROP if k.startswith(("hover", "codelens", "inlay", "builtin",
                                         "show-final-config")) \
        else TEXT_CROP
    ok, rmse = frames_differ(frames[0], frames[1], region=region)
    if not ok:
        raise SystemExit(f"off/on frames nearly identical (RMSE={rmse:.5f}) — "
                         f"开关效果未生效或未画进文字区: {k}")

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
    # The manifest records repo-relative paths (absolute paths bind to one machine and
    # rot on a rerun elsewhere)
    rel = lambda p: str(Path(p).relative_to(ROOT))
    return {"key": k, "off": rel(out / f"{k}-{off_tag}.png"),
            "on": rel(out / f"{k}-{on_tag}.png"), "gif": rel(gif)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--switch", help="key 或 key=state（单态调试，配合 --keep）")
    ap.add_argument("--vsix", help="扩展 vsix 路径（缺省 /tmp/kode-gif-capture/kode.vsix）")
    ap.add_argument("--keep", action="store_true", help="保留 /tmp 截图现场便于排查")
    args = ap.parse_args()

    ensure_xvfb()
    vsix = Path(args.vsix) if args.vsix else CAP / "kode.vsix"
    if not vsix.exists():
        print(f"missing vsix: {vsix}\n先按 README 构建扩展包，或用 --vsix 指定", file=sys.stderr)
        raise SystemExit(2)
    install_vsix(vsix)
    ensure_profile_settings()          # application-scope fixed items like trust/theme (ensured on every run)
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
    single_state = None
    if args.switch and "=" in args.switch:
        single_state = args.switch.split("=", 1)[1]
    fails = 0
    for s in targets:
        if single_state is None and not (s.get("capture") is True or s.get("capture") == "pending-verify"):
            print(f"SKIP {s['key']} (manual)")
            continue
        try:
            r = generate_switch(s, vsix, single_state=single_state)
            if single_state:
                print(f"DEBUG {s['key']}[{single_state}]: {r['debug']}")
            else:
                results.append(r)
                print(f"OK {s['key']}: {r['gif']}")
        except Exception as e:  # noqa: BLE001
            fails += 1
            print(f"FAIL {s['key']}: {e}", file=sys.stderr)
            kill_code()

    kill_code()
    if single_state:
        return
    # Merge the manifest by key (an incremental rerun does not drop other switches'
    # existing entries)
    manifest = OUTPUT / "manifest.json"
    merged = {}
    if manifest.exists():
        try:
            merged = {m["key"]: m for m in json.loads(manifest.read_text())}
        except (ValueError, KeyError):
            merged = {}
    for r in results:
        merged[r["key"]] = r
    ordered = [merged[s["key"]] for s in load_switches() if s["key"] in merged]
    manifest.write_text(json.dumps(ordered, indent=2, ensure_ascii=False))
    print(f"manifest: {manifest} ({len(ordered)} gifs, this run: {len(results)}, fails: {fails})")
    if fails and args.all:
        raise SystemExit(1)      # regression-gate usage: any failure under --all turns red


if __name__ == "__main__":
    main()
