# BigWorld API 遗留 stub：处置决策记录（KB-API-009）

> 状态：**决策记录**（2026-11-04）。源料：
> `../kbengine/docs/api/bigworld/{index,base,bigworld-module,bwpersonality,entity}.md`
> ——五篇骨架 stub（各 1.2k–1.7k），是 `kbengine_api(cn).chm` 转换的遗留物。本记录
> 决定其处置并给出佐证。本记录**不是** API 参考，不含任何已整合 API 条目。

## 1. 决策：明确不整合

五篇 `bigworld/` stub **不**整合进任何 KBEngine API 文章。它们仅以源料索引注记的形式
（即现状）留在 KBEngine fork 的 `docs/api/bigworld/`。理由是**范围**，而非源不可得：

1. **它们记载的是另一款引擎。** 这些 stub 是 **BigWorld-Engine-14.4.1**（商业上游）的
   API，不是 KBEngine。kode 知识库以 KBEngine 源码为grounding（`kbe/src`，commit
   `kbengine@c2a3b8f`，见 `docs/knowledge/README.md`），而 KBEngine API 参考才是实际
   交付物——已由 KB-API-001..008 建成。
2. **没有任何 kode 消费方以 BigWorld 为目标。** kode 是 KBEngine 扩展；其
   hover / completion / diagnostics / 知识消费都作用于 KBEngine 工程。BigWorld API
   参考没有消费方。
3. **提取量大且冗余。** 按 stub 自身「Next steps」，整合 = 从 `/*~` 源注释提取 + 逐项与
   KBEngine 对拍。实测范围见 §3（服务端 ~532 个 `/*~` 块：249 function + 175 attribute
   + 47 callback + 22 class + 8 module）。每项都要逐项 grounding，且 stub 自身告诫勿把
   KBEngine 组件名与语义直接搬过去。
4. **submodule 未检出。** BigWorld 源码在 fork 的 `BigWorld-Engine-14.4.1` git
   submodule 里，fork 工作树中**未初始化**（空目录）。读源需先初始化 submodule 或另克隆
   （§2）。
5. **验收禁止。** KB-API-009 自身验收规定：stub 内容不得当作已验证 API 整合进任何文章；
   这些 stub 无签名无语义，只有源位置 + 已知 API 组。

## 2. 佐证：源实际所在

stub 所指的源**不在** fork 已检出树里，而是一个 git submodule：

- `../kbengine/.gitmodules`：
  `[submodule "BigWorld-Engine-14.4.1"] url = git@github.com:cuihairu/BigWorld-Engine-14.4.1.git`
- `git ls-tree HEAD BigWorld-Engine-14.4.1` → 模式 `160000`（gitlink），commit
  `3d3cc16ae60bb1d71cb014e9b0539e54e6d8c4fb`。
- 工作树：`BigWorld-Engine-14.4.1/` **为空**（submodule 未初始化）→ 该 `/*~` 面
  不存在于 fork 已检出状态。

BigWorld 源码**可访问**（submodule 仓库可达；已浅取固定 commit `3d3cc16` 验证），
所以「不可得」不是决策理由——**范围**才是（§1）。

## 3. 佐证：固定 commit 上 `/*~` 注释面存在

已浅取固定 commit `3d3cc16`（`Update README.md`）并 grep 检出树：

| 查询 | 结果 |
|---|---|
| `programming/bigworld/server` 存在 | 是 |
| `server/baseapp/base.hpp` 存在 | 是 —— `/*~ class BigWorld.Base` 在 **base.hpp:38** |
| `server/baseapp/base.cpp` `/*~` 块 | **33** |
| 11 个 stub 所指源文件全存在 | 是（base.hpp、base.cpp、bigworld.mpp、script_bigworld.cpp、bwpersonality.mpp、cellapp/entity.cpp、real_entity.cpp、witness.cpp、cellapp.cpp、lib/server/app_script_timers.cpp、lib/server/bwpersonality.mpp） |
| `programming/bigworld/server` —— 含 `/*~` 文件 | **57** 个 |
| `programming/bigworld/server` —— `/*~` 块 | **532** |
| … 分解 | 249 function · 175 attribute · 47 callback · 22 class · 8 module · 31 empty |
| `programming/`（整树）—— `/*~` 块 | **2734**（409 文件） |

结论：stub 所指的 `/*~` 面**存在**（服务端约 532 项），但是 BigWorld 的面，整合它是
一条独立、非 KBEngine 的知识泳道。

## 4. 理由（三选一评估）

| 选项 | 成本 | 收益 | 判定 |
|---|---|---|---|
| **整合** | 提取+grounding ~532 服务端项（249 fn / 175 attr / 47 cb / 22 class / 8 module）；逐项 BigWorld↔KBEngine 对拍；先初始化 submodule/克隆 | 一份**无 kode 消费方**的 BigWorld API 参考；与已完成的 KBEngine 参考平行冗余 | **否**——超 KB-API 范围、无消费方、冗余 |
| **只留状态说明** | 写本记录 | stub 仍作为源料索引可被发现 | 保留（本记录即状态说明） |
| **明确不整合** | 写明边界 | 防未来误派工；KBEngine 参考保持唯一 API 源 | **采纳** |

## 5. 范围边界（防未来误派工）

- `bigworld/` stub 是 **BigWorld-Engine-14.4.1** 源提取注记，**不是** KBEngine。
  不要并入任何 KBEngine API 文章（KB-API-001..008）或 KBEngine 知识库。
- KBEngine API 参考已由 KB-API-001..008 完成；bigworld 不含任何 KBEngine 内容。
- 若将来确需 BigWorld API 支持（超出 kode 当前范围），它是**独立 BigWorld 知识泳道**，
  不是 KB-API 任务，且需：初始化/克隆 `BigWorld-Engine-14.4.1` submodule → 从 `/*~`
  注释提取 → 以 BigWorld 源码 `file:line` 逐项 grounding → 逐项 BigWorld↔KBEngine 对拍
  （stub 的 `docs/study/23-bigworld-and-kbengine-comparison.md` 参考即对照图）。
- 本记录不含任何已验证 API 声明；只引源位置与 grep 计数，不引行为。

## 6. 验收对照（KB-API-009）

- [x] 决策带佐证：固定 commit `3d3cc16` 上 `/*~` 面已验证（grep 计数 + `base.hpp:38`，
  见 §3）；submodule 未检出状态已验证（§2）。
- [x] 三选一建议带理由：§1（采纳 `明确不整合`）+ §4 表。
- [x] stub 内容**未**当作已验证 API 整合：无任何 KBEngine 文章出现 stub 的 API 条目；
  本记录是决策，非参考。
- [x] 范围边界已写明：§5。
