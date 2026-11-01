# Guide recordings

The videos of the guide (`docs/media/*.mp4`, their `.jpg` posters and the README GIFs) are recorded
from the real Studio against two **made-up demo orgs**, so no real data reaches the public site.

## The demo orgs

Two scratch orgs from a Dev Hub, filled with invented data (Acme Corp, Globex, Hooli…; Ann Lee, Bob Ray…):

```sh
cd nomadsf/tools/demo
sf org create scratch -f scratch-def.json   -a nomadsf-demo   -v <dev hub> -d 30
sf org create scratch -f scratch-def-b.json -a nomadsf-demo-b -v <dev hub> -d 30
(cd project && sf project deploy start -o nomadsf-demo)        # fields, rule, classes, trigger, permission sets, group, queue
sf org assign permset -n Demo_Admin -o nomadsf-demo
sf apex run -o nomadsf-demo -f seed.apex                       # accounts, contacts, cases, opportunities
sed "s/DOMAIN/acme-$RANDOM.example.com/" users.apex > /tmp/u.apex && sf apex run -o nomadsf-demo -f /tmp/u.apex
sf apex run -o nomadsf-demo -f seed-more.apex                  # more accounts, contacts, cases, opportunities; invoices
sf apex run -o nomadsf-demo -f seed-access.apex                # the newer permission sets and groups for the users
```

The project holds an Invoice object, classes with their tests (a trigger, a batch, a selector, an LWC
controller), LWCs, an Aura component, a Visualforce page and component, nine permission sets, three
permission set groups and two custom profiles.

`nomadsf-demo-b` (shown as **acme-dev**) gets the same with a few differences for Org compare to find:
no `Finance_Read` or `Report_Builder` permission set, no `Customer_Number__c` field, no `acmeWelcome`
Aura component, a `Finance_Team` group with only `Invoice_Manager`, and an older `AccountService`
(deploy without those, seed with `seed-b.apex`, users with the same domain plus `.dev`). Rename each
org's admin to Alex Morgan.

## The demo repository

`node tools/demo/make-repo.mjs` makes `.recordings/acme-project`, a git repository of the project: `main` as
deployed, and `feature/vip-discount` with a changed class, a new class and test, a new field, custom labels and a
deleted validation rule. Start the server with it (`DEMO_PROJECT=$PWD/tools/demo/.recordings/acme-project`); scenes
with `folder: true` open it as the project folder (Compare & package reads its git history).

## Recording

```sh
cd nomadsf
yarn build                                   # the Studio the recordings show
node tools/demo/server.mjs                   # the Studio on http://localhost:7171 with the demo orgs
node tools/demo/record.mjs                   # every scene; or name some: record.mjs query related
```

Needs ffmpeg (`brew install ffmpeg`) and Playwright's own (`npx playwright install ffmpeg`); Chrome is
the browser. Each scene in `scenes.mjs` opens a fresh Studio and uses it like a person: a visible
cursor, typing, and NomadSF's own confirmations (writes go to the demo orgs only).

Each recording is also a test: a scene fails (and keeps the old video) when a step does not find what it
waits for, when the page throws an error, or when the Log shows a problem the scene did not set out to show.
The ✦ AI of a scene (`ai: { task: answer }`) is answered by the recorder — no AI provider is called — and goes
through the Studio's own reading of the answer. To try the real prompts instead, put `FM_AI_PROVIDER`,
`FM_AI_MODEL` and `FM_AI_KEY` in `~/.nomadsf-demo-ai.env` (chmod 600): the server then answers the ✦ buttons
with that provider, and `DEMO_REAL_AI=1 node tools/demo/record.mjs …` uses it.
