// Assembles the extension in dist/: Studio build (dist/app), manifest.json, icons, and a
// store-ready zip. Run after `vite build` (popup + background).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const studio = resolve(root, '../../packages/ui/dist');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!existsSync(join(studio, 'index.html'))) {
  console.error('Build the Studio first: yarn --cwd packages/ui build');
  process.exit(1);
}
rmSync(join(dist, 'app'), { recursive: true, force: true });
cpSync(studio, join(dist, 'app'), { recursive: true });

// ---------- icons: made from assets/nomad-logo.jpg by assets/make-icons.py, copied by Vite from public/icons ----------
const icons = {};
for (const size of [16, 32, 48, 128]) {
  if (!existsSync(join(dist, 'icons', `${size}.png`)))
    throw new Error(`Missing icon ${size}.png: run python3 assets/make-icons.py`);
  icons[size] = `icons/${size}.png`;
}

// ---------- manifest ----------
const salesforceHosts = [
  'https://*.salesforce.com/*',
  'https://*.force.com/*',
  'https://*.salesforce-setup.com/*',
  'https://*.cloudforce.com/*',
  'https://*.site.com/*',
];
const manifest = {
  manifest_version: 3,
  name: 'NomadSF',
  version,
  description: 'Salesforce developer workbench: execute anonymous Apex, debug logs, SOQL with a filterable table.',
  icons,
  action: { default_popup: 'popup.html', default_title: 'NomadSF', default_icon: icons },
  background: { service_worker: 'background.js', type: 'module' },
  permissions: ['cookies', 'activeTab'],
  // Salesforce APIs, plus the local NomadSF app (sf fm dashboard) on this machine
  host_permissions: [
    ...salesforceHosts,
    'http://127.0.0.1/*',
    'http://localhost/*',
    // Repository browser and "Sign in with GitHub" (device flow)
    'https://api.github.com/*',
    'https://github.com/*',
  ],
  content_scripts: [
    {
      matches: [
        'https://*.lightning.force.com/*',
        'https://*.my.salesforce.com/*',
        'https://*.my.salesforce-setup.com/*',
      ],
      js: ['content.js'],
      run_at: 'document_idle',
    },
  ],
  // The floating NomadSF button shows the logo on Salesforce pages
  web_accessible_resources: [
    {
      resources: ['icons/48.png'],
      matches: [
        'https://*.lightning.force.com/*',
        'https://*.my.salesforce.com/*',
        'https://*.my.salesforce-setup.com/*',
      ],
    },
  ],
  // The Studio talks to Salesforce from the extension page; Monaco runs in a worker.
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; worker-src 'self'" },
};
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// ---------- store zip ----------
const zip = join(root, `nomadsf-extension-${version}.zip`);
rmSync(zip, { force: true });
try {
  execFileSync('zip', ['-qr', zip, '.'], { cwd: dist });
  console.log(`Extension: ${dist} (load unpacked) · ${zip} (store upload)`);
} catch {
  console.log(`Extension: ${dist} (load unpacked). Install "zip" to also create the store package.`);
}
