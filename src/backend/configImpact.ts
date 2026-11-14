/**
 * KSEM-CFG-10 联动配置修改影响(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md SEM-040,旧 KSEM-CFG-10):改 key/类型列出读取点、
 * 默认回退及受影响模块;修改未保存内容也刷新,禁止覆盖用户配置。
 *
 * 零写入面:本模块只产出示数据,没有任何写文件/写配置的通道——验收
 * 「禁止覆盖用户配置」由构造保证(无 CodeAction、无 fs 写、无命令)。
 *
 * 「修改未保存内容也刷新」由调用方满足:树/路径入参来自文档实文本
 * (悬停面现解析被悬停文档,盘上缓存树被实文本顶替),本模块是纯函数,
 * 给什么算什么,不自行读盘。
 *
 * 两入口:
 *  - computeKeyImpact:一条配置路径的改动影响面。
 *    · engine-xml:受影响模块(路径首段=进程段)/ 默认回退(删除元件覆盖
 *      或键后引擎采用的 defaults 叶值;无引擎默认=仅元件配置键,删除即
 *      失效)/ 读取点=引擎进程内消费(引擎 XML 配置用户代码不直接读,
 *      不硬造读取点);
 *    · project-json:读取点=CFG-08 结构注册表命中该路径的绑定 glob 的
 *      readers(去重)/ 受影响模块=读取点所在文件 / 默认回退零声称
 *      (JSON 配置无引擎默认);未覆盖路径=readers 空+known(改了没人读,
 *      这是诚实结论不是缺数据);
 *  - computeTypeImpact:serialization.json 一个类型的改动影响面=绑定该
 *    类型的 glob + 各 glob 读取点合并 + 受影响文件;删除绑定后读取点
 *    失去类型信息(CFG-07 类型面静默),读取点本身不受影响(诚实注记)。
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
  /** 受影响模块:engine-xml = 路径首段(进程段);project-json = null
   * (JSON 路径无进程段,受影响面走 affectedFiles) */
  section: string | null;
  /** 默认回退:删除键/元件覆盖后引擎采用的 defaults 叶值;value null =
   * defaults 有定义但是容器段(回落默认结构);fallback null = 无引擎默认
   * (仅元件配置键,删除即失效) */
  fallback: { value: string | null; sensitive: boolean } | null;
  /** false = defaults 树不可得,回退面零声称 */
  fallbackKnown: boolean;
  /** 代码读取点(去重;engine-xml 恒空=引擎内消费) */
  readers: ConfigImpactReader[];
  /** false = 注册表未参与,读取点零声称(project-json 且 structure=null) */
  readersKnown: boolean;
  /** engine-xml = 引擎进程内消费 */
  engineInternal: boolean;
  /** 受影响文件(读取点所在,唯一排序;engine-xml 恒空) */
  affectedFiles: string[];
}

export interface ConfigTypeImpact {
  typeId: string;
  /** 绑定该类型的 glob + loader(loads/load 两表合并,去重) */
  bindings: ReadonlyArray<{ glob: string; loader: 'json.loads' | 'json.load' }>;
  /** 绑定路径的合并读取点(去重) */
  readers: ConfigImpactReader[];
  /** 受影响文件(读取点所在,唯一排序) */
  files: string[];
  /** 诚实注记:删除绑定后读取点失去类型信息(CFG-07 类型面静默) */
  fallbackNote: string;
}

/** 点分路径取叶/容器节点(空名包裹归一与 CFG-06 同口径)。 */
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

/** 读取点去重合并(结构来源 → 读取点面)。 */
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
 * 一条配置路径的改动影响面。返回 null = engine-xml 面两棵树都没有该
 * 路径(诚实无面,不渲染);project-json 面恒有结果(空面=诚实结论)。
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
