import path from 'path';
import { defineConfig } from 'vitest/config';

// Integration tag (C-10 / V-07·c): suites that need a real engine source tree or
// a real demo-script checkout to produce real results.
// The selection criterion is an **explicit file list**, not wildcards — a
// wildcard like `*Real*` would wrongly pick up tests/realReproCellMethods.test.ts
// (an ordinary unit test with "Real" in its name, not tree-dependent).
// Every file in the list carries its own tree guard (describeWithEngineTree /
// describe.skipIf): on a tree-less environment it produces a visible skip, not a
// red — that is the lesson of 675e805: a missing checkout must not redden the
// pipeline.
// The main gate (vitest.config.ts) still collects the full tests/**/*.test.ts set;
// this config only runs separately in a tree environment, and neither replaces
// nor reduces the main gate.
// Run: npx vitest run --config vitest.integration.config.ts
// A real run in a tree environment must point the probe at the engine root:
// KBENGINE_ROOT=<engine root>
export default defineConfig({
  resolve: {
    alias: {
      // The same vscode stub as vitest.config.ts: the assembly semantics must not split
      vscode: path.resolve(__dirname, 'tests/helpers/vscodeStub.ts')
    }
  },
  test: {
    include: [
      'tests/engineTreeProbe.test.ts',
      'tests/realEngineIntegration.test.ts',
      'tests/fantasydemoDefAnalysis.test.ts'
    ],
    environment: 'node'
  }
});
