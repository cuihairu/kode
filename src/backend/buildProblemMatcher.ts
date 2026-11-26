/**
 * Locating build errors back to source (IDE-TSK-003): the error output of
 * compileall -q has two formats depending on the Python version, and both are
 * supported —
 * (1) single line (older, up to about 3.12): `*** SyntaxError: invalid syntax in file
 *   /abs/x.py on line 3`;
 * (2) multi-line (3.13+, verified on 3.14): `*** Error compiling '/abs/x.py'...` +
 *   `  File "/abs/x.py", line 1` + source line/caret line (no match, skipped) +
 *   `SyntaxError: invalid syntax`.
 * This module is the single source of truth for the parser (fed line by line;
 * once file+line+message are all gathered, one problem is emitted). The four
 * regexes of the `$kbengine-compileall` problem matcher contributed by
 * package.json are verbatim identical to this module's four *_SOURCE strings
 * (locked by a parity test), and the task (buildTaskFromSpec) attaches the
 * same matcher name.
 */

/** problem matcher name (tasks attach '$kbengine-compileall') */
export const KBE_COMPILEALL_MATCHER_NAME = 'kbengine-compileall';

// Source strings for the four regexes (verbatim identical to package.json
// problemMatchers, locked by a parity test)

/** (1) single line (older): message = the whole "Class: description" group, file/line ride along as groups */
export const COMPILEALL_INLINE_SOURCE =
  '^\\*\\*\\* ((?:\\w+Error|\\w+Warning|\\w+Exception): .+) in file (.+) on line (\\d+)';

/** (2) multi-line (3.13+) header: which file is being compiled */
export const COMPILEALL_HEADER_SOURCE = "^\\*\\*\\* Error compiling '(.+)'";

/** (2) multi-line (3.13+) location: File "path", line N */
export const COMPILEALL_LOCATION_SOURCE = '^  File "(.+)", line (\\d+)';

/** (2) multi-line (3.13+) closer: the error-class line (message = the error class) */
export const COMPILEALL_MESSAGE_SOURCE = '^((?:\\w+Error|\\w+Warning|\\w+Exception))\\b';

const INLINE_PATTERN = new RegExp(COMPILEALL_INLINE_SOURCE);
const HEADER_PATTERN = new RegExp(COMPILEALL_HEADER_SOURCE);
const LOCATION_PATTERN = new RegExp(COMPILEALL_LOCATION_SOURCE);
const MESSAGE_PATTERN = new RegExp(COMPILEALL_MESSAGE_SOURCE);

/** One compile problem (file + line + message) */
export interface CompileProblem {
  file: string;
  line: number;
  message: string;
}

/**
 * Line-by-line state machine: header/location accumulate the current file and
 * line number; once the error-class line arrives, one problem is emitted and
 * the state resets; the single-line format forms a problem on its own. Lines
 * that do not match (source line/caret/normal output) trigger no action.
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
      // The File line is more specific than the Error compiling header (when both
      // appear they refer to the same file; take the File line)
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
