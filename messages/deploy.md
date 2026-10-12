# summary

Deploy or validate Salesforce metadata with intelligent test selection and progress tracking.

# description

This command deploys or validates Salesforce metadata to target orgs with comprehensive options for test execution, destructive changes, and progress monitoring. It supports validation-only mode, full deployment, and quick deployment from a previous validation.

# examples

- Validate changes without deploying:
  <%= config.bin %> <%= command.id %> --manifest ./manifest --target-org myorg --mode validation

- Deploy with intelligent test selection:
  <%= config.bin %> <%= command.id %> --manifest ./manifest --target-org myorg --mode deployment --intelligent-tests

- Deploy with specific tests:
  <%= config.bin %> <%= command.id %> --manifest ./manifest --target-org myorg --test-level RunSpecifiedTests --tests AccountTest,ContactTest

- Quick deploy from validation:
  <%= config.bin %> <%= command.id %> --mode quick --validation-id 0Af... --target-org myorg

- Deploy with pre-destructive changes:
  <%= config.bin %> <%= command.id %> --manifest ./manifest --target-org myorg --destructive pre

- Async deployment with progress monitoring:
  <%= config.bin %> <%= command.id %> --manifest ./manifest --target-org myorg --async --progress

# flags.manifest.summary

Path to the manifest directory containing package.xml and changed files.

# flags.manifest.description

Specify the directory containing your deployment artifacts (typically the output from 'sf fm build'). This should include package.xml, destructiveChanges.xml, and the changed files.

# flags.targetOrg.summary

Target org for deployment or validation.

# flags.targetOrg.description

Specify the username or alias of the target Salesforce org.

# flags.mode.summary

Deployment mode: validation, deployment, or quick.

# flags.mode.description

- validation: Validate without deploying (default)
- deployment: Full deployment to target org
- quick: Quick deploy from a previous validation (requires --validation-id)

# flags.testLevel.summary

Test execution level for deployment.

# flags.testLevel.description

- NoTestRun: No tests (sandbox only)
- RunSpecifiedTests: Run specific tests (requires --tests)
- RunLocalTests: Run all local tests (production default)
- RunAllTestsInOrg: Run all tests including managed packages

# flags.tests.summary

Comma-separated list of Apex test classes to run.

# flags.tests.description

Specify test class names to run. Required when test-level is RunSpecifiedTests. Example: --tests "AccountTest,ContactTest,OpportunityTest"

# flags.intelligentTests.summary

Automatically detect and run only tests related to changed Apex code.

# flags.intelligentTests.description

Analyzes changed Apex classes and triggers to determine which test classes need to run. This reduces validation time by running only relevant tests.

# flags.destructive.summary

When to run destructive changes: pre, post, or both.

# flags.destructive.description

- pre: Run destructiveChangesPre.xml before deployment
- post: Run destructiveChangesPost.xml after deployment (default if destructiveChanges.xml exists)
- both: Run pre-destructive, then deploy, then post-destructive

# flags.pre.summary

Comma-separated file paths for pre-destructive changes (used with --destructive both).

# flags.pre.description

When using --destructive both, specify which deleted files should be deployed as pre-destructive changes. The remaining deleted files will be deployed as post-destructive changes. Example: --pre "force-app/main/default/classes/OldClass.cls,force-app/main/default/triggers/OldTrigger.trigger"

# flags.validationId.summary

Validation ID for quick deployment.

# flags.validationId.description

The Salesforce validation ID (starts with 0Af) from a previous successful validation. Required for --mode quick.

# flags.preSteps.summary

Script to execute before deployment starts.

# flags.preSteps.description

Path to a shell script that will be executed before the deployment begins. Useful for data backups, environment setup, etc.

# flags.postSteps.summary

Script to execute after deployment completes.

# flags.postSteps.description

Path to a shell script that will be executed after successful deployment. Useful for data migration, cache clearing, etc.

# flags.wait.summary

Minutes to wait for deployment to complete.

# flags.wait.description

Maximum time in minutes to wait for deployment completion. Defaults to 33 minutes. Use 0 for no wait (async mode).

# flags.async.summary

Start deployment and return immediately without waiting.

# flags.async.description

When enabled, the command returns the deployment ID immediately and exits. Use 'sf fm deploy status' to check progress later.

# flags.progress.summary

Show real-time deployment progress.

# flags.progress.description

Display a live progress bar with deployment status, component counts, and test results. Updates every few seconds.

# flags.checkOnly.summary

Alias for --mode validation.

# flags.checkOnly.description

Validate the deployment without actually deploying. Same as --mode validation.

# flags.ignoreWarnings.summary

Ignore deployment warnings and proceed.

# flags.ignoreWarnings.description

When enabled, deployment warnings will not cause the deployment to fail.

# flags.ignoreConflicts.summary

Ignore conflicts and deploy anyway.

# flags.ignoreConflicts.description

When enabled, conflicts between local metadata and org metadata will be ignored. Use with caution as this can overwrite changes made directly in the org.

# flags.tagOnSuccess.summary

Branch name to tag after a successful deployment (creates sf-deploy-success/<branch>/<timestamp>).

# flags.tagOnSuccess.description

After a successful deployment or quick deploy, creates an annotated Git tag on the deployed commit. The next 'sf fm build --from-last-successful-deployment --base-branch <branch>' uses this tag as its starting point, so each release only contains what changed since the last successful deployment. Validations and still-running async deployments are never tagged.

# flags.tagCommit.summary

Commit to tag after a successful deployment (default: HEAD).

# flags.pushTag.summary

Push the deployment tag to the 'origin' remote.

# info.startingDeployment

Starting %s to %s...

# info.analyzingTests

Analyzing changed Apex code to determine test classes...

# info.foundIntelligentTests

Found %s test classes to run based on code changes.

# info.executingPreSteps

Executing pre-deployment steps: %s

# info.executingPostSteps

Executing post-deployment steps: %s

# info.deploymentStarted

Deployment started. Job ID: %s

# info.validationStarted

Validation started. Job ID: %s

# info.quickDeployStarted

Quick deployment started. Job ID: %s

# info.checkingStatus

Checking deployment status...

# info.deploymentInProgress

Deployment in progress (%s%% complete)...

# info.deploymentSucceeded

Deployment succeeded! ✓

# info.validationSucceeded

Validation succeeded! Validation ID: %s

# info.useQuickDeploy

To quick deploy this validation, run: sf fm deploy --mode quick --validation-id %s --target-org %s

# error.manifestNotFound

Manifest directory not found: %s

# error.validationIdRequired

Validation ID is required for quick deployment mode.

# error.testsRequired

Test class names are required when test-level is RunSpecifiedTests.

# error.preStepsNotFound

Pre-deployment script not found: %s

# error.postStepsNotFound

Post-deployment script not found: %s

# error.preStepsFailed

Pre-deployment steps failed with exit code %s

# error.postStepsFailed

Post-deployment steps failed with exit code %s

# error.deploymentFailed

Deployment failed. Check the details above.

# error.noTargetOrg

Target org is required. Use --target-org flag.

# error.destructiveFileNotFound

Destructive mode requires destructiveChanges.xml file in the Destructive directory. Run 'sf fm build' first to generate deployment artifacts.

# error.preFilesRequiredForBoth

When using --destructive both, you must specify which files go to pre-destructive changes using the --pre flag.

# error.preFilesOnlyForBoth

The --pre flag can only be used with --destructive both.

# error.preRequiresDestructiveBoth

The --pre flag requires --destructive both to be set.

# warn.noTestsFound

No test classes specified. Deployment may fail in production.

# warn.noIntelligentTests

Could not determine test classes automatically. Consider using --tests flag.
