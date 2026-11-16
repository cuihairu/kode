# RUST-155 审计结案:自定义 type(含 types.xml 引用的用户定义)生成有效 .pyi

日期:2026-11-17
性质:审计结案(基线零改动)——生成线与有效性校验已系统性建成。

## 生成线(src/pythonTypeStubs.ts + src/entityTypeStubs.ts)

1. **源采集**:CustomTypeInfo 来自 types.xml+alias.xml(同目录合并,pyi ④ 起按镜像目录分模块,entityTypeStubs.ts:307);`dedupeCustomTypesByName` 同名去重与引擎 addDataType 语义同源(types.xml 先注册、alias.xml 后到,同名后到整条作废不发射,poisoned 与作废名都不进——datatypes.cpp 拒重复注册);
2. **两形发射**(buildPythonTypeStubPlan,pythonTypeStubs.ts:538):FIXED_DICT → class(TypedDict 形,属性逐个注解+propertySourceLines 源行);其余条目 → alias 注解(resolveAliasInfo,解析后只含内建/typing/类名/引擎别名,不再互相引用,发射按名字序与输入序无关);
3. **用户定义逐层下钻**:resolveCustomTypePropertyAnnotation 解析链/resolveFixedDictMember(types.xml 自定义类型成员下钻到内建,成员缺失走 FIXED_DICT_DICT_METHODS 方法面);成环/指引为空/级联失败记 poisoned 不发射该条——不造伪 .pyi;
4. **有效 .pyi 形**:renderPythonTypeStub(:657)——`from __future__ import annotations`、typing 条件导入(TypedDict/Union/Callable/Dict/List/Tuple/Any)、KBEngine 条件导入(Entity 恒导,FixedArray/Vector2-4/引擎别名按注解面出现才导)、跨分件引用按模块逐组 import(externalModules,pyi ④);头部钉管理目录与覆盖纪律(用户自配目录同名文件按用户资产不动);
5. **源行回填**:entryLine/propertyLine 记录(recordEntryLine/recordPropertyLine)→ generatedSourceLenses「原始定义: types.xml:line」与 entityTypeStubs `# source: .def:N -> types.xml:M` 同源。

## 有效性校验(pyrightStubGate,IDE-STUB-002)

src/backend/pyrightStubGate:生成 stub 后接 pyright(CLI 优先 `pyright`,回退 `npx --no-install pyright`);探测不可用降级纯生成+输出面板提示。树内真 pyright 1.1.414 在场,隔离测试实跑(RUST-148 批 2 验证,901ms 缓存热)。

## 测试面

tests/pythonTypeStubs.test.ts(计划/渲染/去重/poisoned/跨模块)、tests/entityTypeStubs.test.ts(实体 stub 集成含 customTypeLine 源行)、tests/entityStubRegen.test.ts(再生幂等)、tests/pyrightStubGate.test.ts(CLI 探测/诊断解析/降级)。

## 结论

任务(自定义类型含 types.xml 引用的用户定义 → 有效 .pyi)已由生成线+pyright 校验门+四测试套件系统性满足。基线零改动。
