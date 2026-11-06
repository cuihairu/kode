//! def↔Python 方法一致性规则(C-19 交付①)单测:走 `analyze_def_with_python`
//! (公共面,与 RPC handler 同口径),按 check 码断言命中/不命中,并核对
//! finding 的定位(name span)、双向定位(related)与消息文案。

use kode_server::lint::{
    analyze_def, analyze_def_with_python, PythonParityInput, PythonParitySection,
};

/// 含 3 方法(def 有 3)/缺 1 的示例实体:
/// BaseMethods:reqPos(2 arg)/onDeath(1 arg);CellMethods:onTick。
const AVATAR_DEF: &str = "<root>\n\
\t<BaseMethods>\n\
\t\t<reqPos>\n\
\t\t\t<Arg>UINT32</Arg>\n\
\t\t\t<Arg>VECTOR3</Arg>\n\
\t\t</reqPos>\n\
\t\t<onDeath>\n\
\t\t\t<Arg>INT64</Arg>\n\
\t\t</onDeath>\n\
\t</BaseMethods>\n\
\t<CellMethods>\n\
\t\t<onTick/>\n\
\t</CellMethods>\n\
</root>\n";

/// base 段上下文:base/Avatar.py 类内已实现方法集合(各用例给出)。
fn base_ctx(methods: &[&str]) -> PythonParityInput {
    PythonParityInput {
        python_class: "Avatar".to_string(),
        base: Some(PythonParitySection {
            python_file: "/a/scripts/base/Avatar.py".to_string(),
            implemented_methods: methods.iter().map(|s| s.to_string()).collect(),
        }),
        ..Default::default()
    }
}

fn parity_checks(input: &PythonParityInput) -> Vec<String> {
    analyze_def_with_python(AVATAR_DEF, &Default::default(), &[], input.clone())
        .expect("analyze ok")
        .into_iter()
        .map(|f| f.check.to_string())
        .collect()
}

#[test]
fn no_python_context_is_noop() {
    // 未提供 pythonParity(缺省)→ parity 规则零产出;其余规则照常(空,该 def 干净)。
    assert!(parity_checks(&PythonParityInput::default()).is_empty());
}

#[test]
fn def_has_python_missing_fires_exactly_once() {
    // def 有 3 方法;base 上下文已实现 reqPos/onTick,缺 onDeath → 恰好 1 条。
    let input = base_ctx(&["reqPos", "onTick"]);
    let findings =
        analyze_def_with_python(AVATAR_DEF, &Default::default(), &[], input).expect("analyze ok");
    let parity: Vec<_> = findings
        .iter()
        .filter(|f| f.check == "def-method-missing-in-python")
        .collect();
    assert_eq!(parity.len(), 1, "恰好 1 条 warning:{}", parity.len());
    let finding = parity[0];
    assert_eq!(finding.severity, "warning");
    assert_eq!(finding.name.as_deref(), Some("onDeath"));
    // 定位在 def 文件方法名行(1 基):onDeath 在第 7 行。
    assert_eq!(finding.line, 7);
    // 双向定位:目标 Python 文件 + 类名。
    let related = finding.related.as_ref().expect("related set");
    assert_eq!(related.file, "/a/scripts/base/Avatar.py");
    assert_eq!(related.class_name, "Avatar");
    assert!(
        finding.message.contains("onDeath"),
        "消息含方法名:{}",
        finding.message
    );
    assert!(
        finding.message.contains("Avatar"),
        "消息含类名:{}",
        finding.message
    );
}

#[test]
fn implemented_methods_zero_false_positive() {
    // 全部 3 方法已实现 → 零误报。
    let input = base_ctx(&["reqPos", "onDeath", "onTick"]);
    assert!(parity_checks(&input).is_empty());
}

#[test]
fn missing_section_context_skips_that_section() {
    // 只有 base 上下文(cell 缺)→ 只核验 BaseMethods;onTick(CellMethods)不产。
    let input = base_ctx(&["reqPos", "onDeath"]);
    let findings =
        analyze_def_with_python(AVATAR_DEF, &Default::default(), &[], input).expect("analyze ok");
    let parity: Vec<_> = findings
        .iter()
        .filter(|f| f.check == "def-method-missing-in-python")
        .collect();
    assert_eq!(parity.len(), 0, "BaseMethods 已全实现,cell 缺上下文不核验");
}

#[test]
fn per_section_missing_fires_on_that_section_file() {
    // cell 上下文给出 cell/Avatar.py,onTick 未实现 → 指向 cell 文件。
    let input = PythonParityInput {
        python_class: "Avatar".to_string(),
        cell: Some(PythonParitySection {
            python_file: "/a/scripts/cell/Avatar.py".to_string(),
            implemented_methods: vec![],
        }),
        ..Default::default()
    };
    let findings =
        analyze_def_with_python(AVATAR_DEF, &Default::default(), &[], input).expect("analyze ok");
    let parity: Vec<_> = findings
        .iter()
        .filter(|f| f.check == "def-method-missing-in-python")
        .collect();
    assert_eq!(parity.len(), 1);
    assert_eq!(parity[0].name.as_deref(), Some("onTick"));
    assert_eq!(parity[0].line, 12, "onTick 在 CellMethods 段");
    assert_eq!(
        parity[0].related.as_ref().unwrap().file,
        "/a/scripts/cell/Avatar.py"
    );
}

#[test]
fn empty_python_class_is_noop() {
    // python_class 空(调用方未解析到类)→ 零产出,即便某段上下文在位。
    let input = PythonParityInput {
        python_class: String::new(),
        base: Some(PythonParitySection {
            python_file: "/a/scripts/base/Avatar.py".to_string(),
            implemented_methods: vec![],
        }),
        ..Default::default()
    };
    assert!(parity_checks(&input).is_empty());
}

#[test]
fn default_three_arg_analyze_still_works() {
    // 既有 3 参入口不变:缺省 python 上下文 → 零 parity。
    let findings = analyze_def(AVATAR_DEF, &Default::default(), &[]).expect("analyze ok");
    assert!(findings.is_empty());
}
