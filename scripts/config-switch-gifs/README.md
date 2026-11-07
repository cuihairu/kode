# config-switch-gifs — 配置开关效果截图/动图流水线

对 `kbengine.*` 配置开关逐个产出**真实的开关前后截图与对照动图**，
落在 `docs/public/config-switch-gifs/`，被 `docs/guide/feature-flags.md`
（英文）与 `docs/zh/guide/feature-flags.md`（中文）引用。
开关清单见 `switches.json`（含中英名/效果描述/可截图标记）。

## 流程

每个开关：

1. 从 `tests/fixtures/kbengine-demo-assets` 复制一份干净工作区到
   `/tmp/kode-gif-capture/<key>/`，补齐演示文件（Broken.def 等）；
2. 把该开关的 off 值写进工作区 `.vscode/settings.json`，在 Xvfb 内起
   真实 VS Code（装 kode 扩展），摆出效果可见的姿态（开文件/悬停/跑命令），
   `import` 截真实窗口；
3. 改写为 on 值，重启扩展宿主，同姿态再截一张；
4. ffmpeg 把两张 PNG 缝成循环 GIF（palettegen/paletteuse）。

application-scoped 的 VS Code 基线设置（`update.mode`、`extensions.autoUpdate`
等）写 user profile 的 `settings.json`，不落工作区——写工作区会触发
「Unable to write ... to Workspace Setting」报错 toast，污染截图。

## 用法

```bash
# 前置一次性：从当前 HEAD 打扩展包（pnpm compile 已含在 prepublish 里）
pnpm exec vsce package --no-dependencies -o /tmp/kode-gif-capture/kode.vsix

python3 scripts/config-switch-gifs/generate.py --list
python3 scripts/config-switch-gifs/generate.py --all
python3 scripts/config-switch-gifs/generate.py --switch inlay-type-data
```

依赖：`Xvfb`、`xdotool`、ImageMagick（`import`/`convert`/`identify`）、
`ffmpeg`、VS Code CLI。注意 vsix 缓存按路径字符串判重：重建 vsix 后
删掉 `/tmp/kode-gif-capture/vscode-ext/.vsix-installed` 再跑。

## 产物

- `docs/public/config-switch-gifs/<key>.gif` — off→on 对照动图
- `docs/public/config-switch-gifs/<key>-{off,on}.png` — 两态单帧
- `docs/public/config-switch-gifs/manifest.json` — 本次实抓清单

`switches.json` 里 `capture: false` 的开关（生成向导类、设置文件差异类、
需截图中途改文件类）无头跑不出有意义的界面差异，文档页以表格文字说明，
不造假图。
