# KSEM-CFG-07(SEM-037)配置读取结果类型传播 — 批次纪实

日期:2026-11-14。todo.md SEM-037(旧 KSEM-CFG-07):传播配置读取结果类型。验收:给可确定配置 loader 和字段访问绑定 schema;dict/get/别名/嵌套访问保留类型及缺省值联合。

## 交付面

- **纯核 `src/backend/configFieldAccess.ts`**(零 vscode 零 IO):
  - 可确定配置 loader = `.kbengine/serialization.json` 声明绑定(SER-08 机制)的 `json.loads(串字面量)` 与 `json.load(open(串字面量))`(后者 CFG-07 起消费 `bindings["json.load"]`;encoding 等 open 其余实参容忍,首实参须引号串字面量,变量路径零声称);
  - 字段访问位点(同行链,raw/masked 双行口径同族):dict 下标 `cfg['k']`、整数下标(列表/元组元素)、`.get('k')` / `.get('k', d)`;嵌套链 `cfg['settings']['cap']` 逐段解析(schema ref 展开 / 列表元素 / SER-09 字面量字段);别名 `y = cfg` 经链态 value 复制透传(SER-10 同律);
  - **缺省值联合**:链尾 `.get('k')` → 字段类型 + `none` 联合(Python 语义:缺键返 None);`.get('k', d)` → 字段类型 + `d` 分类类型(classifyValue;推不出不追加);链中 get 按下标面处理不计联合;
  - 输出 `ConfigFieldAccess`:{line, receiver, keys[], origin(schema|derived), typeId, fieldType | null, unionWith[]};scalar family 词表:schema 侧=SCALAR_FAMILIES 名(UINT32 等),derived 侧=py 标量(str/int/float/bool/none),按 origin 区分。
- **SER-10 核延展 `src/backend/jsonChainPropagation.ts`**(契约加宽,行为向后兼容):
  - `SerializationSchema` 增 `loadBindings`(bindings 两键同构校验:'json.loads'/'json.load',其余键预留不消费);
  - 链态 value 增 `typeId?`(schema 绑定产物才有;SER-09 推导/别名无);绑定解析 `schemaPathBinding(path, schema, loader)` 返回 {fmt, typeId},歧义 glob 双 null(SER-08 §2.2 同律);
  - 裸名 `from json import load [as X]` 绑定表 + 角色 'load'(属性形 `json.load` / 裸名形);
  - 行前快照:`deriveJsonChainTypedValues(text, schema, interestLines)` — 请求行的 value 态(name → {fmt, typeId});跳过区(dumps/import 跨行字面量中段)前一快照顺延,行 ≥ 尾行=终态;`deriveJsonChainStructures` 原契约不变(抽内部 walkJsonChains,全部既有测试零改动)。
- 解析锚点位移锁步:`parseSerializationSchema` 78→80,registry `configReadPaths.ts` + `configReadPaths.test.ts` 锚串 :78→:80 同笔(CFG-01 登记册 serde 行补 CFG-07 括注)。

## 诚实边界(v1 明示,不写成已实现)

- **v1 模块作用域链态**:函数体内局部 loader 产物(`def load(): cfg = json.load(...)` 后访问)不声称——SER-10 链态走模块作用域("同名跨作用域合流是谎报");def/class 体访问按入体态解析,三重守卫:参数遮蔽、体内写点(含嵌套 def/class;class 体也是执行作用域,类体赋值遮蔽模块名)、模块级终态漂移(入体后全局重绑,运行期动态可见)任一命中即跳过;
- 直接字典字面量赋值(`cfg = {...}` 后下标)不入——SER-10 链态该写点为 kill,derived 面仅经别名透传可达;
- 变量键/关键字实参/3+ 实参/跨行链/属性接收者(self.cfg)不入;写位点(`cfg['k'] =`)是写不是读不入;
- 开放结构(open fmt)与 unknown fmt 不声称键面;schema=null 时仅 derived 面。

## prove-red(字节还原闭环)

1. 缺省值联合面:链尾 get 无默认的 none 联合摘除 → 2 红(get 联合例)→ `cp` 备份 + python 替换 + 还原 `cmp` 字节一致;
2. json.load 绑定面:角色识别摘除(`fn === 'load'` 臂)→ 2 红(CFG-07 访问例 + SER-10 json.load 面)→ 还原 `cmp` 字节一致。

## 坑账

1. **夹具词表**:schema fixture 用 `DBID` 会被 parseSerializationSchema 拒掉(不在 SCALAR_FAMILIES)→ 字段静默丢弃 → 访问死路;改 `UINT64`(SER-10 自家 fixture 用的就是 UINT32,不照抄设计文档示例);
2. **掩码行键列**:引号串在掩码行成下划线段,键内容须同列切原文行;引号字符本身也被掩码(串 token 全掩),`argMaskedTrim.startsWith('_')` 判定因此成立——引号含在切片内,键取 `slice(1,-1)`;
3. **类体作用域**:class 体也是执行作用域,类体赋值遮蔽模块名——enclosingDef 覆盖 class 头(params 空集),类体写点命中即跳过;
4. **`get` 原文切片引号形态复核**:掩码判定 `^_+$` 后仍须 `isQuotedLiteral` 复核原文(容错拒绝,不猜)。

## 门禁

compile 0 / eslint 0 / vitest 全量 783 文件 9771 过 + 4 skip(RC=0)/ xvfb demo 25 RC=0;分面先行:configFieldAccess 17 例 + jsonChainPropagation 48 例(44 旧 + 4 新 json.load 面)全绿后跑全量。
