# config-switch-gifs — 配置开关效果截图流水线（C-24）

对扩展每个「开启后看得见效果」的配置开关：驱动真实 VS Code（Xvfb + 打包
扩展）先关后开各截一张窗截图，帧差断言 off/on 确有差异，ffmpeg 缝成循环
GIF，产物落 `docs/public/config-switch-gifs/`，清单写 `manifest.json`；
`render_docs.py` 据两份 JSON 生成双语文档页 `docs/guide/config-effects.md`
与 `docs/zh/guide/config-effects.md`。流水线可重跑，兼作配置效果回归测试——
开关效果失效时前后帧完全一致，`frames_differ` 直接报红。

## 依赖

- Xvfb、xdotool、ImageMagick（`import`/`convert`/`identify`）、ffmpeg
- VS Code CLI（`code`）在 PATH
- 扩展 vsix（缺省 `$CAP/kode.vsix`，`--vsix` 可指定；仓库 `vsce package` 产出）
- `show-final-config-on-open` 额外依赖 kode-server 二进制（CFG-009 起
  最终配置合成走 `$/kode/config/resolve`，TS 无本地回退），见下
  `KODE_SERVER_PATH`

## 用法

```bash
# 列清单
python3 scripts/config-switch-gifs/generate.py --list

# 逐个出图（key 见 --list；单态调试加 =off/=on 后缀配 --keep）
python3 scripts/config-switch-gifs/generate.py --switch=codelens-rpc

# 全量重跑（顺序逐开关，每开关独立起 VS Code）
python3 scripts/config-switch-gifs/generate.py --all --vsix /path/kode.vsix

# 文档页再生成（不截图，只按两份 JSON 重排页面）
python3 scripts/config-switch-gifs/render_docs.py
```

## 环境变量（多会话/多树隔离）

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `KODE_GIF_CAP` | `/tmp/kode-gif-capture` | 截图工作区（vscode-profile、staged workspace、frames） |
| `KODE_GIF_DISPLAY` | `:99` | Xvfb 显示号 |
| `KODE_SERVER_PATH` | `<repo>/target/debug/kode-server` | final-config 开关拉起的 kode-server；二进制必须含 `$/kode/config/resolve`（`strings` 可查，旧构建没有——`cargo build -p kode-server` 后确认） |

## 产物契约

- `docs/public/config-switch-gifs/<key>-off.png` / `<key>-on.png` /
  `<key>.gif`（call-chain-view 两态名为 `-text`/`-graph`，随 switches.json
  的 `off`/`on` 字段）
- `docs/public/config-switch-gifs/manifest.json`：每可截图开关一条
  `{key, off, on, gif}`，路径一律 repo 相对（换机重跑不腐化）
- `tests/configSwitchGifs.test.ts`：三方一致性闸（清单 setting ⊆
  package.json contributes、off≠on、capture=true ⇒ 产物+manifest 齐、
  文档页覆盖全部开关）

## 口径

- `switches.json` 是唯一清单：每个开关标注 setting、off/on 状态值、
  中英文名与效果文案、分组、`capture`（true=流水线出图；false=无静态
  截画面，进文档页文末手工验证清单，不配图不编造）。
- 截图就绪判定与帧差默认用标准文字区（`TEXT_CROP`）；悬停卡片/CodeLens/
  inlay/final-config 等渲染在编辑器顶部或短文件的开关用加高区
  （`HOVER_CROP`）。空白帧绝不落盘（60s 就绪超时即失败）。
- 绝不把 RMSE≈0 当成功：前后帧几乎一致 = 效果未生效或未画进判定区，
  直接 SystemExit，宁可失败不产假图。
