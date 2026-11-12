import * as fs from 'fs';
import * as path from 'path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import * as vscode from 'vscode';
import { PYTHON_PROCESSES, processStubRoot } from './backend/pythonProcess';

export interface ProcessConfigDeps {
  exists: (file: string) => boolean;
  readFile: (file: string) => string;
  writeFile: (file: string, text: string) => void;
  mkdir: (dir: string) => void;
}

export const processConfigFs: ProcessConfigDeps = {
  exists: fs.existsSync,
  readFile: file => fs.readFileSync(file, 'utf8'),
  writeFile: (file, text) => fs.writeFileSync(file, text, 'utf8'),
  mkdir: dir => { fs.mkdirSync(dir, { recursive: true }); }
};

export interface ProcessEnvironment {
  root: string;
  extraPaths: string[];
}

const portable = (root: string, file: string): string => path.relative(root, file).replace(/\\/g, '/') || '.';

/** A common script must use its own analysis context. Only the role directory
 * and its KBEngine package enter a role environment; sibling roles never do. */
export function buildProcessEnvironments(
  workspaceRoot: string,
  scriptsRoots: readonly string[],
  stubRoot: string,
  exists: (file: string) => boolean,
  userExtraPaths: readonly string[] = []
): ProcessEnvironment[] {
  const environments = scriptsRoots.flatMap(scriptsRoot => PYTHON_PROCESSES.flatMap(role => {
    const roots = [path.join(scriptsRoot, role)];
    if (role === 'base' || role === 'cell') { roots.push(path.join(scriptsRoot, `${role}app`)); }
    return roots.filter(exists).map(root => ({
      root: portable(workspaceRoot, root),
      extraPaths: [...new Set([
        processStubRoot(stubRoot, role), path.join(stubRoot, 'shared'), root, path.join(scriptsRoot, 'common'), scriptsRoot,
        stubRoot, ...userExtraPaths.map(p => p.replace('${workspaceFolder}', workspaceRoot))
      ].map(p => path.isAbsolute(p) ? portable(workspaceRoot, p) : p))]
    }));
  }));
  // Generated entity_types.pyi imports KBEngine too. It must be analyzed in
  // the same context as its consuming scripts, not the common fallback.
  for (const role of PYTHON_PROCESSES) {
    const root = processStubRoot(stubRoot, role);
    if (exists(`${root}/KBEngine/__init__.pyi`)) {
      environments.push({ root: portable(workspaceRoot, root), extraPaths: [portable(workspaceRoot, root), portable(workspaceRoot, path.join(stubRoot, 'shared')), portable(workspaceRoot, stubRoot)] });
    }
  }
  const shared = path.join(stubRoot, 'shared');
  if (exists(path.join(shared, 'KBEngine', '__init__.pyi'))) {
    environments.push({ root: portable(workspaceRoot, shared), extraPaths: [portable(workspaceRoot, shared), portable(workspaceRoot, stubRoot)] });
  }
  return environments;
}

interface ManagedProcessConfig {
  environments: ProcessEnvironment[];
  stubPath: string;
  extraPaths?: unknown;
}

/** Preserve JSONC comments and user keys. Only update entries equal to the last
 * generated version; edited entries remain user-owned. Never replace TOML
 * project settings with a higher-precedence JSON file implicitly. */
export async function syncProcessPythonConfiguration(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  scriptsRoots: readonly string[],
  stubRoot: string,
  userExtraPaths: readonly string[],
  deps: ProcessConfigDeps = processConfigFs,
  configuredStubPath?: string
): Promise<void> {
  const target = path.join(workspaceRoot, 'pyrightconfig.json');
  const key = `kbengine.python.processConfig:${workspaceRoot}`;
  const previous = context.workspaceState?.get<ManagedProcessConfig>(key);
  const warn = async (message: string): Promise<void> => {
    await vscode.window.showWarningMessage(`KBEngine 进程类型配置: ${message}`);
  };
  try {
    const toml = path.join(workspaceRoot, 'pyproject.toml');
    if (!deps.exists(target) && deps.exists(toml) && /^\s*\[tool\.pyright(?:\]|\.)/m.test(deps.readFile(toml))) {
      await warn('检测到 pyproject.toml 的 tool.pyright，请在其 executionEnvironments 中接入 stubs/<进程> 和 stubs/shared，避免覆盖已有配置。');
      return;
    }
    let source = deps.exists(target) ? deps.readFile(target) : '{}\n';
    const errors: ParseError[] = [];
    const config = parse(source, errors, { allowTrailingComma: true }) as Record<string, unknown> | null;
    if (errors.length || !config || Array.isArray(config) || typeof config !== 'object') {
      await warn('pyrightconfig.json 无法解析，已保留原文件。');
      return;
    }
    // An inherited config may supply a higher-priority global stubPath; require
    // explicit integration rather than claiming isolation we cannot establish.
    if (config.extends !== undefined && previous === undefined) {
      await warn('pyrightconfig.json 使用 extends，请显式合并进程 executionEnvironments 和公共 stubPath；现有继承配置已保留。');
      return;
    }
    const sharedPath = portable(workspaceRoot, path.join(stubRoot, '_shared'));
    const userConfigPath = typeof config.stubPath === 'string' && config.stubPath !== sharedPath && config.stubPath !== previous?.stubPath
      ? config.stubPath : undefined;
    const customPath = userConfigPath ?? configuredStubPath;
    const expandedCustomPath = customPath?.replace('${workspaceFolder}', workspaceRoot);
    const customAbsolute = expandedCustomPath ? path.resolve(workspaceRoot, expandedCustomPath) : undefined;
    if (customAbsolute && (deps.exists(path.join(customAbsolute, 'KBEngine.pyi')) ||
        deps.exists(path.join(customAbsolute, 'KBEngine', '__init__.pyi')))) {
      await warn('用户全局 stubPath 中存在 KBEngine 桩，会覆盖进程选择；已保留配置，请将该桩移出全局 stubPath 后重新同步。');
      return;
    }
    const stubPath = customAbsolute ? portable(workspaceRoot, customAbsolute) : sharedPath;
    const old = Array.isArray(config.executionEnvironments) ? config.executionEnvironments : [];
    if (config.executionEnvironments !== undefined && !Array.isArray(config.executionEnvironments)) {
      await warn('executionEnvironments 不是数组，已保留原文件。');
      return;
    }
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const user = old.filter(env => !previous?.environments.some(managed => same(env, managed)));
    const configPaths = Array.isArray(config.extraPaths) && !same(config.extraPaths, previous?.extraPaths)
      ? config.extraPaths.filter((p): p is string => typeof p === 'string') : [];
    const desired = buildProcessEnvironments(workspaceRoot, scriptsRoots, stubRoot, deps.exists,
      [...configPaths.filter(p => p !== portable(workspaceRoot, stubRoot)), ...userExtraPaths]);
    const conflict = desired.find(env => user.some(item => {
      if (!item || typeof item !== 'object' || typeof item.root !== 'string') { return false; }
      return path.resolve(workspaceRoot, item.root) === path.resolve(workspaceRoot, env.root);
    }));
    if (conflict) {
      await warn(`${conflict.root} 已有用户执行环境，已保留；请将对应进程桩路径放入该环境的 extraPaths 首位。`);
      return;
    }
    // Specific managed roles precede user catch-all environments. Common code
    // keeps the user's global extraPaths (config overrides VS Code settings).
    const environments = [...desired, ...user].sort((a, b) => {
      const depth = (item: unknown): number => item && typeof item === 'object' && 'root' in item && typeof item.root === 'string'
        ? path.resolve(workspaceRoot, item.root).replace(/\\/g, '/').split('/').length : 0;
      return depth(b) - depth(a);
    });
    const edits: Array<[string, unknown]> = [
      ['executionEnvironments', environments]
    ];
    if (userConfigPath === undefined) { edits.push(['stubPath', stubPath]); }
    const extraPaths = [path.join(stubRoot, 'shared'), ...scriptsRoots, stubRoot, ...userExtraPaths]
        .map(p => p.replace('${workspaceFolder}', workspaceRoot))
        .map(p => path.isAbsolute(p) ? portable(workspaceRoot, p) : p);
    if (config.extraPaths === undefined || same(config.extraPaths, previous?.extraPaths)) {
      edits.push(['extraPaths', extraPaths]);
    }
    if (config.reportMissingModuleSource === undefined) { edits.push(['reportMissingModuleSource', false]); }
    for (const [name, value] of edits) {
      source = applyEdits(source, modify(source, [name], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    }
    deps.mkdir(path.join(stubRoot, '_shared'));
    const current = deps.exists(target) ? deps.readFile(target) : null;
    if (current !== source) { deps.writeFile(target, source); }
    await context.workspaceState?.update(key, { environments: desired,
      stubPath: userConfigPath === undefined ? stubPath : previous?.stubPath ?? '',
      extraPaths: edits.some(([name]) => name === 'extraPaths') ? extraPaths : previous?.extraPaths } satisfies ManagedProcessConfig);
  } catch (error) {
    await warn(`写入失败: ${String(error)}`);
  }
}
