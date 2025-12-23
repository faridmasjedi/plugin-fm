# summary

Check the status of a deployment or validation job.

# description

Monitor the progress of a deployment or validation job with real-time updates. Perfect for CI/CD pipelines and async deployments. Can poll at regular intervals and display formatted progress reports.

# examples

- Check deployment status once:
  <%= config.bin %> <%= command.id %> --job-id 0Af... --target-org myorg

- Watch deployment status until completion:
  <%= config.bin %> <%= command.id %> --job-id 0Af... --target-org myorg --watch

- Check status with custom polling interval:
  <%= config.bin %> <%= command.id %> --job-id 0Af... --target-org myorg --watch --interval 15

- Get status in JSON format for CI/CD:
  <%= config.bin %> <%= command.id %> --job-id 0Af... --target-org myorg --json

# flags.jobId.summary

Deployment or validation job ID.

# flags.jobId.description

The Salesforce deployment job ID (starts with 0Af) to check status for. This is returned by the 'sf fm deploy' command.

# flags.targetOrg.summary

Target org where the deployment is running.

# flags.targetOrg.description

Specify the username or alias of the target Salesforce org.

# flags.watch.summary

Continuously watch deployment until completion.

# flags.watch.description

Poll the deployment status at regular intervals until the deployment completes (success or failure). Updates are shown in real-time.

# flags.interval.summary

Polling interval in seconds.

# flags.interval.description

How often to check deployment status when using --watch. Defaults to 15 seconds. Minimum 5 seconds to avoid API limits.

# flags.timeout.summary

Maximum minutes to watch before timing out.

# flags.timeout.description

Maximum time in minutes to watch the deployment. Defaults to 60 minutes. After timeout, the command exits even if deployment is still running.

# info.checkingStatus

Checking deployment status...

# info.deploymentComplete

Deployment completed: %s

# info.pollingStatus

Polling deployment status every %s seconds...

# info.watchingDeployment

Watching deployment %s...

# info.deploymentProgress

Progress: %s%% | Components: %s/%s | Tests: %s/%s passed

# info.timeElapsed

Time elapsed: %s

# info.eta

Estimated completion: %s

# error.jobIdRequired

Job ID is required. Use --job-id flag.

# error.jobNotFound

Deployment job not found: %s

# error.timeout

Deployment monitoring timed out after %s minutes.

# error.targetOrgRequired

Target org is required. Use --target-org flag.
