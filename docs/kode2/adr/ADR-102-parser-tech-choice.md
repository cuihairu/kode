# ADR-102 — kode-parser 采用自研零依赖字节级 XML 状态机(不引 quick-xml/rowan)

- 状态:已接受(2026-10-23,PR-005;即书 §18 ADR-102 的裁决)
- 关联:书 SYNTAX-004、§18 ADR-102、BUILD-003、§0.2 铁律;实现:crates/kode-parser/src/xml.rs;证据:docs/kode2/pr-005.md

## 背景

书 SYNTAX-004/ADR-102 要求评测 quick-xml + 位置层 vs rowan CST,再选型。
仓库铁律:**密码学以外引入第三方 crate 需 ADR**。KBEngine 的四类声明文件
(`.def`/entities.xml/types.xml/alias.xml)是一个极小的 XML 子集(无命名空间、
无 DTD 语义、属性少、单根),但对 span 精确度、容错恢复、伪注释有引擎特有要求。

## 决策

自研 ~600 行字节级状态机(`kode_parser::xml`),**零第三方依赖**(仅依赖
workspace 内 kode-vfs 的解析缓存/指纹)。要点:

1. arena 树 + 父指针,元素/文本/注释/CDATA/PI/DOCTYPE 保留精确字节 span
   (SYNTAX-002);错误恢复 = 记结构化诊断 + 局部跳过,树的前缀部分永不丢弃
   (SYNTAX-003);
2. `.def` 伪注释(`#` 开头行,如 `# <原本 80 列>` 截断头)在字节层掩码为空格,
   长度不变 → span 对原始文件逐字节成立;
3. 遗留拼写容忍(多词标签 `<Client Flags>`、`Detaillevel`、`All Clients`)在
   状态机/规范化层收口,不散落调用方;
4. rowan/quick-xml 的收益(增量 CST、通用 XML)在本子集上暂无数据支撑;
   若后续基准(SYNTAX-006 增量解析)证明手写状态机成瓶颈,再按 ADR-002
   流程重评(本 ADR 可被推翻,推翻需基准证据)。

## 后果

- 正面:零供应链风险、VSIX 体积不变、span/容错语义完全按 kode 需求定义;
  golden 对拍 28/28 与 TS 现有实现逐字段一致(2026-10-23)。
- 负面/约束:不解决通用 XML(命名空间/DTD);fuzz 纲要(proptest/arbitrary)
  尚未接入(随 fuzz 单),当前仅确定性盲样(1149 例,0 panic)。
