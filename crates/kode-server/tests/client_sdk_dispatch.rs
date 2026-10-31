//! `$/kode/sdk/generate` dispatch 与客户端实体 SDK 生成核心单测。
//!
//! 覆盖(与 TS tests/clientSdkGenerator.test.ts 移植对应):
//! - 典型 entity def → 生成文件名(Avatar.ts/Avatar.cs/ClientSdkFixedDicts.*)与
//!   内容关键片段(客户端可见属性过滤、Exposed 方法包装、回调虚位、FixedDict 伴随);
//! - FULL_DEF/MINIMAL_DEF 的客户端可见属性过滤/类型映射/FixedDict 生成;
//! - 头部溯源(engineTrace 缺省写 unknown,传入写实际值)。

use serde_json::{json, Value};

use kode_protocol::{IncomingMessage, Request, RequestId};
use kode_server::{handle_message, Outgoing, ServerState};

const GENERATED_AT: &str = "2026-10-16T08:00:00.000Z";

const FULL_DEF: &str = r#"<!DOCTYPE entity>
<!-- Avatar 实体定义 -->
<root>
  <Parent>
    <Entity/>
  </Parent>
  <Properties>
    <name>
      <Type>STRING</Type>
      <Flags>BASE</Flags>
    </name>
    <hp>
      <Type>UINT32</Type>
      <Flags>CELL_PUBLIC_AND_OWN</Flags>
      <Default>100</Default>
    </hp>
    <homePosition>
      <Type>VECTOR3</Type>
      <Flags>BASE_AND_CLIENT</Flags>
    </homePosition>
    <loot>
      <Type>ARRAY<of>UINT8</of></Type>
      <Flags>OWN_CLIENT</Flags>
    </loot>
    <bag>
      <Type>AvatarProps</Type>
      <Flags>BASE_AND_CLIENT</Flags>
    </bag>
    <skills>
      <Type>ARRAY<of>STRING</of></Type>
      <Flags>BASE_AND_CLIENT</Flags>
    </skills>
  </Properties>
  <BaseMethods>
    <createAvatar>
      <Exposed/>
      <Arg>UINT8</Arg>
    </createAvatar>
    <internalPurge>
      <Arg>UINT32</Arg>
    </internalPurge>
  </BaseMethods>
  <CellMethods>
    <moveTo>
      <Exposed>true</Exposed>
      <Arg>VECTOR3</Arg>
    </moveTo>
  </CellMethods>
  <ClientMethods>
    <onHPChanged>
      <Arg>UINT32</Arg>
      <Arg>UINT32</Arg>
    </onHPChanged>
  </ClientMethods>
</root>
"#;

const MINIMAL_DEF: &str = r#"<root>
  <Properties>
    <level>
      <Type>UINT8</Type>
      <Flags>BASE</Flags>
    </level>
  </Properties>
</root>
"#;

/// 工程 types.xml:AvatarProps(FIXED_DICT 带字段) + Money(无字段别名)。
/// 行号用于断言 FixedDict 伴随文件的 `source: types.xml:N` 注释:
///   1  <root>
///   2    <AvatarProps>
///   3      <Type>FIXED_DICT</Type>
///   4      <Properties>
///   5        <hp><Type>UINT32</Type></hp>
///   6        <name><Type>STRING</Type></name>
///   7      </Properties>
///   8    </AvatarProps>
///   9    <Money>
///   10     <Type>UINT32</Type>
///   11   </Money>
///   12 </root>
const TYPES_XML: &str = r#"<root>
  <AvatarProps>
    <Type>FIXED_DICT</Type>
    <Properties>
      <hp><Type>UINT32</Type></hp>
      <name><Type>STRING</Type></name>
    </Properties>
  </AvatarProps>
  <Money>
    <Type>UINT32</Type>
  </Money>
</root>
"#;

fn request(id: i64, method: &str, params: Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
}

fn response_of(out: &[Outgoing]) -> &Value {
    match &out[0] {
        Outgoing::Response(response) => response.result.as_ref().unwrap(),
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

/// 走完整 `$/kode/rpc` 链路调 `$/kode/sdk/generate`,返回 handler 结果 JSON 数组。
fn generate(params: Value) -> Value {
    let mut state = ServerState::new();
    handle_message(&mut state, request(0, "initialize", json!({"capabilities": {}})));
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/sdk/generate", "params": params}),
        ),
    );
    response_of(&out).clone()
}

/// 结果数组里按文件名取内容;找不到 panic。
fn content_of<'a>(files: &'a [Value], file_name: &str) -> &'a str {
    files
        .iter()
        .find(|f| f.get("fileName").and_then(|v| v.as_str()) == Some(file_name))
        .and_then(|f| f.get("content").and_then(|v| v.as_str()))
        .unwrap_or_else(|| panic!("no file {file_name} in {:?}", files))
}

fn sdk_params(language: &str, def_text: &str) -> Value {
    json!({
        "language": language,
        "entities": [{"name": "Avatar", "defText": def_text}],
        "typesXml": TYPES_XML,
        "generatedAt": GENERATED_AT,
    })
}

/// dispatch 面:典型 entity def → 生成 Avatar.ts + Avatar.cs + FixedDicts 伴随文件。
#[test]
fn dispatch_generates_entity_and_fixed_dicts() {
    let files = generate(sdk_params("typescript", FULL_DEF));
    let files = files.as_array().expect("array result");
    assert_eq!(files.len(), 2);

    let ts = content_of(files, "Avatar.ts");
    assert!(ts.contains("export class Avatar"));
    assert!(ts.contains("// 实体: Avatar 父类: Entity"));
    assert!(ts.contains("public readonly entityId: number"));
    assert!(ts.contains("public hp: number"));
    assert!(ts.contains("public homePosition: [number, number, number]"));
    assert!(ts.contains("public loot: number[]"));
    assert!(ts.contains("public skills: string[]"));
    assert!(ts.contains("public bag: AvatarProps"));
    assert!(ts.contains("public onHPChanged(_arg0: number, _arg1: number): void"));
    assert!(ts.contains("this.onBaseOutgoing('createAvatar', [_arg0])"));
    assert!(ts.contains("this.onCellOutgoing('moveTo', [_arg0])"));
    assert!(ts.contains("protected onBaseOutgoing(_method: string, _args: unknown[]): void"));
    assert!(ts.contains("protected onCellOutgoing(_method: string, _args: unknown[]): void"));
    assert!(ts.contains("import { AvatarProps } from './ClientSdkFixedDicts';"));
    assert!(ts.contains(GENERATED_AT));
    // 纯服务端属性与未 Exposed 方法不进客户端面
    assert!(!ts.contains("public name:"));
    assert!(!ts.contains("internalPurge"));

    let fixed = content_of(files, "ClientSdkFixedDicts.ts");
    assert!(fixed.contains("export interface AvatarProps"));
    assert!(fixed.contains("hp: number"));
    assert!(fixed.contains("name: string"));
    // 无字段的 Money 不进 FixedDict 伴随文件
    assert!(!fixed.contains("Money"));
}

/// FULL_DEF 客户端可见属性过滤:仅客户端域旗标成字段(TS 同口径)。
#[test]
fn full_def_filters_client_visible_properties() {
    let files = generate(sdk_params("typescript", FULL_DEF));
    let files = files.as_array().unwrap();
    let ts = content_of(files, "Avatar.ts");

    // BASE 域(name)不进客户端面;CELL_PUBLIC_AND_OWN/BASE_AND_CLIENT/OWN_CLIENT 进。
    assert!(!ts.contains("public name:"));
    assert!(ts.contains("public hp: number"));
    assert!(ts.contains("public homePosition: [number, number, number]"));
    assert!(ts.contains("public loot: number[]"));
    assert!(ts.contains("public bag: AvatarProps"));
}

/// 类型映射:内置(VECTOR3/UINT8/STRING)、ARRAY、FIXED_DICT、别名、兜底。
#[test]
fn type_mapping_resolves_typescript_and_csharp() {
    let files = generate(sdk_params("typescript", FULL_DEF));
    let files = files.as_array().unwrap();
    let ts = content_of(files, "Avatar.ts");
    assert!(ts.contains("public homePosition: [number, number, number]"));
    assert!(ts.contains("public loot: number[]"));
    assert!(ts.contains("public skills: string[]"));

    let files = generate(sdk_params("csharp", FULL_DEF));
    let files = files.as_array().unwrap();
    let cs = content_of(files, "Avatar.cs");
    assert!(cs.contains("namespace KbEngineClient"));
    assert!(cs.contains("public class Avatar"));
    assert!(cs.contains("public long EntityId { get; }"));
    assert!(cs.contains("public uint Hp { get; set; }"));
    assert!(cs.contains("public Vector3 HomePosition { get; set; }"));
    assert!(cs.contains("public byte[] Loot { get; set; }"));
    assert!(cs.contains("public string[] Skills { get; set; }"));
    assert!(cs.contains("public AvatarProps Bag { get; set; }"));
    assert!(cs.contains("public virtual void OnHPChanged(uint arg0, uint arg1)"));
    assert!(cs.contains("BaseCallCreateAvatar(byte arg0)"));
    assert!(cs.contains("new object[] { arg0 }"));
    assert!(cs.contains("CellCallMoveTo(Vector3 arg0)"));
    assert!(cs.contains("protected virtual void OnBaseOutgoing(string method, object[] args)"));
    assert!(cs.contains("protected virtual void OnCellOutgoing(string method, object[] args)"));
    assert!(!cs.contains("public string Name"));
    assert!(!cs.contains("internalPurge"));
}

/// MINIMAL_DEF:无父类、无方法面、无 FixedDict → 只出实体文件,不产 FixedDicts 伴随。
#[test]
fn minimal_def_generates_entity_only() {
    let files = generate(sdk_params("typescript", MINIMAL_DEF));
    let files = files.as_array().unwrap();
    assert_eq!(files.len(), 1);
    let ts = content_of(files, "Avatar.ts");
    assert!(ts.contains("export class Avatar"));
    // 无父类注释
    assert!(ts.contains("// 实体: Avatar"));
    // BASE 域属性不进客户端面
    assert!(!ts.contains("public level:"));
    assert!(ts.contains("protected onBaseOutgoing"));
    assert!(ts.contains("protected onCellOutgoing"));
    assert!(!ts.contains("public baseCall"));
    assert!(!ts.contains("public cellCall"));
}

/// FixedDict 伴随文件:只收被生成实体引用到的 FIXED_DICT,字段缺 Type 时兜底。
#[test]
fn fixed_dicts_only_referenced_types() {
    // 无 FixedDict 引用 → 不产伴随文件
    let files = generate(sdk_params("typescript", MINIMAL_DEF));
    let files = files.as_array().unwrap();
    assert_eq!(files.len(), 1);

    // FULL_DEF 引用 AvatarProps → 伴随文件带 source 行号注释
    let files = generate(sdk_params("typescript", FULL_DEF));
    let files = files.as_array().unwrap();
    let fixed = content_of(files, "ClientSdkFixedDicts.ts");
    assert!(fixed.contains("/** source: types.xml:2 */"));
    assert!(fixed.contains("/** AvatarProps FIXED_DICT 别名 */"));
    assert!(fixed.contains("  /** source: types.xml:5 */"));
    assert!(fixed.contains("  hp: number;"));
    assert!(fixed.contains("  /** source: types.xml:6 */"));
    assert!(fixed.contains("  name: string;"));
}

/// 引擎溯源:未传 engineTrace → 头部写 unknown 字面量;传入 → 写实际值。
#[test]
fn engine_trace_defaults_to_unknown_and_echoes_input() {
    let files = generate(sdk_params("typescript", MINIMAL_DEF));
    let files = files.as_array().unwrap();
    let ts = content_of(files, "Avatar.ts");
    assert!(ts.contains("// 引擎版本: unknown"));
    assert!(ts.contains("// 引擎提交: unknown"));

    let mut params = sdk_params("typescript", MINIMAL_DEF);
    params["engineTrace"] = json!({"engineVersion": "2.5.10", "engineCommit": "f85ad81"});
    let files = generate(params);
    let files = files.as_array().unwrap();
    let ts = content_of(files, "Avatar.ts");
    assert!(ts.contains("// 引擎版本: 2.5.10"));
    assert!(ts.contains("// 引擎提交: f85ad81"));
}

/// 非法/畸形 def:结构错误被跳过(与 TS parseClientSdkEntity→null 同口径),不产文件。
#[test]
fn malformed_defs_are_skipped() {
    for bad in ["", "not xml at all", "<root><Properties></root>", "<root>"] {
        let files = generate(json!({
            "language": "typescript",
            "entities": [{"name": "Broken", "defText": bad}],
            "typesXml": TYPES_XML,
            "generatedAt": GENERATED_AT,
        }));
        assert_eq!(
            files.as_array().map(|a| a.len()).unwrap_or(0),
            0,
            "def {:?} should be skipped",
            bad
        );
    }
}

// ---------------------------------------------------------------------------
// IDE-RUST-006 组件 SDK:组件槽客户端可见属性入 SDK(slot 成员 + 组件类伴随)
// ---------------------------------------------------------------------------

const COMPONENT_DEF: &str = r#"<root>
  <Properties>
    <hp><Type>UINT32</Type><Flags>CELL_PUBLIC_AND_OWN</Flags></hp>
    <name><Type>STRING</Type><Flags>BASE</Flags></name>
  </Properties>
</root>
"#;

const COMPONENT_ENTITY_DEF: &str = r#"<root>
  <Properties>
    <level><Type>UINT8</Type><Flags>BASE</Flags></level>
  </Properties>
  <Components>
    <healthPack><Type>HealthComp</Type></healthPack>
  </Components>
</root>
"#;

/// 组件槽客户端可见属性入 SDK:实体 slot 成员 + 组件类(仅客户端可见属性)。
#[test]
fn component_slot_client_visible_properties_into_sdk() {
    let params = json!({
        "language": "typescript",
        "entities": [{"name": "Avatar", "defText": COMPONENT_ENTITY_DEF}],
        "defs": {"HealthComp": COMPONENT_DEF},
        "typesXml": TYPES_XML,
        "generatedAt": GENERATED_AT,
    });
    let files = generate(params).as_array().unwrap().clone();
    let ts = content_of(&files, "Avatar.ts");
    assert!(ts.contains("public healthPack: HealthComp;"));
    assert!(ts.contains("import { HealthComp } from './ClientSdkComponents';"));

    let comps = content_of(&files, "ClientSdkComponents.ts");
    assert!(comps.contains("export class HealthComp"));
    assert!(comps.contains("public hp: number"));
    // 纯服务端属性(name BASE)不进组件类
    assert!(!comps.contains("public name:"));

    // C# 同语义
    let params = json!({
        "language": "csharp",
        "entities": [{"name": "Avatar", "defText": COMPONENT_ENTITY_DEF}],
        "defs": {"HealthComp": COMPONENT_DEF},
        "typesXml": TYPES_XML,
        "generatedAt": GENERATED_AT,
    });
    let files = generate(params).as_array().unwrap().clone();
    let cs = content_of(&files, "Avatar.cs");
    assert!(cs.contains("public HealthComp HealthPack { get; set; }"));
    let comps = content_of(&files, "ClientSdkComponents.cs");
    assert!(comps.contains("public class HealthComp"));
    assert!(comps.contains("public uint Hp { get; set; }"));
    assert!(!comps.contains("public string Name"));
}

/// 缺失组件 def:跳过该槽,不产组件类。
#[test]
fn component_slot_missing_def_skipped() {
    let params = json!({
        "language": "typescript",
        "entities": [{"name": "Avatar", "defText": COMPONENT_ENTITY_DEF}],
        "defs": {},
        "typesXml": TYPES_XML,
        "generatedAt": GENERATED_AT,
    });
    let files = generate(params).as_array().unwrap().clone();
    let ts = content_of(&files, "Avatar.ts");
    assert!(!ts.contains("healthPack"));
    assert!(!files.iter().any(|f| f["fileName"] == "ClientSdkComponents.ts"));
}

/// 未知语言 → handler 报错(TS 侧回退路径)。
#[test]
fn unknown_language_is_error() {
    let mut state = ServerState::new();
    handle_message(&mut state, request(0, "initialize", json!({"capabilities": {}})));
    let out = handle_message(
        &mut state,
        request(
            1,
            "$/kode/rpc",
            json!({"method": "$/kode/sdk/generate", "params": sdk_params("python", FULL_DEF)}),
        ),
    );
    match &out[0] {
        Outgoing::Response(response) => {
            assert!(response.error.is_some());
        }
        Outgoing::Notification(_) => panic!("expected response"),
    }
}
