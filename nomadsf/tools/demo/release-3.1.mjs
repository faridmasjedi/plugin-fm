// The NomadSF 3.1 release video (LinkedIn, landscape, drawn bigger to read on a phone): the new admin tools on the
// demo orgs, with title cards and subtitles. Run with the demo server up (DEMO_NEW for acme-new):
//   DEMO_SCENES=tools/demo/release-3.1.mjs DEMO_SIZE=1920x1080 DEMO_ZOOM=1.6 DEMO_MEDIA=~/Desktop/nomadsf-3.1 \
//     node tools/demo/record.mjs
// Read only: nothing is deployed, added or removed (Assign in bulk only picks, it does not add).

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

export const scenes = [
  {
    name: 'nomadsf-3.1',
    hash: 'apps',
    run: async (h) => {
      await card(h, 'NomadSF 3.1', 'New admin tools — free, in Chrome, Edge and VS Code', 3200);

      // Apps & credentials
      await card(h, 'Apps & credentials', 'Every app and credential: who uses it, and every setting');
      await h.press(h.page.locator('nav.side .nav-width'));
      await h.until('this org', 120000);
      await h.settle();
      await h.say('One list: apps defined in this org, and apps from elsewhere (Salesforce CLI)');
      await h.press(h.row('NomadSF Demo'));
      await h.press(h.page.locator('.app-detail button', { hasText: /^Settings/ }).first());
      await h.until('The app');
      await h.click('Edit settings');
      await h.say('Change any setting in place, then deploy — it asks for the org’s name');
      await h.look(h.page.locator('.config-table tr', { hasText: 'permittedUsersPolicyType' }).first());
      await h.pause(1200);
      await h.click('Cancel');

      // Compare
      await h.tab('Compare & Deploy', 'Compare apps');
      await h.press(h.page.locator('.view-switch button', { hasText: 'Credentials' }));
      await h.say('Compare credentials in two orgs — and deploy one across');
      await h.choose(otherOrg(h), /acme-new/);
      await h.waiting(() => h.page.locator('.card table:visible').first().waitFor({ timeout: 300000 }));
      await h.press(h.page.locator('.card table:visible').first().locator('tbody tr', { hasText: 'Named credential' }));
      await h.look(h.page.locator('.config-diff:visible').first());
      await h.pause(1600);

      // Integration check
      await card(h, 'Why does an integration fail?', 'Its user, logins, connected app and certificates — checked');
      await h.tab('Security', 'Integration check');
      await h.type(h.page.locator('input[placeholder^="Integration user"]'), 'Integration User');
      await h.pause(1500);
      await h.choose(h.page.locator('.who-pick select, .who-pick .search-select-native').first(), /^Integration User/);
      await h.choose(
        h.page.locator('.pane-body label', { hasText: 'Connected app' }).locator('select'),
        /CPQ Integration/
      );
      await h.click('Check');
      await h.until(/problem|Nothing/, 60000);
      await h.settle();
      await h.say('Each problem says what to do: here, the user is not approved for the app');
      await h.look(h.page.locator('.finding.bad:visible').first());
      await h.pause(1600);

      // Who can see and Assign in bulk
      await card(h, 'Access', 'Who can see anything — and access for many users at once');
      await h.tab('Access', 'Who can see');
      await h.type(h.page.locator('input[placeholder^="User"]'), 'Dina Patel');
      await h.pause(1500);
      await h.choose(h.page.locator('.who-pick select, .who-pick .search-select-native').first(), /Dina Patel/);
      await h.click('An object');
      await h.type(h.page.locator('input[placeholder^="Object"]').first(), 'Invoice__c');
      await h.page.keyboard.press('Escape');
      await h.click('Check');
      await h.until(/Modify all/, 60000);
      await h.settle();
      await h.say('A record, an object, a field or a class: what the user can do, and which permission gives it');
      await h.pause(1400);
      await h.tab('Access', 'Assign in bulk');
      await h.press(h.page.locator('.segmented button', { hasText: 'By profile' }));
      await h.type(h.page.locator('input[placeholder^="Profile or part"]:visible'), 'standard platform');
      await h.click('Find');
      await h.until('active user(s) found');
      await h.say('Part of a profile, role or username finds them; then any permission sets, groups and queues');
      await h.type(h.page.locator('input[placeholder^="Find permission sets"]'), 'report');
      await h.press(h.page.locator('.bulk-matches button', { hasText: /Report Builder/ }).first());
      await h.pause(1400);

      // Develop
      await card(h, 'For developers', 'Debug log insights · Code checks · Custom settings');
      await h.tab('Develop', 'Code checks');
      await h.click('Check');
      await h.until(/file\(s\) checked/, 180000);
      await h.settle();
      await h.press(h.page.locator('table:visible tbody tr').first());
      await h.say('Injection, XSS, secrets, sharing, access checks, loops — with the line and the fix');
      await h.look(h.page.locator('.check-detail:visible'));
      await h.pause(1600);
      await h.tab('Develop', 'Custom settings');
      await h.choose(
        h.page.locator('.pane-body label', { hasText: 'Custom setting' }).locator('select'),
        /Integration_Settings__c/
      );
      await h.until('Organization');
      await h.settle();
      await h.say('Custom settings: values by org, profile or user — edit, add, delete, or a new one');
      await h.pause(1600);

      await card(h, 'NomadSF 3.1 — free', 'Chrome · Edge · VS Code · a video guide for every tool', 3600);
    },
  },
];
