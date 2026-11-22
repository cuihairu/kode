import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  coerceHotReloadSettingsFormValues,
  defaultHotReloadSettingsLabels,
  HOT_RELOAD_SETTINGS_COMMAND,
  HOT_RELOAD_SETTINGS_WRITABLE_KEYS,
  HotReloadSettingsPanel,
  readHotReloadSettingsFormValues,
  renderHotReloadSettingsFormHtml,
  toHotReloadSettingsFormValues,
  type HotReloadSettingsFormLabels,
  type HotReloadSettingsFormValues
} from '../src/hotReloadSettingsPanel';
import {
  allFileSystemWatchers,
  commandRegistry,
  configurationOverrides,
  panelRegistry
} from './helpers/vscodeStub';

// RUST-378 (HR-UI-005):热更配置面板化编辑 UI(表单化界面)。钉四面:
// ①纯渲染面——11 字段直出当前有效值、HTML 转义(webview 文本不裸插)、
//   CSP+nonce 形状;②入站规范化面——webview 值不信任,类型/越界逐字段
//   回落,不把任意形状写进配置;③写回面——白名单逐键 update(Workspace
//   作用域,键前缀 hotReload.),复位=清键回默认;写后装配同读函数立即
//   可见(表单所见=装配所用零分叉);④四件套装配锁——package.json 命令
//   + activationEvent + NLS 双语 + src/activate/hotReload.ts 注册点。

const baseValues = (): HotReloadSettingsFormValues => ({
  enabled: true,
  actionName: '',
  globs: ['entities/**/*.py'],
  debounceMs: 500,
  triggerMode: 'onSave',
  stabilityWindowMs: 0,
  syntaxGate: false,
  batchFlushMs: 0,
  batchPreviewThreshold: 50,
  sendViaProviders: false,
  allowRootLevelStem: false
});

const labels = (): HotReloadSettingsFormLabels => defaultHotReloadSettingsLabels();

const renderWith = (values: HotReloadSettingsFormValues, nonce = 'nonce-fixed'): string =>
  renderHotReloadSettingsFormHtml({ values, labels: labels(), nonce });

describe('RUST-378 纯渲染面:表单字段直出当前有效值', () => {
  it('11 个可写字段全部在场(id=键名),值如实直出', () => {
    const html = renderWith({
      ...baseValues(),
      enabled: false,
      actionName: 'reload_script',
      globs: ['entities/**/*.py', 'db/**/*.py'],
      debounceMs: 700,
      triggerMode: 'onDiskChange',
      stabilityWindowMs: 120,
      syntaxGate: true,
      batchFlushMs: 40,
      batchPreviewThreshold: 9,
      sendViaProviders: true,
      allowRootLevelStem: true
    });
    for (const key of HOT_RELOAD_SETTINGS_WRITABLE_KEYS) {
      expect(html, `缺字段: ${key}`).toContain(`id="${key}"`);
    }
    expect(html).toContain('value="reload_script"');
    expect(html).toContain('value="entities/**/*.py, db/**/*.py"');
    expect(html).toContain('value="700"');
    expect(html).toContain('value="120"');
    expect(html).toContain('value="40"');
    expect(html).toContain('value="9"');
    expect(html).toMatch(/<input id="enabled"[\s\S]*?(checked )?\/>/);
    expect(html).toContain('value="onDiskChange" selected');
    expect(html).not.toContain('value="onSave" selected');
    // 开/关如实:checked 只在真值字段
    expect(html).toMatch(/id="syntaxGate"[^>]*type="checkbox" checked/);
    expect(html).toMatch(/id="sendViaProviders"[^>]*type="checkbox" checked/);
    expect(html).toMatch(/id="allowRootLevelStem"[^>]*type="checkbox" checked/);
    expect(html).not.toMatch(/id="batchFlushMs"[^>]*checked/);
  });

  it('缺省值渲染:onSave 选中、数字直出、布尔假值不 checked', () => {
    const html = renderWith(baseValues());
    expect(html).toContain('value="onSave" selected');
    expect(html).toContain('value="500"');
    expect(html).toContain('value="50"');
    expect(html).toMatch(/id="syntaxGate"[^>]*type="checkbox" \/>/);
    expect(html).not.toMatch(/id="syntaxGate"[^>]*checked/);
  });

  it('webview 文本一律转义:用户串带标签/引号不裸插(不产生可执行元素)', () => {
    const html = renderWith({
      ...baseValues(),
      actionName: '<img src=x onerror=alert(1)>',
      globs: ['a"onload=alert(2)/**/*.py']
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('a&quot;onload=alert(2)/**/*.py');
    // 值只落属性值位,标签形状不被用户串伪造
    expect((html.match(/<img/g) ?? []).length).toBe(0);
  });

  it('CSP+nonce 形状:script-src 带 nonce,default-src none', () => {
    const html = renderWith(baseValues(), 'abc123');
    expect(html).toContain("script-src 'nonce-abc123';");
    expect(html).toContain('default-src \'none\';');
    expect(html).toContain('<script nonce="abc123">');
  });
});

describe('RUST-378 入站规范化面:webview 值不信任,类型/越界如实回落', () => {
  it('合法全量值逐字段透传', () => {
    const values = baseValues();
    expect(coerceHotReloadSettingsFormValues(values, baseValues())).toEqual(values);
  });

  it('布尔写坏回落;数字负值/NaN/非有限回落;triggerMode 枚举外回落 onSave', () => {
    const fallback = baseValues();
    const coerced = coerceHotReloadSettingsFormValues(
      {
        enabled: 'yes',
        actionName: 42,
        globs: 'entities/**/*.py',
        debounceMs: -5,
        triggerMode: 'bogus',
        stabilityWindowMs: Number.NaN,
        syntaxGate: 1,
        batchFlushMs: Number.POSITIVE_INFINITY,
        batchPreviewThreshold: {},
        sendViaProviders: null,
        allowRootLevelStem: undefined,
        hostile: 'should-be-ignored'
      },
      fallback
    );
    expect(coerced).toEqual(fallback);
  });

  it('globs 混合数组只收字符串项(非串如实丢弃,不把垃圾写进配置)', () => {
    const coerced = coerceHotReloadSettingsFormValues(
      { globs: ['a/**/*.py', 42, null, 'b/**/*.py'] },
      baseValues()
    );
    expect(coerced.globs).toEqual(['a/**/*.py', 'b/**/*.py']);
  });

  it('裸对象/非对象入站都按白名单逐键取,未知键不透传', () => {
    const fallback = { ...baseValues(), actionName: 'kept' };
    expect(coerceHotReloadSettingsFormValues({ actionName: 'kept', junk: 1 }, fallback)).toEqual(fallback);
    for (const raw of ['str', 42, null, undefined, true]) {
      expect(coerceHotReloadSettingsFormValues(raw, fallback)).toEqual(fallback);
    }
  });

  it('有限非负数字面逐字段生效', () => {
    const coerced = coerceHotReloadSettingsFormValues(
      { debounceMs: 800, stabilityWindowMs: 90, batchFlushMs: 30, batchPreviewThreshold: 7 },
      baseValues()
    );
    expect(coerced.debounceMs).toBe(800);
    expect(coerced.stabilityWindowMs).toBe(90);
    expect(coerced.batchFlushMs).toBe(30);
    expect(coerced.batchPreviewThreshold).toBe(7);
  });
});

describe('RUST-378 容忍式表单读:与装配同一 readHotReloadSettings', () => {
  it('类型写坏如实回落默认(不拖垮表单)', () => {
    const values = readHotReloadSettingsFormValues(() => ({
      get: <T>(key: string, defaultValue: T): T => {
        const bad: Record<string, unknown> = {
          enabled: 'nope',
          actionName: 7,
          globs: 'x',
          debounceMs: 'abc',
          triggerMode: 3,
          stabilityWindowMs: -1,
          syntaxGate: 'on',
          batchFlushMs: null,
          batchPreviewThreshold: {},
          sendViaProviders: 0,
          allowRootLevelStem: 'false'
        };
        const value = bad[key];
        return (value === undefined ? defaultValue : value) as T;
      }
    }));
    // globs 类型写坏=非数组→spec unset→[](由 assetsRoot 派生),绝不回落裸全工作区扫
    expect(values).toEqual({ ...baseValues(), globs: [] });
  });

  it('toHotReloadSettingsFormValues 投影去 globsSpec(表单值面=11 字段)', () => {
    const projected = toHotReloadSettingsFormValues({
      ...baseValues(),
      globsSpec: 'explicit'
    } as never);
    expect(Object.keys(projected).sort()).toEqual([...HOT_RELOAD_SETTINGS_WRITABLE_KEYS].sort());
  });
});

describe('RUST-378 面板写回面:白名单逐键 update,复位清键', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    commandRegistry.reset();
    panelRegistry.reset();
    allFileSystemWatchers.length = 0;
    // 种子段(hotReloadSectionReader 读 getConfiguration('kbengine').get('hotReload'))
    configurationOverrides.set('kbengine', { hotReload: { actionName: 'seed_action' } });
  });

  afterEach(() => {
    configurationOverrides.clear();
    commandRegistry.reset();
    panelRegistry.reset();
    allFileSystemWatchers.length = 0;
  });

  const newPanel = (): HotReloadSettingsPanel => new HotReloadSettingsPanel();

  it('show 渲染装配同读现值(种子 actionName 直出),保存写回 Workspace 作用域', async () => {
    const panel = newPanel();
    await panel.show();
    const fake = panelRegistry.panels.at(-1)!;
    expect(fake.viewType).toBe('kbengine.hotReloadSettings');
    expect(fake.webview.html).toContain('value="seed_action"');

    panelRegistry.fireMessage(fake, {
      command: 'save',
      values: { ...baseValues(), actionName: 'new_action', debounceMs: 800 }
    });
    // 微任务排空:save 内逐键 await
    await new Promise(resolve => setTimeout(resolve, 0));

    // 装配同读函数立即可见(表单所见=装配所用,写后零分叉)
    const after = readHotReloadSettingsFormValues();
    expect(after.actionName).toBe('new_action');
    expect(after.debounceMs).toBe(800);
    expect(after.enabled).toBe(true);
    // 面板确认消息回给 webview
    expect(fake.webview.postedMessages.some(m => (m.message as { command: string }).command === 'saved')).toBe(true);
  });

  it('不可信入站(webview 乱填)经规范化写回:垃圾值不落配置', async () => {
    const panel = newPanel();
    await panel.show();
    const fake = panelRegistry.panels.at(-1)!;
    panelRegistry.fireMessage(fake, {
      command: 'save',
      values: {
        enabled: 'yes',
        debounceMs: -1,
        triggerMode: 'bogus',
        hostile: 'injected',
        actionName: 'fine'
      }
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const after = readHotReloadSettingsFormValues();
    // 乱值回落现值/默认,不是 webview 的原样
    expect(after.enabled).toBe(true);
    expect(after.debounceMs).toBe(500);
    expect(after.triggerMode).toBe('onSave');
    expect(after.actionName).toBe('fine');
  });

  it('复位逐键 update undefined:工作区覆写清空回默认', async () => {
    const panel = newPanel();
    await panel.show();
    const fake = panelRegistry.panels.at(-1)!;
    panelRegistry.fireMessage(fake, { command: 'reset' });
    await new Promise(resolve => setTimeout(resolve, 0));
    // 种子覆写已清,装配同读回到默认
    const after = readHotReloadSettingsFormValues();
    expect(after.actionName).toBe('');
    expect(after.debounceMs).toBe(500);
    expect(after.batchPreviewThreshold).toBe(50);
  });

  it('二次 show 不另开面板(reveal 复用);dispose 清句柄', async () => {
    const panel = newPanel();
    await panel.show();
    expect(panelRegistry.panels).toHaveLength(1);
    await panel.show();
    expect(panelRegistry.panels).toHaveLength(1);
    expect(panelRegistry.panels[0].revealed).toBe(true);
    panel.dispose();
    expect(panelRegistry.panels[0].disposed).toBe(true);
    // dispose 后再 show = 新面板(旧句柄已清)
    await panel.show();
    expect(panelRegistry.panels).toHaveLength(2);
  });

  it('未知命令不写配置(消息面只认 save/reset 两键)', async () => {
    const panel = newPanel();
    await panel.show();
    const fake = panelRegistry.panels.at(-1)!;
    panelRegistry.fireMessage(fake, { command: 'drop-table', values: { enabled: false } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const after = readHotReloadSettingsFormValues();
    expect(after.enabled).toBe(true);
  });
});

describe('RUST-378 四件套装配锁:命令/激活/NLS 双语/注册点', () => {
  const root = join(__dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    contributes: { commands: Array<{ command: string }> };
    activationEvents: string[];
  };
  const nlsEn = JSON.parse(readFileSync(join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
  const nlsZh = JSON.parse(readFileSync(join(root, 'package.nls.zh-cn.json'), 'utf8')) as Record<string, string>;

  it('package.json 贡献 kbengine.hotReload.settings + activationEvent', () => {
    expect(pkg.contributes.commands.some(c => c.command === HOT_RELOAD_SETTINGS_COMMAND)).toBe(true);
    expect(pkg.activationEvents).toContain(`onCommand:${HOT_RELOAD_SETTINGS_COMMAND}`);
  });

  it('NLS 双语标题在且真翻译(非同文假翻译)', () => {
    const key = 'kbengine.command.hotReload.settings.title';
    expect(nlsEn[key]).toBeTruthy();
    expect(nlsZh[key]).toBeTruthy();
    expect(nlsEn[key]).not.toBe(nlsZh[key]);
  });

  it('src/activate/hotReload.ts 注册点在(命令常量+导入)', () => {
    const source = readFileSync(join(root, 'src', 'activate', 'hotReload.ts'), 'utf8');
    expect(source).toContain("import { HOT_RELOAD_SETTINGS_COMMAND, openHotReloadSettingsPanel } from '../hotReloadSettingsPanel'");
    expect(source).toContain('vscode.commands.registerCommand(HOT_RELOAD_SETTINGS_COMMAND');
  });
});
