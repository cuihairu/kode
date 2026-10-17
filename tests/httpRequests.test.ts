import { describe, expect, it } from 'vitest';
import {
  applyTemplate,
  applyTemplateWithContext,
  BUILTIN_HTTP_REQUEST_EXAMPLE,
  buildHttpRequest,
  buildOfficialVariableContext,
  buildTemplateVars,
  PackageDirProbe,
  parseHttpRequestEntries,
  resolvePythonModulePath
} from '../src/httpRequests';
import packageJson from '../package.json';

// HTTP 快捷请求纯逻辑(批105):条目解析与坏条目跳过、内置示例与
// package.json 默认值同步锁、模块路径推导(${module})、模板变量提取
// 与字面替换($& 等替换模式不误读、未知占位原样保留)。

describe('parseHttpRequestEntries', () => {
  it('非数组返回空表;完整条目逐字段解析', () => {
    expect(parseHttpRequestEntries('nope')).toEqual([]);
    expect(parseHttpRequestEntries(null)).toEqual([]);
    expect(parseHttpRequestEntries(undefined)).toEqual([]);

    const entries = parseHttpRequestEntries([
      {
        name: '热更',
        url: 'http://127.0.0.1:8090/hotfix?module_name=${module}',
        method: 'post',
        headers: { 'Content-Type': 'application/json', BAD: 42 },
        body: '{"module":"${module}"}',
        enabled: false,
        keybinding: 'ctrl+alt+h'
      }
    ]);
    expect(entries).toEqual([
      {
        name: '热更',
        url: 'http://127.0.0.1:8090/hotfix?module_name=${module}',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }, // 非字符串值如实剔除
        body: '{"module":"${module}"}',
        enabled: false,
        keybinding: 'ctrl+alt+h'
      }
    ]);
  });

  it('缺省字段逐个回落(method 大写化/启用/无键位/空头/空体)', () => {
    const entries = parseHttpRequestEntries([{ name: 'x', url: 'http://a/' }]);
    expect(entries).toEqual([
      {
        name: 'x',
        url: 'http://a/',
        method: 'GET',
        headers: {},
        body: '',
        enabled: true,
        keybinding: ''
      }
    ]);
    expect(parseHttpRequestEntries([{ name: 'x', url: 'http://a/', method: '  ' }])[0].method).toBe('GET');
  });

  it('坏条目整条跳过:非对象/缺名/空名/缺 URL/空 URL', () => {
    const entries = parseHttpRequestEntries([
      42,
      null,
      { url: 'http://a/' },
      { name: '  ', url: 'http://a/' },
      { name: 'x' },
      { name: 'x', url: '   ' },
      { name: '好', url: 'http://a/' }
    ]);
    expect(entries.map(entry => entry.name)).toEqual(['好']);
  });
});

describe('内置示例与 package.json 默认值同步', () => {
  it('kbengine.httpRequests 默认值与代码常量逐字段一致(防漂移)', () => {
    const properties = (packageJson as unknown as {
      contributes: { configuration: { properties: Record<string, { default: unknown }> } };
    }).contributes.configuration.properties;
    expect(properties['kbengine.httpRequests'].default).toEqual([BUILTIN_HTTP_REQUEST_EXAMPLE]);
    expect(BUILTIN_HTTP_REQUEST_EXAMPLE.enabled).toBe(false); // 内置示例默认停用
    // 批152:示例按用户真实热更新服务形态(relaod 是其服务的实际参数名)
    expect(BUILTIN_HTTP_REQUEST_EXAMPLE.url).toBe('http://127.0.0.1:8000/api/hotfix?relaod=${module}');
  });
});

describe('resolvePythonModulePath(批153 __init__.py 包边界)', () => {
  // 脚本化包探针:路径在集合里即视作含 __init__.py 的包目录
  const probeFor = (dirs: string[]): PackageDirProbe => {
    const set = new Set(dirs);
    return dirPath => set.has(dirPath);
  };

  it('真实包结构:各级 __init__.py 齐全才逐段成模块', () => {
    const probe = probeFor(['/ws/entities', '/ws/entities/fight']);
    expect(resolvePythonModulePath('/ws/entities/fight/FightAI.py', probe)).toBe('entities.fight.FightAI');
  });

  it('base/cell 角色目录无 __init__.py:不算模块段,模块名即文件名(用户令核心例)', () => {
    expect(resolvePythonModulePath('/ws/scripts/base/FightAI.py', probeFor([]))).toBe('FightAI');
    expect(resolvePythonModulePath('/ws/scripts/cell/Motion.py', probeFor(['/ws/scripts']))).toBe('Motion');
  });

  it('半包:只有内层是包则只收内层段', () => {
    const probe = probeFor(['/ws/entities/fight']);
    expect(resolvePythonModulePath('/ws/entities/fight/FightAI.py', probe)).toBe('fight.FightAI');
  });

  it('首个非包目录截断:更上层即使是包也不回捞', () => {
    const probe = probeFor(['/ws/entities']);
    expect(resolvePythonModulePath('/ws/entities/fight/FightAI.py', probe)).toBe('FightAI');
  });

  it('base 自带 __init__.py 时按 Python 语义照收(规则通用,不特判角色名)', () => {
    const probe = probeFor(['/ws/scripts', '/ws/scripts/base']);
    expect(resolvePythonModulePath('/ws/scripts/base/FightAI.py', probe)).toBe('scripts.base.FightAI');
  });

  it('不注入探针:按无包边界处理,模块=文件名去 .py', () => {
    expect(resolvePythonModulePath('/ws/scripts/base/Foo.py')).toBe('Foo');
  });

  it('非 .py 扩展保留全名;空路径返回空串;win32 反斜杠归一', () => {
    expect(resolvePythonModulePath('/ws/docs/x.json', probeFor(['/ws/docs']))).toBe('docs.x.json');
    expect(resolvePythonModulePath('')).toBe('');
    expect(resolvePythonModulePath('C:\\ws\\base\\A.py', probeFor(['C:/ws/base']))).toBe('base.A');
  });
});

describe('buildTemplateVars', () => {
  const packaged = (dir: string): boolean =>
    dir === '/ws/entities' || dir === '/ws/entities/fight';

  it('完整上下文:module/moduleBasename/filename/line(0 起转 1 起)/sel', () => {
    const vars = buildTemplateVars({
      filePath: '/ws/entities/fight/FightAI.py',
      cursorLineZeroBased: 9,
      selection: 'self.hp',
      workspaceRoots: ['/ws']
    }, packaged);
    expect(vars).toEqual({
      module: 'entities.fight.FightAI',
      moduleBasename: 'FightAI',
      filename: 'FightAI.py',
      line: '10',
      sel: 'self.hp'
    });
  });

  it('无编辑器:各值为空串(如实,不猜)', () => {
    expect(buildTemplateVars({})).toEqual({ module: '', moduleBasename: '', filename: '', line: '', sel: '' });
  });

  it('base/cell 无包边界形态:module 即文件名去壳,moduleBasename 与之一致', () => {
    const vars = buildTemplateVars({ filePath: '/ws/scripts/base/Foo.py', workspaceRoots: ['/ws'] });
    expect(vars.module).toBe('Foo');
    expect(vars.moduleBasename).toBe('Foo');
    expect(vars.filename).toBe('Foo.py');
  });

  it('反斜杠文件名取 basename', () => {
    expect(buildTemplateVars({ filePath: 'C:\\ws\\a.py' }).filename).toBe('a.py');
  });
});

describe('applyTemplate', () => {
  const vars = {
    module: 'entities.fight.FightAI',
    moduleBasename: 'FightAI',
    filename: 'FightAI.py',
    line: '10',
    sel: 'self.hp'
  };

  it('五个占位全替换;重复出现全中;未知占位原样保留', () => {
    expect(applyTemplate('${module}|${moduleBasename}|${filename}|${line}|${sel}', vars)).toBe(
      'entities.fight.FightAI|FightAI|FightAI.py|10|self.hp'
    );
    expect(applyTemplate('${module}/${module}', vars)).toBe('entities.fight.FightAI/entities.fight.FightAI');
    expect(applyTemplate('http://x/${nope}', vars)).toBe('http://x/${nope}');
  });

  it('替换值按字面插入,不做 URL 编码;$& 等替换模式不误读', () => {
    const tricky = { module: 'a&b=c', moduleBasename: 'b$&c', filename: 'f$&g.py', line: '1', sel: '$1' };
    expect(applyTemplate('?m=${module}&b=${moduleBasename}&f=${filename}&s=${sel}', tricky))
      .toBe('?m=a&b=c&b=b$&c&f=f$&g.py&s=$1');
  });
});

describe('buildOfficialVariableContext', () => {
  it('工作区根转 basename 命名的 folder 表;文件路径透传', () => {
    const context = buildOfficialVariableContext({
      filePath: '/ws/entities/Foo.py',
      workspaceRoots: ['/home/user/projects/ws', 'C:\\multi\\second']
    });
    expect(context.folders).toEqual([
      { fsPath: '/home/user/projects/ws', name: 'ws' },
      { fsPath: 'C:\\multi\\second', name: 'second' }
    ]);
    expect(context.filePath).toBe('/ws/entities/Foo.py');
  });

  it('无根无文件:空 folder 表,filePath 缺省', () => {
    const context = buildOfficialVariableContext({});
    expect(context.folders).toEqual([]);
    expect(context.filePath).toBeUndefined();
  });
});

describe('applyTemplateWithContext(批152 单趟合并)', () => {
  const packaged = (dir: string): boolean =>
    dir === '/ws/entities' || dir === '/ws/entities/fight';
  const vars = buildTemplateVars({
    filePath: '/ws/entities/fight/FightAI.py',
    cursorLineZeroBased: 9,
    selection: '',
    workspaceRoots: ['/ws']
  }, packaged);
  const official = buildOfficialVariableContext({
    filePath: '/ws/entities/fight/FightAI.py',
    workspaceRoots: ['/ws']
  });

  it('官方变量族插值:workspaceFolder/fileBasenameNoExtension/fileDirname/relativeFile', () => {
    expect(applyTemplateWithContext('${workspaceFolder}|${fileBasenameNoExtension}|${relativeFile}', vars, official))
      .toBe('/ws|FightAI|entities/fight/FightAI.py');
  });

  it('批153:${file} 归还官方语义=绝对路径,${filename}=文件名', () => {
    expect(applyTemplateWithContext('${file}|${filename}|${fileBasename}', vars, official))
      .toBe('/ws/entities/fight/FightAI.py|FightAI.py|FightAI.py');
  });

  it('${moduleBasename} 一层模块名与官方 ${fileBasenameNoExtension} 并存不互吞', () => {
    expect(applyTemplateWithContext('${moduleBasename}|${fileBasenameNoExtension}', vars, official))
      .toBe('FightAI|FightAI');
  });

  it('两表都不认识的占位原样保留(不落空)', () => {
    expect(applyTemplateWithContext('http://x/${nope}?m=${module}', vars, official))
      .toBe('http://x/${nope}?m=entities.fight.FightAI');
  });

  it('${env:NAME} 走注入表', () => {
    expect(applyTemplateWithContext('${env:KBE_ROLE}', vars, {
      ...official,
      env: { KBE_ROLE: 'cellapp' }
    })).toBe('cellapp');
  });
});

describe('buildHttpRequest', () => {
  it('URL/请求体/请求头值统一过模板,方法与键原样', () => {
    const entry = {
      name: '热更',
      url: 'http://127.0.0.1:8000/api/hotfix?relaod=${module}',
      method: 'PUT',
      headers: { 'X-File': '${filename}', 'X-Line': '${line}' },
      body: '{"module":"${module}","sel":"${sel}"}',
      enabled: true,
      keybinding: ''
    };
    const request = buildHttpRequest(entry, {
      module: 'entities.fight.FightAI',
      moduleBasename: 'FightAI',
      filename: 'FightAI.py',
      line: '10',
      sel: ''
    });
    expect(request.url).toBe('http://127.0.0.1:8000/api/hotfix?relaod=entities.fight.FightAI');
    expect(request.method).toBe('PUT');
    expect(request.headers).toEqual({ 'X-File': 'FightAI.py', 'X-Line': '10' });
    expect(request.body).toBe('{"module":"entities.fight.FightAI","sel":""}');
  });

  it('带官方上下文:同趟可插官方变量,${moduleBasename} 与 ${fileBasenameNoExtension} 都通', () => {
    const entry = {
      name: '热更一层',
      url: '${workspaceFolder}/log/${moduleBasename}-${fileBasenameNoExtension}.txt',
      method: 'GET',
      headers: {},
      body: '',
      enabled: true,
      keybinding: ''
    };
    const request = buildHttpRequest(
      entry,
      buildTemplateVars({ filePath: '/ws/entities/Foo.py', workspaceRoots: ['/ws'] }),
      buildOfficialVariableContext({ filePath: '/ws/entities/Foo.py', workspaceRoots: ['/ws'] })
    );
    expect(request.url).toBe('/ws/log/Foo-Foo.txt');
  });
});
