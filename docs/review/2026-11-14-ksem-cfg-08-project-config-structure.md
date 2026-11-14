# KSEM-CFG-08(SEM-038)项目配置结构提取 — 批次纪实

日期:2026-11-14。todo.md SEM-038(旧 KSEM-CFG-08):提取项目配置结构。验收:显式 schema 优先,其次静态构造和可证明读取约束;动态 key/多文件冲突保持开放并提供来源。

## 交付面

- **纯核 `src/backend/configProjectStructure.ts`**(零 vscode 零 IO):`deriveProjectConfigStructure(files: {file, text}[], schema)` → `{entries, pathConflicts}`。证据三级(todo 验收同序):
  - **explicit-schema(显式 schema 优先)**:`.kbengine/serialization.json` 绑定表(SER-08 机制)每个 path glob 一个条目,fields 用 schema.types 映射(CFG-07 类型面同构);条目序也在前(explicit-schema 恒先于 static-construction)。同一 glob 跨 loads/load 两表声明不同 type → 不裁定:typeId 置 null、fields 空、open=true + binding-type 冲突(带各方 typeIds + schema 来源);
  - **static-construction(静态构造)**:SER-09 逐文件模块作用域字典推导(`deriveDictFormats`,作用域纪律原样继承);跨文件同名:形状一致 → 合并来源(一条目双方 sources);形状分歧 → 不裁定、open=true + literal-shape 冲突(双方来源),一致键仍保留在 fields(分歧键摘除,不取首见不取多数);终局 unknown 的模块名不作结构证据;
  - **可证明读取约束**:代码内 `json.loads(串字面量)` / `json.load(open(串字面量))` 具体路径(v1 同行、属性形态;掩码判定 `^_+$` + 原文 `isQuotedLiteral` 复核)命中绑定 glob → 条目 `readers` 登记 {file, line(0 基)};一个具体路径命中同表多个 glob 且 type 分歧 → `pathConflicts` 显式报出(matches 列各方 glob+type + 读取点来源)。**CFG-07 类型面对歧义是静默双 null,本面把它翻成显式冲突并给来源;命中条目的 readers 照登(命中事实为真,不因冲突抹掉)**。
- **共享面导出三处**(消费复用,零行为变化):configFieldAccess `mapSchemaType`/`mapDictValueKind`/`matchBracket`/`topLevelCommas` 加 export;jsonChainPropagation 新 `schemaGlobMatches(pattern, path)`(SER-08 fnmatch 语义,RegExp 缓存共享)。

## 诚实边界(v1 明示,不写成已实现)

- fields 只收「各方一致」键位:某方缺键/值类型分歧 → 该键摘除;分歧整体由 open + conflicts 表达;
- 动态 key(open)条目只报已观测键,宇宙开放;SER-09 「开放宇宙零观测 → 无形状声称」语义照收(该名不入注册表);
- 变量路径/f 串/多实参 loads/跨行调用/裸名 `from json import` 面 v1 不入读取面(注册表只收零歧义的字面证据);
- 未绑定路径零声称(不硬造条目);schema=null 时仅静态构造面,读取面零声称;
- 同名跨模块本质是不同变量,合并面是「项目配置视角」的约定证据(v1 明示,分歧即开放不裁定);SER-09/SER-08 的同名跨作用域不合流、歧义不取首条纪律原样继承。

## prove-red(字节还原闭环)

1. 路径冲突显式化面:`distinctTypes.length > 1` 判定短路 → 1 红(多 glob 分歧例)→ `cp` 备份 + python 替换 + 还原 `cmp` 字节一致;
2. 跨文件形状分歧开放面:open 计算摘除 `|| diverged` → 2 红(分歧开放例 + 一致键保留例)→ 还原 `cmp` 字节一致。

## 坑账

1. **掩码折叠坑(新形态)**:`pythonCodeLines` 把串 token 折成**单 `_` + 空格补位**(列保持但长度不等)——原文切片必须按段全距(`openAt+1+lead` 到段末)切,不能按 `trimmed.length` 切(CFG-07 走的是括号位切片,同律不同形);首版按长度切只取到引号字符,`isQuotedLiteral` 复核拒绝 → readers 全空;
2. **探针 JSON 假象**:`JSON.stringify` 把 `Map` 序列化为 `{}`——探针看到 open observed `{}` 误判 SER-09 丢键,实为探针 dump 缺陷;用 pinned 夹具(`d = {"a": 1}` + `d[k] = 2` → open observed {a:int})单测断言核实 SER-09 无回归(git diff 空);
3. **SER-09 零观测诚实语义**:`CFG = {}` + 变量键写 → open 零观测 → 整名不入 map(SER-09 `observed.size === 0 → null`);CFG-08 测试夹具照 pinned 形态(先有观测键再动态写),不照设计文档脑补;
4. **测试夹具 schema 混入**:static-only 面的测试忘传 schema=null → entries 混入 2 个 explicit-schema 条目,length 断言全偏;分级断言要么过滤 key 要么 null schema。

## 门禁

compile 0 / eslint 0 / vitest 全量 784 文件 9785 过 + 4 skip(RC=0)/ xvfb demo 25 RC=0;分面先行:configProjectStructure 14 例 + configFieldAccess 17 例 + jsonChainPropagation 48 例 + dictFormatDerivation 44 例全绿后跑全量。
