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

## rpc-entitycall-links 族(2026-11-17 第十族)

依据:docs/knowledge/api-core-concepts.md(fork HEAD 6d12b8f)§1.1 EntityCall。6 例,执行门=buildRpcLinks 三臂分组(连线臂=两段装配逐标量钉,发送 async-send/语法锚 vs 执行 sync/rpc/declaration-contract;未解析臂=def 未声明闸+实现缺席+unknown-receiver,原因码/证据串钉+「有发送无连线」断言;缺席臂=face-invalid/广播发送不得入链接面),发送边经 resolveFlowCallSites 真解析。**对齐族**:kode def 声明闸与引擎「EntityCall 只能调用 .def 声明的方法」同向——def 未声明时python 同名实现也不连线=引擎不派发的镜像。登记面:①实现缺席条目 kind=positive(def 已声明=引擎会派发,kode 报告的是脚本侧缺陷而非引擎拒绝);②广播边不入 def 契约面=FLOW-008 设计决策,引擎侧依据=EntityCall 最小形「实体 ID+目的地址」无固定接收位;③继承实现(inheritedFrom 证据标注)属宿主回调语义,不属本族钉域。

## data-dictionary-domain 族(2026-11-17 第十一族)

依据:docs/knowledge/api-core-concepts.md(fork HEAD 6d12b8f)§1.4 数据字典表。10 例:字典域臂 4(globalData=null 全进程不收窄/cellAppData=[cell]/baseAppData=[base]/spaceData=null)+进程域臂 6(域内真/域外假/角色不可知与无 scripts 锚定=诚实不判)。执行门=dataDictProcessDomain+dataDictSiteInDomain 双函数直钉。**对齐族**:三字典域化与 §1.4 表逐项同向;登记面=spaceData 条目 kind=unknown(表的模块属性面未列,kode 未建模域化——无害但未建模,取证=cellapp/KBEngine.md 属性节,补域归独立批)。C++ 锚(baseapp.cpp:461/cellapp.cpp:200/entity_app.h:419)在 kode 源头注,本族evidence 采知识档表行。

## process-module-surface 族(2026-11-17 第十二族)

依据:docs/knowledge/api-core-concepts.md(fork HEAD 6d12b8f)§1.7 共享工具面+§2 app 差异。7 例:base/cell 共享清单臂(21 名逐名在场,缺一即红)+单符号臂 3(base address 在场/component 双面在场)+**divergence 条目 1**(引擎 cellapp 无 address,kode cell 表含=面宽于引擎,补全/stub 会对 cell 脚本给运行期不存在的名字;钉 kode 现状,修复 process-api.json 双侧落地后翻钉)+bots subset 缺席清单臂 1(kind=unknown:档言 subset 未枚举成员,kode 缺席名单相容,逐项归属待取证)。**语料方法学第三次实战命中**:parity 全绿下抓出 process-api 实分歧,方向=误导面(补全给出 AttributeError 名字),与 def-flags 四分歧/cell 角色收窄同账本。执行门=processApiSymbols 名单谓词三臂(单符号/在场清单/缺席清单)。

## fixed-dict-sync-trap 族(2026-11-17 第十三族)

依据:docs/knowledge/api-core-concepts.md(fork HEAD 6d12b8f)§1.5 property sync 节(档内含 fixeddict.cpp:272-308 C++ 锚)。7 例:子键陷阱臂 4(下标/点号/深嵌套/增强下标四形态 findings 逐字段钉)+沉默臂 3(整体重赋=唯一正确姿势/注释与字符串同形文本/非 FD 属性普通 dict)。执行门=analyzeFixedDictMutations findings 双向钉。登记面:①深嵌套 key 实测=全段拼接(stats.hp)而模块头注言「key 取首段」=头注陈旧(行为与引擎同向,注释修正归独立批);②FD 构造点闸(KSEM-STRUCT-04 缺键/多键)是另一模块另一面,grounding 走 types.xml 类型图,不在本族钉域,候选另立族。

## builtin-prop-role-misuse 族(2026-11-17 第十四族)

依据:docs/knowledge/api-core-concepts.md(fork HEAD 6d12b8f)§1.5 四数据类+§2.1 身份/控制/可见性三连(档称 classic misread)。7 例:错面臂 4(baseapp 访问 position·isWitnessed/cellapp 访问 databaseID/client 访问 isWitnessed,findings 逐字段钉含 registeredFaces 引证)+沉默臂 3(正确面/isPlayer 方法身份与自定义属性/def 多面歧义不猜)。执行门=findRoleMisuseFindings 四参直钉(生产面表=props 三族同源)。**对齐族**:错用方向与 §2.1 三连分工逐项同向;isPlayer 全面沉默=它是方法身份非 getset,kode 内建属性表不收=同向。登记面:registeredFaces 含 client(position 双面注册)——面表口径=fork getset 表,与 props 族 roster 一致。

## entity-event-pubsub 族(2026-11-18 第十五族)

依据:docs/knowledge/api-core-concepts.md(fork HEAD 6d12b8f)§1.2 事件面四侧三连(registerEvent/fireEvent/deregisterEvent,per-process pub/sub 非 EntityCall)。8 例,执行门=findEventCalls 直钉(逐标量含 offset+fireEvent 缺席独立臂)。**对齐面**:registerEvent/deregisterEvent 两名识别同向,点号事件名取末段、裸引用不调用静默、裸变量回调诚实沉默(只认点名字段/字符串字面量)。**语料方法学第四次实战命中,双分歧同族**:①kode 识别表五名不含引擎真实发送名 fireEvent=发送侧调用点全静默漏检,发送/订阅镜链永不闭合(fireEvent 缺席臂钉现状,补名归独立批);②超集误纳 addEvent/emitEvent/removeEvent 三旧资产名——引擎 Entity 面无此三方法,运行期 AttributeError,kode 照常标注(收窄须双侧同步,归独立批)。登记边界:findEventCalls 无字符串/注释掩码(maskPythonNonCode 既有掩码件未被事件面消费),docstring 同形文本命中=假阳性面,掩码收编归独立批。

## entity-readonly-write-cellapp 族(2026-11-18 第十六族)

依据:docs/knowledge/api-cellapp-entity.md(fork HEAD 6d12b8f)§6 完整属性表 R/W 列。10 例:负臂 4(id 赋值/className 增强赋值/isDestroyed 注解赋值/spaceID del——四写入形态各一,findings 六字段钉)+正臂 6(position R/W 写与分量续写沉默/isDestroyed 读比较沉默/customHp 表外沉默/pathFace null 诚实沉默/docstring 掩码沉默)+非实体脸沉默独立臂(四负臂同文本 null 脸全沉默)。执行门=findReadOnlyWriteFindings 三参直钉(生产面表=内建属性三族同源底座)。**对齐族零分歧**:R 列四属性写侧全部报、R/W 与表外全沉默,与 §6 表逐项同向;写入形态检测走 pythonLexicalMask 掩码文本=与事件面无掩码假阳性(第十五族登记)构成对照。baseapp/client 脸各归己档逐族另建。

## entity-readonly-write-baseapp 族(2026-11-18 第十七族)

依据:docs/knowledge/api-baseapp-entity.md(fork HEAD 6d12b8f)逐属性节头 `*(read-only …)*`/`*(get/set)*` 记法。8 例:负臂 4(databaseID 赋值/databaseInterfaceName 增强赋值/cell del/id 注解赋值)+正臂 4(shouldAutoBackup get/set 写沉默/client 判空比较沉默/customGold 表外沉默/docstring 掩码沉默)+非实体脸沉默独立臂(负臂同文本 null 脸全沉默)。执行门=与 cellapp 族共用三族同构闸(findReadOnlyWriteFindings 直钉)。**对齐族零分歧**:baseapp 面 9 项的 R/W 口径(family-5 语料已钉表)与逐属性节头记法逐项同向,get/set 与 R 分明。

## entity-readonly-write-client 族(2026-11-18 第十八族)

依据:docs/knowledge/api-client.md(fork HEAD 6d12b8f)§4.3 getset 表(read-only/get-set Type 列)。8 例:负臂 4(spaceID 赋值/className 增强赋值/base del/isDestroyed 注解赋值)+正臂 4(position 客户端写喂 updatePlayerToServer 沉默/velocity get/set 写沉默/base 判空比较沉默/docstring 掩码沉默)+非实体脸沉默独立臂。执行门=三族同构闸共用。**对齐族零分歧**:client 面 getset 表 R/W 口径(family-6 语料已钉表)与 §4.3 Type 列逐项同向;position 客户端侧写=引擎明示合法路径(同步机制 clientobjectbase.cpp:1193-1275),与 server 面 position 写路径分立。

## entry-script-spi-roster 族(2026-11-18 第十九族)

依据:docs/knowledge/entry-script-spi-methods.md(fork HEAD c2a3b8f)六组件表+可选四件节。9 例=roster 臂 8(baseapp 12/cellapp 9/loginapp 7/dbmgr 4/interfaces 5/logger 4/bots 2/client 3,名册+可选旗双钉,缺一多一即红)+可选四件臂 1(onAutoLoadEntityCreate/onLogWrote/onReadyForLogin/onReadyForShutDown)。执行门=ENGINE_SPI_METHODS 直钉(SRC-002 恢复件,九族 roster 只钉 SP-1 三件,本族把标注镜全 36 方法面钉进语料护栏)。**对齐族零分歧**:八组件名册+可选旗逐名同向;bots 名册正确剔除 onTargetChanged(档内明示 client only)=档内细分同向;与第九族的 SP-1 范围子集登记互补——标注镜面(本族)与入口钩子 roster 面(family-9)两脸各自钉死。

## rpc-arg-count 族(2026-11-18 第二十族)

依据:docs/knowledge/api-core-concepts.md(fork HEAD 6d12b8f)§1.1 EntityCall(打包前按 .def 描述校验+def-only 派发+三角色只读属性面不存在时 None)。15 例,执行门=computeRpcArgCountFindings 直钉(同步面;async Rust-first 面 parity 归 Rust 车道 cargo 测试)。条目 methods 薄切片经 loader 构 EntityMapping 快照(identity 薄桩)。臂形:mismatch 三报(cell 1v2/零参声明 1v0/跨行 3v2,含尾随逗号不多计)+沉默十臂(数量一致/星号实参/星号形参/段错配归 sectionMismatch/多来源歧义/字符串逗号词法态/声明未就绪/face 滤除(baseapp 面 self.base AttributeError 引用)/括号不闭合/注释掩码)。**对齐族零分歧**:十三臂与档口径逐项同向;登记面=undeclared-method 条目 kind=unknown(映射快照缺席≠def 未声明,真反例臂需全量映射 fixture)。注释掩码臂与第十五族事件面无掩码假阳性构成对照——同一掩码件(maskPythonNonCode)两消费面一有一无。第二十七增量(2026-11-18)=undeclared 真反例解封,全量映射双臂:input 携 def 原文,映射由 EntityMappingManager 实扫 mkdtemp 工作区产出(definitionSemantics→collectMethodDefinitions 生产线,不经手喂薄切片)——控制臂 mismatch-full-mapping(真映射下 1v2 照报,证 fixture 活)+真反例臂 undeclared-full-mapping(def 真未声明方法零警告,与薄快照边界臂双臂合围=rpcArgCount 诊断从不主张 def 成员完备性,漏报向分歧只在 finding 登记不冒充修复;修复候选=未声明 EntityCall 方法诊断面,归独立立项)。

## writetodb-hook-signature 族(2026-11-18 第二十一族)

依据:docs/knowledge/api-cellapp-entity.md(HEAD 96c42f70)writeToDB 节(cellapp 零参 entity.cpp:1238→backupCellData :1239/base 侧 cellData 快照/兼容签名建议)。3 例,执行门=向导 hooks 签名面探针(getHookByName/KBENGINE_HOOKS 实测):①pinned 正例=onWriteToDB 向导签名双侧兼容不变量(signature 含 `(self, ` 与 `=None`——cellapp 零参存活+baseapp 位置传参存活);②pinned 正例+finding 登记=documentation 双侧描述与档同向(baseapp 附参/cellapp 无参),**分歧登记面=向导 signature/example 参数名 dbContext 与档内 baseapp 实参语义(cellData 快照,cellDataDict_)不符——误导性命名,兼容性不变非炸点,修复候选=模板参数名改 cellData 归独立批,不冒充修复**;③unknown=cellapp writeToDB(shouldAutoLoad, dbInterfaceName)(entity_macro.h:18)默认值缺口(C++ 真源未检出无档内 grounding),闸=全 hooks 零主张探针(self.writeToDB() 零参调用仅现于 baseapp 面钩子 onClientDeath 示例,现状零误导)。本族为「签名族」首例:向导模板面(静态数据)进语料护栏,与 hooks.test.ts 锚点面(引擎树位移校准)两脸互补。

## user-type-contract 族(2026-11-18 第二十二族)

依据:docs/knowledge/user-type-impl-contract.md(**新收割知识档**,fork HEAD 55a66552;datatype.cpp setImplModule 装载硬闸 2383-2397+组件范围闸 2174-2179+loadImplModule 两段式 2328-2340+序列化方向 impl_createObjFromDict/impl_getDictFromObj,与 fork study 档 §5.6 交叉校对)。7 例,执行门=user_type 三契约面探针(implFileHasContractMethod/collectUserTypeContractMissing/collectUserTypeContractMissingByImplFile 直钉):①roster 臂=三契约方法名册+声明序;②缺一臂=缺 isSameType 报一条,后果文案与序列化契约同向,ByImplFile 聚合贴行;③缺二臂=两缺口各一条,声明序;④齐备臂=零诊断沉默;⑤文件缺席面分工臂=implFile 缺席时缺方法面静默(「未找到 python 文件」兜底另报);⑥**赋值/lambda 形态臂=语料方法学第五次实战命中**:引擎 GetAttrString 只查属性存在性无 def 约束(赋值/lambda 绑定 callable 合法装载)而 kode 扫描面只认 `def <name>(` 形态=对合法代码报满 3 条缺方法=**误报方向分歧登记**,扫描面收编归独立批不冒充修复;⑦unknown=组件范围闸(引擎侧已钉三组件装载,kode 收集半 definitionWorkspace 宿主绑定纯函数探针不可达,诚实缺口;**2026-11-18 同日解封**:「宿主绑定不可达」判定过重——collectUserTypeContractStatuses 只吃 workspaceRoot 路径纯 fs I/O,fixture 直调先例(definitionWorkspaceBranches.test.ts 模式)即达;臂改 pinned=跨组件统一收集对齐非分歧,非三组件诊断范围语义=消费侧未建模诚实登记)。本族为「余族解封」第二例:fork docs/study §5.6+datatype.cpp 直取收割新知识档落地,GEN-DEF-1e 诊断面进语料护栏。

## entity-script-base-class 族(2026-11-18 第二十三族)

依据:docs/knowledge/entity-script-base-class.md(**新收割知识档**,fork HEAD 55a66552;entitydef.cpp 两条硬闸=类名闸 GetAttrString(pyModule,moduleName)「Could not find EntityClass」+基类闸 isSubClass(pyClass)「not derived from KBEngine.[{}]」;isSubClass 语义=名册任一子类过/MRO 间接亦过/空名册空转;组件名册=cellapp Entity+EntityComponent/baseapp Entity+Proxy+EntityComponent/dbmgr 局部空表直传=空转,与 fork study 档「必须继承自当前进程允许的 KBEngine 脚本基类」交叉校对)。5 例,执行门=实体脚本基类面探针(parsePythonFile 类名/bases+linearizeC3 MRO 直钉):①类名闸臂=parse 见类名+一致性检查面缺席(**漏报方向缺口登记**);②合法基类臂=bases 表达式如实捕获(pinned);③无基类臂=engine 对名册全假拒载而 kode 零诊断(**漏报方向缺口登记**,依赖图 inheritance 边是结构建模非验证面);④间接基类臂=parse 直取基类+linearizeC3 全链(含 resolver miss 终端节点)实测钉;⑤unknown=组件名册在 kode 组件角色面的映射(引擎名册分立已钉,kode 无验证面故无映射可探,诚实缺口)。本族为「余族解封」第三例:**登记型家族首例**——kode 分析底座在(parse/MRO)而验证面缺席,双缺口(类名一致性/基类合法性)收编归独立批。

## fixed-dict-construction-site 族(2026-11-18 第二十四族)

依据:docs/knowledge/fixed-dict-construction-site.md(**新收割知识档**,fork HEAD 55a66552;entity_macro.h:779 onScriptSetAttribute 属性赋值总闸 isSameType→ValueError 响+datatype.cpp:2497 FixedDictType::isSameType 裸 dict 逐键验证三道响闸=键数不符 2528/键缺失 2546/键值类型不符 2555+impl 契约先行 2509 不短路+fixeddict.cpp:295 下标路径已知键类型不符静默 drop——**构造点响/已知键下标静默的不对称**;与 fixed-dict-sync-trap 族/family-13 档互补不重叠,子键陷阱面归彼档)。5 例,执行门=FD 构造点面探针(**真面=analyzeFixedDictConstructWrites 直钉**,KSEM-STRUCT-04 构造面/kbengine.fixedDictConstruct):缺键/多键/键值类型不符三负臂=engine 运行期响闸 ↔ kode 编辑期 kind=missing/extra/type **逐面对齐**(对齐登记;多键臂消息粒度差异=引擎整字面量 collective 一条 TypeError vs kode 逐涉事键,裁决同向非分歧)+齐备臂沉默对齐(整赋值推荐姿势)+下标不对称对照臂双面钉=构造面不接管下标(0)+mutation 面旗子键(1)(已知键类型不符 engine 静默 drop,family-13 行为对照重钉)。**翻案纠正(2026-11-18 同日)**:本族初版执行门误探 analyzeFixedDictMutations(mutation 面,只旗子键赋值)误判构造点零覆盖=「漏报方向缺口登记」;经真面探针实测,三负臂全部翻案为 pinned 对齐——**判例=语料探针必须先盘点同域全部在役面(STRUCT-02 mutation/STRUCT-04 construct 双面)再选钉**,探错面=假缺口登记。本族为「余族解封」第四例:FD 构造点(KSEM-STRUCT-04 已收口面)语料对账落地,槽位=知识档 §4 静态分析含义节(构造错误全运行期响错误;kode 编辑期三 kind 覆盖)。

## fixed-dict-decorator-binding 族(2026-11-18 第二十五族)

依据:docs/knowledge/fixed-dict-decorator-binding.md(**新收割知识档**,fork HEAD 55a66552;entitydef.cpp:2461 installModule("EntityDef")+PY_DEF_HOOK 两段调用机制=绑定判定在装饰器表达式求值时刻执行;py_entitydef.cpp:1178-1197 fixed_dict 分支=**三属性存在性闸**(PyObject_HasAttrString,与 types.xml 路径 GetAttrString 同源存在性,无 def 形态约束)绑定 implementedBy=pyFunc+__qualname__ 取名;**条件不成立无 else 分支=静默不绑**(与 types.xml 路径装载失败响构成**响/沉默第二对不对称**);处理链后段三道响闸=self 参数闸 :1295-1302(排除表仅 rename/fixed_array)/模块域一段闸 :1240-1249(isModuleScope=true else 臂)/未知 optionName 闸 :1211-1214;CPython 求值序推论=装饰器后置属性附加必然三连 false 静默降级)。5 例,执行门=FD 装饰器路径探针(parsePythonFile 类面+implFileHasContractMethod 文本面):后置属性附加负臂(reject-silent,静默不绑缺口登记)+两段调用正臂(accept,存在性绑定;**kode def 形态约束=误报镜像登记,family-22 装饰器侧**)+self 参数闸负臂+嵌套两段负臂+未知 optionName 负臂(三响闸全漏报缺口登记)。**登记型家族第二例**(同 family-23:kode 分析底座缺席,parsePythonFile 只收类、模块级函数装饰器零面)。本族为「余族解封」第五例:family-23 登记的「第二契约强制点 @Def.fixed_dict 装饰器 py_entitydef.cpp:1184」落地;DefContext 消费链(assemblyContexts→DataType 注册)明示不在档。执行序边界注记:fork 内无真实装饰器用法样本(stubs 生成器走 types.xml 路径),求值序推论依据=CPython 装饰器语义公理+PY_DEF_HOOK 代码结构,fork 源码逐行钉。

## proxy-session-semantics 族(2026-11-18 第二十六族)

依据:docs/knowledge/proxy-session-semantics.md(**新收割知识档**,fork HEAD 55a66552;proxy.cpp pyDisconnect 只 condemn 通道不销毁实体+onChannelDeregister→onClientDeath 四行会话解绑体(Py_DECREF clientEntityCall/addr NONE/clientEnabled_ false/CALL_ENTITY_AND_COMPONENTS_METHOD)+loginBaseapp 三返回值现状矩阵=**LOG_ON_WAIT_FOR_DESTROY 与 default 同支(:4020-4021)实际同拒绝,仅 LOG_ON_ACCEPT 有独立分支**+onEntityGetCell 链=客户端可访问 Cell 阶段+giveClientTo 所有权链整迁(五前置校验失败触发 onGiveClientToFailure,非网络失败)+stream* 后台任务分片;与 fork study 档 proxy-client-session-api.md 交叉校对,方法名册面归 api-baseapp-entity.md 两档互补)。6 例,执行门=Proxy 会话面探针(lookupApiDoc base 域+computeReceiverNoneFindingsAsync 实测+parsePythonFile 方法表):悬停名册覆盖正臂(十成员全 hit,文档面名册完备对齐)+**onLogOnAttempt 分歧臂=语料方法学第六次实战命中**(kode hover 文案声称 WAIT_FOR_DESTROY=独立排队流程引用 :3960,而 fork 源码同支=同拒绝且 switch 实际在 3973 起——**文案行号+语义双漂移,登记不冒充修复**,文案随引擎真值再生归独立批)+onClientDeath 对齐臂(receiverNone 消息含 onClientDeath/onLoseCell→S_RELEASE 语义+entity.cpp:800 源码引用,与会话解绑真值同义)+disconnect 对齐臂(condemn 通道文案同向,实体销毁零误述)+onClientGetCell 对齐臂(阶段语义文案同向+parse 方法表可见)+onGiveClientToFailure 文档稀薄臂(not-analyzed:回调条目 summary 仅行号零语义,giveClientTo 本体条目已详尽含五前置——稀薄面限回调条目自身,文案充实归独立批)。本族为「余族解封」第六例:fork docs proxy-client-session-api.md 九层收割;onLogOnAttempt 返回值矩阵与 giveClientTo 前置校验边界=脚本高频误用面,静态检查面收编归独立批。

## entity-lifecycle-hook-roster 族(2026-11-20 第二十七族)

依据:docs/knowledge/entity-lifecycle-reference.md(fork HEAD **3082ab5**,档内自证「Line numbers below … verified at `kbengine@3082ab5`」;Cell state table 逐行钉脚本回调列+Timers 节 onTimer 缓冲回调+RestoreEntityHandler 回放 onRestore+「引擎无 isOnCell/isOnDB/isPersisted 谓词」与基座属性面七项清单)。11 例,执行门=**KBEngine_HOOKS/getHookByName 直钉**(36 条名册的解析面=存在性/分类/签名/引擎调用点四标量;探针实测后写值,drift 即红)。臂形:正例 5(onDestroy/onTimer/onRestore/onGetCell/onCreateCellFailure 逐标量钉,含签名默认值形态 `userArg=None` 与双调用点 sourceLocation)+名册臂 1(lifecycle 分类名单逐项=三条,改名/改分类/新收录即红)+负例 4(isOnCell/isOnDB/isPersisted=引擎明示无谓词族,onRestoreCell=档内 restoring 态只派生 onRestore、restoreCell 系引擎内部 C++ 入口不派生脚本回调)+unknown 1(onRestore 引擎实参集合档内未取证——签名已解析但按未核钉,下一步读 restore_entity_handler.cpp:173/266 调用点格式串)。**分工注记**:`onLoseCell` 不进本族——它已被 HOOK-TIMING-001 以「corroborated-but-unregistered」形态登记在 hooks.ts 收录缺口 + hook-sequencing.ts 补录面,本族不重复登记同一缺口;谓词族三例补的是「KSEM-CELL-11 判据只有 entity.cell」的**名册面**护栏(kode 从不把这些假谓词当引擎回调提示)。本族为 QA-001 语料扩族第 27 例:钩子名册解析面首入语料护栏(此前 roster 族皆钉 SPI/内建属性/时序面,签名+调用点双面钉首次)。

## baseapp-module-face 族(2026-11-20 第二十八族)

依据:docs/knowledge/api-baseapp.md(**KB-API-003 part 1/2,新收割知识档**,fork HEAD **6d12b8f**,grounding base c2a3b8f;档 §1 五登记点表=baseapp.cpp:430-451 app-specific 22 方法 + entity_app.h:423-453 共享 11 方法与 LOG_TYPE_*/NEXT_ONLY/SERVER_ERR_* 常量族 + pywatcher.cpp:184-185 双名 + script.cpp:248,258(component/genUUID64)+ pyurl.cpp:23 urlopen,模块对象 entities/globalData/baseAppData 与 LOG_ON_*/APP_FLAGS_* 常量表外装)+§6 MemoryStream **待取证**(EntityApp 链 entity_app.h:407-453 无注册,仅 PythonApp 工具 python_app.cpp:271 有)+§8 入口回调表 onFini 0 hits + 偏差表 onDelBaseAppData 源码文本假名)。8 例,执行门=**processApiSymbols('base') 直钉 + ENGINE_SPI_METHODS 名册面**(102 符号表的存在性+kind 双标量;探针实测后写值,drift 即红)。臂形:正例 3(site1 二十二法名逐名=function 行/共享四登记点名册 15 方法 function + 13 属性常量 variable 按 role 钉/time 单符号 kind=function 在场)+**分歧登记 2**:①漏报方向=引擎按 app-flags 表迭代注册 APP_FLAGS_NONE/APP_FLAGS_NOT_PARTCIPATING_LOAD_BALANCING(baseapp.cpp:419-424,值 common.h:348-352)而 kode base 符号表缺席(setAppFlags 位掩码常量零补全零类型)②误导方向=引擎 baseapp(EntityApp)链无 MemoryStream 注册而 kode 表有 class 行(补全/类型会给运行期 AttributeError 的名字;档自身把运行期结论标为待取证,运行期实测归独立批)+负例 3(onFini=fork HEAD 无此钩子 grep 0 hits 仅 client_lib/bots 认 onFinish/onDelBaseAppData=源码文本假名、引擎真名 onBaseAppDataDel 在场且 components 含 baseapp/MemoryStream 归负例臂钉现状)+unknown 1(SERVER_ERR_* 数值集档内只给家族名,kode 表带逐值系 typings stub 非本档钉域,下一步读 fork 6d12b8f common.h 错误码枚举)。**判例①=凭记忆写锚点必红**:evidence 逐字 containment 四次撞墙(pywatcher 路径是整串单反引号非末段/pywatcher 与 baseapp.cpp:461 前各带整路径/onFini 句被 markdown 加粗包裹/偏差表行以大写 `The` 起首)——先落 containment 校验再写语料,锚点以 Read 所见原文为准。**判例②=分歧方向须与引擎真值对齐**:漏报方向(引擎有/kode 无)=kind=positive+load=accept+finding;误导方向(引擎无/kode 有)=kind=negative+load=reject-silent+finding;两向皆只钉现状不冒充修复。**判例③=模块面与类面分档不混装**(同第七/八族 cellapp-client 分脸):本族只钉 KBEngine 模块面,Entity/Proxy 类面归 api-baseapp-entity.md 彼档。门禁=定向 73/73(67+6)/prove-red 六咬(名册/单符号/漏报/误导/负例/未知各红一次,sha256 b4e3845a 字节还原复绿)/tsc -p ./ 0/lint 0/tsc-mocha 0/mocha 12 passing(首跑 1 failed=与全量 950 worker 并发争抢,复跑 12 绿)/全量 11403 passed|8skip|7 failed 4 文件=基线红集零新增;语料 28 族 240 条。余族=MemoryStream 运行期实测(baseapp 入口脚本跑 `KBEngine.MemoryStream()`)+SERVER_ERR_* 数值集取证,两项均归独立批。

## loginapp-dbmgr-logger-face 族(2026-11-21 第二十九族)

依据:docs/knowledge/api-loginapp-dbmgr-logger.md(**KB-API-006**,fork HEAD **6d12b8f**,grounding base c2a3b8f,档内 2026-11-04 自证;§1 装配表=python_app.cpp:230-349 共享层九函数+LOG_TYPE_*/NEXT_ONLY+addTimer/delTimer+描述符四件+MemoryStream(:271)+script.cpp:248/258/286 component/genUUID64/urlopen;§2-§4 三面 24 名录;偏差表 D1 ffO 回调必需/D2 SERVER_ERR_* loginapp·dbmgr 有 logger 无/D4 delTimer TypeError/D6 onLogWrote 返回语义/D8 urlopen 三面同形)。9 例,执行门=**processApiSymbols 三面直钉 + ENGINE_SPI_METHODS 名册面**(loginapp 67/dbmgr 68/logger 28 符号表存在性+kind+签名三标量;探针实测后写值,drift 即红)。臂形:正例 5(§1 共享面 24 名三面逐名钉 kind+urlopen 回调五参元组入签名/D2 SERVER_ERR 38 表名 loginapp+dbmgr 逐值钉=SERVER_SUCCESS 0..SERVER_ERR_ACCOUNT_LOGIN_ANOTHER_SERVER 37,fork server_errors.h:57+ 表序实读核值,直接收割第二十八族 unknown 的「下一步」/dbmgr executeRawDatabaseCommand 独占钉+签名默认接口 'default'/loginapp SPI 六回调 required:true/components 含 loginapp/dbmgr+logger SPI 名册钉+onReadyForShutDown components 精确=['baseapp','dbmgr','logger'] required:false+onLogWrote required:false/D1 三面 addTimer/delTimer 精确签名钉——kode 签名无 callbackObj 默认值,与 fork ffO 必需口径一致)+**分歧登记 2(皆误导方向)**:①SERVER_ERR_MAX=引擎从不登记的模块面名字(登记循环 for i<SERVER_ERR_MAX 只走 SERVER_ERR_STR[0..37],MAX 系 #define 循环界非表项,fork 实读)而 kode loginapp/dbmgr 带 `SERVER_ERR_MAX: int = 38` 行②Vector2/3/4+FixedArray=引擎 KBEngine 面皆无(Vector 三名由 script.cpp:291 math::installModule(\"Math\") 装进顶层 Math 模块,FixedArray 全树仅 GC/pickle 内部引用)而 kode 三面各带四条 class 行;两向只钉现状,收窄(typings 双侧+Rust 同嵌)归独立批+负例 1(D2 logger 面:SERVER_*/SERVER_SUCCESS 全缺席,kode logger 表同步缺席=对齐钉,loginapp 表全集反查 logger 零命中)。**判例=fork 树在场则档内张力须源码仲裁**:§1 正文称「SERVER_ERR_* registered only by EntityApp::installPyModules」与偏差表 D2「loginapp/dbmgr 各自有登记循环」互斥——fork 实读 loginapp.cpp:195-206/dbmgr.cpp:343-352 两循环在场、logger 零命中,D2 胜,语料按 D2 钉;Vector/FixedArray 跨族观察=kode 七面(base/cell/client/bots/interfaces/loginapp/dbmgr/logger 之全部探及面)同形,本族只钉三工具面,其余五面归各族各自核。门禁=定向/prove-red/tsc/lint/mocha/全量对基线(数字以提交时实测为准);语料 29 族 249 条。余族=Math 模块面(档 §1 未覆盖,kode 亦无此面,双双缺席非分歧)+entry scripts 缺席致回调运行期不可实测(档 §1 末自证,留部署侧)。
