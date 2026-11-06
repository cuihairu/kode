/**
 * 配置契约检查诊断(config contract diagnostics,内网开发机环境适配审核
 * docs/analysis/intranet-env-audit.md §4/§5,用户会话建议序 #2):
 *
 * kode 的 .def/entities.xml 层诊断很强,但工作区「配置层」是 0 覆盖——真实
 * 内网机(D:\kbengine)暴露的 4 项配置层事实全部只能人肉 review + 线上复现
 * 才能发现:
 *   ① 工作区 extraPaths 配错(../../kbe/typings 应为 ../kbe/typings);
 *   ② .gitignore 缺 .kbengine/;
 *   ③ .kbengine/debug.json 的 components 为空、四组件 telnet 段全被注释
 *      (loginapp 31000 / dbmgr 32000 / baseapp 40000 / cellapp 50000),
 *      Start Debugging 无预设目标;
 *   ④ CLAUDE.md 声明的 telnet 密码(pwd123456,引擎默认)与项目实值冲突。
 *
 * 本模块是唯一纯逻辑面:computeConfigContractFindings 不 import vscode,
 * 文件/目录存在性由调用方注入(装配层 fs,测试桩),每条 finding 带
 * severity + 中英双语修复建议文案。开关 kbengine.configContractDiagnostics
 * 默认开;关闭即零产出。
 */

/** 组件默认清单(与 src/debugConfig.ts SOURCE_DEFAULT_COMPONENTS 同源;此处
 * 复制以保持本模块零 vscode/零内部依赖——SOURCE_DEFAULT_COMPONENTS 所在文件
 * 顶层 import vscode,纯逻辑测试直载会引入替身依赖。两处表如失同步,以
 * debugConfig.ts 为正本,本表注释即为对账锚点)。 */
const KNOWN_COMPONENTS: ReadonlyArray<{ name: string; telnetPort: number }> = [
  { name: 'loginapp', telnetPort: 31000 },
  { name: 'dbmgr', telnetPort: 32000 },
  { name: 'interfaces', telnetPort: 33000 },
  { name: 'logger', telnetPort: 34000 },
  { name: 'baseapp', telnetPort: 40000 },
  { name: 'cellapp', telnetPort: 50000 },
  { name: 'bots', telnetPort: 51000 }
];

export const CONFIG_CONTRACT_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 诊断 code 前缀(与 kbengine.receiverNone 同款稳定 code 纪律) */
export const CONFIG_CONTRACT_DIAGNOSTIC_CODE_PREFIX = 'kbengine.configContract';

export interface ConfigContractDebugJsonInput {
  /** .kbengine/debug.json 是否在盘 */
  exists: boolean;
  /** 原始文本(JSONC,带注释形态);不在盘或缺文本传 undefined */
  text?: string;
}

export interface ConfigContractDocFileInput {
  /** 文件名(CLAUDE.md / README.md 等),finding 以此锚定 */
  name: string;
  text: string;
}

export interface ConfigContractWorkspaceInput {
  debugJson?: ConfigContractDebugJsonInput;
  /** python.analysis.extraPaths 现值(装配层取工作区配置) */
  extraPaths?: readonly string[];
  /**
   * extraPaths 条目指向的目录存在性(注入;装配层为 fs.existsSync 包装,
   * 相对条目按工作区根解析后判定)。缺省(未注入)= 跳过存在性检查,不猜。
   */
  extraPathExists?: (path: string) => boolean;
  gitignore?: { exists: boolean; text?: string };
  /** 根目录文档(CLAUDE.md/README 等)声明对账输入 */
  docs?: readonly ConfigContractDocFileInput[];
  /** kbengine.configContractDiagnostics 开关(默认开) */
  enabled?: boolean;
}

export interface ConfigContractFinding {
  code: string;
  severity: 'Warning' | 'Error' | 'Information';
  /** 诊断锚定文件(debug.json / settings.json / .gitignore / 文档名) */
  file: string;
  /** 0 起行(无法定位为 0) */
  line: number;
  /** 0 起列(恒 0,行级诊断) */
  character: number;
  /** 中英双语消息 + 修复建议 */
  message: string;
}

/** finding 构造helper:统一 file/line/character 形态 */
const finding = (
  code: string,
  file: string,
  line: number,
  message: string
): ConfigContractFinding => ({
  code,
  severity: 'Warning',
  file,
  line,
  character: 0,
  message
});

/**
 * JSONC 剥注释(仅 debug.json 解析用):走字符态机,字符串内的 `//` 与
 * `/*` 不剥;坏 JSON 由调用方按 unparsable 口径处理。
 */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (inString) {
      out += char;
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') { inString = false; }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') { i += 1; }
      out += i < text.length ? '\n' : '';
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
}

interface ParsedDebugJson {
  ok: boolean;
  /** debug.components(解析成功才有) */
  components: Record<string, unknown> | null;
}

/** 解析 debug.json 文本:剥注释 → JSON.parse → 取 debug.components */
function parseDebugJsonText(text: string): ParsedDebugJson {
  try {
    const parsed = JSON.parse(stripJsonComments(text)) as Record<string, unknown> | null;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, components: null };
    }
    const debug = parsed['debug'];
    if (debug === null || typeof debug !== 'object' || Array.isArray(debug)) {
      return { ok: true, components: null };
    }
    const components = (debug as Record<string, unknown>)['components'];
    if (components === null || typeof components !== 'object' || Array.isArray(components)) {
      return { ok: true, components: null };
    }
    return { ok: true, components: components as Record<string, unknown> };
  } catch {
    return { ok: false, components: null };
  }
}

/** telnet 段整段被注释的文本层检出:注释行里出现 telnetPort 即视为被注释 */
const hasCommentedTelnetSection = (text: string): boolean =>
  text.split(/\r?\n/).some(line => /^\s*\/\//.test(line) && /telnetPort|telnet_port/i.test(line));

const knownPortOf = (name: string): number | undefined =>
  KNOWN_COMPONENTS.find(c => c.name === name)?.telnetPort;

/** 组件 telnet 端口取值(数字才认;缺/非数字按缺失口径) */
const telnetPortOf = (component: Record<string, unknown>): number | undefined => {
  const port = component['telnetPort'];
  return typeof port === 'number' && Number.isFinite(port) ? port : undefined;
};

const telnetPasswordOf = (component: Record<string, unknown>): string | undefined => {
  const pwd = component['telnetPassword'];
  return typeof pwd === 'string' && pwd.length > 0 ? pwd : undefined;
};

/**
 * 文档声明式密码行:`telnet 密码: xxx` / `telnetPassword: xxx` /
 * `telnet password: <password> xxx </password>` / 反引号包裹等形态。
 * 返回声明值与其 0 起行号。
 */
function findDocPasswordDecl(text: string): Array<{ value: string; line: number }> {
  const decls: Array<{ value: string; line: number }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /(?:telnetPwd(?:word)?|telnet[_-]?password|telnet[_-]?pass|密码|password)\s*[:：=]\s*<?\s*`?\s*([^\s`<>]+)/i.exec(lines[i]);
    if (match) {
      decls.push({ value: match[1], line: i });
    }
  }
  return decls;
}

/** 文档声明式组件端口行:必须点名组件才对账(不猜归属) */
function findDocPortDecls(text: string): Array<{ component: string; port: number; line: number }> {
  const decls: Array<{ component: string; port: number; line: number }> = [];
  const lines = text.split(/\r?\n/);
  const componentPattern = KNOWN_COMPONENTS.map(c => c.name).join('|');
  for (let i = 0; i < lines.length; i += 1) {
    const match = new RegExp(
      `(${componentPattern})[^\\n]{0,64}?(?:telnet[_-]?port|端口)\\s*[:：=]\\s*(\\d{4,5})`,
      'i'
    ).exec(lines[i]);
    if (match) {
      decls.push({ component: match[1].toLowerCase(), port: Number(match[2]), line: i });
    }
  }
  return decls;
}

/** debug.json 维度:components 空/缺、unparsable、telnet 注释段、端口缺失/偏离 */
function debugJsonFindings(input: ConfigContractWorkspaceInput): ConfigContractFinding[] {
  const findings: ConfigContractFinding[] = [];
  const debugJson = input.debugJson;
  if (!debugJson || !debugJson.exists || typeof debugJson.text !== 'string') {
    // debug.json 不在盘:零噪声(缺失面由 startDebugging 显式提示,不在此重复)
    return findings;
  }
  const parsed = parseDebugJsonText(debugJson.text);
  if (!parsed.ok) {
    findings.push(finding(
      'kbengine.configContract.debugJsonUnparsable',
      'debug.json',
      0,
      'debug.json 无法解析为 JSON(JSONC 剥注释后仍非法),components 按缺失处理,'
      + '调试面将回落骨架默认配置。'
      + ' (English: debug.json is not valid JSON after comment stripping; components are treated as missing '
      + 'and the debug surface falls back to skeleton defaults.) 修复:修正 JSON 语法 '
      + '(Fix: correct the JSON syntax in .kbengine/debug.json.)'
    ));
    return findings;
  }
  const components = parsed.components;
  if (components === null || Object.keys(components).length === 0) {
    const commented = hasCommentedTelnetSection(debugJson.text);
    findings.push(finding(
      'kbengine.configContract.debugComponentsEmpty',
      'debug.json',
      0,
      'debug.components 为空或缺失:Start Debugging / telnet 目标派生 / debugpy '
      + '下一步均无预设目标,调试面退化为裸 TCP。'
      + ' (English: debug.components is empty or missing — Start Debugging, telnet target derivation '
      + 'and debugpy next-step have no preset targets.) 修复:在 .kbengine/debug.json 的 '
      + 'debug.components 下按组件填写(骨架示例带 loginapp/dbmgr/interfaces/logger/'
      + 'baseapp/cellapp/bots 全套; commented-out 示例可直接取消注释)。'
      + ' (Fix: fill debug.components per component in .kbengine/debug.json, or uncomment the skeleton examples.)'
      + (commented ? ' 注意:检测到 telnet 段整段处于注释状态。'
        + ' (Note: a commented-out telnet section was detected in the file text.)' : '')
    ));
    if (commented) {
      findings.push(finding(
        'kbengine.configContract.debugTelnetCommented',
        'debug.json',
        0,
        'debug.json 的 telnet 段(telnetPort 行)整段被注释:解析结果为空 components,'
        + '四组件预设目标(loginapp 31000 / dbmgr 32000 / baseapp 40000 / cellapp 50000)全部不可用。'
        + ' (English: the telnet section in debug.json is commented out; the parsed components are empty and '
        + 'no preset telnet targets are available.) 修复:取消注释并按实际端口填写。'
        + ' (Fix: uncomment the telnet section and fill the actual ports.)'
      ));
    }
    return findings;
  }
  for (const [name, raw] of Object.entries(components)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const component = raw as Record<string, unknown>;
    const known = knownPortOf(name);
    const port = telnetPortOf(component);
    if (known !== undefined && port === undefined) {
      findings.push(finding(
        'kbengine.configContract.debugTelnetPortMissing',
        'debug.json',
        0,
        `组件 ${name} 未声明 telnetPort(引擎已知默认 ${known}):telnet 目标派生将落到空端口,连接期才报错。`
        + ` (English: component ${name} declares no telnetPort (engine default ${known}); telnet targets will `
        + 'resolve to nothing and the failure only surfaces at connect time.)'
        + ` 修复:为 ${name} 填写 telnetPort: ${known}。 (Fix: set "telnetPort": ${known} for ${name}.)`
      ));
    } else if (known !== undefined && port !== known) {
      findings.push(finding(
        'kbengine.configContract.debugTelnetPortMismatch',
        'debug.json',
        0,
        `组件 ${name} 的 telnetPort=${port} 偏离引擎已知默认 ${known}:若非有意改端口,派生目标将指向不存在的监听。`
        + ` (English: component ${name} has telnetPort=${port}, off the engine default ${known}; unless the port was `
        + 'changed on purpose, derived targets point at a listener that does not exist.)'
        + ` 修复:改回 telnetPort: ${known} 或确认引擎侧端口已同步修改。`
        + ` (Fix: set "telnetPort": ${known}, or confirm the engine side was reconfigured to ${port}.)`
      ));
    }
  }
  return findings;
}

/**
 * 绝对路径判定(CFG-02):Windows 盘符根(`C:\`/`C:/`)、UNC/根相对反斜杠、
 * POSIX 根。`${workspaceFolder}/...` 变量形态与相对条目不算绝对。
 */
const isAbsolutePathEntry = (entry: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(entry) || entry.startsWith('/') || entry.startsWith('\\');

/** extraPaths 维度:绝对路径(CFG-02,先报根因)、../../ 双层上跳、指向不存在目录 */
function extraPathsFindings(input: ConfigContractWorkspaceInput): ConfigContractFinding[] {
  const findings: ConfigContractFinding[] = [];
  for (const entry of input.extraPaths ?? []) {
    if (isAbsolutePathEntry(entry)) {
      findings.push(finding(
        'kbengine.configContract.extraPathsAbsolute',
        'settings.json',
        0,
        `extraPaths 条目 "${entry}" 是绝对路径:换机器/换盘符即失效,不可移植。`
        + '生成面已一律写 ${workspaceFolder}/... 变量形态,工作区前缀可替换的存量绝对路径'
        + '会在下次同步时自动迁移;此条不可替换,需人工处理。'
        + ` (English: extraPaths entry "${entry}" is an absolute path — it breaks on another machine or drive `
        + 'letter. The generator now always writes ${workspaceFolder}/... variable form, and legacy absolute '
        + 'entries with the workspace prefix migrate automatically on the next sync; this one is not migratable '
        + 'and needs a manual fix.)'
        + ' 修复:改为 ${workspaceFolder}/... 形态或删除该条目。'
        + ' (Fix: rewrite it as ${workspaceFolder}/... or remove the entry.)'
      ));
      continue;
    }
    if (entry.includes('../..') || entry.includes('..\\..')) {
      findings.push(finding(
        'kbengine.configContract.extraPathsDoubleUp',
        'settings.json',
        0,
        `extraPaths 条目 "${entry}" 含 ../../ 双层上跳:KBEngine 标准布局下 assets 与 kbe/ 同级,`
        + 'kbe/typings 只需一层上跳(../kbe/typings);双层上跳越过了引擎目录,Pylance 解析不到 '
        + 'KBEngine.pyi 与 common.*,import KBEngine 全线报 unknown import。'
        + ` (English: extraPaths entry "${entry}" climbs two levels; in the standard KBEngine layout the assets dir `
        + 'and kbe/ are siblings, so kbe/typings needs exactly one level up (../kbe/typings). Two levels skip past '
        + 'the engine dir and Pylance cannot resolve KBEngine.pyi / common.*)'
        + ` 修复:改为 "${'../kbe/typings'}" 形态。 (Fix: change the entry to "../kbe/typings".)`
      ));
      continue;
    }
    if (input.extraPathExists && !input.extraPathExists(entry)) {
      findings.push(finding(
        'kbengine.configContract.extraPathsMissingDir',
        'settings.json',
        0,
        `extraPaths 条目 "${entry}" 指向的目录不存在:该条目对解析零贡献,还可能掩盖路径拼写错误。`
        + ` (English: extraPaths entry "${entry}" points to a directory that does not exist; it contributes nothing `
        + 'to resolution and may mask a path typo.)'
        + ` 修复:核对相对工作区根的实际目录名,或移除该条目。`
        + ` (Fix: verify the directory name relative to the workspace root, or remove the entry.)`
      ));
    }
  }
  return findings;
}

/** .gitignore 维度:缺 .kbengine/ 托管目录条目 */
function gitignoreFindings(input: ConfigContractWorkspaceInput): ConfigContractFinding[] {
  const gitignore = input.gitignore;
  if (!gitignore || !gitignore.exists || typeof gitignore.text !== 'string') {
    // 非 git 仓/文件不在盘:零噪声
    return [];
  }
  const hasKbengineEntry = gitignore.text.split(/\r?\n/).some(line => {
    const trimmed = line.trim();
    return trimmed === '.kbengine' || trimmed === '.kbengine/' || trimmed.endsWith('/.kbengine') ||
      trimmed.endsWith('/.kbengine/');
  });
  if (hasKbengineEntry) {
    return [];
  }
  return [finding(
    'kbengine.configContract.gitignoreMissingKbengine',
    '.gitignore',
    0,
    '.gitignore 缺 .kbengine/ 条目:该目录是 kode 托管产物(.kbengine/stubs 存根导出、'
    + '含 telnet 密码的 debug.json 等),漏配一次 git add -A 就会把机器本地产物(含明文密码)'
    + '提交进仓。'
    + ' (English: .gitignore has no .kbengine/ entry; the directory holds kode-managed artifacts '
    + '(.kbengine/stubs stub export, debug.json containing the telnet password) — one "git add -A" would commit '
    + 'machine-local artifacts including a plaintext password.)'
    + ' 修复:在 .gitignore 追加一行 .kbengine/。 (Fix: append a ".kbengine/" line to .gitignore.)'
  )];
}

/** 文档声明 vs debug.json 实值:密码/端口冲突对账 */
function docConflictFindings(input: ConfigContractWorkspaceInput): ConfigContractFinding[] {
  const findings: ConfigContractFinding[] = [];
  const debugJson = input.debugJson;
  const parsed = debugJson && debugJson.exists && typeof debugJson.text === 'string'
    ? parseDebugJsonText(debugJson.text)
    : null;
  const components = parsed?.components ?? null;

  // 密码对账:文档声明值与任一组件实值都不一致(且确有组件配了密码)才报;
  // debug.json 未配密码时无从对账,不猜。
  const configuredPasswords = components
    ? Object.entries(components)
      .map(([name, raw]) => {
        const pwd = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? telnetPasswordOf(raw as Record<string, unknown>)
          : undefined;
        return pwd ? { name, pwd } : null;
      })
      .filter((v): v is { name: string; pwd: string } => v !== null)
    : [];
  if (configuredPasswords.length > 0) {
    const actualValues = Array.from(new Set(configuredPasswords.map(p => p.pwd)));
    for (const doc of input.docs ?? []) {
      for (const decl of findDocPasswordDecl(doc.text)) {
        if (!actualValues.includes(decl.value)) {
          findings.push(finding(
            'kbengine.configContract.telnetPasswordDocConflict',
            doc.name,
            decl.line,
            `文档声明的 telnet 密码 "${decl.value}" 与 debug.json 实值不一致`
            + `(实值: ${actualValues.map(v => `"${v}"`).join(' / ')},组件 `
            + `${configuredPasswords.map(p => p.name).join('/')})——按文档走 telnet 将全部认证失败,`
            + '且错误声明会传染给照抄文档的自动化(AI 会话/CI 脚本)。'
            + ` (English: the documented telnet password "${decl.value}" does not match the actual debug.json value `
            + `(actual: ${actualValues.map(v => `"${v}"`).join(' / ')} on component `
            + `${configuredPasswords.map(p => p.name).join('/')}) — telnet auth fails per the doc, and a wrong doc `
            + 'statement leaks into anything that copies it.)'
            + ' 修复:以 debug.json 实值为准更新文档声明(或反向核对哪一侧写错)。'
            + ' (Fix: update the doc to the debug.json value, or verify which side is wrong.)'
          ));
        }
      }
    }
  }

  // 端口对账:文档行点名组件才对账(不猜归属)
  if (components) {
    for (const doc of input.docs ?? []) {
      for (const decl of findDocPortDecls(doc.text)) {
        const raw = components[decl.component];
        const actual = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? telnetPortOf(raw as Record<string, unknown>)
          : undefined;
        if (actual !== undefined && actual !== decl.port) {
          findings.push(finding(
            'kbengine.configContract.telnetPortDocConflict',
            doc.name,
            decl.line,
            `文档声明组件 ${decl.component} telnet 端口 ${decl.port},与 debug.json 实值 ${actual} 不一致`
            + '——按文档连接将落到不存在的监听。'
            + ` (English: the doc declares ${decl.component} telnet port ${decl.port} but debug.json has ${actual}; `
            + 'connecting per the doc hits a listener that does not exist.)'
            + ` 修复:统一两侧端口为 ${actual}。 (Fix: align both sides on ${actual}.)`
          ));
        }
      }
    }
  }
  return findings;
}

/**
 * 配置契约检查入口(纯函数):对 KBEngine 工作区配置层做只读契约检查,
 * 每条 finding 带 severity + 中英双语修复建议;开关关闭零产出;干净输入
 * 零产出。不做任何写入(extraPaths/gitignore/文档均只读,与既有
 * pythonExtraPaths「用户段永不被动」纪律互补)。
 */
export function computeConfigContractFindings(
  input: ConfigContractWorkspaceInput
): ConfigContractFinding[] {
  if (input.enabled === false) {
    return [];
  }
  return [
    ...debugJsonFindings(input),
    ...extraPathsFindings(input),
    ...gitignoreFindings(input),
    ...docConflictFindings(input)
  ];
}
