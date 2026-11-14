# KSEM-CFG-04 配置键与枚举值补全(SEM-034)收口纪实

日期:2026-11-14。todo 原文:「实现配置键和枚举补全。验收:父路径限定可用 key,value 按确定枚举/类型补全;已有 provider 复用,不重复注册冲突项。」

## 交付面

- **纯核心 `src/backend/configCompletion.ts`**(零 vscode 依赖):
  - `parseConfigCompletionContext(text, offset)`:注释掩码(等长空格替换,`<!-- -->` 内换行保留,偏移不失真)→ 标签栈扫描。三态输出:`tagPrefix`(标签名补全态 `<xx`)/`valuePath`(元素文本取值态)/属性区(键值建议都不适用,诚实空)。两处正确性坑在实现中钉死:①光标落在某未完整标签内部时,regex 若先匹配到后面的完整标签会把该标签压栈污染路径——**`tagEnd > bounded` 在压/弹之前 break**;②`<root>` 是 parseConfigXml 的合成文档包裹段的真根,配catalog/契约同口径不入路径——`name === 'root' && stack.length === 0` 跳过。弹栈用 `lastIndexOf` 同名开标签(良构配置精确命中,容忍错配多弹)。
  - `suggestConfigKeys(scan, extraction, parentPath, prefix)`:CFG-03 `scanConfigFieldIdentities` 扫描取父路径下**恰一层**子字段(`rest.includes('.')` 越级滤掉,根层断言无点分标签),Set 去重,详情挂 CFG-02 记录(`recordDetail`:valueKind · unit · 枚举值数 · 证据分级/仅值形态候选),无记录容器段 detail=`section`,大小写不敏感前缀过滤,`localeCompare` 排序。
  - `suggestConfigValues(extraction, valuePath, prefix)`:**只按确定证据**——CFG-02 枚举块逐值建议(detail=含义);`Type: Boolean` 注解仅 `true`/`false`;其余类型(含 value-only 候选与未知键)一律空数组。不回填默认值,不猜。
  - 入口 `provideConfigCompletions(text, offset, scan, extraction)`:按上下文路由键/值建议。
- **provider 壳 `src/configCompletionProvider.ts`**(vscode 适配):开关 `kbengine.configCompletion.enabled`(默认开)→ `buildConfigTreePair()` resolve 缓存取树(null defaultsTree → 无建议,不触发解析 IO)→ 分析产物按 defaultsTree 树身份 WeakMap 缓存(树换代自动失效)→ CompletionItem 映射。选择器 `CONFIG_COMPLETION_SELECTORS` = 四个配置 XML 文件名模式(language xml):`kbengine.xml` / `kbengine_defaults.xml` / `messages_fixed.xml` / `messages_fixed_defaults.xml`,与既有 def/python/启动脚本补全选择器**零交集**——验收条款「不重复注册冲突项」由此成立,并由 extension.test 注册计数 3→4 钉住。
- **CFG-02 配套**:`extractConfigContractsFromTree(tree, catalogSources, baseline)` 新增(tree-only 入口,运行时无原文);`ConfigContractBaseline.lineCount` 放宽为 `number | null`(null=运行时树快照行数未知,如实标注,不伪造)。
- **装配**:`src/activate/languageServices.ts` import +1、注册块 +8(registerCompletionItemProvider + push,现位 :255)。

## 测试(tests/configCompletion.test.ts,15 例,全绿)

上下文三态/注释掩码偏移稳定/兄弟闭标签弹栈/父路径恰一层(根层+段内,无点分越级)/去重+大小写不敏感过滤/详情三面(enum/list/section)/枚举逐值带含义/Boolean 注解恰 true/false/value-only 诚实空/入口路由(键/值/属性区)/值前缀过滤/真 942 行 defaults 夹具偏移稳定性(开标签内+闭标签后)。

prove-red(字节还原口径):①注释掩码失效面(掩码注释里的假标签不被剔除→红)②父路径越级面(根层点分标签混入断言加强后→红)。备份 cp + python 替换 + `cmp` 字节一致还原。

## 文档锁步(本批四族闸全过)

- `docs/architecture/provider-data-sources.md` + zh:ConfigCompletionProvider 入册(类定义/注册位/数据源/允许副作用=纯读),§2a 计数 30 注册/29 类 → 31/30。
- `package.json` 新设置 `kbengine.configCompletion.enabled` + 两份 nls 描述(含 默认值 段与 详见 链接,锚 `#server-config-completion` / `#配置补全`)。
- `docs/guide/configuration.md` + zh:总览表新增「Server Config Completion」/「配置补全」子组与设置行。
- `docs/features.md` + zh:Settings 表新增行。
- `tests/perfCallChainDoc.test.ts` ANCHORS 与 `docs/perf/2026-baseline.md` 锁步:languageServices.ts 顶部 import +1 与注册块 +8 → 五打点 202/259/322/126/723 → 203/268/331/127/732(带日期历史注)。

## 坑账

1. `readonly vscode.DocumentSelector[]` 不能赋给 `registerCompletionItemProvider` 的 selector 形参(readonly 数组不变类型)——按 `vscode.DocumentSelector` 宽化声明。
2. 上下文扫描的 break 必须在压/弹**之前**:否则光标所在残标签 + 其后完整标签会把别人压进栈(测试以「开标签内」真夹具偏移钉住)。
3. 根包裹段跳过条件是 `stack.length === 0`:嵌套出现的同名 `root` 元素(用户数据)照常入路径。
4. vitest 吞 console.log——探针一律 writeFileSync 落盘。
5. 文档锁步闸精确按设计工作:新设置→nls/总览表/Settings 表三族红;新 provider→providerDataSourceDoc 双语红;装配行移→ANCHORS 五打点漂移红。全部补齐后 54/54 绿。

## 门禁

compile 0 / mocha tsc 0 / lint 0 / unit 9726 过 + 4 skip(781 文件)/ xvfb demo 25 RC=0。
