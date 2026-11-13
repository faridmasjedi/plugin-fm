// The NomadSF 3.0 release video (LinkedIn, portrait): the new hubs and tools on the demo orgs, with title cards and
// subtitles. Run with the demo server up:
//   DEMO_SCENES=tools/demo/release-3.0.mjs DEMO_SIZE=1080x1350 DEMO_ZOOM=1.15 DEMO_MEDIA=~/Desktop/nomadsf-3.0 \
//     node tools/demo/record.mjs
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const files = join(fileURLToPath(new URL('.', import.meta.url)), '.recordings', 'files');

/** A big card in the middle of the screen: a chapter of the video. */
async function card(h, title, sub = '', ms = 2600) {
  await h.say('');
  await h.page.evaluate(
    ([t, s]) => {
      let el = document.getElementById('__card');
      if (!el) {
        el = document.createElement('div');
        el.id = '__card';
        el.style.cssText =
          'position:fixed;inset:0;z-index:2147483645;display:grid;place-items:center;pointer-events:none;' +
          'background:rgba(15,23,42,.78);transition:opacity .3s;font-family:system-ui,-apple-system,sans-serif';
        document.body.appendChild(el);
      }
      el.style.opacity = t ? '1' : '0';
      if (t)
        el.innerHTML =
          `<div style="text-align:center;color:#fff;max-width:82%">` +
          `<div style="font:700 44px/1.15 system-ui">${t}</div>` +
          (s ? `<div style="margin-top:14px;font:500 21px/1.4 system-ui;opacity:.9">${s}</div>` : '') +
          `</div>`;
    },
    [title, sub]
  );
  if (title) {
    await h.pause(ms);
    await card(h, '');
    await h.pause(300);
  }
}

export const scenes = [
  {
    name: 'nomadsf-3.0',
    hash: 'code',
    folder: true,
    run: async (h) => {
      await card(h, 'NomadSF 3.0', 'Your Salesforce org, project and files — in one place', 3200);

      // Seven hubs, each with its colour
      await h.say('Seven hubs, each with its own colour — and its own tabs');
      await h.tab('Data', 'Query');
      await h.tab('Access', 'Users');
      await h.tab('Org', 'Limits');
      await h.say('« Narrow keeps only the icons: more room for your work');
      await h.press(h.page.locator('nav.side .nav-width'));
      await h.pause(1200);

      // Security
      await card(h, 'New: Security', 'Dashboard · Timeline · Event logs · Who can see · Sharing');
      await h.tab('Security', 'Dashboard');
      await h.settle();
      await h.say('The org’s security at a glance — each tile opens its tool');
      await h.pause(1200);
      await h.tab('Security', 'Who can see');
      await h.say('Who can see: a record, an object, a field or a class — and why');
      await h.type(h.page.locator('input[placeholder^="User"]'), 'Dina Patel');
      await h.pause(1500);
      await h.choose(h.page.locator('.who-pick select, .who-pick .search-select-native').first(), /Dina Patel/);
      await h.click('An object');
      await h.type(h.page.locator('input[placeholder^="Object"]').first(), 'Invoice__c');
      await h.page.keyboard.press('Escape');
      await h.click('Check');
      await h.until(/Modify all/, 60000);
      await h.settle();
      await h.say('Every right, and the profile or permission set that gives it');
      await h.pause(1400);

      // Licenses and flows
      await card(h, 'New: Licenses and Flows', 'Who holds a license without using it · old flow versions');
      await h.tab('Org', 'Licenses');
      await h.settle();
      await h.press(h.page.locator('button.tab', { hasText: /^No login for/ }));
      await h.say('No login for 90 days: freeze or deactivate them — after typing the org name');
      await h.pause(1200);
      await h.tab('Develop', 'Flows');
      await h.until('Invoice_Reminder', 60000);
      await h.settle();
      await h.say('Old flow versions, old API versions, waiting and failed interviews');
      await h.pause(1400);

      // Sandbox refresh
      await card(h, 'New: Sandbox refresh', 'Save what a refresh wipes — then put it back');
      await h.tab('Compare & Deploy', 'Sandbox refresh');
      await h.say('Before: the users to keep, settings, jobs, sharing — in one workbook');
      await h.press(h.page.locator('.segmented button', { hasText: 'By a query' }));
      await h.type(h.page.locator('input.mono').first(), "Name IN ('Dina Patel', 'Bob Ray')");
      await h.click('Add them all');
      await h.pause(800);
      mkdirSync(files, { recursive: true });
      const [download] = await Promise.all([
        h.page.waitForEvent('download', { timeout: 300000 }),
        h.click('Save the workbook'),
      ]);
      const workbook = join(files, 'before-refresh-3.0.xlsx');
      await download.saveAs(workbook);
      await h.until('Saved:');
      await h.say('After, in the refreshed sandbox: what differs, ready to put back');
      await h.select(
        h.page.locator('header select').first(),
        await h.page.locator('header select option', { hasText: 'acme-dev' }).first().getAttribute('value')
      );
      await h.settle();
      await h.press(h.page.locator('button.tab', { hasText: /After the refresh/ }));
      await h.page.locator('label.file-button input').first().setInputFiles(workbook);
      await h.until(/to put back|Nothing left/, 240000);
      await h.settle();
      await h.page.mouse.wheel(0, 600);
      await h.pause(2200);
      await h.select(
        h.page.locator('header select').first(),
        await h.page.locator('header select option', { hasText: 'acme-uat' }).first().getAttribute('value')
      );
      await h.settle();

      // Compare & Deploy
      await card(h, 'Compare & Deploy', 'Two orgs · your project · two branches · a package.xml');
      await h.tab('Compare & Deploy', 'Branch ↔ Branch');
      await h.say('Two branches, like a pull request — as package.xml and destructiveChanges.xml');
      await h.click('Open the project folder…');
      await h.until('Source — the branch with the changes');
      await h.choose(h.page.locator('.compare-refs select').first(), /feature\/vip-discount/);
      await h.choose(h.page.locator('.compare-refs select').nth(1), /^main$/);
      await h.click('Compare');
      await h.until('In the manifest:');
      await h.settle();
      await h.say('Added, changed, deleted — then validate and deploy, after typing the org name');
      await h.page.mouse.wheel(0, 500);
      await h.pause(2200);

      await card(h, 'NomadSF 3.0 — free', 'Chrome · Edge · VS Code · a video guide for every tool', 3600);
    },
  },
];
