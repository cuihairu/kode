//! client-sdk-gen headless 收集面(client_sdk::generate_sdk_headless):
//! entities.xml 登记序(平铺+分节/首条去重)→ def 读取 → 组件闭包
//! (components/ 优先 interfaces/ 回落)→ types.xml。语料=真实夹具
//! tests/fixtures/kbengine-demo-assets(与 bin 同路径);生成核心与 RPC
//! dispatch 共用同一 `generate` 函数,双入口零分叉(核心面断言在
//! client_sdk_dispatch.rs,此处只钉收集装配面)。

use std::path::{Path, PathBuf};

use kode_server::client_sdk::{
    generate_sdk_headless, read_registered_entity_names, ClientSdkCliRequest,
};

fn demo_assets_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/kbengine-demo-assets")
}

fn file_names(files: &[kode_server::client_sdk::ClientSdkCliFile]) -> Vec<String> {
    files.iter().map(|f| f.file_name.clone()).collect()
}

/// demo-assets entities.xml:登记序=文档序;未登记 def(Critical)不入面。
#[test]
fn headless_collects_registered_entities_in_registry_order() {
    let files = generate_sdk_headless(&ClientSdkCliRequest {
        assets_root: demo_assets_root(),
        language: "python".to_string(),
        namespace: None,
        engine_version: Some("2.5.10".to_string()),
        engine_commit: Some("55a66552".to_string()),
        generated_at: Some("2026-11-18T00:00:00Z".to_string()),
    })
    .expect("generate ok");

    let names = file_names(&files);
    // 8 实体(entities.xml 文档序)+ 组件伴随;未登记的 Critical.def 不生成。
    assert_eq!(
        names,
        vec![
            "Account.py",
            "Spaces.py",
            "Space.py",
            "Avatar.py",
            "Monster.py",
            "TrainingAvatar.py",
            "TrainingMonster.py",
            "EliteMonster.py",
            "ClientSdkComponents.py",
        ]
    );

    let avatar = files
        .iter()
        .find(|f| f.file_name == "Avatar.py")
        .expect("Avatar.py");
    // 骨架可读面:包装方法名来自真实 def 的 Exposed 方法。
    assert!(avatar.content.contains("base_call_reqCastSkill"));
    assert!(avatar.content.contains("cell_call_reqGoto"));
    // 溯源头:引擎版本/提交/生成时间。
    assert!(avatar.content.contains("# 引擎版本: 2.5.10"));
    assert!(avatar.content.contains("# 引擎提交: 55a66552"));
    assert!(avatar.content.contains("2026-11-18T00:00:00Z"));

    // 组件闭包:Avatar.def 的 Inventory 槽 → components/Inventory.def 收集,
    // dataclass 伴随文件;demo Inventory 无客户端可见属性 → pass 占位。
    let comps = files
        .iter()
        .find(|f| f.file_name == "ClientSdkComponents.py")
        .expect("ClientSdkComponents.py");
    assert!(comps.content.contains("# 实体组件: Inventory"));
    assert!(comps.content.contains("class Inventory:"));
    assert!(comps.content.contains("    pass"));
    // FIXED_DICT 伴随:demo types.xml 的 FIXED_DICT 未被客户端面引用 → 不产文件。
    assert!(!names.contains(&"ClientSdkFixedDicts.py".to_string()));
}

/// types.xml 固定字典被客户端面引用时,headless 同样产 FIXED_DICT 伴随文件
/// (demo-assets 的 SKILL_SLOT 引用属性 Flags=BASE 不可见,故用合成资产根钉)。
#[test]
fn headless_emits_fixed_dicts_when_referenced() {
    let tmp = std::env::temp_dir().join(format!("kode-sdkgen-fd-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let defs = tmp.join("scripts/entity_defs");
    std::fs::create_dir_all(&defs).unwrap();
    std::fs::write(
        tmp.join("scripts/entities.xml"),
        "<root><Avatar hasClient=\"true\"></Avatar></root>",
    )
    .unwrap();
    std::fs::write(
        defs.join("Avatar.def"),
        r#"<root>
  <Properties>
    <bag>
      <Type>AvatarProps</Type>
      <Flags>BASE_AND_CLIENT</Flags>
    </bag>
  </Properties>
</root>"#,
    )
    .unwrap();
    std::fs::write(
        defs.join("types.xml"),
        r#"<root>
  <AvatarProps>
    <Type>FIXED_DICT</Type>
    <Properties>
      <hp><Type>UINT32</Type></hp>
    </Properties>
  </AvatarProps>
</root>"#,
    )
    .unwrap();

    let files = generate_sdk_headless(&ClientSdkCliRequest {
        assets_root: tmp.clone(),
        language: "typescript".to_string(),
        namespace: None,
        engine_version: None,
        engine_commit: None,
        generated_at: None,
    })
    .expect("generate ok");
    let names = file_names(&files);
    assert_eq!(
        names,
        vec![
            "Avatar.ts".to_string(),
            "ClientSdkFixedDicts.ts".to_string()
        ]
    );
    let fixed = files
        .iter()
        .find(|f| f.file_name == "ClientSdkFixedDicts.ts")
        .unwrap();
    assert!(fixed.content.contains("export interface AvatarProps"));

    let _ = std::fs::remove_dir_all(&tmp);
}

/// 缺 entity_defs 目录 / entities.xml 不可读 → Err(bin 侧转退出码)。
#[test]
fn headless_missing_layout_is_error() {
    let tmp = std::env::temp_dir().join(format!("kode-sdkgen-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();

    let err = generate_sdk_headless(&ClientSdkCliRequest {
        assets_root: tmp.clone(),
        language: "python".to_string(),
        namespace: None,
        engine_version: None,
        engine_commit: None,
        generated_at: None,
    })
    .unwrap_err();
    assert!(err.contains("entity_defs 目录不存在"), "{err}");

    // 有 entity_defs 无 entities.xml → Err(entities.xml 读取失败)。
    std::fs::create_dir_all(tmp.join("scripts/entity_defs")).unwrap();
    let err = generate_sdk_headless(&ClientSdkCliRequest {
        assets_root: tmp.clone(),
        language: "python".to_string(),
        namespace: None,
        engine_version: None,
        engine_commit: None,
        generated_at: None,
    })
    .unwrap_err();
    assert!(err.contains("entities.xml"), "{err}");

    let _ = std::fs::remove_dir_all(&tmp);
}

/// entities.xml 解析:平铺 + ClientServerEntities/ServerOnlyEntities 分节双口径,
/// 文档序首条去重(与 TS getRegisteredEntities 同向)。
#[test]
fn registered_entity_names_flat_and_sections() {
    let tmp = std::env::temp_dir().join(format!("kode-entities-xml-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();

    let flat = tmp.join("flat.xml");
    std::fs::write(
        &flat,
        "<root>\n  <Avatar hasClient=\"true\"></Avatar>\n  <Monster></Monster>\n  <Avatar></Avatar>\n</root>",
    )
    .unwrap();
    assert_eq!(
        read_registered_entity_names(&flat).unwrap(),
        vec!["Avatar".to_string(), "Monster".to_string()]
    );

    let sectioned = tmp.join("sectioned.xml");
    std::fs::write(
        &sectioned,
        "<root>\n  <ClientServerEntities>\n    <Avatar></Avatar>\n    <Account></Account>\n  </ClientServerEntities>\n  <ServerOnlyEntities>\n    <Spaces></Spaces>\n  </ServerOnlyEntities>\n</root>",
    )
    .unwrap();
    assert_eq!(
        read_registered_entity_names(&sectioned).unwrap(),
        vec![
            "Avatar".to_string(),
            "Account".to_string(),
            "Spaces".to_string()
        ]
    );

    let missing = tmp.join("missing.xml");
    assert!(read_registered_entity_names(&missing).is_err());

    let _ = std::fs::remove_dir_all(&tmp);
}
