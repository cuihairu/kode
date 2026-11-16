# RUST-156 审计结案:所有 .def entity、组件及 Cell/Base/Client API 生成相应 .pyi,保留精确参数与容器类型

日期:2026-11-17
性质:审计结案(基线零改动)——def→pyi 生成线已覆盖实体/接口/组件槽/三段方法面,参数与容器类型经共享解析链保精确。

## 覆盖面(src/entityTypeStubs.ts,entity_types.pyi 生成线)

1. **实体 def 全量**:entities.xml 注册实体(getRegisteredEntities)逐实体发射 `class <Entity>(Entity)` + mailbox face(`<Entity>MB(EntityCall)`,base/cell/client 注解按名引用);分进程桩(base/cell/bots/client 各 processStubRoot,isolated 档)按 role 过滤属性 domains 与方法段(:166-176);
2. **Cell/Base/Client API**:collectEntityTypeMethods 按 def 方法段(BaseMethods/CellMethods/ClientMethods)收方法;角色桩方法过滤 section 精确匹配(:411 三段映射);远端 face=MB 类(Mailbox face 注释 :608);方法面独立开关 `kbengine.python.entityStubMethods`;
3. **接口/组件槽**:defChain 接口固定解析到 interfaces/ 且递归装载自身 Interfaces(KR-AUD-76 引擎 loadInterfaces 口径,entitydef.cpp:611-638)连带组件槽入链,同名去重防环(defChain.ts:69-125);组件 def 按 components/ 池解析,组件 Parent 链走组件池(category==='component' → components 目录);折叠成员随链进入实体桩的 propertyDefinitions/method 面;
4. **精确参数**:methodFaceLines(:662)逐形参 `argN: <注解>`,注解经 resolveAnnotationTypeWithRegistry 共享解析链(与 hover 签名同链,2026-10-21 收口令)——types.xml 自定义类型逐层下钻到内建,链断/成环/未知落 Any 不硬造;
5. **容器类型**:ARRAY of 折叠 → `FixedArray[<元素注解>]`(def 属性运行时真实容器 GEN-DEF-1b,非 Python list;:367-378 元素子路径折叠+同链解析升级);FIXED_DICT → kbe_types.pyi 发射类名(customTypeModules 跨分件引用);GEN-DEF-1 容器属性 __init__ is None 守卫(仅引用型,判定与注解同链禁第二套);

## 有效性

pyrightStubGate(IDE-STUB-002)落盘 stub 统一收 pyright 校验(entity_types.pyi+KBEngine.pyi+kbe_types 分件镜像逐一枚举,RUST-155 在案);陈旧探测/写盘失败两面分离(5200bfc0 回归修复,:171-181)。

## 测试面

tests/entityTypeStubs.test.ts(FIXED_DICT 守卫/ARRAY 折叠 `FixedArray[ITEM_INFO]` :211/域过滤)、tests/entityStubRegen.test.ts(再生幂等)、tests/pyrightStubGate.test.ts、tests/pythonExtraPaths.test.ts(分进程 extraPaths 消费)。

## 结论

任务(全部 def entity+组件槽+Cell/Base/Client API → .pyi,精确参数+容器类型)已由实体桩生成线+共享解析链+pyright 校验门系统性满足。基线零改动。
