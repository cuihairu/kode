//! def MD5 golden sample set and golden JSON generation (moved out of def_md5
//! in SRC-008 phase 1, a pure move: GoldenSample/fixture/minimal/KR-AUD-80/81
//! hand-derived anchors/golden_samples/dump_def_md5_golden/GOLDEN_REL_PATH).
//! Region original text is untouched; computation and parameter types are
//! imported from the parent module (same crate, no cycle).
use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::json;

use super::{compute_def_md5, DefMd5Params};
// ===========================================================================
// Golden
// ===========================================================================

/// A single golden sample (params + expectation). The hand-crafted sample's
/// byte stream serves as the hand-derived canonical derivation anchor.
#[derive(Debug)]
pub struct GoldenSample {
    pub name: &'static str,
    pub params: DefMd5Params,
}

fn fixture_params(root: &Path, sub: &str) -> Option<DefMd5Params> {
    let scripts = root.join(sub).join("scripts");
    let entity_defs = scripts.join("entity_defs");
    let read = |p: std::path::PathBuf| std::fs::read_to_string(p).ok();
    let mut defs = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(&entity_defs) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("def") {
                if let (Some(name), Some(text)) = (
                    path.file_stem().and_then(|s| s.to_str()),
                    read(path.clone()),
                ) {
                    defs.insert(name.to_string(), text);
                }
            }
        }
    }
    for sub_dir in ["interfaces", "components"] {
        if let Ok(entries) = std::fs::read_dir(entity_defs.join(sub_dir)) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("def") {
                    if let (Some(name), Some(text)) = (
                        path.file_stem().and_then(|s| s.to_str()),
                        read(path.clone()),
                    ) {
                        defs.insert(name.to_string(), text);
                    }
                }
            }
        }
    }
    // Component script existence (kbengine-demo-assets's
    // scripts/{base,cell}/components/).
    let mut component_scripts = HashSet::new();
    for side in ["base", "cell"] {
        if let Ok(entries) = std::fs::read_dir(scripts.join(side).join("components")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("py") {
                    if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                        component_scripts.insert(format!("{side}:{name}"));
                    }
                }
            }
        }
    }
    Some(DefMd5Params {
        types_xml: read(entity_defs.join("types.xml")).unwrap_or_default(),
        entities_xml: read(scripts.join("entities.xml")).unwrap_or_default(),
        defs,
        alias_xml: read(entity_defs.join("alias.xml")).unwrap_or_default(),
        component_scripts,
    })
}

/// Hand-crafted minimal assets (canonical derivation anchor): one entity, one
/// property, one method; the byte stream is hand-derived for parity.
fn minimal_params() -> DefMd5Params {
    let types_xml = "<root></root>".to_string();
    let entities_xml = "<root><Gate hasCell=\"true\"></Gate></root>".to_string();
    let gate_def = "<root>\
        <Properties>\
            <level>\
                <Type> UINT32 </Type>\
                <Flags> BASE </Flags>\
                <Persistent> true </Persistent>\
            </level>\
        </Properties>\
        <CellMethods>\
            <respawn>\
            </respawn>\
        </CellMethods>\
        <BaseMethods>\
            <reqUpgrade>\
                <Exposed> true </Exposed>\
                <Arg> UINT32 </Arg>\
            </reqUpgrade>\
        </BaseMethods>\
        <ClientMethods>\
            <onLevelUp>\
                <Arg> UINT32 </Arg>\
            </onLevelUp>\
        </ClientMethods>\
    </root>"
        .to_string();
    let mut defs = HashMap::new();
    defs.insert("Gate".to_string(), gate_def);
    DefMd5Params {
        types_xml,
        entities_xml,
        defs,
        alias_xml: String::new(),
        component_scripts: HashSet::new(),
    }
}

/// KR-AUD-80/81 engine parity fixtures (xml.cpp:72-95/113-119 +
/// entitydef.cpp:551-639/642-818): interface text/element two-form
/// normalization + component `<Type>` text navigation. Hand-derived canonical
/// derivation: the interface name itself never enters the stream, so the two
/// forms' md5 must be identical; the component type name comes from the
/// `<Type>` text.
fn kr_aud_80_interface_params(interface_entry: &str) -> DefMd5Params {
    let combat_def = "<root>\
        <Properties>\
            <hp>\
                <Type> UINT32 </Type>\
                <Flags> CELL_PUBLIC </Flags>\
                <Persistent> true </Persistent>\
            </hp>\
        </Properties>\
        <CellMethods>\
            <onMove>\
                <Arg> VECTOR3 </Arg>\
            </onMove>\
        </CellMethods>\
    </root>"
        .to_string();
    DefMd5Params {
        types_xml: "<root></root>".into(),
        entities_xml: "<root><Avatar hasCell=\"true\"></Avatar></root>".into(),
        defs: [
            (
                "Avatar".to_string(),
                format!("<root><Interfaces>{interface_entry}</Interfaces></root>"),
            ),
            ("Combat".to_string(), combat_def),
        ]
        .into_iter()
        .collect(),
        alias_xml: String::new(),
        component_scripts: HashSet::new(),
    }
}

fn kr_aud_81_component_params() -> DefMd5Params {
    let inventory_def = "<root>\
        <Properties>\
            <slots>\
                <Type> UINT32 </Type>\
                <Flags> BASE </Flags>\
                <Persistent> true </Persistent>\
            </slots>\
        </Properties>\
        <BaseMethods>\
            <pack>\
                <Arg> UINT32 </Arg>\
            </pack>\
        </BaseMethods>\
    </root>"
        .to_string();
    DefMd5Params {
        types_xml: "<root></root>".into(),
        entities_xml: "<root><Avatar hasCell=\"true\"></Avatar></root>".into(),
        defs: [
            (
                "Avatar".to_string(),
                "<root><Components><bag><Type> Inventory </Type><Persistent> true </Persistent></bag></Components></root>".to_string(),
            ),
            ("Inventory".to_string(), inventory_def),
        ]
        .into_iter()
        .collect(),
        alias_xml: String::new(),
        component_scripts: HashSet::new(),
    }
}

/// Golden sample set (all demo-assets entities + parity-project + the minimal
/// anchor + KR-AUD-80/81 interface/component engine parity).
pub fn golden_samples(repo_root: &Path) -> Vec<GoldenSample> {
    let fixtures = repo_root.join("tests/fixtures");
    let mut samples = Vec::new();
    if let Some(mut params) = fixture_params(&fixtures, "kbengine-demo-assets") {
        // The demo-assets fixture is not engine-loadable (it lacks Flags, and
        // Monster.onAggro uses an undefined ENTITY_ID); here the md5 side only
        // adds the ENTITY_ID alias to make it computable (a regression-lock
        // purpose, not parity authority); types.xml is a shared fixture, so the
        // file is left untouched to avoid cascading into other goldens.
        if !params.types_xml.contains("ENTITY_ID") {
            params.types_xml = params
                .types_xml
                .replace("</root>", "  <ENTITY_ID> UINT32 </ENTITY_ID>\n</root>");
        }
        samples.push(GoldenSample {
            name: "kbengine-demo-assets",
            params,
        });
    }
    if let Some(params) = fixture_params(&fixtures, "parity-project") {
        samples.push(GoldenSample {
            name: "parity-project",
            params,
        });
    }
    samples.push(GoldenSample {
        name: "minimal-single-entity",
        params: minimal_params(),
    });
    // KR-AUD-80: interface text/element two forms — the engine navigation
    // (getKey(enterNode·) = trim(first non-comment child node's Value))
    // normalizes them, so the two samples' md5 must be identical.
    samples.push(GoldenSample {
        name: "kr-aud-80-interface-text",
        params: kr_aud_80_interface_params("<Interface> Combat </Interface>"),
    });
    samples.push(GoldenSample {
        name: "kr-aud-80-interface-element",
        params: kr_aud_80_interface_params("<Interface><Combat/></Interface>"),
    });
    // KR-AUD-81: the component type name = the `<Type>` text (Inventory), not
    // the element name literal "Type".
    samples.push(GoldenSample {
        name: "kr-aud-81-component-type",
        params: kr_aud_81_component_params(),
    });
    samples
}

/// Golden JSON (the canonical derivation is authoritative; streamHex+trace for
/// byte-level audits).
pub fn dump_def_md5_golden(repo_root: &Path) -> String {
    let mut samples = Vec::new();
    for sample in golden_samples(repo_root) {
        let result = compute_def_md5(sample.params).expect("compute def md5 golden sample");
        samples.push(json!({
            "name": sample.name,
            "md5": result.md5_hex,
            "streamHex": result.stream_hex,
        }));
    }
    let value = json!({
        "generator": "kode-server dump-def-md5-golden",
        "algorithm": "engine EntityDef::md5() replay (kbengine 732b389)",
        // RUST-404: the golden is a canonical derivation (a byte-for-byte replay
        // mirroring the source), not the output of a real engine run.
        // Compatibility claims may only come from parity against real engine
        // digests; without real engine evidence this stays false here — the
        // canonical derivation must never be passed off as "in sync". Setting it
        // to true requires real engine evidence attached plus a matching update
        // to the evidenceTier assertion in def_md5_golden.rs.
        "realEngineVerified": false,
        "evidenceTier": "spec-derived (kbengine 732b389 source replay; no real engine run)",
        "provenance": {
            "builtins": "datatypes.cpp:53-83",
            "dataTypeCtor": "datatype.cpp:86-97",
            "arrayInit": "datatype.cpp:1715-1717",
            "dictKeys": "datatype.cpp:2096-2149",
            "dictImplementedBy": "datatype.cpp:2184",
            "propertyCtor": "property.cpp:53-64",
            "methodCtor": "method.cpp:28-30",
            "methodArg": "method.cpp:65-67",
            "methodExposed": "method.cpp:50",
            "moduleName": "scriptdef_module.cpp:60",
            "loadOrder": "entitydef.cpp:339-400",
            "autoMatchCompOwn": "scriptdef_module.cpp:341-397",
            "outputFormat": "md5.cpp:65-72 uppercase 32hex",
        },
        "samples": samples,
    });
    serde_json::to_string(&value).expect("serialize def md5 golden")
}

/// Golden file relative path (same-directory convention as flag-domains/wire).
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/def-md5-parity.json";
