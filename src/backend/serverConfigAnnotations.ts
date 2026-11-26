import type { ConfigXmlNode } from '../serverConfigMerge';
import { sourceCommentSameContent } from './serverConfigCommentText';
import {
  SERVER_CONFIG_GROUPS,
  SERVER_CONFIG_GROUP_ORDER,
  SERVER_CONFIG_UNKNOWN_DOC,
  configItemDocBody,
  findServerConfigItemDoc,
  isZhConfigLanguage,
  type ServerConfigGroup,
  type ServerConfigItemDoc
} from './serverConfigCatalog';

/**
 * Sub-category and per-item effect comments for the final config (user order:
 * enhanced final XML config).
 *
 * The grouping axis = process: the top-level section names of
 * kbengine_defaults.xml are process names (dbmgr/cellapp/baseapp/loginapp/
 * machine/bots/logger/interfaces/...); serverconfig.cpp reads each section via
 * `root->FirstChildElement("<process>")` (serverconfig.cpp:733 baseapp, :911
 * dbmgr), and inside a section sub-categorizes by function (network/db/log/...).
 *
 * Comment placement (engine-compatibility evidence: local engine KBEngine 2.5.10's
 * kbe/src/lib/xml/xml.{h,cpp} and kbe/src/lib/server/serverconfig.cpp, measured
 * with the same-version tinyxml2 11):
 * - Container elements: the comment is the element's first child node.
 *   serverconfig.cpp uses FirstChildElement/NextSiblingElement throughout (291
 *   sites) to get child elements, both of which skip comment nodes;
 *   XML_FOR_BEGIN explicitly skips comments via `ToElement()==nullptr`
 *   (xml.h:14-19); enterNode also explicitly skips comment nodes
 *   (xml.cpp:81-89).
 * - Leaf elements (with/without value): the comment goes after the value, still
 *   inside the element. tinyxml2's IntText()/DoubleText() only accept the first
 *   child being text; a comment before the value makes the number read as its
 *   default — measured `<r><!-- c --> 42 </r>` → IntText() takes the default,
 *   `<r> 42 <!-- c --></r>` → 42; engine numeric items go through intText/
 *   doubleText (serverconfig.cpp:41-67). Placed after the value, all three read
 *   paths GetText()/IntText()/ToText() still read the original value.
 * No comment appears above an element or at the top of the file.
 */

/** Top-level section names = process names (evidence: top-level sections of kbe/res/server/kbengine_defaults.xml) */
const PROCESS_SECTION_NAMES = new Set([
  'baseapp',
  'cellapp',
  'dbmgr',
  'loginapp',
  'machine',
  'bots',
  'logger',
  'interfaces',
  'cellappmgr',
  'baseappmgr'
]);

export interface ConfigAnnotationOptions {
  /** VS Code display language (undefined/zh* → Chinese comments, otherwise English) */
  language?: string;
  /**
   * false = disable enhancement (kbengine.finalConfigComments): no effect
   * comments, no doc header note, no re-grouping by sub-category. Only the
   * "generated artifacts" turn off — source comments captured during parse
   * (sourceComments) are the input's original text, unaffected by the switch,
   * and are written back as usual.
   */
  enabled?: boolean;
  /** Doc header note (synthesized provenance and override contract), placed inside the first top-level element; a generated artifact, not emitted when enabled=false */
  header?: string;
}

/** Sub-category sort key; custom config always ranks last */
function groupRank(group: ServerConfigGroup): number {
  const index = SERVER_CONFIG_GROUP_ORDER.indexOf(group);
  return index < 0 ? SERVER_CONFIG_GROUP_ORDER.length : index;
}

/** Compose one comment text: 【sub-category】effect description〔source: ...〕 (same shape on the English side) */
function composeComment(doc: ServerConfigItemDoc, language: string | undefined): string {
  const zh = isZhConfigLanguage(language);
  const group = SERVER_CONFIG_GROUPS[doc.group];
  const label = zh ? group.zh : group.en;
  const body = configItemDocBody(doc, language);
  if (zh) {
    return `【${label}】${body}〔来源: ${doc.source}〕`;
  }
  return `[${label}] ${body} (source: ${doc.source})`;
}

/** Unrecognized custom config items: grouped into the "custom config" sub-category and marked "unrecognized", never guessing semantics */
function composeUnknownComment(language: string | undefined): string {
  const doc = SERVER_CONFIG_UNKNOWN_DOC;
  const zh = isZhConfigLanguage(language);
  const group = SERVER_CONFIG_GROUPS[doc.group];
  const label = zh ? group.zh : group.en;
  const body = configItemDocBody(doc, language);
  return zh ? `【${label}】${body}` : `[${label}] ${body}`;
}

/**
 * Attach sub-category comments to the synthesized config tree: per item look
 * up the doc library (miss = custom config, unrecognized), stably sort within a
 * section by sub-category (same group keeps the engine's original order), and
 * place the doc header note inside the first top-level element. Returns a new
 * tree without mutating the input.
 */
export function annotateConfigTree(
  root: ConfigXmlNode,
  options: ConfigAnnotationOptions = {}
): ConfigXmlNode {
  const { language, enabled = true, header } = options;
  const top = root.children;
  const single = top.length === 1 ? top[0] : undefined;
  // The wrapper section (<root>/<defaults>) does not participate in sorting: global
  // keys and process sections keep the engine's original order.
  // When a single top-level section is itself the process section (no wrapper),
  // its child keys are grouped as usual.
  const isWrapper = single !== undefined && !PROCESS_SECTION_NAMES.has(single.name);
  const sortMinParentDepth = isWrapper ? 2 : 1;

  const annotate = (node: ConfigXmlNode, depth: number, ancestors: readonly string[]): ConfigXmlNode => {
    const segments = [...ancestors, node.name];
    const children = node.children.map(child => annotate(child, depth + 1, segments));

    const isWrapperNode = isWrapper && single !== undefined && node === single;
    const doc = isWrapperNode
      ? findServerConfigItemDoc([node.name])
      : findServerConfigItemDoc(segments);

    // Comments are placed inside the element (containers before children, leaves
    // after the value); rules and evidence in the file header
    const out: ConfigXmlNode = { name: node.name, text: node.text, children };
    if (node.sourceComments !== undefined && node.sourceComments.length > 0) {
      // Source comments pass through verbatim (generated comments are a separate
      // field; source comments win at render time)
      out.sourceComments = [...node.sourceComments];
    }
    // Source comments take priority: when the catalog body (bilingual, its body
    // is often verbatim-harvested from source comments) is the same content as
    // the source comment, do not attach a generated comment, otherwise the same
    // explanation shows twice inside one element (KODE-CFG-010)
    const coveredBySource =
      enabled &&
      doc !== null &&
      (node.sourceComments ?? []).some(
        source =>
          sourceCommentSameContent(source, doc.zh) || sourceCommentSameContent(source, doc.en)
      );
    if (enabled && doc && !coveredBySource) {
      out.comment = composeComment(doc, language);
    } else if (enabled && !doc && !isWrapperNode) {
      out.comment = composeUnknownComment(language);
    }
    return out;
  };

  const annotated: ConfigXmlNode = {
    name: root.name,
    text: root.text,
    children: top.map(child => annotate(child, 1, []))
  };
  if (root.sourceComments !== undefined && root.sourceComments.length > 0) {
    annotated.sourceComments = [...root.sourceComments];
  }

  // Sort within a section by sub-category: same group keeps the original order
  // (stable sort), custom config sinks to the bottom.
  if (enabled) {
    const rankMap = new Map<ConfigXmlNode, number>();
    const rankPass = (node: ConfigXmlNode, segments: readonly string[]): void => {
      const next = node.name.length > 0 ? [...segments, node.name] : segments;
      if (node !== annotated) {
        const doc = findServerConfigItemDoc(next);
        rankMap.set(node, groupRank(doc ? doc.group : 'custom'));
      }
      for (const child of node.children) {
        rankPass(child, next);
      }
    };
    rankPass(annotated, []);

    const sortChildren = (node: ConfigXmlNode, depth: number): void => {
      if (depth >= sortMinParentDepth && node.children.length > 1) {
        node.children = [...node.children].sort(
          (a, b) => (rankMap.get(a) ?? 0) - (rankMap.get(b) ?? 0)
        );
      }
      for (const child of node.children) {
        sortChildren(child, depth + 1);
      }
    };
    sortChildren(annotated, 0);
  }

  if (enabled && header !== undefined && annotated.children.length > 0) {
    // The doc header note is also a generated artifact: not emitted when the
    // switch is off (source comments are outside the switch's jurisdiction)
    annotated.children[0].docHeader = header;
  }
  return annotated;
}
