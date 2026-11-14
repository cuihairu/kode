# KSEM-CFG-11(SEM-041)配置负例集 — 批次纪实

日期:2026-11-14。todo.md SEM-041(旧 KSEM-CFG-11):建立配置负例集。验收:覆盖自定义合法键、重复节点、环境覆盖、缺文件、多根、JSONC、敏感值和版本差异;不允许默认值推断产生伪错误。

## 交付面

**`tests/configNegativeCorpus.test.ts`**(20 例,零 vscode 依赖;真实引擎 defaults 夹具做基线 + 合成负例形态),八轴全覆盖 + 反伪错误闸:

1. **自定义合法键**:有源码类型证据的键给合法值(boolean/integer/枚举文档值)→ 零诊断;用户自有工具键(引擎目录没有)→ `unknownKey` 仅 **information**(引擎容忍忽略),绝无 error/warning——负例集不是「全部报错」,是「不许假阳性」;
2. **反伪错误闸(验收核心句)**:defaults-value-only 记录(只有默认值形态,无类型注释/读取点证据)给怪值 → 零诊断——证据闸把值形态挡在类型面外,不从默认值猜类型;
3. **重复节点**:同名重复叶同坏值 → 去重后**一条**(行锚=首现行);不同坏值 → 两条(args 不同);合并面整表替换不崩,重复条目都保留(mergeConfigXml 整表替换语义钉);
4. **环境覆盖**:profile overrideRoot 只认自己的资产根——overrideRoot 下无 kbengine.xml = 该 profile 无元件配置(纯 defaults),**绝不回落工作区/设置链**(回落即读到别的项目的配置);res/server 子路径次序探测钉;
5. **缺文件**:空 custom 树 → 零值诊断;defaults 缺 → 关系检查零声称/键影响 null(不硬造);serialization.json 缺(schema=null)→ 绑定面静默零声称(**不报 uncovered 噪音**——没有 schema 就没有基线,不是「全未覆盖」);
6. **多根**:parseConfigXml 空名包裹保留全部顶层元素,normalizeRootNode 取 `<root>`;游离顶层元素不入树路径 → 不产生任何诊断(不猜);
7. **JSONC**:serialization.json 是工具生成的严格 JSON——手写注释/尾逗号 → `schema=null` + 显式错误 `'schema is not valid JSON'`,类型面静默零声称(不硬猜不报伪错);结构面诚实降级到纯静态构造面;
8. **敏感值**:string 类型敏感键(password)永不类型检查 → 无诊断无明文;来源证据块 + 修改影响块只出脱敏形态(`p***`,明文不入渲染);
9. **版本差异**:schema_version=2 照收(整数,不按版本分叉行为,绑定照常);非整数 → version=null + 显式错误但 schema 其余面照常解析;**旧版 defaults 快照**缺段 → 段本身 dynamic-extension、段下叶子 dynamic-segment-child(归并到段边界),unknownKey boundary=段名,severity=**information 非error**(版本差异=容忍面,不是报错面)。

**代码改动(一处)**:`configValueValidation.computeConfigValueFindings` 增 finding 去重(路径/行/码/文案参数完全相同只留一条)——custom 重复同名叶产生同路径同锚的重复 finding,同坏值只报一条;不同坏值两条都留。既有 15 例值校验测试零改动全绿。

## 诚实边界(负例集定「容忍语义」,不写成「全部该报错」)

- JSONC 拒收是**当前正确行为**(工具生成的严格 JSON;手编 JSONC=失去全部类型面且无警告——已知限制,记录在案不掩盖);
- 游离顶层元素静默(树消费面只见 root;文本面 configPathLineIndex 见得到但诊断面走树);
- schema_version 缺失/非整数只降版本字段不弃整个 schema(部分诚实解析,错误显式带出);
- 环境覆盖面只钉资产根覆盖轴(res.server 子路径序);环境变量面(KBE_*)是引擎二进制面,不入本 XML 车道。

## prove-red(字节还原闭环)

1. **反伪错误闸**:TYPE_EVIDENCE 加 `defaults-value-only`(默认值推断造伪错)→ 反伪测试 1 红 → `cp` 备份 + python 替换 + 还原 `cmp` 字节一致;
2. **重复节点去重面**:摘去重过滤 → 目标例红(含 6 例连带红,共享返回路径)→ 还原 `cmp` 字节一致,20 例复绿。

## 坑账

1. **键的段位要与 defaults 对齐再断言**:gameUpdateHertz 在引擎默认里是**顶层键**不是 baseapp 段键——custom 放错段位=dynamic-extension→unknownKey(合法容忍),反伪测试先探记录真实路径再钉(裸键 value-only);
2. **dynamic-extension vs dynamic-segment-child**:段本身(dbmgr)= extension,段下叶子= segment-child(归并边界);断言分类要按「首个缺失段」语义走,叶子恒是 child;
3. **grep -v 无匹配退出码 1**:tsc 零输出时 `tsc | grep -v 'npm warn'` 管道在 pipefail 下报 1——grep 无匹配即 1,不是 tsc 红;验 RC 要用 `${PIPESTATUS[0]}` 或直跑;
4. **value-only 记录有 valueKind 但不可用**:records 里 value-only 记录带 valueKind='integer' 形态,但证据闸挡住它进类型面——负例集先钉 record.evidence==='defaults-value-only' 再断言零诊断,防止未来闸松动无声回归。

## 门禁

compile 0(tsc 直跑 exit 0)/ eslint 0 / vitest 全量 787 文件 9844 过 + 4 skip(RC=0)/ xvfb demo 25 RC=0;分面先行:configNegativeCorpus 20 例 + configValueValidation 15 例全绿后跑全量。
