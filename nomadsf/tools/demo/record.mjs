// Records the guide's videos (docs/media/<name>.mp4 + .jpg poster) from the real Studio against the
// made-up demo orgs (tools/demo/server.mjs must be running). Run: node tools/demo/record.mjs [name…]
// Needs Playwright (dev dependency) with Chrome, and ffmpeg.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scenes } from './scenes.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const media = join(here, '../../../docs/media');
const work = join(here, '.recordings');
const BASE = process.env.DEMO_URL ?? 'http://localhost:7171';
const SIZE = { width: 1440, height: 860 };
const GIFS = ['hubs', 'query', 'migrate'];

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
    /** A hub in the sidebar, then a tab of it. */
    tab: async (hub, tab) => {
      await press(
        page
          .locator('nav.side button.hub')
          .filter({ has: page.locator('.hub-label', { hasText: new RegExp(`^${hub}$`) }) })
          .first()
      );
      if (tab) await press(page.locator('.pane.active .hub-tab, .pane .hub-tab').filter({ hasText: tab }).first());
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

const only = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
for (const scene of scenes.filter((s) => !only.length || only.includes(s.name))) {
  const r = await record(scene, browser);
  results.push(r);
  console.log(`${r.error ? '✗' : '✓'} ${r.name} ${r.seconds}s${r.error ? ` — ${r.error}` : ''}`);
}
await browser.close();
writeFileSync(join(work, 'last-run.json'), JSON.stringify(results, null, 2));
