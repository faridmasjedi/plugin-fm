# summary

Find differences between the repository and an org (changes made directly in the org).

# description

Builds a manifest from the project's package directories, retrieves the same metadata from the org into a temporary folder and compares the files (ignoring line endings, trailing spaces and whitespace between XML tags). Reports metadata changed in the org, metadata in the org but not in the repository, and metadata in the repository missing in the org. With --include-org-only, whole types (e.g. ApexClass, Flow) are retrieved too, to find components created only in the org. Writes a Markdown report (and the GitHub job summary in Actions).

# examples

- Check production against the repository:

  <%= config.bin %> <%= command.id %> --target-org prod

- Also find Apex classes and flows created only in the org, and fail the job when anything drifted:

  <%= config.bin %> <%= command.id %> --target-org prod --include-org-only ApexClass,Flow --fail-on-drift --output-file drift.md

# flags.targetOrg.summary

Org to compare with the repository.

# flags.sourceDir.summary

Folders to compare (default: the package directories of sfdx-project.json).

# flags.includeOrgOnly.summary

Metadata types to retrieve completely, to find components that exist only in the org.

# flags.outputFile.summary

Write the Markdown report to this file.

# flags.failOnDrift.summary

Exit with an error when the org differs from the repository.
