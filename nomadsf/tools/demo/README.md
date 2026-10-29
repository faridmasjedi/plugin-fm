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
```

`nomadsf-demo-b` (shown as **acme-dev**) gets the same with a few differences for Org compare to find:
no `Finance_Read` permission set, no `Customer_Number__c` field and an older `AccountService`
(deploy without those, seed with `seed-b.apex`, users with the same domain plus `.dev`). Rename each
org's admin to Alex Morgan.

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
