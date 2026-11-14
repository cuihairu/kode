# KSEM-CFG-05 配置值校验(SEM-035)收口纪实

日期:2026-11-14。todo 原文:「实现配置值校验。验收:校验有源码/schema 依据的类型、范围、枚举和必填;引擎容忍/忽略未知 key 的行为与确实报错分级。」

## 交付面

- **纯核心 `src/backend/configValueValidation.ts`**(零 vscode 依赖),证据分级三面:
  - **类型面 = Error**:`record.evidence ∈ {engine-read-site, defaults-type-annotation}` 且 valueKind ∈ {integer, integer8, float, boolean} 时查字面量形态(整数 `[+-]?\d+`/浮点容整数/布尔仅 true·false 大小写不敏感)——引擎读取点(目录 serverconfig.cpp 锚)与注释类型声明是源码级证据,坏值=启动解析失败级,「确实报错」落此档;
  - **枚举面 = Warning**:`enumValues` 非空(注释枚举块证据)且 custom 值不在文档化值集——引擎对未登记枚举值按掩码/忽略处理,约束强度未经源码证明,降 Warning;枚举证据存在时**只报枚举面**(一条 finding,不重复报类型);
  - **未知键面 = Information**:CFG-03 `dynamic-extension`/`dynamic-segment-child`(custom 独有段)——引擎配置层只读已知键(kbengine_defaults.xml 是引擎全量键 dumps),custom 独有键被容忍忽略;**归并到首缺段边界路径**(与 CFG-03「只记首缺段」同口径,后代不重复登记,一条 boundary 一条 finding)。
- **诚实缺口(不虚构)**:**范围/必填面零实现**——defaults 注释里只有散文提及(「View 范围」「溢出范围」等语境词,非机器可判区间),无结构化 range/required 标注源;有源码/schema 依据的约束前置词在此兑现为「无证据=不查=零产出」,缺口记载于本档与模块头注释,待引擎侧证据可用再接。同理:value-only 形态候选、defaults-comment、docs-only、无记录路径一律不查(不从默认值形态猜约束);list 记录无逐项证据不查;string/unknown 任何字面量都可解析不查。
- **行号锚定**:`configPathLineIndex(customText)`(注释掩码等长替换保偏移,`<root>` 包裹段不入路径,重复路径记首现行);`configLineSpan` 给该行去空白后的字符区间(下划线锚定)。
- **接线层 `src/configValueDiagnosticsWiring.ts`**(与 trapDiagnosticsWiring 同款自持装配):独立集合 `kbengine-config-value`,激活首扫 + 配置 XML 打开/保存即扫 + `**/kbengine.xml` watcher 变更即重算,代际守卫丢弃旧代产物;custom/defaults 树缺失或 custom 文件读不到 → 清空零产出,不猜。开关 `kbengine.configValueDiagnostics`(默认开,关即清空)。分析产物复用 `prepareConfigAnalysis`(CFG-04 补全 provider 同一份 defaultsTree 身份 WeakMap 缓存,改名导出)。
- **文案**:`CONFIG_VALUE_MESSAGE_TEMPLATES` 三模板经 `l10nText(message, args)` 动态取词,`l10n/bundle.l10n.json` + `l10n/bundle.l10n.zh-cn.json` 各 +3 键;`tests/categoryI18n.test.ts` dynamicKeys 点名模板常量(动态取词字面量扫描抓不到,常量表点名对账先例同 PLAYER_TASK_OUTCOME_LABELS)。
- **规则注册**:`lintRuleRegistry` 新增 KBE-CFG-007(typeMismatch/Error)/008(enumMismatch/Warning)/009(unknownKey/Information),与既有 KBE-CFG-001..006(工作区环境契约族,查 debug.json/extraPaths/.gitignore)互不重叠——本族查 kbengine.xml 值层。

## 测试(tests/configValueValidation.test.ts,15 例,全绿)

行号锚定(首现行/root 不入/注释掩码)/重复路径首现/类型面 Error(真语义:args.expected='an integer')/字面量形态(带符号整数/浮点容整数/'1e3' 拒/布尔大小写不敏感,`yes`/`1` 拒=只收文档化形态)/**证据闸(value-only 候选与 defaults-comment 不查)**/枚举面(未登记值带文档化值集,登记值不报)/枚举优先级(枚举+引擎证据只报一条 warning)/string·list 不查/未知键归并(custom-only 段 3 后代→1 boundary finding,已知段下 custom-only 叶照报)/overridden 合法值零产出/空文本叶跳过/排序(行号→严重度)/真 942 行夹具全量直跑(22 条 typed 引擎读取点记录,`thread_pool.init_create` 坏值 Error)/configLineSpan 区间。

prove-red(字节还原口径):①证据闸失效(value-only 候选也查类型)→ 证据闸测试红;②边界归并失效(逐后代登记)→ 归并测试红(2 例)。cp 备份 + cmp 字节一致还原。

## 过程坑账

1. **`[].every()` 恒真**:walkLeaves 首版把「全部子名为 item」判据放在 `children.length === 0` 判据之前,空数组 every()=true → **所有叶子被判成列表容器跳过**,值面全空。修:`children.length > 0 && every(...)`。CFG-03 collectConfigTreePaths 同款判据因前面已有叶子分支而幸免。
2. **configLineSpan end 算反**:首版 `end = raw.length - raw.trimEnd().length`(得到尾随空白长度),正解 `end = raw.trimEnd().length`(末个非空白字符后一位)。
3. **合成夹具包裹段**:引擎约定 kbengine.xml/kbengine_defaults.xml 根元素都是 `<root>`(真夹具实证),合成测试用 `<kbengine>` 包裹会破坏 root-skip 口径——统一 `<root>`。
4. **nls 详见锚双语口径**:锚点闸(configMarkdownDescription)只对 `docs/guide/configuration.md`(en)标题取 slug——en nls 用英文锚(`#diagnostics`/`#server-config-completion`),zh nls 用中文锚(`#诊断`/`#配置补全`);CFG-04 时 en 误写中文锚会红,zh 文件不进该闸。
5. **watcher 分布对账**:新接线文件带 1 处 createFileSystemWatcher → 双语 census 行逐文件计数 +1(17→18),doc 与测试锁步。

## 文档锁步

- `docs/guide/configuration.md` + zh:Diagnostics/诊断子组新设置行(分级语义完整)。
- `docs/features.md` + zh:Settings 表新行。
- `docs/architecture/provider-data-sources.md` + zh:watcher 分布 census 18 处。
- package.json + 两份 nls(默认值段 + 详见链接,锚 `#diagnostics`/`#诊断`)。
- `tests/extension.test.ts`:诊断集合注册序断言追加 `kbengine-config-value`。

## 门禁

compile 0 / mocha tsc 0 / lint 0 / unit 9741 过 + 4 skip(781 文件)/ xvfb demo 25 RC=0。
