//! aliasID 分配(TS assignAliasIds + assignAliasRange)。

use crate::message_table::assembly::Assembly;
use crate::message_table::constants::{ALIAS_ID_MAX, ALIAS_ID_PROPERTY_BASE};

// ---------------------------------------------------------------------------

pub(super) fn assign_alias_ids(asm: &mut Assembly, alias_id_enabled: bool) {
    if !alias_id_enabled {
        return;
    }
    let mut client_properties: Vec<usize> = asm
        .properties
        .iter()
        .enumerate()
        .filter(|(_, p)| p.has_client)
        .map(|(i, _)| i)
        .collect();
    client_properties.sort_by(|&a, &b| asm.properties[a].name.cmp(&asm.properties[b].name));
    let mut next = ALIAS_ID_PROPERTY_BASE;
    for &i in &client_properties {
        asm.properties[i].alias_id = Some(next);
        next += 1;
    }
    if !client_properties.is_empty() && next - 1 > ALIAS_ID_MAX {
        for &i in &client_properties {
            asm.properties[i].alias_id = Some(-1);
        }
    }

    let mut client_methods: Vec<usize> = asm
        .methods
        .iter()
        .enumerate()
        .filter(|(_, m)| m.section == "ClientMethods")
        .map(|(i, _)| i)
        .collect();
    client_methods.sort_by(|&a, &b| asm.methods[a].name.cmp(&asm.methods[b].name));
    let mut next = 1;
    for &i in &client_methods {
        asm.methods[i].alias_id = Some(next);
        next += 1;
    }
    if !client_methods.is_empty() && next - 1 > ALIAS_ID_MAX {
        for &i in &client_methods {
            asm.methods[i].alias_id = Some(-1);
        }
    }
}
