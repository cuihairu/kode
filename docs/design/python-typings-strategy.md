# 项目 Python 文件 typings 策略(产品 spec)

日期:2026-11-17。回答 RUST-157(旧 PY-007)的三选一问题,并钉死「禁止空壳 Any 作为完整实现」纪律。

## 裁定:三车道并存,主车道是「类型增强」

项目 Python 文件(`scripts/**/*.py` 等用户脚本)**不**整树镜像为 pyi、**不**导出用户脚本的 pyi。kode 对用户脚本 typing 的策略=**类型增强**:kode 只生产自己语义域产生的类型面(引擎 API/进程面/实体面/自定义类型),经 pyrightconfig 托管注入 Pylance;用户脚本内部的通用 Python 推导归 Pylance + pyrefly infer(RUST-148 冲突矩阵分立、RUST-152 对接在案)。三车道的分工:

### 1. 解析输出镜像(限 KODE-CFG-017 用途)

`.kbengine/inferred/` 镜像 scripts 树(src/backend/inferredCopy.ts)=pyrefly infer **就地写注解的工作副本**(用户真码永不改);镜像**不进 extraPaths/导入解析**(docs/design/kode-cfg-017-consumer.md 钉死),消费面=pyrefly infer 工作区 + kode 原生 provider 读副本。**不是** typings 发布面——绝不作为 Pylance 的类型来源。

### 2. 类型增强(主车道)

- 四层 stub:①引擎 KBEngine.pyi(fork 源码静态枚举,docs/design/kbengine-pyi-compiled-module-plan.md);②进程模板 `typings/<role>/KBEngine/`(docs/design/python-process-typings.md:base/cell/bots/client/dbmgr/interfaces/logger/loginapp 八目录,进程隔离显式 re-export,共享件单源 `typings/shared/_kbengine_shared/`);③实体 `entity_types.pyi`(RUST-156 审计在案);④自定义 `kbe_types.pyi`(RUST-155 审计在案);
- 注入通道:pyrightconfig.json 托管(per-directory executionEnvironments,extraPaths 序=角色桩根→stubs/shared→脚本目录→公共依赖;global stubPath=`stubs/_shared` 与进程包分离防全局 KBEngine 压制隔离;JSONC 保持,用户显式配置不接管,用户改过的生成条目按用户资产归用户,冲突只报告不替换);
- 用户脚本在此通道下由 Pylance 以 stub 增强后的类型做判定。

### 3. 导出 .pyi(仅限 kode 语义域类型面)

导出车道只覆盖上述四层 stub(docs/design/def-pyi-stubs.md 规格化)。**明确不做**:把用户脚本解析输出整树镜像成 pyi 发布(那是 Pylance/pyrefly 的推导域,kode 复制即竞争且必然过时)。

## 禁止空壳 Any 作为完整实现(硬纪律)

- Any 的**唯一**合法语义=解析链诚实末端:链断/成环/级联失败/未知落 Any(pythonTypeStubs/entityTypeStubs 共用 resolveAnnotationTypeWithRegistry 链;poisoned 名不发射不造伪;裸 ARRAY 未注册与未知同责);
- **禁止**:以 `Any` 占位充当整属性/整方法/整文件的「已完成」typings;凡 kode 自己能推导的(def 类型声明、types.xml 解析链、方法段形参)必须给出精确注解,推不出的显式未知并保持诚实,不得用 Any 掩盖可推导面;
- 审计位:pyrightStubGate 落盘校验(IDE-STUB-002)+RUST-155/156 审计逐面核实+19 parity 体系回归。

## 边界(如实)

- 用户 pyrightconfig 显式 pythonVersion 不接管(RUST-151 边界);
- pyrefly infer 的覆盖率与原因报告=KODE-CFG-017-R 消费面(docs/design/kode-cfg-017-consumer.md),不并入 stub 发布;
- 本 spec 是策略收敛,不新增车道;后续 typings 类任务(RUST-158 覆盖率推断/RUST-159 引擎 pyi 版本化)按各自行执行,不得违反本裁定。
