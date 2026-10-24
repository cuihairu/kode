//! kode-parser:KBEngine `.def` / entities.xml / types.xml / alias.xml 逐字节解析器
//! (kode2 PR-005,书 §6.1/§17 PR-005 基础版)。
//!
//! 模块:
//! - [`xml`]:字节级 XML 状态机,arena 树 + 精确 span + 容错恢复(SYNTAX-002/003);
//! - [`diag`]:结构化诊断 / Span / LineMap;
//! - [`model`]:`.def` 语义(属性/旗标/方法/组件/继承)、entities/types/alias
//!   提取,未知字段保留(SYNTAX-005,SEM-006..008 基础);
//! - [`dep`]:增量重构注册表(指纹零重建 + 反向依赖索引,VFS-011 复用);
//! - [`json`]:对拍 golden 序列化(零依赖 JSON 写出)。
//!
//! 铁律:除密码学外零第三方 crate(本 crate 仅依赖 workspace 内 kode-vfs);
//! 任何输入不 panic(见 tests/blind.rs 变异抽验)。

pub mod dep;
pub mod diag;
pub mod json;
pub mod model;
pub mod xml;

pub use dep::{FileKind, ParseRegistry, ParsedUnit, RefSet, UpdateReport};
pub use diag::{DiagCode, Diagnostic, LineMap, Severity, Span};
pub use model::{
    parse_alias, parse_def, parse_entities, parse_types, AliasDecl, AliasFile, ChainNode,
    ComponentDef, DefFile, EntitiesFile, EntityEntry, MethodDef, MethodSection, PropertyDef,
    TypeDecl, TypeKind, TypesFile,
};
pub use xml::{mask_def_pseudo_comments, parse, Attribute, Document, ElementData, Node, NodeData};
