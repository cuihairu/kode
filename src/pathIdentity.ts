/** 文件身份键：保留 POSIX 大小写，Windows 盘符和 UNC 路径不区分大小写。 */
export function normalizeFileIdentity(filePath: string): string {
  const raw = filePath.replace(/\\/g, '/');
  const unc = raw.startsWith('//');
  const prefix = unc ? '//' : raw.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  // KR-AUD-37①:词法折叠 `..`(POSIX 语义)——同一目录的不同拼法
  // (`scripts/../entity_defs` 与 `entity_defs`)必须同键,否则身份比对把
  // 同一文件判成两个。可弹出则弹;绝对路径根上的 `..` 丢弃(`/..` 即 `/`);
  // 相对路径前置 `..` 保留(不误删);`.` 与空段照旧丢弃。
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      const last = parts[parts.length - 1];
      // 盘符根段(`C:`)等同绝对根:`..` 不可弹出(`C:/a/..` = `C:/`)
      const lastIsDriveRoot = last !== undefined && /^[A-Za-z]:$/.test(last);
      // 审核 P2:UNC 根(`//server/share`)的 server/share 两段是共享边界,
      // 不可被 `..` 弹出(`//server/share/..` = `//server/share`)
      const uncFloor = unc ? 2 : 0;
      if (parts.length > uncFloor && last !== '..' && !lastIsDriveRoot) {
        parts.pop();
        continue;
      }
      if ((prefix !== '' && parts.length <= uncFloor) || lastIsDriveRoot) {
        continue;
      }
      parts.push('..');
      continue;
    }
    parts.push(part);
  }
  // 审核 P2 收口:裸盘符段收尾仅对无前缀路径(真 Windows 盘符根)生效——
  // POSIX 绝对路径 `/C:`(名为 `C:` 的目录)不得与盘符根 `c:/` 碰撞同键
  if (prefix === '' && parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) {
    return `${parts[0].toLowerCase()}/`;
  }
  const normalized = prefix + parts.join('/');
  return /^[A-Za-z]:\//.test(normalized) || unc ? normalized.toLowerCase() : normalized;
}
