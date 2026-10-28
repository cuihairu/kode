import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  PYLANCE_EXTENSION_ID,
  classifyPythonService,
  pylanceInstallExists,
  renderPythonServiceMessage
} from '../src/pythonLanguageServiceStatus';

// IDE-PRJ-005:Python 语言服务可用性三态——未安装/未启用/已激活。
// 判定只看扩展事实(注册/激活/安装目录),extraPaths 是否写入永不参与
// 可用判定,只在显示面附警示(写入≠可用)。

describe('python service classification (IDE-PRJ-005)', () => {
  it('reports active when the language service extension is activated', () => {
    const status = classifyPythonService({
      registered: true,
      isActive: true,
      installDirExists: true,
      extraPathsWritten: true
    });
    expect(status.state).toBe('active');
    expect(status.label).toBe('已激活');
  });

  it('reports not-enabled when installed (registered or on disk) but not active in this window', () => {
    // 已安装(磁盘证据)但本窗口未注册未激活:被禁用
    const disabled = classifyPythonService({
      registered: false,
      isActive: false,
      installDirExists: true,
      extraPathsWritten: false
    });
    expect(disabled.state).toBe('not-enabled');
    expect(disabled.label).toBe('未启用');

    // 已注册未激活(启用中/按需激活):同样不是可用
    const lazy = classifyPythonService({
      registered: true,
      isActive: false,
      installDirExists: true,
      extraPathsWritten: false
    });
    expect(lazy.state).toBe('not-enabled');
  });

  it('reports not-installed when neither registered nor present on disk', () => {
    const status = classifyPythonService({
      registered: false,
      isActive: false,
      installDirExists: false,
      extraPathsWritten: false
    });
    expect(status.state).toBe('not-installed');
    expect(status.label).toBe('未安装');
  });

  it('never treats extraPaths writes as availability', () => {
    // extraPaths 已写入但扩展事实全空:仍是未安装,警示进显示面
    const status = classifyPythonService({
      registered: false,
      isActive: false,
      installDirExists: false,
      extraPathsWritten: true
    });
    expect(status.state).toBe('not-installed');

    const message = renderPythonServiceMessage(status, {
      registered: false,
      isActive: false,
      installDirExists: false,
      extraPathsWritten: true
    });
    expect(message).toContain('未安装');
    expect(message).toContain(`${PYLANCE_EXTENSION_ID}`);
    expect(message).toContain('extraPaths 已写入不等于语言服务可用');

    // extraPaths 未写入时不附警示
    const clean = classifyPythonService({
      registered: true,
      isActive: true,
      installDirExists: true,
      extraPathsWritten: false
    });
    expect(renderPythonServiceMessage(clean, {
      registered: true,
      isActive: true,
      installDirExists: true,
      extraPathsWritten: false
    })).not.toContain('extraPaths');
  });
});

describe('pylance install directory probe (IDE-PRJ-005)', () => {
  it('detects versioned install directories and stays false for empty dirs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pylance-'));
    expect(pylanceInstallExists(dir)).toBe(false);

    fs.mkdirSync(path.join(dir, `${PYLANCE_EXTENSION_ID}-2026.4.1`));
    expect(pylanceInstallExists(dir)).toBe(true);
    // 目录不存在也如实 false,不炸
    expect(pylanceInstallExists(path.join(dir, 'missing'))).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
