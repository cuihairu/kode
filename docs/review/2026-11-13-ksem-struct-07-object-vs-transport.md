# KSEM-STRUCT-07 对象表示与传输表示区分

**日期**:2026-11-13
**条目**:`todo.md` KSEM-STRUCT-07 [P1]「区分对象表示与传输表示。验收:implementedBy 对象成员使用 Python 结构,转换后字典使用 FIXED_DICT 结构;不得把任意自定义对象当 TypedDict。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| implementedBy 对象成员使用 Python 结构 | 内存形式由实现类重定义(createObjFromDict 返回什么脚本侧就是什么,官方示例是 list 子类)——字典键位面(下标补全/悬停/跳转、标量赋值链、FD 构造校验)不再穿过 implementedBy 容器冒认 Properties 键位;接收者的字符串下标悬停给机制说明(内存形式为实现类结构,键位由实现类定义);自定义类型悬停把 Properties 标题框为「传输/存储形式」并附内存形式注记,指向 STRUCT-06 绑定段 |
| 转换后字典使用 FIXED_DICT 结构 | Properties 键位的正名:它们描述引擎在 getDictFromObj 边界还原的传输/存储形式(悬停框架明示),构造点校验对该形式的合法消费点(非 implementedBy 的普通 FD)照常工作——门只收窄不误伤(同注册表回归面钉住) |
| 不得把任意自定义对象当 TypedDict | implementedBy FD 根/链中字段/数组元素三面同收(chainStateFromAnnotation 两处查找都加 `!implementedBy`);非 FD 自定义类型(aliasType=UINT8)本就在 aliasType 门之外——既有口径补显式钉子;implementedBy 属性上的 dict 字面量不再按声明键集校验(校验通过=假安全,校验失败=误报,两向都不对,豁免是唯一诚实面) |

## 2. 引擎真值

- customtypes.md L8:**所有数据类型中只有 FIXED_DICT 能够被用户重定义**——C++ 底层只认 FIXED_DICT,存储/网络传输时从脚本层取数据,「只要能恢复原本的形式则底层依然能够正确的识别」;
- customtypes.md L86-99:官方示例 XXX_TYPE(list) 子类——内存形式 `self[0]`/`self[1]` 位访问,asDict/createFromDict 做两表示转换;createObjFromDict 的返回「直接赋值到脚本中的变量」;
- types.md 例2:AVATAR_INFOS_LIST 带 implementedBy 后内存形式键位完全不同(`{"kbengine": {...}}` 按名键,非声明键 `values`)——内存键位是实现类自定义的,静态不可知。

## 3. 改动面(零新诊断族/零新开关)

| 文件 | 改动 |
|---|---|
| `src/backend/fixedDictSubscript.ts` | 新导出 `implementedByFixedDictOfAnnotation`(implementedBy FD 识别);`chainStateFromAnnotation` 两处查找加 `!implementedBy`(fd/数组元素同收)——下标补全/悬停/跳转/scalarAssign 链/FD 构造链五面同过此门 |
| `src/backend/fixedDictConstructCheck.ts` | `fdContainerOfAnnotation` 加 `!implementedBy`(直接形态+链形态同豁免) |
| `src/backend/hoverMarkdown.ts` | 新纯渲染 `formatImplementedBySubscriptNoteHover`(机制说明:内存形式为实现类结构,Properties 键位仅传输/存储边界适用) |
| `src/languageProviders/hover.ts` | `resolveFixedDictKeyHover` 接收者定型后查 implementedBy 容器 → 命中给机制说明悬停(不进键位解析);链中途 implementedBy 字段照旧由解析链诚实断链 |
| `src/languageProviders/hoverBuilders.ts` | `createCustomTypeHover` Properties 段:implementedBy 类型标题=「Properties(传输/存储形式)」+ 内存形式注记;普通类型原样 |

## 4. 诚实边界(测试钉死)

- 内存下标的**合法性**不裁定:实现类可自定义 `__getitem__` 接受任意键——机制说明只陈述引擎机制(传输/存储形式 vs 内存形式),不判对错;
- 数组元素为 implementedBy FD 的悬停(根注解 `FixedArray[ImplFD]`)不给机制说明(只直配容器名),走解析链诚实断链——数组层实现类形态更远,不猜;
- dict 字面量赋给 implementedBy 属性是否会在传输边界炸(getDictFromObj 期望内存形态)→ 是真 bug 模式,但 isSameType 静态判定脆弱(实现类可能故意接受 dict),本批不造新诊断,豁免+纪实;
- 门内既有口径不变:普通 FD 的五面(补全/悬停/跳转/标量链/构造校验)全回归绿。

## 5. 证据

- 纯核+钉子:`tests/fixedDictSubscript.test.ts` +7 例(容器识别正负/根断链/链中途断链/数组元素断链/普通 FD 回归/标量类型 TypedDict 钉子);
- Provider 三面:+4 例(补全不补声明键/悬停机制说明含绑定值且无键位/普通 FD 悬停回归/跳转无 fixeddict-key 层);
- 构造豁免:`tests/fixedDictConstructCheck.test.ts` +3 例(直接形态零报告含外来键/链形态零报告/普通 FD 照常);
- 悬停框架:`tests/hoverGapArms.test.ts` +2 例(传输/存储形式标题+内存注记/普通类型不误伤);`tests/languageProvidersInternals.test.ts` DOLL 例期望随新框架更新(fixture 带 implementedBy,行为即本批意图);
- prove-red:`git stash push -- src/` 后 9 例红(3 文件),恢复 97/97 绿;
- ANCHORS:hover.ts fixedDictSubscript import +1 → provideHover 306→307,锚点表+docs/perf/2026-baseline.md(含 mermaid)锁步;
- 门禁:eslint 0 / tsc 0 / vitest 747 文件 9157+8skip 全绿 / xvfb demo 25 RC=0。
