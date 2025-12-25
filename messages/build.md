# summary

Build deployment artifacts from Git changes including manifests and changed files.

# description

This command builds complete deployment artifacts by analyzing differences between two Git references (commits, branches, or tags). It generates package.xml and destructiveChanges.xml manifests, copies changed metadata files, and prepares everything needed for Salesforce deployments.

# examples

- Generate a manifest for changes between 'HEAD~1' and 'HEAD':
  <%= config.bin %> <%= command.id %> --ref-a HEAD~1 --ref-b HEAD

- Generate a manifest for changes between 'main' and the current branch:
  <%= config.bin %> <%= command.id %> --ref-a main --ref-b HEAD

- Generate a manifest and place output in 'my-manifest' directory:
  <%= config.bin %> <%= command.id %> --ref-a HEAD~1 --output-dir my-manifest

- Generate a manifest from the last successful deployment on 'main' to HEAD:
  <%= config.bin %> <%= command.id %> --from-last-successful-deployment --base-branch main --ref-b HEAD

# flags.refA.summary

The Git reference for the 'old' state (e.g., commit SHA, branch name, tag).

# flags.refA.description

Specify the Git reference for the older state of your repository. This can be a commit hash, branch name, or tag. If '--from-last-successful-deployment' is used, this flag becomes optional.

# flags.refB.summary

The Git reference for the 'new' state (e.g., commit SHA, branch name, tag).

# flags.refB.description

Specify the Git reference for the newer state of your repository. This can be a commit hash, branch name, or tag. Defaults to 'HEAD' if not specified.

# flags.outputDir.summary

The directory where the generated manifests and changed files will be stored.

# flags.outputDir.description

Specify a custom output directory. If it doesn't exist, it will be created. Defaults to 'manifest'.

# flags.forceignore.summary

Path to a .forceignore file to filter out files from the diff.

# flags.forceignore.description

Specify a custom .forceignore file path. Defaults to '.forceignore' in the current working directory. The file must exist.

# flags.ignore.summary

Ignore patterns (comma-separated)

# flags.ignore.description

Comma-separated list of ignore patterns (e.g., "**/\*.profile,**/\*.permissionset"). These patterns are combined with patterns from .forceignore file. Uses glob pattern matching.

# flags.fromLastSuccessfulDeployment.summary

Generate diff from the last successful Salesforce deployment tag on the base branch.

# flags.fromLastSuccessfulDeployment.description

When set, `ref-a` will be automatically determined by finding the latest Git tag that signifies a successful Salesforce deployment on the specified base branch. Requires `--base-branch`.

# flags.baseBranch.summary

The base branch name to look for successful deployment tags.

# flags.baseBranch.description

Specify the base branch name (e.g., 'main', 'develop') when using `--from-last-successful-deployment` to identify the correct deployment tags.

# flags.copyArtifacts.summary

Copy changed files and sfdx-project.json to the output directory.

# flags.copyArtifacts.description

When true (default), copies changed metadata files and a modified sfdx-project.json to the specified output directory. If false, only manifests will be generated.

# flags.createDockerImage.summary

Create a Docker image containing the changed files and sfdx-project.json.

# flags.createDockerImage.description

When true, a Dockerfile will be generated in the output directory and a Docker image will be built with the changed files and sfdx-project.json. This is useful for containerized deployments.

# error.baseBranchRequired

The '--base-branch' flag is required when using '--from-last-successful-deployment'.

# error.noDeploymentTagFound

No successful deployment tag found for branch '%s'.

# error.refARequired

The '--ref-a' flag is required unless '--from-last-successful-deployment' is used.

# info.generatingManifest

Generating manifest for changes between '%s' and '%s'.

# info.usingDeploymentTag

Using latest deployment tag commit '%s' from branch '%s' as ref-a.

# info.foundChangedFiles

Found %s changed files.

# info.foundDeletedFiles

Found %s deleted files.

# info.foundSubmoduleChangedFiles

Found %s changed files in submodules.

# info.foundSubmoduleDeletedFiles

Found %s deleted files in submodules.

# info.filesAfterIgnore

After applying ignore patterns, %s files remain.

# info.usingAdditionalIgnorePatterns

Using %s additional ignore patterns from --ignore flag.

# info.createdOutputDirs

Created output directories in %s.

# info.copiedChangedFiles

Copied %s changed files to %s.

# info.notCopyingChangedFiles

Skipping copying of changed files. Only manifests will be generated.

# info.copiedSfdxProjectJson

Copied and modified sfdx-project.json to %s.

# info.notCopyingSfdxProjectJson

Skipping copying of sfdx-project.json.

# info.generatedManifest

Generated package.xml at %s.

# info.generatedDestructiveManifest

Generated destructiveChanges.xml at %s.

# info.generatedEmptyPackageXml

Generated empty package.xml for destructive changes at %s.

# info.creatingDockerImage

Creating Docker image with changed files and sfdx-project.json.

# info.dockerfileCreated

Dockerfile created at %s.

# info.dockerImageBuilt

Docker image '%s' built successfully.

# warn.sfdxProjectJsonNotFound

sfdx-project.json not found in current or parent directories. Using default API version.
