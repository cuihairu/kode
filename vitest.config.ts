import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // definitionSemantics pure-logic tests transitively depend on vscode via
      // definitionWorkspace; this stub satisfies module evaluation (tests/fake-vscode,
      // the same implementation consumed by the mocha smoke tests).
      vscode: path.resolve(__dirname, 'tests/helpers/vscodeStub.ts')
    }
  },
  test: {
    // vitest carries all functional tests (pure logic / simulator / fake-vscode
    // assembly and panels); the mocha suite in src/test/suite only smoke-tests the
    // compiled artifacts, and the two never mix.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // WIN-7: the full 499-file run, parallelized by CPU count on 16C/8GB, squeezed
    // spawn/real-run cases out of the 5s testTimeout (all green when run alone) —
    // cap the worker count to keep headroom; Linux CI benefits the same way.
    maxWorkers: 8,
    // Loopback socket integration tests have all moved to the tests/sim simulator
    // (ports allocated dynamically, see docs/redesign.md phase 1), so file-level
    // parallelism no longer fights over fixed ports.
    coverage: {
      provider: 'v8',
      // Coverage honestly counts all src sources: from redesign phase 3 on,
      // extension.ts activate/deactivate are driven by the fake-vscode assembly
      // tests and count in the denominator (P14/P16).
      // all=true: source files untouched by tests also count in the denominator,
      // so the codecov badge number is the true whole-tree value (the default only
      // counts loaded files and inflates to ~100%; corrected 2026-10-22).
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/test/**'],
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage'
    }
  }
});
