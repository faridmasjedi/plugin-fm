// Packs the extension folder into nomadqa-extension.zip (the system zip tool, nothing to install).
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
rmSync(`${root}nomadqa-extension.zip`, { force: true });
execFileSync('zip', ['-qr', '../nomadqa-extension.zip', '.', '-x', '.*'], { cwd: `${root}extension` });
console.log('nomadqa-extension.zip');
