import { describe, expect, it } from 'vitest';
import { parsePythonFile } from '../src/pythonParser';

// KR-AUD-32:`from . import mod` 此前把绑定记成 { module: '.', symbol: 'mod' },
// 下游 importModuleCandidates 按模块名 '.' 解析出 <目录>.py / <目录>/__init__.py,
// 兄弟模块 mod.py 永远落空(`helper.Cls()` 跳转不命中)。修复:纯点号模块的
// import 名是模块接收者,折叠进模块路径('.'+'helper' → '.helper',无 symbol),
// 与 `from .pkg import thing`(module='.pkg', symbol='thing')区分。

describe('KR-AUD-32: 相对导入纯点号模块的绑定形态', () => {
  it('from . import helper 绑定为模块接收者 module=.helper', () => {
    const parsed = parsePythonFile('from . import helper\n', '/ws/scripts/base/machines.py');
    expect(parsed.imports?.get('helper')).toEqual({ module: '.helper' });
  });

  it('from .. import pkg.mod 折叠到 ..pkg.mod;带名字模块保持 symbol 形态', () => {
    const parsed = parsePythonFile(
      'from .. import pkg.mod\nfrom .pkg import thing\nfrom .. import mod as alias\n',
      '/ws/scripts/base/sub/machines.py'
    );
    expect(parsed.imports?.get('pkg.mod')).toEqual({ module: '..pkg.mod' });
    expect(parsed.imports?.get('thing')).toEqual({ module: '.pkg', symbol: 'thing' });
    expect(parsed.imports?.get('alias')).toEqual({ module: '..mod' });
  });
});
