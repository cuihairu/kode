import * as fs from 'fs';
import * as path from 'path';

/**
 * BigWorld fantasydemo 真实脚本资源根目录解析(VULN-KODE-R04):
 * 1) 优先环境变量 KODE_FANTASY_ROOT(CI / 自托管 runner 真跑入口);
 * 2) 否则按本仓库同级检出约定 ../BigWorld/programming/fantasydemo/res;
 * 3) 都不存在时返回 null,依赖真实 demo 脚本的条件测试用例自行 skip。
 * 与 tests/helpers/engineRoot.ts 同款 marker 门控:缺 scripts/entity_defs/Avatar.def
 * 即视为无树,防半检出把 skip 伪装成绿。纯解析、无副作用,不 import vscode 替身。
 */
export function resolveFantasyRoot(): string | null {
  // KODE_FANTASY_ROOT=off:显式禁用,用于本地复现「无树环境」口径
  // (CI 上既无该环境变量、也无同级 BigWorld 检出,本函数返回 null)。
  if (process.env.KODE_FANTASY_ROOT === 'off') {
    return null;
  }

  const candidates = [
    process.env.KODE_FANTASY_ROOT,
    path.resolve(__dirname, '..', '..', '..', 'BigWorld', 'programming', 'fantasydemo', 'res')
  ].filter((value): value is string => !!value);

  for (const candidate of candidates) {
    const marker = path.join(candidate, 'scripts', 'entity_defs', 'Avatar.def');
    if (fs.existsSync(marker)) {
      return candidate;
    }
  }

  return null;
}
