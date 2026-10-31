# KBEngine entitydef 源码分析(kode 实体索引设计底稿)


> 源码先行令的产物。所有结论基于本机 KBEngine 源码检出
> (`~/workspaces/kbengine`,下文路径均相对该根),先读仓库既有分析文档
> (`docs/study/05-entitydef-and-entity-definition.md`、
> `docs/book-legacy/05-entitydef-and-runtime.md`、
> `docs/study/06-python-runtime-and-script-bridge.md`),再回源码逐条核对。
> 每条带 `文件:行号`;查无实据处明确写「源码未见」。文档与源码冲突时以源码
> 为准,差异汇总见第四节。本引擎版本中 interface/parent/components 的加载
> 全部内联在 `entitydef.cpp`(无独立 interface.cpp),已逐段核对。

## 一、真实解析链

引擎侧实体定义的总入口是 `EntityDef::initialize`
(`kbe/src/lib/entitydef/entitydef.cpp:153-250`),分三个阶段。

### 阶段 0:路径解析

1. `getPyUserResPath`:取 `matchRes("server/kbengine.xml")` 所在的资源根;
   匹配失败退回 `respaths_[1]`,再退 `respaths_[0]`
   (`kbe/src/lib/resmgr/resmgr.cpp:462-486`)。
2. `getPyUserScriptsPath`:在资源根里截掉最后一个 `res` 及其后内容,拼上
   `scripts/`(`resmgr.cpp:489-503`)。即 `<资源根>/../scripts/`。
3. 组件分侧目录由 `getPyUserComponentScriptsPath` 追加
   `cell/`、`base/`、`bots/`、`client/`(`resmgr.cpp:506-540`)。
   注意 `autoMatchCompOwn` 里实际用的是硬编码资源路径
   `scripts/client/<名>.py` 等而非该函数(`scriptdef_module.cpp:416、459、495`)。

下文记该根为 `<userScripts>`。

### 阶段 1:def 侧注册(`entitydef.cpp:153-250`)

1. `__entitiesPath = getPyUserScriptsPath()`(`entitydef.cpp:159`);
   `entitiesFile = <userScripts>/entities.xml`,
   `defFilePath = <userScripts>/entity_defs/`(`entitydef.cpp:176-177`)。
2. **types.xml 先于一切实体加载**:`DataTypes::initialize(defFilePath +
   "types.xml")`(`entitydef.cpp:181`),types.xml 位于 `entity_defs/` 内。
3. 标志名映射表初始化:`CELL`/`BASE`/`CELL_AND_CLIENT` 等 → ED_FLAG 位
   (`entitydef.cpp:161-174`)。
4. **entities.xml 可缺省**:`access(entitiesFile, 0) == 0` 才进入解析,注释
   「允许纯脚本定义,则可能没有这个文件」(`entitydef.cpp:184-186`)。
5. 逐实体节点(`entitydef.cpp:198-237`):
   - `moduleName = getKey(node)`——**实体名是 XML 元素名,不是属性**
     (`entitydef.cpp:200`);
   - `registerNewScriptDefModule(moduleName)`(`entitydef.cpp:202`)——
     **类型号在此分配**:`__scriptTypeMappingUType[moduleName] =
     g_scriptUtype`,模块拿 `g_scriptUtype++`
     (`entitydef.cpp:253-265`);即 utype = entities.xml 中的**出现顺序**
     (从 1 起,回读见 `findScriptModule(utype)`,`entitydef.cpp:2382-2396`);
   - def 文件 = `defFilePath + moduleName + ".def"`(`entitydef.cpp:204`),
     解析后进 `loadDefInfo`(`entitydef.cpp:218`);
   - def 里的 detailLevel 随后再次独立加载一次(`entitydef.cpp:227`)。
6. `loadDefInfo` 内部加载顺序(`entitydef.cpp:339-400`):
   `loadAllDefDescriptions`(:345,Properties/Methods 各区块)→
   `loadInterfaces`(:354)→ `loadComponents`(:363)→
   `loadParentClass`(:372)→ `loadDetailLevelInfo`(:381)→
   `loadVolatileInfo`(:390)→ `autoMatchCompOwn()`(:398,见阶段 2.5)。
7. def 侧收尾后进脚本阶段前:`script::entitydef::initialize()`
   (`entitydef.cpp:240`)、`EntityDef::md5().final()`(:243);DBMGR 进程到此
   返回,不加载实体脚本(`entitydef.cpp:245-246`)。

#### 接口(Interfaces)

`<Interfaces>` 逐接口取包裹元素(`interface`/`Interface`/`type`/`Type`
四种拼写,`enterNode` 级联)再取其**首子节点的元素名**为接口名——以接口名
直接命名的子元素(如 `<MoveIface/>`)会被 `getKey` 检查跳过、不装载;
`enterNode` 返回首子节点时 tinyxml 已在解析期丢弃纯空白文本节点
(`condenseWhiteSpace=true` 默认),换行缩进排版不影响取名,def 文件 =
`defFilePath + "interfaces/" + 名字 + ".def"`,方法与属性**平铺并入同一
模块**;接口 def 自身还能再带 `Components`/`Interfaces`,递归处理
(`entitydef.cpp:551-639`,调用点 `entitydef.cpp:354`)。

#### 组件(Components)

`<Components>` 逐组件:组件名 = 元素名,`<Type>` 子节点给组件类型名
(`entitydef.cpp:654、669-671`);组件 def = `defFilePath + "components/" +
类型名 + ".def"`(`entitydef.cpp:681`);组件以
`registerNewScriptDefModule(类型名)` 注册并标 `isComponentModule(true)`
(`entitydef.cpp:716-722`);再以 `addComponentProperty` 挂成宿主实体的一个
属性(默认 flags = `ED_FLAG_BASE | ED_FLAG_CELL_PUBLIC |
ENTITY_CLIENT_DATA_FLAGS`,`entitydef.cpp:686-743`),并
`addComponentDescription` 记录归属(`entitydef.cpp:745`)。

#### 继承(Parent)

`<Parent>` 子节点的元素名 = 父实体名,父 def = `defFilePath + 父名 +
".def"`,**递归 `loadDefInfo` 并把内容并进同一个 ScriptDefModule**——def 层
继承是合并,不是注册一个独立父模块(`entitydef.cpp:890-924`,调用点
`entitydef.cpp:372`)。防环:**源码未见**——`loadParentClass` 无 visited
/已注册检查,靠调用方无环保证;kode 实现必须自备 visited 集。

### 阶段 2:脚本侧加载(`loadAllEntityScriptModules`,`entitydef.cpp:2255-2379`)

1. entities.xml 可缺省:不存在直接 `return true`
   (`entitydef.cpp:2260-2262`)。
2. **组件脚本先于实体脚本**:`loadAllComponentScriptModules`
   (`entitydef.cpp:2264-2265`;函数体 `entitydef.cpp:1984-2110`):从各实体的
   componentDescrs 收集组件名(`:2006-2018`),逐个 `loadScriptModule`
   (`:2026`);缺失且当前进程需要时报
   `Could not load EntityComponentModule`(`:2045-2052`), TOOL_TYPE(kbcmd)
   有专门旁路(`:2031-2042`)。
3. 逐实体(`entitydef.cpp:2278-2375`):
   - `loadScriptModule(moduleName)` = `PyImport_ImportModule(模块名)`
     (`entitydef.cpp:1944-1947`),并做**路径护栏**:模块文件必须位于
     `<userScripts>` 之下(分隔符剔除后比对),否则按「模块名与系统模块冲突」
     置 NULL(`entitydef.cpp:1952-1977`)——防同名误导入;
   - 模块缺失时按 `isLoadScriptModule` 判定是否报错:该函数按进程类型查
     `hasBase/hasCell/hasClient`(BASEAPP 查 base、CELLAPP 查 cell、
     CLIENT/BOTS 查 client、TOOL 一律 false,`entitydef.cpp:1741-1782`);
     需要→`Could not load EntityModule` 报错返回(`:2287-2294`);不需要→
     静默跳过(`:2296-2300`);
   - **同名类**:`PyObject_GetAttrString(pyModule, moduleName)`——类名必须
     等于实体名,缺失报 `Could not find EntityClass`(`:2305-2314`);
   - **基类校验**:`isSubClass(pyClass)` 非 KBEngine 基类子孙报
     `not derived from KBEngine.[X]`(`:2317-2325`);非 type 报错
     (`:2328-2334`);
   - **def 方法对账**:`checkDefMethod` 校验 def 里声明的方法在类上存在
     (`:2336-2342`;实现 `entitydef.cpp:1785+`,借
     `inspect.getfullargspec`);
   - 全部通过才 `setScriptType`(`:2347`);
   - 组件模块兜底检查:实体引用的组件若未加载且需要,报
     `Could not load ComponentModule`(`:2350-2374`)。

### 阶段 2.5:三侧存在性判定(`autoMatchCompOwn`,`scriptdef_module.cpp:302-530`)

`hasCell / hasBase / hasClient` 的唯一真值来源,在 `loadDefInfo` 尾部触发
(`entitydef.cpp:398`)。

- 组件模块分支(`scriptdef_module.cpp:304-331`):`scripts/base/components/
  <名>.py` 存在→`setBase(true)`(:306-312),`scripts/cell/components/
  <名>.py` 存在→`setCell(true)`(:314-320);base/cell 有 exposed 方法→
  补 `setClient(true)`(:322-328)。
- 实体分支:从 entities.xml 读断言属性 `hasClient`(:366)、`hasCell`
  (:377)、`hasBase`(:388)——值为大小写不敏感的 `true` 判 1,其余判 0
  (:369-372),属性缺席保持 -1(:341-343);断言值喂入 def md5
  (:375、386、397)。纯脚本 def(无 .def 文件)经
  `DefContext::findDefContext(name)` 也能贡献 hasClient 断言
  (:405-414)。
- 逐侧判定(以 client 为例,`:416-450`;base `:459-493`;cell
  `:495-529`),`matchRes(f) != f` 表示资源命中:
  - 脚本存在 + 无断言 → `set(true)`(:421-428);
  - 脚本存在 + 有断言 → **断言优先** `set(断言==1)`(:429-434);
  - 脚本缺失 + 无断言 → `set(false)`(:435-444);
  - 脚本缺失 + 有断言 → 断言优先(:445-450)。
- 客户端进程(CLIENT_TYPE)提前 `setBase(true)+setCell(true)` 并返回
  (:452-457)。

### 注册链总报错(用户锚点核对)

`EntityApp::createEntity` 找不到实体类型时的报错原文即注册三件套:
「Please register in entities.xml and implement a %s.def and %s.py」
(`kbe/src/lib/server/entity_app.h:567`);创建时按进程校验
`hasCell`(cellapp)/`hasBase`(其余)(`entity_app.h:573-582`)。

## 二、entities.xml 的字段与职责边界

源码里 entities.xml 被消费的内容只有两样:

| 内容 | 作用 | 依据 |
| --- | --- | --- |
| **元素名**(每节点一个) | 实体模块名;决定 def 文件名、py 模块/类名、**类型号分配顺序** | `entitydef.cpp:200、204、253-265` |
| **属性 `hasClient` / `hasCell` / `hasBase`**(可省) | 三侧存在性断言,可覆盖脚本存在性推导 | `scriptdef_module.cpp:366、377、388、416-529` |

职责边界:

- entities.xml 是**实体清单**——声明「有哪些实体」及各侧存在性,并以其
  子节点顺序固定类型号。
- **extends 不在 entities.xml:源码未见**。继承只写在 .def 的 `<Parent>`
  (`entitydef.cpp:896-915`);需求描述与部分资料把 extends/类型号字段归入
  entities.xml,与源码不符(类型号是顺序派生,不是字段)。
- 除上述三属性外,实体def 目录里对 entities.xml 的 `Attribute(...)` 读取
  仅 `scriptdef_module.cpp:366、377、388` 三处,源码未见其他字段消费。
- entities.xml 缺省合法(纯脚本定义):`entitydef.cpp:184-186`、
  `scriptdef_module.cpp:347-349`、`entitydef.cpp:2260-2262`。

## 三、kode 实体索引设计(每条标源码依据,待过目后再实现)

目标:对 `class GameObject(kbe.KBEntity)` 这类导航/补全,不再孤立猜符号,
而是沿引擎同款链路走:entities.xml 清单 → `entity_defs/<Name>.def` →
`interfaces/`、`components/`、`<Parent>` 归并 → `scripts/{base,cell,
client}/<Name>.py` 同名类。

- **D1 索引入口与路径发现**:入口文件 = 工作区内 entities.xml。发现顺序:
  既有 `getDefinitionWorkspaceLayout` 的 entitiesXmlPath 候选
  (src/definitionWorkspace.ts,现役逻辑)→ `findFiles('**/entities.xml')`
  兜底。源码依据:entities.xml 恒在 `<userScripts>` 根
  (`resmgr.cpp:489-503`;`entitydef.cpp:176`;`scriptdef_module.cpp:345`),
 kode 无法拿到引擎资源根,只能按工作区形态枚举候选。
- **D2 解析时机与缓存**:惰性首用构建(首次导航/补全/explorer 请求触发),
  entities.xml 或被索引 def 文件保存时失效重建。源码依据:引擎在
  `EntityDef::initialize` 一次性构建(`entitydef.cpp:153-250`),kode 的
  「进程启动」对应宿主首请求,不占 activate 启动成本。
- **D3 模块表保持清单顺序**:索引按 entities.xml 子节点顺序存放,不排序;
  顺序即引擎 utype 序(源码依据:`entitydef.cpp:253-265、2382-2396`)。
  同名重复条目:引擎按已有模块复用静默合并(`registerNewScriptDefModule`
  `entitydef.cpp:255-262`),kode 应作诊断提示而非静默。
- **D4 def 定位与纯脚本模块**:模块 → `<scripts根>/entity_defs/<Name>.def`
  (源码依据:`entitydef.cpp:204、177`);def 缺失 = 纯脚本模块,合法且仍可
  从 py 侧索引(源码依据:`entitydef.cpp:184-186`;
  `scriptdef_module.cpp:405-414` 的 DefContext 通道)。
- **D5 继承链构建**:导航呈现两条链。def 链:`<Parent>` 递归 + `interfaces/`
  平铺 + `components/` 挂接,与引擎归并口径一致(源码依据:
  `entitydef.cpp:890-924、551-639、642-771`);py 链:实体 py = 
  `scripts/{base,cell,client}/<Name>.py`(`scriptdef_module.cpp:416、459、
  495`),类名必须等于实体名(`entitydef.cpp:2305-2314`),基类须 KBEngine
  基类子孙(`entitydef.cpp:2317-2325`)——`kbe.KBEntity` 段走 kbe 桩索引,
  项目父类段沿 Python 继承走本索引。kode 必须带 visited 防环:引擎
  `loadParentClass` **源码未见防环**,不能照抄。
- **D6 三侧存在性复算**:kode 按 autoMatchCompOwn 同款规则计算
  hasCell/hasBase/hasClient,用于 explorer 类型显示与跳转目标消歧(该打开
  base/cell/client 哪份 py)。规则:逐侧「脚本存在 || entities.xml 断言,
  断言优先」(源码依据:`scriptdef_module.cpp:416-450、459-493、495-529`;
  属性读取 `:366、377、388`;CLIENT_TYPE 旁路 `:452-457`)。
- **D7 与 kbe 桩索引的分工**:`kbe.*` 模块面(引擎 API)走内置桩索引(另行
  提交的工作);实体清单面(entities.xml 链)走本设计。引擎原生无 KBEntity
  符号(源码未见,`kbe/src/lib` 无该注册),它是项目侧基类习惯,由桩索引以
  别名条目如实承担。
- **D8 无 entities.xml 降级**:找不到 entities.xml 时提示一次「未找到
  entities.xml」(输出通道/状态栏,不逐键提示),导航/补全回落现役逐文件
  逻辑。源码依据:引擎明文允许缺省(`entitydef.cpp:184-186、2260-2262`;
  `scriptdef_module.cpp:347-349`)——降级是源码支持的合法形态,不是补丁。
- **D9 明确范围外**:types.xml 别名展开(`DataTypes::initialize`,
  `entitydef.cpp:181`)、def md5(`scriptdef_module.cpp:375、386、397`)、
  exposed 方法代码生成、detailLevel/volatile 语义——均属引擎序列化/同步
  域,kode 索引不建模,仅保留诊断面。
- **D10 测试口径**:fixture 工作区复刻引擎布局(scripts/entities.xml +
  entity_defs/{*.def,interfaces/,components/} + base/cell/client 同名类),
  覆盖:顺序保真、Parent 链(含环)、接口平铺、三侧判定四象限、纯脚本
  模块、无 entities.xml 降级;`kbe.KBEntity` 导航回归沿用批108 桩索引用例。

## 四、文档与源码差异(以源码为准)

1. `docs/study/05` 将三侧标志的设置点引为 `scriptdef_module.cpp:846-861`;
   实核该区间是 `findAliasMethodDescription`/`addCellMethodDescription`
   (其间仅 `:883` 的 `setCell(true)` 属组件方法登记侧效)。标志驱动的真实
   设置点:`entitydef.cpp:847-861`(addComponentProperty 按 flags 并集)、
   `scriptdef_module.cpp:302-530`(autoMatchCompOwn 全族)、
   `entitydef.cpp:1922-1941`(setScriptModuleHasComponentEntity 按进程置位)。
2. 需求描述/部分资料把 extends 与类型号列为 entities.xml 字段;源码为
   extends=`.def <Parent>`(`entitydef.cpp:896-915`)、类型号=清单顺序
   (`entitydef.cpp:253-265`),entities.xml 自身无此二字段(源码未见,
   见第二节)。
3. `docs/book-legacy/05` 为无行号引用的叙述性综述,细节与源码出入处一律按
   本文档源码引用口径。

## 五、实施边界

- 设计已经用户拍板通过,并附硬需求:def 内 `<Interfaces>` 接口名必须跨
  文件跳转到 `entity_defs/interfaces/<名>.def`。批108/109 落地:kbe 桩
  索引(src/kbeModuleIndex.ts)对应 D7 分工;链路导航(src/
  languageProviders.ts、src/definitionWorkspace.ts)覆盖 D1/D4、D5 的
  py 链与 Interfaces 跨文件段、D6、D8;
- D3 已落地(批147):清单顺序索引由现役 getRegisteredEntities 按子节点
  序保真承担,悬停呈现清单序号;同名重复条目诊断(src/
  entitiesXmlAnalysis.ts)随 .def 同一文档事件生命周期落 kbengine
  collection,共用 kbengine.enableDiagnostics 总开关;
- D5 的 def 链合并呈现已落地(批148):src/defChain.ts 按「`<Parent>` 递归
  + interfaces/ 平铺 + components/ 挂接」三面整理继承闭包(引擎归并口径
  与边解析沿用批 defRenamer 语义),悬停根级 `<Parent>` 元素呈现;visited
  截断防环并如实标注(引擎 loadParentClass 未见防环,不照抄);仍属后续
  增量:D2(独立惰性索引与保存失效重建)、D9 诊断面;当前导航走现役
  layout/清单读取 + 逐文件解析,对账口径见 TESTING.md 批108/109 节;
- 验收走查记录:tests/batch109NavigationWalkthrough.test.ts(11 步,
  每步断言跳转目标在磁盘真实存在),结果记于 TESTING.md 同节。

## 六、Interfaces 与 Components(is-a 与 has-a 语义)

第一节的 `#### 接口(Interfaces)` / `#### 组件(Components)` 给出两块 XML 的加载链视图,
本节在语义层面做对比。以下全部经 `kbe/src/lib/entitydef/entitydef.cpp` 源码核实。

**一句话区分**:`<Interfaces>` 是 *is-a* 复用——接口的 Properties/Methods **平铺并进宿主实体
自己的模块**,加载完成后接口在实体上不留任何痕迹;`<Components>` 是 *has-a* 复用——每个
组件槽变成**实体上的一个属性**,类型为 `EntityComponent`,其成员活在组件自己的模块里。

### 接口(Interfaces,is-a / 混入)

- 入口:`loadInterfaces`(`entitydef.cpp:551-639`,调用点 `entitydef.cpp:354`)。
- 接口 def 文件位于**全局共享目录**`defFilePath + "interfaces/" + <名> + ".def"`
  (`entitydef.cpp:586`)——`entity_defs/` 下一个 `interfaces/` 目录,全体实体共用,不按实体分。
- 接口的 Properties/Methods(及 DetailLevel)**加载进实体自己的 ScriptDefModule**:
  `loadAllDefDescriptions(moduleName, ..., pScriptModule)` 传入的 `pScriptModule` = 实体
  (`entitydef.cpp:598`;`loadAllDefDescriptions` 见 `entitydef.cpp:927-964`,分流到
  loadDefPropertys / loadDefCellMethods / loadDefBaseMethods / loadDefClientMethods),
  成员被直接吸收进实体的 def 面。
- 递归嵌套:接口 def 自身还能带 `<Components>`(`entitydef.cpp:616-625`)与 `<Interfaces>`
  (`entitydef.cpp:628-634`,无限自身递归);`ignoreComponents` 在实体层默认 `false`
  (`entitydef.h:103`),故嵌套组件生效。
- **实体上不留痕**:`loadInterfaces` 内无 `registerNewScriptDefModule`、无 `addComponentProperty`
  、无 utype 分配——接口既不注册成模块也不注册成属性槽;只剩被并入的成员,与实体自身成员
  无异。

### 组件(Components,has-a / 组合)

- 入口:`loadComponents`(`entitydef.cpp:642-818`,调用点 `entitydef.cpp:363`)。
- `<Components>` 的每个子节点 = 一个**槽**:槽名 = 子元素名(`entitydef.cpp:654`),经
  `validDefPropertyName` 校验(`entitydef.cpp:660`;该检查在 `entitydef.cpp:967-1012`,拒绝
  `ENTITY_LIMITED_PROPERTYS` 保留名——id、position、direction、spaceID、cell、base、
  component 等(`entitydef/common.h:125`)——及任何 `KBEngine.Entity` 属性)。
- `<Type>` 子节点给组件类型名(`entitydef.cpp:669-671`);组件 def =
  `defFilePath + "components/" + <类型> + ".def"`(`entitydef.cpp:681`)——`components/`
  目录按**类型**而非槽名分键。
- `addComponentProperty`(`entitydef.cpp:821-887`)在实体上建一个以槽名命名的
  `PropertyDescription`,其 DataType 为包裹组件模块的 `EntityComponentType`
  (`entitydef.cpp:834-843`);该属性的 `DATATYPE` 为 `DATA_TYPE_ENTITY_COMPONENT = 15`
  (`entitydef/common.h:104`,`entitydef/datatype.h:801`)。槽因此占用实体的属性/utype 命名空间:
  `<Utype>`(`entitydef.cpp:698-701`)与 `<Persistent>`(默认 `true`,`false` 关闭,
  `entitydef.cpp:703-713`)均生效;属性按侧由 `addPropertyDescription` 注册
  (`entitydef.cpp:864-874`),`addComponentDescription` 记录归属(`entitydef.cpp:745、813`)。
- 组件 def 加载进**它自己的独立模块**:`registerNewScriptDefModule(<类型>)` +
  `isPersistent(false)` + `isComponentModule(true)`(`entitydef.cpp:716-723`)。若该类型模块
  已存在则复用、不再重解析(`entitydef.cpp:715-747`),故多个槽(同实体或跨实体)可共用同一
  组件类型。
- 组件 def 是**完整迷你实体**:`loadAllDefDescriptions` 进自身模块(`entitydef.cpp:756`)、
  `loadInterfaces`(`entitydef.cpp:765`,以 `ignoreComponents=true` 调用,故组件内接口**不再**
  拉入更深一层组件)、`loadParentClass` 以 `components/` 为基路径(`entitydef.cpp:774`——组件的
  `<Parent>` 在 `entity_defs/components/` 内解析)、`loadDetailLevelInfo`
  (`entitydef.cpp:783`),随后 `autoMatchCompOwn()`(`entitydef.cpp:791`)。
- 槽域 flags 由组件模块 `autoMatchCompOwn` 后的暴露情况派生(`entitydef.cpp:793-811`):
  `hasBase → ED_FLAG_BASE`(`:795-796`);`hasCell → ED_FLAG_CELL_PUBLIC`(`:798-799`);
  `hasClient →` 组件同时有 base 则 `ED_FLAG_BASE_AND_CLIENT`,同时有 cell 则再并客户端联合
  `ED_FLAG_ALL_CLIENTS | ED_FLAG_CELL_PUBLIC_AND_OWN | ED_FLAG_OTHER_CLIENTS | ED_FLAG_OWN_CLIENT`
  (`:801-808`)。这些位在 `addComponentProperty` 内回喂宿主实体的
  hasBase/hasCell/hasClient(`entitydef.cpp:847-861`)。(预注册复用路径上新槽默认取
  `ED_FLAG_BASE | ED_FLAG_CELL_PUBLIC | ENTITY_CLIENT_DATA_FLAGS`,`entitydef.cpp:686-688`。)

### is-a 与 has-a 一览

| 维度 | `<Interfaces>`(is-a) | `<Components>`(has-a) |
| --- | --- | --- |
| 复用方式 | 混入:成员并进实体 | 组合:实体上的一个 EntityComponent 类型槽属性 |
| 脚本面 | 接口成员即实体自身成员(无间接层) | 实体暴露一个以槽名命名的属性;组件成员留在组件模块 |
| 目录 | 全局共享 `entity_defs/interfaces/<名>.def` | `entity_defs/components/<类型>.def` 按 `<Type>` 分键 |
| 实体上留痕 | 无(不建模块、不建属性槽、无 utype) | 一个以槽名命名的 PropertyDescription(EntityComponent,含 utype/persistent) |
| 加载目标模块 | 实体自己的 ScriptDefModule | 独立 ScriptDefModule(isComponentModule(true)、isPersistent(false)) |
| 自身结构 | 可递归嵌套 `<Components>` 与 `<Interfaces>` | 完整迷你 def:Properties/Methods、Interfaces、`<Parent>`(components/ 内解析)、DetailLevel |
| 可否多个 | 任意多个 `<Interfaces>` 子节点,递归无上限 | 任意多个槽;多槽可共用同一 `<Type>`(模块复用) |

### XML 示例(同一实体 def 内两块)

```xml
<!-- entity_defs/Avatar.def -->
<root>
    <Interfaces>
        <Interface>
            <Combat/>   <!-- 元素名 = 接口名;加载 entity_defs/interfaces/Combat.def 并入 Avatar -->
        </Interface>
    </Interfaces>

    <Components>
        <HP>            <!-- 槽名:Avatar 上出现名为 HP 的属性 -->
            <Type>HPComponent</Type>   <!-- -> entity_defs/components/HPComponent.def -->
            <Utype> 10 </Utype>
            <Persistent> true </Persistent>
        </HP>
    </Components>
</root>
```
