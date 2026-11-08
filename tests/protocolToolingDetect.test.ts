//! PA-007 第一增量:协议工具链检测解析面(fixture 全部取自本机
//! tshark 4.6.4 实测输出字节,上游格式漂移时先扩 fixture 再扩解析)。

import { describe, expect, it } from 'vitest';

import {
  findKbengineDissector,
  parseCliVersion,
  parseTsharkFolders,
  parseTsharkPlugins,
  parseTsharkVersion,
  parseWiresharkVersion,
  pluginFolderMatchesHost,
  wiresharkVersionLine,
} from '../src/protocolToolingDetect';

// 本机 `tshark -G plugins` 实测行(TAB 分隔,cat -A 验证)。
const PLUGINS_OUTPUT = [
  'amrnb.so\t0.1.0\tcodec\t/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6/codecs/amrnb.so',
  'ethercat.so\t0.1.0\tdissector\t/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6/epan/ethercat.so',
  'falco-events.so\t0.9.2\tdissector\t/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6/epan/falco-events.so',
  'libwireshark_kbengine.so\t0.1.0\tdissector\t/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6/epan/libwireshark_kbengine.so',
  '',
].join('\n');

// 本机 `tshark -G folders` 实测行(标签补空格到 21 字符 + TAB + 路径)。
const FOLDERS_OUTPUT = [
  'Personal Plugins:   \t/home/cui/.local/lib/wireshark/plugins/4.6',
  'Global Plugins:     \t/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6',
  'Personal Lua Plugins:\t/home/cui/.local/lib/wireshark/plugins',
  'Global Lua Plugins: \t/usr/lib/x86_64-linux-gnu/wireshark/plugins',
  '',
].join('\n');

describe('PA-007:parseTsharkVersion', () => {
  it('parses real first line and drops the trailing period', () => {
    expect(parseTsharkVersion('TShark (Wireshark) 4.6.4.')).toBe('4.6.4');
  });

  it('accepts two-segment versions', () => {
    expect(parseTsharkVersion('TShark (Wireshark) 4.6')).toBe('4.6');
  });

  it('returns null for foreign output', () => {
    expect(parseTsharkVersion('tshark: not found')).toBeNull();
    expect(parseTsharkVersion('')).toBeNull();
  });
});

describe('PA-007:parseWiresharkVersion', () => {
  it('parses GUI banner without requiring a trailing period', () => {
    expect(parseWiresharkVersion('Wireshark 4.6.4 (Git v4.6.4)')).toBe('4.6.4');
  });

  it('returns null when the GUI is absent', () => {
    expect(parseWiresharkVersion('bash: wireshark: command not found')).toBeNull();
  });
});

describe('PA-007:parseTsharkPlugins', () => {
  it('parses tab-separated rows from the real listing', () => {
    const entries = parseTsharkPlugins(PLUGINS_OUTPUT);
    expect(entries).toHaveLength(4);
    expect(entries[3]).toEqual({
      name: 'libwireshark_kbengine.so',
      version: '0.1.0',
      type: 'dissector',
      path: '/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6/epan/libwireshark_kbengine.so',
    });
  });

  it('skips malformed rows instead of guessing', () => {
    const mixed = [
      'amrnb.so\t0.1.0\tcodec\t/ok',
      'broken-row-without-tabs',
      'three\tcolumns\tonly',
      '\t\t\t',
      'trailing\t0.1.0\tdissector\t',
      'ok.so\t1.2.3\tdissector\t/p',
    ].join('\n');
    expect(parseTsharkPlugins(mixed).map((e) => e.name)).toEqual(['amrnb.so', 'ok.so']);
  });

  it('returns empty for empty input', () => {
    expect(parseTsharkPlugins('')).toEqual([]);
    expect(parseTsharkPlugins('\n\n')).toEqual([]);
  });
});

describe('PA-007:findKbengineDissector', () => {
  it('hits the kbengine dissector row', () => {
    const hit = findKbengineDissector(parseTsharkPlugins(PLUGINS_OUTPUT));
    expect(hit?.name).toBe('libwireshark_kbengine.so');
    expect(hit?.version).toBe('0.1.0');
  });

  it('returns null when the plugin is not installed', () => {
    const without = parseTsharkPlugins(PLUGINS_OUTPUT).filter(
      (e) => !e.name.includes('kbengine')
    );
    expect(findKbengineDissector(without)).toBeNull();
    expect(findKbengineDissector([])).toBeNull();
  });

  it('does not mistake a codec row for the dissector', () => {
    const codecOnly = parseTsharkPlugins('kbengine-ish.so\t0.1.0\tcodec\t/x');
    expect(findKbengineDissector(codecOnly)).toBeNull();
  });
});

describe('PA-007:parseTsharkFolders', () => {
  it('extracts the two plugin folders from the real listing', () => {
    const folders = parseTsharkFolders(FOLDERS_OUTPUT);
    expect(folders.personalPlugins).toBe('/home/cui/.local/lib/wireshark/plugins/4.6');
    expect(folders.globalPlugins).toBe('/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6');
  });

  it('keeps nulls for missing rows', () => {
    expect(parseTsharkFolders('')).toEqual({
      personalPlugins: null,
      globalPlugins: null,
    });
    expect(parseTsharkFolders('Personal Lua Plugins:\t/x')).toEqual({
      personalPlugins: null,
      globalPlugins: null,
    });
  });
});

describe('PA-007:parseCliVersion', () => {
  it('parses the kode-kbengine --version contract line', () => {
    expect(parseCliVersion('kode-kbengine 0.2.0\n')).toBe('0.2.0');
  });

  it('rejects malformed output', () => {
    expect(parseCliVersion('kode-kbengine dev')).toBeNull();
    expect(parseCliVersion('')).toBeNull();
  });
});

describe('PA-007:wiresharkVersionLine', () => {
  it('cuts three-segment versions to the maj.min line', () => {
    expect(wiresharkVersionLine('4.6.4')).toBe('4.6');
  });

  it('passes two-segment versions through', () => {
    expect(wiresharkVersionLine('4.6')).toBe('4.6');
  });

  it('returns null for garbage', () => {
    expect(wiresharkVersionLine('dev')).toBeNull();
    expect(wiresharkVersionLine('')).toBeNull();
  });
});

describe('PA-007:pluginFolderMatchesHost', () => {
  it('accepts a plugin installed under the matching version folder', () => {
    expect(
      pluginFolderMatchesHost(
        '/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6/epan/libwireshark_kbengine.so',
        '4.6.4'
      )
    ).toBe(true);
  });

  it('flags a version-line mismatch (4.6 plugin in a 4.4 host)', () => {
    expect(
      pluginFolderMatchesHost('/opt/wireshark/plugins/4.4/epan/kbengine.so', '4.6.4')
    ).toBe(false);
  });

  it('reports unknown for paths without a plugins/<maj.min> shape', () => {
    expect(pluginFolderMatchesHost('/somewhere/kbengine.so', '4.6.4')).toBeNull();
  });

  it('reports unknown for a malformed host version', () => {
    expect(pluginFolderMatchesHost('/p/4.6/epan/kbengine.so', 'dev')).toBeNull();
  });
});
