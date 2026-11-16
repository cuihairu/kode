# RUST-144 批 2 验收纪实:defPropsInlayHints 决策核下沉 Rust(def_props_hints.rs)

日期:2026-11-16。todo 行:RUST-144(InlayHints (RPC 参数名/类型) 与 SemanticTokens;本批=def 属性只读视图 inlay 决策核+golden 双向门禁;批 3=SemanticTokens 新面与增量 token 成本评测)。

## 交付面

- `crates/kode-server/src/def_props_hints.rs`(新建,~590 行):三纯面同构下沉,纯库零 RPC,UTF-16 单元域;
- `crates/kode-server/src/bin/dump-def-props-golden.rs`(新建):golden 生成器;
- `crates/kode-server/tests/golden/def-props-parity.json`(生成,8 语料/16 探测/16 产出);
- `crates/kode-server/tests/def_props_golden.rs`(新建,2 测试):重生成比对+结构完整性(语料≥8/探测≥14/两面覆盖/产出形态含**奇偶 index 段语义审计**:奇数=属性段、偶数>0=间隔段);
- `tests/kodeDefPropsParity.test.ts`(新建,3 测试):TS 镜像读 corpus+probes 驱动生产 findDefPropsAnchorSites/buildDefPropsInlayItems(workspaceRoot='')逐探测对拍;
- `src/lib.rs`(Rust):两处接线。

## 纯面清单(逐条对 TS 生产源核过)

1. **注释锚提取**(findDefPropsAnchorSites):整行注释闸(trim 后以 `#` 起)+精确 token `kode:props-from-def`;代码行尾注释/字符串字面量同词不触发;前导空格整行注释触发;character=行文本 UTF-16 长度;
2. **根级过滤**(isRootLevelProperty):组件槽成员(componentSlotName 存在)与 FIXED_DICT 子键(propertyPath 带 `.`)不进总览;propertyPath 缺省回落 symbolName;
3. **组装面**(buildDefPropsInlayItems):头部段 `def 属性(N)`(悬停=只读视图说明)+逐属性段 `name: 注解`,**间隔段 ` · ` 自第 2 属性起前插**(首属性紧跟头部,无间隔);typeName 缺失/落 Any(未知/ENTITYCALL/PYTHON 表值/ALIAS)→裸名不伪造;可解析→`name: 注解`(与 hover/stub 同链空根内建直查);partTooltip=`basename:行 · 域/ · 持久化`(两种斜杠 basename;无域无持久化只剩出处);根级零 → None。

## 真缺陷:ENTITYCALL 落 Any 未闸(钉即时拦截)

初版组装直接 `resolve_annotation_direct(type_name)` 的 Some/None 判注解——**ENTITYCALL 表值 Some("Any") 被当正常注解输出 `remote: Any`**,而 TS 判据是结果 `=== PYTHON_TYPE_STUB_FALLBACK` → 裸名。单元钉 any_falls_back_to_bare_name 首跑抓出(`remote: Any` 混入 texts)。修=`.filter(|a| a != "Any")`(与批 1 defParam 的 Any 闸同族语义,两处调用点判据一致)。教训:`resolve_annotation_direct` 的 None=「解析不出」与 Some("Any")=「表值恰为 Any」是**两个不同的裸名路径**,消费面必须双闸。

## 坑账

1. **parts 奇偶 index 语义**:`头部(0)/属性(1)/间隔(2)/属性(3)/…`——首属性 index 1,间隔段自 index 2 起偶数。钉初版按「属性段从 2 起偶数」过滤被间隔段全占(`[" · "," · ",…]`)——实际布局与直觉相反,断言值从实现+TS 源逐 index 推;
2. **单属性无间隔段**:root_level_filter 钉初版期望 `头部+间隔+属性` 三段,实际单属性时 `if parts.length > 1` 恒 false → 两段;
3. **CJK 锚 character 算错**:`# 注释 kode:props-from-def` = 1+1+2+1+19=24 单元(钉初版写 21);
4. **serde 可选字段**:tooltip/propertyPath 缺省时键必须缺席(TS undefined 序列化丢键)——`#[serde(skip_serializing_if = "Option::is_none")]`,否则镜像深比不等。

## golden 形态

`{generator, corpus, probes, outcomes}`;corpus 条目 `{name, text(py 源), properties(PropertyDefFace 清单)}`——**属性清单语料化**(实体归属链 python 文件→def 属性的运行时索引是诚实边界,不在本核);probes 两 face(anchors 8/items 8 语料×锚数 16 总);产出 camelCase,可选键缺席与 TS undefined 同形。

## Rust 单元钉(4,全绿)

anchor_only_full_line_comments / root_level_filter / any_falls_back_to_bare_name / tooltip_composition。

## prove-red(双端四靶,全闭环;cp 备份+变异+跑测+cp 还原+cmp 字节校验+grep 钉存在性复绿)

- Rust 靶 1:删 Any 裸名闸(`.filter(|a| a != "Any")` 删除)→ any_falls_back_to_bare_name 红 → 还原 → 4/4 绿;
- Rust 靶 2:禁用根级过滤器(componentSlotName 闸 `false &&`)→ root_level_filter 红 → 还原 → 绿;
- Rust 靶 3:禁用整行注释闸(trim().startsWith('#') `false &&`)→ anchor_only_full_line_comments 红 → 还原 → 绿;
- TS 靶:生产 Any 裸名判据 bypass(`false && annotation === FALLBACK`)→ 镜像对拍红 1 例 → 还原 → 3/3 绿。

## 诚实边界(批 3 范围)

实体归属链(listPropertyDefinitionsForFile:python 文件→所属实体→def 根级属性清单的运行时索引与目录域选择)不下沉,TS 装配面(DefPropsInlayHintsProvider 配置开关/可视区 range 闸/vscode.InlayHint 构造/锚扫描的 provider 侧循环)不动;注册表快照链仍走空根内建直查(与批 1 同);SemanticTokens 新面+增量 token 成本评测=批 3。

## 门禁

eslint 0 / tsc 0 / vitest 全量 854 文件 10381+8skip RC=0 / xvfb demo 25 RC=0 / clippy -D warnings 0 / cargo 全量 77 套件全绿 0 failed / prove-red 双端四靶闭环 / golden 重生成字节锁(16 探测)。
