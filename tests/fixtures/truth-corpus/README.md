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
    "doc": "docs/knowledge/<依据档>.md",     // 必须真实存在;每族只锚一份档
    "engineHead": "引擎 fork HEAD(依据档钉死的 commit)"
  },
  "entries": [{
    "id": "...",
    "kind": "positive | negative | unknown",  // 正例/反例/未知例
    // input 形状按族定(flags=spelling/path;cell-data=method/body/universe),
    // 公共信封(id/kind/engine/evidence/kode.status/finding/reason)族间共享;
    "input": { "...": "..." },
    "engine": { "load": "accept | reject | reject-silent", "truth": "一句话引擎行为" },
    "evidence": ["依据档原文的逐字子串(测试做 containment 闸,伪造锚点即红)"],
    "kode": {
      // analysis/validation 细节形状按族定;两档分歧致引擎真值钉不死时
      // load 取本 grounding 档口径,truth/reason 写明冲突与对峙档
      "...": "...",
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

## cell-data-snapshot 族(2026-11-17 第二族)

依据:docs/knowledge/entity-migration-and-cross-process-references.md(fork HEAD
3082ab5)。键宇宙按 Rust `cellDataKeys` 契约形构造(CELL-01 cell 域 def 字段 +
CELL-02 内建封闭表 position/direction);Rust 侧组合面由 cargo cell 测试钉,本族
execution 闸钉消费面(CELL-10 键面 + CELL-12 时序面)在给定宇宙下的行为。
本族探针实测暴露的登记面(均条目 `finding` 注记,取证前不动 kode):

- **两档对账分歧**:本档初始填充只列 position/direction,而
  api-baseapp-entity.md 的 entity.cellData 节写含 `spaceID`——kode 封闭表采
  「不含 spaceID」口径;若 baseapp-entity 档正确则错键面 confirmed=对合法代码
  误报。取证前提=fork baseapp/entity.cpp:299-314 或真机键集实测。
- **镜像风险**:CELL-01 宇宙仅收 cell 域 def 字段;若引擎 cellData 实为全量
  def 字段,BASE-only 键=补全漏建议+错键误报(与 spaceID 例方向相反)。
- **时序面范围界**:CELL-12 只认 onGetCell 明确入口(onLoseCell 等一律沉默),
  本族实证 onLoseCell 读沉默与引擎真值(最后快照可读)同向;扩展需
  onBackupCellData 重装点证据在案。

## cell-data-role-face 族(2026-11-17 第三族)

依据:docs/knowledge/api-cellapp-entity.md(fork HEAD 6d12b8f,grounding base
c2a3b8f)。execution 闸钉角色闸接管矩阵(`cellScriptRoleAndEntity` 五臂探针)。
本族探针实测暴露的登记面(均条目 `finding` 注记,修复归独立批):

- **消费面误导(分歧登记)**:kode 角色闸双接管 `scripts/cell/` 与
  `scripts/base/`(头注自称「cell/base 面可达 cellData」),引擎真值=
  **cellapp 实体没有 cellData 属性**(installCellDataAttr 从不安装)——cell
  角色脚本里的键补全/错键/读型/hover 全部作用于引擎必抛 AttributeError 的
  属性。修复方向=面收窄到 base 角色。
- **签名检查缺口**:cellapp 侧 onWriteToDB 零参触发,`def onWriteToDB(self,
  cellData):` 形参签名在 cellapp TypeError(引擎文档给 `cellData=None`
  双面写法);kode 无回调签名检查面,实体向导生成的正是无默认值签名(base
  段钩子)——分部布局下是否踩陷阱取决于同一类是否跨进程加载,布局语义
  待取证。

## entity-builtin-props-cellapp 族(2026-11-17 第四族)

依据:docs/knowledge/api-cellapp-entity.md(fork HEAD 6d12b8f)§6 Entity
attributes 完整表。execution 闸=单属性条目(名字+读写性)+roster 完备性条目
(面名单逐项等,多出/缺席/改序即红)。**对齐族**:kode cellapp 面 18 项与
引擎 §6 表逐项零分歧(名字+R/W);类型面不属本族钉域(kode 类型来源=修正版
pyi,非本 grounding 档)。钉域边界:本族只证「cellapp 内建属性面」;
baseapp/client 两面各有 grounding 档(api-baseapp-entity.md/api-client.md),
逐族另建不混装。

## entity-builtin-props-baseapp 族(2026-11-17 第五族)

依据:docs/knowledge/api-baseapp-entity.md(fork HEAD 6d12b8f)§1 注册表行
(getset 表 roster 一行钉)+逐属性节。9 属性条目+roster 完备性条目,执行闸与
cellapp 族共用(face 分发)。**对齐族零分歧**:kode baseapp 面 9 项与注册表
行逐项同;cellData 缺席=正确(实例属性非 getset,归 CELL 家族)。client 面
(api-client.md)同法另建。

## entity-builtin-props-client 族(2026-11-17 第六族)

依据:docs/knowledge/api-client.md(fork HEAD 6d12b8f)§4.3 Entity attributes
(getset 表)。10 属性条目+roster 完备性条目+**缺席条目 2 例**(新臂:fork 未
注册脚本 getset 的属性混入面即红),执行闸与其余两族共用(face 分发)。
**对齐族零分歧**(成员+R/W):kode client 面 10 项与 §4.3 表逐项同。序观察=
文档表呈现序与 kode 声明序(entity_macro.h:58-61→entity.cpp:41-46)不同,
roster 按 kode 实测声明序钉,成员无出入不构成分歧。缺席对=isOnGround/inWorld
(CHM 材料列之,fork 无脚本 getset——C++ 成员存在但只内部用):kode 采 fork
口径缺席=同向;fork/CHM 分歧登记,插件层归属待取证(取证路径=diff 官方 SDK
插件实体类),取证后若收编=pyi/面扩充独立批。

## entity-timer-cleanup 族(2026-11-17 第七族)

依据:docs/knowledge/entity-lifecycle-reference.md(fork HEAD c2a3b8f)§Timers
(实体定时器 vs 模块级 KBEngine.addTimer 两回事)。6 例:pinned 4(销毁期
冗余双形态 delTimer(id)/delTimer("All")+合法双场景 onTimer 体/无 onDestroy
文件)+not-analyzed 登记 2(**缺口=漏报方向**:模块级自绑重复定时器强引用
callback 且 Entity::destroy 永不取消,onDestroy 缺 KBEngine.delTimer 清理则
实体泄漏 garbages——kode 全静默;单发 repeat=0 自释放非陷阱)。执行闸=
analyzeTimerCleanupOnDestroy findings 双向钉(冗余报/合法沉默)。本面 TS-only
(Rust 无镜像,parity golden 不涉)。模块 timer 泄漏面修复归独立批。

## script-role-path-matrix 族(2026-11-17 第八族)

依据:docs/knowledge/fixed-directories-and-path-resolution.md(fork HEAD
c2a3b8f)§固定目录三清单+「getPyUserComponentScriptsPath 只认四类」陷阱。
17 例路径矩阵探针(pythonProcessFromPath 逐路径钉,含 null 缺席臂),登记面:

- **引擎真目录 kode 缺席(漏建议/漏报告方向)**:DBMGR/INTERFACES/LOGINAPP
  组件脚本家=scripts/db、scripts/interface(单数)、scripts/login——kode 返
  null 角色不可知,字典域闸/进程 API 面/stub 根全部跳过;修复=别名补映射
  归独立批,须双侧同步(process-api.json Rust 同嵌)。
- **phantom 宽容超集**:scripts/baseapp、cellapp、dbmgr、interfaces、loginapp
  引擎目录表均无此目录,kode 别名给角色=有意设计(头注自称目录角色≠引擎
  组件名);登记=下游据 phantom 角色对引擎不会加载的文件出进程域结论,
  是否收窄=独立批(先核官方 default assets 目录习惯)。
- 同向面:共享目录 common/server_common 不归属、无 scripts 锚定不判、
  反斜杠归一、子目录取父角色。

## entry-script-spi-cellapp 族(2026-11-17 第九族)

依据:docs/knowledge/entry-script-spi-methods.md(fork HEAD c2a3b8f)cellapp
表。4 例:三件套单钩条目(名字+签名对齐,格式串 Iss/IsO、Is、Iis 逐一对得上)
+roster 条目钉 SP-1 收录范围。**范围子集登记(非分歧)**:引擎 cellapp 入口
SPI=9 方法,kode 收 3(空间/导航三件套),6 缺席=头注明示的范围选择;缺席面
里 onCellAppData/onCellAppDataDel 与字典域闸最相关,扩充归独立批。执行门=
KBENGINE_ENTRY_HOOKS roster+签名双钉,范围漂移即红。
