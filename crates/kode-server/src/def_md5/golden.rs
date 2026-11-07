//! def MD5 golden 样例集与黄金 JSON 生成(SRC-008 阶段 1 自 def_md5 迁出,
//! 纯移动:GoldenSample/fixture/minimal/KR-AUD-80/81 手推锚点/golden_samples/
//! dump_def_md5_golden/GOLDEN_REL_PATH)。区域原文零改动;计算与参数类型自父
//! 模块导入(同 crate 内,无环)。
use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::json;

use super::{compute_def_md5, DefMd5Params};
// ===========================================================================
// Golden
// ===========================================================================

/// 单个黄金样本(params+期望)。手造样本的字节流为手推规范推导锚点。
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
    // 组件脚本存在性(kbengine-demo-assets 的 scripts/{base,cell}/components/)。
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

/// 手造最小资产(规范推导锚点):单实体单属性单方法,字节流手推对拍。
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

/// KR-AUD-80/81 引擎对拍夹具(xml.cpp:72-95/113-119 + entitydef.cpp:551-639/
/// 642-818):接口文本/元素两形态归一 + 组件 <Type> 文本导航。手推规范推导:
/// 接口名本身不入流,两形态 md5 必须相同;组件类型名取 <Type> 文本。
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

/// 黄金样本集(demo-assets 全实体 + parity-project + 最小锚点
/// + KR-AUD-80/81 接口/组件引擎对拍)。
pub fn golden_samples(repo_root: &Path) -> Vec<GoldenSample> {
    let fixtures = repo_root.join("tests/fixtures");
    let mut samples = Vec::new();
    if let Some(mut params) = fixture_params(&fixtures, "kbengine-demo-assets") {
        // demo-assets 夹具非引擎可装载(缺 Flags/Monster.onAggro 用未定义的
        // ENTITY_ID);这里仅 md5 侧补充 ENTITY_ID 别名使可计算(回归锁用途,
        // 非 parity 权威);types.xml 是共享夹具,不动文件避免级联其他 golden。
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
    // KR-AUD-80:接口文本/元素两形态——引擎导航(getKey(enterNode·) =
    // trim(首个非注释子节点 Value))归一,两样本 md5 必须相同。
    samples.push(GoldenSample {
        name: "kr-aud-80-interface-text",
        params: kr_aud_80_interface_params("<Interface> Combat </Interface>"),
    });
    samples.push(GoldenSample {
        name: "kr-aud-80-interface-element",
        params: kr_aud_80_interface_params("<Interface><Combat/></Interface>"),
    });
    // KR-AUD-81:组件类型名=<Type> 文本(Inventory),非元素名字面量 "Type"。
    samples.push(GoldenSample {
        name: "kr-aud-81-component-type",
        params: kr_aud_81_component_params(),
    });
    samples
}

/// 黄金 JSON(规范推导为权威;streamHex+trace 供逐字节审计)。
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

/// 黄金文件相对路径(与 flag-domains/wire 同目录惯例)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/def-md5-parity.json";
