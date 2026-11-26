//! `$/kode/messageTable/build` handler (batch 123 pure-logic core of the message numbering table).
//!
//! From def text (read from disk and passed through by the TS side) produce a MessageTable JSON that matches TS `buildMessageTable` field for field:
//! method/property utype assignment, domain-bit conflicts, alias ids,
//! component slots, types.xml user types. Input = `{entityName, defText, typesXml,
//! defs: {name: text}, paths: {name: path}, aliasIdEnabled}`; output =
//! the full-shape MessageTable JSON (clientMethods/clientProperties carry the full entry set, matching
//! the object returned by TS buildMessageTable; the renderer handles reduced serialization).
//!
//! Engine semantics are aligned item-for-item with the TS implementation (see the src/messageTable.ts module header note); not repeated here.
//! The only difference is the **parsing base**: TS uses fxp + parseLocalDefinition, Rust uses the kode-parser
//! xml state machine (equivalent fault-tolerant parsing); the raw text of `<Utype>`/ARRAY `<of>` chains/`<Flags>`
//! is extracted here from the xml Document (PropertyDef/MethodDef do not carry that granularity).

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

/// Register the `$/kode/messageTable/build` RPC handler.
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
