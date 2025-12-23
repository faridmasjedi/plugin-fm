# summary

Cancel a running deployment or validation job.

# description

Cancel a deployment or validation job that is currently in progress. This is useful in CI/CD workflows when a new commit is pushed to a PR and you want to cancel the previous validation job.

The command can read the job ID from a file (e.g., artifact from previous CI/CD step) or from a flag. If the job is already completed or not found, the command can optionally skip the cancellation without failing.

# examples

- Cancel a deployment using job ID:

  <%= config.bin %> <%= command.id %> --job-id 0Af5e000004zXXX --target-org myorg

- Cancel using job ID from artifact file:

  <%= config.bin %> <%= command.id %> --job-id-file ./artifacts/job-id.txt --target-org myorg

- Cancel with skip if not found (safe for CI/CD):

  <%= config.bin %> <%= command.id %> --job-id-file ./artifacts/job-id.txt --target-org myorg --skip-if-not-found

- Cancel previous PR validation (CI/CD workflow):

  <%= config.bin %> <%= command.id %> --job-id-file ./pr-job-id.txt --target-org prod --skip-if-not-found

# flags.jobId.summary

Deployment or validation job ID to cancel.

# flags.jobId.description

The Salesforce deployment job ID (starts with 0Af) to cancel. This is returned by the 'sf fm deploy' command with --async flag.

# flags.jobIdFile.summary

Path to file containing the job ID.

# flags.jobIdFile.description

Path to a file containing the job ID to cancel. This is useful in CI/CD workflows where the job ID is saved as an artifact. The file should contain only the job ID (e.g., "0Af5e000004zXXX").

# flags.targetOrg.summary

Target org where the deployment is running.

# flags.targetOrg.description

Username or alias of the target org where the deployment is running. The org must be authenticated.

# flags.skipIfNotFound.summary

Skip cancellation if job ID file not found or job doesn't exist.

# flags.skipIfNotFound.description

When enabled, the command will not fail if the job ID file doesn't exist or the job is not found. This is useful in CI/CD workflows where there might not be a previous job to cancel (e.g., first commit in a PR).

# info.cancelingJob

Canceling deployment job: %s

# info.executingCancel

Executing cancel command...

# info.cancelSuccess

Successfully canceled job: %s

# info.alreadyCompleted

Job %s is already completed with status: %s. Skipping cancel.

# info.jobNotFound

Job %s not found. Skipping cancel.

# info.noJobId

No job ID provided. Skipping cancel.

# info.jobIdFileNotFound

Job ID file not found: %s. Skipping cancel.

# error.noJobId

No job ID provided. Specify --job-id or --job-id-file.

# error.cannotReadJobIdFile

Cannot read job ID file '%s': %s

# error.jobNotFound

Job %s not found: %s

# error.cancelFailed

Failed to cancel job %s: %s
