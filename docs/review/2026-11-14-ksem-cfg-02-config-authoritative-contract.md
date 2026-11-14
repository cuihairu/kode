# KSEM-CFG-02 配置权威契约提取(2026-11-14)

验收口径(todo.md SEM-032,旧 KSEM-CFG-02):提取配置权威契约——关联引擎
读取源码、默认 XML、已有 schema;记录类型、枚举、单位、范围、可重复节点、
动态键和版本,**不从默认值猜全部约束**。

交付物:契约提取纯核心 `src/backend/configContract.ts` + `tests/
configContract.test.ts`(13 例,真夹具 tests/fixtures/config/
kbengine_defaults.xml——942 行引擎字节镜像——全量直跑)。CFG-01 登记册
(configReadPaths.ts)的 server-config lane 即本核的数据来源位。

## 证据分级(每条记录必带,测试锁死)

| 档位 | 证据源 | 夹实测 |
|---|---|---|
| `engine-read-site` | 目录锚指引擎读取点(SERVER_CONFIG_ITEM_DOCS source 含 serverconfig.cpp,31 处) | 122 条 |
| `defaults-enum-comment` | 注释枚举块(`N: 含义` 行 ≥2) | 匿名组(publish.state)+父段具名组(trace_packet.debug_type 0-3) |
| `defaults-type-annotation` | 内联 `<!-- Type: X -->`(夹具 48 处,部分随枚举优先) | 39 条 |
| `defaults-value-only` | 仅默认值形态——**候选,非约束** | 其余叶子 |
| `defaults-comment` | `<item>` 重复结构 | 16 条列表节点 |

总记录 189(叶子+item 列表,钉死漂移闸);目录升档可叠加注释侧证据
(引擎锚证明读取,不证明类型全貌——候选旗标保留)。

## 契约面登记

- **类型**:Integer/Integer8/Float/Boolean/String 注解映射 + 单值形态候选
  (boolean/integer/float/string);
- **枚举**:匿名组挂元素自身(publish.state: 0=debug/1=release);父段具名组
  按 header 与子叶同名传播(trace_packet 注释的 debug_type 组 →
  `trace_packet.debug_type`,4 值);仅 1 条值行不算枚举
  (congestionControl 的 `false: disable ...` 是单值提示);
- **单位**:注释括注词表(秒/毫秒/字节/bit/seconds/…);括号内纯数字
  (`(1400)`)是默认提示不是单位,不采;
- **可重复节点**:`<item>` 子节点全等模式 → list 契约(trace_packet.disables);
- **范围:不记**——任何证据源都不证明数值上下界,每条记录 unproven 恒含
  'range'(测试断言全量);
- **动态键:不记**——引擎对未知子节点的迭代行为无本地证据,恒 false 且入
  unproven;
- **版本**:逐键 since-version 无证据不记(unproven.version-per-key);版本
  维度=extraction.baseline(942 行引擎快照钉死+口径注)。

## 诚实条款

1. 候选≠约束:`defaults-value-only` 记录 valueOnlyCandidate=true,类型断言
   只到「单值形态」,unproven 追加 'type-full-picture';绝不回填范围/类型
   全貌。
2. 引擎锚升档不覆盖注释证据:source 组合「目录取证+注释侧」;候选旗标在
   升档后保留(引擎读取点证明 key 被读,不证明值类型全貌)。
3. 消费面契约:`contractRecordByPath(extraction, path)` 为补全/校验/悬停
   (SEM-034/035/036)的取数入口;unproven 列表供 UI 明示「未知面」。

## 已有 schema 关联

- CFG-01 登记册 server-config lane(resolve 链/catalog/final config)=
  本核数据来源位;
- SERVER_CONFIG_ITEM_DOCS(255 键 zh/en+source)=目录取证源;
- Rust 解析核(KODE-CFG-002 parse_config)与 TS 回落核(单一事实源)
  =树产物来源;本核零 vscode、零文件读取。

## 门禁

compile 0 / eslint 0 / vitest 全量 9700+4skip RC=0 / xvfb demo 25 RC=0;
prove-red:撤 unproven range + 候选谎称注解证据 → 3 红(候选诚实/范围诚实/
统计一致),还原 cmp 字节一致全绿。
