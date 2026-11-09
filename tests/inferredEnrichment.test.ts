import { describe, expect, it } from 'vitest';
import * as path from 'path';
import {
  mirrorRelPathFor,
  mirrorPathForSource,
  extractReturnAnnotation,
  extractParamAnnotations,
  extractVariableAnnotation,
  diffInferredAnnotations
} from '../src/inferredEnrichment';

// KODE-CFG-017-R 消费面富化：纯逻辑层注解提取。死臂/边界取证见各用例注释。

describe('mirrorRelPathFor 镜像路径映射', () => {
  it('scripts 根:相对前缀原样保留', () => {
    expect(mirrorRelPathFor('/ws', '/ws/scripts', 'base/Avatar.py')).toBe('scripts/base/Avatar.py');
  });

  it('assets/scripts 根:前缀含路径段', () => {
    expect(mirrorRelPathFor('/ws', '/ws/assets/scripts', 'cell/kbemain.py')).toBe(
      'assets/scripts/cell/kbemain.py'
    );
  });

  it('根即 scripts:无前缀', () => {
    expect(mirrorRelPathFor('/ws/scripts', '/ws/scripts', 'a.py')).toBe('a.py');
  });
});

describe('extractReturnAnnotation 返回注解', () => {
  it('有注解原样透传(含嵌套泛型)', () => {
    const text = 'def foo(x: int) -> List[Dict[str, int]]:\n    pass\n';
    expect(extractReturnAnnotation(text, 'foo')).toBe('List[Dict[str, int]]');
  });

  it('无返回注解 → null', () => {
    expect(extractReturnAnnotation('def foo(x):\n    pass\n', 'foo')).toBeNull();
  });

  it('字符串里的假 def 不误配', () => {
    const text = 's = "def fake(x) -> str"\ndef real() -> int:\n    pass\n';
    expect(extractReturnAnnotation(text, 'real')).toBe('int');
  });

  it('不存在符号 → null', () => {
    expect(extractReturnAnnotation('def foo() -> int:\n    pass\n', 'bar')).toBeNull();
  });
});

describe('extractParamAnnotations 参数注解', () => {
  it('有注解参数提取,无注解参数跳过', () => {
    const text = 'def f(x: int, y, z: str = "a") -> None:\n    pass\n';
    expect(extractParamAnnotations(text, 'f')).toEqual([
      { name: 'x', type: 'int' },
      { name: 'z', type: 'str' }
    ]);
  });

  it('self 前缀参数跳过,嵌套泛型注解保留逗号', () => {
    const text = 'def m(self, data: Dict[str, int]) -> None:\n    pass\n';
    expect(extractParamAnnotations(text, 'm')).toEqual([{ name: 'data', type: 'Dict[str, int]' }]);
  });

  it('无参数 → []', () => {
    expect(extractParamAnnotations('def f() -> int:\n    pass\n', 'f')).toEqual([]);
  });

  it('不存在符号 → []', () => {
    expect(extractParamAnnotations('def f(x: int) -> int:\n    pass\n', 'g')).toEqual([]);
  });
});

describe('extractVariableAnnotation 变量注解', () => {
  it('模块级变量注解', () => {
    expect(extractVariableAnnotation('count: int = 0\n', 'count')).toBe('int');
  });

  it('self 属性注解', () => {
    expect(extractVariableAnnotation('self.name: str\n', 'name')).toBe('str');
  });

  it('注解行内字符串/注释不串', () => {
    // 行内 `#` 注释后的内容不属注解;但 `:` 前是符号即取。
    const text = 'value: str  # 注释\n';
    expect(extractVariableAnnotation(text, 'value')).toBe('str');
  });

  it('无注解 → null', () => {
    expect(extractVariableAnnotation('count = 0\n', 'count')).toBeNull();
  });

  it('注解含字符串字面量:原文切片保真(掩码定位不串味)', () => {
    expect(extractVariableAnnotation('mode: Literal["a", "b"] = "a"\n', 'mode')).toBe('Literal["a", "b"]');
  });

  it('类型行之后他行的 = 不越行截尾', () => {
    const text = 'count: int\nother = 5\n';
    expect(extractVariableAnnotation(text, 'count')).toBe('int');
  });
});

describe('mirrorPathForSource 镜像绝对路径映射', () => {
  it('工作区内:拼 <managedDir>/inferred/<相对路径>', () => {
    expect(mirrorPathForSource('/ws', '.kbengine', '/ws/scripts/base/Avatar.py')).toBe(
      path.join('/ws', '.kbengine', 'inferred', 'scripts/base/Avatar.py')
    );
  });

  it('工作区外:返回 null', () => {
    expect(mirrorPathForSource('/ws', '.kbengine', '/other/a.py')).toBeNull();
  });

  it('自定义 managedDir 随迁', () => {
    expect(mirrorPathForSource('/ws', '.kbengine2', '/ws/a.py')).toBe(
      path.join('/ws', '.kbengine2', 'inferred', 'a.py')
    );
  });
});

describe('diffInferredAnnotations 源↔镜像行差分', () => {
  it('返回注解:源缺箭头 → 右括号后出 `-> T`', () => {
    const source = 'def foo():\n    pass\n';
    const mirror = 'def foo() -> int:\n    pass\n';
    expect(diffInferredAnnotations(source, mirror)).toEqual([
      { line: 0, character: 9, label: '-> int' }
    ]);
  });

  it('形参注解:源缺冒号 → 名字后出 `: T`;已注解形参不出', () => {
    const source = 'def f(x, y: str) -> None:\n    pass\n';
    const mirror = 'def f(x: int, y: str) -> None:\n    pass\n';
    expect(diffInferredAnnotations(source, mirror)).toEqual([
      { line: 0, character: 7, label: ': int' }
    ]);
  });

  it('赋值注解:镜像 `name: T =`、源裸赋值 → 名字后出 `: T`', () => {
    const source = 'count = 0\n';
    const mirror = 'count: int = 0\n';
    expect(diffInferredAnnotations(source, mirror)).toEqual([
      { line: 0, character: 5, label: ': int' }
    ]);
  });

  it('self 属性赋值差分', () => {
    const source = '        self.name = x\n';
    const mirror = '        self.name: str = x\n';
    expect(diffInferredAnnotations(source, mirror)).toEqual([
      { line: 0, character: 17, label: ': str' }
    ]);
  });

  it('行数不一致(结构漂移)整批不出', () => {
    expect(diffInferredAnnotations('a = 1\nb = 2\n', 'a: int = 1\n')).toEqual([]);
  });

  it('源已带同款注解 → 不出(只补缺)', () => {
    expect(diffInferredAnnotations('count: int = 0\n', 'count: int = 0\n')).toEqual([]);
    expect(diffInferredAnnotations('def f() -> int:\n    pass\n', 'def f() -> int:\n    pass\n')).toEqual([]);
  });

  it('源行比较语句(==)不误配赋值差分', () => {
    expect(diffInferredAnnotations('count == 1\n', 'count: int = 1\n')).toEqual([]);
  });

  it('注释里的注解形态不串(掩码后不命中)', () => {
    const source = 'count = 0  # count: str\n';
    const mirror = 'count: int = 0  # count: str\n';
    expect(diffInferredAnnotations(source, mirror)).toEqual([
      { line: 0, character: 5, label: ': int' }
    ]);
  });

  it('多行签名(单行括号不闭合)该行跳过,优雅降级', () => {
    const source = 'def f(\n        x\n    ):\n        pass\n';
    const mirror = 'def f(\n        x: int\n    ) -> str:\n        pass\n';
    expect(diffInferredAnnotations(source, mirror)).toEqual([]);
  });
});
