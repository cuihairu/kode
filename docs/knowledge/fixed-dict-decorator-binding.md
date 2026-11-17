# FIXED_DICT 装饰器路径:@EntityDef.fixed_dict 的绑定闸与静默不绑

依据:fork KBEngine(HEAD 55a66552)`kbe/src/lib/entitydef/py_entitydef.cpp` + `entitydef.cpp`。本档钉 **types.xml implementedBy 之外的第二个 FIXED_DICT 实现绑定入口**——`@EntityDef.fixed_dict()` 装饰器;types.xml 路径(datatype.cpp 三连 GetAttrString 装载失败响)见 user-type-impl-contract.md,两档互补不重叠。DefContext 后续消费链(assemblyContexts→DataType 注册)不在本档范围。

## 1. EntityDef 模块与两段调用机制

引擎以 C++ 模块 `EntityDef` 暴露类型装饰器(entitydef.cpp:2461):

```cpp
script::entitydef::installModule("EntityDef");
```

每个装饰器方法(rename/method/property/entity/interface/component/fixed_dict/fixed_array/fixed_item)经 PY_DEF_HOOK 生成:`__py_def_<name>(args, kwargs)` 深拷贝实参入栈 CallContext 后返回 `__py_def_parse` 的 PyCFunction。装饰器表达式 `@EntityDef.fixed_dict()` 求值序(CPython 语义):`EntityDef.fixed_dict` 取得工厂→工厂调用入栈返回 parse-callable→被装饰对象作为第一实参触发 `__py_def_parse`。**绑定判定在装饰器表达式求值时刻执行**——模块顶层位于装饰器之后的属性附加语句此时尚未运行。

## 2. fixed_dict 分支:三属性存在性闸与静默不绑(py_entitydef.cpp:1178-1197)

```cpp
else if (defContext.optionName == "fixed_dict")
{
	defContext.isModuleScope = true;

	if (PyObject_HasAttrString(pyFunc, "createObjFromDict") && PyObject_HasAttrString(pyFunc, "getDictFromObj") && PyObject_HasAttrString(pyFunc, "isSameType"))
	{
		defContext.implementedBy = pyFunc;
```

- **绑定条件=三契约属性的存在性**(`PyObject_HasAttrString`,与 types.xml 路径的 GetAttrString 同为存在性判定):属性以何种形态出现不限——嵌套 def、属性赋值、lambda 附加均可,没有「必须是 def」的约束。
- 条件成立 → `defContext.implementedBy = pyFunc`(:1184),模块名取 `__qualname__`:

```cpp
defContext.implementedByModuleName = PyUnicode_AsUTF8AndSize(pyQualname, NULL);
```

- **条件不成立 → 静默不绑**:if 块(:1182-1196)后直接收束(:1197),**无任何 else 报错分支**——装饰器零异常返回,implementedBy 不绑定。与 types.xml 路径「三契约缺失=装载失败响」构成**响/沉默第二对不对称**(第一对=FD 构造点响/已知键下标静默,见 fixed-dict-construction-site.md)。

## 3. 处理链后段三道响闸

装饰器分支之后,`__py_def_parse` 还有两段公共处理,`fixed_dict` 不在任何排除表内:

- **self 参数闸**(:1295-1302;排除表仅 rename/fixed_array):被装饰对象经 `inspect.getfullargspec` 取参表,零参 → AssertionError 响:

```cpp
PyErr_Format(PyExc_AssertionError, "EntityDef.%s: \'%s\' did not find \'self\' parameter!\n", defContext.optionName.c_str(), moduleQualname);
```

- **模块域一段闸**(:1240-1249;isModuleScope=true 走 else 臂):`__qualname__` 按点分段须恰一段(模块顶层定义);嵌套定义(两段及以上)→ AssertionError 响:

```cpp
PyErr_Format(PyExc_AssertionError, "EntityDef.%s: error! such as: @EntityDef.rename()\n\tdef ENTITY_ID() -> EntityDef.INT32: pass\n", defContext.optionName.c_str());
```

- **未知 optionName 闸**(:1211-1214):`@EntityDef.<其他名>` → AssertionError 响:

```cpp
PyErr_Format(PyExc_AssertionError, "EntityDef.%s: not support!\n", defContext.optionName.c_str());
```

## 4. CPython 求值序下的静默降级形态

`@EntityDef.fixed_dict()` 装饰模块级函数、三契约属性以**装饰器之后**的顶层语句附加(`TAVATAR.createObjFromDict = ...`)——按 §1 求值序,绑定判定先于属性附加执行,三属性存在性必然为假 → §2 静默不绑:**零报错、零绑定**。作者以为自定义实现已挂载,实际该类型未走实现绑定,全程无任何提示(静默降级)。合法替代:先构造完整对象(属性就位),再显式两段调用 `EntityDef.fixed_dict()(obj)` 完成绑定。

## 5. kode 面现状与静态分析含义

kode 无装饰器分析面:`parsePythonFile` 只收类(PythonClassDef 无 decorators 字段,模块级函数装饰器零面);`implFileHasContractMethod` 正则只认 def 形态(`^\s*def name\(`),对赋值/lambda 附加形态恒 false——user-type-impl-contract 族登记的「kode 只认 def 形态」误报分歧在装饰器路径同样成立(绑定条件同源存在性判定)。静态面后果:§2 静默不绑(用户无感知)、§3 三道响闸(装载期可响)均零覆盖=漏报方向缺口;装饰器路径整体收编归独立批,本档只钉真值不冒充修复。
