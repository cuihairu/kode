# KSEM-CFG-10(SEM-040)联动配置修改影响 — 批次纪实

日期:2026-11-14。todo.md SEM-040(旧 KSEM-CFG-10):联动配置修改影响。验收:改 key/类型列出读取点、默认回退及受影响模块;修改未保存内容也刷新,禁止覆盖用户配置。

## 交付面

- **纯核 `src/backend/configImpact.ts`**(零 vscode 零 IO 零写入),两入口:
  - **`computeKeyImpact({path, face, customTree, defaultsTree, structure?})`**:
    - `engine-xml` 面:受影响模块 = 路径首段(进程段);默认回退 = `kbengine_defaults.xml` 的同路径叶值(删除元件覆盖/删除该键后引擎采用的值),三态区分——有引擎默认(叶值)/容器节点(回落引擎默认**结构**,不虚称叶值)/无引擎默认(仅元件配置键,删除即失效);defaults 树不可得 → `fallbackKnown=false` 零声称;读取点 = 引擎进程内消费,**引擎 XML 配置不声称用户代码读取点**(不硬造);
    - `project-json` 面:读取点 = CFG-08 注册表**路径级**读取点(`pathReads`,两 loader 合并去重);未覆盖路径 = 读取点空且 known=true(改了没人读,诚实结论不是缺数据);注册表不可得 → `readersKnown=false` 零声称;受影响模块 = 读取点所在文件(唯一排序)。
  - **`computeTypeImpact(typeId, schema, structure)`**:serialization.json 一个类型的改动影响面 = 绑定该类型的 glob+loader(loads/load 两表合并去重)+ 各 glob 读取点合并 + 受影响文件;诚实注记 = 删除绑定后读取点失去类型信息(CFG-07 类型面对无绑定路径静默);`schema=null` → null(不猜绑定);绑定空 = 改它零影响(诚实结论)。
  - **`renderImpactBlock(impact, language)`**:悬停影响块双语文案;敏感回退值只出脱敏形态(`p***`,明文永不入块)。
- **CFG-08 核加宽(行为向后兼容)**:`ProjectConfigStructure.pathReads` —— 已覆盖具体路径的读取点(按路径逐条,与 `entries[].readers` 的 glob 聚合面区分);按 path/loader 排序。既有 CFG-08 测试零改动全绿,新增 3 例 pin。
- **接线 `src/serverConfigHover.ts` `configImpactForHover`**:悬停在 kbengine*.xml 上追加第三块(静态文案 + CFG-06 来源证据 + 修改影响)。**修改未保存内容也刷新**:被悬停文档若就是 custom/defaults 配置文件本身,以其实文本现解析顶替盘上缓存树(resolve 缓存读盘,不含未保存编辑);非配置文件不顶替(用别文件的盘树是正确语义)。树不可得/路径解析不出 → 静默零追加,既有静态文案面不受影响。
- **零写入面**:本批次没有任何写文件/写配置的通道(无 fs 写、无 CodeAction、无命令)——验收「禁止覆盖用户配置」由构造保证。
- **对账**:features en/zh 悬停服务配置行追加影响块子句;provider-data-sources en/zh 的 ServerConfigHoverProvider 行更新真位(`serverConfigHover.ts:366` / `activate/languageServices.ts:233`)+ CFG-10 数据源与副作用口径。

## 诚实边界(v1 明示,不写成已实现)

- engine-xml 读取点零声称(引擎 XML 配置由引擎进程内消费,用户代码不直接读);类型/键的项目 JSON 读取点才是真读取点面;
- 类型影响面只消费 schema 绑定(不推断「同类型未绑定」的读取点);
- project-json 的读取点只按**已覆盖**具体路径列(glob 聚合会夸大到同 glob 全体读点,故走 `pathReads`);
- defaults 树不可得时回退面零声称(`fallbackKnown=false`),不拿目录文档值硬造(与 CFG-09 的目录锚口径一致)。

## prove-red(字节还原闭环)

1. **未保存刷新面**:摘除实文本顶替 → 5 红(两例 live 面 + 一例盘树不顶替面 + 两例块装配面)→ `cp` 备份 + python 替换 + 还原 `cmp` 字节一致;
2. **路径级读取点面**:摘除 pathReads 匹配 → 1 红(读取点/受影响文件例)→ 还原 `cmp` 字节一致。

## 坑账

1. **悬停光标位语义(CFG-06 同款,不改)**:`configPathAtText` 在 `<` 处或标签名首字符处落**父路径**(value 态优先)/null,完整标签路径要光标在标签名**内部**(+3 起);悬停测试锚点必须偏移进标签名,不是 `indexOf` 命中位;
2. **glob 聚合读取点会夸大影响**:CFG-08 的 `entries[].readers` 是绑定 glob 的聚合面——`res/guild/*.json` 的条目带 g1/g2 两个文件的读点;键影响面按具体路径取读取点,若直接消费聚合面会把改 `g1.json` 的影响算到 g2 的读点上 → 新 `pathReads` 路径级证据(CFG-10 消费);
3. **pathReads 需确定性排序**:按 (path, loader) 排,否则多路径夹具断言随 loader 表序漂移(与 pathConflicts 同口径);
4. **features.md 双份并存**:CFG 面锁步锁 `docs/features.md` 与 `docs/zh/features.md`(docsCommands 闸只读根级),勿只改一边。

## 门禁

compile 0 / eslint 0 / vitest 全量 786 文件 9824 过 + 4 skip(RC=0)/ xvfb demo 25 RC=0;分面先行:configImpact 13 例 + serverConfigHover 17 例 + configProjectStructure 17 例 + configRelationChecks 18 例 + 文档锁(providerDataSourceDoc/docsCommands/categoryI18n)全绿后跑全量。
