// Assembles the extension in dist/: Studio build (dist/app), manifest.json, icons, and a
// store-ready zip. Run after `vite build` (popup + background).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

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

// ---------- icons: rounded square with the NomadSF gradient ----------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function icon(size) {
  const radius = size * 0.22;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      // inside the rounded rectangle?
      const dx = Math.max(radius - x - 0.5, 0, x + 0.5 - (size - radius));
      const dy = Math.max(radius - y - 0.5, 0, y + 0.5 - (size - radius));
      const alpha = Math.max(0, Math.min(1, radius - Math.hypot(dx, dy) + 0.5));
      const t = (x + y) / (2 * size);
      const [r, g, b] = [11 + (139 - 11) * t, 92 + (92 - 92) * t, 255 + (246 - 255) * t];
      // white "N"
      const u = x / size;
      const v = y / size;
      const inN =
        v > 0.25 &&
        v < 0.75 &&
        (Math.abs(u - 0.32) < 0.07 || Math.abs(u - 0.68) < 0.07 || Math.abs(u - 0.32 - (v - 0.25) * 0.72) < 0.08);
      const o = 1 + x * 4;
      row[o] = inN ? 255 : r;
      row[o + 1] = inN ? 255 : g;
      row[o + 2] = inN ? 255 : b;
      row[o + 3] = Math.round(alpha * 255);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
mkdirSync(join(dist, 'icons'), { recursive: true });
const icons = {};
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(dist, 'icons', `${size}.png`), icon(size));
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
  host_permissions: [...salesforceHosts, 'http://127.0.0.1/*', 'http://localhost/*'],
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
