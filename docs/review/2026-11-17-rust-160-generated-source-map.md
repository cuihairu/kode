# RUST-160 结案:生成 .pyi 源映射记录生成符号→原文件,含多源汇聚优先级

日期:2026-11-17
性质:盘点+顺修真缺陷——源映射面已建成;盘点发现并修复标量属性来源镜错文件跳转(e803c330)。

## 源映射面(已建)

1. **逐符号源行记录**:entity 桩属性 `# source: .def:N -> types.xml:M` 双源链注释+方法 `# source: .def:N (段)`;kbe_types 条目 sourceFile+sourceLine+propertySourceLines;
2. **真实渲染行映射**(KR-AUD-78):recordEntryLine/recordPropertyLine 渲染期记录 entryLines/propertyLines,禁止硬编码生成行号;
3. **反向跳转面**(T-05):generatedSourceMap resolve*(生成行→来源)+GeneratedSourceCodeLensProvider「原始定义」镜→kbengine.source.reveal(带选区强制 reveal,批 159);def 再生后 updateEntityPlan fire 重询(C-22);
4. **多源汇聚优先级**:dedupeCustomTypesByName winner 语义(types.xml 先注册、alias.xml 后到整条作废不发射,skipped reason 携带 winner 出处 `文件:行`,与引擎 addDataType 拒重复注册同源,KSEM-STRUCT-08 统一口径);跨分件 externalModules 汇聚(pyi ④)。

## 顺修真缺陷(e803c330)

旧行为:entity 来源 resolve 返回 `customTypeLine ?? sourceLine`(标量属性无 customTypeLine 时回落 .def 行),lens **恒跳 types.xml**——标量属性的 .def 行号落错文件且标签误写 types.xml。修复:

- GeneratedSourceLocation 增 `sourceKind: 'types.xml'|'def'`+`propertyName` 判别面;
- lens 按来源族分目标:def 走实体注册表 defFile(逐实体 Map,generators.ts 从 getAllMappings 构建),缺映射不出镜绝不造错误跳转;types.xml 缺注册表逐镜跳过(不再当总闸,纯 def 工作区实体镜照常出);
- 标签分形:`.def:N` / `types.xml:N`;
- 测试:resolve 期望全面升级(+sourceKind/propertyName,标量回落断言 sourceKind='def')+新 lens 钉(def 镜跳 Avatar.def 选区 23 行+缺映射零镜);prove-red=lens 恢复恒跳 typesXmlPath 变异→新钉红,cp+cmp 还原;
- 门禁:eslint 0/tsc 0/unit 861 文件 10407+8skip EXIT=0/xvfb demo 25 RC=0。

## 登记候选(不阻塞)

- 方法面行映射未入 EntityTypeStubLineMap(方法只有 `# source:` 注释,无 lens)——方法镜候选,按需点火;
- URI/span/root 结构化机器可读 map 文件(JSON)不建:当前消费面=人+CodeLens(URI 级跳转已覆盖),无机器消费面避免死产物。
