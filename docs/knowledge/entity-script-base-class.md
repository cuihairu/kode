# 实体脚本基类合法性检查:loadAllEntityScriptModules/isSubClass 与组件名册

依据:fork KBEngine(HEAD 55a66552)`kbe/src/lib/entitydef/entitydef.cpp` + `kbe/src/lib/server/entity_app.h` + 组件 `registerScript` 调用点,与 fork study 档 `docs/zh/study/05-entitydef-and-entity-definition.md`(「这个类必须继承自当前进程允许的 KBEngine 脚本基类,而不是任意普通 Python 类」)交叉校对。

## 1. 检查在加载链中的位置

- `entity_app.h:340`:`if(!EntityDef::initialize(scriptBaseTypes_, componentType_)){` —— 各组件(EntityApp 派生)把自己 `registerScript` 注册的脚本基类表传入实体定义初始化。
- `entitydef.cpp:146`:`loadAllEntityScriptModules(EntityDef::__entitiesPath, EntityDef::__scriptBaseTypes);` —— entities.xml 遍历时逐实体模块装载并做本档两条硬闸。
- fork study 档同向:`loadAllEntityScriptModules(...)` 负责导入 Python 实体模块、检查类是否存在、检查是否继承自合法的脚本基类,并把 `scriptType_` 绑回 `ScriptDefModule`。

## 2. 两条硬闸

- **类名闸**(`entitydef.cpp:2306-2312`):实体模块必须暴露**与模块名同名**的类:

```cpp
PyObject_GetAttrString(pyModule, const_cast<char *>(moduleName.c_str()));
```

取不到 → `EntityDef::initialize: Could not find EntityClass[{}]` → return false(实体定义装载失败)。
- **基类闸**(`entitydef.cpp:2317-2324`):

```cpp
std::string typeNames = isSubClass(pyClass);
```

返回串非空 → `EntityDef::initialize: EntityClass {} is not derived from KBEngine.[{}]` → return false。

## 3. isSubClass 语义(`entitydef.cpp:2227`)

- 遍历 `__scriptBaseTypes`,`PyObject_IsSubclass(pyClass, 基类)` **任一**为真 → valid → 返回空串(通过;IsSubclass 沿 MRO 走,间接子类同样通过)。
- 全部为假 → 把未命中的基类名拼成 `'Name1''Name2'` 形式清单返回(即错误信息方括号里的内容)。
- **空名册空转**:基类表为空时循环体不执行,`valid` 保持 false 但清单为空串 → 返回空串 = 检查通过。dbmgr 即此形态(见 §4)。

## 4. 组件名册(registerScript → scriptBaseTypes_)

- `entity_app.h:390-394`:`registerScript(PyTypeObject* pto)` → `scriptBaseTypes_.push_back(pto);`(组件在启动期逐个注册本进程合法的脚本基类)。
- **cellapp**(`cellapp.cpp:158-159`):

```cpp
registerScript(Entity::getScriptType());
registerScript(EntityComponent::getScriptType());
```

- **baseapp**(`baseapp.cpp:414-416`):

```cpp
registerScript(Entity::getScriptType());
registerScript(Proxy::getScriptType());
registerScript(EntityComponent::getScriptType());
```

- **dbmgr**(`dbmgr.cpp:274-275`):局部空表 `std::vector<PyTypeObject*> scriptBaseTypes;` 直传 `EntityDef::initialize(scriptBaseTypes, componentType_)` —— 空名册 = 基类闸空转(任何类都过,见 §3)。
- loginapp/bots 源码中未见 `registerScript` 调用(浅查口径,不据此断言其行为;kbcmd 与 dbmgr 同空表形态);client 侧 `ClientApp::registerScript`(`clientapp.cpp:218-223`)机制同 `entity_app.h`。
