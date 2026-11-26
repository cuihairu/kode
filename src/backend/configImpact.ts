/**
 * KSEM-CFG-10 coupled config-modification impact (pure core, zero vscode dependency).
 *
 * Acceptance contract (todo.md SEM-040, formerly KSEM-CFG-10): when a key/type
 * is changed, list the read points, the default fallback, and the affected
 * modules; also refresh when unsaved content is modified, and never overwrite
 * user configuration.
 *
 * Zero write surface: this module only produces display data and has no channel
 * for writing files/config — the acceptance item "must not overwrite user
 * configuration" is guaranteed by construction (no CodeAction, no fs writes,
 * no commands).
 *
 * "Also refresh for unsaved content" is satisfied by the caller: the tree/path
 * inputs come from the document's actual text (the hover surface parses the
 * hovered document on the spot, and the on-disk cached tree is displaced by the
 * actual text); this module is a pure function — it computes what it is given
 * and never reads from disk itself.
 *
 * Two entry points:
 *  - computeKeyImpact: the change impact surface of a single config path.
 *    · engine-xml: affected module (first path segment = process section) /
 *      default fallback (the defaults leaf value the engine adopts after the
 *      component override or key is removed; no engine default = a
 *      component-config-only key, so removal disables it) / read points =
 *      consumption inside the engine process (engine XML config is not read
 *      directly by user code, so no read points are fabricated);
 *    · project-json: read points = the readers of the bound glob that hits this
 *      path in the CFG-08 structure registry (deduplicated) / affected modules
 *      = the files containing the read points / zero claim on the default
 *      fallback (JSON config has no engine defaults); an uncovered path = empty
 *      readers + known (changing it is read by nobody — that is an honest
 *      conclusion, not missing data);
 *  - computeTypeImpact: the change impact surface of a single type in
 *    serialization.json = the globs bound to that type + the merged read points
 *    of each glob + the affected files; after a binding is removed the read
 *    points lose their type information (the CFG-07 type surface goes silent),
 *    while the read points themselves are unaffected (an honest note).
 */

import { normalizeRootNode } from './configFieldIdentity';
import {
  isSensitiveConfigKey,
  maskSensitiveValue
} from './configSourceFace';
import type {
  ConfigStructureSource,
  ProjectConfigStructure
} from './configProjectStructure';
import type { SerializationSchema } from './jsonChainPropagation';
import type { ConfigXmlNode } from '../serverConfigMerge';

export interface ConfigImpactReader {
  file: string;
  line: number | null;
}

export interface ConfigKeyImpact {
  path: string;
  /** Affected module: engine-xml = the first path segment (process section);
   * project-json = null (JSON paths have no process section, the affected
   * surface goes through affectedFiles) */
  section: string | null;
  /** Default fallback: the defaults leaf value the engine adopts after the key /
   * component override is removed; value null = defaults defines it but it is a
   * container section (falls back to the default structure); fallback null = no
   * engine default (a component-config-only key, removal disables it) */
  fallback: { value: string | null; sensitive: boolean } | null;
  /** false = the defaults tree is unavailable, zero claim on the fallback surface */
  fallbackKnown: boolean;
  /** Code read points (deduplicated; always empty for engine-xml = consumed inside the engine) */
  readers: ConfigImpactReader[];
  /** false = the registry did not participate, zero claim on read points
   * (project-json with structure = null) */
  readersKnown: boolean;
  /** engine-xml = consumption inside the engine process */
  engineInternal: boolean;
  /** Affected files (where the read points live, unique and sorted; always empty for engine-xml) */
  affectedFiles: string[];
}

export interface ConfigTypeImpact {
  typeId: string;
  /** Globs + loaders bound to that type (the loads/load tables merged, deduplicated) */
  bindings: ReadonlyArray<{ glob: string; loader: 'json.loads' | 'json.load' }>;
  /** Merged read points of the bound paths (deduplicated) */
  readers: ConfigImpactReader[];
  /** Affected files (where the read points live, unique and sorted) */
  files: string[];
  /** Honest note: after a binding is removed the read points lose their type information (the CFG-07 type surface goes silent) */
  fallbackNote: string;
}

/** Fetch the leaf/container node for a dot-separated path (empty-name wrapper normalization follows the CFG-06 contract). */
function nodeAtPath(tree: ConfigXmlNode, path: string): ConfigXmlNode | null {
  let node = normalizeRootNode(tree);
  for (const segment of path.split('.')) {
    const child = node.children.find((candidate) => candidate.name === segment);
    if (child === undefined) {
      return null;
    }
    node = child;
  }
  return node;
}

/** Merge read points with deduplication (structure sources → read-point surface). */
function mergeReaders(sources: ReadonlyArray<ConfigStructureSource>): ConfigImpactReader[] {
  const out: ConfigImpactReader[] = [];
  for (const s of sources) {
    if (!out.some((r) => r.file === s.file && r.line === s.line)) {
      out.push({ file: s.file, line: s.line });
    }
  }
  return out;
}

/**
 * The change impact surface of a single config path. Returning null = neither
 * tree on the engine-xml face contains the path (honestly no surface, nothing
 * rendered); the project-json face always returns a result (an empty surface =
 * an honest conclusion).
 */
export function computeKeyImpact(opts: {
  path: string;
  face: 'engine-xml' | 'project-json';
  customTree: ConfigXmlNode | null;
  defaultsTree: ConfigXmlNode | null;
  structure?: ProjectConfigStructure | null;
}): ConfigKeyImpact | null {
  if (opts.face === 'engine-xml') {
    const inDefaults = opts.defaultsTree !== null ? nodeAtPath(opts.defaultsTree, opts.path) : null;
    const inCustom = opts.customTree !== null ? nodeAtPath(opts.customTree, opts.path) : null;
    if (inDefaults === null && inCustom === null) {
      return null;
    }
    const container = inDefaults !== null && inDefaults.children.length > 0;
    const fallback =
      inDefaults === null
        ? null
        : {
            value: container ? null : inDefaults.text.trim().length > 0 ? inDefaults.text.trim() : null,
            sensitive: isSensitiveConfigKey(opts.path)
          };
    return {
      path: opts.path,
      section: opts.path.split('.')[0] ?? null,
      fallback,
      fallbackKnown: opts.defaultsTree !== null,
      readers: [],
      readersKnown: true,
      engineInternal: true,
      affectedFiles: []
    };
  }
  // project-json:读取点=注册表该具体路径的路径级读取点(CFG-08 pathReads,
  // 两 loader 合并;不用 entries 的 glob 聚合 readers——改一个 json 文件的
  // 影响只列读它的点,不夸大到同 glob 全体)
  const structure = opts.structure ?? null;
  const readers: ConfigImpactReader[] = [];
  if (structure !== null) {
    for (const pr of structure.pathReads) {
      if (pr.path !== opts.path) {
        continue;
      }
      for (const r of mergeReaders(pr.sources)) {
        if (!readers.some((x) => x.file === r.file && x.line === r.line)) {
          readers.push(r);
        }
      }
    }
  }
  return {
    path: opts.path,
    section: null,
    fallback: null,
    fallbackKnown: false,
    readers,
    readersKnown: structure !== null,
    engineInternal: false,
    affectedFiles: [...new Set(readers.map((r) => r.file))].sort()
  };
}

/**
 * serialization.json 一个类型的改动影响面。schema=null → null(零声称,
 * 不猜绑定);绑定空数组 = 没有任何 glob 绑此类型(改它=零影响,诚实结论)。
 */
export function computeTypeImpact(
  typeId: string,
  schema: SerializationSchema | null,
  structure: ProjectConfigStructure | null
): ConfigTypeImpact | null {
  if (schema === null) {
    return null;
  }
  const seen = new Set<string>();
  const bindings: Array<{ glob: string; loader: 'json.loads' | 'json.load' }> = [];
  const visit = (
    table: ReadonlyArray<{ path: string; type: string }>,
    loader: 'json.loads' | 'json.load'
  ): void => {
    for (const b of table) {
      if (b.type !== typeId) {
        continue;
      }
      const key = `${loader}\u0000${b.path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      bindings.push({ glob: b.path, loader });
    }
  };
  visit(schema.loadsBindings, 'json.loads');
  visit(schema.loadBindings, 'json.load');
  bindings.sort((a, b) => a.loader.localeCompare(b.loader) || a.glob.localeCompare(b.glob));
  const readers: ConfigImpactReader[] = [];
  if (structure !== null) {
    for (const b of bindings) {
      const entry = structure.entries.find(
        (e) => e.face === 'path-binding' && e.key === b.glob
      );
      if (entry === undefined) {
        continue;
      }
      for (const r of mergeReaders(entry.readers)) {
        if (!readers.some((x) => x.file === r.file && x.line === r.line)) {
          readers.push(r);
        }
      }
    }
  }
  return {
    typeId,
    bindings,
    readers,
    files: [...new Set(readers.map((r) => r.file))].sort(),
    fallbackNote:
      '删除/改绑该类型后,相关读取点失去类型信息(CFG-07 类型面对无绑定路径静默无类型);读取点本身不受影响'
  };
}

/**
 * 悬停影响块文案(纯格式化,双语言;敏感回退值只出现脱敏形态)。
 * engine-xml 面:模块/回退/读取点三行;project-json 面:读取点/受影响
 * 文件两行(无进程段与引擎默认面,不硬造)。
 */
export function renderImpactBlock(
  impact: ConfigKeyImpact,
  language: 'en' | 'zh'
): string {
  const lines: string[] = ['---'];
  if (impact.engineInternal) {
    if (language === 'en') {
      lines.push('**Modification impact** (if this key is changed/removed):');
      lines.push(`- Affected module: \`${impact.section}\` process section (consumed inside the engine)`);
      if (!impact.fallbackKnown) {
        lines.push('- Default fallback: unknown (engine defaults tree unavailable)');
      } else if (impact.fallback === null) {
        lines.push(
          '- Default fallback: none — component-config-only key; removing it disables the setting',
        );
      } else if (impact.fallback.value === null) {
        lines.push('- Default fallback: falls back to the engine default structure (`kbengine_defaults.xml`)');
      } else {
        const shown = impact.fallback.sensitive
          ? `${maskSensitiveValue(impact.fallback.value)} (masked)`
          : `\`${impact.fallback.value}\``;
        lines.push(`- Default fallback: on removal falls back to engine default ${shown} (\`kbengine_defaults.xml\`)`);
      }
      lines.push('- Read points: consumed inside the engine; no user-code read points claimed');
    } else {
      lines.push('**修改影响**(改动/删除此键时):');
      lines.push(`- 受影响模块:\`${impact.section}\` 进程段(引擎进程内消费)`);
      if (!impact.fallbackKnown) {
        lines.push('- 默认回退:未知(引擎默认树不可得)');
      } else if (impact.fallback === null) {
        lines.push('- 默认回退:无引擎默认(仅元件配置键,删除即失效)');
      } else if (impact.fallback.value === null) {
        lines.push('- 默认回退:回落引擎默认结构(`kbengine_defaults.xml`)');
      } else {
        const shown = impact.fallback.sensitive
          ? `${maskSensitiveValue(impact.fallback.value)}(已脱敏)`
          : `\`${impact.fallback.value}\``;
        lines.push(`- 默认回退:删除后回落引擎默认 ${shown}(\`kbengine_defaults.xml\`)`);
      }
      lines.push('- 读取点:引擎进程内消费,无用户代码读取点声称');
    }
    return lines.join('\n');
  }
  // project-json 面
  if (language === 'en') {
    lines.push('**Modification impact** (if this key is changed):');
    if (!impact.readersKnown) {
      lines.push('- Read points: unknown (project config registry not available)');
    } else if (impact.readers.length === 0) {
      lines.push('- Read points: none claimed — no bound schema glob matches this path');
    } else {
      lines.push(
        `- Read points: ${impact.readers
          .map((r) => (r.line === null ? r.file : `${r.file}:${r.line + 1}`))
          .join(', ')}`,
      );
    }
    if (impact.affectedFiles.length > 0) {
      lines.push(`- Affected files: ${impact.affectedFiles.join(', ')}`);
    }
  } else {
    lines.push('**修改影响**(改动此键时):');
    if (!impact.readersKnown) {
      lines.push('- 读取点:未知(项目配置注册表不可得)');
    } else if (impact.readers.length === 0) {
      lines.push('- 读取点:零声称——没有绑定 glob 命中此路径');
    } else {
      lines.push(
        `- 读取点:${impact.readers
          .map((r) => (r.line === null ? r.file : `${r.file}:${r.line + 1}`))
          .join(', ')}`,
      );
    }
    if (impact.affectedFiles.length > 0) {
      lines.push(`- 受影响文件:${impact.affectedFiles.join(', ')}`);
    }
  }
  return lines.join('\n');
}
