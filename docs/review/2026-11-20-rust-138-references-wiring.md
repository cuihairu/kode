# RUST-138 批 3:References 生产接线(textDocument/references 上线,服务面=语义引用)

日期:2026-11-20
todo.md 行:`RUST-138(旧 LSP-005)References:跨 root 实体/方法/组件/类型,区分语法同名和真实语义引用。`
本批边界:**LSP 接线 + TS 薄壳切换**(批 2 语义分类面之上)。产品面裁定=语义引用(`semantic_reference_locations`——「引用=类型 IR 可证」,Shadow/Dangling 不入生产结果);entityMapping 运行时半边(python 键族)仍归 TS,不在本批。

## Rust 侧

- `kode-protocol` 新 wire DTO:`ReferenceContext{includeDeclaration}` + `ReferencesParams{textDocument,position,context}`(LSP 标准形;协议走 RUST-055 单一真源,schema + TS 生成件同批再生)。
- `server.rs` 顶层臂 `textDocument/references` → `handle_references`:与 hover/definition 同一装配线(CanonicalUri → root_for → DocumentKey → drain_index_for_request → open_buffer)。服务面 = `HoverEngine::semantic_reference_locations`(非位置面——跨 root 同名异声明 Shadow 与不可解析 Dangling 不入列);未打开/未知目标/空结果/非语料文档(python/entities/alias)一律 null 回 TS,不报错。

## TS 侧

- `kodeCoreShadowFaces.ts` 新 `serveReferencesFromRust(document,position,includeDeclaration)`:语料门(def + 三类 XML 同口径)先行,镜像 + 请求 + 交互预算(awaitWithInteractiveBudget)一条龙;非数组壳或任一条目缺 uri/range 四元 → 整面作废 null(不做部分采用,保 TS 集完整),调用方回 TS 既有链。
- `languageProviders/references.ts` 两处缝接线(其余分支不动):
  1. types.xml 符号引用臂(provideTypesXmlReferences 前);
  2. def 语料符号臂(findDefSymbolInfo miss → provideDefSymbolReferences 前)。
  Rust 命中即投影 vscode.Location(uri=canonical 路径 Uri.file 直挂,0 基行列直传);miss/null 回 TS 原链,行为与接线前逐位一致(门未装配/非服务轨道零开销)。

## 测试

- 单测 `tests/kodeCoreShadowFaces.test.ts` +8(合 49):rust 轨道返回面与 includeDeclaration 参数透传、无引用 null、畸形条目整面作废、非数组壳作废、python 直通、ts 轨道零开销、门未装配、请求失败兜底。替身 stub 的 request 记录补 params 字段(向后兼容)。
- E2E(真实二进制)`tests/kodeCoreServingE2E.test.ts` 新套件 5 例:
  1. def 类型引用 SKILL_SLOT → types.xml 声明行(0 基 13)先行 + Avatar.def `<of>` 使用位(0 基 40);
  2. includeDeclaration=false 不含声明行;
  3. types.xml 符号引用 ITEM_ID → 唯一使用位(无声明位,TS 同口径);
  4. **跨 root 同名异声明(Shadow 区分判据)**:双根 initialize workspaceFolders 注册,同名 RATING 两根各持独立声明,两根语料全量镜像;root-a 查询只收 root-a 声明+同根使用位,root-b 声明与使用位一律不入列(`uris.every(startsWith rootA)`);
  5. python 文档零请求直通 null。
- 回归:kodeReferencesParity(批 1 位置面 3 例)/kodeReferencesSemanticParity(批 2 镜像 4 例)/protocolSchema 三锁照绿。

## 门禁(2026-11-20)

- `cargo test -p kode-server`:833 passed / 0 failed;
- `cargo clippy -p kode-server -p kode-protocol --all-targets -- -D warnings`:0;
- `tsc --noEmit`:0;
- vitest 触达面:kodeCoreShadowFaces 49 / kodeCoreServingE2E 15 / protocolSchema 3 / kodeReferencesParity+SemanticParity 7 / defSymbolReferences+kodeCoreGateWiring+kodeCoreClient 57,全绿。

## 余(如实登记)

- entityMapping 运行时引用半边(python self 属性访问/方法实现/receiver 调用/数据字典·cellData·spaceData 键族)仍 TS 生产,不随本批切换;
- 位置面(references_at,含 Shadow)仍留 golden/对拍车道,不暴露 wire。
