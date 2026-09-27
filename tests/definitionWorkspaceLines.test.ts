import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDefinitionEntries } from '../src/definitionWorkspace';

// 批62 行覆盖:定义文件清单对"非普通文件条目"的跳过。
// fs.readdirSync(withFileTypes) 给出的 Dirent 对符号链接既不是 isFile() 也不是
// isDirectory(),mapDefinitionFiles 的第三个守卫即为此类条目而写。这里用真实
// 文件系统构造该形态(链接指向目录的 Loop.def、指向文件的 Linked.def),断言的是
// 清单口径:只收普通 .def 文件,链接名不计入——不依赖任何替身。

const p = (...segments: string[]) => path.join(root, ...segments);
let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-lines-'));
  const interfaces = p('scripts', 'entity_defs', 'interfaces');
  fs.mkdirSync(interfaces, { recursive: true });
  fs.mkdirSync(p('scripts', 'entity_defs', 'nested'), { recursive: true });

  fs.writeFileSync(p('scripts', 'entities.xml'), '<root>\n  <Hero hasBase="true"/>\n</root>\n', 'utf8');
  fs.writeFileSync(p('scripts', 'entity_defs', 'Hero.def'), '<root>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(interfaces, 'IBase.def'), '<root>\n</root>\n', 'utf8');

  // 目录条目(已有覆盖)与两类链接条目
  fs.symlinkSync(p('scripts', 'entity_defs', 'nested'), path.join(interfaces, 'Loop.def'));
  fs.symlinkSync(path.join(interfaces, 'IBase.def'), path.join(interfaces, 'Linked.def'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('definitionWorkspace 定义文件清单的链接条目', () => {
  it('符号链接的 .def 名不出现在接口清单中,普通文件照常列出', () => {
    const interfaces = p('scripts', 'entity_defs', 'interfaces');
    const entries = getDefinitionEntries(root, 'interface');

    expect(entries.map(entry => entry.name)).toEqual(['IBase']);
    // 两条链接:指向目录的与指向文件的都不计入(清单只认普通文件)
    expect(entries.some(entry => entry.name === 'Loop.def' || entry.name === 'Loop')).toBe(false);
    expect(entries.some(entry => entry.name === 'Linked')).toBe(false);

    // 正向对照:清单仍带规范字段,链接条目不是"解析失败"而是被显式跳过
    const entry = entries[0];
    expect(entry.category).toBe('interface');
    expect(entry.exists).toBe(true);
    expect(entry.registered).toBe(true);
    expect(entry.filePath).toBe(path.join(interfaces, 'IBase.def'));
  });

  it('实体清单里链接名同样不会被当作未注册定义补入', () => {
    // entity_defs 下只放一个链接形式的 Ghost.def:实体类别先按 entities.xml 建条目,
    // 再从未注册文件补齐——链接条目不得出现在补齐结果里。
    fs.symlinkSync(p('scripts', 'entity_defs', 'Hero.def'), p('scripts', 'entity_defs', 'Ghost.def'));
    try {
      const entries = getDefinitionEntries(root, 'entity');
      expect(entries.map(entry => entry.name)).toEqual(['Hero']);
    } finally {
      fs.rmSync(p('scripts', 'entity_defs', 'Ghost.def'), { force: true });
    }
  });
});
