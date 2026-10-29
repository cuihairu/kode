# IDE-ACC-008 服务成本归因对照(启用/禁用,同机同项目)

日期:2026-10-29。原始数:`2026-10-29-acc008-service-attribution-run.txt`(本文件同目录,
# enabled / # disabled 两块由 `--attribution` 双跑各写一面、同文件合并,复跑请
`KODE_ACC8_OUT` 重定向防覆盖)。方法:`npm run compile && tsc -p tsconfig.mocha.json` 后
`node out/test/electron/runTest.js --attribution` 双跑——enabled=Kode+Pylance 联合场;
disabled=`KODE_FIELD_MODE=disabled`(devPath 指空目录,Kode 完全不加载)的 Pylance-only
场。同一工作区装配(与 `--field` 共用:demo 资产 + 5000 文件外部根),同一台机、同一天,
VS Code 1.141.0 harness,Pylance 2026.4.1,Kode 0.2.0。两面跑同一组请求:def 面 hover
(TrainingAvatar.def `<reqAttack>`,20 连发)与 python 面 hover
(plain_var_caller.py `def get_annotated_data`,20 连发;Pylance 惰性分析已用首命中
轮询窗排除在测量外)。

## 原始数(单轮,n=20/面,PERF-015 口径:本机单轮,不作跨机器比较)

| 指标 | enabled(Kode+Pylance) | disabled(Pylance-only) | 差值(归因) |
| --- | --- | --- | --- |
| Kode 实例数 | 1 | 0 | 单一 Kode ID 断言成立(两面各自断言) |
| def hover 命中 | 20/20 | 0/20 | def 面=Kode 独占领地(归因锚) |
| def hover p50/p95 | 3.345 / 9.989 ms | 0.915 / 28.407 ms | 命中成本只能归 Kode |
| python hover 命中 | 20/20 | 20/20 | Python 面两面都被服务(Kode 不挤占) |
| python hover p50/p95 | 51.258 / 97.143 ms | 37.764 / 74.804 ms | 单轮差 13.5ms,两面区间重叠 |
| 宿主 RSS | 336 MiB | 284 MiB | +52 MiB = Kode 宿主侧内存成本 |

## 归因结论

- **单一 Kode ID**:启用面全宿主恰一个 `cuihairu.kode-kbengine` 实例(无 dev/marketplace
  双装配);禁用面恰零实例(禁得干净,无残留注册)。
- **def 面成本归 Kode**:同一 def 位 hover,禁用面零命中、启用面全命中——这批 hover
  的全部成本只能来自 Kode(p50 3.345ms)。
- **python 面成本归 Pylance**:python hover 两面全命中且量级一致(几十 ms),Pylance
  独立服务该面;Kode 在场时 Python 服务可用性不受挤占(20/20)。两面单轮差 13.5ms
  属两次独立进程的波动区间重叠,不构成回归结论。
- **Kode 宿主侧内存**:RSS 差 +52 MiB(含 5000 文件外部根索引与 worker 池常驻)。
  注意口径:Pylance 语言服务器进程是独立进程,其内存不在宿主 RSS 内,本表只能归因
  宿主侧;两套服务各自进程级的完整四面对照(裸面/Pylance-only/Kode-only/联合)沿用
  `2026-10-28-p0-4c-joint-acceptance.md` 既有数据。

## 免责(PERF-015)

单轮单机数据,只作归因方向与量级证据,不作跨机器/跨轮次绝对值比较;hover 为墙钟
采样;两面为两次独立 VS Code 进程,启动态与缓存态有不可控差异,区间重叠的指标以
重叠如实记录,不下回归结论。
