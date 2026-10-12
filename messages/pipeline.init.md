# summary

Create a starter pipeline file (.fm/pipeline.yml) and example deployment scripts.

# description

Writes .fm/pipeline.yml with a typical release flow (build delta, code quality, validation, approval, pre-deploy Apex, quick deploy with a deployment tag, post-deploy script, failure notification), example scripts in .fm/scripts, and adds .fm/runs/ to .gitignore. Edit the file to fit your process; every stage is optional.

# examples

- Create a pipeline for the 'uat' org and the 'main' branch:

  <%= config.bin %> <%= command.id %> --target-org uat --base-branch main

- Create a release train with Data Cloud, core and OmniStudio waves:

  <%= config.bin %> <%= command.id %> --train --target-org uat

# flags.targetOrg.summary

Org alias used in the generated stages.

# flags.baseBranch.summary

Branch whose deployments are tagged and used as the diff baseline.

# flags.train.summary

Create a release train instead: Data Cloud, core and OmniStudio waves deployed across pull request and push.

# flags.train.description

Writes a pipeline that builds with --waves and .fm/waves.yml. On a pull request it validates and deploys the Data Cloud wave (with an optional approval) and validates the core wave as the PR check. On push it deploys the core wave, then validates and deploys the OmniStudio wave (with an optional approval), and tags the commit. Set FM_REQUIRE_APPROVAL=true to turn the approvals on.

# flags.force.summary

Overwrite existing files.

# info.nextSteps

Next: review .fm/pipeline.yml, then run 'sf fm pipeline run' and watch it with 'sf fm dashboard'.
