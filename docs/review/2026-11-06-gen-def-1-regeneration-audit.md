# GEN-DEF-1 重生成 diff 审计(pyi/stub 生成器 __init__ is None 守卫)

日期:2026-11-06 · 分支:`feat/gen-def-1-stub-guards`(基线 `ae36cd7` = origin/main)
口径:todo.md:954(用户令 2026-11-02,引擎源码已核实)——`__init__` 初始化守卫
仅对 FIXED_DICT/ARRAY 引用型(含命名别名)生成 `if self.<prop> is None:`;简单
类型不生成;禁 `if not self.` 形态(falsy 判断会把引擎合法默认 0/""/[] 误判并
重建,引用失效)。

## 审计方法

同一 dump 脚本(`tests/genDef1AuditDump.test.ts`)在基线 worktree(ae36cd7)与
改造 HEAD 上各跑一次,全量重生成以下生成物并落盘逐文件 diff:

- 真实夹具 `tests/fixtures/kbengine-demo-assets`(7 个 .def + types.xml;
  审计闸断言 mappings/产物非空,7 实体全出)
- 真实 fantasydemo 树(`KODE_FANTASY_ROOT` 指向
  `~/workspaces/BigWorld/programming/fantasydemo/res`;Account/Avatar/
  ClientOnly/Guard/Space.def + alias.xml;4 实体全出)
- 合成容器夹具(Hero:hp UINT32 简单 / talent ARRAY / profile FIXED_DICT,
  带 CellMethods 方法面)——容器守卫的唯一预期 diff 面
- 附带 `buildEntityTypeStubLineMap` / `buildPythonTypeStubLineMap` 行映射
  (**Map 显式 Object.fromEntries 序列化**——首版审计误用 JSON.stringify(Map)
  得到空对象,v2 已修并断言非空,demo 映射实出 Account.accountName=19 等)

结果文件:`/tmp/gen-def-1-audit/{base2,current2}`(guard_audit.txt 计数 + 产物
全文 + 行映射 JSON;两轮 dump 均绑定当轮 HEAD)。

## 审计结论

1. **真实生成物逐字节零漂移**:demo 与 fantasydemo 两个真实树的
   `entity_types.pyi` / `kbe_types.pyi` / 行映射 JSON 在基线与改造后完全一致
   (`diff -rq` 仅合成夹具两文件不同)。两树的 .def 均无 ARRAY/FIXED_DICT
   属性(含别名),按口径简单类型不守卫——**现有使用方的存根不受本次改造
   影响,无需任何迁移**。
2. **合成容器夹具 diff = 预期守卫增量,且仅此一处**:

   ```diff
        # source: .def:6 -> types.xml:8
        talent: FixedArray[TALENT_NODE]

   +    def __init__(self) -> None:
   +        if self.profile is None:
   +            self.profile = {}
   +        if self.talent is None:
   +            self.talent = []
   +
        # source: .def:40 (CellMethods)
        def shout(arg1: int) -> None: ...
   ```

   - `is None guards`:0 → 2(FIXED_DICT→`{}` 复位、ARRAY→`[]` 复位)
   - `__init__ blocks`:0 → 1(仅容器属性存在时生成;简单类型实体不生成空 `__init__`)
   - 守卫段落位:属性面之后、方法面之前;属性行映射(填充态 JSON)逐字节
     一致,守卫不漂移 KR-AUD-78 行映射。
3. **旧形态清零**:全部重生成产物 grep `if not self.` = 0;guard_audit.txt
   双侧同数。
4. **别名链覆盖**(审核轮 1 补):ARRAY 别名(ROOM_LIST→ARRAY<of UINT32>)与
   FIXED_DICT 别名链(CHAR_PROFILE→ITEM_INFO)经 pythonTypeStubs 同一解析链
   (resolveAnnotationTypeWithRegistry,复用环检测/级联跳过)解析到容器,
   同口径守卫;简单别名(PLAYER_ID→UINT32)不守卫——tests/genDef1GuardConvention
   .test.ts 三条别名用例锁死。

## 红先行证据(审核轮 1 勘误后的如实口径)

红跑(基线实现,`.red-logs/gen-def-1-red.log`,7 failed / 7 passed):
- **6 项为守卫缺失行为证据**:FIXED_DICT 守卫、ARRAY 守卫、行映射随守卫段
  迁移、混合实体、codeGenerator base/cell 守卫、段间越域——基线实现即
  「无守卫」变体,这些断言在其上全数失败(等价于守卫判定恒假的变异验证)。
- **1 项为测试自身缺陷**:行映射用例首版把 plan.content(含 kbe_types 导入
  行)与无模块语境的 lineMap 渲染按同一索引对比,差 1 行——系测试比较语境
  错误而非守卫断言,当轮已修(同 customTypeModules 语境对比 + 守卫段剔除
  基线复核)。

## 覆盖面清单(生成器 × 守卫点)

| 生成器 | 实体类发射点 | 本次改造 |
| --- | --- | --- |
| `src/entityTypeStubs.ts`(entity_types.pyi) | 实体类(renderEntityTypeStub) | ✅ `__init__` is None 守卫,别名链同口径(a85a796) |
| `src/codeGenerator.ts`(generatePythonContent) | base/cell/client 段实体 .py | ✅ 容器属性守卫(7122016) |
| `src/entityWizard.ts`(buildEntityPartPythonContent) | 向导段实体 .py | 已符合(GEN-DEF-2 交付,本次回归锁口径) |
| `src/pythonTypeStubs.ts`(kbe_types.pyi) | TypedDict 类/别名,无实体类 | 无守卫点(TypedDict 不得有方法),回归测试锁零 `__init__` |
| `src/clientSdkGenerator.ts` | TS/AS 类,无 Python `__init__` | 不适用 |

注:receiverNone 快修(languageProviders.ts `if not self.<receiver>: return`
早退守卫)非 `__init__` 初始化守卫生成器,属邮箱句柄早退面,不在本条口径
(属性默认值守卫)范围,未改。

## 已知取舍(审核轮 1 残余,如实记录)

- **codeGenerator FIXED_DICT 判定走命名约定**(`<Entity>State`,即
  entityWizard.fixedDictTypeName):该生成器运行时 types.xml 注册表不可得
  (FIXED_DICT 命名类型恰由同事务 appendFixedDictTypeToTypesXml 首次登记),
  无真注册表可查。漏守(用户自定义他名 FIXED_DICT)保守安全;误守仅在
  用户手工把 `<Entity>State` 注册成简单别名且引擎 addDataType 未拒重的
  边缘出现。不引入 fs 读 types.xml(破坏纯函数面与既有测试形态),
  如实记录为约定耦合。
- **.pyi 体含语句**:entity_types.pyi `__init__` 体为真实守卫语句;仓内无
  消费者执行 .pyi 体(docs/design/def-pyi-stubs.md:154 明确存根不执行),
  现有 content 断言已全部随更新。Pylance 对 .pyi 方法体的解释未实测
  (本机无 pyright),如实记录。
