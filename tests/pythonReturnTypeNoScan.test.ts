import * as fs from 'fs';
import { expect, it, vi } from 'vitest';
import { resolveLocalVariableReturnType } from '../src/pythonReturnTypeInference';

vi.mock('fs', () => ({
  readdirSync: vi.fn(() => [{ name: 'source.py', isDirectory: () => false, isFile: () => true }]),
  readFileSync: vi.fn(() => 'def get_data() -> JSONDATA:\n    pass\n')
}));

it('只在目标变量存在调用赋值时枚举和读取项目文件', () => {
  expect(resolveLocalVariableReturnType(
    ['other = get_data()', 'data = 42', 'return data'], 2, 'data', '/project'
  )).toBeNull();
  expect(fs.readdirSync).not.toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', '/project'))
    .toMatchObject({ annotation: 'JSONDATA' });
  expect(fs.readdirSync).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync).toHaveBeenCalledTimes(1);
});
