/**
 * ~/.ssh/config parsing (the data source for the IDE-PDBG-004 remote server
 * management view): each Host block collects HostName/User/Port/ProxyJump (the
 * jump chain), for remote debug and py-spy dispatch. Only common keys are
 * recognized; the Include directive is not expanded (an honestly documented
 * limitation: hosts written into an included file do not appear). Wildcard Host
 * patterns (asterisk and question mark) are match templates rather than concrete
 * hosts by ssh semantics, so the view does not list them.
 */

export interface SshHostEntry {
  /** The alias on the Host line (what the view and debug.json connection declarations reference) */
  host: string;
  /** HostName, the actual host; defaults to the alias itself (ssh semantics) */
  hostname?: string;
  user?: string;
  port?: number;
  /** ProxyJump jump chain (e.g. bastion or bastion1,bastion2) */
  proxyJump?: string;
}

/** Wildcard patterns (ssh treats asterisk and question mark as match templates, not concrete hosts): neither the view nor the pick face lists them */
export function isWildcardHostPattern(host: string): boolean {
  return host.includes('*') || host.includes('?');
}

/**
 * Parse ssh_config text: scan line by line for `Host` opening a block, and inside
 * the block collect HostName/User/Port/ProxyJump (keys are case-insensitive, both
 * `=` and whitespace separators accepted); a negated host (`!`) skips the whole
 * block. Multiple aliases on one Host line each get their own entry (parameters of
 * the block are shared).
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
    // Hash comments (a hash inside quotes is not stripped — hostnames containing # in the value are extremely rare, conservatively not handled)
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (line.length === 0) {
      continue;
    }
    // Both `Key=Value` and `Key Value` forms (the ssh_config manual ruling)
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
      continue; // a stray key outside a block belongs to no host, ignore
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
    // Other keys (Match/Include/IdentityFile…) do not enter the view face: Include
    // not being expanded is an honest limitation, documented
  }
  flush();
  return entries;
}

/** Consolidate by alias: for the same alias a later block overrides the earlier one (an approximation of ssh's "first value wins" ruling, good enough for the view) */
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
