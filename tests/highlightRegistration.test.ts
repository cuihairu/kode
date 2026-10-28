import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// 高亮注册面回归锁(批103,紧急高亮回归排查落地):
// 用户实测装最新 vsix 后 .py 高亮全废。全仓考古结论(git 全历史扫描):
// - languages/grammars 自 dc75f33(初始提交)起恒等——只注册 kbengine-def
//   一门语言、source.kbengine-def 一条语法,从未注册过 python/.py/注入;
// - themes 自 1232d60 起曾恒等单套;2026-10-20 用户令扩为 11 套(Monokai+10 常见主题)。
// - extension 无任何可动态关闭语法着色的 API 调用(无 semanticTokens/
//   decorations/files.associations/settings.json 写入,见 grep 取证)。
// 即:打包产物不是 .py 高亮回归的成因(.py 由 VS Code 内建 MagicPython
// extensions/python 着色,扩展无注销他人语法的通道;共存分词实证见
// tests/pythonHighlightCoexistence.test.ts)。本文件把"注册面恒等"锁成
// 回归锁,防未来任何人误改语法注册/语言 id/打包漏资源(工单①②④类):
// 一、注册面逐字段锁定(languages/grammars/themes 的完整结构;
//     批130 起 grammars 扩为两条:def 主语法 + types.xml 注入语法,
//     注入面锁死只许 text.xml);
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

  it('grammars 逐字段锁定:def 主语法 + types.xml 注入语法(批130 起)', () => {
    // 第二条是注入语法:无 language 键,injectTo 只许 text.xml——
    // types.xml 默认由 XML 插件着色,kode 只在其上叠加 KBEngine 语义
    // scope,不抢宿主分词。
    expect(pkg.contributes.grammars).toEqual([
      {
        language: 'kbengine-def',
        scopeName: 'source.kbengine-def',
        path: './syntaxes/kbengine.tmLanguage.json'
      },
      {
        scopeName: 'text.kbengine-types',
        path: './syntaxes/kbengine-types-injection.json',
        injectTo: ['text.xml']
      },
      {
        scopeName: 'text.python-constants',
        path: './syntaxes/python-constants-injection.json',
        injectTo: ['source.python']
      },
      {
        scopeName: 'text.python-function-calls',
        path: './syntaxes/python-function-calls-injection.json',
        injectTo: ['source.python']
      }
    ]);
  });

  it('themes 锁定:11 套(Monokai 主题 + 10 常见主题)且文件在位可解析', () => {
    // 2026-10-20 用户令:多配几套常见主题可选;锁定标签清单防静默增删。
    const labels = (pkg.contributes.themes as Array<{ label: string }>).map(t => t.label);
    expect(labels).toEqual([
      'KBEngine Theme (Monokai)',
      'KBEngine (One Dark)',
      'KBEngine (Dracula)',
      'KBEngine (GitHub Light)',
      'KBEngine (Solarized Light)',
      'KBEngine (Solarized Dark)',
      'KBEngine (Nord)',
      'KBEngine (Gruvbox Dark)',
      'KBEngine (Catppuccin Mocha)',
      'KBEngine (Visual Studio Dark+)',
      'KBEngine (Visual Studio Light+)'
    ]);
    for (const entry of pkg.contributes.themes as Array<{ path: string; uiTheme: string }>) {
      expect(entry.uiTheme).toMatch(/^vs-(dark|light)$/);
      const themeFile = path.join(root, entry.path.replace(/^\.\//, ''));
      const theme = JSON.parse(fs.readFileSync(themeFile, 'utf8')) as {
        tokenColors: unknown[];
        colors: Record<string, string>;
      };
      expect(Array.isArray(theme.tokenColors)).toBe(true);
      expect(theme.tokenColors.length).toBeGreaterThan(20);
      expect(theme.colors['editor.background']).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
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
      // 注入宿主白名单(2026-10-21 用户令演进): types.xml 语义着色(批130)
      // 仅入 text.xml; 全局常量色(text.python-constants, 只发射
      // variable.other.constant.python 标准 scope) 与函数调用色
      // (text.python-function-calls, 只发射 variable.function.call.python
      // 标准 scope) 仅入 source.python——
      // 除此三者外注入任何宿主仍锁死; 不得注册 source.python 重复语法、
      // 不得映射 .py 语言(上两条保持不变)
      const injectTo = grammar.injectTo as string[] | undefined;
      if (injectTo !== undefined) {
        const allowed =
          grammar.scopeName === 'text.python-constants' ||
          grammar.scopeName === 'text.python-function-calls'
            ? ['source.python']
            : ['text.xml'];
        expect(injectTo).toEqual(allowed);
      }
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

// .vscodeignore 打包防漏:把关键资产路径逐一验证"最终不被排除"。
// 语义取 .vscodeignore(gitignore 子集)中真实会出现的形态:精确路径、
// 目录前缀(dir/、dir/**)、全目录(dir)、按后缀(*.ext、**/*.ext),
// 以及负向豁免(!path)——gitignore 语义为"最后命中的行生效",
// 所以 out/** + !out/extension.js 的单文件 bundle 打包模型(2026-10-15
// 执行单)下 out/extension.js 依然在包内,锁必须按此判定而非见排除即红。
const CRITICAL_ASSETS = [
  'syntaxes/kbengine.tmLanguage.json',
  'syntaxes/kbengine-types-injection.json',
  'syntaxes/python-constants-injection.json',
  'syntaxes/python-function-calls-injection.json',
  'syntaxes/kbengine-color-theme.json',
  'language-configuration.json',
  'snippets/kbengine.json',
  'snippets/kbengine-python.json',
  'snippets/kbengine-types-xml.json',
  'resources/logo.png',
  'resources/logo.svg',
  'out/extension.js'
];

function exclusionCovers(line: string, asset: string): boolean {
  if (line === asset) {
    return true;
  }
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

  // gitignore 语义:逐行扫描,记下最后一条命中资产的行;是排除行才真被排除
  function effectiveExclusion(asset: string): string | null {
    let hit: string | null = null;
    for (const line of lines) {
      const negated = line.startsWith('!');
      const pattern = negated ? line.slice(1) : line;
      if (exclusionCovers(pattern, asset)) {
        hit = negated ? null : line;
      }
    }
    return hit;
  }

  it('关键高亮/打包资产不被任何排除行命中', () => {
    for (const asset of CRITICAL_ASSETS) {
      const hit = effectiveExclusion(asset);
      expect(hit, `${asset} 不得被 .vscodeignore 最终排除,命中: ${hit ?? ''}`).toBeNull();
      // out/ 是构建产物(仓库不跟踪): 存在性断言只对入库资产生效,
      // 编译前跑测试的顺序(如 nightly 全量门禁)不误伤;忽略命中判定仍全量执行
      if (!asset.startsWith('out/')) {
        expect(fs.existsSync(path.join(root, asset)), `${asset} 应在仓库在位`).toBe(true);
      }
    }
  });

  it('排除行仅限既定集合(map/测试/文档/构建垃圾),防误加全类排除', () => {
    // 全类排除(如 *.json、syntaxes、out)是"打包漏 grammar 资源"的根因
    // 形态;锁白名单集合,新增排除必须改本用例过目。
    // 2026-10-15 执行单:切换 esbuild 单文件 bundle 打包模型——
    // out/ 只带 bundle 产物(out/** + !out/extension.js),
    // vendor/ 整目录不进包(fxp 已内联),根目录脚本/杂项文档补齐。
    expect(new Set(lines)).toEqual(
      new Set([
        '.github/',
        '.vscode/',
        '.vscode-test/',
        '.spec-workflow/',
        '.vtmp/',
        '.gitignore',
        '.npmrc',
        '.npmignore',
        '.nvmrc',
        '.vscodeignore',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'docs/',
        'resources/docs/',
        // 2026-10-23 打包防污染: codecov-action 会把上传器二进制落在
        // 工作区(codecov/codecov.SHA256SUM/codecov.SHA256SUM.sig,9.9MB)
        // 曾混入 v0.1.3 市售包;translate_pages.py 为工作区游离脚本。
        'codecov*',
        'translate_pages.py',
        'src/',
        'tests/',
        'build/',
        'vendor/',
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
        '*.vsix',
        'tsconfig.json',
        'tsconfig.mocha.json',
        '.eslintrc.json',
        'vitest.bench.config.js',
        'vitest.bench.config.js.map',
        '/*.js',
        '/*.js.map',
        'CONTRIBUTING.md',
        'COMPLETED_FEATURES.md',
        'PROJECT_SUMMARY.md',
        'KBENGINE_SOURCE_AUDIT_PLAN.md',
        'README.zh.md',
        'TESTING.md',
        'todo.md',
        'CHANGELOG.zh.md',
        'out/**',
        // 2026-10-26 打包瘦身: Rust 构建树与 pdb 调试符号不进 vsix(nightly 85MB 膨胀)
        'cargo-home/',
        'target/',
        '**/target/',
        '*.pdb',
        '!out/extension.js',
        // 2026-10-27 Python 索引重构: parser worker 是随包分发的第二个
        // bundle(esbuild src/pythonParserWorker.ts),运行期按 __dirname 加载
        '!out/pythonParserWorker.js',
        // 2026-10-29 IDE-REL-004: 构建身份随包分发,运行期 readBuildCommit
        // 只读 <extensionPath>/out/buildCommit.json(安装产物提交=构建输入)
        '!out/buildCommit.json'
      ])
    );
  });
});
