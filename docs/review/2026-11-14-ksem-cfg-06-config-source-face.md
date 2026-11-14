# KSEM-CFG-06(SEM-036)配置来源跳转 + 悬停来源证据块 — 批次纪实

日期:2026-11-14。todo.md SEM-036(旧 KSEM-CFG-06):实现配置来源跳转。验收:代码配置读取 key 跳有效值及 schema/默认声明;hover 展示覆盖来源和单位,敏感值脱敏。

## 交付面

- **纯核 `src/backend/configSourceFace.ts`**(零 vscode 依赖):
  - `configSourceInfo(path, customTree, defaultsTree, extraction)`:覆盖来源层(`custom`=元件 kbengine.xml 覆盖 / `defaults`=引擎默认生效,两树皆缺=`exists:false` 诚实面)、生效值(.custom 叶优先回落 defaults 叶,容器段/空文本=null)、单位(仅取 CFG-02 契约记录 `unit` 证据,无记录不猜)、敏感键判定;
  - `isSensitiveConfigKey`/`maskSensitiveValue`:叶子键 password/passwd/pwd/secret/token/credential/access·api key 族(大小写不敏感,含 `access_key`/`apiKey` 变体);脱敏=首字符 + `***`(长度 ≤1 整体 `***`)——**明文永不入悬停文本**(测试双语言断言 plaintext 不出现);
  - `renderSourceEvidenceBlock(info, 'en'|'zh')`:`---` 分隔的证据块(来源行 / 生效值行 / 单位行,缺省行不渲染),敏感值只出脱敏形态;
  - `configPathAtText(text, offset)`:复用 CFG-04 `parseConfigCompletionContext` 三态(取值态=valuePath;标签名态=parentPath.tagPrefix;属性区=null),两处悬停/跳转语义修正见坑账;
  - `configDeclarationLine(text, path)`:复用 CFG-05 `configPathLineIndex`(注释掩码保偏移、首现开标签行)。
- **跳转面 `src/configDefinitionProvider.ts`**:ConfigDefinitionProvider(第四个 definition provider)——defaults 文件声明行(`fs.readFileSync` 对树 defaultsPath,同文件跳过)+ 最终配置虚拟文档生效值行(`buildFinalServerConfig().text` 行号表;URI=`kbengine-config:/kbengine-final.xml`,同 URI 跳过);选择器=CFG-04 同四 XML 文件;解析不出路径 → 无跳转目标,不猜。
- **悬停面 `src/serverConfigHover.ts`**:静态文档之后追加 `sourceEvidenceForHover`——`buildConfigTreePair` 两树皆 null → null(降级为纯静态文档,既有 12 例悬停测试零改动全绿);extraction 经 `prepareConfigAnalysis`(CFG-04 的 `analysisFor` 转正导出)取 CFG-02 契约;语言按 `getHoverLanguage() === 'en' ? 'en' : 'zh'`。
- **装配 `src/activate/languageServices.ts`**:顶部 import +1,配置补全注册块后 +8(definition provider 注册);ANCHORS 五打点 203/268/331/127/732 → **204/277/340/128/741** 锁步(tests/perfCallChainDoc.test.ts + docs/perf/2026-baseline.md 同笔)。
- **文档对账**:provider-data-sources.md en+zh(32/31 计数 + ConfigDefinitionProvider 行)、features.md en+zh(悬停:服务配置取值 条目补来源证据块与跳转面)。

## prove-red(字节还原闭环)

1. 脱敏面:`maskSensitiveValue` 改恒返原值 → tests/configSourceFace.test.ts 1 红(明文断言)→ `cmp` 字节还原;
2. 来源层判定:sourceLayer 强制恒 `'defaults'` → 2 红(custom 覆盖来源断言)→ `cp` 备份 + python 替换 + 还原后 `cmp` 字节一致。

## 坑账

1. **悬停路径部分名**:光标落在标签名中间时 CFG-04 语境解析给的是补全前缀(`gameUpdateHert`),悬停/跳转语义要整标签——`configPathAtText` 在 tagPrefix 态按行内 `<([\w.-]+)` 取完整标签名(且须 startsWith 前缀防错行);
2. **闭标签行尾恢复被取值态遮蔽**:光标在 `</name>` 之后时栈已弹出 name,valuePath 会把父路径当值路径——闭标签行恢复提最先判(按行内闭标签名补回),再去 valuePath;
3. **HoverLanguage 宽类型**:renderSourceEvidenceBlock 只收 `'en'|'zh'`,getHoverLanguage() 可能回 'zh-cn' 等 → 调用点三元归一,不放宽纯核签名;
4. **`<root>` 约定**:真实 kbengine.xml/kbengine_defaults.xml 根元素均为 `<root>`(CFG-05 已实证),测试夹具沿用,`normalizeRootNode` 兼容两种包裹。

## 门禁

compile 0 / eslint 0 / vitest 全量 782 文件 9750 过 + 4 skip(RC=0)/ xvfb demo 25 RC=0;受影响 11 文件先行 123/123 绿后才跑全量。
