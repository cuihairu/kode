import * as fs from 'fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { resetPythonReturnAnnotationCache, resolveLocalVariableReturnType } from '../src/pythonReturnTypeInference';

vi.mock('fs', () => ({
  readdirSync: vi.fn(() => [{ name: 'source.py', isDirectory: () => false, isFile: () => true }]),
  promises: {
    readdir: vi.fn(async () => [{ name: 'source.py', isDirectory: () => false, isFile: () => true }]),
    readFile: vi.fn(async () => 'def get_data() -> JSONDATA:\n    pass\n')
  },
  readFileSync: vi.fn(() => 'def get_data() -> JSONDATA:\n    pass\n')
}));

beforeEach(() => {
  resetPythonReturnAnnotationCache();
  vi.clearAllMocks();
});

it('只在目标变量存在调用赋值时枚举和读取项目文件', async () => {
  expect(resolveLocalVariableReturnType(
    ['other = get_data()', 'data = 42', 'return data'], 2, 'data', '/project'
  )).toBeNull();
  expect(fs.readdirSync).not.toHaveBeenCalled();
  expect(fs.promises.readdir).not.toHaveBeenCalled();
  expect(fs.promises.readFile).not.toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', '/project'))
    .toMatchObject({ annotation: 'JSONDATA' });
  expect(fs.promises.readdir).toHaveBeenCalledTimes(1);
  expect(fs.promises.readFile).toHaveBeenCalledTimes(1);
});

it('缓存有效期从慢构建完成时开始', async () => {
  const now = vi.spyOn(Date, 'now')
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(4000)
    .mockReturnValueOnce(4001);
  try {
    const query = () => resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', '/project');
    expect((await query())?.annotation).toBe('JSONDATA');
    expect((await query())?.annotation).toBe('JSONDATA');
    expect(fs.promises.readdir).toHaveBeenCalledTimes(1);
    expect(fs.promises.readFile).toHaveBeenCalledTimes(1);
  } finally {
    now.mockRestore();
  }
});
