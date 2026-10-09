import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// 高亮注册面回归锁(批103,紧急高亮回归排查落地):
// 用户实测装最新 vsix 后 .py 高亮全废。全仓考古结论(git 全历史扫描):
// - languages/grammars 自 dc75f33(初始提交)起恒等——只注册 kbengine-def
//   一门语言、source.kbengine-def 一条语法,从未注册过 python/.py/注入;
// - themes 自 1232d60 起"KBEngine Dark"恒等,2026-03-31(36eca10)后未再动;
// - extension 无任何可动态关闭语法着色的 API 调用(无 semanticTokens/
//   decorations/files.associations/settings.json 写入,见 grep 取证)。
// 即:打包产物不是 .py 高亮回归的成因(.py 由 VS Code 内建 MagicPython
// extensions/python 着色,扩展无注销他人语法的通道;共存分词实证见
// tests/pythonHighlightCoexistence.test.ts)。本文件把"注册面恒等"锁成
// 回归锁,防未来任何人误改语法注册/语言 id/打包漏资源(工单①②④类):
// 一、注册面逐字段锁定(languages/grammars/themes 的完整结构);
// 二、"零 python 注册"不变量(防与内建 MagicPython 冲突类事故);
// 三、.vscodeignore 打包防漏锁(高亮/主题/片段/图标/主产物不得被排除,
//     CI 产物清单核对发现的历史隐患:tests/ 与 *.md 全量进包属体积问题,
//     不在本锁范围,另行收口)。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Contribution {
  contributes: {
    languages: Array<Record<string, unknown>>;
    grammars: Array<Record<string, unknown>>;
    themes?: Array<Record<string, unknown>>;
    snippets: Array<{ language: string; path: string }>;
  };
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
) as Contribution;

describe('高亮注册面恒等锁(批103)', () => {
  it('languages 逐字段锁定:仅 kbengine-def,自初始提交起未变', () => {
    expect(pkg.contributes.languages).toEqual([
      {
        id: 'kbengine-def',
        aliases: ['KBEngine Def', 'kbengine-def', 'def'],
        extensions: ['.def'],
        configuration: './language-configuration.json'
      }
    ]);
  });

  it('grammars 逐字段锁定:仅 source.kbengine-def 一条,无注入/无第二 scope', () => {
    expect(pkg.contributes.grammars).toEqual([
      {
        language: 'kbengine-def',
        scopeName: 'source.kbengine-def',
        path: './syntaxes/kbengine.tmLanguage.json'
      }
    ]);
  });

  it('themes 锁定:KBEngine Dark(vs-dark)且文件在位可解析', () => {
    // description 于批107 补入(注明适用面:通用开发语言 + KBEngine .def)
    expect(pkg.contributes.themes).toEqual([
      {
        label: 'KBEngine Dark',
        uiTheme: 'vs-dark',
        path: './syntaxes/kbengine-color-theme.json',
        description:
          '通用深色主题,覆盖常见语言(Python/JS/Go 等)的通用语法着色,并对 KBEngine .def 文件提供专属高亮'
      }
    ]);
    const themePath = path.join(root, 'syntaxes', 'kbengine-color-theme.json');
    const theme = JSON.parse(fs.readFileSync(themePath, 'utf8')) as {
      tokenColors: unknown[];
    };
    expect(Array.isArray(theme.tokenColors)).toBe(true);
    expect(theme.tokenColors.length).toBeGreaterThan(0);
  });

  it('零 python 注册不变量:.py 不映射、source.python 不注册(防与内建 MagicPython 冲突)', () => {
    // .py 着色由 VS Code 内建 python 扩展(MagicPython)提供;kode 从
    // 初始提交起就未注册 python 语言/语法,这是既有行为而非缺陷。
    // 一旦有人注册 source.python(重复 scope)或把 .py 映射进
    // kbengine-def,都会改变全机 .py 文件的着色行为——锁死。
    for (const language of pkg.contributes.languages) {
      expect(language.id).not.toBe('python');
      expect(language.extensions).not.toContain('.py');
    }
    for (const grammar of pkg.contributes.grammars) {
      expect(String(grammar.scopeName)).not.toBe('source.python');
      expect(String(grammar.scopeName)).not.toContain('injection');
      expect(grammar.injectTo).toBeUndefined();
    }
  });

  it('snippets 的语言归属仅限 kbengine-def/xml/python(片段不承担高亮)', () => {
    const allowed = new Set(['kbengine-def', 'xml', 'python']);
    for (const snippet of pkg.contributes.snippets) {
      expect(allowed.has(snippet.language)).toBe(true);
      expect(fs.existsSync(path.join(root, snippet.path))).toBe(true);
    }
  });
});

// .vscodeignore 打包防漏:把关键资产路径逐一验证"不被任何排除行命中"。
// 语义取 .vscodeignore(gitignore 子集)中真实会出现的形态:精确路径、
// 目录前缀(dir/、dir/**)、全目录(dir)、按后缀(*.ext、**/*.ext)。
const CRITICAL_ASSETS = [
  'syntaxes/kbengine.tmLanguage.json',
  'syntaxes/kbengine-color-theme.json',
  'language-configuration.json',
  'snippets/kbengine.json',
  'snippets/kbengine-python.json',
  'snippets/kbengine-types-xml.json',
  'resources/logo.png',
  'out/extension.js'
];

function exclusionCovers(line: string, asset: string): boolean {
  if (line.endsWith('/**')) {
    return asset.startsWith(line.slice(0, -3));
  }
  if (line.endsWith('/')) {
    return asset.startsWith(line);
  }
  if (line.startsWith('**/')) {
    const suffix = line.slice(3);
    if (suffix.startsWith('*.')) return asset.endsWith(suffix.slice(1));
    return asset.slice(asset.lastIndexOf('/') + 1) === suffix;
  }
  if (!line.includes('/')) {
    if (line.startsWith('*.')) return asset.endsWith(line.slice(1));
    // 裸文件名/裸目录名:gitignore 语义下同层目录同名也命中
    const fileName = asset.slice(asset.lastIndexOf('/') + 1);
    return fileName === line || asset.split('/').includes(line);
  }
  return false;
}

describe('.vscodeignore 打包防漏锁(批103,工单④类)', () => {
  const lines = fs
    .readFileSync(path.join(root, '.vscodeignore'), 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
  const exclusions = lines.filter(line => !line.startsWith('!'));

  it('关键高亮/打包资产不被任何排除行命中', () => {
    for (const asset of CRITICAL_ASSETS) {
      const hit = exclusions.filter(line => exclusionCovers(line, asset));
      expect(hit, `${asset} 不得被 .vscodeignore 排除,命中: ${hit.join(', ')}`).toEqual([]);
      expect(fs.existsSync(path.join(root, asset)), `${asset} 应在仓库在位`).toBe(true);
    }
  });

  it('排除行仅限既定集合(map/测试/文档/构建垃圾),防误加全类排除', () => {
    // 全类排除(如 *.json、syntaxes、out)是"打包漏 grammar 资源"的根因
    // 形态;锁白名单集合,新增排除必须改本用例过目。
    expect(new Set(lines)).toEqual(
      new Set([
        '.github/',
        '.vscode/',
        '.spec-workflow/',
        '.gitignore',
        '.npmrc',
        '.vscodeignore',
        'docs/',
        'resources/docs/',
        'src/',
        'vendor/**/LICENSE',
        'coverage/',
        '.nyc_output/',
        '.cache/',
        '.tmp/',
        '.idea/',
        '.DS_Store',
        '*.log',
        '*.tmp',
        '*.temp',
        '*.ts',
        '!*.d.ts',
        'tsconfig.json',
        '.eslintrc.json',
        '.npmignore',
        'pnpm-lock.yaml',
        '*.vsix',
        'CONTRIBUTING.md',
        'COMPLETED_FEATURES.md',
        'PROJECT_SUMMARY.md',
        'out/**/*.map',
        'out/test/'
      ])
    );
  });
});
