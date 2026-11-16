# RUST-153 审计结案:Python class/method/function/variable 分层 symbol 索引与 importer map

日期:2026-11-17
性质:审计结案(基线零改动)——分层索引与 importer map 已系统性建成;两处「不做」是分工裁定与无消费面裁定,非缺口。

## 分层索引现状

### Rust 侧(ruff AST,crates/kode-python/src/model.rs:15 `AstSymbols`,symbols.rs `extract`)

| 层 | 面 | 形状 |
|---|---|---|
| class | `classes: Vec<AstClass>` | 文件直属类(嵌套限定名/装饰器);方法与 `self.<n>` 属性写点挂在类上 |
| method | `AstClass.methods`(MethodSymbol)+方法域 | 域正确性由 RUST-PRECISION 批 A AST 跨度交付(嵌套类/条件 def 域修正) |
| function | `functions: Vec<AstFunction>`(model.rs:100) | name/line/character/is_async/decorators/params/end_line,模块级 def(不在类内) |
| variable | 类属性写点(挂类上)+ `module_shadows: BTreeMap<名,行>` | 顶层 Store 绑定名→最近行,仅 import 遮蔽面(graph.rs:199 消费)——**模块级通用变量符号面不做**,见裁定 |

### TS 侧(域语义消费)

- **PythonClassIndex**(src/backend/pythonClassIndex.ts:199):类/方法分层索引,C3 线性化(linearizeC3:43)、PythonMethodLocation(:113)、SelfMethodResolution(:132)——实体域归属语义;
- **WorkspaceIndex**(src/workspaceIndex.ts:61,`sharedWorkspaceIndex`,languageServices.ts:522):全 workspace 事件调用索引(allEventCalls/allEventCallsMarked)+methodsOf——def 域,分片让出调度(冷首扫不阻塞宿主);
- **KBEngineWorkspaceSymbolProvider**(src/languageProviders/references.ts:387,注册 languageServices.ts:733):def 符号前缀查询,entityMappingManager 驱动,零全仓扫描(IDE-NAV-006 交付线);
- python 通用 outline/documentSymbols 面已有 parity 套件覆盖(documentSymbols parity 在 19 parity 体系内)。

## importer map 现状(两义判别)

1. **正向(import→绑定)**——已建,三面:
   - `AstImport`(模块顶层)+ `function_import_bindings: Vec<ScopeImportBindings>`(函数作用域行区间定位调用点可见性,callgraph 接收者解析消费,graph.rs);
   - `FileImportBindings`(return_annotations.rs:51/:618 `extract_file_imports`):`FromImportBindingFace`(from X import Y as Z)+`BareImportBindingFace`(裸 import)——RUST-PRECISION 批 D 接收者级联的交付面;
2. **反向(谁 import 我)**——不存在且**裁定不建**:全部消费面(接收者推导/导入补全/跳转)只查「本文件 import 了什么→绑定解析到哪」,无任何面需要反向索引;无消费面不建,避免死索引。

## 两处「不做」的裁定

1. **模块级通用变量符号面**:python 通用符号/outline 职责按 RUST-148 冲突矩阵归 Pylance,Kode 只保留域语义所需深度(类属性写点+遮蔽面);复制即竞争。
2. **反向 importer map**:无消费面(见上)。

## 结论

任务面(class/method/function/类属性分层+正向 importer map 含作用域可见性)已由 Rust AST 索引+TS 两索引+def 符号 provider 系统性满足,验证走 parity 体系。基线零改动;两处不做登记为分工裁定。
