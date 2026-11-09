# KODE-CFG-017-R：消费面富化（`.kbengine/inferred` 读副本）

> 状态：实现（2026-11-09 落地）。源：todo.md line 1095 KODE-CFG-017-R。
> 前置：KODE-CFG-017 扫描面（合入 0012c98e）——`inferredCopy.ts` 镜像层、
> `inferPipeline.ts` 装配层、`pyreflyInfer.ts` 推断层已落地；镜像生成与
> 隔离面（search.exclude / watcherExclude / gitignore）已接线。

## 1. 问题与目标

kode 的 hover/inlay/补全 provider 对 **KBEngine def 类型** 解析很强
（entityMapping / PythonClassIndex / databaseSchema），但对 **普通 Python
符号**（非实体属性的函数返回、参数类型、局部变量）无类型信息——pyrefly
`infer` 已把这些推断注解写进 `.kbengine/inferred/` 镜像（用户真码不改），
但**没有任何消费方读它**（inferPipeline.ts 头部明言「消费面后续批次接入」）。

目标：kode 原生 hover/inlay provider 读 `.kbengine/inferred` 副本，在 kode
语义引擎给出弱/无类型时，用 pyrefly 推断注解**富化**展示。

## 2. 铁律（T-04 禁遮蔽）

- **镜像不进 extraPaths / 导入解析**：`.kbengine/inferred` 是 pyrefly 注解
  产物，**绝不**加入 `python.analysis.extraPaths` 或任何 import 解析面
  （T-04 同款：同名 `.py` 遮蔽红线）。extraPaths 只含 scripts 根 +
  `.kbengine/stubs`（pythonStubExport 管理段）。
- **用户真码永不改**：注解只写镜像，provider 只读镜像。
- **只读、可缺省**：镜像文件缺失 / 无注解 / 解析失败 → 静默回退现有行为，
  不抛错、不刷通知（与 inferPipeline 自动面「失败只落通道」同口径）。

## 3. 镜像结构（已落地，inferredCopy.ts）

```
<managedDir>/inferred/<mirrorPrefix>/<相对路径>.py
```
- `<managedDir>`：`kbengine.managedDir`，默认 `.kbengine`。
- `<mirrorPrefix>`：`mirrorPrefixFor(workspaceRoot, scriptsRoot)` ——
  `scripts`、`assets/scripts` 等；多根不冲突。
- 内容 = 用户源码 + pyrefly `infer` 就地写的类型注解（`def f(x: int) -> str:`）。
- 源在 scripts 根内时 `mirrorPrefix + scripts 相对路径 == 工作区相对路径`，
  故镜像定位可直接按工作区相对路径拼装（`mirrorPathForSource`）。

## 4. 富化模块（已落地）

`src/inferredEnrichment.ts`（**纯逻辑，不 import vscode**）+
`src/inferredMirrorLookup.ts`（vscode 读取面，唯一含 fs/vscode 依赖）：

```ts
// inferredEnrichment.ts（纯）
mirrorRelPathFor(workspaceRoot, scriptsRoot, sourceRelPath): string;          // 镜像相对路径
mirrorPathForSource(workspaceRoot, managedDir, sourceFsPath): string | null;  // 镜像绝对路径
extractReturnAnnotation(mirrorText, symbolName): string | null;               // `def f() -> str` → 'str'
extractParamAnnotations(mirrorText, symbolName): Array<{name, type}>;         // 无注解参数跳过
extractVariableAnnotation(mirrorText, symbolName): string | null;             // `x: int` / `self.x: str`
diffInferredAnnotations(sourceText, mirrorText): Array<{line, character, label}>; // 行差分(inlay)
// inferredMirrorLookup.ts（vscode 面）
readInferredMirrorText(sourceFsPath): string | null;                          // 任何缺失 → null
createInferredMirrorHover(document, word): vscode.Hover | null;               // 链尾兜底 hover
```

提取口径：`pythonLexicalMask` 掩码保长保行（列偏移不变），定位全在掩码上
做，注解文本一律**回原文切片**（`Literal["a"]` 字面量保真、注释尾巴不串；
参数表按段内偏移 + 顶层逗号分切 + 括号配对）。行差分（inlay）宁缺毋错：
两文行数不一致（结构漂移）整批不出，单行 def 头不闭合（多行签名）该行跳过。

## 5. Provider 富化接线（已落地）

### 5.1 hover（src/languageProviders/hover.ts 链尾）
整条 KBEngine 域解析链**全部 miss**（`provideHoverTimed` 末尾 `return null`
前）：`document.languageId === 'python'` 且 `hoverShowSymbolDocs` 开时，
`createInferredMirrorHover` 出最小悬停——`**推断类型**: \`-> T\``（def）或
`\`T\``（变量）+ 已注解形参表；镜像缺失/无注解 → null（链尾本就 null）。
更强面已提前 return，本面只补缺不覆盖。

### 5.2 inlay（src/languageProviders/inlay.ts 新增 provider）
`InferredMirrorTypeInlayHintsProvider`：源行缺注解而镜像同行有 → 原位
`: <type>` / `-> <type>`（kind=Type），可视区过滤同既有 inlay 口径。
**实现取「定义点行差分」而非设计初稿的调用点实参匹配**——pyrefly 就地写
注解不改行数，逐行对比即可精确插位，无需调用点实参↔形参启发式配对。
闸 = `kbengine.infer.enabled`（镜像生产总闸：停管线即无新鲜镜像，提示随之
关；比初稿复用 `builtinTypeInlayHints` 语义更准，后者保持内建属性专属）。

### 5.3 completion：审计结论 = 不做死面（对账更正）
初稿设想「kode 无 detail 时读镜像设 item.detail」。实现前逐 face 审计
completion.ts：15 个 `new CompletionItem` 位点逐一核对——**全部 face 均自带
detail**（known types / flags / DetailLevel / hooks / reload fns / navmesh /
builtin props / def 方法签名 / 实体属性方法 / 别名类型），且 kode 补全链
**不产出普通 Python 标识符条目**（那是 Pylance/Pyright 的领地）。镜像富化
在补全面没有诚实插入点——做兜底 pass 是死代码，做通用词补全是新功能越界。
**结论：补全面不实现，此审计即该子项的交付物**；todo 勾账按此口径。

## 6. 隔离验证（T-04 测试，已落地 tests/inferredEnrichmentProviders.test.ts）

- `planPythonExtraPaths` 输出条目恒不含 `inferred`（默认发现根 + 管理段）。
- 静态审计：`src/pythonExtraPaths.ts` / `src/pythonStubExport.ts` 源码不含
  `inferredDirFor|inferredMirrorLookup|inferredEnrichment` 引用。

## 7. 可选子项（本批**不实现**，文档明示挂账）

- **非同名 stub 抽取落 `.kbengine/stubs`**：仅当用户源码无同名 `__init__`
  等（避免遮蔽），从镜像抽注解到 stubs。需 pyrefly 输出形态再评估。
- **monkeytype 运行时观测车道**：运行期收集真实类型，与 pyrefly 静态推断
  互补。需要运行环境接入，另批。

## 8. 测试（已落地）

- `tests/inferredEnrichment.test.ts`（29 例）：镜像路径映射（前缀/越界/
  自定义 managedDir）；返回/参数/变量注解（缺注解 null、嵌套泛型透传、
  字符串字面量保真、注释尾巴不串、不越行截尾）；行差分（返回/形参/赋值/
  self 属性、结构漂移整批空、已注解不出、`==` 不误配、多行签名降级）。
- `tests/inferredEnrichmentProviders.test.ts`（13 例）：hover 链尾兜底
  （def/变量/镜像缺失/无注解）、inlay 三类提示与可视区/总闸/语言闸、
  T-04 双断言。

## 9. 门禁

- `pnpm lint` 0 / `pnpm compile`（tsc）0 / `pnpm test:unit` 全绿（含新测试）/
  `xvfb-run -a npm run test:demo:editor` RC=0。
- 文档对账：本设计文档 + `docs/features.md`（en）infer 配置行 +
  `docs/zh/guide/configuration.md`（zh）infer 配置行。
- 只改 `src/`、`tests/`、`docs/`（不触 `crates/`、并发会话文件）。
