//! flag→domain 真值表 golden 面: kode-parser `normalize_flag_tokens` +
//! `flag_domains` 组合的 JSON 快照,供 TS 侧生成镜像对拍(单一来源 =
//! Rust;TS `src/generated/flagDomains.ts` 是派生镜像,勿手改)。

use kode_parser::model::{flag_domains, normalize_flag_tokens};

/// 规范旗标 token(与 model.rs `normalize_flag_tokens` 的 KNOWN 同集)。
pub const CANONICAL: &[&str] = &[
    "BASE",
    "BASE_AND_CLIENT",
    "CELL_PUBLIC",
    "CELL_PRIVATE",
    "ALL_CLIENTS",
    "CELL_PUBLIC_AND_OWN",
    "OWN_CLIENT",
    "OTHER_CLIENTS",
];

/// 输出真值表 JSON(紧凑单行,同 hover golden 口径;尾部换行由调用方
/// println 引入,不参与比对)。自校验:规范 token 经 normalize 恒等回显,
/// 若 model.rs KNOWN 漂移先 panic 提示同步。
pub fn dump_flag_domains_golden() -> String {
    for token in CANONICAL {
        assert_eq!(
            normalize_flag_tokens(token),
            vec![token.to_string()],
            "canonical flag token {token} no longer round-trips through normalize_flag_tokens; \
             sync CANONICAL here with model.rs KNOWN"
        );
    }
    let flag_domains_map: std::collections::BTreeMap<&str, Vec<&str>> = CANONICAL
        .iter()
        .map(|t| (*t, flag_domains(&[t.to_string()])))
        .collect();
    // normalize 矩阵:输入原文 → normalize_flag_tokens 输出。覆盖规范形、
    // CELL 别名、遗留拼写(空白/连字符/大小写变体)、未知、空串、多 token。
    // TS 侧生成的 normalizeFlagTokens 须逐例一致(遗留折叠面同源)。
    let normalize_cases: Vec<(&str, Vec<String>)> = vec![
        ("BASE", normalize_flag_tokens("BASE")),
        ("CELL", normalize_flag_tokens("CELL")),
        ("CELL_PUBLIC", normalize_flag_tokens("CELL_PUBLIC")),
        ("ALL CLIENTS", normalize_flag_tokens("ALL CLIENTS")),
        ("ALL_CLIENTS", normalize_flag_tokens("ALL_CLIENTS")),
        ("ALL-CLIENTS", normalize_flag_tokens("ALL-CLIENTS")),
        ("all_clients", normalize_flag_tokens("all_clients")),
        ("Cell_Private", normalize_flag_tokens("Cell_Private")),
        ("cell_public", normalize_flag_tokens("cell_public")),
        ("base_and_client", normalize_flag_tokens("base_and_client")),
        ("BOGUS", normalize_flag_tokens("BOGUS")),
        ("", normalize_flag_tokens("")),
        ("BASE|CELL", normalize_flag_tokens("BASE|CELL")),
        (
            "  OTHER_CLIENTS  ",
            normalize_flag_tokens("  OTHER_CLIENTS  "),
        ),
    ];
    let value = serde_json::json!({
        "source": "crates/kode-parser/src/model.rs normalize_flag_tokens+flag_domains",
        "canonical": CANONICAL,
        "flagDomains": flag_domains_map,
        "alias": { "CELL": "CELL_PUBLIC" },
        "normalizeCases": normalize_cases,
    });
    serde_json::to_string(&value).expect("serialize flag-domains golden")
}

/// 提交侧 golden 相对仓库根路径(与 hover GOLDEN_REL_PATH 同约定)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/flag-domains-parity.json";
