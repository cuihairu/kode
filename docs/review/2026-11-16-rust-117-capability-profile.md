# RUST-117 验收:引擎版本差异 capability profile(不用 if version 散落调用方)

日期:2026-11-16。验收对象:todo.md RUST-117(旧 SEM-015)「引擎版本差异经 capability profile 决定,不用 `if version` 散落调用方」。

## 1. 判据词 → 实现面映射(crates/kode-server/src/semantics/capability.rs,KSEM-CAP 纯库面 + engine_meta 扩类别)

| 判据词 | 实现面 | 语义 |
|---|---|---|
| capability profile | `CapabilityProfile::resolve(meta, version)`(装配点一次) | 全表过滤 `MetaCategory::Capability`,键序 BTreeMap 确定;构造后不可变 |
| 版本差异经 profile 决定 | `capability(id)` → `CapabilityState{Supported{source}/Unsupported{source}/Unknown}` | 调用点只问能力态,不见版本串比较(消费形态测试钉);`is_supported` 仅 Supported 为真(保守口径) |
| 不用 if version 散落调用方 | API 形状强制 | 版本串只在装配点出现一次;分支只落能力态;`version` 字段原样携带供审计 |
| 引擎版本差异(数据面) | `engine_meta` 扩 `MetaCategory::Capability`,seed 3 条本树 2.5.10 实证:`cap/math-module-vectors`(在,math.cpp:17-21)/`cap/component-string-constant`(在,script.cpp:248)/`cap/no/entitycall-type-python-constants`(实证缺席,common.h:283-292) | 键约定:`cap/<id>` = 能力在,`cap/no/<id>` = 实证缺席(缺席也是实证事实,非 Unknown),两键都无 = Unknown 不猜 |

## 2. 关键语义保证(诚实边界)

- **「外部版本可覆盖」对能力差同样成立**:RUST-113 `OverrideSet` 版本域覆盖直接作用于能力键——测试钉:fork 覆盖只翻声明版本,域外 seed 基线不变;override 专有能力只在声明版本出现;全版本集 override 通吃;
- seed = 本地引擎树 2.5.10 实证基线(全版本事实);其它版本差异无证据 → Unknown(不猜),由登记覆盖供给——本面不猜版本兼容性,真实差异裁决归消费方;
- 与 RUST-113 边界:113 供给逐条引擎事实,本面把能力差收敛成单点 profile;与 rename_policy 边界:能力键 `cap/` 名空间化,语料符号名不撞(测试钉);
- 同 id 两形态并存(cap 在 + cap/no 缺)时 `cap/no` 后写胜(BTreeMap 键序确定)——fork 覆盖 seed 语义,测试钉;
- 无 RPC、无 TS 消费,消费接线属各域账行。

## 3. 测试与 prove-red

- 9 例内嵌单元:基线三能力解析(锚点断言)/ is_supported 严格 + Unknown 不猜 / 版本域覆盖只翻域内 + 域外 seed 不变 / override 专有能力只入声明版本 / 全版本 override 通吃 / 消费形态钉(调用点无版本串)/ ids 枚举确定 + 非能力类别不泄漏 / 名空间不撞 rename 扫描 / 双形态并存缺席后写胜;
- prove-red 三靶(cp 备份+python3 变异+cmp 字节还原):① resolve 忽略 version(全 override 适用)→ 3 例红;② `cap/no` 缺席误判 Supported → 4 例红;③ is_supported 查无也真 → 1 例红。

## 4. 兼容面核验

- seed 表 29 → 32(三条能力差),engine_meta 表数钉测试同步;golden `semantics-facts.json` **字节不变**(rename 探针不受能力类别影响,dump|cmp 实证);semantics 全量 325 例绿。

## 5. 门禁(2026-11-16 实跑)

clippy 六 crate `-D warnings` 0 / cargo test 六 crate 103 套件 1402 绿(capability 9)/ rustfmt 本批文件 / pnpm lint 0 / pnpm compile 0 / vitest 842 文件 10332+8skip 全绿 / xvfb demo 25 RC=0。

## 6. 结论

判据词全落:能力差经 profile 决定(装配点一次解析,调用点零版本比较)、三分能力态(在/实证缺席/不猜)、外部版本覆盖供给差异。整行 `[x]` 勾账。
