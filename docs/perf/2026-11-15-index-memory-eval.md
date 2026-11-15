# 索引内存占用评测(RUST-129 旧 IDX-012,2026-11-15)

「50k 文件内存爆炸」命题落到数字上,并对 interning / arena / small vectors
三个候选结构给出**实测裁决**。全部 release 实测,本机 14 核。

## 复现

```bash
# 隔离进程逐档跑(报告口径;绝对驻留 after_kb 才是可比数字)
cargo run -p kode-index --release --example bench_memory -- --layer parse --files 50000
cargo run -p kode-index --release --example bench_memory -- --layer full  --files 50000
# 名字去重率(intering 潜力)
cargo run -p kode-index --release --example bench_memory -- --layer ratio
# 或一条命令全扫(升序;仅供快速观察,增量 delta 受分配器驻留页污染,见下)
cargo run -p kode-index --release --example bench_memory
```

语料形态与 bench_increment 同族:每文件 64 属性 + 12 方法(源文本 6.4KB),
属性/方法名全工程共享(贴真实项目 hp/level/onLogin 类重名形态),实体名取
文件 stem 唯一 → 每文件 77 符号。

## 口径

- **RSS 绝对驻留(`after_kb`)是唯一可比数字**:每档在隔离进程跑,`before`
  是干净进程底噪(~2.3MB),`after` 即该形态的真实驻留。同进程升序扫档时
  上一档 drop 后分配器不把页还给 OS,`delta_kb` 因此被污染(实测 parse@25k
  delta 报 16.9KB/文件,而真实值 34.5KB/文件,低估一半)——扫档模式的
  `after_kb` 与隔离跑完全一致,增量 delta 一律不作结论。
- 分层归因:`--layer parse`(仅 ParseRegistry:解析树缓存 + 引用正/反表)
  与 `--layer full`(完整 SymbolIndex)同规模各跑一次,**符号层 = full − parse**。
- 线性检验:5k/10k/25k/50k 四档,每文件字节数应平稳。

## 实测(2026-11-15,隔离进程)

| 文件数 | 符号数 | parse 层驻留 | full 层驻留 | parse KB/文件 | full KB/文件 | 符号层 KB/文件 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5,000 | 385,000 | 174,456 KB | 264,852 KB | 34.9 | 53.0 | 18.1 |
| 10,000 | 770,000 | 346,076 KB | 526,736 KB | 34.6 | 52.7 | 18.1 |
| 25,000 | 1,925,000 | 861,400 KB | 1,330,464 KB | 34.5 | 53.2 | 18.7 |
| 50,000 | 3,850,000 | 1,720,540 KB | 2,670,404 KB | 34.4 | 53.4 | 19.0 |

- **线性成立**:四档 KB/文件抖动 ±1%,无超线性结构。
- **50k 文件形态 = 2.61GB 全量驻留**,即 ~53KB/文件、~693B/符号
  (源文本仅 6.4KB/文件,放大 8.2×)。
- **解析层占 65%**(34.4KB/文件 ≈ 5.4× 源文本):DefFile 胖节点驻留——
  每属性 ~13 个字段(type_refs/flags/flags_raw/default_value/detail_level/
  database_length/identifier/extra_tags…),~10 次独立堆分配,小字符串的
  malloc 头开销是放大主因。缓存条目只存解析树(`ValidEntry { input, value }`),
  文本不驻留,排除「文本驻留」解释。
- **符号层占 35%**(18.6KB/文件 ≈ 242B/符号):Symbol(owned name String +
  DocumentKey uri String + detail)+ slots/by_name/by_file 表结构。

## 三个候选结构的实测裁决

| 候选 | 实测证据 | 裁决 |
| --- | --- | --- |
| 字符串 interning | 名字字节去重率 94.15×(77,000 符号名字节 403,890 → 去重 4,290),50k 文件可省名字堆字节约 20MB | **占总驻留 <1%——不是杠杆**。重名面已被 `by_name` 的单键 + id 集合吸收,残余重复只在 Symbol.name |
| small vectors | FileEntry.symbols 平均 77 元素/文件,远超 smallvec 内联阈值;收益仅覆盖 ≤1-2 符号的文件 | **本形态无空间** |
| arena / 紧凑布局 | 符号表已是 `slots: Vec<Option<Symbol>>` arena + 空槽复用;残余碎片来自 Symbol 内 owned String | **结构性换血收益 < 符号层本身的 35%,且 < 解析层任一优化** |

## 结论与边界

1. **「50k 爆炸」的主犯是解析层驻留(65%,1.68GB),不是符号表结构**——
   intern/arena/smallvec 三个候选合计理论上限 < 5%,单独做任何一项都
   不能把 2.6GB 拉回可用区间。
2. **真杠杆按序指向**:
   - 冷热分层:活跃文件驻留、冷文件驱逐(RUST-125 懒加载/打开文件优先
     warm 的自然消费形态);
   - 解析层落盘持久化 + 冷启动按需载入(RUST-126..128 持久化家族);
   - (次级,属 parser-core 改动,超出本行)PropertyDef 胖节点瘦身:
     合并小字符串字段 / boxed slice,理论上限 ~解析层的 30-50%,按
     ADR-002 基准驱动再评路径另立项。
3. **边界**:RSS 含分配器 slack(含页对齐开销,对结论方向无影响);合成
   语料为 64 属性+12 方法的重形态 def,轻文件项目按比例缩放;ARCH-012
   纪律——只立 Rust 自身基线,不做 Rust↔TS 性能对比结论。

## 历史账

- RUST-102(2026-11-15)已立增量/热更新墙钟基线
  (`docs/perf/2026-11-15-index-increment-bench.md`):热更新 P50 0.4ms
  亚毫秒级。本报告补内存面:两者合看,索引层瓶颈形态是**内存驻留**
  (50k 文件 2.6GB),不是稳态交互时延(亚毫秒)。
