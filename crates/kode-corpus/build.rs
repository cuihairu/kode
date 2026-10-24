use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Default)]
struct CaseSpec {
    encoding: Option<String>,
    source: Option<String>,
    bom_len: Option<usize>,
    declared: Option<String>,
    cookie_line: Option<usize>,
    line_count: Option<usize>,
    classes: Vec<ClassSpec>,
    methods: Vec<MethodSpec>,
    attributes: Vec<AttributeSpec>,
    imports: Vec<ImportSpec>,
    instances: Vec<InstanceSpec>,
}

#[derive(Debug)]
struct ClassSpec {
    name: String,
    qualified_name: String,
    bases: Vec<String>,
    start_line: usize,
    end_line: usize,
}

#[derive(Debug)]
struct MethodSpec {
    class: String,
    name: String,
    line: usize,
    character: usize,
    is_async: bool,
    decorators: Vec<String>,
}

#[derive(Debug)]
struct AttributeSpec {
    class: String,
    name: String,
    line: usize,
    character: usize,
}

#[derive(Debug)]
struct ImportSpec {
    binding: String,
    module: String,
    symbol: Option<String>,
    line: usize,
    is_from: bool,
}

#[derive(Debug)]
struct InstanceSpec {
    variable: String,
    class_name: String,
    line: usize,
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let fixture_root = manifest_dir.join("tests/fixtures/python");
    let cases_path = fixture_root.join("golden.cases");
    println!("cargo:rerun-if-changed={}", cases_path.display());
    println!("cargo:rerun-if-changed={}", fixture_root.display());

    let manifest = fs::read_to_string(&cases_path)
        .unwrap_or_else(|err| panic!("read {}: {err}", cases_path.display()));
    let cases = parse_cases(&manifest);
    verify_fixture_coverage(&fixture_root, &cases);
    for (path, _) in &cases {
        println!(
            "cargo:rerun-if-changed={}",
            fixture_root.join(path).display()
        );
    }

    let generated = emit_table(&fixture_root, &cases);
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let output = out_dir.join("python_golden.rs");
    fs::write(&output, generated).unwrap_or_else(|err| panic!("write {}: {err}", output.display()));
}

fn parse_cases(manifest: &str) -> Vec<(String, CaseSpec)> {
    let mut cases = Vec::new();
    let mut current: Option<(String, CaseSpec)> = None;
    for (index, raw) in manifest.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            if let Some(case) = current.take() {
                cases.push(case);
            }
            let path = line[1..line.len() - 1].trim();
            assert!(!path.is_empty(), "empty case path at line {}", index + 1);
            current = Some((path.to_string(), CaseSpec::default()));
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            panic!("invalid golden line {}: {line}", index + 1);
        };
        let Some((_, spec)) = current.as_mut() else {
            panic!("golden value before case header at line {}", index + 1);
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "encoding" => spec.encoding = Some(value.to_string()),
            "source" => spec.source = Some(value.to_string()),
            "bom_len" => spec.bom_len = Some(parse_usize(value, index + 1)),
            "declared" => {
                spec.declared = (!value.is_empty()).then(|| value.to_string());
            }
            "cookie_line" => {
                spec.cookie_line = (!value.is_empty()).then(|| parse_usize(value, index + 1));
            }
            "line_count" => spec.line_count = Some(parse_usize(value, index + 1)),
            "class" => spec.classes.push(parse_class(value, index + 1)),
            "method" => spec.methods.push(parse_method(value, index + 1)),
            "attribute" => spec.attributes.push(parse_attribute(value, index + 1)),
            "import" => spec.imports.push(parse_import(value, index + 1)),
            "instance" => spec.instances.push(parse_instance(value, index + 1)),
            other => panic!("unknown golden key {other:?} at line {}", index + 1),
        }
    }
    if let Some(case) = current.take() {
        cases.push(case);
    }
    cases.sort_by(|left, right| left.0.cmp(&right.0));
    for (path, spec) in &cases {
        assert!(spec.encoding.is_some(), "{path}: missing encoding");
        assert!(spec.source.is_some(), "{path}: missing source");
        assert!(spec.bom_len.is_some(), "{path}: missing bom_len");
        assert!(spec.line_count.is_some(), "{path}: missing line_count");
    }
    cases
}

fn verify_fixture_coverage(root: &Path, cases: &[(String, CaseSpec)]) {
    let expected: BTreeSet<&str> = cases.iter().map(|(path, _)| path.as_str()).collect();
    let actual: BTreeSet<String> = fs::read_dir(root)
        .unwrap_or_else(|err| panic!("read fixture dir {}: {err}", root.display()))
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|ext| ext.to_str()) == Some("py"))
                .then(|| path.file_name()?.to_str().map(str::to_owned))
                .flatten()
        })
        .collect();
    for path in &actual {
        assert!(
            expected.contains(path.as_str()),
            "fixture {path} has no golden case"
        );
    }
    for path in expected {
        assert!(actual.contains(path), "golden case {path} has no fixture");
    }
}

fn parse_usize(value: &str, line: usize) -> usize {
    value
        .parse()
        .unwrap_or_else(|_| panic!("invalid usize {value:?} at line {line}"))
}

fn parse_bool(value: &str, line: usize) -> bool {
    match value {
        "0" | "false" => false,
        "1" | "true" => true,
        _ => panic!("invalid bool {value:?} at line {line}"),
    }
}

fn fields(value: &str, count: usize, line: usize) -> Vec<&str> {
    let fields: Vec<&str> = value.split('|').collect();
    assert_eq!(
        fields.len(),
        count,
        "expected {count} fields at line {line}"
    );
    fields
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}

fn parse_class(value: &str, line: usize) -> ClassSpec {
    let fields = fields(value, 5, line);
    ClassSpec {
        name: fields[0].to_string(),
        qualified_name: fields[1].to_string(),
        bases: split_list(fields[2]),
        start_line: parse_usize(fields[3], line),
        end_line: parse_usize(fields[4], line),
    }
}

fn parse_method(value: &str, line: usize) -> MethodSpec {
    let fields = fields(value, 6, line);
    MethodSpec {
        class: fields[0].to_string(),
        name: fields[1].to_string(),
        line: parse_usize(fields[2], line),
        character: parse_usize(fields[3], line),
        is_async: parse_bool(fields[4], line),
        decorators: split_list(fields[5]),
    }
}

fn parse_attribute(value: &str, line: usize) -> AttributeSpec {
    let fields = fields(value, 4, line);
    AttributeSpec {
        class: fields[0].to_string(),
        name: fields[1].to_string(),
        line: parse_usize(fields[2], line),
        character: parse_usize(fields[3], line),
    }
}

fn parse_import(value: &str, line: usize) -> ImportSpec {
    let fields = fields(value, 5, line);
    ImportSpec {
        binding: fields[0].to_string(),
        module: fields[1].to_string(),
        symbol: (!fields[2].is_empty()).then(|| fields[2].to_string()),
        line: parse_usize(fields[3], line),
        is_from: parse_bool(fields[4], line),
    }
}

fn parse_instance(value: &str, line: usize) -> InstanceSpec {
    let fields = fields(value, 3, line);
    InstanceSpec {
        variable: fields[0].to_string(),
        class_name: fields[1].to_string(),
        line: parse_usize(fields[2], line),
    }
}

fn emit_table(root: &Path, cases: &[(String, CaseSpec)]) -> String {
    let mut out = String::from(
        "// @generated by crates/kode-corpus/build.rs; do not edit.\n\
         #[derive(Debug, Clone, Copy, PartialEq, Eq)]\n\
         pub struct GoldenClass {\n\
             pub name: &'static str,\n\
             pub qualified_name: &'static str,\n\
             pub bases: &'static [&'static str],\n\
             pub start_line: usize,\n\
             pub end_line: usize,\n\
         }\n\
         #[derive(Debug, Clone, Copy, PartialEq, Eq)]\n\
         pub struct GoldenMethod {\n\
             pub class: &'static str,\n\
             pub name: &'static str,\n\
             pub line: usize,\n\
             pub character: usize,\n\
             pub is_async: bool,\n\
             pub decorators: &'static [&'static str],\n\
         }\n\
         #[derive(Debug, Clone, Copy, PartialEq, Eq)]\n\
         pub struct GoldenAttribute {\n\
             pub class: &'static str,\n\
             pub name: &'static str,\n\
             pub line: usize,\n\
             pub character: usize,\n\
         }\n\
         #[derive(Debug, Clone, Copy, PartialEq, Eq)]\n\
         pub struct GoldenImport {\n\
             pub binding: &'static str,\n\
             pub module: &'static str,\n\
             pub symbol: Option<&'static str>,\n\
             pub line: usize,\n\
             pub is_from: bool,\n\
         }\n\
         #[derive(Debug, Clone, Copy, PartialEq, Eq)]\n\
         pub struct GoldenInstance {\n\
             pub variable: &'static str,\n\
             pub class_name: &'static str,\n\
             pub line: usize,\n\
         }\n\
         #[derive(Debug, Clone, Copy, PartialEq, Eq)]\n\
         pub struct GoldenCase {\n\
             pub relative_path: &'static str,\n\
             pub bytes: &'static [u8],\n\
             pub encoding: &'static str,\n\
             pub source: &'static str,\n\
             pub bom_len: usize,\n\
             pub declared: Option<&'static str>,\n\
             pub cookie_line: Option<usize>,\n\
             pub line_count: usize,\n\
             pub classes: &'static [GoldenClass],\n\
             pub methods: &'static [GoldenMethod],\n\
             pub attributes: &'static [GoldenAttribute],\n\
             pub imports: &'static [GoldenImport],\n\
             pub instances: &'static [GoldenInstance],\n\
         }\n\n\
         pub static PYTHON_GOLDEN: &[GoldenCase] = &[\n",
    );
    for (path, spec) in cases {
        let fixture = root.join(path);
        out.push_str("    GoldenCase {\n");
        out.push_str(&format!("        relative_path: {},\n", rust_str(path)));
        out.push_str(&format!(
            "        bytes: include_bytes!({}),\n",
            rust_str(&fixture.display().to_string())
        ));
        out.push_str(&format!(
            "        encoding: {},\n",
            rust_str(spec.encoding.as_deref().expect("validated"))
        ));
        out.push_str(&format!(
            "        source: {},\n",
            rust_str(spec.source.as_deref().expect("validated"))
        ));
        out.push_str(&format!(
            "        bom_len: {},\n",
            spec.bom_len.expect("validated")
        ));
        out.push_str(&format!(
            "        declared: {},\n",
            option_str(spec.declared.as_deref())
        ));
        out.push_str(&format!(
            "        cookie_line: {},\n",
            option_usize(spec.cookie_line)
        ));
        out.push_str(&format!(
            "        line_count: {},\n",
            spec.line_count.expect("validated")
        ));
        out.push_str("        classes: &[\n");
        for class in &spec.classes {
            let bases = string_slice(&class.bases);
            out.push_str(&format!(
                "            GoldenClass {{ name: {}, qualified_name: {}, bases: {}, start_line: {}, end_line: {} }},\n",
                rust_str(&class.name),
                rust_str(&class.qualified_name),
                bases,
                class.start_line,
                class.end_line
            ));
        }
        out.push_str("        ],\n        methods: &[\n");
        for method in &spec.methods {
            out.push_str(&format!(
                "            GoldenMethod {{ class: {}, name: {}, line: {}, character: {}, is_async: {}, decorators: {} }},\n",
                rust_str(&method.class),
                rust_str(&method.name),
                method.line,
                method.character,
                method.is_async,
                string_slice(&method.decorators)
            ));
        }
        out.push_str("        ],\n        attributes: &[\n");
        for attribute in &spec.attributes {
            out.push_str(&format!(
                "            GoldenAttribute {{ class: {}, name: {}, line: {}, character: {} }},\n",
                rust_str(&attribute.class),
                rust_str(&attribute.name),
                attribute.line,
                attribute.character
            ));
        }
        out.push_str("        ],\n        imports: &[\n");
        for import in &spec.imports {
            out.push_str(&format!(
                "            GoldenImport {{ binding: {}, module: {}, symbol: {}, line: {}, is_from: {} }},\n",
                rust_str(&import.binding),
                rust_str(&import.module),
                option_str(import.symbol.as_deref()),
                import.line,
                import.is_from
            ));
        }
        out.push_str("        ],\n        instances: &[\n");
        for instance in &spec.instances {
            out.push_str(&format!(
                "            GoldenInstance {{ variable: {}, class_name: {}, line: {} }},\n",
                rust_str(&instance.variable),
                rust_str(&instance.class_name),
                instance.line
            ));
        }
        out.push_str("        ],\n    },\n");
    }
    out.push_str("];\n");
    out
}

fn rust_str(value: &str) -> String {
    format!("{value:?}")
}

fn option_str(value: Option<&str>) -> String {
    value.map_or_else(
        || "None".to_string(),
        |value| format!("Some({})", rust_str(value)),
    )
}

fn option_usize(value: Option<usize>) -> String {
    value.map_or_else(|| "None".to_string(), |value| format!("Some({value})"))
}

fn string_slice(values: &[String]) -> String {
    let items = values
        .iter()
        .map(|value| rust_str(value))
        .collect::<Vec<_>>()
        .join(", ");
    format!("&[{items}]")
}
