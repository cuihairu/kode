//! Assembly 到输出 JSON 的映射与时间戳。

use crate::message_table::assembly::{AsmArg, AsmMethod, AsmProperty};
use crate::message_table::json::{ArgJson, MethodJson, PropertyJson};

// ---------------------------------------------------------------------------

pub(super) fn method_to_json(m: &AsmMethod) -> MethodJson {
    MethodJson {
        name: m.name.clone(),
        section: m.section.to_string(),
        direction: m.direction.to_string(),
        visible_to_client: m.visible_to_client,
        exposed: m.exposed,
        args: m.args.iter().map(arg_to_json).collect(),
        declared_utype: m.declared_utype,
        utype: m.utype,
        alias_id: m.alias_id,
        status: m.status.to_string(),
        origin: m.origin.clone(),
        origin_kind: m.origin_kind.to_string(),
        line: m.line,
    }
}

pub(super) fn arg_to_json(a: &AsmArg) -> ArgJson {
    ArgJson {
        name: a.name.clone(),
        of_type: a.of_type.as_deref().map(|a| Box::new(arg_to_json(a))),
        utype: a.utype,
        line: a.line,
    }
}

pub(super) fn property_to_json(p: &AsmProperty) -> PropertyJson {
    PropertyJson {
        name: p.name.clone(),
        type_name: p.type_name.clone(),
        flags: p.flags.clone(),
        has_client: p.has_client,
        utype: p.utype,
        declared_utype: p.declared_utype,
        alias_id: p.alias_id,
        persistent: p.persistent,
        origin: p.origin.clone(),
        origin_kind: p.origin_kind.to_string(),
        line: p.line,
    }
}

/// 当前 UTC 时间 ISO-8601(TS new Date().toISOString() 等价,毫秒截 0)。
pub(super) fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.000Z")
}

/// 1970-01-01 起天数 → 公历(y,m,d)(Howard Hinnant civil_from_days)。
pub(super) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
