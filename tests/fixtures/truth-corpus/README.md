# 人工真值语料(KSEM-QA-01)

QA-001 判据:「每类能力有引擎/声明依据的正例、反例、未知例;**TS/Rust 一致不等于正确**」。
`tests/fixtures/parity/golden.json` 钉的是 TS≡Rust 对拍;本语料钉的是**引擎真值**——
双方一致仍可能一起错,故每条样本必须带引擎依据(evidence),不允许「两边一致所以对」。

## 语料文件

每族一个 JSON:`<family>.json`,结构:

```jsonc
{
  "family": "能力族 id",
  "grounding": {
    "doc": "docs/knowledge/<依据档>.md",     // 必须真实存在
    "engineHead": "引擎 fork HEAD(依据档钉死的 commit)"
  },
  "entries": [{
    "id": "...",
    "kind": "positive | negative | unknown",  // 正例/反例/未知例
    "input": { "spelling": "...", "path": "xml | decorator" },
    "engine": { "load": "accept | reject | reject-silent", "truth": "一句话引擎行为" },
    "evidence": ["依据档原文的逐字子串(测试做 containment 闸,伪造锚点即红)"],
    "kode": {
      "analysis": { "domains": [...], "tokens": [...] },  // 分析面实测输出(探针取真值后钉)
      "validation": { "diagnostic": "none | pipe | unknown" },
      "status": "pinned | not-analyzed | unverified"
    },
    "finding": "divergence 注记(无则省略)"
  }]
}
```

## 纪律

1. **evidence 是逐字子串闸**:每条 evidence 必须逐字出现在 grounding.doc 里,
   测试 `truthCorpus.test.ts` 做 containment 校验——凭记忆写锚点、锚点漂移、
   伪造依据都会红。不接受「见 §N」式悬空引用。
2. **kode 侧期望必须探针实测后钉**(临时 vitest 抛错打印真值),不许按源码臆断;
   语料钉的是「当前行为+引擎真值」的对照,不是愿望。
3. **未知例必须诚实**:知识档没写的写 unknown,reason 写清缺口在哪、下一步查哪
   (引擎树在 fork 3082ab5)。不许用推测填 unknown,也不许把没核的说成已核。
4. **divergence 只登记不冒充修复**:kode 面与引擎真值不一致时,`finding` 写明
   哪个面、什么方向、既有的缓解(如并行诊断)是什么;修复归后续批次,本语料
   不在修复前改 kode 期望。
5. **族扩充**:每族一个 JSON;执行闸(跑 TS 面)只对 `status: "pinned"` 且
   `path: "xml"` 的条目生效,decorator 面kode 未分析处如实 not-analyzed。

## def-property-flags 族(2026-11-17 首族)

依据:docs/knowledge/def-flags.md(fork HEAD 3082ab5,2026-11-09 钉)。
本族探针实测暴露的登记面(均已在条目 `finding` 注记,修复归后续批次):

- 分析面(`propertyFlagDomainList`/`normalizeFlagTokens`)对引擎拒载的三种拼法
  (`|` 组合、空白折叠、无下划线紧缩拼)仍投影域位——代码注释明示「分析侧容错
  只影响建议面」,验证面(KR-AUD-84 整串查表诊断)与引擎同向兜住;残余风险=
  hover/补全建议面展示引擎不接受写法的域位。
- 验证面对空 `<Flags></Flags>` 静默(引擎查空串失败=模块拒载);分析面诚实空。
- 装饰器路径(kode 未分析):引擎侧别名拼写静默 UNKOWN 无任何面(common.cpp:42-68
  精确 8 名链,py_entitydef.cpp:2507 不检查)。
- Rust 侧同表镜像(normalize_flag_tokens 同容忍族),golden=
  crates/kode-server/tests/golden/flag-domains-parity.json。
