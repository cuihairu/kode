//! MessageTable numbering and domain-rule constants.

// ---------------------------------------------------------------------------
// Constants (item-for-item identical with TS messageTable.ts; see its module header note for sources)
// ---------------------------------------------------------------------------

/// g_entityFlagMapping, 12 entries (entitydef.cpp L161-174), values = EntityDataFlags bits
/// (common.h L19-30). toupper before lookup, case-insensitive.
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

/// common.h L141-147: three-domain bit sets.
pub(super) const ENTITY_BASE_DATA_FLAGS: i64 = 0x40 | 0x20;
pub(super) const ENTITY_CELL_DATA_FLAGS: i64 = 0x01 | 0x02 | 0x04 | 0x08 | 0x80 | 0x10;
pub(super) const ENTITY_CLIENT_DATA_FLAGS: i64 = 0x20 | 0x04 | 0x08 | 0x80 | 0x10;

/// Primitive-type utype table: DataTypes::initialize order (datatypes.cpp L54-79).
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

/// Engine-reserved property names (common.h L125-155 ENTITY_LIMITED_PROPERTYS, static-table part).
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

/// ENTITY_METHOD_UID upper bound: uint16; beyond it reports overflow.
pub(super) const METHOD_UTYPE_MAX: i64 = 65535;
/// aliasID: properties start at 4 (1-3 reserved); beyond 255 falls back to -1.
pub(super) const ALIAS_ID_PROPERTY_BASE: i64 = 4;
pub(super) const ALIAS_ID_MAX: i64 = 255;

/// Method-section load order (engine loadDefInfo order).
pub(super) const METHOD_LOAD_ORDER: &[&str] = &["CellMethods", "BaseMethods", "ClientMethods"];

/// Three-domain bit sets: only property tables whose domain bits hit go through addPropertyDescription.
pub(super) fn domain_bits_of(domain: &str) -> i64 {
    match domain {
        "cell" => ENTITY_CELL_DATA_FLAGS,
        "base" => ENTITY_BASE_DATA_FLAGS,
        _ => ENTITY_CLIENT_DATA_FLAGS,
    }
}

/// Component type numbers (common.h L78-82); addPropertyDescription conflict errors print per domain.
pub(super) fn domain_component_type(domain: &str) -> i64 {
    match domain {
        "cell" => 5,
        "base" => 6,
        _ => 7,
    }
}

/// Method-section name -> engine section abbreviation (used in conflict messages).
pub(super) fn section_name(section: &str) -> &'static str {
    match section {
        "CellMethods" => "Cell",
        "BaseMethods" => "Base",
        _ => "Client",
    }
}

/// Origin label: own as-is; interfaces/parents get a suffix (same as TS originLabel).
pub(super) fn origin_label(module_name: &str, origin_kind: &str) -> String {
    match origin_kind {
        "interface" => format!("{module_name}(接口)"),
        "parent" => format!("{module_name}(父类)"),
        _ => module_name.to_string(),
    }
}

/// TS normalizeSourceKey: backslashes normalized to slashes + lowercase.
pub(super) fn normalize_source_key(file_path: &str) -> String {
    file_path.replace('\\', "/").to_ascii_lowercase()
}
