# KSEM-CFG-03 统一配置字段身份(2026-11-14)

验收口径(todo.md SEM-033,旧 KSEM-CFG-03):以配置根/层级路径/工程/版本
定位字段;map 动态键与固定对象字段区分。

交付物:字段身份纯核心 `src/backend/configFieldIdentity.ts` + `tests/
configFieldIdentity.test.ts`(11 例)。CFG-01 登记册/CFG-02 契约之上的
定位层。

## 身份四轴

- **root**:`defaults`(引擎默认)/`custom`(项目覆盖文件)/`final`
  (合成最终配置);
- **path**:点分层级路径(去 `<root>` 包裹,与 catalog/CFG-02 同口径;
  容器段也是可定位字段——整段覆盖是 kbengine.xml 常规实践);
- **project**:工程标识(调用方传入资产根指纹;null=纯引擎默认;串内
  空槽序列化,不容 `@`/`/`——往返完整性优先);
- **version**:引擎快照锚(如 `kbengine-defaults-942`,与 CFG-02 baseline
  同源)。

身份串 `{root}://{project}@{version}/{path}`,动态段名后缀 `~` 标记
(`final://proj-a@kbengine-defaults-942/myservice~.host`),解析往返
(`parseConfigFieldIdentity`);非良构(坏 scheme/缺版本/空路径/project 含
`@`)一律 null——不猜。

## 动态键区分(结构观察面,与 CFG-02 行为面互补)

CFG-02 的 `dynamicKeys` 是「引擎是否迭代未知子节点」的行为面(无证据不
记);本模块是**结构观察面**——字段在双树中的存在性直接可证:

| kind | 判据 | 语义 |
|---|---|---|
| `fixed` | defaults 快照可枚举 | 引擎固定对象字段 |
| `dynamic-extension` | 只在 custom 树(路径末端缺失段) | 项目自加叶子/段 |
| `dynamic-segment-child` | 父段是 custom 独有段 | 动态段的子字段(**只有首缺段入 dynamicSegments,后代不重复登记**) |

溯源四布尔:`definedInDefaults`/`definedInCustom`/`overriddenByCustom`
(defaults+custom 同在)/kind;`scanConfigFieldIdentities(defaultsTree,
customTree)` 双树全量对扫(并集路径逐条分类,统计分桶恰分全部记录;
真夹具 942 行 defaults 单树扫描 fixed-only)。

## 坑账

1. `parseConfigXml` 产物是空名合成文档节点(真 `<root>` 是其子)——身份
   模块入口 `normalizeRootNode` 归一(CFG-02 walk 因 `name==='root'` 重置
   前缀恰好幸免;本模块逐段下行无处可幸,必须显式归一);
2. 首缺段后的后代段曾全量入 `dynamicSegments`,导致 `myservice.host` 被
   判成第二个动态段——改为只记**首缺段**,`lostAtIndex < 末段` 判段子
   字段;
3. version 正则曾容 `@`,`pro@ja@v/a.b` 会以 project='pro'/version=
   'ja@...' 静默错拆——收紧 `[^/@]+`,错拆输入整体不匹配返回 null;
4. vitest console.log 静默(既有坑)——探针落盘 `/tmp` 文件再读。

## 消费面

SEM-034 补全(父路径限定可用 key=身份的 path 前缀查询)、SEM-035 校验
(fixed 字段走契约,dynamic-extension 走容忍分级)、SEM-036 跳转(身份串
作为跳转目标键)。

## 门禁

compile 0 / eslint 0 / vitest 全量 9711+4skip RC=0 / xvfb demo 25 RC=0;
prove-red:段子字段不区分 + `~` 标记不剥 → 4 红(动态段往返×2/段子字段/
分桶),还原 cmp 字节一致全绿。
