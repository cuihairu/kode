# RUST-169 审计:类型生成器 provider 可扩展 × 官方核心类型 IR 唯一数据源

- 日期:2026-11-17
- 结论:**审计结案,基线零生产码改动**。唯一数据源不变量以新钉钉死(`tests/entityTypeStubs.test.ts` 尾节「RUST-169 唯一数据源:同注册表跨 plan 裁定一致」);「provider 可扩展」按注入缝现状裁定入档,插件注册式 API 不建(死产物纪律)。

## 官方核心类型 IR:单一提取、单一 arbiter

生成器车道的数据流(全部消费面共用一条提取链):

```
def / types.xml / alias.xml / entities.xml
        │  单点提取
        ▼
getCustomTypeInfos(workspaceRoot)          (src/definitionWorkspace.ts)
        │  引擎规则单点 arbiter
        ▼  dedupeCustomTypesByName(datatypes.cpp addDataType:拒重复注册,
           types.xml 先见保留 / alias.xml 后到作废)
CustomTypeInfo[]  ←—— 官方核心类型 IR(TS 生成器车道)
        │
        ├─ buildPythonTypeStubPlan(customTypes)        kbe_types 分件桩
        ├─ buildEntityTypeStubPlan(mappings,customTypes) 实体桩
        ├─ 交互注解解析链(completion/hover)           STRUCT-08 四钉同源
        └─ RUST-167 类型预览(消费两 plan 产物+注册表)
```

- **零二次解析**:`buildPythonTypeStubPlan` / `buildEntityTypeStubPlan` 都是纯函数,输入只有注入的 `readonly CustomTypeInfo[]` / `readonly EntityMapping[]`;两个生成器文件对 types.xml/alias.xml 零直接解析(fs 读只在落盘 unchanged 比对)。生成器内部也不绕行——`collectCustomTypeModules`(`src/entityTypeStubs.ts:315`)直接复用 `buildPythonTypeStubPlan(group)` 产模块映射。
- **单一 arbiter 贯穿每个消费边界**:实体桩上下文表(`src/entityTypeStubs.ts:337`)、别名解析链上下文(`buildResolutionContext`,`src/pythonTypeStubs.ts:446`)、公开解析入口(`resolveAnnotationTypeWithRegistry`,`src/pythonTypeStubs.ts:392`)全部经同一个 `dedupeCustomTypesByName`;同名裁定在任一消费面都不可分叉。
- **既有钉**:同名去重(`tests/pythonTypeStubs.test.ts:517`)、存根 plan 与交互解析链同源一致(KSEM-STRUCT-08 套件,`tests/pythonTypeStubs.test.ts:1281` 四例:同名两源/属性面同名/循环别名/未知类型两向一致)。

## 新钉:跨 plan 裁定一致(RUST-169 增量)

既有钉各自面内一致;新钉把「同一注册表数组」同时喂两个 plan,断言裁定全链一致:

- 类型桩:同名两源(ITEM_INFO=UINT32@types.xml:3 先见 / ITEM_INFO=UINT8@alias.xml:9 后到)→ 只发射先见条(注解按引擎内建映射 UINT32→int)+ 后到条落 skipped(原因指认 winner 的 types.xml 出处);
- 实体桩:同一数组下属性 `customTypeLine` 取先见条行 3,并显式断言 `not 9`——arbiter 若退化成裸 last-wins,此面立即翻红。

## provider 可扩展:现状裁定

1. **注入即缝(已建)**:两个导出入口都有显式 provider 注入口——`exportPythonTypeStubs` / `exportEntityTypeStubs` 的 `options.listCustomTypes`(默认 `getCustomTypeInfos`)与 mappings 注入;plan builder 纯函数数据进数据出。RUST-167 类型预览是活的组合实证:不改生成器一行,即组成第三个消费面(实体 plan + 类型 plan + 注册表 → 预览树)。
2. **插件注册式 API 不建**:零消费面——仓内没有任何「第三方类型生成 provider」需求方;按死产物纪律(RUST-158/160/164 同裁定)不预建抽象。旧 provider 选择开关 `kbengine.python.stubSourceMode` / `kbengine.python.stubEngineTypings` 已随 2026-11-11 静态模板车道退役(configuration.md 设置总账有记载);未来出现真实消费方时随消费面一起建。
3. **唯一数据源不因扩展而破**:任何 provider 实现喂的都是同一形状的 `CustomTypeInfo[]`,arbiter 在消费端单点把关——新钉保证「喂什么数组,两个 plan 就一致裁定什么」。

## 边界(不声称的部分)

- Rust 分析车道(`references.rs` / `definition.rs` / `diagnostics.rs`)有自己的 def/types 提取,为分析面服务;两车道间一致性由 KSEM-STRUCT / RPC 系列对账钉覆盖,不在本条(生成器车道)范围内。
- 「API provider 可扩展」若被理解为「外部插件注册自定义类型生成器」,现状未建(见上裁定);本文档钉死的是**数据源唯一性**与**注入缝**两点,不虚构插件机制存在。

## prove-red 与门禁

- 变异:`buildEntityTypeStubPlan` 上下文表去掉 `dedupeCustomTypesByName`(裸 last-wins Map)→ 新钉红 1(实体桩 customTypeLine 翻成后到条行 9);cp 备份 + cp 还原 + `cmp` 字节校验,复跑 13/13 绿。
- 门禁:eslint 0 / tsc 0 / unit 全量 EXIT=0 / xvfb demo 25 RC=0(数字见 todo.md 勾行)。
