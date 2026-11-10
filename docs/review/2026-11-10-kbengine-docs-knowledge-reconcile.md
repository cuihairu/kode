# KBEngine 官方文档 ↔ 知识库核对报告 · 2026-11-10

用户令(2026-11-10)：「git@github.com:kbengine/kbengine_docs.git 这个是文档,需要 clone 下 核对下,知识库」。

## 1. 来源与方法

- **官方源**:`git@github.com:kbengine/kbengine_docs.git`,clone 到 `/tmp/kbengine_docs`(depth 1)。
  仓库 = 官方文档站源码:`api/`(zh CHM HTML 源)、`api_en/`(en)、`README.md`、`generate_python_tips.py`。
- **提取法**(`/tmp/extract_api.py`):每个 `api/<face>/Classes/*.html` 是 doxygen 式页面,
  段标题为 `<h2>成员函数文档/回调函数文档/属性文档`;成员/回调名取 `<span class="function_list">def name(...):`,
  属性名取 `<span class="attribute_definition">`(属性段不用 function_list,故初版提取计数为 0,补此标记后正确)。
  module 面在 `api/<face>/Modules/KBEngine.html`(无类页,段无属性表)。
- **被核对对象**:`docs/knowledge/api-*.md`(跟踪,重写非照抄,锚点= fork 源码)。源材料即本仓库
  `api/`(kbengine_docs = CHM HTML 源),故核对 = 「官方文档化面」vs「知识库声称覆盖面」名称集差集。
- 名称集对比按 (face, class/module) 对齐,官方名逐一在对应知识库文件中 grep(全文文本命中判覆盖)。

## 2. 结果:全量覆盖,0 遗漏

| 面 | 官方成员函数 | 官方回调 | 官方属性 | 官方名合计 | 知识库未覆盖 |
| --- | --- | --- | --- | --- | --- |
| baseapp/Entity | 11 | 8 | 10 | 29 | **0** |
| baseapp/Proxy | 6 | 6 | 7 | 19 | **0** |
| cellapp/Entity | 29 | 21 | 18 | 68 | **0** |
| client/Entity | 7 | 5 | 4 | 16 | **0** |
| bots/Entity | 7 | 4 | 8 | 19 | **0** |
| bots/PyClientApp | 2 | 0 | 1 | 3 | **0** |
| interfaces/Modules/KBEngine | 12 | 0 | 0 | 12 | **0** |
| loginapp/Modules/KBEngine | 9 | 0 | 0 | 9 | **0** |
| dbmgr/Modules/KBEngine | 8 | 0 | 0 | 8 | **0** |
| logger/Modules/KBEngine | 7 | 0 | 0 | 7 | **0** |
| **合计** | **98** | **44** | **48** | **190** | **0** |

**结论**:知识库对官方 `kbengine_docs` 全部 190 个文档化 API 名(98 方法 + 44 回调 + 48 属性)全覆盖,
**无遗漏、无缺失**。知识库各文件头部「all N documented surface items are covered」的声称成立。

## 3. 对账中发现的小偏差(非覆盖缺口,如实记录)

1. **cellapp/Entity 属性计数声称 vs 官方 HTML**:
   知识库 `api-cellapp.md` 头部称「Entity 17 documented attributes(16 table rows;isOnGround 在材料属性
   散文里但缺于自身汇总表)」;官方 `api/cellapp/Classes/Entity.html` 属性段实际列 **18** 个
   (含 `className`/`id`/`isDestroyed`——这三个来自共享宏 `entity_macro.h`,知识库在 §1「Shared entity
   methods」单独列出)。即官方 18 = 知识库 §1 实体专属 15(`entity.cpp:71-88`)+ 共享宏 3(`id/isDestroyed/className`),
   知识库**实际覆盖 18 个**(名称全命中),「17」是计数口径表述(16 表行 + isOnGround 散文)与官方属性段
   行数(18)不一致,非缺失。已在 §9 备注。
2. **签名默认值差异**:官方 HTML 方法签名未标默认值(如 `destroy(self, deleteFromDB, writeToDB)`、
   `createCellEntityInNewSpace(self, cellappIndex)`),知识库给默认值(源自 fork 源码,如
   `destroy(deleteFromDB=False, writeToDB=True)`、`createCellEntityInNewSpace(cellappIndex=None)`)。官方未标
   默认 ≠ 矛盾;参数名一致。
3. **官方文档化面 ≠ fork 源码面**:知识库另含 fork 3.12 新增/源码实测面(如 `clientapp`/`entities` 等
   bots 属性、`debugView`),这些不在官方文档,属「知识库超官方文档」——正常,知识库以 fork 源码为锚点,
   官方文档为参考面。

## 4. 验证方法声明

- 提取计数与知识库头部声称(cellapp Entity 29+21、baseapp 11+8 等)逐一吻合,排除双侧同错空转。
- 未做 en(`api_en/`)对拍:名称面 zh/en 应同源,本核对以 zh 为准;en 签名若需对拍可另批。
- `/tmp/kbengine_docs` 与 `/tmp/official_api.txt`、`/tmp/extract_api.py` 为 scratch,不提交。
