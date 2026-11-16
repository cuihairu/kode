# RUST-158 审计结案:未注解 Python 签名按可置信信息推断;未知保留 Any/Unknown 并输出覆盖率与原因

日期:2026-11-17
性质:审计结案(基线零改动)——推断车道、未知保留与逐面原因输出已系统性建成;聚合百分比报告不存在,如实登记为形态边界。

## 推断车道(按可置信信息)

1. **def 域精确定**(最可信):def `<Arg>`/属性类型声明逐形参精确注解(def_param_hints/def_props_hints/rpcargs 深审-2 桥/serialization 值族,RUST-155/156 在案);
2. **pyrefly infer 外部推断**(KODE-CFG-017):`.kbengine/inferred/` 镜像 scripts 树(inferredCopy.ts,用户真码永不改),pyrefly `infer --python-version` 就地写未注解签名的注解;kode 消费富化(KODE-CFG-017-R 已实现,docs/design/kode-cfg-017-consumer.md):inferredEnrichment extractReturnAnnotation/extractParamAnnotations/extractVariableAnnotation/diffInferredAnnotations(inlay 行差分)+inferredMirrorLookup 链尾兜底 hover——**无注解条目静默回退现有行为**(未知不硬造);
3. **kode 原生推导**(RUST-PRECISION 批 C/D):同文件 def `-> T` 调用注解、赋值链传播(有界跳数+visited 防环)、接收者定型 localReturnType(链式 f().g() 任一环未知→null)、import 绑定路径(FileImportBindings from/裸两 face)——推不出显 null/空集,绝不猜。

## 未知保留 Any/Unknown(逐面)

- Rust 语义面:Unknown 不猜全局纪律(rpcargs `from_type_graph` 图缺=Unknown 带原文绝不默认 PYTHON;nav 类缺失不造行号;semantics 各模块查无=None 不硬造);
- stub 面:Any=解析链诚实末端(链断/成环/级联/裸 ARRAY 未注册与未知同责;poisoned 名不发射不造伪——RUST-155 审计);
- hover/inlay:接收者不可知→不显示(批 D 删全局方法名猜测),pyrefly 富化只读已注解条目;
- typings spec:docs/design/python-typings-strategy.md(2026-11-17,RUST-157)钉「Any 唯一合法语义=解析链诚实末端,禁止占位充当已完成」。

## 原因输出(逐面携带)

- stub 计划:PythonTypeStubSkipped{name,reason}(同名去重=引擎 addDataType 拒注册语义+winner 出处;poisoned 原因=成环/指引为空/级联);
- flow 面:unresolvedCode/unresolvedReason(FLOW-004 十码含全谱)+branchCondition/unknown-receiver 如实;
- def fingerprint:defFingerprintInspector 判定 reasons 列;
- infer 面:pyreflyInfer 拒绝原因(allowed=false 供诊断播报不静默);inferPipeline run 状态(status ran/not-found/disabled+逐 scripts 根退出码)。

## 覆盖率形态(如实登记)

镜像本身即覆盖产物(pyrefly 对全部未注解签名写注解,注解差异经 diffInferredAnnotations 以 inlay 呈现=逐签名可见);聚合「X% 签名已推断」统计报告不存在——逐面原因已携带、覆盖逐签名可见,聚合报告**裁定不做**(无消费面,避免死报表),登记为形态边界非缺口。

## 结论

三要素(可置信推断/未知保留/原因输出)已系统性满足;聚合覆盖率报告登记为不做。基线零改动。
