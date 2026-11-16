# RUST-125:非活跃懒加载 / 打开优先 / 初扫优先级(验收纪实)

日期:2026-11-16
任务行(todo.md):`RUST-125 (旧 IDX-008) 非活跃文件懒加载;当前打开文件优先 warm;初扫扫描优先级按资源根/最近文件调整。`

## 结论(三句逐句兑现)

1. **非活跃文件懒加载 = 解析层冷热分层**(RUST-129 实测的「自然消费形态」):
   解析产物驻留预算 CORE-013 底座(`with_parse_budget` 256MB 字节权重口径,
   二次机会近似 LRU)已在生产构造接线;本批补齐**运行观测面**——health
   `parseCache` 键 `{budgetBytes, residentBytes, evictions, valid, negative}`
   恒装配,冷热分层的生产运行状态(驻留多少/逐了多少/预算几何)首次可视。
   预算超限时冷文件解析产物被逐,符号层(by_name/by_file/slots)不动,
   被逐文件下次请求自带文本即重建——驱逐只丢缓存不丢正确性。
2. **当前打开文件优先 warm = 两个兑现面**:
   - TS 镜像顺序:已打开的语料文档**排前镜像**(交互文件首个就绪),其余
     保持发现序;内容优先(未保存修订)既有口径不变。
   - Rust 索引侧:didOpen 打开事件触达解析缓存(`note_buffer_open` →
     `mark_recent`),给一轮驱逐缓刑;编辑面由 didChange→update 自然触达。
3. **初扫扫描优先级**:扫描根序 = `getIndexScanRoots`(workspace 顶层 ∪
   assetsRoot,既有)先行注册 + 打开文档排前(本批);**最近文件(mtime)
   不做**——诚实边界:全量 stat 50k 文件换镜像内部次序收益不成立(Rust 侧
   ingest 是后台队列,交互优先已由「didOpen/didClose 不过风暴窗 + 请求入口
   freshen」兑现),如需冷启动加速走 RUST-126..128 持久化车道。

## 语义口径(诚实边界)

- **缓刑非硬 pin**:打开文件给驱逐缓刑(`mark_recent` 置近期位)而非硬
  豁免——硬 pin 在超预算时形成无界驻留(违背 RUST-129 冷热分层初衷);
  正编辑文件经 didChange 高频重置缓刑天然存活,长置未动的打开文件持续
  超限下最终被逐 = 诚实冷逐出(请求自带文本,重建零正确性损失)。
- **二次机会时钟语义**:清位缓刑条目移至环尾,牺牲者序 = 环序非严格 LRU
  序(测试 `mark_recent_grants_one_round_reprieve` 钉的就是这个真实语义:
  后续超限轮先逐环头,持续超限最终轮到缓刑条目)。
- **预算口径**:256MB = 驻留产物「自有字符串字节」权重;RUST-129 实测
  def 形态 RSS ≈ 权重 ×3(≈768MB RSS 上限,与暖门 PRESSURE_RSS_BUDGET
  同量级)。真实项目(千级 def)远低于预算,驱逐只在超大众语料触发。

## 验收实测

- **parse_cache 单测**:`mark_recent_grants_one_round_reprieve`(缓刑存活 +
  未触达先逐 + 持续超限最终逐出)、`mark_recent_unknown_key_is_noop`。
- **index 转发**:`parse_cache_stats_forward_budget_resident_and_evictions`
  (无界 = budget None/resident 0;有预算 = 透传 + 入库增长;极小预算 =
  插入即逐 + 驱逐计数透传 + 无效键触达零操作)。
- **dispatch 层**:didOpen 后 health `parseCache` 键形状(budgetBytes =
  256MB 常量、valid ≥ 1、residentBytes > 0)。
- **TS 镜像**:`初扫优先级:已打开语料文档排前镜像,其余保持发现序`
  (b 打开,发现序 a,b,c → 镜像序 b,a,c,内容用编辑器修订)。
- **TS 契约**:protocolContract health 顶层键集 + parseCache 子键锁步
  (预算常量、valid ≥ 1、resident > 0、evictions = 0)。
- **prove-red 三靶全红且 cp+cmp 字节还原**:①mark_recent 变异空体 →
  parse_cache 红;②镜像排序回退 keys 原序 → mirror 排序例红;③删 health
  parseCache 块 → protocolContract + dispatch 双红。

## 坑账

1. **测试自污染**:断言「条目存活」用 `get` 会命中置位续缓刑——驱逐行为
   断言必须走纯观测面(新增 `ParseCache::contains`,不置位)。
2. **时钟环牺牲者序**:缓刑条目清位移至环尾,下一轮牺牲者是环头而非该
   条目;「缓刑只一轮即逐」的直觉断言不符合二次机会语义,测试按真实
   语义重钉(持续超限最终逐出)。

## 门禁

- `cargo clippy --workspace --all-targets -- -D warnings`:0
- cargo test(kode-vfs/parser/index/server 四 crate):全绿 0 failed
- `pnpm lint`:0;`tsc --noEmit`:0
- vitest 全量 + xvfb demo:见执行记录

## 执行记录

- vitest 全量:843 文件 passed + 1 skipped,10334 tests passed + 8 skipped,exit 0
  (首轮 1 failed = rstR2IndexInventory census 漂移:新增 note_buffer_activity/
  parse_cache_stats 两 pub fn 未同笔进清单,补齐后复跑全绿——同笔纪律)
- xvfb-run -a npm run test:demo:editor:25 passing,Exit code 0
