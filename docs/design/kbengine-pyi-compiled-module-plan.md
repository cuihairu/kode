# KBEngine.pyi 全量生成方案：源码枚举车道

- 日期：2026-11-09
- 提案人：用户（「根据源码精确的校验的版本，然后内部集成，然后生成的时候复制过去」；「真正生成完整 KBEngine.pyi」）
- 状态：**方案定稿（源码枚举主车道），待点火**。编译 .so 车道已实测并**否决**（见 §4 实测记录 + §5 否决理由）。
- **状态更新（2026-11-11，批 ③ 落地）：本方案被静态模板车道取代。** 最终形态：插件内置静态模板（kode 仓库顶层 `typings/`，派生自用户 fork `cuihairu/kbengine` 的 typings，钉点 commit **28d2117**，`scripts/derive-kbengine-stub-typings.mjs` 按 fork 布局一类一文件切分；kode overlay = `Entity.pyi` 的 `cellData` 声明、`Proxy.pyi` 的 `__ACCOUNT_NAME__`/`__ACCOUNT_PASSWORD__` 内部属性标注、`_vectors.pyi`），激活期 **copy-if-absent** 复制到 `<managedDir>/stubs/`（零覆盖铁律，覆盖只走 `kbengine.python.resetStubs` 显式命令且要用户确认；旧动态生成链——引擎 checkout 拼接/精选目录回退/托管目录内容比对重写——与 `stubSourceMode`/`stubEngineTypings` 设置一并退役）。本文件的枚举器/合并器（Phase 1/2）未再点火：fork typings 已覆盖成员集，签名质量即 fork 手工质量（与 §1.3 结论一致）；如未来发现 fork 缺成员，再回到本车道补枚举。§4 编译 .so 否决实测记录原样保留。
- 关联：todo `IDE-STUB-005`（pyrefly stubgen 车道拍板——本方案是其演化终态：pyrefly stubgen 对无标注代码全落 `Incomplete`（KODE-CFG-017 实测结论，`src/pyreflyInfer.ts` 头注），不采用；crates.io `pyrefly` 是 0.0.1 占位符（"Coming soon to crates.io"，0 依赖），Rust 库直集成不可行，维持 CLI shell-out）。

## 0. 一句话方案

**KBEngine 模块的完整成员集可以纯静态地从引擎 C++ 源码枚举出来**——全部成员都经过少数几种注册调用（`APPEND_SCRIPT_MODULE_METHOD` / `X::installScript(module)` / `installModule` / `PyModule_AddIntConstant` / `PyModule_AddStringConstant`），这些调用在源码里是确定、可 grep 的。因此：

1. **钉死引擎源码版本**（fork 仓 git commit，作为生成输入）。
2. **源码枚举器**扫描注册调用 → 得完整成员名单（方法/类/子模块/常量）。
3. **与既有引擎 typings 合并**（`typings/_KBEngine_*.pyi` 11 文件，用户自生成，提供签名质量）。
4. **生成时复制**到 kode `.kbengine/stubs/KBEngine.pyi`。

**不需要编译 .so、不需要 pyright、不需要运行时 dump。** 版本精确（源码是唯一真值），内部集成（kode 消费既有 typings），生成时复制（落 .kbengine/stubs 现有交付面）。

## 1. 事实底座（全部本机核实）

1. `KBEngine` 模块由 C++ 侧 `Script::install(..., "KBEngine", componentType_)` 注入（`kbe/src/lib/server/python_app.cpp:213`）；全树无 `PyInit_KBEngine`——没有独立 `.so/.pyd`。
2. **模块成员集 = 源码注册调用的并集**，注册形态只有五种，全部静态可枚举：
   - **模块方法**：`APPEND_SCRIPT_MODULE_METHOD(module, NAME, fn, METH_VARARGS, 0)`——`kbe/src/lib` 52 处 + `kbe/src/server` 47 处，共 99 处，去重后即方法名单（实测含 `createEntity/createEntityLocally/createEntityAnywhere/executeRawDatabaseCommand/addWatcher/delWatcher/getWatcher/getWatcherDir/addTimer/delTimer/registerReadFileDescriptor/.../fireEvent/publish/charge/...`）。
   - **类**：`X::installScript(module)`——`Entity::installScript/Proxy::installScript/Space::installScript/EntityComponent::installScript/GlobalDataClient::installScript`（baseapp.cpp:408-412）+ `EntityCall::installScript/EntityComponentCall::installScript/FixedArray::installScript/FixedDict::installScript/VolatileInfo::installScript/PyMemoryStream::installScript`（entitydef.cpp:2453-2460）。
   - **子模块**：`installModule("Math")` → Vector2/Vector3/Vector4（`tp_name` 三处）；`installModule("EntityDef")` → `rename/method/clientmethod/property/entity/interface/component/fixed_dict/fixed_array/fixed_item`（py_entitydef.cpp:1815-1830 `PY_ADD_METHOD` 十项）。
   - **常量**：`PyModule_AddIntConstant(module, name, val)`（baseapp.cpp:423 遍历）；`PyModule_AddStringConstant(module, "component", componentName)`（script.cpp:248）。
3. **签名质量**：C 扩展函数是 `METH_VARARGS`，运行时/源码反射拿不到参数表——无论哪条车道，签名质量上限 = 既有引擎 typings 的手工质量（用户自生成）。**完整性**（成员名单）来自源码枚举，**签名**来自 `typings/_KBEngine_*.pyi`。
4. 分发管线 `tools/build_kbengine_typing_bundle.py` 已存在（typings 打包 drop-in）；kode 侧 `.kbengine/stubs` + `extraPaths/stubPath` 自动接线已存在。
5. baseapp/cellapp 暴露的 KBEngine API 不完全相同（`KBENGINE_TYPING_TODO.md` 确认）——枚举器按组件面（base/cell/bots/login/db/logger/interface）分别扫对应注册段，产出与 `_KBEngine_*.pyi` 11 文件分文件真值对齐。

## 2. 总链路（源码枚举车道）

```
kbengine fork 源码 (钉死 commit)
    │
    ├─ 源码枚举器 extract_kbengine_api.py
    │    扫注册调用 → 完整成员名单 JSON (方法/类/子模块/常量, 按组件面)
    │
    ├─ 既有引擎 typings typings/_KBEngine_*.pyi (签名质量)
    │
    └─► merge_kbengine_stub.py
          底座 = 引擎 typings (签名)
          补集 = 枚举成员全集 (完整性, 补 def name(*args:Any,**kwargs:Any)->Any / name:Any)
          typings 有而枚举无的成员标注 "# not in source enum" (供人工复核, 不删)
          │
          ▼
     KBEngine.pyi (全量成员 + 最好签名) ──复制──► kode .kbengine/stubs/KBEngine.pyi
```

**为什么枚举代替编译**：编译 .so 需要 85 个静态库全量 PIC 重编 + 链接修正（fmt v10/v12 头不匹配、`--whole-archive` 强制抽取、系统 libcurl/libssl/libmysqlclient 手动补）+ 模块初始化序列要真实 Script 单例（否则 `PyUrl::initialize` 空指针段错误）+ pyright 对纯二进制模块的 createstub 能力未证实。**源码枚举零编译、零 ABI 风险、零 pyright 不确定性、版本可钉死、可在 CI 里跑。** 两者完整集相同（都是真值），枚举更稳。

## 3. 分阶段任务

### Phase 0：枚举可行性 spike（本机，已完成）

| 步骤 | 状态 | 结果 |
|---|---|---|
| 0.1 确认注册调用全枚举 | ✅ | 五种形态全部 grep 到（见 §1.2），99 处方法 + 类 + 子模块 + 常量 |
| 0.2 编译 .so 车道实测 | ✅ 完成并否决 | 见 §4 实测记录；产出 24MB KBEngine.so 但 import 后段错误（Script 单例缺失），修复即暴露更多系统依赖链——收益不抵成本 |
| 0.3 枚举器原型 | 未开始 | 扫 `kbe/src` 五形态注册调用 → JSON；单测用 fixtures |
| 0.4 与 typings 合并对账 | 未开始 | 枚举成员 ⊇ typings 成员？缺口/盈余各列 |

### Phase 1：枚举器与合并器（~1 天，引擎 fork 仓）

1. `tools/extract_kbengine_api.py`：五形态注册调用扫描器，输出 `kbengine-api.json`（组件面 × {methods, classes, submodules, constants}）。
   - 只 grep/parse 源码文本，不编译、不 import。
   - 组件面参数化：`--component base|cell|bots|login|db|logger|interface`，与 `_KBEngine_*.pyi` 分文件对齐。
2. `tools/merge_kbengine_stub.py`：底座 = `typings/_KBEngine_<component>.pyi`（签名）；补集 = 枚举成员全集（补 `def name(*args: Any, **kwargs: Any) -> Any` / `name: Any`）；盈余标注 `# not in source enum`。产物过 kode 自洽门（93ad3854：签名引用名必须已导入/已定义）。
3. 单测：枚举器（五形态各命中 + 组件面过滤 + 99 处方法去重）+ 合并器（补集/标注/排序），fixtures 用源码样本 + JSON 样本。
4. 引擎仓 CI/每日构建：枚举器 + 合并器 + import 冒烟（防引擎改动后成员集静默漂移，与 §6 验收口径挂钩）。

### Phase 2：kode 集成（~0.5 天，需用户拍板车道位次）

- `kbengine.python.stubSourceMode` 语义延伸或 `stubEngineTypings` 优先级链加一级：**源码枚举合并产物 > 引擎 typings 拼接（现状，用户 typings）> 精选目录（兜底）**。
- 生成在引擎仓做，产物按现有 `.kbengine/stubs` 交付面复制落入；kode 只消费。命令与来源标注沿用 `kbengine.python.exportStubs` 现有播报面。

## 4. 编译 .so 车道实测记录（2026-11-09，本机 Linux，已否决）

> 保留作为「为什么否决」的证据，不删除。

- **链接错误一（无 -fPIC）**：`relocation R_X86_64_PC32 ... recompile with -fPIC`（libkbe_pyscript.a copy.cpp / libkbe_network_interface.a NetworkInterface vtable）→ 全树 `-DCMAKE_POSITION_INDEPENDENT_CODE=ON` 重编解决。
- **链接错误二（multiple definition）**：`g_componentGlobalOrder/g_componentGroupOrder/g_genuuid_sections`（server_runtime serverapp.cpp ↔ components_bootstrap_support）→ `--allow-multiple-definition`（spike）。
- **库名不匹配**：`libkbe_fmt.a` 实际产物名 `libfmt.a`（CMakeLists 引用名 ≠ 产物名）。
- **fmt 版本头不匹配**：stub 模块对象编译时用了 fmt **v10** 头（`.o` 引用 `fmt::v10::vformat`），而 kbe libs 与 vendored fmt 是 **v12**（`FMT_VERSION 120100`）→ 用 vendored 头重编 `.o` 解决。
- **系统库缺失**：`import` 报 `curl_easy_cleanup`/`mysql_fetch_lengths` 未定义 → 手动补 `-lcurl -lssl -lcrypto -lz -lmysqlclient`。
- **`--whole-archive` 必需**：弱 vtable 引用不触发惰性归档抽取（`libkbe_common_memorystream.a` 含 vtable 但默认不抽）→ `--whole-archive` 强制抽取。
- **段错误（最终否决点）**：`import KBEngine` 在 `PyUrl::initialize(pScript=0x0)` 段错误——`PyUrl::initialize` 解引用 `pScript->getModule()`，但 stub 源码传 `NULL`（其注释「只需存指针」是错的）。修复需构造最小 `Script` 单例（`StubScript : Script { StubScript(PyObject* m){ module_ = m; } }`）→ 修复后 import 成功，`dir(KBEngine)` 仅 10 成员（`MemoryStream/genUUID64/urlopen/component` + dunder；`Math` 子模块有 Vector2/3/4）。
- **10 成员的启示**：即使 import 成功，成员集也只有 lib 侧已链接的少数——`createEntity/Entity/Proxy/Space` 等 server 侧成员（baseapp.cpp:408-434）**根本不链接进桩模块**，要补就得把 baseapp 全链进来，又引入 app 单例/网络初始化依赖链。**这是否决的本质：编译车道的完整集上限 = 可链接闭包，而非模块真值；源码枚举无此上限。**

## 5. 边界与风险（诚实面）

1. **源码枚举的完整性依赖注册形态覆盖**：已确认五种形态覆盖全部成员（§1.2 全 grep 到）。若有新注册形态（如未来加 `PyModule_AddFunctions`），枚举器单测会红——这是特性不是缺陷（防漂移）。
2. **C 函数签名泛型化是物理极限**（METH_VARARGS 无反射），签名质量上限 = 引擎 typings 的手工质量。枚举只保证「一个不漏」，不保证「每个都强类型」。
3. **组件面矩阵**：base/cell/bots/login/db/logger/interface 七面，每面扫对应注册段；单一 .so 只承载一个面（§1.5），枚举器天然分面无此约束。
4. **Windows 无需验证**：枚举是纯文本扫描，与平台无关，无 .pyd 编译需求。用户原「Windows 归 iMac」分派针对编译车道，此车道不适用（若仍走编译车道则按用户分派）。
5. 引擎仓与 kode 仓职责分离：枚举器/合并器改动落在 kbengine fork 仓，kode 侧只接消费车道——**引擎 fork 的提交不在 kode 交付面内**，须用户在引擎仓点头。

## 6. 验收口径

1. 枚举器输出成员集 ⊇ 既有 `_KBEngine_*.pyi` 成员集（一个不漏，含 `createEntity/addWatcher/Vector3/genUUID64` 抽样）。
2. 产物 .pyi 过 kode 自洽门（93ad3854 回归测试两面绿）。
3. Pylance 探针项目：`import KBEngine` 无 could-not-resolve；抽样成员类型非 unknown。
4. kode 门禁四件套绿；枚举器/合并器单测绿。
5. 引擎 fork 任一改动后：枚举器 CI 跑，成员集变化即红（防静默漂移）。
