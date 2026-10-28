/**
 * 构建错误定位到源码(IDE-TSK-003):compileall -q 的错误输出按 Python
 * 版本有两种格式,两种都支持——
 * ①单行(旧版,≈3.12 及以前):`*** SyntaxError: invalid syntax in file
 *   /abs/x.py on line 3`;
 * ②多行(3.13+ 实测 3.14):`*** Error compiling '/abs/x.py'...` +
 *   `  File "/abs/x.py", line 1` + 源码行/插入符行(不匹配,跳过)+
 *   `SyntaxError: invalid syntax`。
 * 本模块是解析器的单一事实源(逐行喂入,凑齐 文件+行+消息 即吐一条问
 * 题),package.json 贡献的 `$kbengine-compileall` problem matcher 的
 * 四条正则与本模块四个 *_SOURCE 逐字同源(锁测试对账),任务
 * (buildTaskFromSpec)挂同一 matcher 名。
 */

/** problem matcher 名(任务挂 '$kbengine-compileall') */
export const KBE_COMPILEALL_MATCHER_NAME = 'kbengine-compileall';

// 四条正则的源串(package.json problemMatchers 逐字同源,锁测试对账)

/** ①单行(旧版):消息=「类: 描述」整组,文件/行号随组 */
export const COMPILEALL_INLINE_SOURCE =
  '^\\*\\*\\* ((?:\\w+Error|\\w+Warning|\\w+Exception): .+) in file (.+) on line (\\d+)';

/** ②多行(3.13+)头:正在编译哪个文件 */
export const COMPILEALL_HEADER_SOURCE = "^\\*\\*\\* Error compiling '(.+)'";

/** ②多行(3.13+)定位:File "路径", 行 N */
export const COMPILEALL_LOCATION_SOURCE = '^  File "(.+)", line (\\d+)';

/** ②多行(3.13+)收口:错误类行(消息=错误类) */
export const COMPILEALL_MESSAGE_SOURCE = '^((?:\\w+Error|\\w+Warning|\\w+Exception))\\b';

const INLINE_PATTERN = new RegExp(COMPILEALL_INLINE_SOURCE);
const HEADER_PATTERN = new RegExp(COMPILEALL_HEADER_SOURCE);
const LOCATION_PATTERN = new RegExp(COMPILEALL_LOCATION_SOURCE);
const MESSAGE_PATTERN = new RegExp(COMPILEALL_MESSAGE_SOURCE);

/** 一条编译问题(文件+行+消息) */
export interface CompileProblem {
  file: string;
  line: number;
  message: string;
}

/**
 * 逐行状态机:header/location 累积当前文件与行号,错误类行凑齐即吐
 * 一条问题并清零;单行格式独立成条。不匹配的行(源码行/插入符/正常
 * 输出)零动作。
 */
export class CompileallErrorParser {
  private pendingFile: string | undefined;
  private pendingLine: number | undefined;

  feed(line: string): CompileProblem | null {
    const inline = INLINE_PATTERN.exec(line);
    if (inline) {
      return { message: inline[1], file: inline[2], line: Number(inline[3]) };
    }
    const header = HEADER_PATTERN.exec(line);
    if (header) {
      this.pendingFile = header[1];
      this.pendingLine = undefined;
      return null;
    }
    const location = LOCATION_PATTERN.exec(line);
    if (location) {
      // File 行比 Error compiling 头更具体(两者都在时同文件,取 File 行)
      this.pendingFile = location[1];
      this.pendingLine = Number(location[2]);
      return null;
    }
    const message = MESSAGE_PATTERN.exec(line);
    if (message && this.pendingFile !== undefined && this.pendingLine !== undefined) {
      const problem: CompileProblem = {
        file: this.pendingFile,
        line: this.pendingLine,
        message: message[1]
      };
      this.pendingFile = undefined;
      this.pendingLine = undefined;
      return problem;
    }
    return null;
  }
}
