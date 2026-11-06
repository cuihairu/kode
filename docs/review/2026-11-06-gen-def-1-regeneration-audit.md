# GEN-DEF-1 重生成 diff 审计(pyi/stub 生成器 __init__ is None 守卫)

日期:2026-11-06 · 分支:`feat/gen-def-1-stub-guards`(基线 `ae36cd7` = origin/main)
口径:todo.md:954(用户令 2026-11-02,引擎源码已核实)——`__init__` 初始化守卫
仅对 FIXED_DICT/ARRAY 引用型生成 `if self.<prop> is None:`;简单类型不生成;
禁 `if not self.` 形态(falsy 判断会把引擎合法默认 0/""/[] 误判并重建,引用失效)。

## 审计方法

同一 dump 脚本(`tests/genDef1AuditDump.test.ts`)在基线 worktree(ae36cd7)与
改造 HEAD 上各跑一次,全量重生成以下生成物并落盘逐文件 diff:

- 真实夹具 `tests/fixtures/kbengine-demo-assets`(7 个 .def + types.xml)
- 真实 fantasydemo 树(`~/workspaces/BigWorld/programming/fantasydemo/res`:
  Account/Avatar/ClientOnly/Guard/Space.def + alias.xml)
- 合成容器夹具(Hero:hp UINT32 简单 / talent ARRAY / profile FIXED_DICT,
  带 CellMethods 方法面)——容器守卫的唯一预期 diff 面
- 附带 `buildEntityTypeStubLineMap` / `buildPythonTypeStubLineMap` 行映射 JSON

结果文件:`/tmp/gen-def-1-audit/{base,current}`(guard_audit.txt 计数 + 产物全文)。

## 审计结论

1. **真实生成物逐字节零漂移**:demo 与 fantasydemo 两个真实树的
   `entity_types.pyi` / `kbe_types.pyi` / 行映射 JSON 在基线与改造后完全一致
   (`diff -rq` 仅合成夹具两文件不同)。两树的 .def 均无 ARRAY/FIXED_DICT
   属性,按口径简单类型不守卫——**现有使用方的存根不受本次改造影响,
   无需任何迁移**。
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
   - 守卫段落位:属性面之后、方法面之前;属性行映射 JSON 逐字节一致
     (`LINE_MAPS_IDENTICAL`,守卫不漂移 KR-AUD-78 行映射)。
3. **旧形态清零**:全部 6 份重生成产物 grep `if not self.` = 0;
   `guard_audit.txt` 双侧同数。

## 红先行证据

- `tests/genDef1GuardConvention.test.ts` 红跑(基线实现):**7 failed / 7 passed**
  ——失败的恰为 7 个守卫口径断言(FIXED_DICT/ARRAY 守卫缺失、行映射/混合实体/
  codeGenerator 三段),通过的是口径既满足面(简单类型无守卫、poisoned 不守卫、
  全语料无 `if not self.`、向导回归)。红日志归档:`.red-logs/gen-def-1-red.log`
  (commit `1e47026` 附带断言清单)。
- 变异验证(口径真实覆盖):守卫判定恒假(guardNoneEmptyOf 恒 undefined)时
  红测试必失败——红跑本身即该变异的等价证据(基线实现即"无守卫"变体,
  7 项全红)。

## 覆盖面清单(生成器 × 守卫点)

| 生成器 | 实体类发射点 | 本次改造 |
| --- | --- | --- |
| `src/entityTypeStubs.ts`(entity_types.pyi) | 实体类(renderEntityTypeStub) | ✅ 新增 `__init__` is None 守卫(a85a796) |
| `src/codeGenerator.ts`(generatePythonContent) | base/cell/client 段实体 .py | ✅ 容器属性守卫(7122016) |
| `src/entityWizard.ts`(buildEntityPartPythonContent) | 向导段实体 .py | 已符合(GEN-DEF-2 交付,本次回归锁口径) |
| `src/pythonTypeStubs.ts`(kbe_types.pyi) | TypedDict 类/别名,无实体类 | 无守卫点(TypedDict 不得有方法),回归测试锁零 `__init__` |
| `src/clientSdkGenerator.ts` | TS/AS 类,无 Python `__init__` | 不适用 |

注:receiverNone 快修(languageProviders.ts `if not self.<receiver>: return`
早退守卫)非 `__init__` 初始化守卫生成器,属邮箱句柄早退面,不在本条口径
(属性默认值守卫)范围,未改。
