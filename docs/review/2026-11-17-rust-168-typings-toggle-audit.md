# RUST-168 审计:typings 开关切换——语言服务器行为 / 索引失效 / 诊断收敛

- 日期:2026-11-17
- 结论:**审计结案,基线零生产码改动**;切换面全链行为钉齐(新增 3 钉于 `tests/pythonExtraPaths.test.ts`),契约文字补进 `docs/guide/configuration.md` 的 `kbengine.python.stubExport` 行(en+zh)。
- 旧词澄清:旧 PY-018 的「typings 开关」指已退役的 `kbengine.python.stubSourceMode` / `kbengine.python.stubEngineTypings`(2026-11-11 静态模板车道退役,configuration.md 设置总账有记载)。现代对应面 = `kbengine.python.stubExport`(总闸,管四件事)/ `kbengine.python.stubCopy`(窄闸,只管自动复制这一步)/ `kbengine.python.extraPathsSync`(Python 接线开关)。

## 触发链(切换后行为靠谁驱动)

- 激活期静默链(`src/activate/generators.ts:157`):`exportKbeStubs` → `exportPythonTypeStubs` → `syncPythonExtraPaths`(silent)→ `exportEntityTypeStubs` → `syncJsoncAssociation`。任何开关切换都在**下次激活**被这条链重新对齐。
- `kbengine.managedDir` / `kbengine.python.stubDir` 变更:watcher 即时重建+同步(KODE-PYRIGHT-001,`generators.ts:243-256`)。
- `kbengine.python.entityStubMethods` 变更:即时重导实体方法面(`generators.ts:261-268`)。
- `stubExport` / `stubCopy` / `extraPathsSync` 三个开关本身**没有 watcher**——契约即「下次激活/手动命令生效」,本次审计按此口径钉死,不改成即时生效(与 :301 已文档契约一致)。

## 切换矩阵

| 切换 | `python.analysis.extraPaths` 管理段 | `python.analysis.stubPath` | `reportMissingModuleSource` 压制 | pyrightconfig 进程档 | 盘上桩文件 | workspaceState 记忆键 |
|---|---|---|---|---|---|---|
| `stubExport` 开→关 | 下次同步**撤出**存根目录(新钉 T1) | 不再写;已写值保留 | 不再写;已写 `none` 保留(无 managed 记忆键,不可与用户值区分=文档契约) | 不再同步(`processMode` 闸:总闸关即 false) | **保留**(导出开关不是删除开关) | 收敛为撤线后管理段 |
| `stubExport` 关→开 | 下次同步**复线**(新钉 T3) | 复写(用户自设永不覆盖,CFG-03) | 键级合并补 `none`(用户已有键不动,CFG-04) | 角色桩在盘判定通过即恢复 | copy-if-absent + 内容比对零写 | 收敛为复线后管理段 |
| `extraPathsSync` 关 | 同步整体 no-op,只说明不写(既有钉 `tests/pythonExtraPaths.test.ts:288`) | — | — | — | — | 不动 |
| 边界:`stubExport` 关 且 无可发现根 | 撤线**不发生**——「不写配置也不打扰」是既定契约(`:599`;新钉 T2 断言陈旧记忆保留) | — | — | — | — | 保留到下次有管理段可写的那次同步 |

撤线/复线的唯一驱动是 `kbengine.python.extraPaths.managed:<root>` / `kbengine.python.stubPath.managed:<root>` 记忆键;盘上文件只作「在盘」判据(`processMode` 认角色桩包 `<stubDir>/base/KBEngine/__init__.pyi`,迁移期兼容旧单文件 `KBEngine.pyi` 与桩包 `KBEngine/__init__.pyi`)。

## 语言服务器行为(本扩展侧边界)

本扩展对语言服务器只负责**把配置写对**:写 `.vscode/settings.json`(`python.analysis.*` 三键,JSONC 宿主经带资源域 update)与 `pyrightconfig.json`(进程档,JSONC applyEdits 保注释)之后,Pylance/Pyright 自行重载配置并重建自己的索引——该重载行为是语言服务器的外部行为,本审计**不声称**真机表现;真机导航与 stub 优先级验证在 RUST-170 泳道(对 Pylance/Pyright 分别真实环境验证),届时收口。

## 索引失效(本扩展侧:零耦合,不需要失效)

- 流敏感分析 LRU 按文档实例身份成键(`src/flowVersionKey.ts`,KODE-PERF-001:WeakMap 单调 id + version)——与桩无关;
- Rust 侧解析 LRU 按 文本+版本 键控——与桩无关;
- def/实体注册表的失效事件只来自 def / types.xml / entities.xml 文件事件——桩文件增删不触发;
- 跨激活状态只有 workspaceState 记忆键两枚(extraPaths.managed / stubPath.managed),撤复线由其驱动——新钉 T1/T3 对「记忆同步收敛」有直接断言。

结论:typings 开关切换**不需要**本扩展侧任何索引失效动作;需要失效的只有语言服务器自己的索引,其触发面(配置文件变更)由本扩展正确写盘保证。

## 诊断收敛

- CFG-04 噪声压制(`reportMissingModuleSource='none'`):只加不撤——总闸关后不再写,已写的 `none` 常驻(文件仍在盘时该压制语义正确;无 managed 记忆键故不可撤,这是文档化取舍而非遗漏);
- 契约诊断 `kbengine.configContract.extraPathsAbsolute`:每次评估读配置现值,无缓存——切换后的下次评估即收敛;
- 撤线后 Pylance 对 `import KBEngine` 的解析走 stubPath(保留值)→ 与盘上文件一致,不产生新诊断漂移。

## prove-red(两变异三红,cmp 还原)

- 变异 a:`extraPathsSync` 与 `stubExport` 两道读值恒 true——撤线面失效,红 3(含新钉 T1「撤出+记忆收敛+不再写 stubPath/压制」);
- 变异 b:删「管理段为空即 continue」闸——无根也撤线违反不打扰契约,红 3(含新钉 T2;同时抓出两个既有契约钉);
- 恢复:cp 备份 + cp 还原 + `cmp` 字节校验通过,复跑 42/42 绿。

## 新钉清单(tests/pythonExtraPaths.test.ts 尾节「RUST-168 typings 开关切换」)

1. **T1 关→撤线**:总闸关 + 记忆键持有存根段 → 下次同步 extraPaths 撤出存根目录、记忆收敛为发现根、stubPath 与压制均不再写;
2. **T2 关→无根**:总闸关 + 无可发现根 → 零写入、陈旧记忆保留(诚实边界,不写不打扰契约);
3. **T3 关→开复线**:记忆处于撤线后形态 + 存根文件回盘 → extraPaths 复线(根+存根目录)、stubPath、压制一并恢复,记忆收敛。
