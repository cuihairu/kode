# Mixin 跳转与 CodeLens 设计(mixin jump + provenance)

> 目标:修复「跨类调用处跳不到 mixin 提供的方法实现」,并在类/方法处用 CodeLens 标注
> 「由哪些 mixin 提供」。跳转与 CodeLens **共用同一套解析**,不各写一套。
> 验收口径:以**真实代码跳转成功率**为准,不看测试覆盖率。

## 0. 结论速览

- **可解性:部分解。**
  - **可解(需新增 Python 类层级索引)**:同名多实现、菱形继承、`__init__` 里绑定 —— 三者的根因相同
    (当前**零** Python 类层级/MRO 解析),补一个 Python 类符号表 + MRO 即可解。
  - **不可解(静态分析的根本极限)**:运行时注入(`setattr` / 装饰器在运行期挂方法)——静态看不到,
    只能做启发式提示,不能保证命中。
- **根因(一句话)**:当前方法归属由**文件名 basename** 决定、索引**只从 `.def` 构建**,而 mixin 是
  普通 Python 类、没有 `.def`,所以任何 mixin 提供的方法都查不到。

---

## 1. 现状:跳转怎么解析方法归属(file:line)

### 1.1 注册
- `PythonDefinitionProvider` 注册给 `{ language: 'python', scheme: 'file' }` —— `src/extension.ts:92-95`。

### 1.2 入口
- `provideDefinition` —— `src/languageProviders.ts:1900`。两条触发:
  1. `self.xxx` 访问 → `getPythonSelfAccessAtPosition`(`src/pythonLanguageUtils.ts:14`,正则
     `/\bself\.(\w+(?:\.\w+)*)/g` 在 `:18`)→ 先 `resolvePropertyDefinition`(`:1907`)再
     `resolveMethodDefinition`(`:1919`)。
  2. 方法声明行 → `getPythonMethodDeclarationAtPosition`(`src/languageProviders.ts:2126`)→
     `resolveMethodDefinition`(`:1933`)。

### 1.3 归属解析(核心)
`EntityMappingManager.resolveMethodDefinition(pythonFile, methodName)` —— `src/entityMapping.ts:568`:
1. `ensureIndexForPythonFile(pythonFile)` —— 索引**只由 `**/*.def` 构建**(`src/entityMapping.ts:134`
   `findFiles('**/*.def')`,`:141` 以 `.def` 文件名作 entityName,`:162` `buildIndex`)。
2. `inferOwnerNameFromPythonFile(pythonFile)` = **`path.basename(pythonFile, '.py')`** ——
   `src/entityMapping.ts:1073-1075`。**owner 就是当前 Python 文件名。**
3. `inferOwnerKindFromPythonFile` —— `:1077-1091`:路径含 `/components/`→`component`、
   `/interfaces/`→`interface`、`.py`→`entity`。
4. `inferMethodSectionFromPythonFile` —— `:1093-1109`:`/scripts/base/`→`BaseMethods`、
   `/scripts/cell/`→`CellMethods`、`/scripts/client/`→`ClientMethods`。
5. `selectMethodDefinition(index.methodDefinitions, {methodName, ownerKind, ownerName, section})`
   —— 在 `.def` 声明的方法里**扁平匹配**。

### 1.4 kode 从 Python 里到底读了什么(决定它能解什么)
- `parsePythonMethodBlocks` —— `src/entityMapping.ts:1142-1187`:正则
  `/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/`(`:1148`)**逐行扁平扫 `def`**。
  **不记录 `def` 属于哪个类、不读 `class X(A, B):` 的基类、不建作用域。**
- `parsePythonSelfCalls` —— `:1189-1211`:正则 `/\bself\.(\w*)\s*\(/g`(`:1195`),**只认 `self.x(` 调用**。
- `getPythonSelfAccessAtPosition` —— `src/pythonLanguageUtils.ts:14-45`:只认 `self.` 前缀访问。

→ **全仓无任何 Python 类层级 / 基类 / MRO 解析。** 这是所有 mixin 形态失败的共同根因。

---

## 2. Mixin 形态分类与「为什么跳不到」

对 `class ServerEntity(ServerEntityCommon, RunnableMixin, ...)` 里 `self.doTick()`(由 mixin 提供)的调用点:

| # | 形态 | 为什么跳不到(依据) | 可解性 |
|---|---|---|---|
| A | **同名多实现** | `parsePythonMethodBlocks`(`entityMapping.ts:1148`)**扁平扫 `def`、不记类作用域**,同名 `def` 在多个类里无法区分归属;`resolveMethodDefinition` 又只按 **文件名 basename**(`:1073-1075`)查 `.def`。→ 无法判定该跳哪个 | **可解**(补类作用域 + MRO 后可列出全部候选) |
| B | **菱形继承** | 需 C3 线性化(MRO)确定「先命中哪个基类的实现」。当前**零基类解析**(`parsePythonMethodBlocks` 不读 `class X(A,B):`),无 MRO 可算 | **可解**(需实现 MRO) |
| C | **运行时注入**(`setattr`/装饰器运行期挂方法) | `parsePythonMethodBlocks`(`:1148`)只匹配字面 `def` 行;运行期注入的方法**根本没有 `def` 行**,静态不可见 | **不可解**(静态分析根本极限;仅能启发式) |
| D | **`__init__` 里绑定**(`self.run = self._run_impl` / 类属性赋值) | `parsePythonSelfCalls`(`:1195`)只匹配 `self.x(`(带括号的调用);`getPythonSelfAccessAtPosition`(`pythonLanguageUtils.ts:18`)只匹配 `self.x` 访问。**赋值语句(`self.run = ...`)两者都不认**,且解析仍回落到 `.def` owner 查找 | **可解**(需补赋值/别名追踪) |

**共同根因**:A/B/D 都因为「没有 Python 类层级索引」而失败;C 因为静态不可见而失败。
索引只吃 `.def`(`entityMapping.ts:134`),而 mixin 是纯 Python 类、没有 `.def`,天然不在索引里。

---

## 3. 真实 kbengine 代码的验证(如实说明局限)

**本机 `D:\workspaces\kbengine` 这份拷贝里,不存在任务举例的 mixin 实体形态。** 实测:
- `grep 'class ServerEntity(' --include='*.py'` → **无命中**;`ServerEntityCommon` → **无命中**。
- 全仓 `Mixin` 字样只命中 vendored 第三方 perf 代码(`BigWorld-Engine-14.4.1/.../perf/sqlalchemy/*`、
  `perf/simplejson/ordered_dict.py`),**不是 kbengine 自己的实体代码**。
- KBEngine SDK 模板实体全是**单继承**:`class Account(KBEngine.Proxy)`
  (`kbe/res/sdk_templates/server/python_assets/scripts/base/Account.py:5`)、
  `class Account(KBEngine.Entity)`(bots)、`class Account(KBEngine.EntityComponent)`(组件)。

→ 结论:**这份 kbengine 是引擎 + SDK 模板,不含带 mixin 的游戏资产**。因此**无法在本仓 kbengine 上
测 mixin 跳转成功率**(没有可测的 mixin 实体)。`class ServerEntity(ServerEntityCommon, RunnableMixin)`
是**真实 KBEngine 游戏资产**里的写法,不在本引擎仓。

**本仓能验证的部分**:单继承实体的现有跳转按 §1 逻辑走 `.def` owner 查找,机制成立;
mixin 场景只能以**构造夹具 + 依据 §1/§2 的源码推理**判定,不能冒充「真实 kbengine 实测」。
验收若坚持「真实 kbengine 跳转成功率」,需一份**含 mixin 的游戏资产仓**(非本引擎仓)。

---

## 4. 实现路径(跳转 + CodeLens 共用一套)

### 4.1 新增 Python 类层级索引(单一真相源)
新增 `PythonClassIndex`,供跳转与 CodeLens **共同消费**(避免两套逻辑):
- **枚举类**:解析 `class X(Base1, Base2, metaclass=M):` 的基类列表 + `def` 的**所属类作用域**
  (修正 `parsePythonMethodBlocks` `entityMapping.ts:1142` 的扁平扫:用缩进/栈维护类作用域,
  记录 `def → 所在 class`)。
- **解析 MRO**:对 `X` 的基类做 C3 线性化(`X → Base1 → Base2 → ... → object`),得到**方法查找顺序**。
  查 `self.foo()` 时按 MRO 顺序在各类里找第一个 `def foo`,即真实运行时实现。
- **import 解析**:基类可能是 `from pkg.mixin import RunnableMixin`,需按模块路径解析到定义文件
  (复用/扩展现有 workspace 文件索引)。

### 4.2 跳转行为(与现有跳转合并)
- **保留现有 `.def` 路径不动**(`resolveMethodDefinition` `entityMapping.ts:568`):
  实体声明的方法仍走 `.def`(KBEngine 语义:方法契约在 `.def`)。
- **新增 Python 层级兜底**:当 `.def` 查不到(即 mixin 提供的方法),走 `PythonClassIndex` 按 MRO 找实现。
  合并点在 `provideDefinition`(`languageProviders.ts:1900`):`.def` 未命中 → 尝试 Python MRO → 都无则返回 null。
- **多个实现时的 UI**:
  - **MRO 唯一命中**(只有 1 个类在 MRO 里定义了该方法)→ 直接跳那一个(与现在体验一致)。
  - **多个候选**(同名多实现 / 菱形)→ 返回 `vscode.Location[]`,VS Code 原生弹**列表选择**。
    每项 label 带「类名 + 定义文件」,description 带「MRO 序号 + 是否 mixin」。
  - **不跳第一个**:跳第一个在菱形下会误导(可能跳到不会被执行的实现);列表选择是唯一不撒谎的呈现。

### 4.3 大仓性能(必须增量/缓存)
- **按文件粒度缓存 + 失效**:沿用 `EntityMappingManager` 的 index 缓存思路;Python 文件变更
  (`onDidChangeTextDocument` / 文件 watcher)只重解析**该文件**的类定义,不全仓重扫。
- **懒解析 MRO**:MRO 只在**跳转/CodeLens 请求时**按需算,不预计算全仓类图。
- **跨文件基类解析缓存**:import → 定义文件的解析结果 memoize;文件变更时按 import 反向索引失效。
- **预算上限**:单次跳转的 MRO 遍历设深度/节点上限(防循环 import 死循环),超限降级为「列出直接基类」。

### 4.4 CodeLens(与跳转共用 `PythonClassIndex`)
- **触发点**:类定义行(`class X(...)`)与方法定义行(`def foo`)。
- **内容**:
  - 类定义处:「provided by: RunnableMixin, ServerEntityCommon」——列出该类**从哪些 mixin/基类**
    继承了能力;多个来源**全部列出、逐个可点**(`CodeLens.command` 带 location,点击跳到对应 mixin 定义)。
  - 方法定义处:若该 `def` 是**被 MRO 中多个类共有**的同名方法之一,标注「overrides Base.foo / 提供给 N 个子类」。
- **与跳转合并**:CodeLens 的「来源列表」与跳转的「多实现列表」**同一份 `PythonClassIndex` 查询结果**;
  跳转返回 `Location[]` 时,CodeLens 复用同样的候选集渲染,不重复实现归属判定。
- **每类都触发 → 增量/缓存**(避免输入卡顿):
  - CodeLens provider **只读缓存**(`PythonClassIndex` 已在文件打开/变更时增量更新),不在
    `provideCodeLenses` 里做重解析。
  - `vscode.languages.registerCodeLensProvider` 结果按 document 版本缓存;仅该文件变更时重算该文件的 lens。
  - 大仓:类定义数量多时,对 lens 做**节流**(如 100ms debounce)+ 只对「有 mixin 基类的类」出 lens
    (单继承 `KBEngine.Entity` 的类不出,省掉绝大多数)。

---

## 5. 验收口径
- **以真实跳转成功率为准**:需一份**含 mixin 的真实资产仓**(本引擎仓不含,见 §3)。
  在该仓上抽样:`self.<mixin方法>()` 调用点 → 跳转命中 MRO 正确实现 的比例。
- 分层验收:
  1. 单继承实体(现有能力)不回归 —— `.def` 路径未改动。
  2. mixin 方法(A/B/D)跳转命中 MRO 正确实现;多候选时列表可选且每项可点。
  3. CodeLens 在 mixin 类/方法处列出全部来源、逐个可点。
  4. 大仓输入不卡顿(lens 增量 + 缓存生效)。
- **不看测试覆盖率**;C(运行时注入)标记为「静态不可解」,不计入成功率分母,只做启发式提示(可选)。
