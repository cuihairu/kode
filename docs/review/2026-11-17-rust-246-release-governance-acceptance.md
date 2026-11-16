# RUST-246 验收纪要:自动发布遵循手动发布规则(release governance 守卫锁,真增量)

日期:2026-11-17。本纪要对账 RUST-246(旧 QA-017)的验收口径与交付证据。**结论:QA-017 原侦察「自动发布须遵循手动规则,防重构顺手改 governance」的治理现状本身已符合(版本号只由人手动给出:tag/手动触发;自动面只跟随),缺的是防回归守卫——本批交付守卫测试 `tests/releaseGovernance.test.ts` 五锁+CONTRIBUTING「发布规则」节(规则首次文档化),真增量收口。**

## 治理现状盘点(守卫锁定的靶面,全部实证)

| 通道 | 触发面 | 发布动作 | 闸 |
| --- | --- | --- | --- |
| 正式 GitHub Release | ci.yml:on.tags 仅 `v*`;步骤条件 `refs/tags/v*`(push 或 dispatch-on-tag) | gh CLI 建 release+附 VSIX(`gh release create` 非空 tag 名,不写死版本) | tag 即人工授权(版本号只能由维护者手动给出);Marketplace 两条绕闸腿已于 2026-10-24 拆除(ci.yml 注释记账) |
| Marketplace | publish.yml:仅 `workflow_dispatch` | `vsce publish`(唯一出现文件) | publisher 校验(`p.publisher!=="cuihairu"`)+版本一致性(`v!==p.version` exit 1)+`if: inputs.publish`(默认 false 只验证) |
| npm | npm.yml:仅 `workflow_dispatch` | `npm publish`(唯一出现文件) | 版本一致性(`v!==p.version`)+`if: inputs.publish`;setup-node registry-url 写 .npmrc(裸 NODE_AUTH_TOKEN 是 no-op,npm 11.19 实证注释) |
| nightly | nightly.yml:schedule(03:17 UTC 离峰)+dispatch | gh CLI 滚动 release,tag 恒 `nightly` 字面量+恒 `--prerelease` | 48h stagnation gate(无新提交跳过);不带版本号;不发 Marketplace |
| 其余 | docs.yml(push docs 路径,Pages)/engine-integration.yml(dispatch+周巡,无发布)/platform-vsix.yml(workflow_call 被动) | — | 非版本发布面 |

## 验收口径 → 交付证据映射

| 任务书要求 | 交付 | 证据 |
| --- | --- | --- |
| 自动发布遵循现有仓库的手动发布规则 | 治理现状盘点(上表)+规则首次文档化 | CONTRIBUTING.md 新「发布规则」节(正式 Release 跟随 tag/Marketplace+npm dispatch 版本闸/nightly 滚动 prerelease) |
| 避免重构顺手改变 release governance | `tests/releaseGovernance.test.ts` 五锁 | ①无 workflow 用 `release:` 事件触发(防 release:created 自动发布回归,历史坑 ci.yml :185 记账)②`vsce publish`/`npm publish` 命令只允许出现在各自 dispatch-only workflow(命令通道唯一)③publish/npm 触发面仅 workflow_dispatch+版本一致性闸+publisher 闸+`if: inputs.publish` 在位④nightly 恒 `--prerelease`+tag 恒 `nightly`+不得建版本号 release+48h 门在位⑤ci 正式 Release 只跟随 `refs/tags/v*`+on.tags 仅 `v*` 通配+不得分支驱动 |

## prove-red 闭环(五锁全证)

python 变异五处→跑测五锁全红→cp 备份还原+cmp 字节校验→复绿 5/5:
- 锁1:ci.yml on 块插 `release: types: [created]` → `ci.yml 不得用 release 事件触发发布` 红;
- 锁2:docs.yml 追加 `# vsce publish` 注释行 → `vsce publish 漂移进 docs.yml` 红(注释提及也锁,防漂移起点);
- 锁3:npm.yml `v!==p.version`→`v==p.version` → `npm.yml 缺版本一致性校验` 红;
- 锁4:nightly `--prerelease`→`--draft`(两处全替)+`create nightly`→`create nightlyRoll` → `nightly 发布必须标 --prerelease` 红;
- 锁5:ci `refs/tags/v`→`refs/tags/w`(条件两处全替)→ `ci release 步骤须以 refs/tags/v* 为条件` 红。

## 门禁

lint 0 / compile 0 / unit 全量绿(本批新文件入全量跑)。

## 诚实条款

- **守卫锁的是静态面**:workflow 文件的触发块/命令出现位置/闸行存在性,不执行 workflow;真正运行面的验证(如 nightly 实跑)由 schedule 触发的 nightly 构建自身承担。
- **首跑伪象记账**:守卫首次全量跑时锁2 报「vsce publish 漂移进 ci.yml」,当时点未复现且现时点 grep/node/vitest 三方一致为 false;同轮锁1/3/4 各有一处断言 API 用错(`match` 无命中返回 null 而误断言 undefined)与缩进判错(tags 列表项 6 空格写成 4),修正后 5/5 稳定绿——伪象不再深挖,如实记录。
- **「不重做已完成部分」**:治理现状(拆 release:created 自动 Marketplace、publish 版本闸等)是既有收口(2026-10-24 复核),本批只补守卫与文档,不重演历史。
- **顺手还了一笔 244 遗留债(如实记账)**:244 feat(07c7ed88)曾提交 CONTRIBUTING 四字段全文+勾选框修正,随后 244 docs(01f0b3d2)以 stale tree 误删,当时恢复 commit(ea759e9b)只恢复了模板与测试文件、漏了 CONTRIBUTING——净检出自那以后 `tests/pullRequestTemplate.test.ts` 例 2(CONTRIBUTING 含四字段)应红。本批提交收编工作树完整版(=07c7ed88 修正+本批发布节,`diff` 核验无并发会话污染),一笔还原:feat commit 54552336e 消息即「add governance guard, restore pr fields」。
