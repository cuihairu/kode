# RUST-161 审计结案:.pyi 跳转用户定义的拦截策略——从 stub 逆向跳源,适配 Python LS 定义规则

日期:2026-11-17
性质:审计结案(基线零改动)——拦截策略=不劫持 Python LS、供给逆向镜;对 Pylance 定义规则的适配已由遮蔽纪律+stub 层次隔离系统性建成。

## 拦截策略:不劫持,供给逆向镜

- kode **不劫持** Pylance 的 go-to-definition(RUST-148 冲突矩阵分立纪律:通用语义归 Pylance,kode 多 provider 并存只补 def 域面)——「配置拦截策略」的裁定=**不拦截**;用户 F12 落进生成桩时,kode 供给桩内**逆向镜**:GeneratedSourceCodeLensProvider「原始定义」CodeLens(RUST-160 在案,e803c330 修复后 types.xml 族跳注册表文件、def 族逐实体解析 defFile 跳真源,缺映射不出镜绝不造错误跳转)——落桩一点即回真源;
- def 再生后 updateEntityPlan fire 让已打开桩立即重询镜(C-22),行映射渲染期记录(KR-AUD-78)禁硬编码。

## 适配 Python LS 的定义规则(四条既有纪律)

1. **生成桩不遮蔽实现**:entity_types.pyi 不遮蔽 Python 实现文件(python-process-typings.md 末钉)——Pylance 定义解析优先真实 .py 实现,能落真源就落真源,桩只补类型面;
2. **T-04 镜像不进解析**:`.kbengine/inferred` 绝不进 extraPaths/导入解析(KODE-CFG-017-R 铁律)——Pylance 永不跳进 pyrefly 副本,同名 .py 遮蔽红线;
3. **stub 层次隔离**:global stubPath=`stubs/_shared` 与进程包分离(python-process-typings.md:35),防全局 KBEngine 包压制 per-process executionEnvironment 隔离——Pylance 跳 KBEngine 时落**正确进程**的 stub(base 脚本落 base 桩),不会混装;
4. **用户 stub 权威**:copy-if-absent 零覆盖铁律+resetStubs 显式确认闸+用户自配目录同名文件按用户资产不动(RUST-159/155 在案)——用户自写 stub 在 LS 定义规则下保持权威,不被生成物静默替换。

## 引擎 API 桩的「源」

KBEngine.pyi/进程模板(fork typings 钉 commit 28d2117)无用户源可跳——其真源=引擎 C++;出处面由 engine_meta 版本化 metadata 供给(五类 seed 逐条引擎出处,RUST-159 在案),不造假跳转。

## 结论

「从 stub 逆向跳源」已由 CodeLens 逆向镜(修复后按来源族正确分目标)满足;「适配 Python LS 定义规则」由不遮蔽+镜像不进解析+stub 层次隔离+用户 stub 权威四纪律满足;拦截策略=不劫持。基线零改动;方法面 lens 候选已在 RUST-160 登记。
