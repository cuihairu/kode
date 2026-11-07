//! MessageTable 编号与域规则常量。

// ---------------------------------------------------------------------------
// 常量(与 TS messageTable.ts 逐条一致;来源见其模块头注)
// ---------------------------------------------------------------------------

/// g_entityFlagMapping 12 项(entitydef.cpp L161-174),值 = EntityDataFlags 位
/// (common.h L19-30)。查找前 toupper,大小写不敏感。
pub(super) const PROPERTY_FLAG_BITS: &[(&str, i64)] = &[
    ("CELL", 0x01),
    ("CELL_AND_CLIENT", 0x08),
    ("CELL_AND_CLIENTS", 0x04),
    ("CELL_AND_OTHER_CLIENTS", 0x80),
    ("BASE_AND_CLIENT", 0x20),
    ("BASE", 0x40),
    ("CELL_PUBLIC", 0x01),
    ("CELL_PRIVATE", 0x02),
    ("ALL_CLIENTS", 0x04),
    ("CELL_PUBLIC_AND_OWN", 0x08),
    ("OTHER_CLIENTS", 0x80),
    ("OWN_CLIENT", 0x10),
];

/// common.h L141-147:三域位集。
pub(super) const ENTITY_BASE_DATA_FLAGS: i64 = 0x40 | 0x20;
pub(super) const ENTITY_CELL_DATA_FLAGS: i64 = 0x01 | 0x02 | 0x04 | 0x08 | 0x80 | 0x10;
pub(super) const ENTITY_CLIENT_DATA_FLAGS: i64 = 0x20 | 0x04 | 0x08 | 0x80 | 0x10;

/// 基元类型 utype 表:DataTypes::initialize 顺序(datatypes.cpp L54-79)。
pub(super) const PRIMITIVE_TYPE_UTYPES: &[(&str, i64)] = &[
    ("UINT8", 1),
    ("UINT16", 2),
    ("UINT64", 3),
    ("UINT32", 4),
    ("INT8", 5),
    ("INT16", 6),
    ("INT32", 7),
    ("INT64", 8),
    ("STRING", 9),
    ("UNICODE", 10),
    ("FLOAT", 11),
    ("DOUBLE", 12),
    ("PYTHON", 13),
    ("PY_DICT", 14),
    ("PY_TUPLE", 15),
    ("PY_LIST", 16),
    ("ENTITYCALL", 17),
    ("BLOB", 18),
    ("VECTOR2", 19),
    ("VECTOR3", 20),
    ("VECTOR4", 21),
];

/// 引擎保留属性名(common.h L125-155 ENTITY_LIMITED_PROPERTYS,静态表部分)。
pub(super) const LIMITED_PROPERTY_NAMES: &[&str] = &[
    "id",
    "position",
    "direction",
    "spaceID",
    "autoLoad",
    "cell",
    "base",
    "client",
    "cellData",
    "className",
    "componentdatabaseID",
    "isDestroyed",
    "shouldAutoArchive",
    "shouldAutoBackup",
    "__ACCOUNT_NAME__",
    "__ACCOUNT_PASSWORD__",
    "clientAddr",
    "clientEnabled",
    "hasClient",
    "roundTripTime",
    "timeSinceHeardFromClient",
    "allClients",
    "hasWitness",
    "isWitnessed",
    "otherClients",
    "topSpeed",
    "topSpeedY",
    "interface",
];

/// ENTITY_METHOD_UID 上界:uint16,超界报溢出。
pub(super) const METHOD_UTYPE_MAX: i64 = 65535;
/// aliasID:属性从 4 起(1-3 保留),超 255 回退 -1。
pub(super) const ALIAS_ID_PROPERTY_BASE: i64 = 4;
pub(super) const ALIAS_ID_MAX: i64 = 255;

/// 方法段装载序(引擎 loadDefInfo 顺序)。
pub(super) const METHOD_LOAD_ORDER: &[&str] = &["CellMethods", "BaseMethods", "ClientMethods"];

/// 三域位集:域命中的属性表才会走 addPropertyDescription。
pub(super) fn domain_bits_of(domain: &str) -> i64 {
    match domain {
        "cell" => ENTITY_CELL_DATA_FLAGS,
        "base" => ENTITY_BASE_DATA_FLAGS,
        _ => ENTITY_CLIENT_DATA_FLAGS,
    }
}

/// 组件类型号(common.h L78-82),addPropertyDescription 冲突报错按域打印。
pub(super) fn domain_component_type(domain: &str) -> i64 {
    match domain {
        "cell" => 5,
        "base" => 6,
        _ => 7,
    }
}

/// 方法段名 → 引擎段简称(冲突文案用)。
pub(super) fn section_name(section: &str) -> &'static str {
    match section {
        "CellMethods" => "Cell",
        "BaseMethods" => "Base",
        _ => "Client",
    }
}

/// 来源标签:own 原样;接口/父类带后缀(与 TS originLabel 同)。
pub(super) fn origin_label(module_name: &str, origin_kind: &str) -> String {
    match origin_kind {
        "interface" => format!("{module_name}(接口)"),
        "parent" => format!("{module_name}(父类)"),
        _ => module_name.to_string(),
    }
}

/// TS normalizeSourceKey:反斜杠归斜杠 + 小写。
pub(super) fn normalize_source_key(file_path: &str) -> String {
    file_path.replace('\\', "/").to_ascii_lowercase()
}
