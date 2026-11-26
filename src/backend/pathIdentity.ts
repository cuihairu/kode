/** File identity key: keeps POSIX case sensitivity; Windows drive letters and UNC paths are case-insensitive. */
export function normalizeFileIdentity(filePath: string): string {
  const raw = filePath.replace(/\\/g, '/');
  const unc = raw.startsWith('//');
  const prefix = unc ? '//' : raw.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  // KR-AUD-37(1): lexical fold of `..` (POSIX semantics) -- spellings of the
  // same directory (`scripts/../entity_defs` vs `entity_defs`) must share one
  // key, otherwise identity comparison treats one file as two. Pop when a pop
  // is legal; a `..` at an absolute root is dropped (`/..` is `/`); a leading
  // `..` on a relative path is kept (no false deletion); `.` and empty
  // segments are dropped as before.
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      const last = parts[parts.length - 1];
      // A drive-root segment (`C:`) is equivalent to an absolute root: `..` cannot pop it (`C:/a/..` = `C:/`)
      const lastIsDriveRoot = last !== undefined && /^[A-Za-z]:$/.test(last);
      // Audit P2: the two `server/share` segments of a UNC root (`//server/share`) are the share
      // boundary and cannot be popped by `..` (`//server/share/..` = `//server/share`)
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
  // Audit P2 closure: the bare drive-segment tail applies only to prefix-less paths (a genuine
  // Windows drive root) -- the POSIX absolute path `/C:` (a directory named `C:`) must not
  // collide with the drive root `c:/` into the same key
  if (prefix === '' && parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) {
    return `${parts[0].toLowerCase()}/`;
  }
  const normalized = prefix + parts.join('/');
  return /^[A-Za-z]:\//.test(normalized) || unc ? normalized.toLowerCase() : normalized;
}
