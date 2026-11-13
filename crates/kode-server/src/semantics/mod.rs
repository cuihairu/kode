//! KBEngine 共同语义模型(KSEM-BAS,设计
//! docs/design/kbengine-semantic-precision-and-process-flow.md §4)。
//!
//! 落地位置=现有 crate 边界内(kode-server,已依赖 kode-types/kode-index/
//! kode-parser/kode-python,不另起解析器)。Rust 负责语义事实与查询,
//! TS 负责文档/工作区输入、交互与呈现(消费边界见 [`query`])。
//!
//! 模块与 todo.md 原子任务对应:
//! - [`id`] BAS-03 语义身份(工程/资源根/实体/角色/组件/声明稳定 ID,
//!   同名跨工程与 Base/Cell 不串联);
//! - [`types`] BAS-04 结构类型表达式(标量/范围/别名/数组/固定字典/组件/
//!   实体引用/可空/联合/未知;字段名/声明序/源码位置保留);
//! - [`snapshot`] BAS-05 有效实体声明快照(Parent/Interfaces/组件展开,
//!   覆盖与冲突记录;缺失/环/多候选不任取一个);
//! - [`facts`] BAS-06 事实与诊断证据(声明事实/代码推导/未知/冲突 +
//!   来源路径;未知不自动转错误);
//! - [`expr`] BAS-07 Python 表达式来源(Ruff AST 属性/下标/调用/局部赋值;
//!   别名重绑定失效;同行按列序);
//! - [`store`] BAS-08 带版本查询快照(文档 overlay + 工程代数;过期构建
//!   不覆盖新版本;删除/重开清理事实;工程视图 = fold 确定性折叠);
//!   [`ProjectDefResolver`] 为工程级 def 解析(文件名字根 = 类型名);
//! - [`deps`] BAS-09 增量依赖边(def/types/Python/config → 消费文件反向
//!   依赖;单文件变更只失效相关项;级联失效有界 BFS,删除对称清理);
//! - [`query`] BAS-10 共享查询契约(Rust 事实查询与 TS/LSP 消费边界;
//!   同一结构供 hover/completion/definition/diagnostics;缺服务降级)。
//! - [`cell`] CELL-01/02 cellData 字段集与引擎内建键(有效 Cell 属性表,
//!   继承/接口展开复用 BAS-05;缺 Cell 脚本/无 Cell 部件分状态;内建键
//!   position/direction 独立引擎来源封闭表;组件槽展开归 CELL-03)。
//! - [`refs`] RPC-01..03 角色化引用类型/self 角色绑定/引用别名传播(
//!   EntityCall<类,调用类型> 与本地 Entity 区分;七种调用类型的目标面表
//!   归属/自名闸/面跳全矩阵;ENTITYCALL 字段取值接受=EntityCall/None/Entity
//!   按源码;类未知保持未知不猜;`bind_self_role` 逐面逐属性绑定
//!   self.base/cell/client——cellapp 的 self.client=CLIENT_VIA_BASE 陷阱钉死,
//!   转发链=绑定+面跳复合;`AliasTable` 别名传播——重绑定即遮蔽不回落旧引用、
//!   合流异值成候选不任取、未知不按同名方法猜)。
//! - [`dispatch`] RPC-04 方法/组件槽落点(只查对应面 Methods 段——远程句柄
//!   分面=调用类型目标面,本地引用=脚本面;组件槽远程路径查组件自身 def
//!   模块对应面表,本地真身=plain Python 派发、def 同面声明缀附;
//!   def + Python 实现双跳转,歧义多候选全列;类未知/面缺声明/槽缺失
//!   一律 Unknown 带因不硬造)。
//! - [`callers`] RPC-07 特殊 caller 规则(EXPOSED_AND_CALLER_CHECK 四语境
//!   分开:传输/调用点恒按 def 声明位——callerID 不上流、调用点永不传;
//!   实现位仅 cellapp cell 段 exposed 注入恰多一参;启动对账 exposed+1
//!   升级/其余拒;base·client 段实现+1=静默升级但运行时必 TypeError;
//!   expected_arity 按侧取数,两侧共用一个数必出一向误报)。
//! - [`broadcast`] RPC-08 广播调用语义(allClients/otherClients 接收者集合
//!   逐项登记:allClients=自己客户端+全部观察者客户端、otherClients=仅观察者
//!   可零收,绝不画成单客户端;仅 cellapp 进程有此属性,base/client 语境
//!   AttributeError;广播只查 client 段,组件广播查组件自身 def 模块并透传
//!   标志,宿主同名不混入;client 段未命中回落属性臂,快照缺不判缺失)。
//! - [`impact`] RPC-09 RPC 修改影响查询(方法/Arg 变更 → 确定调用点/
//!   不确定候选/不受影响三桶分诊,过近似纪律宁可候选不漏报;索引覆盖态
//!   由消费方显式声明,Partial/Missing 不构成零影响依据;no_impact_claim
//!   只在覆盖完备∧两列表皆空才产结论——零影响红线钉在 API 形状上)。
//! - [`create_api`] CREATE-01 创建 API 契约表(九 API 逐条登记签名/同步
//!   返回/回调形态/callable 闸/结构前置+引擎出处;同步返实体仅两个本地
//!   API;回调三分=单参实体|句柄、三参 OKi、onGetCell 无参;callable 闸
//!   两分=非 DBID 静默忽略 vs DBID 族 AssertionError;FromDBID 失败通知
//!   不闭合=None/False/静默丢三态并存;直连闸 BASE/CELL 分明)。
//! - [`entity_name`] CREATE-02 创建 API 实体名解析(字面量→目录解析+所需
//!   段检验,缺段分引擎硬闸(InNewSpace hasCell)与结构缺两档;前缀候选=
//!   补全面;动态名=Unknown 不猜;目录未就绪=IndexMissing 绝不判 Missing)。
//! - [`create_return`] CREATE-03 创建 API 返回值推导(同步返实体仅两个
//!   本地 createEntity,类名按 entityType 字面量、动态名 Unknown 不硬造;
//!   七条异步 API 调用表达式=AsyncNone 绝不视作本地对象;回调交付面=
//!   单参实体|ENTITYCALL 句柄联合、三参 Nullable 实体+DBID+wasActive、
//!   cell 族 onGetCell 浮出;查无此 API=None 不猜)。
//! - [`create_bind`] CREATE-04 异步创建回调绑定(可解析 bound method/
//!   函数逐形参赋型:单参=实体|句柄联合、三参=Nullable+DBID+UINT8;
//!   失败值面逐族登记=首参 None/id 分配失败单参 False/实体化失败不触发;
//!   形参数错=ArityMismatch;动态回调=Unresolved 不猜;未传=合法缺省;
//!   契约无参位=NoCallbackSlot,cell 族浮出走 onGetCell)。
//! - [`create_params`] CREATE-05 初始化参数字典检查(params 逐键按
//!   createNamespace 三路分诊:cellData 特殊键必须 dict、def 属性普通/
//!   cellData 两通道、def 未声明键=动态 setattr 不拦提示级;缺键不报=
//!   initProperty 默认值兜底无必填概念;字面量值家族对拍=静态纪律提示级
//!   非引擎错误预测;目录未就绪=IndexMissing 绝不判未声明)。
//! - [`create_target`] CREATE-06 Cell 创建目标检查(仅报告静态可证明的
//!   角色和类型错误:目标 EntityCall 角色闸=cell 族要 CELL/remotely 族要
//!   BASE 直连,角色未折叠=Unknown 不报;spaceID 存在性=运行时态登记
//!   RuntimeGate 不判;inNewSpace 非 int 静默兜底 0/负数回绕=提示级)。
//! - [`rpcargs`] RPC-06 普通 RPC 参数类型校验 + 深审-2 def `<Arg>` 文本
//!   转换桥(`arg_text_to_sem_type`:内建直映、两端 trim、有图走
//!   `from_type_graph` 递归(alias/ARRAY/FIXED_DICT/UserType);无图或图缺
//!   =Unknown 带原文,绝不默认 PYTHON——PYTHON 可 pickle 全接受,默认它
//!   =吞光全部 mismatch;显式 `<Arg>PYTHON</Arg>` 才是合法 PYTHON)。
//! - [`store`] 深审-1 def 解析按引用类别分池(`ReferenceKind` 三池=
//!   entities/interfaces/components 目录约定,引擎 Parent 按当前池递归;
//!   `def_kind_from_key` 按路径判池、resolve 类别+名双匹配,同名接口/
//!   父实体/组件/实体跨类别不串接;`EntitySnapshot::build` 增 own_kind,
//!   组件 def 的 parent 链走组件池)。

pub mod broadcast;
pub mod callers;
pub mod create_api;
pub mod create_bind;
pub mod create_params;
pub mod create_return;
pub mod create_target;
pub mod entity_name;
pub mod impact;
pub mod cell;
pub mod dispatch;
pub mod refs;
pub mod rules;
pub mod rpcargs;
pub mod deps;
pub mod expr;
pub mod facts;
pub mod id;
pub mod query;
pub mod snapshot;
pub mod store;
pub mod types;

pub use id::{Facet, SemId, SemKind};
pub use types::{FieldDef, SemType};
