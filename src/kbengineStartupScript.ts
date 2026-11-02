import * as vscode from 'vscode';

/**
 * KBEXP-1 启动参数与启动脚本分析面(用户令 2026-11-02;KB-001 第六篇):
 * KBEngine 各进程启动参数(CLI + 环境变量)与启动脚本链的 hover/补全/诊断。
 *
 * 事实来源(单一来源,kbe/src 源码取证,KB-001 第六篇参数表):
 *  CLI 启动参数解析在 kbe/src/lib/server/kbemain.h `parseMainCommandArgs`(:238):
 *    --cid= / --gus= / --hide= / --KBE_ROOT= / --KBE_RES_PATH= / --KBE_BIN_PATH=
 *  (无 --cidauto;未给 --cid 时 g_componentID 落 -1 = 自动,机器/日志自推导,
 *   其余进程向 machine 查询,checkComponentID kbemain.h:105-139)。
 *  环境变量(读):KBE_ROOT/KBE_RES_PATH/KBE_BIN_PATH(resmgr.cpp:140-142)、
 *    KBE_TIMING_METHOD(timestamp.cpp:102)、UID/UUID(platform.h:566-595);
 *  环境变量(各进程写出给脚本子进程):KBE_COMPONENTID/KBE_BOOTIDX_GLOBAL/
 *    KBE_BOOTIDX_GROUP(kbemain.h:100-102 setEvns)。
 *  配置文件:loadConfig(kbemain.h:66-74)读 server/kbengine_defaults.xml 再读
 *    server/kbengine.xml(元件覆盖文件,非 engine_config.xml——本引擎无此文件,
 *    kbengine*.xml 的字段悬浮已由批112 serverConfigHover.ts 承担,本模块只做
 *    启动脚本面)。
 *  启动脚本链(模板 kbe/res/sdk_templates/server/python_assets/):start_server
 *    .sh/.bat 先 kill 再按序起 machine/logger/interfaces/dbmgr/baseappmgr/
 *    cellappmgr/baseapp/cellapp/loginapp(每进程 --cid + --gus;bat 第二实例加
 *    --hide=1),start_bots 起 bots(无参,靠 machine 查 id),safe_kill 经
 *    kbcmd --getuid 取 UID 后走 cluster_controller.py stop,kill_server 按名
 *    pkill/taskkill,guiconsole.bat 起 guiconsole。
 *
 * 诊断口径(保守,低误报):只对「服务器进程启动行」检查——①未知 --xxx 参数
 * (拼写错误);②--cid=/--gus= 值非数值(类型错);③启动行引用 $KBE_RES_PATH/
 * $KBE_BIN_PATH 但本文件从未赋值且无 source(缺必要环境,进程资源解析必败)。
 * 非启动行(如 pkill/python/echo 等)一律不检,防把 --help/--version 等无关
 * 旗标误报成 KBEngine 参数。开关 kbengine.startupScriptDiagnostics(默认开)。
 */

/** CLI 启动参数文档(键=参数名,不含 `--`);双语 + 源码取证行 */
export const CLI_STARTUP_PARAM_DOCS: Record<
  string,
  { zh: string; en: string; source: string }
> = {
  cid: {
    zh: '组件 ID(组件唯一标识,uint64)。启动脚本里常给固定值;不给则落 -1 自动——machine/logger 由 UID+MAC+类型自推导,其余进程向 machine 查询组件 ID。',
    en: 'Component ID (unique per-component identity, uint64). Usually a fixed value in the startup script; if omitted it falls to -1 (auto) — machine/logger derive it from UID+MAC+type, other processes query the machine for one.',
    source: 'kbe/src/lib/server/kbemain.h:250'
  },
  gus: {
    zh: '组序号(group order,uint16,≤65535):生成 UUID 分区号,同机多实例/多组部署时区分启动批次。',
    en: 'Group order (uint16, ≤65535): the UUID generator section; distinguishes startup batches for multi-instance / multi-group deployments.',
    source: 'kbe/src/lib/server/kbemain.h:278'
  },
  hide: {
    zh: '隐藏控制台窗口(Win32 生效,取 >0 隐藏;非 Win32 为静默 no-op)。bat 里多开第二实例时常用 --hide=1 隐藏窗口。',
    en: 'Hide the console window (Win32-only; >0 hides; a silent no-op on non-Win32). Often used with --hide=1 for extra bat-launched instances.',
    source: 'kbe/src/lib/server/kbemain.h:302'
  },
  'KBE_ROOT': {
    zh: 'KBEngine 安装树根目录(setenv KBE_ROOT)。等同环境变量 KBE_ROOT,供本进程与子进程使用。',
    en: 'Root of the KBEngine install tree (setenv KBE_ROOT). Same as the KBE_ROOT environment variable, for this process and children.',
    source: 'kbe/src/lib/server/kbemain.h:331'
  },
  'KBE_RES_PATH': {
    zh: '资源搜索路径,冒号(Linux)/分号(Win32)分隔的多段目录。等同环境变量 KBE_RES_PATH,至少含 kbe/res/ 与元件 res/、scripts/。',
    en: 'Resource search path, colon- (Linux) / semicolon- (Win32) separated. Same as KBE_RES_PATH; must include kbe/res/ plus the project res/ and scripts/.',
    source: 'kbe/src/lib/server/kbemain.h:344'
  },
  'KBE_BIN_PATH': {
    zh: '服务器二进制目录(如 …/kbe/bin/server/)。等同环境变量 KBE_BIN_PATH,进程可执行文件所在。',
    en: 'Directory of the server binaries (e.g. …/kbe/bin/server/). Same as KBE_BIN_PATH; where the process executables live.',
    source: 'kbe/src/lib/server/kbemain.h:357'
  }
};

/** 环境变量文档(键=变量名) */
export const STARTUP_ENV_VAR_DOCS: Record<
  string,
  { zh: string; en: string; source: string }
> = {
  KBE_ROOT: {
    zh: 'KBEngine 安装树根目录。启动脚本先 export,进程经 resmgr 读;缺失则资源解析失败。',
    en: 'Root of the KBEngine install tree. Exported by the startup script and read via resmgr; missing means resource resolution fails.',
    source: 'kbe/src/lib/resmgr/resmgr.cpp:140'
  },
  KBE_RES_PATH: {
    zh: '资源搜索路径(多段,冒号/分号分隔)。缺失则引擎找不到 kbengine.xml/脚本,进程无法启动。',
    en: 'Resource search path (multi-segment, colon/semicolon-separated). Missing means the engine cannot find kbengine.xml/scripts and the process fails to start.',
    source: 'kbe/src/lib/resmgr/resmgr.cpp:141'
  },
  KBE_BIN_PATH: {
    zh: '服务器二进制目录。缺失则启动脚本的 $KBE_BIN_PATH/<proc> 展开为空,进程找不到。',
    en: 'Directory of server binaries. Missing means $KBE_BIN_PATH/<proc> expands empty and the process cannot be found.',
    source: 'kbe/src/lib/resmgr/resmgr.cpp:142'
  },
  KBE_TIMING_METHOD: {
    zh: '高精度计时方法选择(rdtsc / gettimeofday / gettime);未设用默认。一般无需改动。',
    en: 'High-resolution timing method (rdtsc / gettimeofday / gettime); defaults if unset. Usually no need to change.',
    source: 'kbe/src/lib/common/timestamp.cpp:102'
  },
  KBE_COMPONENTID: {
    zh: '当前组件的组件 ID 字符串(进程在 setEvns 里写出,供脚本子进程读取)。',
    en: 'The current component ID as a string (written by setEvns for script children to read).',
    source: 'kbe/src/lib/server/kbemain.h:100'
  },
  KBE_BOOTIDX_GLOBAL: {
    zh: '全局启动序号(进程写出给脚本子进程;baseapp/cellapp 再 setenv 进 Python 环境)。',
    en: 'Global boot index (written for script children; re-exported into the Python env by baseapp/cellapp).',
    source: 'kbe/src/lib/server/kbemain.h:101'
  },
  KBE_BOOTIDX_GROUP: {
    zh: '组启动序号(进程写出给脚本子进程;baseapp/cellapp 再 setenv 进 Python 环境)。',
    en: 'Group boot index (written for script children; re-exported into the Python env by baseapp/cellapp).',
    source: 'kbe/src/lib/server/kbemain.h:102'
  },
  UID: {
    zh: '用户 ID:引擎用它区分多套部署(组件 ID 推导/数据库账号)。可环境给,否则用 getuid() 或硬件摘要自动推导(autoFixUserDigestUID)。',
    en: 'User ID: used to separate deployments (component-ID derivation / DB account). May be supplied by env, else getuid() or a hardware-digest auto-derivation (autoFixUserDigestUID).',
    source: 'kbe/src/lib/common/platform.h:566'
  },
  UUID: {
    zh: '用户 ID 覆盖值(Linux 优先于 UID/getuid)。设置后即作为 UID 使用。',
    en: 'User ID override (Linux takes precedence over UID/getuid). When set it is used as the UID.',
    source: 'kbe/src/lib/common/platform.h:589'
  }
};

/**
 * 服务器进程名集合(经 parseMainCommandArgs 解析、带 KBEngine 启动参数):
 * 9 个服务器进程 + bots。kbcmd(工具,自带 --clientsdk/--outpath/--getuid 面)
 * 与 guiconsole(无参 GUI 工具)不在此列——它们的参数面不同,混入会把
 * 合法调用误报成未知参数(gensdk.sh 的 `kbcmd --clientsdk=...` 即翻车例)。
 */
export const SERVER_PROCESS_NAMES = new Set([
  'machine',
  'logger',
  'interfaces',
  'dbmgr',
  'baseappmgr',
  'cellappmgr',
  'baseapp',
  'cellapp',
  'loginapp',
  'bots'
]);

export const STARTUP_SCRIPT_DIAGNOSTIC_CODE = 'kbengine.startupScript';
export const STARTUP_SCRIPT_DIAGNOSTICS_ENABLED_DEFAULT = true;
export const STARTUP_SCRIPT_HOVER_ENABLED_DEFAULT = true;

/** 启动脚本文档判定(启动脚本链:sh/bash 与 bat/cmd) */
export function isStartupScriptDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'shellscript' || document.languageId === 'bat';
}

export interface StartupScriptFinding {
  line: number;
  start: number;
  end: number;
  message: string;
  code: string;
}

interface Token {
  kind: 'cli' | 'env';
  name: string;
  start: number;
  end: number;
  /** CLI 参数值(等号后;无值则 null) */
  value: string | null;
}

const CLI_PARAM_RE = /--([A-Za-z_][A-Za-z0-9_]*)(=([^ \t"']*))?/g;
const ENV_VAR_RE = /\b(KBE_[A-Za-z_][A-Za-z0-9_]*|UID|UUID)\b/g;

/** 行首注释起点(行首或空白后的 `#`);无注释返回 -1 */
function commentStart(line: string): number {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return i;
    }
  }
  return -1;
}

/** 行内 token 扫描:`--name[=value]` 与 `$VAR`/`VAR=`/`export VAR=` 的变量名 */
function lineTokens(line: string): Token[] {
  const tokens: Token[] = [];
  CLI_PARAM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLI_PARAM_RE.exec(line)) !== null) {
    tokens.push({
      kind: 'cli',
      name: m[1],
      start: m.index,
      end: m.index + m[0].length,
      value: m[3] ?? null
    });
  }
  ENV_VAR_RE.lastIndex = 0;
  while ((m = ENV_VAR_RE.exec(line)) !== null) {
    const prev = line[m.index - 1];
    const after = line[m.index + m[0].length];
    // 仅收「变量引用/赋值/导出」形态:`$VAR`、`export VAR=`、`VAR=`;裸词
    // (如注释里提到)不收,防 GUID 之类误匹配
    const isRef = prev === '$';
    const isAssign = after === '=' || (line.slice(0, m.index).trimEnd().endsWith('export'));
    if (!isRef && !isAssign) {
      continue;
    }
    tokens.push({
      kind: 'env',
      name: m[1],
      // `$VAR` 引用把 `$` 并入 token 区间(悬浮/画线都盖住 `$`)
      start: isRef ? m.index - 1 : m.index,
      end: m.index + m[0].length,
      value: null
    });
  }
  return tokens.sort((a, b) => a.start - b.start);
}

function docsFor(token: Token): { zh: string; en: string; source: string } | null {
  if (token.kind === 'cli') {
    return CLI_STARTUP_PARAM_DOCS[token.name] ?? null;
  }
  return STARTUP_ENV_VAR_DOCS[token.name] ?? null;
}

function hoverForToken(token: Token): vscode.Hover | null {
  const docs = docsFor(token);
  if (!docs) {
    return null;
  }
  const prefix = token.kind === 'cli' ? '--' : '';
  const kindLabel = token.kind === 'cli' ? 'CLI 启动参数' : '环境变量';
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**\`${prefix}${token.name}\`** — ${kindLabel}\n\n`);
  md.appendMarkdown(`${docs.zh}\n\n`);
  md.appendMarkdown(`*${docs.en}*\n\n`);
  md.appendMarkdown(`来源: \`${docs.source}\``);
  return new vscode.Hover(md);
}

/** CLI token 的「参数名」区间(不含 `=value`):悬浮/画线只盖 --name */
function cliNameRange(token: Token): { start: number; end: number } {
  return { start: token.start, end: token.start + 2 + token.name.length };
}

/** 启动脚本悬浮:命中已知 `--param` 或 `$VAR`/`VAR=` 的变量名 → 文档 */
export function provideStartupScriptHover(
  lines: readonly string[],
  line: number,
  character: number
): vscode.Hover | null {
  if (line < 0 || line >= lines.length) {
    return null;
  }
  const text = lines[line];
  const commentAt = commentStart(text);
  for (const token of lineTokens(text)) {
    if (commentAt >= 0 && token.start >= commentAt) {
      break;
    }
    const { start, end } = token.kind === 'cli' ? cliNameRange(token) : token;
    // 光标在 token 区间(值区不悬停参数名;`$` 并进 env 区间)
    if (character >= start && character <= end) {
      return hoverForToken(token);
    }
  }
  return null;
}

/** 启动脚本补全:`--` 前缀 → CLI 参数;`KBE_` 前缀(含 $) → 环境变量 */
export function provideStartupScriptCompletions(
  lines: readonly string[],
  line: number,
  character: number
): vscode.CompletionItem[] | null {
  if (line < 0 || line >= lines.length) {
    return null;
  }
  const text = lines[line];
  const commentAt = commentStart(text);
  if (commentAt >= 0 && character > commentAt) {
    return null;
  }
  // 向左扫当前词([A-Za-z0-9_-]),前缀决定补全域
  let start = character;
  while (start > 0 && /[A-Za-z0-9_-]/.test(text[start - 1])) {
    start -= 1;
  }
  const prefix = text.slice(start, character);
  if (prefix.startsWith('--')) {
    return Object.entries(CLI_STARTUP_PARAM_DOCS).map(([name, docs]) => {
      const item = new vscode.CompletionItem(`--${name}=`, vscode.CompletionItemKind.Property);
      item.detail = `${name === 'cid' || name === 'gus' ? 'uint' : 'string'}`;
      item.documentation = new vscode.MarkdownString(docs.zh);
      return item;
    });
  }
  if (/^\$?KBE_[A-Za-z0-9_]*$/.test(prefix)) {
    return Object.entries(STARTUP_ENV_VAR_DOCS)
      .filter(([name]) => name.startsWith('KBE_'))
      .map(([name, docs]) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
        item.detail = 'env';
        item.documentation = new vscode.MarkdownString(docs.zh);
        return item;
      });
  }
  return null;
}

/** 行首命令的可执行名(去引号/去路径/去 .exe);非命令段返回 null */
function commandName(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed) {
    return null;
  }
  let first = trimmed.split(/[ \t]/)[0];
  first = first.replace(/^["']/, '').replace(/["']$/, '');
  const slash = first.lastIndexOf('/');
  if (slash >= 0) {
    first = first.slice(slash + 1);
  }
  const backslash = first.lastIndexOf('\\');
  if (backslash >= 0) {
    first = first.slice(backslash + 1);
  }
  if (first.endsWith('.exe')) {
    first = first.slice(0, -4);
  }
  return first || null;
}

/** 行内启动段切割(按 ; & |,含 && / || 边界) */
function commandSegments(line: string): string[] {
  return line.split(/[;&|]/);
}

/**
 * 启动脚本诊断:仅检查「服务器进程启动行」——①未知 --xxx(拼写错误);
 * ②--cid=/--gus= 值非数值;③启动行引用 $KBE_RES_PATH/$KBE_BIN_PATH 但
 * 本文件从未赋值且无 source(缺必要环境)。非启动行不检。
 */
export function computeStartupScriptFindings(text: string): StartupScriptFinding[] {
  const lines = text.split(/\r?\n/);
  const findings: StartupScriptFinding[] = [];
  const hasSource = /\b(source|\.)\s+[^ \t]/.test(text);
  const assigns = (name: string): boolean =>
    new RegExp(`(^|[^A-Za-z0-9_])${name}\\s*=`).test(text);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    for (const segment of commandSegments(line)) {
      const cmd = commandName(segment);
      if (cmd === null || !SERVER_PROCESS_NAMES.has(cmd)) {
        continue;
      }
      // —— 启动行:逐个 token 检 ——
      const tokens = lineTokens(segment);
      for (const token of tokens) {
        if (token.kind !== 'cli') {
          continue;
        }
        const segStart = line.indexOf(segment);
        const { start, end } = cliNameRange(token);
        const globalStart = segStart + start;
        const globalEnd = segStart + end;
        if (!CLI_STARTUP_PARAM_DOCS[token.name]) {
          findings.push({
            line: idx,
            start: globalStart,
            end: globalEnd,
            message: `未知启动参数 --${token.name}(应为 --cid / --gus / --hide / --KBE_ROOT / --KBE_RES_PATH / --KBE_BIN_PATH;疑似拼写错误)`,
            code: STARTUP_SCRIPT_DIAGNOSTIC_CODE
          });
          continue;
        }
        if (
          (token.name === 'cid' || token.name === 'gus') &&
          token.value !== null &&
          !/^\d+$/.test(token.value)
        ) {
          findings.push({
            line: idx,
            start: globalStart,
            end: globalEnd,
            message: `--${token.name} 值应为数字(收到「${token.value}」;uint${token.name === 'cid' ? '64' : '16'})`,
            code: STARTUP_SCRIPT_DIAGNOSTIC_CODE
          });
        }
      }
      // —— 缺必要环境:启动行用 $KBE_*,本文件未赋值且无 source ——
      if (!hasSource) {
        for (const env of ['KBE_RES_PATH', 'KBE_BIN_PATH', 'KBE_ROOT']) {
          if (new RegExp(`\\$${env}\\b`).test(segment) && !assigns(env)) {
            findings.push({
              line: idx,
              start: Math.max(0, line.indexOf(`$${env}`)),
              end: Math.max(0, line.indexOf(`$${env}`) + env.length + 1),
              message: `启动行使用了 $${env} 但本文件从未赋值且未 source 其他文件——引擎读不到资源路径,进程无法启动`,
              code: STARTUP_SCRIPT_DIAGNOSTIC_CODE
            });
          }
        }
      }
      // 每段只检一个命令(启动行通常单命令)
      break;
    }
  }
  return findings;
}

/** 启动脚本悬浮提供者(随扩展装配注册;kbengine.hover.startupScript 开关默认开) */
export class StartupScriptHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    if (
      !vscode.workspace
        .getConfiguration('kbengine')
        .get<boolean>('hover.startupScript', STARTUP_SCRIPT_HOVER_ENABLED_DEFAULT)
    ) {
      return null;
    }
    return provideStartupScriptHover(
      document.getText().split(/\r?\n/),
      position.line,
      position.character
    );
  }
}

/** 启动脚本补全提供者(随扩展装配注册;与悬浮同开关 kbengine.hover.startupScript) */
export class StartupScriptCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (
      !vscode.workspace
        .getConfiguration('kbengine')
        .get<boolean>('hover.startupScript', STARTUP_SCRIPT_HOVER_ENABLED_DEFAULT)
    ) {
      return null;
    }
    return provideStartupScriptCompletions(
      document.getText().split(/\r?\n/),
      position.line,
      position.character
    );
  }
}
