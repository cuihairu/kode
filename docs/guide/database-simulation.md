# 数据库模拟

[English](./database-simulation.en.md) | [中文](./database-simulation.md)

命令 `kbengine.database.simulate` 在数据库 schema 快照之上模拟「建表 + 首批行数据」,打开一个 `.dbsim` 虚拟文档;`kbengine.database.exportSimulation` 把当前模拟文档导出为 Markdown。模拟口径逐条对齐引擎 dbmgr/baseapp 的 MySQL 落库实现(kbe/src/lib/db_mysql / kbe/src/lib/db_interface),所有差异在文档尾部如实列出。

## 模拟什么

| 块 | 内容 | 引擎出处 |
| --- | --- | --- |
| DDL | 每表 `CREATE TABLE IF NOT EXISTS`,含 `id bigint(20) unsigned AUTO_INCREMENT`、`PRIMARY KEY idKey (id)`、`) ENGINE=InnoDB` | `entity_table_mysql.cpp:390-395` |
| 子表列 | `parentID bigint(20) unsigned NOT NULL` + `INDEX(parentID)` | `entity_table_mysql.cpp:379-380` |
| autoLoad | `sm_autoLoad tinyint not null DEFAULT 0` | `entity_table_mysql.cpp:416-418` |
| 列名 | 顶层 `<fdName>_` 前缀,嵌套累积 key 名,VECTOR 索引在前,ARRAY 子表 `values`/反转祖先链 | `entity_table_mysql.cpp:215-231`、`:1486-1498`、`:268-272`、`:1228-1257` |
| 逐类型 DDL | INT8-64/UINT8-64 → `tinyint`..`bigint`;FLOAT/DOUBLE → `float`/`double`;STRING/UNICODE → `varchar(N)`;PYTHON/PY_DICT/PY_TUPLE/PY_LIST/BLOB → `blob`(无 NOT NULL/DEFAULT);VECTOR2/3/4 每分量 `float not null DEFAULT 0` | `entity_table_mysql.cpp:505-763`(`createItem`) |
| 宽度缺省 | 数字列未写 `<DatabaseLength>` 时是 `int not null DEFAULT 0`,不是 `int(11)`——引擎对空长度整段剥掉 `(@DATALEN@)` | `entity_table_mysql.cpp:1643-1659` |
| varchar 缺省 | 未写 `<DatabaseLength>` 时长度 255 | `entity_table_mysql.cpp:1829-1833`、`:1899-1903` |
| 持久性 | 只有小写完全等于 `true` 的 `<Persistent>` 属性进列;缺节点 = false | `entitydef.cpp:1178-1188` |
| 索引 | `<Index>` 建索引并转大写;STRING/UNICODE/PYTHON/BLOB 建索引强制要 `<DatabaseLength>`;`<Identifier>true` 只进 def md5,不建索引 | `entity_table_mysql.cpp:292-334`、`:317-332`;`entitydef.cpp:1221-1239` |
| 行数据 | 根表 1 行、组件子表 1 行、ARRAY 子表默认 2 行(`rowsPerChildTable`),parentID 取父表首行 id,行 id 全局递增 | 模拟器约定,源码注释登记 |
| INSERT 语句 | `insert into tbl_X (cols) values(...);`,不含 `id` 列(引擎 INSERT 同形,新 id 来自 `mysql_insert_id`) | `sqlstatement.h:69-122`、`:128-145` |
| sm_autoLoad | 导出 INSERT 并入 `sm_autoLoad` 便于单语句重建;引擎实际由 `entityShouldAutoLoad` 单独 UPDATE | `entity_table_mysql.cpp:766-775`;`baseapp/entity.cpp:1144-1151` |

## 与真实引擎的差异(11 条,导出文档尾部同样列出)

1. redis 后端不模拟:引擎另有 `kbe/src/lib/db_redis`,快照与模拟按 mysql 单口径(审计块19 遗留①)。
2. 列序按快照文档序;引擎 CREATE 只含 id/parentID,其余列经逐列 ALTER 追加,物理列序取决于 ALTER 时序(`entity_table_mysql.cpp:390-395`、`:51-57`)。
3. 无外键:引擎 DDL 无 FOREIGN KEY/REFERENCES,子表仅靠 parentID 逻辑关联,导出 DDL 同形。
4. UNIQUE 冲突引擎不做写前校验,由 MySQL 索引失败令 writeTable 返回 0(`dbmgr.cpp:1044-1066`;`kbe_table_mysql.cpp:187`/`:352` 的 1062 分支已注释);模拟器改为预检并报 `unique`——这是模拟器比引擎多做的事。
5. AUTO_INCREMENT 起点模拟取 1;引擎读 dbInterface `<autoIncrementInit>`(`serverconfig.cpp:1043-1045` → `db_interface_mysql.cpp:775-787`)。
6. ARRAY 子表行序 = 子表行 id 升序;引擎 UPDATE 按升序逐位覆盖、多余行删除(`write_entity_helper.h:92-230`);模拟增改删按 id 寻址,不实现按位置覆盖。
7. 引擎 INSERT 不含 id(AUTO_INCREMENT)且 sm_autoLoad 由 entityShouldAutoLoad 单独 UPDATE(`entity_table_mysql.cpp:766-775`);导出 INSERT 并入 sm_autoLoad 以便单语句重建整行。
8. varchar 长度取 DatabaseLength 缺省 255(`entity_table_mysql.cpp:1829-1833`);引擎在线比对另有 MBMAXLEN(=3) 折算(`db_interface_mysql.h:16-18`),模拟不折算。
9. 数字列 DEFAULT 引擎按 def `<Default>` 原文插值,非数字默认会让 MySQL 建列报错;模拟按数值解析,解析不动落 0。
10. 引擎子表行恒有父 id(parentID NOT NULL);模拟允许 parentID=0 表示无父行,仅出现在父表无模拟行的嵌套场景。
11. bigint 边界值经 JS number 有舍入,|值| > 2^53 时型别校验按舍入后的值判定(引擎为 uint64 精确值)。

## 行校验语义

`applyRowOperation` 走严格引擎语义:任一校验不过即整条语句被拒,存储保持操作前状态(clone 后操作,不改入参)。校验项:

- 表/行不存在(`unknown-table` / `unknown-row`);
- INSERT 的 values 带 `id` 列(引擎 INSERT 不含 id)或直写 `parentID`(`orphan-parent`);
- 整数列按 mysql 区间校验(tinyint -128..127 到 bigint ±2^63,unsigned 到 2^64-1,BigInt 精确比较);
- 浮点列要有限数值;varchar 超长报错;blob 只收字符串;
- UNIQUE 列冲突(update 时排除自身行)——见差异第 4 条,引擎不做这层预检;
- DELETE 递归级联清子表行(待删 id 闭包,等价 `remove_entity_helper.h:38-46` 先删子后删父)。

## 入口与导出

- `Simulate Entity Database`(`kbengine.database.simulate`):不传实体名时取当前活动 `.def` 文件推断;打开 `.dbsim` 虚拟文档(内存生成,不落盘)。
- `Export Entity Database Simulation`(`kbengine.database.exportSimulation`):在 `.dbsim` 文档里执行,保存为 Markdown;导出内容 = DDL + 行 JSON + INSERT 语句 + 差异清单。

schema 快照本身由 `Open Database Schema`(`kbengine.database.open`)同源产出,表结构与列名的更多细节见其虚拟文档头部。
