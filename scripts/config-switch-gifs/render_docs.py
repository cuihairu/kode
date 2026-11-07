#!/usr/bin/env python3
"""从 switches.json + manifest.json 生成双语「配置开关效果」文档页。

交付③(C-24):每个可截图开关=说明+off/on 静态图+动态 GIF(VitePress 直接嵌,
路径 /config-switch-gifs/*,与 docs/public 对位);不可截图开关(capture=false)
归入文末手工验证清单,如实标注无静态画面,不配图不编造。

只读两份 JSON,不改任何截图产物;配置或截图变更后重跑本脚本即再生成,
页面永不腐化。英文页 docs/guide/config-effects.md,中文页 docs/zh/guide/
config-effects.md(双语结构同 docs/.vitepress/config.mts 约定:en 在根,
zh 在 docs/zh/)。页面头部标注生成器来源,手改无效。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SWITCHES = ROOT / "scripts" / "config-switch-gifs" / "switches.json"
MANIFEST = ROOT / "docs" / "public" / "config-switch-gifs" / "manifest.json"
OUT_EN = ROOT / "docs" / "guide" / "config-effects.md"
OUT_ZH = ROOT / "docs" / "zh" / "guide" / "config-effects.md"

# 与 generate.py 同口径:manifest 相对 ROOT 存 repo 路径,页面用站点绝对路径
ASSET_PREFIX = "/config-switch-gifs/"

TEXT = {
    "title": {"en": "Config switch effects", "zh": "配置开关效果"},
    "intro": {
        "en": (
            "Every extension setting with a visible effect, captured before/after "
            "by the automated screenshot pipeline (`scripts/config-switch-gifs/`): "
            "Xvfb + real VS Code + the packaged extension, switch off → screenshot, "
            "switch on → screenshot, ffmpeg-stitched animation. The pipeline is "
            "rerunnable and doubles as a regression test — a switch whose effect "
            "breaks produces identical frames and fails the run. Switches without "
            "a static visual face are listed for manual verification at the end."
        ),
        "zh": (
            "所有「开启后看得见效果」的扩展配置项,由自动截图流水线"
            "(`scripts/config-switch-gifs/`)驱动真实 VS Code(Xvfb + 打包扩展)"
            "逐个先关后开各截一张,ffmpeg 缝成动态图。流水线可重跑,兼作配置效果"
            "回归测试——开关效果失效时前后帧完全一致,流水线直接报红。没有静态"
            "画面的开关列在文末手工验证清单,不配图不编造。"
        )
    },
    "rerun": {
        "en": "Regenerate this page: `python3 scripts/config-switch-gifs/render_docs.py`",
        "zh": "本页由生成器产出:`python3 scripts/config-switch-gifs/render_docs.py`"
    },
    "off": {"en": "Off", "zh": "关闭"},
    "on": {"en": "On", "zh": "开启"},
    "animation": {"en": "Animation", "zh": "动态图"},
    "manual-title": {"en": "Manual verification list", "zh": "手工验证清单"},
    "manual-intro": {
        "en": (
            "These switches have no single static screenshot face: the effect is "
            "behavioral (writes files, wires tooling, gates actions inside panels) "
            "or only visible mid-interaction. Verify them by following the effect "
            "description; the screenshots above deliberately exclude them."
        ),
        "zh": (
            "这些开关没有单一静态截图面:效果是行为性的(写文件/接线工具链/闸门在"
            "面板动作里)或只在交互过程中可见。按下表效果说明手工验证;上方截图"
            "有意不含它们。"
        )
    },
    "setting-col": {"en": "Setting", "zh": "配置项"},
    "effect-col": {"en": "Effect", "zh": "效果"},
    "generated-note": {
        "en": "This page is generated from `switches.json` + `manifest.json`; do not edit by hand.",
        "zh": "本页由 `switches.json` + `manifest.json` 生成,请勿手改。"
    },
}


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def site_asset(repo_path: str) -> str:
    """docs/public/config-switch-gifs/x.png → /config-switch-gifs/x.png"""
    public = "docs/public"
    assert repo_path.startswith(public + "/"), repo_path
    return "/" + repo_path[len(public) + 1:]


def md_safe(text: str) -> str:
    """反引号外的 <...> 转成实体:VitePress 页面经 Vue 模板编译,裸 `<Flags>`
    之类会被当元素解析,缺闭合标签直接 docs:build 报错。反引号内是行内代码,
    原样保留。"""
    parts = text.split("`")
    for i in range(0, len(parts), 2):
        parts[i] = parts[i].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return "`".join(parts)


def render_page(lang: str, switches: list[dict], manifest: list[dict]) -> str:
    t = TEXT
    captured = {e["key"]: e for e in manifest}
    manual = [s for s in switches if not s.get("capture")]
    lines: list[str] = []
    lines.append(f"# {t['title'][lang]}\n")
    lines.append(t["intro"][lang] + "\n")
    lines.append(t["rerun"][lang] + "\n")
    lines.append(f"> {t['generated-note'][lang]}\n")

    # 组序按 switches.json 首现序(生成器不造排序,清单顺序=作者顺序)
    groups: dict[str, list[dict]] = {}
    for s in switches:
        if s["key"] in captured:
            groups.setdefault(s[f"group_{lang}"], []).append(s)

    for group, items in groups.items():
        lines.append(f"## {group}\n")
        for s in items:
            e = captured[s["key"]]
            on_label = s["on"] if isinstance(s["on"], str) else t["on"][lang]
            off_label = s["off"] if isinstance(s["off"], str) else t["off"][lang]
            name = s[f"name_{lang}"]
            lines.append(f"### {name} (`{s['setting']}`)\n")
            lines.append(md_safe(s[f"effect_{lang}"]) + "\n")
            lines.append(f"| {off_label} | {on_label} |")
            lines.append("| --- | --- |")
            lines.append(
                f"| ![{name} off]({site_asset(e['off'])}) "
                f"| ![{name} on]({site_asset(e['on'])}) |\n"
            )
            lines.append(
                f"*{t['animation'][lang]}:* ![{name}]({site_asset(e['gif'])})\n"
            )

    lines.append(f"## {t['manual-title'][lang]}\n")
    lines.append(t["manual-intro"][lang] + "\n")
    lines.append(f"| {t['setting-col'][lang]} | {t['effect-col'][lang]} |")
    lines.append("| --- | --- |")
    for s in manual:
        effect = md_safe(s[f"effect_{lang}"]).replace("|", "\\|")
        lines.append(f"| `{s['setting']}` | {effect} |")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    switches = load(SWITCHES)
    switches = switches["switches"] if isinstance(switches, dict) else switches
    manifest = load(MANIFEST)
    missing = [s["key"] for s in switches
               if s.get("capture") and s["key"] not in {e["key"] for e in manifest}]
    if missing:
        print(f"capture=true but no manifest entry: {missing}", file=sys.stderr)
        raise SystemExit(1)
    OUT_EN.write_text(render_page("en", switches, manifest), encoding="utf-8")
    OUT_ZH.write_text(render_page("zh", switches, manifest), encoding="utf-8")
    print(f"wrote {OUT_EN.relative_to(ROOT)} + {OUT_ZH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
