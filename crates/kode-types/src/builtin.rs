//! 引擎内建类型表(对齐 engine DataTypes::getDataType 注册名;TS 侧
//! `tests/kodeTypesParity.test.ts` 持同一清单副本,双侧一致才可对拍)。
//!
//! 口径来源:src/databaseSchema.ts `SIMPLE_DB_TYPE_LABELS` + VECTOR2/3/4。
//! `ARRAY`/`FIXED_DICT` 是容器指引字而非内建标量,单独由
//! [`is_container_directive`] 识别;别名链终点落在两者任一(或图内节点)上
//! 都算「已知」(见 [`is_known_terminal`])。

/// 引擎内建类型名(全大写;查询侧大小写敏感,与引擎注册名一致)。
pub const BUILTIN_TYPES: &[&str] = &[
    "INT8",
    "INT16",
    "INT32",
    "INT64",
    "UINT8",
    "UINT16",
    "UINT32",
    "UINT64",
    "FLOAT",
    "DOUBLE",
    "STRING",
    "UNICODE",
    "PYTHON",
    "PY_DICT",
    "PY_TUPLE",
    "PY_LIST",
    "BLOB",
    "ENTITYCALL",
    "VECTOR2",
    "VECTOR3",
    "VECTOR4",
];

/// 容器指引字(.def/types.xml `<Type>` 文本里的 ARRAY / FIXED_DICT)。
pub const CONTAINER_DIRECTIVES: &[&str] = &["ARRAY", "FIXED_DICT"];

pub fn is_builtin(name: &str) -> bool {
    BUILTIN_TYPES.contains(&name)
}

pub fn is_container_directive(name: &str) -> bool {
    CONTAINER_DIRECTIVES.contains(&name)
}

/// 别名链终点是否「已知」:内建标量、容器指引、图内命名节点(由调用方补查)
/// 之外的名称视为 unknown(SEM-013:保留理由,不冒充内建)。
pub fn is_known_terminal(name: &str) -> bool {
    is_builtin(name) || is_container_directive(name)
}
