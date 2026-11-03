/**
 * XML 注释文本工具:规范化、生成注释剥壳、源注释与文案库正文的同内容判定。
 * 独立成模块是为了让 serverConfigMerge(渲染期回写)与 serverConfigAnnotations
 * (挂文案库注释)共用同一套口径而不构成循环依赖(二者本就互相 import)。
 */

/**
 * XML 注释内容消毒:注释内部不得出现 `--`(XML 规范),结尾的 `-` 不能与
 * `-->` 拼出 `--`;空白统一压成单行(文案库已单行,这里兜底)。
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
 * 文案库生成注释剥壳取正文:`【子分类】正文〔来源: …〕`(中文)与
 * `[Group] body (source: …)`(英文)两构,去掉标签与出处后剩纯正文——
 * 用于判断该生成注释是否已被源注释覆盖(文案库多数正文即收割自 defaults
 * 源注释)。
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
 * 判重阈值:二元组覆盖率(见 bigramCoverage),须**双向都 ≥ 此值**才判同
 * (见 sourceCommentSameContent)。按真实 kbe/res/server/kbengine_defaults.xml
 * 的 169 个带源注释元素实测:同内容的收割对双向覆盖 ≥0.48(多数 1.0,即文案
 * 库正文逐字取自源注释);不同内容的保留对双向中较低者最高 0.36——0.4 落在
 * 空档里,两侧都不误判。
 */
const SAME_CONTENT_COVERAGE = 0.4;
/** 短于该长度不判重:`16M`/`port` 这类短注释偶然撞字会误杀生成注释 */
const SAME_CONTENT_MIN_LENGTH = 4;

/** 字符二元组集合(去空白):`abc` → {ab,bc} */
function bigrams(text: string): Set<string> {
  const compact = text.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let index = 0; index + 1 < compact.length; index += 1) {
    grams.add(compact.slice(index, index + 2));
  }
  return grams;
}

/** a 的二元组有多大比例出现在 b 里(1 = a 完全被 b 覆盖) */
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
 * 源注释与文案库正文是否同一内容(KODE-CFG-010 去重口径):**双向**二元组覆盖
 * 率都 ≥ 阈值才判同(交集)。曾用"任一方向 ≥ 阈值"(并集),实测会吞掉改写型真
 * 文档:「系统默认(system default)」与 EN 文案 zh 向仅 0.17 但 EN 向 0.67,
 * 被误压 2 处;`auth.password` 恰 0.40 边界同样误压。收割型逐字注释双向都是
 * 1.0,交集不受影响(压制数 139→135)。任一侧短于下限时不判(短注释撞字会误杀)。
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
