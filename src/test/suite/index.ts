import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 10000
  });

  const testsRoot = path.resolve(__dirname, '.');

  try {
    const files: string[] = await glob('**/*.test.js', { cwd: testsRoot });
    for (const f of files) {
      mocha.addFile(path.resolve(testsRoot, f));
    }
  } catch (err) {
    throw err;
  }

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures > 0) {
        reject(new Error(`${failures} tests failed.`));
      } else {
        resolve();
      }
    });
  });
}
