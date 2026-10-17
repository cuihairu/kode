import { describe, expect, it } from 'vitest';
import {
  applyTemplate,
  applyTemplateWithContext,
  BUILTIN_HTTP_REQUEST_EXAMPLE,
  buildHttpRequest,
  buildOfficialVariableContext,
  buildTemplateVars,
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

describe('resolvePythonModulePath', () => {
  const roots = ['/ws'];

  it('工作区内相对路径去 .py 转点;根尾斜杠容忍', () => {
    expect(resolvePythonModulePath('/ws/entities/fight/FightAI.py', roots)).toBe('entities.fight.FightAI');
    expect(resolvePythonModulePath('/ws/entities/Foo.py', ['/ws/'])).toBe('entities.Foo');
    // 非 .py 扩展保留全名(模块概念只对 .py 剥壳)
    expect(resolvePythonModulePath('/ws/docs/x.json', roots)).toBe('docs.x.json');
  });

  it('win32 反斜杠路径同样归一', () => {
    expect(resolvePythonModulePath('C:\\ws\\entities\\A.py', ['C:\\ws'])).toBe('entities.A');
  });

  it('不在任何根下:文件名去 .py,不带目录', () => {
    expect(resolvePythonModulePath('/tmp/other/Foo.py', roots)).toBe('Foo');
    expect(resolvePythonModulePath('/tmp/other/Foo.txt', roots)).toBe('Foo.txt');
  });

  it('空路径返回空串;路径恰等于根(无尾随分隔)不算在其下', () => {
    expect(resolvePythonModulePath('', roots)).toBe('');
    expect(resolvePythonModulePath('/ws', roots)).toBe('ws');
  });
});

describe('buildTemplateVars', () => {
  it('完整上下文:module/moduleBasename/file/line(0 起转 1 起)/sel', () => {
    const vars = buildTemplateVars({
      filePath: '/ws/entities/fight/FightAI.py',
      cursorLineZeroBased: 9,
      selection: 'self.hp',
      workspaceRoots: ['/ws']
    });
    expect(vars).toEqual({
      module: 'entities.fight.FightAI',
      moduleBasename: 'FightAI',
      file: 'FightAI.py',
      line: '10',
      sel: 'self.hp'
    });
  });

  it('无编辑器:各值为空串(如实,不猜)', () => {
    expect(buildTemplateVars({})).toEqual({ module: '', moduleBasename: '', file: '', line: '', sel: '' });
  });

  it('回落形态(不在根下):module 即文件名去壳,moduleBasename 与之一致', () => {
    const vars = buildTemplateVars({ filePath: '/tmp/other/Foo.py', workspaceRoots: [] });
    expect(vars.module).toBe('Foo');
    expect(vars.moduleBasename).toBe('Foo');
  });

  it('反斜杠文件名取 basename', () => {
    expect(buildTemplateVars({ filePath: 'C:\\ws\\a.py' }).file).toBe('a.py');
  });
});

describe('applyTemplate', () => {
  const vars = {
    module: 'entities.fight.FightAI',
    moduleBasename: 'FightAI',
    file: 'FightAI.py',
    line: '10',
    sel: 'self.hp'
  };

  it('五个占位全替换;重复出现全中;未知占位原样保留', () => {
    expect(applyTemplate('${module}|${moduleBasename}|${file}|${line}|${sel}', vars)).toBe(
      'entities.fight.FightAI|FightAI|FightAI.py|10|self.hp'
    );
    expect(applyTemplate('${module}/${module}', vars)).toBe('entities.fight.FightAI/entities.fight.FightAI');
    expect(applyTemplate('http://x/${nope}', vars)).toBe('http://x/${nope}');
  });

  it('替换值按字面插入,不做 URL 编码;$& 等替换模式不误读', () => {
    const tricky = { module: 'a&b=c', moduleBasename: 'b$&c', file: 'f$&g', line: '1', sel: '$1' };
    expect(applyTemplate('?m=${module}&b=${moduleBasename}&s=${sel}', tricky)).toBe('?m=a&b=c&b=b$&c&s=$1');
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
  const vars = buildTemplateVars({
    filePath: '/ws/entities/fight/FightAI.py',
    cursorLineZeroBased: 9,
    selection: '',
    workspaceRoots: ['/ws']
  });
  const official = buildOfficialVariableContext({
    filePath: '/ws/entities/fight/FightAI.py',
    workspaceRoots: ['/ws']
  });

  it('官方变量族插值:workspaceFolder/fileBasenameNoExtension/fileDirname/relativeFile', () => {
    expect(applyTemplateWithContext('${workspaceFolder}|${fileBasenameNoExtension}|${relativeFile}', vars, official))
      .toBe('/ws|FightAI|entities/fight/FightAI.py');
  });

  it('${file} 自定义语义恒胜出(文件名,非官方绝对路径)', () => {
    expect(applyTemplateWithContext('${file}|${fileBasename}', vars, official)).toBe('FightAI.py|FightAI.py');
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
      headers: { 'X-File': '${file}', 'X-Line': '${line}' },
      body: '{"module":"${module}","sel":"${sel}"}',
      enabled: true,
      keybinding: ''
    };
    const request = buildHttpRequest(entry, {
      module: 'entities.fight.FightAI',
      moduleBasename: 'FightAI',
      file: 'FightAI.py',
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
