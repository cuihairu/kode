import * as path from 'path';
import { globSync } from 'glob';
import Mocha from 'mocha';

async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true
  });

  const testsRoot = path.resolve(__dirname, 'suite');
  const files = globSync('**/*.test.js', { cwd: testsRoot });

  for (const file of files) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures > 0) {
        reject(new Error(`${failures} tests failed.`));
        return;
      }

      resolve();
    });
  });
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
