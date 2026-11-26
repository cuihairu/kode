/**
 * XML comment text utilities: normalization, generated-comment shell stripping,
 * and the same-content decision between a source comment and the catalog body.
 * Split into its own module so that serverConfigMerge (render-time write-back)
 * and serverConfigAnnotations (attaching catalog comments) can share one
 * contract without forming a circular dependency (they already import each
 * other).
 */

/**
 * XML comment content sanitization: `--` must not appear inside a comment (XML
 * spec), and a trailing `-` must not combine with `-->` to form `--`; whitespace
 * is collapsed to a single line (the catalog is already single-line; this is a
 * fallback).
 */
export function sanitizeXmlComment(text: string): string {
  let comment = text.replace(/\s+/g, ' ').trim();
  comment = comment.replace(/-+/g, '-');
  if (comment.endsWith('-')) {
    comment += ' ';
  }
  return comment;
}

/**
 * Strip the shell of a generated catalog comment and take the body: the Chinese
 * shape (a fullwidth-bracket group tag, then the body, then a fullwidth "source"
 * tail) and the English `[Group] body (source: …)` are the two shapes; after
 * removing the tag and provenance the pure body remains — used to decide whether
 * the generated comment is already covered by a source comment (most catalog
 * bodies are harvested from defaults source comments).
 */
export function generatedCommentBody(comment: string): string {
  return comment
    .replace(/^【[^】]*】\s*/, '')
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/\s*〔来源:[^〕]*〕\s*$/, '')
    .replace(/\s*\(source:[^)]*\)\s*$/, '')
    .trim();
}

/**
 * Dedup threshold: bigram coverage (see bigramCoverage); both directions must be
 * >= this value to rule "same" (see sourceCommentSameContent). Measured on the
 * real kbe/res/server/kbengine_defaults.xml's 169 elements with source comments:
 * same-content harvested pairs have bidirectional coverage >= 0.48 (mostly 1.0,
 * i.e. the catalog body is verbatim from the source comment); different-content
 * retained pairs peak at 0.36 for the lower direction — 0.4 falls in the gap,
 * neither side misjudged.
 */
const SAME_CONTENT_COVERAGE = 0.4;
/** Below this length no dedup: short comments like `16M`/`port` colliding by chance would wrongly suppress generated comments */
const SAME_CONTENT_MIN_LENGTH = 4;

/** Character bigram set (whitespace removed): `abc` → {ab,bc} */
function bigrams(text: string): Set<string> {
  const compact = text.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let index = 0; index + 1 < compact.length; index += 1) {
    grams.add(compact.slice(index, index + 2));
  }
  return grams;
}

/** What fraction of a's bigrams appear in b (1 = a fully covered by b) */
function bigramCoverage(a: string, b: string): number {
  const source = bigrams(a);
  if (source.size === 0) {
    return 0;
  }
  const target = bigrams(b);
  let hit = 0;
  for (const gram of source) {
    if (target.has(gram)) {
      hit += 1;
    }
  }
  return hit / source.size;
}

/**
 * Whether a source comment and a catalog body are the same content (KODE-CFG-010
 * dedup contract): **bidirectional** bigram coverage both >= the threshold rules
 * "same" (intersection). An earlier "either direction >= threshold" (union) was
 * measured to swallow rewritten true docs: the zh comment for "system default"
 * (system default) vs the EN copy is only 0.17 zh-ward but 0.67 EN-ward, and was
 * wrongly suppressed twice;
 * `auth.password` sits exactly at the 0.40 boundary and was likewise wrongly
 * suppressed. Verbatim harvested comments are 1.0 in both directions, so the
 * intersection is unaffected (suppression count 139→135). Not judged when either
 * side is shorter than the floor (short comments colliding by chance would be
 * wrongly killed).
 */
export function sourceCommentSameContent(left: string, right: string): boolean {
  const a = sanitizeXmlComment(left);
  const b = sanitizeXmlComment(right);
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  if (Math.min(a.length, b.length) < SAME_CONTENT_MIN_LENGTH) {
    return false;
  }
  return (
    bigramCoverage(a, b) >= SAME_CONTENT_COVERAGE &&
    bigramCoverage(b, a) >= SAME_CONTENT_COVERAGE
  );
}
