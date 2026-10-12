# summary

Run static code analysis (PMD, ESLint, Salesforce Code Analyzer) on changed files.

# description

Scans only the metadata that changed between two Git references (or everything with --all), so pull requests are judged on the code they touch. Uses Salesforce Code Analyzer when it is installed (it bundles PMD, ESLint, RetireJS, Flow Scanner and more); otherwise falls back to a local PMD and the repository's own ESLint.

Bring your own rules: a PMD ruleset.xml in the repository (ruleset.xml, pmd/ruleset.xml, config/pmd/ruleset.xml, .pmd/ruleset.xml) or a code-analyzer.yml is picked up automatically.

Writes quality.md, quality.sarif (for GitHub code scanning) and quality.json to the output directory, appends the Markdown summary to the GitHub Actions job summary when available, and exits with code 1 when violations at or above the severity threshold are found.

# examples

- Scan the changes of a pull request against main:

  <%= config.bin %> <%= command.id %> --ref-a origin/main --ref-b HEAD

- Use the team's PMD ruleset and only block on Critical issues:

  <%= config.bin %> <%= command.id %> --ref-a origin/main --pmd-ruleset config/pmd/ruleset.xml --severity-threshold 1

- Scan the whole project with PMD and ESLint, reporting without failing:

  <%= config.bin %> <%= command.id %> --all --engine pmd --engine eslint --warn-only

# flags.refA.summary

Git reference for the 'old' state; files changed since this ref are scanned.

# flags.refB.summary

Git reference for the 'new' state.

# flags.all.summary

Scan every file in the package directories instead of only changed files.

# flags.engine.summary

Engine(s) to run: code-analyzer, pmd, eslint. Detected automatically when omitted.

# flags.engine.description

When omitted, Salesforce Code Analyzer is used if installed ('sf plugins install code-analyzer'). Otherwise PMD is used when the 'pmd' command and a ruleset are available, and ESLint when the repository has ESLint installed and configured.

# flags.ruleSelector.summary

Code Analyzer rule selector(s), e.g. Recommended, Security, pmd:ApexCRUDViolation.

# flags.pmdRuleset.summary

Path to a PMD ruleset.xml. Auto-detected in the repository when omitted.

# flags.pmdRuleset.description

With the pmd engine the ruleset is used as is. With Code Analyzer it is registered as a custom ruleset and the rules it references are added to the rule selectors. For full control with Code Analyzer, provide a code-analyzer.yml instead.

# flags.configFile.summary

Path to a Code Analyzer configuration file (default: code-analyzer.yml in the repository).

# flags.forceignore.summary

Path to the .forceignore file; ignored files are not scanned.

# flags.severityThreshold.summary

Fail when a violation of this severity or worse is found (1 Critical ... 5 Info).

# flags.severityThreshold.description

Severities follow Code Analyzer and PMD: 1 Critical, 2 High, 3 Moderate, 4 Low, 5 Info. ESLint errors count as High and warnings as Low.

# flags.warnOnly.summary

Report violations without failing the command.

# flags.outputDir.summary

Directory for quality.md, quality.sarif and quality.json.

# info.scanning

Scanning %s file(s) with %s.

# info.noFiles

No scannable files changed. Nothing to analyze.

# error.noEngines

No code analysis engine is available. Install Salesforce Code Analyzer (sf plugins install code-analyzer), or install PMD and add a ruleset.xml, or add ESLint to the repository.

# error.thresholdExceeded

Found %s violation(s) at or above severity %s.

# error.engineFailed

One or more analysis engines failed. See the output above.

# error.refOrAllRequired

Provide --ref-a to scan changed files, or --all to scan the whole project.
