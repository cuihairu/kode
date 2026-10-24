use std::path::Path;

use kode_corpus::{
    decode_source, detect_encoding, enumerate_python_files, index_python_corpus, python_golden,
    render_module, DecodedSource, EncodingSource, EnumerateOptions, GoldenCase, PythonModule,
};

#[test]
fn build_generated_golden_matches_decoder_and_lexer() {
    for case in python_golden() {
        let decoded = decode_source(case.bytes)
            .unwrap_or_else(|err| panic!("{}: decode failed: {err}", case.relative_path));
        assert_detection(case, &decoded);
        let module = kode_corpus::parse_python_module(&decoded.text);
        assert_module(case, &module);
        assert!(render_module(&module).contains("line_count="));
    }
}

#[test]
fn fixture_enumeration_and_index_cover_the_golden_table() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/python");
    let enumeration = enumerate_python_files(&root, &EnumerateOptions::default()).unwrap();
    let enumerated: Vec<&str> = enumeration
        .files
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect();
    let expected: Vec<&str> = python_golden()
        .iter()
        .map(|case| case.relative_path)
        .collect();
    assert_eq!(enumerated, expected);

    let index = index_python_corpus(&root, &EnumerateOptions::default()).unwrap();
    assert!(index.issues().is_empty(), "issues: {:?}", index.issues());
    assert_eq!(index.len(), python_golden().len());
    for case in python_golden() {
        let entry = index.get(case.relative_path).unwrap();
        let detected = detect_encoding(case.bytes);
        assert_eq!(entry.detection, detected);
        assert_eq!(
            entry.fingerprint,
            kode_corpus::content_fingerprint(case.bytes)
        );
        assert_eq!(
            render_module(&entry.module),
            render_module(&kode_corpus::parse_python_module(&entry.source))
        );
    }
}

fn assert_detection(case: &GoldenCase, decoded: &DecodedSource) {
    let detection = &decoded.detection;
    assert_eq!(
        detection.encoding.canonical_name(),
        case.encoding,
        "{}",
        case.relative_path
    );
    assert_eq!(
        source_name(detection.source),
        case.source,
        "{}",
        case.relative_path
    );
    assert_eq!(detection.bom_len, case.bom_len, "{}", case.relative_path);
    assert_eq!(
        detection.declared.as_deref(),
        case.declared,
        "{}",
        case.relative_path
    );
    assert_eq!(
        detection.cookie_line, case.cookie_line,
        "{}",
        case.relative_path
    );
}

fn assert_module(case: &GoldenCase, module: &PythonModule) {
    assert_eq!(module.line_count, case.line_count, "{}", case.relative_path);
    let classes: Vec<_> = module
        .classes
        .iter()
        .map(|class| {
            (
                class.name.as_str(),
                class.qualified_name.as_str(),
                class.bases.join(","),
                class.start_line,
                class.end_line,
            )
        })
        .collect();
    let expected_classes: Vec<_> = case
        .classes
        .iter()
        .map(|class| {
            (
                class.name,
                class.qualified_name,
                class.bases.join(","),
                class.start_line,
                class.end_line,
            )
        })
        .collect();
    assert_eq!(classes, expected_classes, "{}", case.relative_path);

    let methods: Vec<_> = module
        .methods
        .iter()
        .map(|method| {
            (
                method.class.as_str(),
                method.name.as_str(),
                method.line,
                method.character,
                method.is_async,
                method.decorators.join(","),
            )
        })
        .collect();
    let expected_methods: Vec<_> = case
        .methods
        .iter()
        .map(|method| {
            (
                method.class,
                method.name,
                method.line,
                method.character,
                method.is_async,
                method.decorators.join(","),
            )
        })
        .collect();
    assert_eq!(methods, expected_methods, "{}", case.relative_path);

    let attributes: Vec<_> = module
        .attributes
        .iter()
        .map(|attribute| {
            (
                attribute.class.as_str(),
                attribute.name.as_str(),
                attribute.line,
                attribute.character,
            )
        })
        .collect();
    let expected_attributes: Vec<_> = case
        .attributes
        .iter()
        .map(|attribute| {
            (
                attribute.class,
                attribute.name,
                attribute.line,
                attribute.character,
            )
        })
        .collect();
    assert_eq!(attributes, expected_attributes, "{}", case.relative_path);

    let imports: Vec<_> = module
        .imports
        .iter()
        .map(|import| {
            (
                import.binding.as_str(),
                import.module.as_str(),
                import.symbol.as_deref(),
                import.line,
                import.is_from,
            )
        })
        .collect();
    let expected_imports: Vec<_> = case
        .imports
        .iter()
        .map(|import| {
            (
                import.binding,
                import.module,
                import.symbol,
                import.line,
                import.is_from,
            )
        })
        .collect();
    assert_eq!(imports, expected_imports, "{}", case.relative_path);

    let instances: Vec<_> = module
        .instances
        .iter()
        .map(|instance| {
            (
                instance.variable.as_str(),
                instance.class_name.as_str(),
                instance.line,
            )
        })
        .collect();
    let expected_instances: Vec<_> = case
        .instances
        .iter()
        .map(|instance| (instance.variable, instance.class_name, instance.line))
        .collect();
    assert_eq!(instances, expected_instances, "{}", case.relative_path);
}

fn source_name(source: EncodingSource) -> &'static str {
    match source {
        EncodingSource::Bom => "bom",
        EncodingSource::Cookie => "cookie",
        EncodingSource::Heuristic => "heuristic",
        EncodingSource::Default => "default",
    }
}
