// Records the guide's videos (docs/media/<name>.mp4 + .jpg poster) from the real Studio against the
// made-up demo orgs (tools/demo/server.mjs must be running). Run: node tools/demo/record.mjs [name…]
// Needs Playwright (dev dependency) with Chrome, and ffmpeg.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scenes as guideScenes } from './scenes.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
// DEMO_MEDIA / DEMO_SCENES: somewhere else to write the videos, other scenes to run (trying a scene out)
const media = process.env.DEMO_MEDIA ?? join(here, '../../../docs/media');
const work = join(here, '.recordings');
const BASE = process.env.DEMO_URL ?? 'http://localhost:7171';
const SIZE = { width: 1440, height: 860 };
const GIFS = ['hubs', 'query', 'migrate'];
// The demo git repository (make-repo.mjs), opened as "the project folder" by scenes with `folder: true`; a folder
// a backup is written to (Backup's "Choose folder…", in readwrite mode), emptied before each recording
const ROOTS = { repo: join(work, 'acme-project'), backups: join(work, 'backups') };

/** Chrome's folder picker: the demo repository to read, or the backups folder to write (served from this process). */
const FOLDER = () => {
  const missing = () => new DOMException('not found', 'NotFoundError');
  const base64 = async (data) => {
    const bytes =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : new Uint8Array(data.buffer ?? data);
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const file = (root, path, name, stat) => ({
    kind: 'file',
    name,
    async getFile() {
      const now = (await window.__fsStat(root, path)) ?? stat;
      const bytes = Uint8Array.from(atob(await window.__fsRead(root, path)), (c) => c.charCodeAt(0));
      return new File([bytes], name, { lastModified: now.mtime });
    },
    async createWritable() {
      const parts = [];
      return {
        async write(data) {
          parts.push(await base64(data?.type === 'write' ? data.data : data));
        },
        async close() {
          await window.__fsWrite(root, path, parts);
        },
      };
    },
    async isSameEntry(other) {
      return other?.name === name && other?.kind === 'file';
    },
  });
  const dir = (root, path, name) => {
    const child = (n) => (path ? `${path}/${n}` : n);
    const handle = {
      kind: 'directory',
      name,
      async getDirectoryHandle(n, options) {
        let s = await window.__fsStat(root, child(n));
        if (!s && options?.create) s = await window.__fsMkdir(root, child(n));
        if (!s || !s.dir) throw missing();
        return dir(root, child(n), n);
      },
      async getFileHandle(n, options) {
        let s = await window.__fsStat(root, child(n));
        if (!s && options?.create) {
          await window.__fsWrite(root, child(n), []);
          s = await window.__fsStat(root, child(n));
        }
        if (!s || s.dir) throw missing();
        return file(root, child(n), n, s);
      },
      async removeEntry(n) {
        await window.__fsRemove(root, child(n));
      },
      async *entries() {
        for (const [n, isDir] of await window.__fsList(root, path))
          yield [
            n,
            isDir
              ? dir(root, child(n), n)
              : file(root, child(n), n, (await window.__fsStat(root, child(n))) ?? { mtime: 0 }),
          ];
      },
      async *values() {
        for await (const [, h] of handle.entries()) yield h;
      },
      async *keys() {
        for await (const [n] of handle.entries()) yield n;
      },
      [Symbol.asyncIterator]() {
        return handle.entries();
      },
      async isSameEntry(other) {
        return other?.name === name && other?.kind === 'directory';
      },
      async queryPermission() {
        return 'granted';
      },
      async requestPermission() {
        return 'granted';
      },
    };
    return handle;
  };
  const top = { backups: () => dir('backups', '', 'NomadSF backups'), repo: () => dir('repo', '', 'acme-project') };
  window.showDirectoryPicker = async (options) => {
    const root = options?.mode === 'readwrite' ? 'backups' : 'repo';
    return Object.assign(top[root](), { fakeRoot: root });
  };
  // The Studio remembers a folder in IndexedDB, which cannot keep functions: it keeps which folder, and gets it back
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    return put.call(this, value?.fakeRoot ? { fakeFolder: value.fakeRoot } : value, key);
  };
  const result = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
  Object.defineProperty(IDBRequest.prototype, 'result', {
    get() {
      const value = result.get.call(this);
      return value?.fakeFolder ? Object.assign(top[value.fakeFolder](), { fakeRoot: value.fakeFolder }) : value;
    },
  });
};

async function openFolder(page) {
  rmSync(ROOTS.backups, { recursive: true, force: true });
  mkdirSync(ROOTS.backups, { recursive: true });
  const inRoot = (root, p) => {
    const full = join(ROOTS[root], p ?? '');
    if (!full.startsWith(ROOTS[root])) throw new Error('outside the folder');
    return full;
  };
  const stat = (root, p) => {
    try {
      const s = statSync(inRoot(root, p));
      return { dir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
    } catch {
      return null;
    }
  };
  await page.exposeFunction('__fsStat', stat);
  await page.exposeFunction('__fsRead', (root, p) => readFileSync(inRoot(root, p)).toString('base64'));
  await page.exposeFunction('__fsList', (root, p) =>
    readdirSync(inRoot(root, p), { withFileTypes: true }).map((e) => [e.name, e.isDirectory()])
  );
  // Writing only ever reaches the backups folder
  const writable = (root) => {
    if (root !== 'backups') throw new Error('The demo repository is read-only.');
  };
  await page.exposeFunction('__fsMkdir', (root, p) => {
    writable(root);
    mkdirSync(inRoot(root, p), { recursive: true });
    return stat(root, p);
  });
  await page.exposeFunction('__fsWrite', (root, p, parts) => {
    writable(root);
    writeFileSync(inRoot(root, p), Buffer.concat(parts.map((b) => Buffer.from(b, 'base64'))));
  });
  await page.exposeFunction('__fsRemove', (root, p) => {
    writable(root);
    rmSync(inRoot(root, p), { recursive: true, force: true });
  });
  await page.addInitScript(FOLDER);
}

/** The AI of a scene: answers written for it (no AI provider is called), through the Studio's own parsing. */
async function scriptedAi(page, answers) {
  await page.route('**/api/ai', (route) => route.fulfill({ json: { current: { apiKeySet: true, provider: 'demo' } } }));
  await page.route('**/api/ai/assist', async (route) => {
    // Newer tasks reach the app as a ready-made prompt (task 'chat'): the scene's one answer
    const { task } = route.request().postDataJSON();
    const text = answers[task] ?? answers.any;
    if (!text) return route.fulfill({ status: 400, json: { error: `No demo answer for ${task}` } });
    return route.fulfill({ json: { text, model: 'demo model', provider: 'Demo', sentChars: 900 } });
  });
}

/** A visible cursor (recordings show no pointer) that follows the mouse and pulses on a click. */
const CURSOR = () => {
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div');
    dot.style.cssText =
      'position:fixed;left:-40px;top:-40px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
      'background:rgba(11,92,255,.28);border:2px solid rgba(11,92,255,.9);z-index:2147483647;pointer-events:none;' +
      'transition:transform .12s ease';
    document.body.append(dot);
    addEventListener(
      'mousemove',
      (e) => {
        dot.style.left = `${e.clientX}px`;
        dot.style.top = `${e.clientY}px`;
      },
      true
    );
    addEventListener('mousedown', () => (dot.style.transform = 'scale(.7)'), true);
    addEventListener('mouseup', () => (dot.style.transform = 'scale(1)'), true);
  });
};

/** What a scene can do: move and click like a person, type, answer the typed-name check. */
function helpers(page, clock) {
  const pause = (ms = 700) => page.waitForTimeout(ms);
  /** Waiting for Salesforce: a long wait is cut out of the video (it keeps 0.8 s of it). */
  const waiting = async (work) => {
    const from = clock();
    try {
      return await work();
    } finally {
      const to = clock();
      if (to - from > 1.5) clock.cuts.push([from + 0.5, to - 0.3]);
    }
  };
  const pointAt = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
    return box;
  };
  const press = async (locator) => {
    await locator.waitFor({ state: 'visible', timeout: 20000 });
    await pointAt(locator);
    await pause(250);
    await locator.click();
    await pause(500);
  };
  const clickable = page.locator('button:visible, [role=tab]:visible, label.file-button:visible');
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The button whose text is exactly the name (else the first that contains it)
  const button = async (name) => {
    if (name instanceof RegExp) return clickable.filter({ hasText: name }).first();
    const exact = clickable.filter({ hasText: new RegExp(`^\\s*${esc(name)}\\s*$`) });
    return (await exact.count()) ? exact.first() : clickable.filter({ hasText: name }).first();
  };
  const h = {
    page,
    pause,
    press,
    /** A button or tab by its text. */
    click: async (name) => press(await button(name)),
    /** A hub in the sidebar, then a tool in the hub's own sidebar. */
    tab: async (hub, tab) => {
      await press(
        page
          .locator('nav.side button.hub')
          .filter({ has: page.locator('.hub-label', { hasText: new RegExp(`^${hub}$`) }) })
          .first()
      );
      // The hub's own sidebar of tools, in its pane
      if (tab)
        await press(
          page
            .locator('.pane.active .pane-nav-item, .pane .pane-nav-item')
            .filter({ has: page.locator('.pane-nav-label', { hasText: new RegExp(`^${esc(tab)}$`) }) })
            .first()
        );
      await pause(1500);
    },
    /** Types into a field like a person. */
    type: async (locator, text, { clear = true } = {}) => {
      await press(locator);
      if (clear) await locator.fill('');
      await locator.pressSequentially(text, { delay: 45 });
      await pause(400);
    },
    /** The Monaco editor's whole text. */
    code: async (text) => {
      const editor = page.locator('.monaco-editor').first();
      await press(editor);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(text, { delay: 18 });
      await pause(500);
    },
    /** The option of a list whose text matches (a label, not a value). */
    choose: async (locator, text) => {
      await locator.waitFor({ timeout: 60000 });
      const options = await locator
        .locator('option')
        .evaluateAll((os) => os.map((o) => ({ value: o.value, text: o.textContent })));
      const hit = options.find((o) => (text instanceof RegExp ? text.test(o.text) : o.text.includes(text)));
      if (!hit) throw new Error(`No option ${text}`);
      await pointAt(locator);
      await locator.selectOption(hit.value);
      await pause(900);
    },
    /** Ticks an object in an object picker (Backup, Migrate): filters the list for it first. */
    pickObject: async (name) => {
      const picker = page.locator('.object-picker').first();
      await h.type(picker.locator('input[placeholder^="Filter"]').first(), name);
      await press(
        picker
          .locator('.obj-row', { has: page.locator('.obj-label', { hasText: new RegExp(`^${esc(name)}$`) }) })
          .locator('input[type=checkbox]')
          .first()
      );
    },
    /** A table row whose cell is exactly this text. */
    row: (text) =>
      page.locator('tr', { has: page.locator('td', { hasText: new RegExp(`^\\s*${esc(text)}\\s*$`) }) }).first(),
    select: async (locator, value) => {
      await pointAt(locator);
      await locator.selectOption(value);
      await pause(900);
    },
    /** Answers NomadSF's own dialog: types the org name when asked, then the main button. */
    confirm: async (orgName) => {
      const dialog = page.locator('.ask').last();
      await dialog.waitFor({ timeout: 60000 });
      const input = dialog.locator('input').first();
      if (orgName && (await input.count())) await h.type(input, orgName);
      await press(dialog.locator('.ask-actions button.primary'));
    },
    /** Any long wait, cut out of the video like a wait for Salesforce. */
    waiting,
    /** Waits until a text shows (Salesforce answers in its own time). */
    until: (text, timeout = 60000) => waiting(() => page.getByText(text).first().waitFor({ timeout })),
    /** Until NomadSF stops waiting for Salesforce (its spinner and every working message are gone). */
    settle: (timeout = 60000) =>
      waiting(async () => {
        await page.waitForTimeout(300);
        await page
          .waitForFunction(
            () =>
              !document.querySelector('.status-spin') &&
              !/Working…/.test(document.querySelector('header')?.textContent ?? ''),
            null,
            { timeout }
          )
          .catch(() => {});
      }),
    file: (locator, path) => locator.setInputFiles(path),
  };
  return h;
}

async function record(scene, browser) {
  mkdirSync(work, { recursive: true });
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    recordVideo: { dir: work, size: SIZE },
    acceptDownloads: true,
  });
  await context.addInitScript(CURSOR);
  const page = await context.newPage();
  if (scene.folder) await openFolder(page);
  // DEMO_REAL_AI=1: the server's own AI answers (see server.mjs) instead of the scene's written answers
  if (scene.ai && !process.env.DEMO_REAL_AI) await scriptedAi(page, scene.ai);
  // A recording is a test too: an error in the page fails the scene
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const born = Date.now();
  await page.goto(`${BASE}/${scene.hash ? `#${scene.hash}` : ''}`);
  await page.locator('nav.side').waitFor();
  await page.waitForTimeout(2500);
  const from = (Date.now() - born) / 1000;
  const clock = () => (Date.now() - born) / 1000;
  clock.cuts = [];
  const h = helpers(page, clock);
  let error;
  try {
    await scene.run(h);
    await h.pause(1800);
    if (pageErrors.length) throw new Error(`Page error: ${pageErrors[0]}`);
    // …and so does a problem in the Log the scene did not set out to show (scene.problems: a pattern it expects)
    const problems = (await page.locator('.log-row.status-problem .log-text').allTextContents()).filter(
      (t) => !(scene.problems && scene.problems.test(t))
    );
    if (problems.length) throw new Error(`Problem in the Log: ${problems[0]}`);
  } catch (e) {
    error = e;
    await page.screenshot({ path: join(work, `failed-${scene.name}.png`) }).catch(() => {});
  }
  const video = await page.video().path();
  await context.close();
  // A scene that went wrong keeps the video it had: a stuck recording never replaces a good one
  if (error) {
    rmSync(video, { force: true });
    return { name: scene.name, seconds: 0, error: error.message.split('\n')[0] };
  }
  const out = join(media, `${scene.name}.mp4`);
  // From the loaded page to the end, without the long waits for Salesforce, 1280 wide, small and
  // quick to start on the web
  const keep = clock.cuts.length
    ? `select='not(${clock.cuts
        .map(([a, b]) => `between(t,${(a - from).toFixed(2)},${(b - from).toFixed(2)})`)
        .join('+')})',setpts=N/25/TB,`
    : '';
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    from.toFixed(2),
    '-i',
    video,
    '-vf',
    `fps=25,${keep}scale=1280:-2`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '30',
    '-preset',
    'slow',
    '-movflags',
    '+faststart',
    '-an',
    out,
  ]);
  const length = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], {
      encoding: 'utf8',
    })
  );
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    Math.max(0, length - 1).toFixed(2),
    '-i',
    out,
    '-frames:v',
    '1',
    '-q:v',
    '4',
    join(media, `${scene.name}.jpg`),
  ]);
  rmSync(video, { force: true });
  // The READMEs show a few as GIFs (GitHub plays no MP4 inline)
  if (GIFS.includes(scene.name))
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      out,
      '-vf',
      'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      join(media, `${scene.name}.gif`),
    ]);
  return { name: scene.name, seconds: Math.round(length) };
}

const scenes = process.env.DEMO_SCENES ? (await import(resolve(process.env.DEMO_SCENES))).scenes : guideScenes;
const only = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
for (const scene of scenes.filter((s) => !only.length || only.includes(s.name))) {
  const r = await record(scene, browser);
  results.push(r);
  console.log(`${r.error ? '✗' : '✓'} ${r.name} ${r.seconds}s${r.error ? ` — ${r.error}` : ''}`);
}
await browser.close();
writeFileSync(
  join(media === join(here, '../../../docs/media') ? work : media, 'last-run.json'),
  JSON.stringify(results, null, 2)
);
