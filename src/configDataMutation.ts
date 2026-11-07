/**
 * KODE-CFG-016:Excel 配置类强类型 stub 与意外写检测(纯逻辑层)。
 *
 * 游戏行业普遍用 Excel 生成 Python 配置(dict 表 / *Config 类),这些数据
 * 只允许热更新重载接口修改;业务代码里「顺手改配置」是隐蔽线上事故源。
 * 本模块两个纯函数面(不 import vscode,源码文本全部注入):
 *
 * ① computeConfigDataMutationFindings——意外写检测:枚举配置绑定名的全部
 *    写点(属性 `x.f=v` / 下标 `x[k]=v` / `del` / 增强赋值 `x+=v` / 变异方法
 *    append/pop/update/clear/sort/... ),写点不在「热更新接口(reload* /
 *    hotUpdate*)∪ mutationExclude 白名单」→ finding
 *    `kbengine.configDataMutation`。识别依据=配置驱动非启发式:配置目录
 *    (configDirGlobs)内的模块级绑定 + 匹配 configClassPatterns 的配置类;
 *    消费面按 from-import 名绑定(同名跨模块可能串扰,如实边界)。
 * ② collectConfigSchema——强类型 stub 直读:配置绑定/类的字面量 schema
 *    (key→value 类型已确定)直读出类型文本,供 hover/补全富化,非推断。
 *
 * 诚实边界(文档化):
 * - 行级扫描:跨行写语句(`ITEMS[\n1]=2`)不识别(MVP);
 * - 消费面按名字匹配,不做模块路径解析(配置名通常全局唯一);
 * - 裸名字遮蔽:消费文件模块级 `ITEMS = {}` 再绑定后,本文件该名后续写点
 *   视为本地新绑定,不再报(遮蔽语义)。
 */

/** 变异方法集合(list/dict/set 常见变异;宁可多报靠 mutationExclude 消解) */
const MUTATOR_METHODS = new Set([
  'append', 'extend', 'insert', 'pop', 'remove', 'clear', 'sort', 'reverse',
  'update', 'setdefault', 'popitem', 'discard', 'add'
]);

export const CONFIG_DATA_MUTATION_CODE = 'kbengine.configDataMutation';
export const CONFIG_DATA_SETTINGS_DEFAULT = {
  enabled: true,
  configDirGlobs: ['scripts/config/**', 'scripts/data/config/**', 'scripts/data/**'],
  configClassPatterns: ['*Config', '*Data'],
  reloadFunctionPatterns: ['reload*', 'hotUpdate*'],
  mutationExclude: [] as string[]
};

export interface ConfigDataSettings {
  enabled: boolean;
  configDirGlobs: string[];
  configClassPatterns: string[];
  reloadFunctionPatterns: string[];
  mutationExclude: string[];
}

export interface ConfigSourceInput {
  /** 工作区相对 posix 路径(与 configDirGlobs/mutationExclude 同口径) */
  file: string;
  text: string;
}

export interface ConfigDataFinding {
  code: string;
  severity: 'Warning';
  file: string;
  /** 0 起行 */
  line: number;
  /** 0 起列(写点 base 名首字符) */
  character: number;
  /** 写点 base 配置名 */
  baseName: string;
  form: 'attribute' | 'subscript' | 'delete' | 'augmented' | 'mutator';
  /** 中英双语消息 + 处置建议 */
  message: string;
}

export interface ConfigSchemaEntry {
  name: string;
  kind: 'class' | 'binding';
  /** 类型文本:binding=字面量类型直读;class=`字段: 类型` 逗点连接 */
  typeText: string;
  file: string;
  /** 0 起行(定义处) */
  line: number;
}

// ---------------------------------------------------------------------------
// 掩码:注释与字符串内容 → 空格(保换行与行宽),写点扫描在其上做,
// 字符串/注释里的 `ITEMS[1]=2` 形态不再误报。
// ---------------------------------------------------------------------------

/** 把注释尾与字符串字面量(含三引号/f 前缀)整体替换为空格,保留换行 */
export function maskPythonNonCode(source: string): string {
  const out = source.split('');
  let i = 0;
  const n = source.length;
  const blank = (idx: number) => {
    if (out[idx] !== '\n' && out[idx] !== '\r') {
      out[idx] = ' ';
    }
  };
  while (i < n) {
    const ch = source[i];
    if (ch === '#') {
      while (i < n && source[i] !== '\n') {
        blank(i);
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      // 三引号判定
      const triple = source.slice(i, i + 3) === ch.repeat(3);
      const quoteLen = triple ? 3 : 1;
      const closer = ch.repeat(quoteLen);
      for (let k = 0; k < quoteLen; k += 1) {
        blank(i + k);
      }
      i += quoteLen;
      while (i < n) {
        if (source[i] === '\\') {
          blank(i);
          if (i + 1 < n) {
            blank(i + 1);
          }
          i += 2;
          continue;
        }
        if (source.slice(i, i + quoteLen) === closer) {
          for (let k = 0; k < quoteLen; k += 1) {
            blank(i + k);
          }
          i += quoteLen;
          break;
        }
        blank(i);
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// 极小 glob(supports **, *, ?;posix 相对路径口径)
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` 跨段;`**/` 允许零段
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function anyGlobMatch(globs: readonly string[], value: string): boolean {
  return globs.some(g => globToRegExp(g).test(value));
}

/** fnmatch 口径(模式匹配名字,`*` 可含段内任意字符) */
function nameMatchesPattern(name: string, patterns: readonly string[]): boolean {
  return patterns.some(p => globToRegExp(p).test(name));
}

// ---------------------------------------------------------------------------
// ① 意外写检测
// ---------------------------------------------------------------------------

interface FileConfigNames {
  /** 本文件定义的配置绑定/类名(配置目录文件) */
  defined: Set<string>;
  /** 本文件 from-import 进来的配置名 → 别名集合 */
  imported: Set<string>;
  /** 配置文件里的定义语句行(定义本身不报):name → 行集合 */
  definitionLines: Map<string, Set<number>>;
}

function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') {
      w += 1;
    } else if (ch === '\t') {
      w = (Math.floor(w / 8) + 1) * 8;
    } else {
      break;
    }
  }
  return w;
}

/** 收集一个文件内的配置名面:定义(配置目录文件)+ from-import 别名 */
function collectFileConfigNames(
  file: string,
  maskedLines: readonly string[],
  isConfigFile: boolean,
  classPatterns: readonly string[],
  globalConfigNames: ReadonlySet<string>
): FileConfigNames {
  const defined = new Set<string>();
  const imported = new Set<string>();
  const definitionLines = new Map<string, Set<number>>();
  const addDefinition = (name: string, lineNo: number) => {
    defined.add(name);
    let set = definitionLines.get(name);
    if (!set) {
      set = new Set();
      definitionLines.set(name, set);
    }
    set.add(lineNo);
  };
  if (isConfigFile) {
    maskedLines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      // 仅模块级(indent 0)定义面;类体默认值不构成绑定
      if (indentWidth(line) !== 0) {
        return;
      }
      let m = /^class\s+([A-Za-z_]\w*)/.exec(trimmed);
      if (m) {
        if (nameMatchesPattern(m[1], classPatterns)) {
          addDefinition(m[1], idx);
        }
        return;
      }
      m = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(trimmed);
      if (m) {
        addDefinition(m[1], idx);
      }
    });
  }
  // from-import 别名:`from x.y import A as B, C` / `from x import (A, B)`
  for (let idx = 0; idx < maskedLines.length; idx += 1) {
    const trimmed = maskedLines[idx].trim();
    const m = /^from\s+[\w.]+\s+import\s+(.+)$/.exec(trimmed);
    if (!m) {
      continue;
    }
    const body = m[1].replace(/^\(/, '').replace(/\)$/, '');
    for (const piece of body.split(',')) {
      const names = piece.trim().split(/\s+as\s+/);
      const origin = names[0]?.trim();
      const alias = names[1]?.trim() || origin;
      if (!origin || !/^[A-Za-z_]\w*$/.test(origin)) {
        continue;
      }
      if (globalConfigNames.has(origin) || defined.has(origin)) {
        imported.add(alias);
      }
    }
  }
  return { defined, imported, definitionLines };
}

/** 找到 lineNo 上文最近的、缩进更小的 def 名(容纳 reload 豁免判定) */
function enclosingFunctionName(
  defLines: ReadonlyArray<{ line: number; indent: number; name: string }>,
  lineNo: number,
  indent: number
): string | null {
  let best: { line: number; indent: number; name: string } | null = null;
  for (const d of defLines) {
    if (d.line < lineNo && d.indent < indent) {
      best = d;
    }
  }
  return best?.name ?? null;
}

function writeFormFor(
  line: string,
  base: string
): { form: ConfigDataFinding['form']; baseIndex: number } | null {
  const esc = base.replace(/\$/g, '\\$');
  // 逐个出现位判定(评审二轮 P1:首出现是读(print(CFG))不吞后续写点
  // (CFG.x = 1)):任一出现位构成写点即报。在**原始行**上匹配:出现位下标
  // 即 UTF-16 字符偏移(VS Code 列口径,Tab 计 1 列)——评审三轮 P2:
  // 列偏移不得用缩进视觉宽度(indentWidth 把 Tab 扩 8 列,列会多报)。
  const startRe = new RegExp(`(?:^|[^\\w.])(${esc})\\b`, 'g');
  startRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(line)) !== null) {
    const baseIndex = m.index + m[0].length - base.length;
    const rest = line.slice(baseIndex + base.length);
    // `del BASE` / `del BASE.attr` / `del BASE[k]`
    if (line.slice(0, baseIndex).trimEnd().endsWith('del')
      && /^\s*(?:\.[\w]+|\[[^\]]*\])*\s*(?:,|$)/.test(rest)) {
      return { form: 'delete', baseIndex };
    }
    // 变异方法:`BASE.<chain>.<mut>(` 或 `BASE[k].<mut>(`
    const mutNames = [...MUTATOR_METHODS].join('|');
    const mutRe = new RegExp(`^(?:\\.[A-Za-z_]\\w*|\\[[^\\]]*\\])*\\s*\\.\\s*(${mutNames})\\s*\\(`);
    if (mutRe.test(rest)) {
      return { form: 'mutator', baseIndex };
    }
    // 增强赋值(先于普通赋值判定)
    const augRe = new RegExp(`^(?:\\.[A-Za-z_]\\w*|\\[[^\\]]*\\])*\\s*(?:\\+=|-=|\\*=|/=|//=|%=|\\|=|&=|\\^=|>>>=|>>=|<<=)`);
    if (augRe.test(rest)) {
      return { form: 'augmented', baseIndex };
    }
    // 普通赋值(属性链 / 下标链;`=` 后瞻非 `=`)
    const assignRe = new RegExp(`^(?:\\.[A-Za-z_]\\w*|\\[[^\\]]*\\])+\\s*=(?!=)`);
    if (assignRe.test(rest)) {
      const chain = rest.match(/^(?:\.[A-Za-z_]\w*|\[[^\]]*\])+/)![0];
      return { form: chain.includes('[') ? 'subscript' : 'attribute', baseIndex };
    }
    // 防零宽死循环:正则消费到出现位末尾
    startRe.lastIndex = baseIndex + base.length;
  }
  return null;
}

export function computeConfigDataMutationFindings(
  sources: readonly ConfigSourceInput[],
  settings: ConfigDataSettings
): ConfigDataFinding[] {
  if (!settings.enabled || sources.length === 0) {
    return [];
  }
  const masked = sources.map(s => maskPythonNonCode(s.text));
  const isConfigFile = sources.map(s => anyGlobMatch(settings.configDirGlobs, s.file));
  // 第一遍:配置目录文件的定义名并集(供 from-import 名校验)
  const globalConfigNames = new Set<string>();
  const fileNames: FileConfigNames[] = sources.map((s, i) => {
    const maskedLines = masked[i].split(/\r?\n/);
    const names = collectFileConfigNames(s.file, maskedLines, isConfigFile[i], settings.configClassPatterns, new Set());
    for (const name of names.defined) {
      globalConfigNames.add(name);
    }
    return names;
  });
  // 第二遍:from-import 别名(需全局名集合就绪)
  fileNames.forEach((names, i) => {
    const lines = masked[i].split(/\r?\n/);
    const imported = collectFileConfigNames(sources[i].file, lines, false, settings.configClassPatterns, globalConfigNames).imported;
    names.imported = imported;
  });

  const findings: ConfigDataFinding[] = [];
  sources.forEach((source, i) => {
    if (anyGlobMatch(settings.mutationExclude, source.file)) {
      return;
    }
    const lines = masked[i].split(/\r?\n/);
    // def 名清单(reload 豁免判定;任意缩进 def 都计入——豁免看「最近的、
    // 缩进更小的外层 def」,与定义层级无关)
    const defLines: Array<{ line: number; indent: number; name: string }> = [];
    lines.forEach((line, idx) => {
      const m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line.trim());
      if (m) {
        defLines.push({ line: idx, indent: indentWidth(line), name: m[1] });
      }
    });
    // 本文件模块级遮蔽:配置名被模块级再绑定后,该名视为本地绑定
    const shadowAt = new Map<string, number>();
    for (const [name, defSet] of fileNames[i].definitionLines) {
      // 配置文件自身定义行不参与遮蔽(定义即绑定起点)
      if (!isConfigFile[i]) {
        for (const lineNo of defSet) {
          if (!shadowAt.has(name) || lineNo < shadowAt.get(name)!) {
            shadowAt.set(name, lineNo);
          }
        }
      }
    }

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      const indent = indentWidth(line);
      // 扫描名集合:from-import 别名 ∪ 配置文件自身定义名(评审二轮 P1:
      // 只扫 imported 会漏配置文件自身的再写点;定义语句行本身仍豁免)
      const scanNames = isConfigFile[i]
        ? [...fileNames[i].imported, ...fileNames[i].defined]
        : [...fileNames[i].imported];
      for (const base of scanNames) {
        const hit = writeFormFor(line, base);
        if (!hit) {
          continue;
        }
        // 定义语句本身(配置文件内的定义行)不报
        const defSet = fileNames[i].definitionLines.get(base);
        if (defSet?.has(idx)) {
          continue;
        }
        // 模块级遮蔽后再绑定行起的模块级写点 = 本地绑定
        const shadowLine = shadowAt.get(base);
        if (shadowLine !== undefined && idx > shadowLine && indent === 0) {
          continue;
        }
        // 遮蔽绑定之后定义的函数体:其内写点也是本地绑定
        if (shadowLine !== undefined) {
          const enclosing = enclosingFunctionName(defLines, idx, indent);
          const enclosingLine = enclosing
            ? defLines.find(d => d.name === enclosing && d.line < idx && d.indent < indent)
            : undefined;
          if (enclosingLine && enclosingLine.line > shadowLine) {
            continue;
          }
        }
        // 热更新接口豁免
        const enclosing = enclosingFunctionName(defLines, idx, indent);
        if (enclosing && nameMatchesPattern(enclosing, settings.reloadFunctionPatterns)) {
          continue;
        }
        findings.push({
          code: CONFIG_DATA_MUTATION_CODE,
          severity: 'Warning',
          file: source.file,
          line: idx,
          // 列 = base 名在原始行内的字符偏移(Tab 计 1 列,评审三轮 P2)
          character: hit.baseIndex,
          baseName: base,
          form: hit.form,
          message:
            `配置数据写点「${base}」不在热更新接口/白名单内,配置应由 reload 接口或 mutationExclude 白名单修改。` +
            ` Config data write to "${base}" outside reload functions/exclusion list.`
        });
      }
    });
  });
  return findings;
}

// ---------------------------------------------------------------------------
// ② schema 直读(字面量类型)
// ---------------------------------------------------------------------------

/** 从 src[startIdx..] 起读一个字面量表达式类型,返回类型文本与结束下标 */
function inferLiteralType(src: string, startIdx: number, depth: number): { typeText: string; end: number } {
  let i = startIdx;
  const n = src.length;
  const skipWs = () => {
    while (i < n) {
      if (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r') {
        i += 1;
      } else if (src[i] === '#') {
        while (i < n && src[i] !== '\n') {
          i += 1;
        }
      } else {
        break;
      }
    }
  };
  skipWs();
  if (depth > 6 || i >= n) {
    return { typeText: 'Any', end: i };
  }
  const ch = src[i];
  // 字符串
  if (ch === '"' || ch === '\'' || /[fFrRbBuU]/.test(ch) && (src[i + 1] === '"' || src[i + 1] === '\'')) {
    let j = /[fFrRbBuU]/.test(ch) && (src[i + 1] === '"' || src[i + 1] === '\'') ? i + 1 : i;
    const q = src[j];
    const triple = src.slice(j, j + 3) === q.repeat(3);
    const qlen = triple ? 3 : 1;
    j += qlen;
    while (j < n) {
      if (src[j] === '\\') {
        j += 2;
        continue;
      }
      if (src.slice(j, j + qlen) === q.repeat(qlen)) {
        j += qlen;
        break;
      }
      j += 1;
    }
    return { typeText: 'str', end: j };
  }
  if (src.startsWith('True', i) || src.startsWith('False', i)) {
    return { typeText: 'bool', end: i + (src.startsWith('True', i) ? 4 : 5) };
  }
  if (src.startsWith('None', i)) {
    return { typeText: 'None', end: i + 4 };
  }
  if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
    let j = ch === '-' ? i + 1 : i;
    while (j < n && /[0-9_.eExXbBoOaAcCdDfF]/.test(src[j])) {
      j += 1;
    }
    const text = src.slice(i, j);
    return { typeText: /[.eE]/.test(text.replace(/^0[xXbBoO]/, '')) ? 'float' : 'int', end: j };
  }
  if (ch === '[') {
    // list
    let j = i + 1;
    const elemTypes: string[] = [];
    while (j < n) {
      j = skipWsFrom(src, j);
      if (src[j] === ']') {
        j += 1;
        break;
      }
      const elem = inferLiteralType(src, j, depth + 1);
      if (!elemTypes.includes(elem.typeText)) {
        elemTypes.push(elem.typeText);
      }
      j = elem.end;
      // 逗号或结尾
      while (j < n && src[j] !== ',' && src[j] !== ']') {
        j += 1;
      }
      if (src[j] === ',') {
        j += 1;
      }
    }
    const elemUnion = elemTypes.length ? elemTypes.join(' | ') : 'Any';
    return { typeText: `list[${elemUnion}]`, end: j };
  }
  if (ch === '{') {
    // dict 或 set:判定首个元素后是否跟 `:`;空 `{}` 视 dict
    let j = i + 1;
    const keyTypes: string[] = [];
    const valueTypes: string[] = [];
    const isSet = (() => {
      const probe = inferLiteralType(src, skipWsFrom(src, i + 1), depth + 1);
      let k = probe.end;
      while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) {
        k += 1;
      }
      return src[k] !== ':' && src[k] !== '}' && src[k] !== ',';
    })();
    while (j < n) {
      j = skipWsFrom(src, j);
      if (src[j] === '}') {
        j += 1;
        break;
      }
      const key = inferLiteralType(src, j, depth + 1);
      j = key.end;
      if (!isSet) {
        while (j < n && src[j] !== ':' && src[j] !== '}') {
          j += 1;
        }
        if (src[j] === ':') {
          const value = inferLiteralType(src, j + 1, depth + 1);
          if (!valueTypes.includes(value.typeText)) {
            valueTypes.push(value.typeText);
          }
          j = value.end;
        }
      }
      if (!keyTypes.includes(key.typeText)) {
        keyTypes.push(key.typeText);
      }
      while (j < n && src[j] !== ',' && src[j] !== '}') {
        j += 1;
      }
      if (src[j] === ',') {
        j += 1;
      }
    }
    if (isSet) {
      const elemUnion = keyTypes.length ? keyTypes.join(' | ') : 'Any';
      return { typeText: `set[${elemUnion}]`, end: j };
    }
    const keyUnion = keyTypes.length ? keyTypes.join(' | ') : 'Any';
    const valueUnion = valueTypes.length ? valueTypes.join(' | ') : 'Any';
    return { typeText: `dict[${keyUnion}, ${valueUnion}]`, end: j };
  }
  // 非字面量(调用/名字):落到 Any 并跳到行尾
  let j = i;
  while (j < n && src[j] !== '\n' && src[j] !== '#' && src[j] !== ',' && src[j] !== '}' && src[j] !== ']') {
    j += 1;
  }
  return { typeText: 'Any', end: j };
}

function skipWsFrom(src: string, idx: number): number {
  let j = idx;
  while (j < src.length) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      j += 1;
    } else if (c === '#') {
      while (j < src.length && src[j] !== '\n') {
        j += 1;
      }
    } else {
      break;
    }
  }
  return j;
}

export function collectConfigSchema(
  sources: readonly ConfigSourceInput[],
  settings: ConfigDataSettings
): ConfigSchemaEntry[] {
  if (!settings.enabled) {
    return [];
  }
  const out: ConfigSchemaEntry[] = [];
  for (const source of sources) {
    if (!anyGlobMatch(settings.configDirGlobs, source.file)) {
      continue;
    }
    const maskedLines = maskPythonNonCode(source.text).split(/\r?\n/);
    maskedLines.forEach((line, idx) => {
      if (indentWidth(line) !== 0) {
        return;
      }
      const trimmed = line.trim();
      // 类:注解字段汇总
      const cls = /^class\s+([A-Za-z_]\w*)/.exec(trimmed);
      if (cls && nameMatchesPattern(cls[1], settings.configClassPatterns)) {
        const fields: string[] = [];
        for (let j = idx + 1; j < maskedLines.length; j += 1) {
          const bodyLine = maskedLines[j];
          if (bodyLine.trim() && indentWidth(bodyLine) === 0) {
            break;
          }
          const fm = /^\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_][\w.\], |]*)\s*(?:=.*)?$/.exec(bodyLine);
          if (fm) {
            fields.push(`${fm[1]}: ${fm[2].trim()}`);
          }
        }
        out.push({
          name: cls[1],
          kind: 'class',
          typeText: fields.join(', '),
          file: source.file,
          line: idx
        });
        return;
      }
      // 绑定:模块级 NAME = <literal>
      const bind = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(.+)$/.exec(trimmed);
      if (bind) {
        const eqOffset = line.indexOf('=');
        const rhsStart = skipWsFrom(source.text, /* approximate global offset */ globalOffsetOf(source.text, idx, eqOffset + 1));
        const inferred = inferLiteralType(source.text, rhsStart, 0);
        if (inferred.typeText !== 'Any' || /=\s*[{[]/.test(trimmed)) {
          out.push({
            name: bind[1],
            kind: 'binding',
            typeText: inferred.typeText,
            file: source.file,
            line: idx
          });
        }
      }
    });
  }
  return out;
}

/** 行/列 → 全局字符偏移 */
function globalOffsetOf(text: string, line: number, character: number): number {
  const lines = text.split(/\r?\n/);
  let off = 0;
  for (let i = 0; i < line; i += 1) {
    off += lines[i].length + 1;
  }
  return off + character;
}
