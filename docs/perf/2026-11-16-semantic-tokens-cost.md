# SemanticTokens 决策核成本评测(RUST-144 批 3)

日期:2026-11-16。todo 行:RUST-144 批 3(SemanticTokens 新面+增量 token 成本评测)。测量对象:纯函数层 `buildSemanticTokenSpans`(span 提取)+ `encodeSemanticTokens`(LSP 相对编码),TS 生产实现(`src/backend/semanticTokens.ts`,编译产物 `out/backend/semanticTokens.js`,Node 24 直跑驱动,5 轮取中位)。

## 场景与结果

合成语料形态:`@base.exposed` 装饰器 + 类 + `async def method(self, a: int, b = 1, *rest)` 方法(带注解/默认值/星形参,三 token/方法+装饰器+类)。

| 场景 | 行数 | span 数 | build 中位 | encode 全量中位 | encode 100-span 窗口中位 |
|---|---|---|---|---|---|
| entity-typical(5 类×15 方法) | 240 | 310 | 1.9ms | 0.13ms | 0.04ms |
| small-1k(50 类×10 方法) | 1,650 | 2,100 | 9.3ms | 0.31ms | 0.02ms |
| medium-10k(500 类×20 方法) | 31,500 | 41,000 | 222ms | 6.1ms | 0.01ms |
| large-30k(1500 类×20 方法) | 94,500 | 123,000 | 794ms | 15.6ms | 0.02ms |

大文件档第二轮实测 build 2,220ms / encode 48.7ms(同机负载敏感,两轮包络如实记录;既往 perf 基线亦有同族抖动在案)。

## 读法

1. **典型实体文件(~200 行)build ~2ms、encode ~0.1ms**——单次全量在交互预算内;
2. build 随规模超线性(31.5k→94.5k 行=3x,耗时 3.6-10x 包络):三遍扫描(code_lines/statements/parse_python_file)叠加语句合并的串拼接;**万行级病理文件全量 build 进入数百 ms~2s 档**,不可在每次编辑裸跑;
3. encode 是纯 O(n) 数值变换,全量 12 万 span ~16-49ms;可视区窗口(增量 range 代理)恒 <0.05ms——**增量面的成本大头在 span 提取,不在编码**。

## 对装配面(批 4)的结论

- provider 全量 `provideDocumentSemanticTokens` 必须按文档版本缓存 span(编辑失效重算),与 KODE-PERF-001 versionKey 缓存同纪律;典型文件首算 ~2ms 无感;
- range provider 走「已缓存 span 按行窗切片+重编码」,窗口编码 <0.05ms;
- 病理大文件(>30k 行)首算百 ms 档的兜底策略(预算闸/降级)留批 4 装配时按 RUST-147(无 KBEngine 工作区不劣化)一并裁度,本批不预设。

## 复现

```bash
npm run compile
node /tmp 下的驱动(评测时一次性脚本,未入库:合成语料生成+hrtime 计时+中位统计,核心断言面即上表)
```

驱动形态:合成 5/50/500/1500 类场景 → 预热 1 轮 → build/encode/窗口 encode 各 5 轮取中位,JSON 落盘。
