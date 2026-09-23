import * as fs from 'fs';
import * as path from 'path';

/**
 * 引擎源码根目录解析:
 * 1) 优先环境变量 KBENGINE_ROOT;
 * 2) 否则按本仓库同级检出约定 ../kbengine;
 * 3) 都不存在时返回 null,依赖引擎源码的条件测试用例自行 skip。
 */
export function resolveEngineRoot(): string | null {
  const candidates = [
    process.env.KBENGINE_ROOT,
    path.resolve(__dirname, '..', '..', '..', 'kbengine')
  ].filter((value): value is string => !!value);

  for (const candidate of candidates) {
    const marker = path.join(candidate, 'kbe', 'src', 'lib', 'entitydef');
    if (fs.existsSync(marker)) {
      return candidate;
    }
  }

  return null;
}
