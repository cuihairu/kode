//! flag->domain truth-table golden face: a JSON snapshot of kode-parser `normalize_flag_tokens` +
//! the `flag_domains` combination, for the TS side to generate a mirror for comparison (single source of truth =
//! Rust; TS `src/generated/flagDomains.ts` is the derived mirror, do not hand-edit).

use kode_parser::model::{flag_domains, normalize_flag_tokens};

/// Canonical flag tokens (same set as KNOWN in model.rs `normalize_flag_tokens`).
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

/// Output truth-table JSON (compact single line, same stance as the hover golden; the trailing newline comes from
/// the caller's println and does not participate in comparison). Self-check: canonical tokens normalize back to themselves,
/// and a drift in model.rs KNOWN panics first to prompt a sync.
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
    // normalize matrix: raw input -> normalize_flag_tokens output. Covers canonical forms,
    // the 4 legacy aliases (CELL/CELL_AND_CLIENT/CELL_AND_CLIENTS/CELL_AND_OTHER_
    // CLIENTS), legacy spellings (whitespace/hyphen/case variants), unknowns, empty string, multi-token.
    // The TS-side generated normalizeFlagTokens must match case for case (same source for the legacy-folding face).
    let normalize_cases: Vec<(&str, Vec<String>)> = vec![
        ("BASE", normalize_flag_tokens("BASE")),
        ("CELL", normalize_flag_tokens("CELL")),
        ("CELL_AND_CLIENT", normalize_flag_tokens("CELL_AND_CLIENT")),
        (
            "CELL_AND_CLIENTS",
            normalize_flag_tokens("CELL_AND_CLIENTS"),
        ),
        (
            "CELL_AND_OTHER_CLIENTS",
            normalize_flag_tokens("CELL_AND_OTHER_CLIENTS"),
        ),
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
        "alias": {
            "CELL": "CELL_PUBLIC",
            "CELL_AND_CLIENT": "CELL_PUBLIC_AND_OWN",
            "CELL_AND_CLIENTS": "ALL_CLIENTS",
            "CELL_AND_OTHER_CLIENTS": "OTHER_CLIENTS"
        },
        "normalizeCases": normalize_cases,
    });
    serde_json::to_string(&value).expect("serialize flag-domains golden")
}

/// Commit-side golden path relative to the repo root (same convention as hover GOLDEN_REL_PATH).
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/flag-domains-parity.json";
