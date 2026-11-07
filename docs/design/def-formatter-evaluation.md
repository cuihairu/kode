# .def Native Formatter Evaluation (KODE-FEAT-001 · 2026-11-05)

> Original entry: evaluate a native .def formatter (sharing syntax facts with
> the XML parser); produce the evaluation conclusion before deciding the
> implementation.
>
> This document is the evaluation conclusion; it implements no code.
> Conclusion: **feasible and worth doing — anchor on kode-parser's exact spans
> in the Rust core (kode-server RPC returns TextEdits), with the TS side doing
> provider adaptation only**. All facts below come from this worktree's source.

## Evaluation questions

1. Are the existing parser's syntax facts sufficient to support a formatter?
2. Which layer should the formatter live in (TS / Rust)?
3. What are the semantics-preservation risks?

## Facts

### Parser status quo (two parsers, different span fidelity)

- **Rust `crates/kode-parser/src/xml.rs`**: byte-by-byte state machine, arena
  tree + **exact byte spans** — every element keeps `open_span`/`close_span`/
  `content_span`/`name_span`, attributes carry `name_span`/`value_span`, and
  comments/CDATA/PI/declarations each have spans; error-tolerant recovery (bad
  input records diagnostics, recovers locally, never panics). These are
  formatter-grade syntax facts.
- **TS `src/defParser.ts`**: vendored fast-xml-parser (fxp), **offsets are
  rebuilt by re-searching with `text.indexOf(node.text, searchOffset)`**
  (around defParser.ts:596, rechecked 2026-11-07) — nodes with identical
  names/text get misaligned; this is navigation-grade precision, not
  formatter-grade. The TS side has no
  other XML-formatting dependency (package.json has no prettier/xml formatter
  dependency; `grep FormattingEdit src/` returns zero hits — the extension
  currently has no formatting provider at all).

### Two special syntax facts of the `.def` format

- **Pseudo-comments**: lines starting with `#` (engine legacy format, e.g. the
  truncation header `# <originally 80 columns>`). On the Rust side,
  `mask_def_pseudo_comments` (xml.rs:803, rechecked 2026-11-07) replaces such
  lines with
  **byte-equal-length** spaces before parsing, so a pseudo-comment line's
  position in the original text still falls inside the content span — when
  the formatter slices the original text by spans, these lines can be kept
  verbatim.
- **The engine is format-insensitive for this file**: .def files are parsed by
  the engine byte-by-byte (attributes/text semantics); whitespace changes do
  not affect semantics. But the def MD5 (`def_md5.rs`/hotReloadDefHash) hashes
  by content — **formatting necessarily changes the content hash**, and the
  hot-reload reconciliation/MD5 comparison will treat it as a change. This is
  a behavior-surface fact that must be written into the future
  implementation's documentation (formatting is not a semantics-neutral
  operation; it interacts with the hot-reload state machine).

## Option comparison

| Option | Approach | Verdict |
|---|---|---|
| A. TS-side formatter | Rearrange based on defParser's indexOf offsets | **No**: offsets are imprecise; rearranging amplifies misalignment into content corruption |
| B. Rust core formatter | kode-parser span tree → kode-server RPC returns a TextEdit list → TS `DocumentFormattingEditProvider` adapts | **Recommended**: exact spans; consistent with config-first's "parsing converges on Rust as the single source of truth"; kode-server already has an RPC surface of the same shape |
| C. External XML formatter library | prettier plugin / vscode-xml | No: a zero-external-dependency VSIX is an established constraint (fxp was vendored for exactly this reason), and external libraries don't understand `.def` pseudo-comments or engine formatting conventions |

## Suggested implementation shape (for later entries to finalize)

- Rust: add a format module to `crates/kode-parser` (pure function
  `format_def(text, options) -> Vec<TextEdit>`); rules: indent by depth
  (default 4 spaces, per the official KBEngine def template convention);
  whether to wrap overlong one-line attribute layouts can be decided later;
  comments and pseudo-comments kept verbatim (written back word-for-word by
  original spans); conservative blank-line compression (keep single blank
  lines).
- RPC: kode-server adds a `kode/format/def` dispatch; TS: a new
  `src/defFormatter.ts` registers formatting/range-formatting providers and,
  when Rust is unavailable, honestly degrades to no provider (same precedent
  as processTopologyRust).
- Acceptance criteria (future entry): idempotence
  (format(format(x)) == format(x)); semantic equivalence (parse trees before
  and after formatting equal element-by-element for elements/attributes/text
  tokens); pseudo-comments preserved verbatim; fault tolerance (bad input
  produces no edits and no panic); full test suite green.

## Conclusion

1. **Worth doing**: the Rust parser's span facts are in place and the
   formatter is a thin layer; the TS-side parser doesn't qualify — option A is
   ruled out outright.
2. **Option B recommended** (Rust core + RPC + thin TS provider adaptation),
   on the same track as this repo's config-first direction of "parsing
   converges on Rust as the single source of truth".
3. **Behavior surface that must go into the implementation docs**: a formatter
   changes file bytes → the def content hash/MD5 changes with it, and the
   hot-reload reconciliation and the engine's MD5 handshake will treat
   formatting as a real change; the implementation entry must make this
   interaction explicit in its acceptance criteria (e.g. the rule for marking
   DIRTY after formatting).
4. This entry stops at evaluation per its original specification;
   implementation awaits a later entry (dependent on the current batch's
   closure of the config-first pipeline and the kode-server RPC surface).
