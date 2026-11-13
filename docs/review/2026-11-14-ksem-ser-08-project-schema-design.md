# KSEM-SER-08 收口:项目显式序列化 schema 设计

**日期**:2026-11-14
**条目**:`todo.md` KSEM-SER-08 —— 支持项目显式序列化 schema。验收:设计项目级 schema/注解绑定方式及版本规则,避免污染业务代码;无 schema 时不声称 json.loads 返回固定类型。
**性质**:设计文档。物化车道 = KSEM-SER-09(静态字典格式)/ KSEM-SER-10(JSON 链传播),按本设计实施;本批零引擎行为改动。

---

## 1. 目标与非目标

**目标**:给项目 JSON / 自定义序列化面一个**项目显式 schema** 机制,使静态分析可证明地知道 `json.loads(path)` 返回的结构;机制的全部声明放在项目声明文件里,业务代码零污染。

**非目标**:
- 不实现结构推导与传播(归 SER-09/10);本批只定载体、绑定方式、版本规则、诚实边界;
- 不触碰引擎 wire(引擎 wire 契约归 SER-02 模型 §2 登记的领域);
- 不给 pickle/PYTHON 桶任何字段结构(SER-11 边界;SER-01 实测 pickle 桶不透明无字段语义)。

**引擎真源边界**(SER-01 盘点实测):KBEngine 不拦截 stdlib `json`,没有反序列化 hook——项目 JSON 是**纯 kode 侧约定**,引擎对它零契约、零校验。这决定了 schema 机制是分析约定而非引擎契约:文档与消息面必须如实表述「kode 静态约定」,绝不写成引擎行为。

## 2. 绑定方式:声明式文件绑定(选定),代码内注解(否决)

| 路线 | 形态 | 裁定 |
|---|---|---|
| **A 声明式文件绑定(选定)** | 项目声明文件 `.kbengine/serialization.json`:type 定义 + 消费点绑定(路径 glob 或符号 → type id) | 业务代码零污染;绑定单源真相;声明文件随项目版本化 |
| **B 代码内注解(否决)** | 装饰器/类型注解标在业务函数上 | 污染业务代码(验收明文排除);双源真相(注解写了但文件未装/反之);引擎无 hook,注解纯属 kode 约定却要求业务代码买单 |

**路线 A 的先例一致性**:`types.xml` 的 `implementedBy` 就是引擎自己的「绑定放声明文件」哲学——SER-03..07 整族(implementedBy → pythonFilePath + 符号末段绑定)零业务代码侵入地工作至今。schema 机制沿用同一哲学:`.kbengine/` 命名空间已有 configContract 车道守护(.gitignore 契约面要求 `.kbengine/` 入 ignore),声明文件放这里与既有工作区契约天然一致。

### 2.1 schema 文件形状(默认草案,可调)

```json
{
  "schema_version": 1,
  "types": {
    "proj.guild.GuildConfig": {
      "fields": {
        "level": "UINT32",
        "members": ["DBID"],
        "notice": "STRING",
        "settings": "proj.guild.GuildSettings"
      }
    },
    "proj.guild.GuildSettings": {
      "fields": { "cap": "UINT16", "open": "BOOL" }
    }
  },
  "bindings": {
    "json.loads": [
      { "path": "res/guild_configs/*.json", "type": "proj.guild.GuildConfig" }
    ]
  }
}
```

- `types`:字段名 → 标量族名 / `[元素类型]`(数组)/ type 引用(嵌套)。标量族名**复用 CELL-08 既有 SCALAR_FAMILIES 真源**(UINT8/16/32/64、INT8/16/32/64、FLOAT、DOUBLE、STRING、UNICODE、BOOL、DBID…),schema 不自造第二套标量宇宙——两套宇宙必然漂移。
- `bindings`:按**消费点证据**绑定——`json.loads` 键下挂 `{path, type}` 项;后续 lanes 可扩展 `json.load`(文件对象)、`module.func`(函数返回)等键。绑定语义 = 「该 glob 命中的文件经 json.loads 读出后,结构即 type」。
- 未定义 type 引用 / 标量族名不在 SCALAR_FAMILIES / glob 语法非法 → schema 自身校验失败:默认**记诊断**(挂既有 configContract 车道的形态,声明文件是项目资产,坏了要让用户看见),而不是静默忽略。

### 2.2 版本规则

- `schema_version`:整数,单调递增,由项目作者维护;分析面不推断它,只在诊断信息面展示(证据可追溯)。
- 缓存键控:结构推导结果 LRU 以 **(文档身份, schema 内容 md5)** 复合成键——KODE-PERF-001 flowVersionKey 协议同族(src/flowVersionKey.ts,模块在 src/ 根不在 backend/)(文档实例身份 + 内容版本,防跨实例撞键);schema 变更 → md5 变 → 旧推导作废重算。这与 SER-02 §5 登记的引擎 defs-md5 语义同哲学:内容指纹做失效闸,不靠 mtime。
- 绑定歧义裁定:同一加载点命中多条 `{path, type}` → **未知,不猜**(不取第一条、不取最长 glob——家族律「不凭名字推定」的绑定面版本)。

## 3. 无 schema 诚实契约(验收第三面)

**现状审计(2026-11-14 本批实测,诚实基线)**:
- Rust `crates/kode-python/src/*.rs` grep `loads|pickle|json.loads` → **零命中**:引擎侧从未声称 stdlib json 的返回形态;
- TS `src/backend/*.ts` grep `json.loads` → 仅 `hotReloadTransport.ts`(:557/:564,热更传输脚本自用 JSON,非分析面);
- Python 返回推导面(TS pythonReturnTypeInference + Rust self_flow)均无 stdlib 返回表;
- **结论:现状已是诚实状态** —— `json.loads` 的返回在双引擎都是未知,今日没有任何面声称固定类型。本设计的任务是**让这个不变量在 SER-09/10 物化时保持成立**,而不是修复一个已存在的谎称。

**不变量(对物化车道的硬约束)**:

1. 无 schema(或绑定未命中)时:
   - (a) 不得从变量名 / 函数名 / 文件名推定结构——「不凭函数名推定结构」家族律(SER-05 定名)的 JSON 面版本;
   - (b) 不得给 `json.loads` 调用点提供任何补全 / 悬停字段面;
   - (c) 诊断面零产出——「未知」不是诊断,静默即诚实。
2. 有 schema 且绑定命中且 type 已定义且无歧义时:结构面(补全/悬停/诊断)才开启;四个条件缺一 → 回落第 1 条。
3. schema 机制对 pickle/PYTHON 零绑定能力:bindings 键空间不设 pickle 条目(防未来误配;裸 PYTHON ≠ FIXED_DICT,SER-11)。

## 4. 与物化车道的消费契约

- **KSEM-SER-09(项目静态字典格式)**:以本 schema `types` 为推导种子;无种子时纯从 dict 构造/写点推导,分支合流、多写者、动态 update → 开放结构(该行验收原文)。schema 种子与推导结果冲突时:推导按代码事实,**不拿 schema 覆盖代码证据**——schema 是绑定输入,不是代码之上的裁判。
- **KSEM-SER-10(JSON dumps/loads 链传播)**:`dumps(obj)` 仅当 obj 来源可证明(schema 绑定或 SER-09 推导)才传播;`loads(path)` 仅绑定命中才给结构。JSON 语义转换面(key 恒 str / tuple→list / 数值 int↔float 边界)按 SER-02 §2 原语表口径登记,不在本设计展开。
- **KSEM-SER-11(pickle/PYTHON 边界)**:本设计 §3.3 即其绑定面边界;pickle 传递证据(「已有对象类型可传递」)读 SER-02 §3 对象结构登记,不读本 schema。

## 5. 默认裁定与可调项

| 项 | 默认 | 可调性 |
|---|---|---|
| 声明文件路径 | `.kbengine/serialization.json`(固定) | 物化批可加 vscode 设置覆盖,默认值不变 |
| path glob 语义 | Python `fnmatch` 语义(与 `.kbengine/` 既有 glob 用法一致) | — |
| schema 自身校验失败 | 记诊断(configContract 车道形态) | — |
| `schema_version` 语义 | 项目作者维护的单调整数,仅展示不推断 | — |

---

**证据与门禁**:本批纯设计零代码改动;诚实审计 grep 证据见 §3(双引擎零声称,实测于 2026-11-14 工作树 @ ef125da5 之上)。门禁与 SER-01/02 纯文档批同口径:lint 0 / tsc 0 / unit 全量 / xvfb demo 25 RC=0(见 todo.md 勾行注)。
