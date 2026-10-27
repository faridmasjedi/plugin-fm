// The extension ships NomadSF Studio (packages/ui build) in dist/studio: no local app needed.
const { cpSync, existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const from = join(__dirname, '../../../packages/ui/dist');
const to = join(__dirname, '../dist/studio');
if (!existsSync(join(from, 'index.html'))) {
  console.error('NomadSF Studio is not built. Run: yarn --cwd nomadsf/packages/ui build');
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
