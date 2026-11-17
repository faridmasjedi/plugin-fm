// The NomadSF 3.2 release video (LinkedIn, landscape, drawn bigger to read on a phone): the new admin tools on the
// demo orgs, with title cards and subtitles. Run with the demo server up (DEMO_NEW for acme-new):
//   DEMO_SCENES=tools/demo/release-3.2.mjs DEMO_SIZE=1920x1080 DEMO_ZOOM=1.6 DEMO_MEDIA=~/Desktop/nomadsf-3.2 \
//     node tools/demo/record.mjs
// Before it: acme-new gets one different sharing rule (sf project deploy start --metadata-dir tools/demo/sharing-diff
// -o nomadsf-new); the video deploys acme-uat's rules back to acme-new. Nothing else is changed.

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
          'background:rgba(15,23,42,.8);transition:opacity .3s;font-family:system-ui,-apple-system,sans-serif';
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

const otherOrg = (h) => h.page.locator('select:visible', { hasText: 'Choose the other org' }).first();

/** A row of the table on screen whose cell is exactly this text (hidden panes keep their tables). */
const visibleRow = (h, text) =>
  h.page.locator('tr:visible', { has: h.page.locator('td', { hasText: new RegExp(`^\\s*${text}\\s*$`) }) }).first();

export const scenes = [
  {
    name: 'nomadsf-3.2',
    hash: 'access',
    run: async (h) => {
      await card(h, 'NomadSF 3.2', 'Who can do what, who sees which records — free, in Chrome, Edge and VS Code', 3200);

      // A user's full access
      await card(h, 'Everything a user can do', 'From their profile, permission sets and groups — in one place');
      await h.type(h.page.locator('input[placeholder="Name, username, email or user Id"]'), 'Dina');
      await h.click('Find');
      await h.until('Dina Patel');
      await h.settle();
      await h.press(h.page.locator('.tabs .tab', { hasText: /^Access$/ }).first());
      await h.waiting(() => h.page.locator('.user-full-access .dt table').first().waitFor({ timeout: 120000 }));
      await h.say('Objects, fields, classes, pages, tabs, record types, layouts — each row says where it comes from');
      await h.look(h.page.locator('.user-full-access .dt tbody tr', { hasText: 'Invoice__c' }).first());
      await h.pause(1800);
      const sub = (t) => h.page.locator('.user-full-access .table-tabs-bar .tab', { hasText: t }).first();
      await h.press(sub('Shared records'));
      await h.waiting(() => h.page.locator('.shared-records .dt table').waitFor({ timeout: 300000 }));
      await h.say('Shared records: what they own, and what is shared with them — and why');
      await h.look(h.page.locator('.shared-records .dt').first());
      await h.pause(1800);

      // Tables
      await card(h, 'Every table, more powerful', 'Is empty · Filter logic like a list view · Choose your columns');
      await h.tab('Data', 'Query');
      await h.code('SELECT Name, Industry, Phone, Website, Customer_Tier__c FROM Account ORDER BY Name');
      await h.page.keyboard.press('Escape');
      await h.click('Run');
      await h.waiting(() => h.page.locator('.dt:visible .dt-count').first().waitFor({ timeout: 120000 }));
      await h.settle();
      await h.look(h.page.locator('.dt:visible').first());
      const cond = (i) => h.page.locator('.dt-condition:visible').nth(i);
      await h.press(h.page.locator('.dt-filters-toggle:visible', { hasText: 'Filters' }).first());
      await h.choose(cond(0).locator('select').first(), /^Website$/);
      await h.choose(cond(0).locator('select.dt-condition-op'), 'Is not empty');
      await h.say('Hide blank values — then combine filters: 1 AND (2 OR 3)');
      await h.click('+ Add a filter');
      await h.choose(cond(1).locator('select').first(), /^Customer_Tier__c$/);
      await h.type(cond(1).locator('input').first(), '=Gold');
      await h.click('+ Add a filter');
      await h.choose(cond(2).locator('select').first(), /^Industry$/);
      await h.type(cond(2).locator('input').first(), 'Technology');
      await h.type(h.page.locator('.dt-logic input:visible'), '1 AND (2 OR 3)');
      await h.pause(1600);
      await h.say('Columns: only what you need — exports follow');
      await h.press(h.page.locator('.dt-filters-toggle:visible', { hasText: 'Columns' }).first());
      await h.press(h.page.locator('.dt-column-pick:visible', { hasText: 'Phone' }).locator('input'));
      await h.pause(1600);

      // Sharing
      await card(h, 'Sharing, for the whole org', 'Every object’s defaults and rules — and two orgs compared');
      await h.tab('Access', 'Sharing');
      await h.press(h.page.locator('.view-switch button:visible', { hasText: 'All objects' }));
      await h.waiting(() => h.page.locator('.dt table:visible').first().waitFor({ timeout: 120000 }));
      await h.say('All objects: defaults, and how many sharing rules each has');
      await h.pause(1400);
      await h.press(visibleRow(h, 'Invoice__c'));
      await h.waiting(() => h.page.locator('.sharing-tree:visible').first().waitFor({ timeout: 120000 }));
      await h.settle();
      await h.say('Click one: its rules as a tree, down to the people');
      await h.pause(1800);
      await h.tab('Compare & Deploy', 'Compare sharing');
      await h.choose(otherOrg(h), /acme-new/);
      await h.waiting(() => h.page.locator('.sharing-compare-table table').first().waitFor({ timeout: 300000 }));
      await h.press(visibleRow(h, 'Invoice__c'));
      await h.say('Two orgs, rule by rule — and A’s rules deployed to B after typing B’s name');
      await h.look(h.page.locator('.sharing-compare-detail .dt').first());
      await h.pause(1600);
      await h.click(/rules to B/);
      await h.confirm('acme-new');
      await h.until(/✓ Deployed|❌/, 300000);
      await h.settle();
      await h.pause(1600);

      await card(h, 'NomadSF 3.2 — free', 'Chrome · Edge · VS Code · a video guide for every tool', 3600);
    },
  },
];
