/** 文件身份键：保留 POSIX 大小写，Windows 盘符和 UNC 路径不区分大小写。 */
export function normalizeFileIdentity(filePath: string): string {
  const raw = filePath.replace(/\\/g, '/');
  const unc = raw.startsWith('//');
  const prefix = unc ? '//' : raw.startsWith('/') ? '/' : '';
  const parts = raw.split('/').filter(part => part !== '' && part !== '.');
  const normalized = prefix + parts.join('/');
  return /^[A-Za-z]:\//.test(normalized) || unc ? normalized.toLowerCase() : normalized;
}
