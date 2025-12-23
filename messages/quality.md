# summary

Run quality checks (linting, PMD, tests) on changed files between two commits

# description

Analyzes the diff between two Git commits and runs comprehensive quality checks on the changed files. This includes ESLint for JavaScript/TypeScript, XML validation, PMD static analysis, and Jest/Mocha tests. Perfect for CI/CD pipelines to ensure code quality on changed files only.

# examples

- Run quality checks between current branch and main:

  <%= config.bin %> <%= command.id %> --base-sha origin/main --head-sha HEAD

- Run quality checks on a specific commit range:

  <%= config.bin %> <%= command.id %> --base-sha abc123 --head-sha def456

- Run with custom PMD ruleset:

  <%= config.bin %> <%= command.id %> --base-sha origin/main --head-sha HEAD --pmd-ruleset ./custom-rules.xml

- Skip specific checks:

  <%= config.bin %> <%= command.id %> --base-sha origin/main --head-sha HEAD --skip-pmd --skip-tests

- Run with JSON output:

  <%= config.bin %> <%= command.id %> --base-sha origin/main --head-sha HEAD --json

# flags.baseSha.summary

Base commit SHA or ref to compare from (e.g., origin/main)

# flags.baseSha.description

The starting commit SHA, branch name, or Git reference to compare from. This is typically the target branch like 'origin/main' or 'main'.

# flags.headSha.summary

Head commit SHA or ref to compare to (e.g., HEAD)

# flags.headSha.description

The ending commit SHA, branch name, or Git reference to compare to. This is typically the current commit or 'HEAD'.

# flags.pmdRuleset.summary

Path to custom PMD ruleset XML file

# flags.pmdRuleset.description

Path to a custom PMD ruleset XML file. If not provided, looks for ruleset in default locations (.pmd/ruleset.xml, pmd-ruleset.xml). If no ruleset is found, PMD check is skipped.

# flags.skipEslint.summary

Skip ESLint checks

# flags.skipEslint.description

Skip ESLint linting for JavaScript/TypeScript files.

# flags.skipXmlLint.summary

Skip XML validation

# flags.skipXmlLint.description

Skip XML validation for XML files.

# flags.skipPmd.summary

Skip PMD static analysis

# flags.skipPmd.description

Skip PMD static analysis checks.

# flags.skipTests.summary

Skip test execution

# flags.skipTests.description

Skip running tests for changed files.

# flags.failOnWarnings.summary

Fail the command if warnings are found

# flags.failOnWarnings.description

By default, only errors cause the command to fail. Set this flag to also fail on warnings.

# info.analyzingChanges

Analyzing changes between %s and %s...

# info.foundChangedFiles

Found %s changed file(s)

# info.noChangedFiles

No files changed between commits

# info.runningEslint

Running ESLint on %s file(s)...

# info.runningXmlLint

Running XML validation on %s file(s)...

# info.runningPmd

Running PMD static analysis...

# info.runningTests

Running tests for changed files...

# info.allChecksPass

✅ All quality checks passed!

# info.checksFailedWithErrors

❌ Quality checks failed with %s error(s)

# info.checksFailedWithWarnings

⚠️ Quality checks completed with %s warning(s)

# info.pmdRulesetNotFound

PMD ruleset not found, skipping PMD checks

# info.noPmdRuleset

No PMD ruleset provided or found, skipping PMD checks

# info.skippingCheck

Skipping %s checks (--skip-%s flag)

# error.invalidGitRef

Invalid Git reference: %s. Error: %s

# error.gitDiffFailed

Failed to get Git diff: %s

# error.eslintFailed

ESLint checks failed with %s error(s) and %s warning(s)

# error.xmlLintFailed

XML validation failed for %s file(s)

# error.pmdFailed

PMD analysis failed with %s violation(s)

# error.testsFailed

Tests failed with %s failure(s)

# error.noGitRepo

Not a Git repository. This command requires a Git repository.
