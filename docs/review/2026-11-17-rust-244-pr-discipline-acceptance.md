# RUST-244 验收纪要:每个修复 PR 附复现脚本、测试证据、profile/perf delta、回退计划(真增量:PR 模板四字段+守卫测试)

日期:2026-11-17。本纪要对账 RUST-244(旧 QA-015)的验收口径与交付证据。**结论:QA-015 原侦察「缺失(无 PR 模板)」仍成立(.github/ 只有 workflows/,CONTRIBUTING PR 描述模板无四字段)——本批交付任务书验收口径两件:`.github/PULL_REQUEST_TEMPLATE.md` 四字段模板+守卫测试锁字段齐全,真增量收口。**

## 验收口径 → 交付证据映射

| 任务书要求 | 交付 | 证据 |
| --- | --- | --- |
| `.github/PULL_REQUEST_TEMPLATE.md` 四字段 | 本批新建 | 复现脚本(Bug 修复必须附最小复现,无法构造须说明缺陷面与已排除原因)/测试证据(测试命令+输出摘要,合并前全量门禁绿)/Profile-Perf delta(性能敏感附前后对比,不涉及写「不涉及」)/回退计划(可 revert commit/开关/数据面,「直接 revert <hash>」亦可);GitHub 建 PR 自动载入 |
| 守卫测试(docsCommands 同款)锁字段齐全 | 本批新建 | `tests/pullRequestTemplate.test.ts` 两例:①模板存在+四字段标题逐一 in+非空(>200 字符防清空假绿)②CONTRIBUTING.md PR 描述节四字段一致(防双模板漂移) |
| CONTRIBUTING.md 对账 | 本批同步 | PR 描述节代码块更新为四字段模板全文+指向自动载入与守卫测试 |
| 首个按模板走的 PR 可查 | 过程条款 | 本仓工作流为 main 直推(2026-10-24 用户令:只在 main 开发),PR 频次低;模板+守卫已就绪,首个实际 PR 用时生效,如实记账 |

## prove-red 闭环

模板删「## 回退计划」字段 → 测试红(AssertionError 点名缺失字段)→ cp 备份还原+cmp 字节校验 → 复绿。

## 门禁

lint 0 / compile 0 / unit 10662 passed(+2 新例)/884 文件。

## 诚实条款

- **模板纪律对直推工作流的适配**:本仓以 main 直推为主,PR 模板约束的是外部贡献与偶发 PR;仓内修复纪律的实际口径(todo.md 勾账约定:commit+file:line+测试数+纪要)在勾行体系里已运转,模板四字段是同一纪律的 PR 面投影,两者不冲突。
- **「首个 PR 可查」未发生**:无现存 PR 可指;不冒充已验收。
- 截图字段保留自 CONTRIBUTING 旧模板(UI 改动适用),不属于 QA-015 四字段,如实划界。
