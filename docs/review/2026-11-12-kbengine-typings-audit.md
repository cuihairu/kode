# KBEngine typings 源码、文档与类型提示核验

核验日期：2026-11-12。结论：**已有较广 API 覆盖，但实现尚不完整，且存在直接破坏类型提示的高优先级问题。** 本次仅新增核验报告，未修改实现。

后续状态：本报告记录修复前的快照。按进程拆分及类型提示修复现已实现，
见 [Python process typings](../design/python-process-typings.md) 与
`typings/README.md`；下文旧路径及诊断数量用于保留原始核验依据。

## 基准与核验范围

- kode HEAD：`b31e2daaeb15338b50adb32d4934e3eabfec60cc`。工作区已有其他未提交修改，本报告对照当前磁盘上的 typings。
- 实际派生源：`/home/cui/workspaces/kbengine/typings`，来源 `https://github.com/cuihairu/kbengine`，最近修改 typings 的提交 `28d2117`，与 kode README 一致。
- 本地引擎 HEAD：`3082ab50d24f551336b52170a7388891914968fd`。C++ 基准为该检出的 `kbe/src/`。
- 配套文档：`/home/cui/workspaces/kbengine/docs/api/kbengine/`，重点核对 baseapp/cellapp 的 Entity、Proxy、模块 API，以及 logger。
- 上游入口：[KBEngine 源码](https://github.com/kbengine/kbengine)、[官方文档](https://kbengine.github.io/docs/)、[官方 API 源文件入口](https://github.com/kbengine/kbengine/tree/master/docs)。上游文档用于确认来源，fork 行为以本地源码为准，未将其他分支的新 API 当成本 fork 的缺漏。
- 扫描全部 22 个 `.pyi` 的语法与声明，运行 Pyright 1.1.414，抽查 C++ 参数解析、注册表、回调调用点；提取主要进程模块注册函数并比对声明名称。未启动全部引擎进程逐 API 执行，不宣称所有签名和默认值均已验证。

## 验证结果

1. 在临时目录重跑 `derive-kbengine-stub-typings.mjs --typings ../kbengine/typings --out <temp>/derived --pin 28d2117`：生成 23 个文件，与当前 `typings/` 逐文件比较无差异。证明派生可复现；不代表源声明正确。
2. `pyright --pythonversion 3.11 typings/KBEngine --outputjson`：22 个文件，**13 个 error**。
3. `vitest run tests/kbengineStubTemplate.test.ts tests/pythonStubExport.test.ts tests/pythonExtraPaths.test.ts tests/pythonStubDir.test.ts`：**4 个测试文件、86 个测试全部通过**。这些检查验证模板形状、复制和接线，未发现下述真实类型解析问题。
4. 单独配置 `stubPath` 指向 kode/typings，对调用样例执行 strict Pyright，复现 `Any` 泄漏、合法 baseapp 调用误报、向量读写误报。随后仅在临时副本中加入同名 `as` 重导出，再跑样例，确认类导出问题的根因。

## 已确认问题（按优先级）

### P1：包入口没有显式重导出类，类退化为 Any

位置：`typings/KBEngine/__init__.pyi:30-39`；生成位置：`scripts/derive-kbengine-stub-typings.mjs` 的 `emitInit`。

`.pyi` 中 `from .Entity import Entity` 不等于公开重导出。当前又提供了模块级 `__getattr__ -> Any`，使正常使用悄悄退化：

```python
import KBEngine
from KBEngine import Entity, Vector3
reveal_type(KBEngine.Entity)  # Any
reveal_type(Entity().position)  # Any
```

在临时副本改成 `from .Entity import Entity as Entity` 后，第一个结果恢复为 `type[Entity]`。其他逐类导出和 Vector2/3/4 同样需要处理，可采用显式同名别名或正确的 `__all__`。

影响：实例成员补全、参数校验、跳转信息受损，错误代码也可能不报警。仅验证导出行文本存在无法覆盖此问题。

### P1：baseapp/cellapp 同名函数互相覆盖

位置：`__init__.pyi:21-22`、`_KBEngine_baseapp.pyi:37`、`_KBEngine_cellapp.pyi:36`。

两层星导入按顺序覆盖，未形成 overload。实际解析结果：

```python
reveal_type(KBEngine.createEntity)
# (entityType, spaceID, position, direction, params=...) -> Entity | None
KBEngine.createEntity("Avatar", {})
# error: Arguments missing for parameters "position", "direction"
```

而 baseapp 源码 `kbe/src/server/baseapp/baseapp.cpp:431-432` 将 `createEntity` 与 `createEntityLocally` 注册为同一实现，baseapp 的类型名和属性字典调用属于合法形式。

修复建议：合并入口至少明确声明两套 overload；如需按进程检查 API 归属，应让导出/分析层选择对应模型。单纯交换导入顺序会转而损坏 cellapp 的签名。

### P1：位置、方向返回类型错误，且向量构造重载不足

位置：`Entity.pyi:60-61`、`_KBEngine_common.pyi:32`、`_vectors.pyi:10/42/76`。

- `position/direction` 被声明为 tuple/Sequence，运行时却是 `ScriptVector3`。源码 `server/cellapp/entity.cpp:131-132` 创建包装对象，`:1830`、`:1958` 返回同一对象。
- 直接从类文件导入以避开入口 Any 后，`entity.position.x` 报属性不存在，`entity.position = Vector3(1, 2, 3)` 报类型不兼容。Vector3 拥有索引方法并不使其在静态类型中自动成为 `Sequence`。
- `Vector3()`、`Vector3((1, 2, 3))` 是源码支持的形式，桩只声明三个数值参数，产生误报。证据：`lib/pyscript/vector3.cpp:157-170` 的 `tp_new` 与 `:838` 的 `__py_pySet`。后者也处理单个数值和向量输入。
- `set(*args: float)` 同样漏掉序列/向量输入，并允许源码不支持的零参数形式。

建议区分读取类型与可赋值输入类型：getter 返回 Vector3，setter 接受源码实际支持的输入；补齐 Vector2/3/4 的构造和 set 重载。

### P1：_vectors.pyi 缺失 List、Tuple 导入

位置：`_vectors.pyi:17-18,51-52,83-84`。

6 个未定义名称错误来自 `tuple()` 和 `list()` 返回注解；直接调用 Vector3.tuple() 的返回类型被推断为 Unknown。建议使用内置 `tuple[...]`/`list[...]`，或补齐导入。必须改派生脚本内的 `VECTOR_CLASSES`，否则重跑会丢失修复。

### P2：EntityComponent 缺少核心运行时属性

位置：`EntityComponent.pyi:37` 起。

源码证据：`server/baseapp/entity_component.cpp:15-21`、`server/cellapp/entity_component.cpp:17-25`。

- 两端均缺：`ownerID`、`owner`、`name`、`className`、`isDestroyed`。
- cell 端另缺：`allClients`、`otherClients`。

这些成员经 `__getattr__ -> Any` 兜底，因此可能没有红线，但缺少准确补全与类型验证。服务端 EntityComponent 仅注册 timers 和 cell 端 clientEntity；不能因为客户端组件提供事件方法，就直接将那些方法补进服务端模型。

### P2：Entities、GlobalDataClient、PyBots 被错误建模为完整 dict

位置：`Entities.pyi:37`、`GlobalDataClient.pyi:37`、`_KBEngine_bots.pyi:91`。

- Entities 实际是只读映射：`lib/entitydef/entities.h:88-94` 的 `mp_ass_subscript` 为 NULL；当前继承 Dict 却允许 `entities[id] = entity`、`clear/pop/update` 等不受支持操作。
- Entities 缺少 `has_key` 与 `garbages`（同文件 `:114-127`）；源码 `keys/values/items` 返回 list（`:178/:199/:220`），当前继承 dict 得到的是 view 返回类型。
- GlobalDataClient 实际继承 `script::Map`，不是 dict。Map 暴露 `has_key/keys/values/items/update/get`（`lib/pyscript/map.cpp:40-47`），当前遗漏 has_key，却承诺完整 dict API；key 被限定为 str，而源码使用 Python 对象作为 key 并进行 pickle，见 `lib/server/globaldata_client.cpp:100` 起。
- PyBots 的只读映射表在 `server/tools/bots/pybots.cpp:22-27`；其 List 返回类型与 dict override 冲突，导致 4 个 Pyright error（keys/values/items/get）。

建议使用精确声明的映射接口或 Protocol，避免通过继承 Dict 赋予不存在的写接口。用 Mapping 时也要考虑该引擎 keys/items 返回 list，不能机械继承后再次制造 override 冲突。

### P2：hooks 有真实缺漏，logger 回调返回类型错误

位置：`hooks.pyi:33`、`:80`、`:107` 起。

CellEntityHooks 缺：

- `onEnterTrap(entity, rangeXZ, rangeY, controllerID, userArg)`；
- `onLeaveTrap(entity, rangeXZ, rangeY, controllerID, userArg)`；
- `onLeaveTrapID(entityID, rangeXZ, rangeY, controllerID, userArg)`；
- `onLoseControlledBy(id)`。

证据：`server/cellapp/entity.cpp:1755-1779` 与 `:1513`。前三项中的 Enter/LeaveTrap 和 LoseControlledBy 也见配套 `docs/api/kbengine/cellapp/Entity.md`；LeaveTrapID 通过源码发现，说明文档本身也非穷尽清单。

CellAppModuleHooks 缺 `onReadyForLogin`、`onSpaceGeometryLoaded(spaceID, mappingName)`，证据分别为 `server/cellapp/initprogress_handler.cpp:153-167`、`server/cellapp/spacememory.cpp:308-309`，配套模块文档也列出。

LoggerModuleHooks.onLogWrote 目前 `Any -> None`，实际输入 bytes，返回 False 可阻止持久化，返回 str 可替换日志：`server/tools/logger/logger.cpp:290-317`。应声明符合此契约的输入输出，避免正确的过滤器实现与 Protocol 不兼容。

这些 Protocol 是可供显式引用的辅助类型；仅存在 hooks.pyi 并不会自动校验用户 kbemain.py 中每个独立函数。

### P2：bots/client 模块 API 仍有漏项和模型混用

位置：`_KBEngine_bots.pyi`、包入口。

`lib/client_lib/clientapp.cpp:192-200` 注册了模块级 `fireEvent/player/callback/cancelCallback/disconnect`，桩没有这些模块级函数。部分同名能力仅写在 ClientObject 类上，不能替代模块声明。该注册段没有条件分支排除 bots。

bots.Entity 还缺源码暴露的 base/cell 与 isDestroyed：`lib/client_lib/entity.cpp:41-42`、`lib/entitydef/entity_macro.h:60`。当前注释描述 base/cell 调用，但未显式声明其类型。

入口显式选择服务端 Entity 覆盖 bots.Entity 是已说明的超集策略，不能据此声称同一入口也能准确检查 bots 脚本；bots 需要独立选择其模型。

### P2：urlopen 的参数分支未准确描述

位置：`_KBEngine_common.pyi:105` 起及 pythonapp/bots 对应声明。

源码 `lib/pyscript/pyurl.cpp:79-114` 支持第三个参数为 headers 字典或 postData bytes，当前第三个参数仅允许 bytes/None，所以合法 `urlopen(url, cb, {"X-Test": "1"})` 会被误报。

源码 `:172-177` 要求显式传入的 callback 可调用，当前 `callback=None` 却允许显式传 None；四参数分支要求实际 bytes 与 dict，不能用默认 None 的单一签名准确描述。建议按实际调用分支写 overload。

### P3：剩余 Pyright 错误来自 __reduce_ex__ override

位置：`Entity.pyi:70`、`MemoryStream.pyi:54`、`_KBEngine_pythonapp.pyi:31`。

三个声明使用 `protocol: int`，本次 Pyright/typeshed 的 object 基类声明接受 SupportsIndex，触发不兼容 override。应结合运行时接受面决定参数类型或去除冗余 override，避免只通过关闭诊断掩盖问题。

13 个错误构成：向量未定义名称 6 + PyBots override 4 + reduce override 3。此数量来自本次工具版本，未来 typeshed 变化可能影响其中的 override 诊断。

### P3：EntityComponentCall 的继承关系不符合引擎

位置：`EntityComponentCall.pyi:37`。

当前 `EntityComponentCall(EntityCall)` 会继承 getComponent，但源码两者分别继承 `EntityCallAbstract`，见 `lib/entitydef/entity_component_call.h:29-32`、`lib/entitydef/entity_call.h:15-18`。EntityComponentCall 自身的方法表为空（对应 cpp:19-20）。应共享动态远程调用的抽象协议，而非虚构子类关系。

## 完整性与设计边界

- baseapp/cellapp Entity、Proxy 的直接注册方法和属性名称扫描未发现新的大面积漏收；旧报告提到的 8 个 cell 移动/导航方法、13 个 cell 属性、MemoryStream.bytes/rpos/wpos/fill 等现已存在。
- 主要服务端模块注册函数名称已在模板某处出现，但“某处存在”不证明从正确组件入口导出，也不证明签名准确。createEntity 覆盖就是反例。
- 不应沿用 2026-10-21 报告的百分比评价当前模板：既有修复，也有拆包后产生的新问题。
- `__getattr__ -> Any` 对动态 def 方法有用途，但当前也吞掉静态 API 拼写错误。实测 `KBEngine.thisApiDoesNotExist` 仍为 Any。要检查拼写和调用签名，需要把已知引擎接口与动态 def 生成面区分，并考虑严格模式。
- `cellData: Dict[str, Any]` 提供容器提示，但不会单独提供逐属性校验。实体 def 驱动的 `entity_types/kbe_types` 属于另外的生成链路，本报告未将其算作模板缺失，也未验证其全链路完整性。
- copy-if-absent 是当前明确约定，保护用户副本；其后果是仅升级扩展不会修复已有副本。实现修正后应提供差异预览/显式重置或合并路径，不能无提示覆盖项目修改。
- 派生脚本 pin 校验读取最近提交，但不会检查输入文件是否有未提交变更。因此 `--pin` 不能单独保证输入字节属于钉点提交；本次输入 typings 未见未提交修改，重跑无差异。

## 建议修复顺序与验收

1. 先修包入口显式重导出、向量导入；以 reveal_type 断言 Entity/Proxy/Vector3 不为 Any、tuple/list 返回值不为 Unknown。
2. 处理 createEntity 两端签名、Vector3 getter/setter/构造重载；合法 base 与 cell 调用均通过，非法调用仍失败。
3. 将共享缺陷回修 fork typings：组件属性、映射容器、hooks、bots、urlopen、继承关系；再通过派生脚本生成，保留一类一文件与 copy-if-absent。
4. 增加真实 Pyright 消费样例检查，并明确断言错误调用的诊断，不只检查模板字符串。要求桩自身无 error，合法样例无误报，已知非法调用有预期诊断。

复现核心样例（配置 stubPath 指向本仓库 typings，strict；可关闭 reportMissingModuleSource 以排除无运行时 Python 模块的环境噪声）：

```python
import KBEngine
from KBEngine.Entity import Entity
from KBEngine._vectors import Vector3

reveal_type(KBEngine.Entity)  # 当前 Any；期望 type[Entity]
KBEngine.createEntity("Avatar", {})  # baseapp 合法形式，当前误报
e = Entity()
e.position.x  # 源码支持，当前误报
e.position = Vector3(1, 2, 3)  # 当前误报
Vector3()  # 源码支持，当前误报
Vector3((1, 2, 3))  # 源码支持，当前误报
reveal_type(Vector3(1, 2, 3).tuple())  # 当前 Unknown
```
