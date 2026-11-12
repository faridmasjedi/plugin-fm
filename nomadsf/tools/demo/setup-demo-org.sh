#!/usr/bin/env bash
# One demo scratch org from start to end (the steps of README.md), plus the bulk test set (make-bulk.mjs).
#   tools/demo/setup-demo-org.sh <alias> <a|b> <dev hub> <user domain> [bulk size]
# a = acme-uat (the full project, bulk variant a); b = acme-dev (the project with its differences, bulk variant b).
# The sharing seed (Invoices private + two rules) runs when SHARING_DIR holds sharing-1-private and sharing-2-rules.
set -euo pipefail
alias=$1 variant=$2 hub=$3 domain=$4 size=${5:-medium}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
step() { printf '\n== %s: %s\n' "$alias" "$*"; }
apex() { sf apex run -o "$alias" -f "$1" | grep -E 'USER_DEBUG|Error|error|Executed' | grep -v '^$' || true; }

def=$here/scratch-def.json
[ "$variant" = b ] && def=$here/scratch-def-b.json && domain="$domain.dev"

if sf org display -o "$alias" >/dev/null 2>&1; then
  step "the scratch org is there already: going on"
else
  step "create the scratch org (30 days)"
  sf org create scratch -f "$def" -a "$alias" -v "$hub" --duration-days 30 -w 20 >/dev/null
fi

step "deploy the demo project"
cp -R "$here/project" "$work/project"
# Queue members are users of another org: users.apex adds them once the users exist
perl -0pi -e 's#\s*<users>.*?</users>##sg' "$work"/project/force-app/main/default/queues/*.queue-meta.xml
if [ "$variant" = b ]; then
  d=$work/project/force-app/main/default
  rm -f "$d"/permissionsets/Finance_Read.* "$d"/permissionsets/Report_Builder.*
  rm -f "$d"/objects/Account/fields/Customer_Number__c.*
  rm -rf "$d"/aura/acmeWelcome
  # Nothing may point at the field that is not there
  perl -0pi -e 's#\s*<fieldPermissions>(?:(?!</fieldPermissions>).)*?Customer_Number__c.*?</fieldPermissions>##sg' \
    "$d"/permissionsets/*.permissionset-meta.xml "$d"/profiles/*.profile-meta.xml
  perl -0pi -e 's#\s*<permissionSets>(Finance_Read|Report_Builder)</permissionSets>##g' \
    "$d"/permissionsetgroups/*.permissionsetgroup-meta.xml
  # An older AccountService: Gold from 20M (later raised to 10M)
  perl -pi -e 's/10000000/20000000/' "$d"/classes/AccountService.cls
  # Its own billing system (Sandbox refresh compares remote sites and settings)
  perl -pi -e 's/billing-uat/billing-dev/' "$d"/remoteSiteSettings/Billing_API.remoteSite-meta.xml
fi
deploy() { # the errors only, when it fails
  sf project deploy start -o "$alias" -w 60 --json "$@" > "$work/deploy.json" 2>/dev/null || {
    node -e 'const r=require(process.argv[1]).result??{};const f=[].concat(r.details?.componentFailures??[]);console.log("deploy failed:",f.slice(0,10).map(x=>`${x.componentType} ${x.fullName}: ${x.problem}`).join("\n")||JSON.stringify(r).slice(0,400))' "$work/deploy.json"
    exit 1
  }
}
(cd "$work/project" && deploy)
sf org assign permset -n Demo_Admin -o "$alias" >/dev/null

step "the admin is Alex Morgan"
printf "User u = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];\nu.FirstName = 'Alex'; u.LastName = 'Morgan';\nupdate u;\n" > "$work/admin.apex"
apex "$work/admin.apex"

step "records and users"
if [ "$variant" = b ]; then apex "$here/seed-b.apex"; else apex "$here/seed.apex"; fi
sed "s/DOMAIN/$domain/" "$here/users.apex" > "$work/users.apex"
apex "$work/users.apex"
for f in seed-more seed-access seed-groups seed-groups-members seed-jobs; do apex "$here/$f.apex"; done
billing=billing-uat; [ "$variant" = b ] && billing=billing-dev
sed "s#ENDPOINT#https://$billing.example.com/v2#" "$here/seed-integration.apex" > "$work/integration.apex"
apex "$work/integration.apex"

if [ -n "${SHARING_DIR:-}" ] && [ -d "$SHARING_DIR/sharing-1-private" ]; then
  step "sharing: Invoices private, then two rules"
  sf project deploy start -o "$alias" --metadata-dir "$SHARING_DIR/sharing-1-private" -w 20 >/dev/null
  # Changing the default starts a recalculation: the rules wait for it
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if sf project deploy start -o "$alias" --metadata-dir "$SHARING_DIR/sharing-2-rules" -w 20 >/dev/null 2>&1; then break; fi
    sleep 30
  done
  apex "$SHARING_DIR/seed-sharing-owners.apex"
fi

step "bulk test set ($size, variant $variant)"
mkdir -p "$work/bulk"
printf '{ "packageDirectories": [{ "path": "force-app", "default": true }], "sourceApiVersion": "62.0" }\n' > "$work/bulk/sfdx-project.json"
node "$here/make-bulk.mjs" "$work/bulk" --size "$size" --variant "$variant" >/dev/null
(cd "$work/bulk" && deploy --source-dir force-app)
# Anonymous Apex runs with the admin's own field access: Bulk_Admin gives it for the bulk objects
sf org assign permset -n Bulk_Admin -o "$alias" >/dev/null
objects=$(ls "$work/bulk/force-app/main/bulk/objects" | wc -l | tr -d ' ')
sed -e "s/PER_OBJECT/100/" -e "s/OBJECTS/$objects/" "$here/seed-bulk.apex" > "$work/bulk.apex"
apex "$work/bulk.apex"

step "done"
sf org display -o "$alias" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;console.log(r.instanceUrl, "expires", r.expirationDate)})'
