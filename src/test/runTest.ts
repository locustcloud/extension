import * as path from 'path';
import { execSync } from 'child_process';
import {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

/**
 * Entry point for running extension tests.
 * Sets up a test instance of VSCode with the extension and dependencies installed.
 * Runs tests located in ./suite/index.ts
 */

async function main() {
  try {
    const version = process.env.VSCODE_VERSION ?? 'stable';

    const repoRoot = path.resolve(__dirname, '../../');
    const testRoot = path.join(repoRoot, '.vscode-test');
    const userDataDir = path.join(testRoot, 'user-data');
    const extensionsDir = path.join(testRoot, 'extensions');

    const vscodeExecutablePath = await downloadAndUnzipVSCode(version);
    const cli = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const run = (cmd: string) => execSync(cmd, { env, stdio: 'inherit' });

    // create dirs
    run(`mkdir -p "${userDataDir}" "${extensionsDir}"`);

    // install required deps into the SAME dirs
    run(
      `${cli} --user-data-dir "${userDataDir}" --extensions-dir "${extensionsDir}" --install-extension ms-python.python`,
    );

    // sanity print
    run(
      `${cli} --user-data-dir "${userDataDir}" --extensions-dir "${extensionsDir}" --list-extensions --show-versions`,
    );

    const extensionDevelopmentPath = repoRoot;
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({
      version,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`],
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
