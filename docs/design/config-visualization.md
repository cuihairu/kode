# 配置合并可视化面板 UI/UX 设计(KODE-CFG-VIZ · Review Draft)

> Status: **review draft**。本文档先于代码;实现启动以评审通过为前提,实现须与
> 本文逐条对齐,并复用仓库既有词汇(`$/kode/config/resolve`、`ConfigResolvedState`、
> `buildConfigTreePair`、`canWriteRefresh`、`SRC-012`、`webviewStrings`、
> `WEBVIEW_THEME_CSS` 等)——不造新词。未实现的面在文中如实标注「本设计提出,
> 未实现」,绝不装扮成已实现。
>
> 任务来源:用户 2026-11-08 原话「config 分类现在只有最终配置,我们讨论说的配置
> 的可视化根本就没有做」。现状入口只有 `kbengine.config.showFinal`
> (`src/serverConfigMerge.ts:313`,注册于 `src/activate/views.ts:337`)——把最终合成
> XML 倾倒进只读虚拟文档;用户看不出哪些键被覆盖、最终值从哪来、默认值是什么。

## 1. 用户问题与目标

### 1.1 问题

KBEngine 运行时配置是两层合成:引擎默认 `kbengine_defaults.xml`(10 个进程段
baseapp/baseappmgr/bots/cellapp/cellappmgr/dbmgr/interfaces/logger/loginapp/machine,
另约 12 个全局段 threads/backup_watch_point/clientactivity 等)+ 用户覆盖文件
`kbengine.xml`(常在 `assets/res/server/kbengine.xml`),进程实跑读的是**最终合成
结果**。现有 UI 只呈现合成结果本身(`kbengine.config.showFinal` 虚拟文档),三个
关键问题无处可看:

1. **哪些键被覆盖了**——用户改了 `kbengine.xml`,但看不出它压掉了哪些默认值;
2. **最终值从哪来**——一个值是引擎默认还是覆盖产物,无从判断;
3. **默认值原本是什么**——想回退一个覆盖时,不知道默认值是多少。

### 1.2 目标

- 一屏回答「每个键:默认值 → 覆盖值 → 最终值,值从哪个文件来」;
- 快速定位被覆盖/新增的键(筛选 + 计数),不必人工 diff 两份 XML;
- 与实跑同源:数据一律来自既有 core 解析链,面板**零二次解析、零编辑**;
- 只读:面板永远不写配置文件(与 `src/playerDataPanel.ts` 的只读铁律同口径)。

### 1.3 非目标

- 不改 `kbengine.config.showFinal` 虚拟文档(保留,面板是补充不是替换);
- 不做配置编辑/写回(编辑属于编辑器本体,面板只读);
- 不迁移任何解析/合成语义进面板——解析归 core(`$/kode/config/resolve`),
  位置/读盘归 TS(`resolveCustomConfigXmlPath`),面板只做消费与呈现
  (config-first.md §3.1 L2 纪律);
- 不做 profile 轴切换 UI(第一版只呈现当前解析态;profile 轴缓存分槽已在
  `serverConfigResolve.ts` 处理,面板不重复造轴)。

## 2. 现状与约束出处(每条约束对应仓库既有模式)

| # | 约束 | 仓库出处(行号 2026-11-09 实测) |
|---|---|---|
| 1 | SRC-012 拆分:控制器(vscodel API/生命周期/消息派发)+ 纯字符串 HTML 模块(无 vscode import,纯函数 state→HTML) | `src/entityDependencyWebViewHtml.ts` 文件头(SRC-012 自 `entityDependencyWebView.ts` 纯移动迁出,「不触 vscode API,与 messageTableRender.ts 同口径」) |
| 2 | 安全:整页 nonce CSP `default-src 'none'`;无外联/无 CDN/无本地媒体;静态插值 escapeHtml;动态数据一律 createElement+textContent | `src/webviewSecurity.ts:35` `webviewScriptCsp`(default-src 'none',图片源默认不开);`:19` `randomNonce`;`:31` `toJsonForScript`(内联 JSON 唯一合法通道);`entityDependencyWebViewHtml.ts:45` `escapeHtml`/`:64` statCard 双面转义 |
| 3 | i18n:全部文案走 `src/webviewStrings.ts`,zh/en 键集合一致(测试强制) | `webviewStrings.ts` 文件头(「tests/webviewStrings.test.ts 强制 zh/en 键集合一致」);每面板一个命名空间的既有惯例(monitoring/logs/telnet/entityDependency/…共 8 个) |
| 4 | 数据流:持久 HTML 壳 + postMessage 增量更新(不整页重绘);`retainContextWhenHidden: true`;代际守卫防旧回包盖新态 | 壳+postMessage 惯例:`src/monitoringWebView.ts:71`(retainContextWhenHidden)/`:105`(postMessage command 派发);代际守卫:`src/entityDependencyWebView.ts:102` `canWriteRefresh`(KODE-PERF-005,三面齐才可写) |
| 5 | 只读 + 零新依赖(无框架/无图表库,纯 DOM+CSS) | `src/playerDataPanel.ts` 文件头(「界面**零编辑字段**」);entityDependency 系面板均为纯 DOM+CSS |
| 6 | 可访问性:键盘可达、focus-visible、ARIA 树/列表/区语义、颜色只作辅助(状态必须有文字)、`var(--vscode-*)`/`var(--kode-*)` 主题 token | `src/webviewTheme.ts:33`(「token 名统一 --kode-* 前缀,面板不再自带色值」);`:51-58` 提供 ok/warn/err/info/neutral 语义色 + dim 变体 |

**数据事实(已核实)**:core RPC `$/kode/config/resolve` 经
`gate.runInRust('$/kode/config/resolve', { defaultsXml, customXml })`
(`src/serverConfigResolve.ts:370`)回包 TS 消费态 `ConfigResolvedState`
(`src/serverConfigResolve.ts:53`):含 `defaultsTree` / `customTree` / `merged`
三棵 `ConfigXmlNode` 树 + 双方路径;每个节点自带 `sourceComments`
(`src/serverConfigMerge.ts:43`,KODE-CFG-010 解析期捕获的输入 XML 原文注释,按
归属规则挂节点;MCP `why_setting` 已把 sourceComments 用作出处交叉佐证,
todo.md CFG-018)。**每键「defaults vs override」出处可由三树对比纯投影得出**
——扩展已算好全部所需数据,本面板不新增任何解析面。

## 3. 信息架构

### 3.1 规模与分组

约 10 个进程段 + 约 12 个全局段、每段几十键、合计数百键。分组主轴沿用文案库
既有口径:**顶层段名 = 进程名,分组主轴 = 进程**(`src/serverConfigCatalog.ts`
`SERVER_CONFIG_GROUPS`/`SERVER_CONFIG_GROUP_ORDER`,config-first.md §2.1 #16-18)。
面板把顶层段分两组呈现:进程段 / 全局段——与服务器运维心智模型一致(先找进程,
再找键),也与文案库/监控面板的分组惯性一致。

### 3.2 导航模型候选

| 方案 | 形态 | 优点 | 缺点 |
|---|---|---|---|
| A 三栏常驻 | 段树 + 键表 + 详情同屏 | 一次看全 | webview 面板宽度被切三份,键表列宽不足;三焦点区 Tab 路径长,ARIA 结构最复杂 |
| **B 两栏 + 常驻详情(推荐)** | 左段树(定宽)+ 右侧上下结构:上键表(flex)+ 右详情列(定宽,常驻占位) | 主任务(扫覆盖)与次任务(看单键)分区明确;详情列常驻占位避免点击时布局跳动(布局稳定优于「点开才出现」);渐进披露:详情内容由选择驱动 | 首屏多一个占位态(用引导文案消化) |
| C 单栏手风琴 | 段折叠 + 行内展开详情 | 实现最简 | 数百键下滚动深度大;「只看被覆盖」筛选与跨段搜索没有着落;详情埋进行内,三值对照缺稳定比较面 |

**推荐 B**,理由:

1. 核心任务是「扫描哪些键被覆盖」(列表任务)+「理解某一个键的三值故事」(详情
   任务),二者交替发生——B 把两任务各给一个稳定区域,ACD 认知负担最小;
2. 三值对照(默认/覆盖/最终)需要**稳定比较面**:C 的行内展开会让三值区域随滚动
   消失,A 的宽度挤压让三列并排变成换行堆叠;
3. 键盘路径短:段树 → 键表 → 详情,两跳到达任意键(Fitts:目标区域大且相邻)。

### 3.3 布局线框(ASCII)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 配置合并可视化  [Rust 核心]   [搜索键名_______________] [全部|覆盖|新增|默认] [刷新] │
│ defaults: …/kbe/res/server/kbengine_defaults.xml · kbengine.xml: …/res/server/…  │
├──────────────┬────────────────────────────────────────────┬──────────────────────┤
│ ▾ 进程段      │  baseapp(87 键 · 覆盖 5 · 新增 1)           │  键详情               │
│   baseapp  5▸│  ┌───────────────────────────────────────┐ │                      │
│   baseappmgr0│  │ 键                最终值        状态    │ │  (未选中占位:)        │
│   bots     0 │  │ gatewayPort       27016       [覆盖]  │ │  在键列表中选择一个键, │
│   cellapp  2▸│  │ backupPeriod      300         [默认]  │ │  查看默认值、覆盖值与   │
│   …          │  │ telnet_service    ●           [新增]  │ │  最终值对照。          │
│ ▾ 全局段      │  │ …                                     │ │                      │
│   threads  0 │  └───────────────────────────────────────┘ │                      │
│   …          │                                            │                      │
├──────────────┴────────────────────────────────────────────┴──────────────────────┤
│ ⚠ defaults-only 警示条(仅该态出现,见 §5.4)                                       │
│ 状态栏: 10 进程段 + 12 全局段 · 486 键 · 覆盖 23 · 新增 2                          │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- 段树节点格式:`段名 + 覆盖/新增计数`(计数 > 0 才显示,数字是筛选的入口暗示);
- 键列表标题行显示当前段名 + 三种计数(与树一致,双处呈现防迷路);
- 详情列常驻,未选中时渲染引导占位(不隐藏、不跳动)。

## 4. 每键三态呈现

### 4.1 三态判定(纯投影,逐键)

对 `defaultsTree` / `customTree` / `merged` 做同路径对比(合成语义 =
config-first.md §2.1 `mergeConfigXml`:子节点按名对齐,覆盖命中 → **整名替换**,
两侧皆有子 → 递归;重名 `<item>` = 整表替换):

| 状态 | 判定 | 徽标(文字,不靠颜色) | 颜色 token | 形状 |
|---|---|---|---|---|
| 仅默认 | defaults 有此键,custom 无 | `默认` | `var(--kode-neutral)` + `--kode-neutral` dim 底 | 圆点徽标 ◦ |
| 被覆盖 | 两侧皆有,merged 叶值 ≠ defaults 叶值 | `覆盖` | `var(--kode-info)` + `--kode-info-dim` 底 | 方角徽标 ▐ |
| 仅覆盖文件新增 | custom 有此键(merged 同),defaults 无 | `新增` | `var(--kode-ok)` + `--kode-ok-dim` 底 | 圆角徽标 ● |

三态可同时被文字徽标 + 形状 + 颜色区分(不依赖颜色的检验项满足);色值全部取自
`src/webviewTheme.ts:51-58` 既有语义 token,不新增色值。

**第四子态「显式重申」**:custom 里有此键但值与 defaults 相同(覆盖命中但值没
变)。徽标仍归 `覆盖`(主轴只有三态,与任务口径一致),但在键详情区出一条说明行
「覆盖值与默认值相同(显式重申,以覆盖文件为准)」——如实,不把重申伪装成有效
修改,也不静默吞掉。

### 4.2 合成语义带来的判定细则(如实呈现,不含糊)

1. **容器整名替换**:覆盖文件替换了某容器段(如整段 `<telnet_service>`)时,该
   容器下**全部叶键**的 merged 子树都来自覆盖侧——投影按此标注(每个叶都标
   `覆盖`/`新增`),这与引擎实际读取行为一致,不做「看起来只改了一个键」的假象;
2. **重名 `<item>` 整表替换**(config-first.md §2.1):被整表替换的表内所有条目
   标 `覆盖`,并在详情注明「重名 item 整表替换」;
3. **defaults 缺失解析**(defaultsTree=null):无从对比,整体进入 §8 的
   empty/error 态,不伪造三态。

### 4.3 键详情区线框(ASCII)

```
┌─ 键详情 ──────────────────────────────────────────┐
│ baseapp › gatewayPort                     [覆盖]▐  │
│ 含义: baseapp 网关监听端口(文案库 zh 说明)          │
│ 文案出处: kbengine_defaults.xml:618                │
│ ┌────────────────────────────────────────────────┐│
│ │ 默认值   27015                                  ││
│ │ 覆盖值   27016     ← 来自 assets/res/server/…   ││
│ │          /kbengine.xml                          ││
│ │ 最终值   27016                                  ││
│ │          (最终值 = 进程实跑读取的合成结果)        ││
│ └────────────────────────────────────────────────┘│
│ 源注释(输入文件原文):                              │
│   <!-- 生产网关端口,与 firewall 联动 -->            │
│ [复制最终 XML 片段]  [打开 kbengine.xml]            │
└────────────────────────────────────────────────────┘
```

- **含义/文案出处**:复用 `src/serverConfigCatalog.ts` 文案库(zh/en 双语 +
  `source` 的 `file:line` 权威出处,255 条;查询走既有
  `findServerConfigItemDoc`,未知键如实回落「文案库未收录」,不编文案);
- **源注释**:该节点 `sourceComments` 逐条原文展示(parse 期捕获,非面板生成);
- **复制最终 XML 片段**:用既有 `renderConfigXml`(`src/serverConfigMerge.ts:60`,
  tab 缩进 + 源注释回写口径)对该子树产片段,经 `vscode.env.clipboard.writeText`
  写剪贴板(写剪贴板不是写文件,只读铁律不破);
- **打开来源文件**:defaults/custom 两个按钮按需出现(custom 不存在时不渲染),
  走 `openTextDocument` 只读打开(先例:`entityDependencyWebView.ts` openNode)。

## 5. 交互设计

### 5.1 搜索与筛选(全部前端本地计算,零 per-keystroke RPC)

| 交互 | 行为 |
|---|---|
| 搜索框(键名) | 150ms 防抖,子串匹配,**跨段全局搜索**:命中键以平铺列表呈现并附段名列;选中命中项 → 段树定位高亮 + 详情打开。清空恢复段浏览 |
| 筛选片(全部/只看被覆盖/只看新增/只看默认) | 与搜索叠加,作用于当前呈现的列表(段内或搜索结果);计数徽标(树 + 列表头)是筛选入口暗示 |
| 段树点击 | 切换键列表到该段(懒加载该段键,见 §6);当前段高亮 |
| 键行点击/Enter | 详情列更新为该键三值对照 |
| 刷新 | 走完整 resolve 链路重取(代际守卫,见 §5.5) |

搜索/筛选在**已加载的段数据**上本地计算;跨段全局搜索只匹配已加载段的键——第一
版如实标注「搜索范围为已加载段」还是预载全量?**决定:面板打开即预载全部段的键
清单**(数百键的轻量 DTO,一次 resolveState 附带;详情/片段才懒加载)——全局搜索
因此无死角,增量纪律不破(键列表/详情仍按需)。`retainContextWhenHidden: true`
保证切走再切回不重取不重绘(monitoringWebView.ts:71 先例)。

### 5.2 键盘操作表

| 键 | 作用域 | 行为 |
|---|---|---|
| Tab | 全局 | 搜索框 → 筛选片 → 刷新 → 段树 → 键列表 → 详情动作按钮 |
| ↑/↓ | 段树 | 移动段选择(roving tabindex) |
| ↑/↓ | 键列表 | 移动键选择;Enter/Space 打开详情 |
| Enter/Space | 筛选片/按钮 | 激活 |
| Esc | 搜索框 | 清空搜索并还原列表 |
| Esc | 面板 | 无模态浮层;详情无关闭概念(常驻),Esc 不做隐藏以免焦点丢失 |

### 5.3 无自定义 kbengine.xml(defualts-only 降级态)

`customTree === null` 即 defaults-only(判定沿用 `src/playerDataPanel.ts:117`
同款口径)。面板照常呈现全部键(全部标 `默认`),但顶部出**诚实警示条**,文案
对齐 `PLAYER_DATABASE_DEFAULTS_ONLY_WARNING`(`src/playerDataPanel.ts:153`)的
口径——**绝不把引擎默认值装扮成最终合成配置**:

> 未发现元件 kbengine.xml,以下各键均为引擎默认值(kbengine_defaults.xml)而非
> 最终合成配置;若实际部署使用自定义配置,请把 kbengine.xml 放到 assetsRoot 的
> res/server/ 下(或检查 kbengine.assetsRoot 设置)后点刷新。

同时:头部双路径行 custom 显示「(未发现)」,筛选片「只看被覆盖/只看新增」置灰
并给计数 0。

### 5.4 Rust 核心不可用(TS 兜底路径)

`ensureConfigResolved()` 回包 `ok:false`(gate 未接线 / RPC 失败,
`src/serverConfigResolve.ts:366-388` 的降级口径)时,控制器回落 TS 侧既有
`buildConfigTreePair()`(`src/serverConfigMerge.ts:187`)——TS 解析路径在
config-first.md §6.2 迁移期内保留为兜底/兼容面,三树对比投影对两条路径同样适用。
呈现:头部徽标从 `Rust 核心` 换为 `TS 兜底`(徽标词沿用 entityDependency 面板
既有徽标口径)+ 一条说明条「Rust 核心不可用,以下由 TS 兜底路径解析」。两条路径
都失败才进 §8 error 态。

### 5.5 刷新与代际守卫

两级代际,各守各的:

1. **数据代际**:`ConfigResolvedState.generation`(root config generation;
   watcher `**/kbengine*.xml` / 设置变化 → bump,extension.ts 既有接线)——resolve
   回包代际落后即弃,不落槽(serverConfigResolve.ts 既有 stale 复核口径);
2. **绘制代际**:面板控制器持 `refreshGeneration`,新一代刷新开始自增;回包写入面
   `canWriteRefresh(generation)` 三面齐(代际最新 + 面板在 + 状态机未换代)才
   postMessage,旧代结果整体弃置——**原样套用 KODE-PERF-005 的
   `canWriteRefresh` 模式**(`src/entityDependencyWebView.ts:102`),不发明新
   守卫。

## 6. 消息协议提案

约定:沿用面板既有 `{ command: string, ... }` 消息形(entityDependency/
monitoring 同口径);回包一律 `result: { ok: true; data: T } | { ok: false;
error: string }`(仓库错误面惯例:core 门 `outcome.ok/reason`、kode-mcp 同形)。
所有 extension→webview 回包带 `generation`(绘制代际),前端丢弃过期回包。

```ts
/** webview → controller */
export type ConfigVizInbound =
  | { command: 'ready' }                                          // 壳加载完成,请求初始数据
  | { command: 'refresh' }
  | { command: 'selectSection'; sectionId: string }               // 段切换 → 键清单回包
  | { command: 'selectKey'; sectionId: string; path: string }     // 键选中 → 详情回包
  | { command: 'copyFragment'; sectionId: string; path: string }  // 复制 → copyDone 回包
  | { command: 'openSource'; file: 'defaults' | 'custom' };

/** controller → webview */
export type ConfigVizOutbound =
  | { command: 'resolveState'; generation: number; result: ConfigVizResult<ConfigVizSummary> }
  | { command: 'sectionKeys'; generation: number; result: ConfigVizResult<ConfigVizSection> }
  | { command: 'keyDetail'; generation: number; result: ConfigVizResult<ConfigVizKeyDetail> }
  | { command: 'copyDone'; generation: number; result: ConfigVizResult<{ path: string }> };

export type ConfigVizResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** 键三态(主轴三态;显式重申用 restated 标注,不扩主轴) */
export type ConfigKeyState = 'defaults-only' | 'overridden' | 'custom-only';

/** resolveState 回包:全量段清单 + 键 DTO(一次附全,支撑本地搜索) */
export interface ConfigVizSummary {
  source: 'rust' | 'ts';              // 徽标:Rust 核心 / TS 兜底
  defaultsOnly: boolean;              // customTree === null(诚实警示条)
  defaultsPath: string | null;
  customPath: string | null;
  groups: Array<{
    id: 'process' | 'global';
    sections: Array<{
      id: string;                     // 段名(baseapp / threads / …)
      keyCount: number;
      overrideCount: number;          // 覆盖(含显式重申)
      customOnlyCount: number;
      keys: ConfigVizKeyEntry[];      // 全量键 DTO(轻量;详情/片段懒取)
    }>;
  }>;
}

export interface ConfigVizKeyEntry {
  path: string;                       // 点分路径(段内相对,如 'gatewayPort')
  name: string;
  state: ConfigKeyState;
  restated: boolean;                  // 覆盖值 === 默认值(显式重申)
  finalValue: string;                 // merged 叶值(截断策略见 §6.1)
}

/** selectKey 回包:三值对照 + 出处 + 片段 */
export interface ConfigVizKeyDetail {
  sectionId: string;
  path: string;
  state: ConfigKeyState;
  restated: boolean;
  defaultValue: string | null;        // 仅覆盖新增 → null
  overrideValue: string | null;       // 仅默认 → null
  finalValue: string;
  sourceComments: string[];           // 该节点 sourceComments 原文(resolve 树自带)
  catalogDoc: string | null;          // 文案库含义(按 locale);未收录 → null(如实)
  catalogSource: string | null;       // 文案出处 file:line(kbengine_defaults.xml:618 形)
  fragmentXml: string;                // renderConfigXml 子树片段(复制用)
  mergedByTableReplace?: boolean;     // 重名 <item> 整表替换标注(§4.2-2)
}
```

### 6.1 协议细则

1. **长值截断**:键列表的 `finalValue` 超过 120 字符截断 + 尾注 `…(N 字符)`;
   详情区三值**不截断**(完整呈现,滚动查看)——列表保扫读、详情保真相,绝不静默
   丢内容(entityDependency 截断警告条同口径:如实,不装完整);
2. **generation 回带**:extension→webview 每个回包的 `generation` 是面板绘制代际;
   前端只认最新代,旧代 `sectionKeys`/`keyDetail` 丢弃(与控制器写入面
   `canWriteRefresh` 双保险);
3. **错误面**:resolveState 失败 `{ ok:false, error }` 携带可读原因(透传
   `ConfigResolvedState.reason` 口径);面板进 error 态并保留上一份 ready 数据
   (§8-6);
4. **复制落点**:copyFragment 由控制器执行 `vscode.env.clipboard.writeText`
   (webview 内联脚本不直写剪贴板,动作留在 controller 侧,与 openNode 先例一致)。

## 7. 文案计划(webviewStrings 键表)

新增命名空间 `configVisualizer`,zh/en 键集合一致(`tests/webviewStrings.test.ts`
既有强制覆盖新命名空间)。以下为全量可见文案(函数形键沿用 strings 表既有惯例,
如 `monitoring.historyWindow`):

| key | zh | en |
|---|---|---|
| title | 配置合并可视化 | Config Merge Visualization |
| sourceBadgeRust | Rust 核心 | Rust core |
| sourceBadgeTs | TS 兜底 | TS fallback |
| searchLabel | 搜索键名 | Search keys |
| searchPlaceholder | 搜索键名… | Search keys… |
| filterLabel | 筛选 | Filter |
| filterAll | 全部 | All |
| filterOverridden | 只看被覆盖 | Overridden only |
| filterCustomOnly | 只看新增 | Custom only |
| filterDefaultsOnly | 只看默认 | Defaults only |
| refresh | 刷新 | Refresh |
| groupProcess | 进程段 | Process sections |
| groupGlobal | 全局段 | Global sections |
| colKey | 键 | Key |
| colFinalValue | 最终值 | Final value |
| colState | 状态 | State |
| stateDefaultsOnly | 默认 | default |
| stateOverridden | 覆盖 | overridden |
| stateCustomOnly | 新增 | custom |
| restatedNote | 覆盖值与默认值相同(显式重申,以覆盖文件为准) | Override equals the default (explicit restatement; the override file wins) |
| tableReplaceNote | 重名 item 整表替换(引擎按名整体替换) | Duplicate `<item>` replaces the whole table (engine replaces by name) |
| sectionTreeLabel | 配置段 | Config sections |
| keyListLabel | 键列表 | Key list |
| detailRegionLabel | 键详情 | Key details |
| detailPlaceholder | 在键列表中选择一个键,查看默认值、覆盖值与最终值对照。 | Select a key to compare its default, override and final values. |
| detailDefaultValue | 默认值 | Default |
| detailOverrideValue | 覆盖值 | Override |
| detailFinalValue | 最终值 | Final |
| detailFinalNote | 最终值 = 进程实跑读取的合成结果 | Final value = the merged result processes actually read |
| detailFromDefaults | 来源:引擎默认 kbengine_defaults.xml | Source: engine defaults kbengine_defaults.xml |
| detailFromCustom | 来源:元件 kbengine.xml 覆盖 | Source: overridden by component kbengine.xml |
| detailCustomOnlyNote | 该键仅存在于覆盖文件,引擎默认中没有此键 | This key exists only in the override file; the engine defaults have no such key |
| detailDoc | 含义 | Meaning |
| detailDocMissing | 文案库未收录该键 | Not documented in the catalog |
| detailDocSource | 文案出处 | Doc source |
| detailSourceComments | 源注释(输入文件原文) | Source comments (verbatim from the input file) |
| copyFragment | 复制最终 XML 片段 | Copy final XML fragment |
| copyDone | 已复制最终 XML 片段 | Final XML fragment copied |
| copyFailed: (error) => … | 复制失败:{error} | Copy failed: {error} |
| openDefaultsFile | 打开 defaults 文件 | Open defaults file |
| openCustomFile | 打开 kbengine.xml | Open kbengine.xml |
| sectionMeta: (keys, overridden, customOnly) => … | {keys} 键 · 覆盖 {overridden} · 新增 {customOnly} | {keys} keys · {overridden} overridden · {customOnly} custom |
| statusSummary: (sections, keys, overridden, customOnly) => … | {sections} 段 · {keys} 键 · 覆盖 {overridden} · 新增 {customOnly} | {sections} sections · {keys} keys · {overridden} overridden · {customOnly} custom |
| loading | 正在解析配置… | Resolving config… |
| emptyNoWorkspace | 未打开工作区,无法定位配置文件。 | No workspace folder open; config files cannot be located. |
| emptyNoConfig | 未找到 kbengine_defaults.xml(检查 kbengine.binPath / kbengine.assetsRoot 设置)。 | kbengine_defaults.xml not found (check kbengine.binPath / kbengine.assetsRoot settings). |
| defaultsOnlyWarning | 未发现元件 kbengine.xml,以下各键均为引擎默认值(kbengine_defaults.xml)而非最终合成配置;若实际部署使用自定义配置,请把 kbengine.xml 放到 assetsRoot 的 res/server/ 下(或检查 kbengine.assetsRoot 设置)后点刷新。 | No component kbengine.xml found; every value below is the engine default (kbengine_defaults.xml), not the final merged config. If your deployment uses a custom config, place kbengine.xml under assetsRoot's res/server/ (or check the kbengine.assetsRoot setting) and refresh. |
| rustUnavailableNote | Rust 核心不可用,以下由 TS 兜底路径解析。 | Rust core unavailable; the TS fallback path produced the data below. |
| errorState | 配置解析失败 | Config resolution failed |
| retry | 重试 | Retry |
| searchResultHeading | 搜索结果 | Search results |
| noSearchHits | 无匹配键 | No matching keys |
| valueTruncated: (n) => … | …(共 {n} 字符,详情区可见完整值) | …({n} chars total; full value shown in details) |

## 8. 状态清单

| # | 状态 | 进入条件 | 渲染 |
|---|---|---|---|
| 1 | loading | 壳已渲染,resolveState 未回 | 壳 + 状态行「正在解析配置…」(`role="status"`);不渲染任何键数据 |
| 2 | ready | resolveState ok 且非 defaults-only | §3.3 全布局;徽标 Rust 核心/TS 兜底(随 source) |
| 3 | empty · 无工作区 | workspaceFolders 空 | 空态文案 emptyNoWorkspace;树/表/详情全部占位,刷新仍可点(打开工作区后可重试) |
| 4 | empty · 无配置文件 | defaultsTree=null(customPath 亦空) | 空态文案 emptyNoConfig;不伪造三态(§4.2-3) |
| 5 | defaults-only | customTree === null(路径存在与否均可) | ready 布局 + 诚实警示条(§5.3);全部键标 `默认`;覆盖/新增筛选置灰 |
| 6 | ts-fallback | resolve ok=false → TS buildConfigTreePair 成功 | ready 布局 + 徽标 TS 兜底 + rustUnavailableNote 说明条 |
| 7 | error | 两条路径皆失败 | 保留上一份 ready 数据(若有)+ 顶部错误条(errorState + 可读 error)+ 重试按钮;无历史数据则错误条 + 重试占位。刷新失败不吞键——错误必须可见,旧数据标注「来自上次成功解析」 |

## 9. 可访问性清单(本面板专项)

- [ ] 键盘全流程可达:搜索 → 筛选片 → 刷新 → 段树(↑/↓)→ 键列表(↑/↓ +
      Enter/Space)→ 详情动作按钮,Tab 顺序固定且与视觉顺序一致;
- [ ] 段树 `role="tree"` / `treeitem` / `group` + `aria-expanded`;键列表
      `role="listbox"` + `option` + `aria-selected` + `aria-activedescendant`;
      详情区 `role="complementary"` + `aria-labelledby`(文案键
      sectionTreeLabel/keyListLabel/detailRegionLabel 供 aria-label 用);
- [ ] 三态不靠颜色单通道:徽标文字(默认/覆盖/新增)+ 形状差异同时存在(§4.1);
- [ ] `:focus-visible` 焦点环(2px `var(--kode-accent)` outline),鼠标点击不显环;
- [ ] 复制结果经单一 `role="status"` `aria-live="polite"` 区播报(copyDone/
      copyFailed),播报区不复用为警示条(避免互相吞播报);
- [ ] Esc 清搜索;无模态浮层、无闪烁内容;loading/error 态用 `role="status"`
      播报而非抢焦点;
- [ ] 颜色/字号全部走 `var(--kode-*)` / `var(--vscode-*)` token
      (webviewTheme.ts 纪律),不新增硬编码色值;字号用既有 `--kode-t-*` 档位,
      随 webview 缩放正常;
- [ ] 文案全部走 webviewStrings(zh/en 同集合),lang 属性随 locale
      (`htmlLang()`);对比度不达标组合(如 dim 底 + fg-4 字)不用于正文。

## 10. 实现拆分建议(不写实现代码)

| 文件 | 新/旧 | 职责 | 复用 |
|---|---|---|---|
| `src/configVisualizerModel.ts` | 新 | 纯投影:三树 → 每键三态 DTO(§4.1 判定 + §4.2 细则)+ 详情装配(三值/片段/文案/源注释) | `ConfigXmlNode`(serverConfigMerge.ts:32)、`renderConfigXml`(:60)、`findServerConfigItemDoc`(serverConfigCatalog)、`ConfigResolvedState` 字段 |
| `src/configVisualizerPanelHtml.ts` | 新 | SRC-012 字符串半边:整页壳 HTML/CSS/内联客户端脚本生产(纯函数,无 vscode import) | `WEBVIEW_THEME_CSS`(webviewTheme)、`strings(resolvePanelLocale())`(webviewStrings)、`webviewScriptCsp`/`randomNonce`/`toJsonForScript`(webviewSecurity)、`escapeHtml`(entityDependencyWebViewHtml.ts:45 同实现) |
| `src/configVisualizerPanel.ts` | 新 | 控制器:WebviewPanel 生命周期(`retainContextWhenHidden: true`)、消息派发 switch、两级代际守卫(§5.5)、resolve + TS 兜底分流、剪贴板/打开文件动作 | `ensureConfigResolved`/`configTreePairFromState`(serverConfigResolve.ts:297/:83)、`buildConfigTreePair`(serverConfigMerge.ts:187)、`canWriteRefresh` 模式(entityDependencyWebView.ts:102) |
| `src/webviewStrings.ts` | 改 | 增 `configVisualizer` 命名空间(zh+en,§7 全表) | 既有 zh/en 平行结构 |
| 命令注册 | 改 | `kbengine.config.visualize`(标题「配置合并可视化」)入 package.json contributes + activate/views.ts(先例 :337);showFinal 原样保留 | — |
| `tests/configVisualizerModel.test.ts` | 新 | 投影判定:三态 + 显式重申 + 容器整名替换 + `<item>` 整表替换 + 长值截断;Rust/TS 两路同投影一致 | `tests/helpers/configCoreContract.ts` 树构造 |
| `tests/configVisualizerPanelHtml.test.ts` | 新 | 壳安全面:nonce/CSP 串、静态插值全转义、壳内不含任何键值数据、无 vscode import(静态断言) | 既有 webview 面板测试形态 |

约束重申:零新依赖(package.json 零改动为验收项);面板对配置文件**零写操作**
(控制器 API 面审计无 `workspace.fs.writeFile`);数据一律出自既有 resolve 链,
面板不含第二套解析。

## 11. 验收清单(可测断言)

- [ ] 壳 HTML(以含哨兵键值的 fixture 渲染)中**不出现**任何键名/键值——数据只经
      postMessage 达前端(§6 纪律的可测化);
- [ ] 壳 CSP 串等于 `webviewScriptCsp(nonce, [cspSource])`:`default-src 'none'`,
      无 img-src、无 CDN、未注册 localResourceRoots;
- [ ] 客户端脚本对 resolve 数据只用 createElement/textContent 路径(HTML 模块
      单测:含 `<script>`/引号 fixture 的键名/键值渲染后按文本出现,不产生元素);
- [ ] webviewStrings parity:zh/en `configVisualizer` 键集合一致(既有 parity
      测试自动覆盖新命名空间);
- [ ] 三态判定:defaults-only / overridden / custom-only / 显式重申 / 容器整名替换 /
      `<item>` 整表替换各有一例断言,且 Rust 与 TS 两路输入投影结果一致;
- [ ] defaults-only:`customTree=null` 时警示条可见、全部键标「默认」、覆盖/新增
      筛选置灰(断言文案 + 状态);
- [ ] ts-fallback:resolve `ok:false` 时徽标 TS 兜底 + 说明条可见,数据来自
      buildConfigTreePair(断言徽标与数据源标记);
- [ ] 代际守卫:并发两次 refresh,旧代 `sectionKeys`/`keyDetail` 回包不落 UI
      (controller 单测,fake webview 收信断言);
- [ ] 截断:列表 >120 字符值截断 + 字符数尾注,详情区同一键完整值可见;
- [ ] 复制片段:`copyFragment` 回包后的剪贴板内容 === `renderConfigXml` 对该子树
      的输出;copyDone/copyFailed 均经 aria-live 区播报;
- [ ] 状态矩阵:§8 七态各有渲染断言(loading/ready/两 empty/defaults-only/
      ts-fallback/error);
- [ ] 只读:controller 公开面无任何配置文件写调用(审计断言);剪贴板与
      openTextDocument 是仅有的两个出面板副作用;
- [ ] 零新依赖:package.json 不变(diff 断言);
- [ ] i18n 与 lang:locale=zh 渲染 `lang="zh-CN"`,en 渲染 `lang="en"`,界面无
      硬编码文案字符串(grep 断言 HTML 模块不含中文字面量,除注释)。
