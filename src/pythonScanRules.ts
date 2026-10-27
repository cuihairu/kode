/** Keep workspace discovery and external-root walking on the same exclusion list. */
export const PY_SCAN_EXCLUDED_DIRS = new Set([
  'node_modules', 'third_party', '.git', 'vcpkg', 'build', 'dist',
  'out', '.tmp', 'perf', '.venv', 'venv', 'site-packages', '__pycache__'
]);

export const PY_SCAN_EXCLUDE =
  `**/{${[...PY_SCAN_EXCLUDED_DIRS].join(',')}}/**`;
