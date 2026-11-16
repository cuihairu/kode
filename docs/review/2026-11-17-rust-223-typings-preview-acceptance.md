# RUST-223 验收纪要:生成 typings 的预览/路径/来源图/覆盖率与冲突说明

日期:2026-11-17。本纪要对账 RUST-223(旧 UI-006,主 todo 排队项)的验收口径与既有交付证据。结论:**四维+预览全部有既有面(RUST-167 类型预览视图为主体),本批为纯对账收口(零代码增量)。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 预览 | `kbengine.typePreview` 树视图(RUST-167):API 类型树/typing 覆盖/缺失映射/来源跳转四件事归一一棵节点树,数据现算不缓存(getChildren/refresh 经 getModel 现算),`kbengine.typePreview.refresh`/`kbengine.typePreview.jump` 命令;导出命令尾链自动刷新 | `src/typePreviewView.ts`;`src/backend/typePreviewModel.ts`;`src/activate/generators.ts:121-140`;package.json views `kbengine.typePreview` |
| 路径 | 存根目录三源解析(设置 > 环境变量 > 默认约定 `.kbengine/stubs`),来源随值带出供播报与「配置来源」视图说明当前生效值来自哪里;kbe_types.pyi 分件约定路径(typings 根 fallback 布局) | `src/pythonStubExport.ts:158-258`(ResolvedStubDir/StubDirReading/resolveStubDir);`src/pythonTypeStubs.ts:135`(kbeTypeStubFilePath);批 142 用户令注记 |
| 来源图 | 生成物→真实源行双向:GeneratedSourceCodeLensProvider(生成 .pyi 内 code lens 跳回源,RUST-160 def 来源镜按实体注册表 defFile 解析——标量属性跳 .def 行而非 types.xml)+类型预览树来源跳转(一律真实源行,解析不出如实不跳) | `src/generatedSourceLenses.ts`;`src/backend/generatedSourceMap.ts`;KR-AUD-78 真实行映射注记 |
| 覆盖率 | 类型预览树「typing 覆盖」叶子:全部注解位里已解析(不含 Any)占比 `resolved/total`,`anyCount`=缺失映射候选数(与缺失映射共用同一份注解位事实);skipped 计数(别名解析失败 reason 直接入 skipped) | `src/backend/typePreviewModel.ts:27-34,118-127`;`src/pythonTypeStubs.ts:123-134`(plan.skipped) |
| 冲突说明 | 三层:①KBEngine 桩包 copy-if-absent 零覆盖(已有文件一字节不动,播报明示)+旧 kode 生成物迁移面(带生成标记才移除,用户同名文件绝不碰);②kbe_types.pyi 生成冲突 skipped 说明「已存在,按用户资产不覆盖」;③显式重置 resetKbeStubs 只走命令且要确认(模板集同名删后重复制,未知文件一律不碰,取消=零动作) | `src/pythonStubExport.ts:329-395,488`(copyTemplateIntoFolder/resetKbeStubs);`src/pythonTypeStubs.ts:845` |

## 「生成 typings」两族的分层记账(诚实边界)

- **kbe API 桩包(KBEngine/ KBEngine.pyi)**:复制型交付——内置模板(extensionPath/typings)整包 copy-if-absent,模板内容随扩展分发静态钉死(来源=扩展自带模板集,非运行时从引擎二进制枚举;编译 .so 车道实测否决,见 docs/design/kbengine-pyi-compiled-module-plan.md);本族可验收维=路径+冲突+reset。
- **自建类型桩(kbe_types.pyi + entity_types.pyi)**:真生成——从 types.xml 自定义类型/实体注册表(def)推导注解(buildPythonTypeStubPlan/buildEntityTypeStubPlan);预览/覆盖率/来源图三维全落在本族(RUST-167/RUST-160/KR-AUD-78)。
- 验收原文「生成 typings」两族都覆盖:①族有路径/冲突面,②族四维全有;不存在「只有生成无预览」的暴露面。

## 本批增量

- 零代码增量:四维+预览均有既有钉(typePreviewView/generators/pythonStubExport 套件),再造属仪式性重复。

## 诚实条款

- 覆盖率的口径是**注解位解析占比**(自建类型桩内的 typing 覆盖),不是「kbe 引擎 API 成员覆盖百分比」——引擎 API 桩是静态模板,无成员级覆盖测量面(如需,属 KBEngine.pyi 生成车道新需求)。
- 预览树数据现算不缓存(导出后尾链刷新);打开视图时若尚未导出过桩,树内容反映当前注册表推导结果,与落盘文件可能暂时不一致——差异由「导出命令尾链刷新」收敛,预览树不冒充落盘内容。
