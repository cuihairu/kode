# KSEM-DATA-06(SEM-047)空间数据读写关联 — 纪实

日期:2026-11-14。todo.md SEM-047(旧 KSEM-DATA-06):实现空间数据读写关联。验收:可确定 spaceID 与 key 建索引/补全/跳转;动态空间不合并为同一确定对象,保护键写入有明确诊断。

## 交付面

### 纯核(`src/backend/spaceDataIndexCore.ts`,零 vscode 依赖)

- `findKbeSpaceDataCalls(text, aliases, intBindings?)`:逐行正则 `alias.(setSpaceData|getSpaceData|delSpaceData)(` + 词法掩码剔注释/字符串伪调用;`x.KBEngine.` 属性链不收;实参顶层逗号切分(深度+引号感知;行内注释/未闭调用不判);**元数精确才收**(set=3/get=2/del=2,引擎 argssize 断言同口径 spacememory.cpp:703/760/816);跨行调用不入索引(诚实边界);
- spaceID 签名:int 字面量原样(含负数)/裸标识符按 `extractModuleIntConstantBindings` 解析(顶格 int 赋值,注解形态同收,同名全等→值、冲突→动态)/其余→null(动态);key 签名:引号内内部原文(**不解转义**——`"a\nb"` 与 `"a\\nb"` 异族,罕见形态如实不归一);
- `findSpaceDataProtectedKeyFindings`:set/del 的 key 为 `_mapping`(大小写不敏感,kbe_stricmp 同口径)→ 发现;**get 豁免**(_mapping 即几何映射路径,引擎自写自读 spacememory.cpp:543-554);键保护与 spaceID 可解性正交(动态 sid 照报);
- `spaceDataKeyCompletionContext`:键位上下文(引号内片段/未开引号插入位=光标;闭调用/首参未完→null;动态 sid 上下文仍识别但签名 null);
- `findKbeSpaceDataCallAtPosition`:落点键位探测(含两枚引号列)。

### 索引(`src/spaceDataIndex.ts`,独立单例)

- 实现裁定:与三字典索引(GlobalDataDictIndex)分离——后者是经多轮审计的字节领地(commitFile/replaceFileSites/根身份键/AUD-070 追读协议),并行表穿线风险大于收益;spaceData 键族是引擎级身份(逐空间存储,无进程根语义),全工作区一张倒排;
- 族键 `(spaceID, key)` 全等(引擎按精确串存取,键区分大小写);动态 spaceID 调用不入族(验收硬面);生命周期:ensureStarted 幂等(监听先挂再扫;open/change 增量、close 回读盘版本;初扫 8 路有界并发读盘逐文件让出);**v1 无文件系统 watcher**(边界如实记录:编辑器外磁盘变更不追);面查询前 `syncDocument(document)` 自档自愈零陈旧;`awaitReady(token)` 冷扫等待可取消(与 awaitDataDictIndexReady 同判据);
- 开关 `kbengine.python.enableSpaceDataIndex`(默认开;infrastructure 读取+extension 配置变更刷新,与 enableDataDictIndex 同款接线)。

### 面

- **补全**(`src/languageProviders/completion.ts`):键位分支先于 Rust-first 判定(键位上下文里 def 链/Rust 面均无效);开关关→null 不接管;动态 sid→[](不造键不合并);族 detail=写点数 · 首写点 file:line(纯读族如实标「无写点」,l10n 与三字典同键复用);
- **F12**(`src/languageProviders/pythonDefinition.ts` `resolveSpaceDataSitesAtPosition` 共享实现):get/del → 首个写点;set → 首个异类点;无异类回退同类首点(与 globaldata-key 同款);layer `spacedata-key` 入 JumpLayerTrace 联合;
- **Shift+F12**(`src/languageProviders/references.ts`):同族全部站点含自身(跨文件);
- **诊断**(`src/activate/diagnostics.ts` + `src/backend/spaceDataProtectedKeyCheck.ts`):独立集合 `kbengine-space-data-protected-key` + 独立调度器(C-19 范式);`kbengine.spaceDataProtectedKey` **Error**(引擎 AssertionError 是契约真源,非发明规则;对照 DATA-03 零诊断裁定——那是联合分歧无声明面,本面是引擎逐行核实的行为契约);开关 `kbengine.spaceDataProtectedKeyDiagnostics` 默认开;open immediate/change queued/close 摘除,extension 全接线;消息双语入 l10n bundle 两份。

### 声明面

package.json 双开关声明 + package.nls.json/package.nls.zh-cn.json 描述(现状口径:两文件中文同文);l10n/bundle.l10n.json + zh-cn 消息模板。

## 诚实边界(全部记录在案)

跨行调用/非字面量键/键转义解义/spaceID 运行期存在性/空 key/非串 value 诊断面——都不在本批,v1 无 watcher,`docs/knowledge/api-cellapp.md` 缺口账已同步改述(_mapping 诊断与键位补全两缺口闭合,余面如实保留)。

## 测试(`tests/spaceDataReadWrite.test.ts`,18 例)

纯核 9:三函数扫描(区间/别名)/掩码四态(注释/字符串/属性链/完闭带尾注照收+未闭注释不判)/元数+跨行/绑定表五态+sid 四态/族键+转义不解义/保护键 set-del-get 四态+动态照报/诊断项(Error/range/code)/补全上下文四态/键位探测。
索引 2:双空间异族(逐空间存储)/动态不建族+增量替换+removeFile。
面 4:补全同空间族+异空间不混(写点计数跨文件)/动态键位无项/F12 双向(读→写/写→读)+动态不导航/Shift+F12 全族三站点+开关关 resolver null。

## prove-red(5 变异,cmp 字节还原后全复绿)

1. 补全动态闸失效(`spaceIdSignature ?? '1'` 借族)→ 动态键位例红;2. F12 异类跳转改同类 → 读点跳转例红;3. 保护键 get 豁免摘除 → 发现数 3→4 红;4. 词法掩码摘除 → 注释/字符串伪调用例红;5. 大小写不敏感改精确 → _MAPPING/_Mapping 例红。

## 锚点

completion.ts 键位分支 +14 与 provideSpaceDataKeyCompletions +61(均在 PythonCompletionProvider 之前)→ 真位重探 989→1064;同批 diagnostics.ts 打点 195/208→200/213、extension.ts 421/518→430/529、pythonDefinition.ts 313/869/975→354/942/1048;ANCHORS 表+baseline mermaid+dated note 全锁步,perfCallChainDoc 4/4 绿。

## 文档

docs/features.md / docs/zh/features.md:enableDataDictIndex 行后新增两行(enableSpaceDataIndex 索引面+spaceDataProtectedKeyDiagnostics 诊断面);docs/knowledge/api-cellapp.md spaceData contract 小节 kode 面段改述+缺口账改述(改页→重生成 api-docs 225 条→重编 kode-server binary 三连完成)。

## 门禁

compile 0 / eslint 0 / vitest 全量(见 todo.md 勾行时点数)/ xvfb demo 25 RC=0。
