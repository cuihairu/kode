# KSEM-DATA-02(SEM-043)补共享数据键补全 — 纪实

日期:2026-11-14。todo.md SEM-043(旧 KSEM-DATA-02):补共享数据键补全。验收:按工程和共享数据域列 key 与写入来源,静态常量按真实绑定解析,不把同名标识符恒当同一键值。

## 交付面

### 1. 键位补全(`src/languageProviders/completion.ts`)

- KBEngineCompletionProvider 增第二可选注入 `dataDictIndex`(缺省静默让位,既有无参用例口径不变);装配点 `src/activate/languageServices.ts:115`(单例索引与 definition/hover/inlay/references 同源注入,DATA-01 审计的装配面结论延到第五个消费面);
- 分支位:cellData 键位之后、FIXED_DICT 键位与 Rust-first 判定之前(键位上下文里 def 链/Rust 面均无效,同款先接管;null→落回既有同步链,非键位路径同步契约不变);
- `provideDataDictKeyCompletions`:`awaitDataDictIndexReady`(AUD-072 可取消冷建等待,不空手装作无键)→ `queryKeyFamilies(dict, resolveScopeRoot(fsPath))`(AUD-068 根身份键,只列本工程同字典键族)→ 前缀 startsWith 过滤 → 项 detail = `写点数 · 首写点 basename:line`(1 基);纯读键族诚实标 `no write site`,不造来源;键位无键族返回 `[]`(不给项,不造键);开关 `kbengine.python.enableDataDictIndex` 关→null 不接管;
- 纯核 `dataDictKeyCompletionContext`(`src/backend/globalDataIndexCore.ts`):`alias.globalData["片段` / `.get("片段` / 光标刚过 `[` 三态;别名前是 `.` 的属性链(x.KBEngine.globalData)与非字典接收者不接管(与扫描器同守卫);替换范围=引号内片段精确区间(不含引号),cellData/FD 键位同款。

### 2. 静态常量真实绑定(`src/backend/globalDataIndexCore.ts`)

- `extractModuleConstantBindings(text)`:顶格 `NAME = "literal"` / 带注解 `NAME: str = "literal"`;同名多次赋值值全等→该值,冲突→null(条件分支序静态不可知,不猜运行时终值);RHS 非单段字符串字面量(f-string/拼接/调用/引用)不入绑定;缩进赋值(函数/类体)不是模块作用域,不收——类常量解析需类域追踪,不在本面;
- `resolveIdentifierSignature`:键表达式是裸标识符且绑定值确定→解析为绑定值;无绑定/冲突/非裸标识符→原签名(标识符名,现状语义);
- 双侧同口径:扫描侧(scanLineDictAccesses 第 9 参)与查询侧(getKbeDataDictAccessAtPosition 第 4 参、getDataDictAccessInCodeContext 第 5 参缺省自全文算)都过同一解析——否则查询签名≠索引签名,已解析键族的跳转/引用/悬停/inlay 全部失配静默丢;`findKbeDataDictAccesses`/Sliced 增第 5 参缺省自全文取,逐行扫描调用方(typeInlayHints 视口行)显式传全文绑定;
- 四个既有查询面(definition/references/hover/inlay)零改动获得解析:它们都经 `getDataDictAccessInCodeContext(全文…)`/已带绑定的逐行扫描,缺省参数自然生效——hover 的行级快筛(单行无绑定)只判"有无访问位"不判签名,真查走全文复核,无失配。

### 3. 索引查询(`src/globalDataIndex.ts`)

- `queryKeyFamilies(dict, root)`:`byKey` 前缀扫描出同根同字典全部键族(签名升序);null 签名访问本就不入倒排(replaceFileSitesSliced 双侧 skip),无需再滤。

### 4. l10n

- `src/nlsRuntime` 唯一口径:`{count} write site(s)` / `no write site` 两键入 bundle.l10n.json + bundle.l10n.zh-cn.json(个写点/无写点)。

## 验收句逐条

| 验收句 | 落面 |
|--------|------|
| 按工程列 key | `resolveScopeRoot(fsPath)` 根身份前缀,双根测试钉(A 根键位只见 ka 不见 kb) |
| 按共享数据域列 key | `queryKeyFamilies(dict, root)`,dict 维隔离测试钉(cellAppData 键位不混 baseAppData 的 bk) |
| 写入来源 | detail = 写点数 · 首写点 file:line;纯读键族 `no write site` 测试钉 |
| 静态常量按真实绑定解析 | 顶格字面量绑定→签名=绑定值;同名不同文件不同值→两族(索引族表+补全双钉) |
| 不把同名标识符恒当同一键值 | 同名异值两文件测试钉 `['alpha','beta']` 两族;冲突/缩进/非字面量三退化退回标识符名(不猜) |

## prove-red(两面各变异一次,cmp 字节还原)

1. **绑定解析面**:`resolveIdentifierSignature` 改恒返原签名 → 5 例红(扫描侧解析/查询侧同口径/补全标识符键出族/前缀过滤/同名两族)——解析删除即全链失配,证明力来自测试钉在解析生效值上;
2. **补全分支面**:completion 入口 `if (dataDictCtx)` 改永假 → 4 例红(键族列表/前缀过滤+跨字典隔离/工程隔离/同名两族补全面)——分支摘除即键位静默,非键位路径不受影响。
两面各自 `cp` 备份→python 变异→跑红→还原→`cmp` 字节相同→15/15 复绿。

## 边界(诚实缺口,记录在案)

- 跨模块 import 的常量绑定不解析(`from consts import KEY` 不入绑定)——文件本地模块作用域为界,跨文件解绑需 import 图,不在本面;
- 类体/函数体缩进赋值不解析(类常量需类域追踪);
- 绑定冲突(同名多次赋不同值)退回标识符名,不猜条件分支运行时终值。

## 坑账

1. **push 闭包老串误替换**:给 push 加解析时 old_string 只锚了字面量分支头部,把原 `if` 块的 push 体留成孤儿(多余 `}` 提前闭箭头),TS1128 在函数尾——修复=按 HEAD 原闭包全貌删孤儿块;教训:给既有闭包加分支,old_string 必须含完整原分支体,不能只锚头部;
2. **l10nText 是具名参数**(`NlsArgs = Record<string, string|number|boolean>`),`{0}` 位置参数编译红——键与值两侧占位符都要同步改(`{count}`);json.dump 重写整文件前先确认缩进与尾换行,否则 diff 全文件膨胀;
3. **假 vscode 桩双包 Uri**:`[Uri.file(a), Uri.file(b)].map(f => Uri.file(f))` 的 fsPath 变成 Uri 对象,findFilesAcrossRoots normalizeForCompare 抛 paths[0] must be string——字符串数组直接 map Uri.file,先 Uri 后 map 是双包;
4. **completion 冷索引直读 byKey 会静默空**:首版 queryKeyFamilies 不等初扫,键位在初扫完成前空手回——补 `awaitDataDictIndexReady`(AUD-072)与 hover/references 同款;
5. **provider-data-sources 表锚点 HEAD 即陈旧**(:260/:960 落函数体中部噪声,并发会话漂移所致)——按现真位重校(类 :306/同步链 :391)并补数据源面,zh 表同 path 同锚同步。

## 门禁

compile 0(tsc 直跑 exit 0)/ eslint 0 / vitest 全量(本批 +15 例,见 todo.md 勾行时点数)/ xvfb demo 25 RC=0。
