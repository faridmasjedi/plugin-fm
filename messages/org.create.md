# summary

Create a ready-to-work scratch org or sandbox: create, deploy, permission sets, data, setup Apex.

# description

Runs the usual setup as one command, step by step with the Salesforce CLI, and stops at the first failure. Scratch orgs: created from the definition file, then the project is deployed. Sandboxes: created from the production org given with --target-org (or cloned from another sandbox); the project is not deployed unless you deploy it later. Then permission sets are assigned, data plans imported ('sf data import tree') and Apex scripts run, in that order. --dry-run prints the commands without running them.

# examples

- Scratch org with the project, a permission set, sample data and a setup script:

  <%= config.bin %> <%= command.id %> --alias feature-x --permset App_User --data-plan data/plan.json --apex-script scripts/apex/setup.apex --open

- Developer sandbox from production, shown first:

  <%= config.bin %> <%= command.id %> --type sandbox --alias uat2 --sandbox-name uat2 --target-org prod --dry-run

# flags.type.summary

scratch (default) or sandbox.

# flags.alias.summary

Alias of the new org.

# flags.definitionFile.summary

Scratch org definition file (default: config/project-scratch-def.json).

# flags.durationDays.summary

Days the scratch org lives (1–30).

# flags.targetDevHub.summary

Dev Hub for the scratch org (default: your default Dev Hub).

# flags.targetOrg.summary

Production org to create the sandbox from.

# flags.sandboxName.summary

Sandbox name (letters and digits, max 10; default: from the alias).

# flags.licenseType.summary

Sandbox license (default Developer).

# flags.sourceSandbox.summary

Clone this sandbox instead of creating from production.

# flags.noDeploy.summary

Do not deploy the project to the new scratch org.

# flags.permset.summary

Permission set to assign (repeatable).

# flags.dataPlan.summary

Data plan to import with 'sf data import tree' (repeatable).

# flags.apexScript.summary

Anonymous Apex file to run after setup (repeatable).

# flags.setDefault.summary

Make the new org your default org.

# flags.open.summary

Open the org in the browser at the end.

# flags.dryRun.summary

Print the steps and commands without running them.
