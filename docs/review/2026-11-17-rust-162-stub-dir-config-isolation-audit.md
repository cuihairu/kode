# RUST-162 审计结案:.pyi 输出目录隔离、pyrightconfig/analysis.extraPaths 集成,禁止不经确认覆盖现有配置

日期:2026-11-17
性质:审计结案(基线零改动)——目录隔离与配置写入闸已系统性建成,「禁止不经确认覆盖」由五道闸满足。

## 输出目录隔离

- 默认落 `<managedDir>/stubs/`(kbengine.managedDir,默认 `.kbengine`,管理段);`resolveStubDir`(managedDir 设置+stubDir 设置+folder 名解析)支持用户自配目录;isolated 档分进程 `processStubRoot(stubDir, base/cell/bots/client)` 各自 KBEngine/__init__.pyi+entity_types.pyi(python-process-typings.md 八目录进程隔离);
- **用户资产保护**:copy-if-absent 零覆盖铁律(激活期只建缺);覆盖只走 `kbengine.python.resetStubs` 显式命令+用户确认;用户自配目录里的同名生成文件按用户资产不动(pythonTypeStubs 头注钉);
- `.kbengine` 管理段加 search.exclude/watcherExclude/gitignore 隔离面(inferPipeline ExclusionsApplyResult,KODE-CFG-017 线),镜像不进 extraPaths(T-04)。

## pyrightconfig 集成(syncProcessPythonConfiguration,src/pythonProcessConfig.ts:120-175)

五道「不经确认不覆盖」闸:

1. **类型闸**:executionEnvironments 存在但非数组 → 警告+整文件保留(return);
2. **user-owned 判别**:旧条目 ≠ workspaceState previous 记忆(managed 生成形态 JSON 全等)→ 视为用户条目,永远保留在 environments 尾部;用户编辑过的生成条目自动升级 user-owned;
3. **root 冲突闸**:desired 与用户条目同 root → 警告「已有用户执行环境,已保留;请将对应进程桩路径放入该环境的 extraPaths 首位」+整文件保留(return);
4. **extraPaths 用户闸**:config.extraPaths 与 previous 记忆不同(用户改过)→ 不写 extraPaths,用户全局路径并入 desired 序(config overrides settings);
5. **缺省闸**:stubPath 只在用户未自配(userConfigPath undefined)时写;reportMissingModuleSource 只在 undefined 时写;JSONC 经 applyEdits/modify 保格式保注释;内容比对零写(current !== source 才写盘)。

analysis.extraPaths 集成序:stubRoot/shared → scriptsRoots → stubRoot → 用户 extraPaths;per-environment 序=角色桩根首位→stubs/shared→脚本目录→公共依赖(RUST-148 批 2 收敛后角色环境不再重复 scriptsRoot 全树)。TOML 项目配置不替换(python-process-typings.md :73 钉)。

## 结论

目录隔离(管理段+分进程+用户资产保护)与 pyrightconfig/extraPaths 集成五闸(类型/user-owned/root 冲突/extraPaths 用户/缺省)已系统性满足「禁止不经确认覆盖现有配置」。基线零改动。
