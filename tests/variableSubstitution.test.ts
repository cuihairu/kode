/**
 * VS Code 官方变量替换(批141,任务单 kode-varfix.md):统一实现在
 * src/variableSubstitution.ts,workspacePath 的静默空串口径与 quickActionConfig
 * 的抛错口径都委派到这里,仓内不再有第二套替换实现。
 * 官方变量表: https://code.visualstudio.com/docs/reference/variables-in-scope-files
 */
import { describe, expect, it } from 'vitest';
import * as path from 'path';
import {
  substituteVariables,
  resolveWorkspaceFolderRef,
  type VariableContext,
  type VariableFolderRef
} from '../src/variableSubstitution';

const FOLDERS: VariableFolderRef[] = [
  { fsPath: '/ws/main', name: 'main' },
  { fsPath: '/ws/engine', name: 'engine' }
];

const CTX: VariableContext = {
  folders: FOLDERS,
  filePath: '/ws/main/scripts/entity_defs/Avatar.def',
  cwd: '/ws/main',
  userHome: '/home/dev',
  pathSeparator: '/'
};

describe('resolveWorkspaceFolderRef', () => {
  it('takes the first folder when no name is requested', () => {
    expect(resolveWorkspaceFolderRef(undefined, FOLDERS)).toBe(FOLDERS[0]);
  });

  it('takes the folder matching the requested name', () => {
    expect(resolveWorkspaceFolderRef('engine', FOLDERS)).toBe(FOLDERS[1]);
  });

  it('returns null when there is no folder at all', () => {
    expect(resolveWorkspaceFolderRef(undefined, [])).toBeNull();
  });

  it('returns null when the named folder does not exist', () => {
    expect(resolveWorkspaceFolderRef('missing', FOLDERS)).toBeNull();
  });
});

describe('substituteVariables 工作区族', () => {
  it('expands ${workspaceFolder} to the first folder path', () => {
    expect(substituteVariables('${workspaceFolder}/kbe', CTX)).toBe('/ws/main/kbe');
  });

  it('expands ${workspaceFolder:Name} to the named folder path', () => {
    expect(substituteVariables('${workspaceFolder:engine}/kbe', CTX)).toBe('/ws/engine/kbe');
  });

  it('expands ${workspaceFolderBasename} to the folder directory name', () => {
    expect(substituteVariables('${workspaceFolderBasename}', CTX)).toBe('main');
  });

  it('expands ${workspaceFolderBasename:Name} to the named folder directory name', () => {
    expect(substituteVariables('${workspaceFolderBasename:engine}', CTX)).toBe('engine');
  });
});

describe('substituteVariables 文件族', () => {
  it('expands ${file} to the current file path', () => {
    expect(substituteVariables('${file}', CTX)).toBe('/ws/main/scripts/entity_defs/Avatar.def');
  });

  it('expands ${fileBasename} to the file name with extension', () => {
    expect(substituteVariables('${fileBasename}', CTX)).toBe('Avatar.def');
  });

  it('expands ${fileBasenameNoExtension} to the file name without extension', () => {
    expect(substituteVariables('${fileBasenameNoExtension}', CTX)).toBe('Avatar');
  });

  it('expands ${fileDirname} to the directory holding the file', () => {
    expect(substituteVariables('${fileDirname}', CTX)).toBe('/ws/main/scripts/entity_defs');
  });

  it('expands ${fileExtname} to the extension with the leading dot', () => {
    expect(substituteVariables('${fileExtname}', CTX)).toBe('.def');
  });

  it('expands ${relativeFile} against the owning workspace folder', () => {
    expect(substituteVariables('${relativeFile}', CTX)).toBe('scripts/entity_defs/Avatar.def');
  });

  it('expands ${relativeFileDirname} against the owning workspace folder', () => {
    expect(substituteVariables('${relativeFileDirname}', CTX)).toBe('scripts/entity_defs');
  });
});

describe('substituteVariables 环境与系统族', () => {
  it('expands ${env:NAME} from the injected environment', () => {
    const ctx: VariableContext = { ...CTX, env: { PORT: '8080' } };
    expect(substituteVariables('http://127.0.0.1:${env:PORT}/x', ctx)).toBe('http://127.0.0.1:8080/x');
  });

  it('expands ${cwd} to the injected working directory', () => {
    expect(substituteVariables('${cwd}/run.bat', CTX)).toBe('/ws/main/run.bat');
  });

  it('expands ${userHome} to the injected home directory', () => {
    expect(substituteVariables('${userHome}/.kbengine', CTX)).toBe('/home/dev/.kbengine');
  });

  it('expands ${pathSeparator} to the injected separator', () => {
    expect(substituteVariables('a${pathSeparator}b', CTX)).toBe('a/b');
  });
});

describe('substituteVariables 未解析口径', () => {
  it('falls back to the empty string when the variable cannot be resolved', () => {
    expect(substituteVariables('${env:MISSING}/kbe', CTX)).toBe('/kbe');
  });

  it('falls back to the empty string for an unknown variable name', () => {
    expect(substituteVariables('${config:kbengine.binPath}', CTX)).toBe('');
  });

  it('falls back to the empty string when no workspace folder is open', () => {
    expect(substituteVariables('${workspaceFolder}/kbe', { ...CTX, folders: [] })).toBe('/kbe');
  });

  it('falls back to the empty string when no current file is open', () => {
    expect(substituteVariables('x${file}y', { ...CTX, filePath: undefined })).toBe('xy');
  });

  it('falls back to the empty string when cwd or userHome is not injected', () => {
    expect(substituteVariables('${cwd}${userHome}', { ...CTX, cwd: undefined, userHome: undefined })).toBe('');
  });

  it('names the failing expression when the policy is throw', () => {
    expect(() =>
      substituteVariables('${config:kbengine.binPath}', CTX, 'throw')
    ).toThrow(/config:kbengine\.binPath/);
  });

  it('names the failing expression for a file variable without a current file', () => {
    expect(() => substituteVariables('${fileBasename}', { ...CTX, filePath: undefined }, 'throw')).toThrow(
      /fileBasename/
    );
  });
});

describe('substituteVariables 边界', () => {
  it('returns the text unchanged when it carries no variable', () => {
    expect(substituteVariables('kbengine.server.restart', CTX)).toBe('kbengine.server.restart');
  });

  it('expands several variables inside one string', () => {
    // 「//」折叠不在本模块:那是 quickAction 包装层的职责(协议分隔冒号后的
    // 双斜杠要保留),核心替换只做替换,口径见 tests/quickActionConfig.test.ts
    expect(substituteVariables('${workspaceFolder:engine}/${workspaceFolder}/start.bat', CTX)).toBe(
      '/ws/engine//ws/main/start.bat'
    );
  });

  it('leaves an empty placeholder body untouched', () => {
    expect(substituteVariables('${}', CTX)).toBe('');
  });

  it('reports the relative file as the full path when the file is outside every folder', () => {
    expect(substituteVariables('${relativeFile}', { ...CTX, filePath: '/elsewhere/Avatar.def' })).toBe(
      '/elsewhere/Avatar.def'
    );
  });

  it('handles a windows file path by normalizing separators', () => {
    const ctx: VariableContext = {
      ...CTX,
      folders: [{ fsPath: 'C:\\work\\kode', name: 'kode' }],
      filePath: 'C:\\work\\kode\\scripts\\Avatar.def'
    };
    expect(substituteVariables('${relativeFile}', ctx)).toBe('scripts/Avatar.def');
    expect(substituteVariables('${fileDirname}', ctx)).toBe('C:/work/kode/scripts');
    expect(substituteVariables('${workspaceFolder}', ctx)).toBe('C:\\work\\kode');
  });

  it('reads the process environment when no environment is injected', () => {
    process.env['KODE_VAR_MISSING_TEST'] = 'from-process';
    try {
      expect(substituteVariables('${env:KODE_VAR_MISSING_TEST}', CTX)).toBe('from-process');
    } finally {
      delete process.env['KODE_VAR_MISSING_TEST'];
    }
  });

  it('joins the colon-separated parts of an env expression back into one name', () => {
    expect(substituteVariables('${env:KODE_A:KODE_B}', { ...CTX, env: { 'KODE_A:KODE_B': 'joined' } })).toBe(
      'joined'
    );
  });

  it('treats a bare ${env} without a name as unresolved', () => {
    expect(substituteVariables('${env}', CTX)).toBe('');
    expect(() => substituteVariables('${env}', CTX, 'throw')).toThrow(/env/);
  });

  it('falls back to the host path separator when none is injected', () => {
    expect(substituteVariables('a${pathSeparator}b', { ...CTX, pathSeparator: undefined })).toBe(
      `a${path.sep}b`
    );
  });
});

describe('substituteVariables 文件名退化形态', () => {
  it('reports no extension for a file name without a dot', () => {
    expect(substituteVariables('${fileExtname}', { ...CTX, filePath: '/ws/main/README' })).toBe('');
    expect(substituteVariables('${fileBasenameNoExtension}', { ...CTX, filePath: '/ws/main/README' })).toBe(
      'README'
    );
  });

  it('treats a dotfile as having no extension and no stem', () => {
    const ctx: VariableContext = { ...CTX, filePath: '/ws/main/scripts/.gitignore' };
    expect(substituteVariables('${fileExtname}', ctx)).toBe('');
    expect(substituteVariables('${fileBasenameNoExtension}', ctx)).toBe('.gitignore');
  });

  it('handles a bare file name with no directory part', () => {
    const ctx: VariableContext = { ...CTX, filePath: 'Avatar.def' };
    expect(substituteVariables('${fileBasename}', ctx)).toBe('Avatar.def');
    expect(substituteVariables('${fileDirname}', ctx)).toBe('');
  });

  it('reports the filesystem root as the dirname of a top level file', () => {
    expect(substituteVariables('${fileDirname}', { ...CTX, filePath: '/Avatar.def' })).toBe('/');
  });

  it('treats a workspace root with a trailing slash as a full prefix', () => {
    const ctx: VariableContext = {
      ...CTX,
      folders: [{ fsPath: '/ws/main/', name: 'main' }],
      filePath: '/ws/main/Avatar.def'
    };
    expect(substituteVariables('${relativeFile}', ctx)).toBe('Avatar.def');
    expect(substituteVariables('${relativeFileDirname}', ctx)).toBe('');
    expect(substituteVariables('${workspaceFolderBasename}', ctx)).toBe('main');
  });

  it('resolves a relative family variable against the owning folder rather than the first', () => {
    const ctx: VariableContext = { ...CTX, filePath: '/ws/engine/scripts/Avatar.def' };
    expect(substituteVariables('${relativeFile}', ctx)).toBe('scripts/Avatar.def');
  });
});
