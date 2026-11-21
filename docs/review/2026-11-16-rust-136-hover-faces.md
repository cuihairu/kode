# RUST-136 第一增量:hover 来源 / 可用分面 / 注释 三面

日期:2026-11-16
账本:todo.md RUST-136(旧 LSP-003「Hover 展示完整类型、来源、可用分面、
版本与注释,严禁阻塞等待全局索引」)。
基础版(PR-010 响应链:定位/签名/继承链/成员展开)已在库;本批交付五名词中
的三个,余两个如实登记(见诚实边界)。

## 落地面(零 IO 红线保持)

1. **来源 source{file,line}**:HoverResponse 恒在键(每 face 皆有)。
   file = 悬停文档 canonical 路径(golden 语境 = 语料键相对路径,与
   golden files[].file 同源);line = 命中声明行(1 基)。各 face 的 find
   都是 `x.line == line1`,line 恒取 line1。定位只在本文件声明符号上成立,
   「悬停词所在文档即声明文档」语义诚实。
2. **可用分面**:实体本体面(defEntity)signature.facets = 本 def 方法三段
   非空段(base→cell→client 固定序,`entity_facets`);其余面恒空数组
   (键恒在)。方法面 markdown 增 **Facet** 行 = symbol.facet(既有结构面,
   Base/Cell/ClientMethods 三段此前在 markdown 被折叠成「方法区块」,现在
   具体段可见)。markdown 实体面增 **Facets** 行。继承面方法不入本面
   (链上成员已逐祖先携带 facet)。
3. **注释 comment**:signature.comment = 声明紧邻上方的 `<!-- -->` 块
   (`preceding_comment`):自上一行向上扫,空白行可间隔,遇首个非注释内容
   行即停;跨行注释(`<!--` 开 `-->` 闭分行)向上续;逐行去标记后 trim,
   块首尾空行丢,多行 '\n' 连接;`-->` 不在行尾也切片安全(取 `<!--` 后
   首个 `-->`);畸形未闭合到文件顶按已收内容返回(不抬高成错误)。声明行
   自身的同行尾注释不在扫描域。markdown 三段渲染路径(属性/方法早退 +
   通用尾)共享 `append_doc_block`,**Doc** 引用块逐行渲染,所有 face 出现。

markdown 增行:**Source**(`file:line`,头部之后)、方法 **Facet**、实体
**Facets**、尾 **Doc** 引用块。golden 重生成(107 hovers 总数不变):
source 107/107、comment 6(含 types.xml 跨行注释)、facets 13——非空洞。

## 对拍与测试

- golden `hover-parity.json` 再生成;`hover_golden_matches_regenerated_dump`
  绿;TS `kodeHoverParity.test.ts` 逐 hover 深等镜像(TS 复算补
  precedingComment/entityFacets/source 同算法,4/4 绿)。
- hover_units +2:`rust136_source_facet_comment_faces_are_populated`(三面
  populated + markdown 行)、`rust136_comment_gap_and_content_stop_rules`
  (空行隔断可收/内容行隔断不借/跨行 '\n' 连接)。
- prove-red 四靶(cp 备份 + python 变异 + cmp 字节还原,全闭环):
  ①Rust `entity_facets` 恒空 → golden 红;②Rust `preceding_comment` 恒
  None → golden 红;③TS `precedingComment` 恒 null → parity 红;④TS
  source.line 恒 0 → parity 红。还原后全绿。
- 坑:clippy `while_let_loop` 打回(`loop { let Some(..) else break }`
  → `while let` 重铸,golden 重 dump `cmp` 字节稳定后复绿);TS 镜像初版
  `lastIndexOf('<!--')+4` 在无标记时 -1+4=3(Rust 是 `unwrap_or(0)`),
  对拍写镜像时当场修掉。

## 诚实边界(两个名词未做,不装)

- **版本**:语料(def/XML)无引擎版本可推导;引擎版本 = TS
  `kbengine.engineVersion` 项目声明口径(RUST-113 已立),供给 hover 需要
  请求参数/镜像链路设计,归 RUST-113 域接线,本批不猜不装。
- **完整类型**:属性 Type = `<Type>` 首 token(与既有一致);types.xml
  解析展开(FIXED_DICT 逐字段名)需 kode_parser TypeDecl 增字段名
  (现只有 field_refs 类型引用),留 parser 模型扩展续批。
- markdown 属性/方法面的「与 TS getSymbolHover 逐字节同」措辞为 PR-012
  历史门;现 TS 侧悬停已独立演化(同步方向/调用方向/数据库存储行为 TS
  fallback 自有面),无字节级双向门在守,本批不动 TS fallback 面;结构面
  对拍(golden↔TS 复算)是唯一活门。

## 门禁

clippy --workspace --all-targets -D warnings = 0;cargo test --workspace
RC=0(167 suites ok,hover_units 29 例);pnpm lint 0;pnpm compile 0;
vitest 全量 10348 + 8 skipped RC=0(含 kodeHoverParity 4 例);xvfb-run -a
npm run test:demo:editor RC=0。

## 增量⑤:引擎版本行落状态栏 tooltip(2026-11-21 用户拍板改道)

背景:增量④ 裁定 hover 版本行无消费者(任务书「Hover…版本」措辞溯源
KODE_2_COMPLETE_TODO.md 整合书,非用户逐字需求)→ 作废不做;改道=引擎版本
属**环境信息**,落 kodeServiceStatus 状态栏 tooltip(数据源=既有
engineVersionDetect 检测链,未检出显式「未检测到」,绝不编造)。

1. **纯函数面**(`src/backend/kodeServiceStatus.ts`):新增
   `engineVersionLine(version: string | null)`;`coreStatusBarTooltip(state,
   engineVersion?)` 增中间行,tooltip 三行=服务轨道依据 / 引擎版本行 / 索引
   格式 schema 行(ENGINE-WORDING-006 两行相邻,措辞分词)。`engineVersion`
   取真值即版本串,`null`/`undefined`/空串一律显式「未检测到(no version
   marker readable in the engine tree)」;**绝不回落 `kbengine.engineVersion`
   设置值**(那是用户声明口径,不是引擎树里的标记事实)。两个 l10n 源串入
   en/zh 包(categoryI18n 正反向双门)。
2. **装配面**(`src/activate/kodeServiceStatus.ts`):deps 增
   `detectEngineVersion: () => string | null`;一次探测缓存(状态栏刷新不反复
   读 FS),`kbengine.engineRoot` 配置变化才重探并刷新。
3. **数据源接线**(`src/activate/infrastructure.ts`):活动 profile 引擎根 →
   `kbengine.engineRoot` 设置根 → `findEngineRoot` 向上找 →
   `readEngineVersionMarker` 读 `version.h`/`kbeversion.h` 宏;与
   databaseWiring 的 KB-VER-004 探测同口径。显式根兼容「引擎仓 kbe/ 目录」
   形态(projectWizard 同款归一:本层有引擎树标记即用,`kbe/` 子目录形态退到
   父层);显式根探不到标记时回落向上找。任何异常静默回落 `null`(状态栏显式
   「未检测到」),不阻塞激活、不编造版本值。

RUST-113 验收口径同步:版本**展示**归环境面(状态栏 tooltip),RUST-113
metadata 域仍只按四类 seed(引擎 API/回调/内建对象/常量)按版本供给,本增量
不为其立设置供给通道——hover/元数据面继续不消费 `kbengine.engineVersion`。

诚实边界:MCP 灯 tooltip 不加引擎版本行。MCP tooltip 只承载内建托管事实与
点击启停语义(点击=`kbengine.mcp.toggle`),引擎版本是全局环境事实,落核心
灯(点击开 `kbengine.core.showShadowDiffLog`)。

## 增量⑤ 门禁

vitest 定向 `tests/kodeServiceStatus.test.ts` + `tests/categoryI18n.test.ts`
22 例全绿(引擎版本行 en/zh 三态 + 空串防御臂 + ENGINE-WORDING-006 既有断言
零扰动);`tsc -p ./` 0;eslint 本批三文件 0。纯 TS 面,零 Rust 改动。
