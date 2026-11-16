# RUST-243 验收纪要:生成覆盖率达到门槛前不得标「所有 Python 文件类型完整生成」(轻真增量:文案审计钉)

日期:2026-11-17。本纪要对账 RUST-243(旧 QA-014)的验收口径与交付证据。**结论:任务书验收三件套中,覆盖率量测口径既有在案(typePreview resolved/total,RUST-223 收口,不造轮子)、宣称面当前零越界(复证);真缺口=「不得标」纪律无可执行钉——本批补文案审计测试(QA-014 验收口径逐字实现),轻真增量收口。**

## 验收三件套 → 交付证据映射

| 任务书要求 | 形态 | 证据 |
| --- | --- | --- |
| 覆盖率量测(`measure-pyi-coverage.mjs`) | **既有口径引用,不另造轮子**(2026-11-11 全局令:凡有既有机制禁自造轮子) | typePreview typing 覆盖叶子 resolved/total 已解析占比+anyCount 缺失映射候选+plan.skipped 计数(RUST-223 对账:数据现算不缓存,`typePreviewModel.ts` 可编程消费);生成物有效性另有 pyrightStubGate 落盘 pyright 校验(IDE-STUB-002) |
| 门槛值+宣称纪律 | **纪律落账**:宣称必须同句带覆盖率数字;门槛数值待首个宣称出现时按 typePreview resolved/total 口径定标(当前零宣称,门槛不触发=不虚构数字) | 本批测试放行规则 `/\d+(?:\.\d+)?\s*%/` 同句数字;RUST-157 产品 spec 同源纪律「禁止 Any 占位充当整属性/整方法/整文件已完成」 |
| 文案审计测试 | **本批新钉**(真缺口) | `tests/generationClaimAudit.test.ts`:扫描 README.md+CHANGELOG.md+docs 全域 .md(豁免引用性档案 kode2/review/knowledge 官方镜像/acceptance-evidence——它们不是项目宣称面),出现「所有 Python 文件类型完整生成」必须同句带覆盖率数字 |

## 宣称面现状(复证)

`grep '所有 Python 文件类型完整生成'` 全仓仅命中任务书自身(todo.md:519 任务行+docs/kode2/qa-execution-plan.md QA-014 定义)——README/docs/CHANGELOG/src 零越界(与 qa-execution-plan.md:176 原侦察一致,2026-11-17 复证)。

## prove-red 三态闭环

1. 基线绿(零宣称,宣称面收集 620+ 文件);
2. 探针 `docs/zz-r243-probe.md` 无数字宣称 → 红(`expected [ Array(1) ] to deeply equal []`,断言消息指引纪律);
3. 探针改带覆盖率数字 → 放行绿(规则语义=带量测证据的宣称合法);
4. 探针删除 `git status` 复证无痕+基线复绿。

## 诚实条款

- **门槛数值未虚构**:QA-014 原文「覆盖率达到门槛前不得标」——当前宣称面零出现,无消费面;放行规则钉的是「宣称必须自带量测数字」,门槛数值留待首个宣称按 typePreview resolved/total 定标,纪要如实记账。
- **英文宣称变体未钉**:QA-014 字面口径=中文短语 grep;README 英文面若出现同义英文宣称(如 "fully generated for all Python files")不在钉面——无既有英文样本,发明宽匹配有误伤风险,如实划界;docs/zh 全域在扫。
- **豁免单边界**:docs/review(验收纪要)与 docs/kode2(任务书档案)豁免=它们引用短语是任务定义/对账非宣称;若未来这两处之外出现宣称,测试红。
- 量测脚本不另造:`measure-pyi-coverage.mjs` 原提案与 typePreview resolved/total 口径重叠,按「禁自造轮子」令引用既有面。
