/**
 * ~/.ssh/config 解析(IDE-PDBG-004 远程服务器管理视图的数据源):
 * Host 块逐一收 HostName/User/Port/ProxyJump(跳板链),供远程 debug 与
 * py-spy 分派用。只认常见键,Include 指令不展开(如实标注局限,主机
 * 写在被 include 的文件里不会出现)。通配 Host 模式(星号与问号)按
 * ssh 语义是匹配模板不是具体主机,视图不列。
 */

export interface SshHostEntry {
  /** Host 行的别名(视图与 debug.json 连接声明引用的就是它) */
  host: string;
  /** HostName 实际主机;缺省 = 别名本身(ssh 语义) */
  hostname?: string;
  user?: string;
  port?: number;
  /** ProxyJump 跳板链(如 bastion 或 bastion1,bastion2) */
  proxyJump?: string;
}

/** 通配模式(ssh 把星号与问号当匹配模板,不是具体主机):视图与选择面都不列 */
export function isWildcardHostPattern(host: string): boolean {
  return host.includes('*') || host.includes('?');
}

/**
 * 解析 ssh_config 文本:逐行扫 `Host` 开块,块内收 HostName/User/Port/
 * ProxyJump(键大小写不敏感,`=` 与空白分隔都认);negated host(`!`)跳过
 * 整块。Host 行多个别名时逐别名各立一条(同块参数共享)。
 */
export function parseSshConfig(text: string): SshHostEntry[] {
  const entries: SshHostEntry[] = [];
  let current: { aliases: string[]; hostname?: string; user?: string; port?: number; proxyJump?: string } | null = null;
  const flush = (): void => {
    if (current === null) {
      return;
    }
    for (const alias of current.aliases) {
      if (isWildcardHostPattern(alias) || alias.startsWith('!')) {
        continue;
      }
      entries.push({
        host: alias,
        hostname: current.hostname,
        user: current.user,
        port: current.port,
        proxyJump: current.proxyJump
      });
    }
    current = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    // 井号注释(引号内井号不剥——键值里带 # 的主机名极罕见,保守不处理)
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (line.length === 0) {
      continue;
    }
    // `Key=Value` 与 `Key Value` 两种形(ssh_config 手册口径)
    const normalized = line.includes('=') && /^[A-Za-z]/.test(line)
      ? line.replace('=', ' ')
      : line;
    const separator = normalized.indexOf(' ');
    if (separator < 0) {
      continue;
    }
    const key = normalized.slice(0, separator).toLowerCase();
    const value = normalized.slice(separator + 1).trim();
    if (key === 'host') {
      flush();
      const aliases = value.split(/\s+/).filter(alias => alias.length > 0);
      if (aliases.length > 0) {
        current = { aliases };
      }
      continue;
    }
    if (current === null || value.length === 0) {
      continue; // 块外的散键不属任何主机,忽略
    }
    if (key === 'hostname') {
      current.hostname = value;
    } else if (key === 'user') {
      current.user = value;
    } else if (key === 'port') {
      const port = Number(value);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        current.port = port;
      }
    } else if (key === 'proxyjump') {
      current.proxyJump = value;
    }
    // 其余键(Match/Include/IdentityFile…)不进视图面:Include 不展开是
    // 如实局限,写进文档
  }
  flush();
  return entries;
}

/** 按别名收拢:同别名后块覆盖前块(ssh「首个取值生效」的近似,视图够用) */
export function dedupeSshHosts(entries: SshHostEntry[]): SshHostEntry[] {
  const byHost = new Map<string, SshHostEntry>();
  for (const entry of entries) {
    const existing = byHost.get(entry.host);
    if (!existing) {
      byHost.set(entry.host, { ...entry });
    } else {
      byHost.set(entry.host, {
        ...existing,
        hostname: entry.hostname ?? existing.hostname,
        user: entry.user ?? existing.user,
        port: entry.port ?? existing.port,
        proxyJump: entry.proxyJump ?? existing.proxyJump
      });
    }
  }
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}
