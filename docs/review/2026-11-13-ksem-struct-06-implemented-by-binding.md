# KSEM-STRUCT-06 implementedBy 绑定解析

**日期**：2026-11-13
**条目**：`todo.md` KSEM-STRUCT-06 [P1]「解析 implementedBy 绑定。验收：绑定真实导入、类/对象和契约方法声明；重名、动态返回及缺实现保留未知。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 绑定真实导入 | 模块候选按真实导入序发现:`module.py` 与 `module/__init__.py` 同名并存时**包目录胜出**(CPython FileFinder 包优先,本地 python3 实测定案:同根同名双形态 `import m` 解析到 `m/__init__.py`);绑定只在模块真存在+符号真有定义时成立,路径猜到但文件缺席=module-not-found 不装 |
| 类/对象 | 符号定义点按引擎 GetAttrString 三合法形态分类:class→类、def→函数、`X = Y` 一跳到本文件 class/def 单处定义→对象(注明别名来源 `Y`,行落赋值行) |
| 契约方法声明 | 三契约方法(createObjFromDict/getDictFromObj/isSameType,setImplModule L2383-2397)沿用 GEN-DEF-1e 同一文件级真源 `implFileHasContractMethod` 零新表扫描,随绑定快照返回(呈现由姊妹契约段承担,不重复渲染) |
| 重名保留未知 | 同文件同符号多处定义 → ambiguous-symbol(证据=行列);跨 user_type 根同名模块并存 → ambiguous-module(工程内 sys.path 序不可判,候选文件名列证据) |
| 动态返回保留未知 | 赋值 RHS 是调用/属性链/字面量 → dynamic-value;别名目标(`X = Y` 的 Y)在本文件 class/def 非"恰好单处" → dynamic-value(不追 import 链,诚实断) |
| 缺实现保留未知 | 模块未解析到 → module-not-found;符号无定义 → symbol-not-found;非两段畸形值(引擎 loadImplModule 拆段即报错)→ malformed,如实呈现不装绑定 |

## 2. 引擎真值

- loadImplModule(datatype.cpp L2331-2357):值按 '.' 拆必须恰好两段 `moduleName.symbolName`,ImportModule 前段 + GetAttrString 后段,按属性名取**不要求 class**(repo 内既有校准注释,findPythonSymbolDefinitionLine 同锚);
- setImplModule(L2383-2397):三契约方法逐个 GetAttrString,任一缺失装载失败(GEN-DEF-1e 已交付的诊断面,本批复用其真源不另判定);
- CPython 导入序:FileFinder 对同名"目录包 vs 文件模块"**包目录胜出**——本地 `python3` 双形态夹具实测 `import m` → `m/__init__.py`,采集侧按此序出候选(既有定位器只试 `.py`,包模块此前绑定不到,本批补上)。

## 3. 新增纯核(`src/backend/implementedByBinding.ts`,零 vscode 依赖)

| 导出 | 职责 |
|---|---|
| `parseImplementedBy(raw)` | 引擎两段拆分(恰好两段且皆非空;其余 null=malformed) |
| `resolveImplementedByBinding(raw, candidates)` | 绑定裁定主函数:malformed/module 0 或 >1/符号定义点 0·多·单分判,单点按形态分类;object 面别名只追同文件 class/def 单处定义一跳 |
| `scanSymbolSites` | 符号定义点扫描(class/def `\b` 界;赋值 `=[^=]` 防比较/增强/海舅误判) |
| `renderImplementedByBindingSection(binding)` | 悬停段纯字符串(bound=形态/别名/落点/包注;unbound=六类未知原因随引擎依据) |

**采集面**(`src/backend/userTypeContractSource.ts` 新增 `implementedByBindingForWorkspace`):layout.userTypeRoots × {包 `__init__.py` 优先,同名 `.py`} 逐根至多一候选,读源后交纯核;implementedBy 空 → null(与契约段同门槛)。

**悬停面**(`src/languageProviders/hoverBuilders.ts` 新增 `resolveImplementedByBindingSection`):挂 `createCustomTypeHover` 第 5 参,types.xml 自定义类型**类型名声明行臂**(getCustomTypeHover)带绑定段;Type 值引用臂(getTypeValueHover)本批不动(仍 4 参);渲染序=绑定段(绑到哪)在契约段(要求什么)之前。

## 4. 诚实边界(全部测试钉死,16+3 例)

- 别名只追一跳且限本文件:`X = Y` 的 Y 是 import 名/重名/缺失 → dynamic-value,不追 import 链;
- 赋值形态不误判:`==` 比较、`+=` 增强、walrus `:=` 均不认作赋值点(`=[^=]` + 形态前缀);
- 串内 `#` 不当注释剥(`\s+#` 才剥,`X = "#hash"` 的 RHS 保持原样);
- 跨根同名模块按 ambiguous 处理(不沿"第一个根"猜——与既有跳转定位器口径不同面,本面是绑定真形,跳转面不动);
- 文件级扫描的既知口径(与 GEN-DEF-1e 一致):docstring 内同形文本可能同形命中,该口径既有校准,不另造词法态。

## 5. 证据

- 纯核测试:`tests/implementedByBinding.test.ts`(16 例:两段拆分 2/unbound 六类/bound 三形态+包注/赋值形态防误判/渲染/采集面真 tmpdir 含包胜文件);
- 悬停接线:`tests/hoverGapArms.test.ts` +3 例(无 implementedBy null/文档不在工作区 null/绑定成立真形落点+模块缺失未知原因);
- prove-red:`git stash push -u -- src/` 后 3 例红(纯核缺失收集失败+接线臂红),恢复 33/33 绿;
- ANCHORS:hover.ts 仅在文件尾 export 块加一行导出,全部锚点在其之前零位移(perfCallChainDoc 4/4 绿实证);
- 门禁:eslint 0 / tsc 0 / vitest 全量绿 / xvfb demo 25 RC=0(见提交信息)。
