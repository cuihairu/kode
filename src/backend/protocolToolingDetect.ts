//! PA-007(todo.md Phase 5):协议工具链检测——Wireshark/TShark/KBEngine
//! 插件/kode-kbengine CLI 的版本与安装状态解析。
//!
//! 本模块是纯函数面:只解析 CLI 输出文本,零 vscode/child_process 依赖,
//! 可独立单测;spawn 与命令接线在 wiring 侧(PA-007 后续增量)。解析规则
//! 以本机 tshark 4.6.4 实测输出为基准(见 tests fixture),上游输出格式
//! 变化时先扩测试再扩解析,不静默吞错。

/** `tshark -G plugins` 一行:`name<TAB>version<TAB>type<TAB>path`。 */
export interface TsharkPluginEntry {
  name: string;
  version: string;
  type: string;
  path: string;
}

/** `tshark -G folders` 里与本集成相关的两个插件目录。 */
export interface TsharkPluginFolders {
  personalPlugins: string | null;
  globalPlugins: string | null;
}

/** `tshark -v` 首行 `TShark (Wireshark) 4.6.4.` → `4.6.4`(尾句点非版本)。 */
export function parseTsharkVersion(firstLine: string): string | null {
  const match = /^TShark \(Wireshark\) (\d+\.\d+(?:\.\d+)?)/.exec(firstLine);
  return match ? match[1] : null;
}

/** `wireshark -v` 首行 `Wireshark 4.6.4 (...)` → `4.6.4`;GUI 未装如实 null。 */
export function parseWiresharkVersion(firstLine: string): string | null {
  const match = /^Wireshark (\d+\.\d+(?:\.\d+)?)/.exec(firstLine);
  return match ? match[1] : null;
}

/**
 * `tshark -G plugins` 全量解析:严格 4 列 TAB 分隔,列数/空白不符的行
 * 如实跳过(检测报告宁缺毋错);全空输入返回空数组。
 */
export function parseTsharkPlugins(stdout: string): TsharkPluginEntry[] {
  const entries: TsharkPluginEntry[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const fields = trimmed.split('\t');
    if (fields.length !== 4) {
      continue;
    }
    const [name, version, type, path] = fields;
    if (name === '' || version === '' || type === '' || path === '') {
      continue;
    }
    entries.push({ name, version, type, path });
  }
  return entries;
}

/** 命中 KBEngine dissector 插件(type=dissector 且文件名含 kbengine)。 */
export function findKbengineDissector(
  entries: TsharkPluginEntry[]
): TsharkPluginEntry | null {
  return (
    entries.find(
      (entry) => entry.type === 'dissector' && entry.name.includes('kbengine')
    ) ?? null
  );
}

/**
 * `tshark -G folders` 解析:每行 `标签:补空格<TAB>路径`(标签自带冒号,
 * 冒号后按列宽补空格);只取两行插件目录,其余(Lua/个人 Lua 等)忽略。
 * 未安装/格式漂移 → 对应 null。
 */
export function parseTsharkFolders(stdout: string): TsharkPluginFolders {
  let personal: string | null = null;
  let global: string | null = null;
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const label = line.slice(0, tab).trimEnd().replace(/:$/, '');
    const value = line.slice(tab + 1).trim();
    if (label === 'Personal Plugins') {
      personal = value;
    } else if (label === 'Global Plugins') {
      global = value;
    }
  }
  return { personalPlugins: personal, globalPlugins: global };
}

/** `kode-kbengine --version` 单行输出 → semver(`0.2.0`);畸形输出 null。 */
export function parseCliVersion(stdout: string): string | null {
  const match = /^kode-kbengine (\d+\.\d+\.\d+)$/.exec(stdout.trim());
  return match ? match[1] : null;
}

/** `4.6.4` → `4.6`(宿主版本线,插件目录 `<maj.min>` 子目录口径);`4.6` 原样。 */
export function wiresharkVersionLine(version: string): string | null {
  const match = /^(\d+\.\d+)(?:\.|$)/.exec(version);
  return match ? match[1] : null;
}

/**
 * 插件落盘目录版本线与宿主版本线是否一致(PA-006 实勘:plugin_want_major/
 * minor 必须匹配宿主,4.6 插件不进 4.4 宿主;目录 `<maj.min>` 即目标版本线)。
 * pluginPath 无 `/plugins/<maj.min>/` 形态(如个人目录手动放置)→ null 未知,
 * 报告如实标未知,不猜。
 */
export function pluginFolderMatchesHost(
  pluginPath: string,
  tsharkVersion: string
): boolean | null {
  const host = wiresharkVersionLine(tsharkVersion);
  if (host === null) {
    return null;
  }
  const match = /[/\\]plugins[/\\](\d+\.\d+)[/\\]/.exec(pluginPath);
  if (match === null) {
    return null;
  }
  return match[1] === host;
}
