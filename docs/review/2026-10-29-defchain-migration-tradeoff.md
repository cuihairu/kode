# defChain 迁移取舍

- 日期:2026-10-29 · 基线:`fbeba9a`(IDE-RST-006 收口后)
- 来源:todo IDE-RST-007;输入对照 [2026-10-29-r2-index-inventory.md](2026-10-29-r2-index-inventory.md)(§2.2 ChainNode、§4 缺口「接口/组件/缺失文件标记在链出口的表达」)。
- 对象:`src/defChain.ts` buildDefChain(Parent 链递归+interfaces/ 平铺+components/ 挂接+环截断,DefChainNode.defPath 缺文件为 null 不虚构)+ hover 消费面 getDefChainHover(languageProviders.ts:2315,根级 `<Parent>` 元素悬停呈现闭包三面)。
- 锁定:tests/rstDefChainTradeoffDoc.test.ts(章节/四面对照/数字/IPC 判据方向)。

## 1. 语义对拍面(接口/组件/缺失文件/环)

探针实录(合成 tmp 工作区,defs 根判据=同目录 entities.xml;接口取 wrapper 拼写 `<Interface>`,直名子元素引擎不装载,defRenamer.ts:434 同口径):

```
chain10: parentChain=Ent8<-Ent7<-…<-Ent0 interfaces=IFoo components=CompMain cycleTruncated=false
missing: parentChain=Missing2(缺) cycleTruncated=false
cycle:   parentChain=Cyc2<-Cyc1 cycleTruncated=true
```

逐面对照(TS buildDefChain vs Rust `SymbolIndex::entity_chain`):

| 面 | TS(现产) | Rust R2 现状 |
|---|---|---|
| 接口 | 各级 `<Interfaces>` 平铺进闭包,同名去重首见保序;固定解析到 interfaces/;**接口 def 不跟随 Parent**(引擎 loadInterfaces 口径) | 无:ChainNode 无接口面,链不表达 |
| 组件 | `<Components>` 槽 `<Type>` 挂接平铺;**组件 def 的 Parent 在 components/ 内解析**(目录分域) | 无:entity_chain 不含组件(component_types 只是浅层辅助函数) |
| 缺失文件 | defPath=null 如实标记「(def 缺失)」,链行保留该节点后停止 | 无文件存在性语义:parent=None 链止,缺文件与无父同形,不可区分 |
| 环 | visited 文件级截断+cycleTruncated=true 如实标注(引擎 loadParentClass 未见防环,kode 必须截断) | seen 名字级截断+诊断 InheritanceCycle,但 **Span 0,0 无文件位** |

即:对拍对象=hover 呈现的 parentChain(name+缺标记)/interfaces/components/cycleTruncated 四字段逐项相等;Rust 侧当前只有「Parent 名字链+环诊断」半面,其余三面半全缺(r2-index-inventory §4 已列)。

## 2. Parent hover 路径与耗时

- 触发:KBEngineHoverProvider(languageProviders.ts:1160)→ getDefChainHover——根级 `<Parent>` 元素(含取值文本)悬停;同步路径,**无缓存**:每次悬停 parseDefAst(入口 def)+ buildDefChain 全链 fs 读+逐级解析。
- TS 实测(2026-10-29 本机单轮,合成语料,链深 10×50 次):avg **1.929** ms/次(min 1.071/max 4.347)。
- 读法:逐字符触发的交互路径,链深 10 时约 2 ms,无感;成本随链深与 def 体量线性涨,且 hover 重复触发不摊销(无缓存)。深链/大 def 真实工程里可涨,但同型问题在 schema 面(SCH-002)已示范缓存解。

## 3. IPC 成本量测

方法:kode-server(target/debug,经 kodeCoreClient stdio)镜像全链语料(链上每级 def+entities.xml),同 URI 同 version 对 `<Parent>` 取值位发 textDocument/hover ×50 往返。单轮合成语料(PERF-015:跨机器绝对值禁止比较)。

- Rust hover Parent 位(同 URI/version×50):avg **0.564** ms(min 0.407/max 4.048)。
- 对照 RST-006 的通道下界(definition avg 0.550/diagnostic avg 0.339):hover 面往返与此同量级,通道成本稳定在 0.3–0.6 ms。
- **方向判据:与 RST-006 相反,此处 IPC 不构成否决**——TS 交互面实付(1.929 ms,无缓存全链走)高于 Rust 往返下界(0.564 ms),若 Rust 侧有等价语义,含 IPC 的端到端有机会更快;否决理由在 §1 的语义缺口,不在 IPC。

## 4. 采纳/暂缓结论

**暂缓迁移**。依据:

1. 语义缺口三面半(接口/组件/缺失文件标记,环半面缺文件位),Rust 侧需先扩 ChainNode 出口(defPath 缺失标记+接口/组件面+环诊断文件位)才可对拍——工作量是「补模型」不是「搬代码」。
2. TS 侧 1.929 ms 的成本可用缓存治(对照 SCH-002 LRU 模式,以 def 文件版本为键),是比迁移便宜一个量级的等价收益;先迁移等于放着便宜的解不用。
3. 无用户体感痛点报告(链深 10 约 2 ms)。

复评触发条件(任一满足即重开):

- 真实工程深链(30+ 层)或大 def 上 Parent hover 可感卡顿(现场证据,PERF-015 口径);
- R2 补齐链出口表达(接口/组件/缺失标记+环文件位)进入排期;
- 缓存解实施后仍有可感成本(说明缓存键失效率过高)。

若届时采纳,顺序:①ChainNode 出口扩面(defPath/接口/组件/环文件位入 R2 模型+索引) → ②语义对拍 golden(四面字段逐项相等,含 missing/cycle 语料) → ③hover 面经 kode-server 下发(复用现有 hover 通道,IPC 成本已实测 0.564 ms 可承受)。中途对拍不等即停,回到 TS 轨。
