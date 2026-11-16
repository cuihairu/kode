# RUST-144 批 4 验收纪实:SemanticTokens provider 装配面接线

日期:2026-11-16。todo 行:RUST-144(本批=provider 装配面:配置闸+注册+版本缓存+文档对账;决策核与成本评测见批 3 docs/review/2026-11-16-rust-144-semantic-tokens.md)。

## 交付面

- `src/semanticTokensProvider.ts`(新建):`SemanticTokensProvider implements vscode.DocumentSemanticTokensProvider`+`buildSemanticTokensLegend()`(注册期构造);
- `src/activate/languageServices.ts`:defProps 注册块后单注册(pythonDocumentSelector);
- `package.json`+`package.nls.json`+`package.nls.zh-cn.json`:配置键 `kbengine.semanticTokens.enabled`(默认 **false**)+双语描述(含默认值段与配置指南深链,契约锁口径);
- `tests/semanticTokensProvider.test.ts`(4 钉)+`tests/extension.test.ts`(注册断言+legend 内容);
- `tests/fake-vscode/core.ts`(SemanticTokens/SemanticTokensLegend 类)+`tests/fake-vscode/languages.ts`(registerDocumentSemanticTokensProvider 记账,第三参 legend 独立形态);
- `tests/perfCallChainDoc.test.ts`:languageServices 五打点锚点真位重探 128/209/282/349/750→129/210/283/350/765(顶部 import +1,defProps 后注册块 +14);
- 文档对账:`docs/architecture/provider-data-sources.md`+zh(新 provider 行,注册位 :644)、`docs/perf/2026-baseline.md`(§7 出处随锚点锁步)、`docs/guide/configuration.md`+zh 与 `docs/features.md`+zh(Settings 行,并发脏件用 HEAD+单行 hunk 隔离提交,worktree 同步行对齐)。

## 设计裁定

1. **默认关**:python 语义 token 常由 Pylance 提供,VSCode 语义 token 多 provider 抢位行为是 RUST-148 冲突矩阵的裁定对象——裁定前 opt-in(诚实保守,不与既有用户的高亮面抢位);
2. **无 contributes.semanticTokenTypes 声明面**:5 类 class/function/method/parameter/macro 与 2 修饰 declaration/async 全部是 VSCode 标准内建名,主题自带配色,manifest 零声明(原候选「package.json semanticTokenTypes 声明」按此裁定取消);
3. **版本缓存**:`flowVersionKeyForDocument`(文档实例身份+版本,与 KODE-PERF-001 同键纪律)Map 缓存编码产物,LRU 8 槽——批 3 成本评测结论落地:增量面成本大头在 span 提取(典型 1.9ms/病理 794-2220ms),重算只该发生在版本变更;同版本命中复用同一 Uint32Array 实例;
4. **legend 注册期构造**:模块顶层 `new vscode.SemanticTokensLegend` 会在 bundle 装载烟测炸(nightly 2026-11-12 回归门的 vscode 替身按需提供类,import 期即求值)——改 `buildSemanticTokensLegend()` 注册期调用,bundleLoadSmoke 首跑抓出。

## prove-red(两靶,cp+cmp 还原)

- 靶 1:配置闸 `false &&` 废掉(恒开)→ 默认关钉红(开闸出码断言序列破坏)→ 还原 4/4 绿;
- 靶 2:版本键废掉(恒定字符串)→ 版本失效钉+跨实例钉双红(编辑后同实例命中旧码/新实例命中旧码)→ 还原绿。

## 坑账

1. **提交顺序教训**:feat 提交先于全门禁(定向绿就提交),全量首跑 7 红(bundle 装载/nls 契约×2/docsCommands×2/锚点漂移/provider 文档)——全部修复后重建 feat 提交替换未推提交;红线「测试绿才 push」守住了,但「绿才 commit」应同样先行;
2. **真 index 误写**:隔离文档 hunk 首次漏带 GIT_INDEX_FILE 直接 update-index 写进真 index——`git reset -q`(mixed)恢复后重做;真 index 事务边界=每次调用显式带 env;
3. **subprocess `.strip()` 吃文件尾换行**:git show 经 strip 后重建的 4 件文档全丢尾换行(diff 尾部 -1/+1 对)——git_nostrip 通道重建修正,每件恰好 +1 行;
4. **nls 描述契约**:新配置键描述必须含「默认值」段+「详见 [」链接且链接锚点须真存在于 configuration.md 标题 slug(configMarkdownDescription 四件套);
5. **文档对账链**:新 provider 触发 providerDataSourceDoc(装配层 new XxxProvider 全册对账)、新配置键触发 docsCommands(中英 configuration 总览表+中英 features Settings 表双向)+锚点漂移触发 perfCallChainDoc+baseline §7 锁步——五面齐改才绿。

## 诚实边界

- range/edits 增量 provider(`provideDocumentSemanticTokensEdits`)不做:批 3 成本评测已证窗口编码 <0.05ms 非瓶颈,VSCode 编辑抖动下全量+版本缓存已足;真机病理大文件兜底策略与 RUST-147 一并裁度;
- 默认开启翻转=RUST-148(Pylance 冲突矩阵)裁定后另批;features.md 功能叙述段(非 Settings 行)随默认翻转时补;
- 激活链 demo 门禁真机验证:xvfb 25 绿(默认关=注册零 token 面安全)。

## 门禁

eslint 0 / tsc 0 / vitest 全量 857 文件 10391+8skip RC=0 / xvfb demo 25 RC=0 / prove-red 两靶闭环 / 契约五面(bundleLoadSmoke/configMarkdownDescription/docsCommands/providerDataSourceDoc/perfCallChainDoc)全绿。
