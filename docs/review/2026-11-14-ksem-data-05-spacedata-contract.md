# KSEM-DATA-05(SEM-046)登记 spaceData 契约 — 纪实

日期:2026-11-14。todo.md SEM-046(旧 KSEM-DATA-05):登记 spaceData 契约。验收:核实 key/value 字符串约束、空间范围、客户端可见路径和 _mapping 保护规则,记录出处。

## 交付面(登记型,零生产码)

### 引擎真源核实(全部逐行验过,出处见 docs/knowledge/api-cellapp.md §2 spaceData contract)

1. **形态**:spaceData 非字典属性——三模块函数带首参 spaceID(cellapp.cpp:183-185,绑定 spacememory.cpp:697/754/810),逐空间存储(SpaceMemorys::findSpace 失败→AssertionError set:733/get:790/del:846);
2. **key/value 字符串约束**:PyArg "Iss"/"Is" 解析期拒非串(set:709/get:766/del:822),空 key 三函数全拒(set:725/get:782/del:838),引擎注释明示字符串-only 动机=客户端兼容(spacememory.h:127);get 返回 str(:806)、缺失键抛 AssertionError(:799)——绑定先查存在性,C++ 层缺键回空串路径(:582-590)到不了脚本;
3. **客户端可见路径(只收不发)**:变更通知空间内持 Witness 实体(ClientInterface::setSpaceData/delSpaceData 逐次 :636-653 + witness 挂接时 initSpaceData 全量快照 :658-684);客户端本地副本 app.spacedata(js 模板 kbengine.js:4846-4870;UE4 getSpaceData(key) 读本地 KBEngine.cpp:1132)——客户端 SDK 无 set/del,不可写;_mapping 下发客户端会本地触发 addSpaceGeometryMapping(kbengine.js:4856/KBEngine.cpp:1097);
4. **_mapping 保护规则**:set 与 del 大小写不敏感拒(kbe_stricmp)→AssertionError "key{_mapping} is protected!"(set:740-742/del:862-864);**get 放行**——_mapping 即空间几何映射路径,引擎经 addSpaceGeometryMapping→setGeometryPath 自写(spacememory.cpp:543-554),getSpaceGeometryMapping 读它;
5. **回调**:onSpaceData(spaceID, key, value) 入口脚本;del 派发 value=None(spacememory.cpp:607-632)。

### kode 现状核实(面与出处)

- cell 进程 API 三函数 str 注解签名齐(typings/cell/KBEngine/_module.pyi:124-130,embed 于 process-api.json);bots/client 带单键读形态 `getSpaceData(__key: str) -> str`、无 set/del——与引擎接收单向路径一致(客户端本地副本单键语义);
- 入口钩子 onSpaceData 已登记(src/backend/entryHooks.ts,SpaceMemory::onSpaceDataChanged 出处,Iss/IsO 格式串);
- 共享数据字典索引刻意不含 spaceData(KBENGINE_DATA_DICTS=globalData/baseAppData/cellAppData;函数形态非字典属性)。

### 缺口账(记录不预造)

实参校验面(空 key/非串 value/_mapping 写/spaceID 存在性)无诊断发射面;静态 setSpaceData 调用点未收编键位补全——spaceData 键可容纳与三字典同款的写点索引,留给后续批次点火。

## 测试(`tests/ksemData05SpaceDataContract.test.ts`,4 例审计钉)

cell 三函数签名+pyi 行号钉/bots-client 单键读+无写 API 钉/onSpaceData 钩子登记钉/索引范围三元+函数形态零收录钉。prove-red 不适用=零生产码,断言即当前真值(DATA-01 同款口径)。

## 文档

docs/knowledge/api-cellapp.md:§2 表行改述(:183-185 校正既有 :182-184 偏移+指向契约小节)+新增 §2 spaceData contract 小节(五点契约全出处);§5 无偏差行(素材与 fork 一致,无 deviation)。

## 门禁

compile 0 / eslint 0 / vitest 全量(见 todo.md 勾行时点数)/ xvfb demo 25 RC=0。
