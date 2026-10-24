# Parser 级 Rust↔TS 对照基准(ARCH-012「无数据不声称快」前置数据)

- 日期:2026-10-23 · 分支 `v0.2` · 被测 commit `14a0fae`(产品代码零改动,只新增 bench 驱动与语料生成器)
- 环境:同 [docs/perf/hardware.md](hardware.md)(Intel i9-10880H,14 vCPU,45 GiB RAM,Linux 7.0.0-38-generic,Node v24.21.0,rustc 1.99.0);同机同日、同一批语料、两侧均为 release / 纯进程口径
- 被测对象:

| 侧 | 解析入口 | 驱动 |
|---|---|---|
| Rust | `kode_parser::model::{parse_def, parse_entities, parse_types, parse_alias}` | [crates/kode-parser/examples/head2head.rs](https://github.com/cuihairu/kode/blob/main/crates/kode-parser/examples/head2head.rs) |
| TS | `src/defParser.parseDefDocument` + `src/compositionRoots.{parseEntityNames, parseTypesXml}` | [scripts/parser-head2head-ts.mjs](../../scripts/parser-head2head-ts.mjs)(esbuild 打包为 CJS,`node --expose-gc` 纯进程,不含 vitest / fake-vscode 桩开销) |

- 原始输出:[2026-parser-head2head-run.txt](2026-parser-head2head-run.txt)(两侧 × 三档语料 × 两轮的完整 harness 输出)
- 采样:**6 次进程级运行**(2 轮 × 3 档语料),每轮内部再取 18/27 个中位轮与 5 次增量重复;每轮带 `SURFACE` 语义面与零重建断言作金丝雀(§1)

## 0. 结论速览

1. **解析吞吐/延迟:Rust 全档领先,幅度 6.7×–11.9×。** 全量口径(两侧对齐到 parse+extract)中位轮 **20.0 / 37.0 / 19.1 MB/s** 对 TS **1.67 / 3.35 / 2.85 MB/s**;单文件 P50 **6 / 7 / 211 µs** 对 **105 / 78 / 947 µs**。优势在小文件集最大,在 1.6 MB 巨型 def 上收窄。
2. **增量二扫:Rust 46×–88× 领先,但 TS 的瓶颈不是解析,是内容指纹。** TS `contentFingerprint`(BigInt FNV-1a 逐字节)跑 10 MB 需 ~1.07 s(`fp_only`),占其零重建二扫成本的 99%;Rust 同式指纹 16.6 ms。**TS 侧若照搬「解析器级增量注册表」而不换指纹实现,「零重建」也省不下时间。**
3. **内存:Rust 峰值 2.9 / 6.8 / 124 MiB,TS 70.8 / 229.6 / 1,154 MiB(9.3×–33.8×)。** TS 在 10 MB 语料上峰值 1.13 GB,主要是 V8 对短命 AST 对象的堆保留(不等于存活集),但在用户机器上就是真实 RSS 峰值。
4. **与 PR-005 基线交叉校验一致**(28 文件 P50 同为 6 µs;2001 文件 526 ms vs 502 ms,+4.7%),方法可信。**门 1 的端到端指标(hover/completion P95)不由此推断。**

## 1. 口径

三口径 + 内存,两侧同式实现(只用各自公开 API,不往产品代码里加计时钩子):

| 口径 | 定义 | 采样 |
|---|---|---|
| ① 全量 | 语料逐文件解析一遍为一轮 | 20 轮,前 2 轮预热,**中位轮**计吞吐,同时给 min/max |
| ② 单文件 | 逐文件单独计时,样本 = 文件数 × 轮数 | 30 轮,前 3 轮预热(n = 756 / 36,504 / 54,027),给 P50/P95/P99/max |
| ③ 增量 | 同内容扫两遍:首扫全 rebuild、二扫零重建 | 5 次重复(每次新注册表)取中位;`fp_only` 只算内容指纹、不解析 |
| ④ 内存 | 进程 `VmHWM`(`/proc/self/status`) | 每侧每档一次进程,与 `/usr/bin/time -v` 的 Max RSS 交叉核对 |

**金丝雀校验(防止「少干活所以快」)**:每次运行输出 `SURFACE props/methods`,两侧同一语料必须同值(29/23、1,208/7,225、148,000/0);增量口径在进程内 `assert` 首扫 `rebuilds == 文件数`、二扫 `rebuilds == 0` 且 `cache_hits == 文件数`。任一条不成立,该次运行直接失败,而不是产出一个更好看的数。

TS 侧两处口径差异(表内单列,不与 Rust 混算):

- `.def` 分 `parse-only`(仅 `parseDefDocument`)与 `parse+extract`(+ 与 Rust `parse_def` 同级的 properties/methods/parent/行号提取)两个面,**与 Rust 对齐的是 parse+extract**。
- `alias.xml` 无 TS 专用入口,用 `parseDefDocument` 顶替(Rust 用 `parse_alias`);该文件占语料 <1%,不影响量级。

## 2. 语料(三档,同机生成/校验)

| 档 | 来源 | 文件数 | 字节 | 说明 |
|---|---|---|---|---|
| T1 真实 fixtures | `tests/fixtures/{kbengine-demo-assets,parity-project,electron-ws,kbengine-tpl-scripts}` | 28 | 9,270 | 手写 KBEngine 样例:29 属性 / 23 方法、含 interfaces 与父子实体;单文件 14 B–1.9 KB |
| T2 资产集 parser 面 | `scripts/generate-perf-assets.mjs` 的 30,005 文件资产集,取 `*.def` + `entities/types/alias.xml` | 1,352 | 417,448 | def-heavy 1,200 份、big-py 巨型 def、multi-root 三根同名实体 |
| T3 合成大样本 | `scripts/gen-parser-h2h-corpus.mjs`(与 PR-005 同形) | 2,001 | 10,538,731 | 2,000 × 64 属性 + 1 × 20,000 属性「巨型 def」 |

**T2 唯一化说明(重要)**:资产集里 def-heavy 的 1,200 份 `.def` 逐字节相同(284 B)。TS `parseDefDocument` 以**全文文本**为键缓存 8 份文档(`src/defParser.ts:69`),这批文件会让 TS 端 1,203 次「解析」退化为缓存命中——按原样测,TS 全量 8.5 ms 反而快过 Rust 10.1 ms,但那是缓存不是解析(§5.1)。因此对照用的 T2 是给每份 `.def`/`alias.xml` 追加一行唯一头注释的派生副本(`--unique-copy`,+19 B/文件,`SURFACE` 与 Rust 完全一致),两侧对同一份派生语料计时。T3 生成器同理每文件带唯一头注释。

## 3. 对照表(两轮进程级运行的均值;两轮原始值见 §3.5)

时间单位:ms(全量/增量)、µs(单文件);吞吐为十进制 MB/s(= 字节/1e6/秒)。

### 3.1 ① 全量(逐文件整册,中位轮)

| 档 | 侧 | 面 | 中位 ms | 吞吐 MB/s | 相对 |
|---|---|---|---|---|---|
| T1 (28 文件) | Rust | parse | **0.448** | **20.02** | 1× |
| T1 | TS | parse-only | 5.026 | 1.77 | 11.2× |
| T1 | TS | parse+extract | 5.317 | 1.67 | **11.9×** |
| T2 (1,352) | Rust | parse | **10.803** | **36.95** | 1× |
| T2 | TS | parse-only | 113.267 | 3.51 | 10.5× |
| T2 | TS | parse+extract | 118.720 | 3.35 | **11.0×** |
| T3 (2,001) | Rust | parse | **525.584** | **19.14** | 1× |
| T3 | TS | parse-only | 3,323.215 | 3.02 | 6.3× |
| T3 | TS | parse+extract | 3,529.788 | 2.85 | **6.7×** |

### 3.2 ② 单文件(逐文件分布,parse+extract 对 Rust parse)

| 档 | 侧 | n | P50 µs | P95 µs | P99 µs | max µs |
|---|---|---|---|---|---|---|
| T1 | Rust | 756 | **6** | **58** | **83** | **149** |
| T1 | TS | 756 | 105.3 | 546.2 | 777.2 | 1,143 |
| T2 | Rust | 36,504 | **7** | **13** | **29** | **115** |
| T2 | TS | 36,504 | 78.0 | 162.1 | 232.2 | 5,360 |
| T3 | Rust | 54,027 | **211** | **301** | **384** | **120,284** |
| T3 | TS | 54,027 | 946.8 | 1,539.1 | 4,891.6 | 1,405,551 |

倍差:Rust 快 **17.6× / 11.2× / 4.5×**(P50,T1/T2/T3),P95 **9.4× / 12.5× / 5.1×**,P99 **9.4× / 8.0× / 12.7×**。

**大文件极值(T3 的 20,000 属性 `MEGA.def`)**:Rust **82.6 / 83.1 ms**,TS **1,127 / 1,288 ms**(单文件 14.6×)。按属性摊:Rust 4.1 µs/属性,TS 60.4 µs/属性;而 TS 在 64 属性小文件上只要 14.8 µs/属性——**TS 单属性成本随文件增大涨 4.1×,有明确超线性劣化**;Rust 3.3 → 4.1 µs/属性,基本线性。T3 的 P99 4.9 ms 与 max 1.41 s 之间那三个数量级,就是这一份文件拉出来的。

### 3.3 ③ 增量(同内容两扫 × 5 重复,中位)

| 档 | 侧 | 首扫 ms(全 rebuild) | 二扫 ms(零重建) | 其中纯指纹 ms | 二扫是否 0 rebuild |
|---|---|---|---|---|---|
| T1 (28) | Rust | **0.514** | **0.018** | 0.015 | 是(28/28 hit) |
| T1 | TS | 5.385 | 1.623 | 1.633 | 是(28/28) |
| T2 (1,352) | Rust | **14.002** | **0.907** | 0.689 | 是(1,352/1,352) |
| T2 | TS | 128.114 | 41.584 | 45.665 | 是(1,352/1,352) |
| T3 (2,001) | Rust | **638.900** | **16.450** | 16.611 | 是(2,001/2,001) |
| T3 | TS | 4,507.199 | 1,076.050 | 1,067.841 | 是(2,001/2,001) |

倍差:首扫 Rust 快 **10.5× / 9.1× / 7.1×**;零重建二扫 Rust 快 **88× / 46× / 65×**。

拆解:TS 的二扫 ≈ 纯指纹成本(1,076 vs 1,068 ms,重合在噪声内),解析与 Map 查表可忽略;Rust 的二扫(16.5 ms)同样由指纹主导(16.6 ms)。**这条口径真正的差距是「指纹实现」,不是「增量架构」**——两侧的零重建语义都成立。

### 3.4 ④ 内存峰值(VmHWM,同进程口径)

| 档 | 侧 | VmHWM MiB | 相对 | `/usr/bin/time -v` Max RSS MiB |
|---|---|---|---|---|
| — | node 空进程基线 | 42.5 | — | — |
| T1 | Rust | **2.9** | 1× | — |
| T1 | TS | 70.8 | **24.4×** | 70.5 |
| T2 | Rust | **6.8** | 1× | — |
| T2 | TS | 229.6 | **33.8×** | 230.0 |
| T3 | Rust | **124.1** | 1× | 124.1 |
| T3 | TS | 1,154.2 | **9.3×** | 1,154.2 |

读法:TS 的 MiB 里 42.5 MiB 是 node 运行时地板;扣地板后的「产品面」差距是 28.3 vs 2.9 MiB(T1)、187.1 vs 6.8 MiB(T2)、1,111.7 vs 124.1 MiB(T3)。T3 的 TS 峰值 = **117× 输入字节**,Rust 12×。

### 3.5 轮间漂移(6 次运行,同机同日)

| 档 | 指标 | run1 | run2 | 漂移 |
|---|---|---|---|---|
| T1 | Rust 全量中位 | 0.395 ms | 0.500 ms | ±11.7% |
| T1 | TS 全量中位(pe) | 5.013 ms | 5.621 ms | ±5.7% |
| T2 | Rust 全量中位 | 11.369 ms | 10.237 ms | ±5.3% |
| T2 | TS 全量中位(pe) | 120.061 ms | 117.379 ms | ±1.1% |
| T3 | Rust 全量中位 | 509.220 ms | 541.948 ms | ±3.1% |
| T3 | TS 全量中位(pe) | 3,555.682 ms | 3,503.895 ms | ±0.7% |
| T3 | TS 单文件 P50 | 918.0 µs | 975.5 µs | ±3.1% |
| T3 | TS 峰值内存 | 1,145,336 KiB | 1,218,468 KiB | ±3.1% |

T1 的 Rust 绝对值只有 0.4 ms,机械盘 + 调度噪声占主导(±12%),**故 T1 的 0.45 ms 只作量级参考,不宜作回归阈值**;T2/T3 的漂移 ≤5%,与 hardware.md §2 第 1 条(「判定回归必须多轮取中位」)一致。

## 4. 结论

1. **parser 层面数据支持「Rust 更快」,且不是靠少干活**:三档语料 × 四口径,`SURFACE` 语义面同值、增量零重建断言全部通过。全量吞吐 6.7×–11.9×,单文件 P50 4.5×–17.6×。
2. **优势随文件变大而收窄**:小文件集 11.9× → 真实资产集 11.0× → 10 MB 合成样本 6.7×;TS 在大文件上超线性(每属性 14.8 → 60.4 µs),Rust 线性(3.3 → 4.1 µs)。真实仓库以中小 def 为主,**10× 量级是更贴近现实的预期**。
3. **增量口径的瓶颈在 TS 指纹,不在解析器**:TS 零重建二扫 1.08 s/10 MB 里 99% 是指纹;要在 TS 侧保留增量能力,先换 `contentFingerprint`(BigInt 逐字节 → 32 位双通道/分块),否则这条优化没有意义。Rust 侧同式指纹 16.6 ms/10 MB,够用。
4. **内存是比速度更大的差距**:峰值 9.3×–33.8×(扣 node 地板后 9.7×–27.5×),TS 在 10 MB 语料上冲到 1.13 GB。这条比「快几倍」更能解释 30k 资产集上的卡顿体感,建议纳入门 1 验收指标(hardware.md §2 第 3 条把「进程 RSS 峰值」列为从未记录,本文补上 parser 级数据)。
5. **不外推**:本文只测 parser 单层,不含 transport、extension host、索引调度、磁盘 IO;门 1 的 hover/completion P95 与「切 rust 后是否更快」必须按 pr-012 §5 的端到端口径另测。本文给 ARCH-012 提供的是「parser 这层快多少、代价是什么」的实测底数。

## 5. 如实记录的发现(含对结论的修正)

### 5.1 TS 侧按全文文本的 8 条文档缓存会伪装成「解析很快」

`src/defParser.ts:69` 用**整段文件文本**做 Map key(上限 8)。未唯一化的资产集里 1,208 份 `.def` 只有 5 种不同内容(1,200 份完全同内容),1,203 次命中缓存:TS 全量 **8.536 ms vs Rust 10.099 ms**,看起来 TS 反超 18%;`SINGLE P50` 掉到 0.2 µs 也是同一原因(命中路径不做解析)。本报告因此全部改用唯一化语料。这一条同时是**产品风险**:该缓存强引用最多 8 份完整 AST(巨型 def 单份就上百 MB),也是 §3.4 里 T3 峰值的来源之一。

### 5.2 TS `parse+extract` 只比 `parse-only` 贵 7%–9%,Rust 无 parse-only 面

T1 5.317/5.026、T2 118.720/113.267、T3 3,529.8/3,323.2 ms。即 TS 的成本几乎全在 `parseDefDocument` 建树(fast-xml-parser 解析 + 自己再 tokenize 一遍 + 归一化节点),提取面很便宜。Rust `parse_def` 解析与提取一趟出,没有「只解析」档——**这对 Rust 略有不利(<10%),不改变量级结论**。

### 5.3 与 PR-005 基线的对账

| 指标 | PR-005 记录 | 本次(两轮) | 差异 |
|---|---|---|---|
| T1 P50 / P95 | 6 µs / 50 µs | 6 / 6 µs,58 / 51 µs | P50 同,P95 +9% |
| T3 全量 | 502 ms / 19.9 MB/s | 509.2 / 541.9 ms,19.7 / 18.6 MB/s | +1.4% / +8.0% |
| T3 P50 | 196 µs | 211 / 212 µs | +7.7% |

PR-005 的 19.9 MB/s 可复现(本轮 18.6–19.7 MB/s,同机同日 4%–8% 漂移);P50 6 µs 完全一致。

### 5.4 MEGA.def 不能代表典型负载

它占 T3 全量耗时的 **15.8%(Rust)/ 34.2%(TS)**。剔除后倍差从 6.7× 收窄到 **5.2×**(Rust 442.7 ms vs TS 2,321.9 ms)——也就是说 6.7× 这个数里,MEGA 这份文件贡献了差距的约 1.5×。保留它是为了与 PR-005 语料同形;读 T3 时应同时看 5.2×。

## 6. 未覆盖

1. `entities.xml` / `types.xml` 未单独分列(混在「全量」里,占比 <2%);alias 的 TS 侧是代用入口(§1)。
2. 深继承链、循环别名、非 ASCII 路径、损坏/半截 XML:语料未覆盖,属 PERF-004 待建项。
3. 冷盘(页缓存已清)未分离;本文全部为热缓存口径(与 hardware.md §1 一致)。
4. TS 侧在纯 node 进程测,不含 extension host 事件循环与结构化克隆开销;Rust 侧不含跨进程 IPC。
5. 每格 2 次进程级运行;hardware.md §2 第 1 条要求的「多轮取中位 + 置信区间」中,置信区间未算(n=2 不足以给区间)。跨机器绝对值禁止比较(PERF-015)。

## 7. 复现

```bash
# 1) 语料(确定性:同参数任意机器同字节数)
node scripts/gen-parser-h2h-corpus.mjs --out /tmp/kode-h2h/synth
node scripts/generate-perf-assets.mjs --out /tmp/kode-h2h/assets30k --large-files 30000
node scripts/gen-parser-h2h-corpus.mjs --unique-copy /tmp/kode-h2h/assets30k --out /tmp/kode-h2h/assets30k-uniq

# 2) Rust 侧
cargo build -p kode-parser --release --example head2head
./target/release/examples/head2head /tmp/kode-h2h/synth
./target/release/examples/head2head /tmp/kode-h2h/assets30k-uniq
./target/release/examples/head2head tests/fixtures/{kbengine-demo-assets,parity-project,electron-ws,kbengine-tpl-scripts}

# 3) TS 侧(打包成纯 CJS,避免 tsx/vitest 转译开销进计时)
pnpm exec esbuild scripts/parser-head2head-ts.mjs --bundle --platform=node --format=cjs \
  --outfile=/tmp/kode-h2h-ts.cjs
/usr/bin/time -v node --expose-gc /tmp/kode-h2h-ts.cjs /tmp/kode-h2h/synth
```

T3 的 TS 侧单次约 6 分钟(20 轮全量 + 30 轮单文件,含 MEGA.def × 50 次),Rust 侧约 30 秒。
