//! `$/kode/messageTable/build` handler(批123 消息编号表纯逻辑核心)。
//!
//! 从 def 文本(TS 侧已读盘直传)产出一张与 TS `buildMessageTable` 逐字段
//! 一致的 MessageTable JSON:方法/属性 utype 分配、域位冲突、别名 id、
//! 组件槽、types.xml 用户类型。输入 = `{entityName, defText, typesXml,
//! defs: {name: text}, paths: {name: path}, aliasIdEnabled}`;输出 =
//! MessageTable 全形 JSON(clientMethods/clientProperties 为全量条目,与
//! TS buildMessageTable 返回对象一致,渲染器负责缩减序列化)。
//!
//! 引擎语义与 TS 实现逐条对齐(src/messageTable.ts 模块头注),此处不复述;
//! 差异只在**解析基座**:TS 用 fxp + parseLocalDefinition,Rust 用 kode-parser
//! xml 状态机(等价的容错解析),`<Utype>`/ARRAY `<of>` 链/`<Flags>` 原文
//! 在此从 xml Document 提取(PropertyDef/MethodDef 不带这些细粒度)。

mod aliases;
mod assembly;
mod builder;
mod components;
mod constants;
mod json;
mod methods;
mod properties;
mod render;
mod source;
mod types;
mod views;

use serde_json::Value;

use crate::rpc::RpcRegistry;
use builder::build_table;

/// 注册 `$/kode/messageTable/build` RPC 处理器。
pub fn register(reg: &mut RpcRegistry) {
    {
        reg.register("$/kode/messageTable/build", build_handler);
    }
}

pub(super) fn build_handler(params: Value) -> Result<Value, String> {
    {
        build_table(&params)
    }
}
