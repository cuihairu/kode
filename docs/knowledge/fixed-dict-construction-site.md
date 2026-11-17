# FIXED_DICT 构造点:实体属性整赋值的三道响闸与下标点的不对称

依据:fork KBEngine(HEAD 55a66552)`kbe/src/lib/entitydef/entity_macro.h` + `datatype.cpp` + `fixeddict.cpp`。本档钉「构造点」(把整个值赋给 FIXED_DICT 类型实体属性,如 `self.profile = {...}`)的引擎真值;子键陷阱面(下标逐键赋值)见 fixed-dict-sync-trap 族与 api-core-concepts.md §1.5,两档互补不重叠。

## 1. 实体属性赋值总闸(entity_macro.h:779 onScriptSetAttribute)

脚本里对 .def 声明属性的赋值走 `onScriptSetAttribute(attr, value)`:

- entity_macro.h:794:实体已销毁 → `AssertionError "can't set %s.%s to %s. entity is destroyed!"`(响)。
- entity_macro.h:800-802:**类型总闸**:

```cpp
if(!dataType->isSameType(value))
```

不过闸 → `PyErr_Format(PyExc_ValueError, "can't set %s.%s to %s.", ...)`(响,赋值不生效)。

## 2. FixedDictType::isSameType 对裸 dict 的逐键验证(datatype.cpp:2497)

FIXED_DICT 类型属性的整赋值目标若为裸 dict,引擎逐键验证,**三道响闸**:

- **键数不符**(datatype.cpp:2528-2531):

```cpp
if(dictSize != (Py_ssize_t)keyTypes_.size())
```

`"FIXED_DICT(%s) key does not match! giveKeySize=%d, dictKeySize=%d, dictKeyNames=[%s], notFoundKeys=[%s]."` → TypeError(响)。
- **键缺失**(datatype.cpp:2546):

```cpp
"set FIXED_DICT(%s) error! keys[%s] not found, allKeyNames=[%s].",
```

→ TypeError(响)。
- **键值类型不符**(datatype.cpp:2555):

```cpp
"set FIXED_DICT(%s) error! at key: %s(%s), allKeyNames=[%s].",
```

→ TypeError(响)。
- 逐键通过 = 合法构造(整赋值是 FIXED_DICT 推荐姿势,见 fixed-dict-sync-trap 族沉默臂同向)。
- **impl 契约先行**(datatype.cpp:2509):`if(impl_isSameType(pyValue))` 为真直接放行——自定义实现类实例即使在裸 dict 形状之外也合法;impl 判 false 不短路,继续走原生形状判断(datatype.cpp 注释明示「fixeddict 或者用户产生的类别都应该是合法的」)。

## 3. 与下标点的不对称(对比面)

子键赋值路径(`self.profile['level'] = 5`)走 `FixedDict::mp_ass_subscript`(fixeddict.cpp:272):

- fixeddict.cpp:295:`if(!fixedDict->checkDataChanged(dictKeyName, value))` → **已知键但值类型不符时 checkDataChanged 返回 false,赋值静默丢弃(return 0,无任何异常)**——与构造点的响闸形成不对称:构造点响、已知键下标静默。
- 下标路径的响闸:未知键 `set FIXED_DICT to a unknown key[%s]`(TypeError)、删除已知键 `can't delete from FIXED_DICT key[%s]`(TypeError)。

## 4. 静态分析含义

构造点错误全部是**运行期响错误**(装载后运行时抛 ValueError/TypeError),装载期不拦;静态面若对「FD 属性整赋值裸 dict 的键集完整性」零覆盖,则这三类错误全部漏报(编辑期不可见,运行期才炸)。
