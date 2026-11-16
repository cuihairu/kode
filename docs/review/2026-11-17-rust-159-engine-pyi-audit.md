# RUST-159 审计结案:KBEngine 引擎 builtin API .pyi 按版本/commit 生成,支持用户引擎分支覆盖

日期:2026-11-17
性质:审计结案(基线零改动)——版本/commit 钉定与用户引擎分支覆盖两面已系统性建成。

## 按版本/commit 生成

1. **静态模板车道**(docs/design/kbengine-pyi-compiled-module-plan.md §状态更新 2026-11-11):插件内置 `typings/` 派生自用户 fork `cuihairu/kbengine` **钉点 commit 28d2117**(作者时步骤 `scripts/derive-kbengine-stub-typings.mjs` 一类一文件切分;kode overlay=Entity.pyi cellData/Proxy.pyi __ACCOUNT_NAME__·__ACCOUNT_PASSWORD__/_vectors.pyi);激活期 copy-if-absent 复制落 `<managedDir>/stubs/`——**零覆盖铁律**,覆盖只走 `kbengine.python.resetStubs` 显式命令且要用户确认;旧动态生成链(引擎 checkout 拼接/精选目录回退/托管目录重写)与 stubSourceMode/stubEngineTypings 设置一并退役;
2. **版本化消费面**:engineVersion 设置(预设 3.7.3/3.7.2/3.6.3/fork-3.12/2.5.10,精确串不猜 semver,fork- 前缀抑制 fork 标注,KB-VER 分层标注/越界提示);engine_api metadata(readEngineApiMetadata,engineApiMetadata.ts)从用户引擎 root git rev-parse HEAD + describe --tags --always --dirty 读 commit/describe 进 metadata 面;
3. `process-api.json` 与 .pyi 同源生成,TS/Rust 双侧内嵌(进程模块补全/hover 签名匹配)。

## 用户引擎分支覆盖

1. **引擎 root 探测**(engineApiMetadata.ts:93):显式 engineRoot → `KBENGINE_ROOT` env(`off`=关闭)→ `<workspace>/../kbengine` 兄弟目录,hasEngineTreeMarker 校验;命中后读该分支真实 commit/describe——用户自有分支的版本事实如实进面;
2. **engine_meta OverrideSet**(crates/kode-server/src/semantics/engine_meta.rs:84):外部版本覆盖,后登记者优先,被遮蔽的 seed/更早 override 进 `shadowed` 事实不删除;未声明版本不猜(版本域 override 不生效,全版本 override 照常)——用户分支的能力差异经 OverrideSet 外部供给,seed=2.5.10 实证基线;
3. **版本差异 capability**(CAP-01/RUST-117):调用点按声明版本解析 profile 一次,逐能力 Supported/Unsupported/Unknown;
4. **用户资产保护**:copy-if-absent+resetStubs 确认闸=用户在自己 stub 上的分支适配不被生成物静默吞(用户自配目录同名文件按用户资产不动,RUST-155 在案)。

## 边界(如实)

引擎 fork 的提交不在 kode 交付面内(plan §职责分离):fork typings 质量即 fork 手工质量,新注册形态靠枚举器单测防漂移(特性非缺陷);kode 侧只接消费车道。

## 结论

版本/commit 钉定(fork 28d2117 源码唯一真值+git 元数据面)与用户引擎分支覆盖(root 探测+OverrideSet 遮蔽事实+capability profile+零覆盖铁律)已系统性满足。基线零改动。
