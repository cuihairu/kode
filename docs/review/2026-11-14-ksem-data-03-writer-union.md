# KSEM-DATA-03(SEM-044)合并多写者类型 — 纪实

日期:2026-11-14。todo.md SEM-044(旧 KSEM-DATA-03):合并多写者类型。验收:不同写入点类型形成联合及来源说明;只有声明契约冲突才报错,正常多态不误报。

## 交付面

### 联合面(现状确认,零改动)

- inlay/hover 读点联合多写点值类型(`: int | str`,去重保序)——DATA-01 审计已钉现状,本批不重做;写点 RHS 推不出的写点本就不入联合(inferDataDictValueType null 诚实跳过)。

### 来源说明(本批新面,`src/languageProviders/hover.ts` buildDataDictHover)

- 读点悬停联合 ≥2 类时逐类型列出产源写点:`- int ← writerA.py:2`(同类型多写点标签聚合一行,`writerA.py:2, writerB.py:5`);联合单类(含单写者)保持既有渲染(首个写点行即来源),既有钉(globalDataIndex.provider.test.ts `首个写点`)不破;
- 类型推不出的写点:不入联合,联合 ≥2 类时条数如实补记(`另有 N 处写点类型不可推(不入联合)`);
- 标签去重:同文件同行多记录(调用键展开等)不重复列。

### 「只有声明契约冲突才报错」的裁定(诚实缺口,零诊断)

- **引擎三共享字典(globalData/baseAppData/cellAppData)无声明契约面**:键值即 pickle 的任意 Python 对象,引擎无 schema/无 types.xml 声明/无注解面——「声明契约冲突」在这三字典上**没有触发面**;
- 全仓核查:`dataDictIndex` 消费面=completion/definition/references/hover/inlay 五个信息面+装配,**零诊断发射面**(diagnostics.ts/diagnosticScheduler.ts 均不消费索引);
- 裁定:写点间类型分歧(int|str)=正常多态,如实并陈不裁剪、不出冲突措辞;若未来出现声明机制(如用户侧 schema 登记),冲突检查应挂在那张声明表上,不挂在本索引——已记录在差距账,不预造。

## 测试(`tests/dataDictWriterUnion.test.ts`,5 例)

联合 ≥2 类逐类型产源(int←A/str←B+条数+首写点照常)/同型多写点聚合(单类不出逐类型行,`|` 不出现)/不可推写点补记(3 写点 2 可推,另有 1 处)/单写者渲染不铜变(无 `- ` 行)/正常多态不误报(悬停含 union 无「冲突」无 error,inlay 照常 `: int | str`)。

## prove-red

摘来源说明块(`types.length >= 2` 改永假)→ 2 例红(联合产源例+不可推补记例),精确落在来源说明面;cmp 字节还原后 5/5 复绿。

## 锚点

本批 hover.ts 净 +24 行全部在 buildDataDictHover 体内(anchors 面 provideHover :313 之前不受影响),ANCHORS/baseline 无位移——perfCallChainDoc 4/4 复绿确认。

## 坑账

1. **测试草稿占位混入**:首版「同型多写点」例写了半截占位码(带 label break 的残句)——写完即自审文件全文,残句 vitest 变换期就报,不等人;
2. **既有钉不破优先于新渲染**:首个写点行保留(单类联合时它就是唯一来源说明),逐类型行只在 ≥2 类时追加——新面以追加而非替换落地,单写者/单类路径字节级不铜变。

## 门禁

compile 0 / eslint 0 / vitest 全量(见 todo.md 勾行时点数)/ xvfb demo 25 RC=0。
