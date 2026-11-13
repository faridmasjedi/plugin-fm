# Guide recordings

The videos of the guide (`docs/media/*.mp4`, their `.jpg` posters and the README GIFs) are recorded
from the real Studio against two **made-up demo orgs**, so no real data reaches the public site.

## The demo orgs

Two scratch orgs from a Dev Hub, filled with invented data (Acme Corp, Globex, Hooli…; Ann Lee, Bob Ray…):

```sh
cd nomadsf/tools/demo
sf org create scratch -f scratch-def.json   -a nomadsf-demo   -v <dev hub> --duration-days 30
sf org create scratch -f scratch-def-b.json -a nomadsf-demo-b -v <dev hub> --duration-days 30
(cd project && sf project deploy start -o nomadsf-demo)        # fields, rule, classes, trigger, permission sets, group, queue
sf org assign permset -n Demo_Admin -o nomadsf-demo
sf apex run -o nomadsf-demo -f seed.apex                       # accounts, contacts, cases, opportunities
sed "s/DOMAIN/acme-$RANDOM.example.com/" users.apex > /tmp/u.apex && sf apex run -o nomadsf-demo -f /tmp/u.apex
sf apex run -o nomadsf-demo -f seed-more.apex                  # more accounts, contacts, cases, opportunities; invoices
sf apex run -o nomadsf-demo -f seed-access.apex                # the newer permission sets and groups for the users
sf apex run -o nomadsf-demo -f seed-groups.apex                # roles Support Manager › Support Lead for Dina, Chen, Bob
sf apex run -o nomadsf-demo -f seed-groups-members.apex        # a group and roles inside Support Team and Tier 1 Support
sf project deploy start -o nomadsf-demo --metadata-dir sharing-1-private  # Invoices private (starts a sharing recalculation)
sf project deploy start -o nomadsf-demo --metadata-dir sharing-2-rules    # after it: two sharing rules on Invoices
sf apex run -o nomadsf-demo -f seed-sharing-owners.apex        # Bob owns a few invoices (Access › Who can see, Security › Sharing)
sf apex run -o nomadsf-demo -f seed-northwind.apex             # an account no other org has (Record › Related copies it)
```

The project also holds a remote site (`Billing_API`), a custom setting (`Integration_Settings__c`, seeded by
`seed-integration.apex`), a custom permission (`Approve_Discounts`, in `Sales_Ops`) and the `Invoice_Reminder` flow.
For Develop › Flows, deploy the flow three times to acme-uat (v1 obsolete, v2 active at API 49, v3 a draft) so there
are old versions and an old API version to show.

The project holds an Invoice object, classes with their tests (a trigger, a batch, a selector, an LWC
controller), LWCs, an Aura component, a Visualforce page and component, nine permission sets, three
permission set groups and two custom profiles.

`nomadsf-demo-b` (shown as **acme-dev**) gets the same with a few differences for Org compare to find:
no `Finance_Read` or `Report_Builder` permission set, no `Customer_Number__c` field, no `acmeWelcome`
Aura component, a `Finance_Team` group with only `Invoice_Manager`, and an older `AccountService`
(deploy without those, seed with `seed-b.apex`, users with the same domain plus `.dev`). Rename each
org's admin to Alex Morgan.

### In one go, with a big test set

`setup-demo-org.sh <alias> <a|b> <dev hub> <user domain> [size]` does all of the above for one org (b: acme-dev
with its differences), then deploys the bulk test set of `make-bulk.mjs` and seeds its records (`seed-bulk.apex`).
With `SHARING_DIR` pointing at the sharing seed it also makes Invoices private with two rules.

`node make-bulk.mjs <project> --size small|medium|big --variant a|b` writes `force-app/main/bulk`: permission sets
and groups, Apex services with tests, objects with fields, labels, custom permissions and LWCs. Variant b changes
about a tenth, removes some and adds some, so every compare has same, different and only on one side. An org holds
at most 1,000 permission sets, so medium (900) fits and big (4,000) is for projects only.

## The demo repository

`node tools/demo/make-repo.mjs` makes `.recordings/acme-project`, a git repository of the project: `main` as
deployed, and `feature/vip-discount` with a changed class, a new class and test, a new field, custom labels and a
deleted validation rule. Start the server with it (`DEMO_PROJECT=$PWD/tools/demo/.recordings/acme-project`); scenes
with `folder: true` open it as the project folder (Compare & package reads its git history).

`manifest/package.xml` names a few components of `feature/vip-discount` for the Check a manifest scene.

A third, empty org stands in for a freshly refreshed sandbox: `DEMO_NEW=<alias> node tools/demo/server.mjs` adds it
as **acme-new** (Sandbox refresh › After, Copy records).

## Recording

```sh
cd nomadsf
yarn build                                   # the Studio the recordings show
node tools/demo/server.mjs                   # the Studio on http://localhost:7171 with the demo orgs
node tools/demo/record.mjs                   # every scene; or name some: record.mjs query related
```

`DEMO_REPO` and `DEMO_BACKUPS` set the folders the fake folder picker offers (the project, and where Backup writes);
a `DEMO_BACKUPS` folder is kept, not emptied. `DEMO_MEDIA` writes the videos elsewhere, `DEMO_SCENES` adds a scenes
file. Every scene has subtitles: `intro` (the tool, and what it is for) and `h.say(text)` before a step; a clicked
element near an edge is scrolled to the middle first. `hub-*` scenes walk each hub tab by tab; `init` runs in the page
before it loads (Settings › AI sets `__nomadsfDemoAiForm` to show the extension's AI form). A failed scene keeps the old video and leaves `.recordings/failed-<scene>.png`.

Needs ffmpeg (`brew install ffmpeg`) and Playwright's own (`npx playwright install ffmpeg`); Chrome is
the browser. Each scene in `scenes.mjs` opens a fresh Studio and uses it like a person: a visible
cursor, typing, and NomadSF's own confirmations (writes go to the demo orgs only).

Each recording is also a test: a scene fails (and keeps the old video) when a step does not find what it
waits for, when the page throws an error, or when the Log shows a problem the scene did not set out to show.
The ✦ AI of a scene (`ai: { task: answer }`) is answered by the recorder — no AI provider is called — and goes
through the Studio's own reading of the answer. To try the real prompts instead, put `FM_AI_PROVIDER`,
`FM_AI_MODEL` and `FM_AI_KEY` in `~/.nomadsf-demo-ai.env` (chmod 600): the server then answers the ✦ buttons
with that provider, and `DEMO_REAL_AI=1 node tools/demo/record.mjs …` uses it.

### Apps and credentials (demo)

`configs/uat`, `configs/new`: a `Billing` named credential and its `Billing_Auth` external credential (the URL differs).
`configs/eca-uat`, `configs/eca-new`: an external client app `NomadSF_Demo` with its OAuth settings (the scopes
differ). Deploy each with `sf project deploy start --metadata-dir <folder> -o <org>`. New orgs refuse new connected apps
("contact Salesforce Customer Support"): `configs/connected-app-*` is kept for orgs that still allow them.
