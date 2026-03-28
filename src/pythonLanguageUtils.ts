export interface PythonSelfAccess {
  rootSymbol: string;
  currentSymbol: string;
  fullPath: string;
}

export interface PythonSelfCompletionContext {
  rootSymbol: string | null;
  parentPath: string;
  fullPath: string;
  partialSymbol: string;
}

export function getPythonSelfAccessAtPosition(
  lineText: string,
  character: number
): PythonSelfAccess | null {
  const regex = /\bself\.(\w+(?:\.\w+)*)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(lineText)) !== null) {
    const fullMatch = match[0];
    const accessPath = match[1];
    const pathStart = match.index + fullMatch.indexOf(accessPath);
    const segments = accessPath.split('.');

    let segmentOffset = pathStart;
    for (const segment of segments) {
      const segmentStart = segmentOffset;
      const segmentEnd = segmentStart + segment.length;

      if (character >= segmentStart && character <= segmentEnd) {
        return {
          rootSymbol: segments[0],
          currentSymbol: segment,
          fullPath: accessPath
        };
      }

      segmentOffset = segmentEnd + 1;
    }
  }

  return null;
}

export function getPythonSelfSymbolAtPosition(lineText: string, character: number): string | null {
  const access = getPythonSelfAccessAtPosition(lineText, character);
  return access ? access.rootSymbol : null;
}

export function getPythonSelfCompletionContext(lineText: string): PythonSelfCompletionContext | null {
  const match = lineText.match(/\bself\.(\w+(?:\.\w+)*)?\.?$/);
  if (!match) {
    return null;
  }

  const accessPath = match[1] || '';
  const endsWithDot = lineText.endsWith('.');
  const segments = accessPath ? accessPath.split('.') : [];

  if (endsWithDot) {
    return {
      rootSymbol: segments.length > 0 ? segments[0] : null,
      parentPath: accessPath,
      fullPath: accessPath,
      partialSymbol: ''
    };
  }

  const partialSymbol = segments.length > 0 ? segments[segments.length - 1] : '';
  const rootSymbol = segments.length > 0 ? segments[0] : null;
  const parentPath = segments.length > 1 ? segments.slice(0, -1).join('.') : '';

  return {
    rootSymbol,
    parentPath,
    fullPath: accessPath,
    partialSymbol
  };
}
