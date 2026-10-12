# sf fm quality

Static code analysis on the files that changed between two Git references, so a pull request is judged on the code it touches, not on years of existing code.

```bash
sf fm quality --ref-a <git-ref> [--ref-b HEAD] [options]
sf fm quality --all [options]
```

## Engines

| Engine          | Used when                                                     | What it checks                                                   |
| --------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `code-analyzer` | `sf code-analyzer` is installed (preferred)                   | PMD, CPD, ESLint (LWC/Aura), RetireJS, Flow Scanner, regex rules |
| `pmd`           | Code Analyzer is missing, `pmd` is on the PATH, ruleset found | Apex and Visualforce with your `ruleset.xml`, exactly as written |
| `eslint`        | Code Analyzer is missing, the repo has ESLint installed       | `.js`/`.ts` with the repository's own ESLint configuration       |

Choose explicitly with `--engine` (repeatable): `--engine pmd --engine eslint`.

PMD, CPD and the Graph Engine need **Java 11+**. If Java is missing, Code Analyzer still runs the other engines; the report shows a warning such as `pmd did not run: Could not locate Java v11.0.0+` instead of failing the build.

## Bring your own rules

- **PMD ruleset** — put `ruleset.xml` in the repo (`ruleset.xml`, `pmd-ruleset.xml`, `pmd/ruleset.xml`, `config/pmd/ruleset.xml` or `.pmd/ruleset.xml`) or pass `--pmd-ruleset`.
  - With the `pmd` engine the ruleset is used exactly as written.
  - With Code Analyzer the ruleset is registered as a custom ruleset, and the rules it references are added to the rule selectors (`category/apex/security.xml` → `pmd:Security`, `.../ApexCRUDViolation` → `pmd:ApexCRUDViolation`). `<exclude>` elements are not translated.
- **Code Analyzer config** — a `code-analyzer.yml` in the repo (or `--config-file`) gives full control and takes precedence.
- **Rule selection** — `--rule-selector` (default `Recommended`), e.g. `--rule-selector Security --rule-selector pmd:ApexCRUDViolation`.

## Gate

Severities follow Code Analyzer and PMD: **1 Critical, 2 High, 3 Moderate, 4 Low, 5 Info**. ESLint errors count as High, warnings as Low.

The command exits with code **1** when a violation at or above `--severity-threshold` (default `2`) is found, or when an engine fails. `--warn-only` reports without failing.

## Output

Written to `--output-dir` (default `quality-report/`):

| File            | Use                                                               |
| --------------- | ----------------------------------------------------------------- |
| `quality.md`    | Markdown summary; also appended to the GitHub Actions job summary |
| `quality.sarif` | Upload to GitHub code scanning for inline PR annotations          |
| `quality.json`  | Full result for automation and the dashboard                      |

## Flags

| Flag                   | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `--ref-a`, `-r`        | Scan files changed since this ref                             |
| `--ref-b`, `-R`        | Newer ref (default `HEAD`)                                    |
| `--all`, `-a`          | Scan every file in the package directories                    |
| `--engine`, `-e`       | `code-analyzer`, `pmd`, `eslint` (auto-detected when omitted) |
| `--rule-selector`      | Code Analyzer rule selector(s) (default `Recommended`)        |
| `--pmd-ruleset`        | PMD `ruleset.xml` (auto-detected)                             |
| `--config-file`        | Code Analyzer config (default `code-analyzer.yml`)            |
| `--forceignore`, `-i`  | Files ignored by `.forceignore` are not scanned               |
| `--severity-threshold` | Fail on this severity or worse (1–5, default 2)               |
| `--warn-only`          | Never fail                                                    |
| `--output-dir`, `-d`   | Report directory (default `quality-report`)                   |

Changed files include files changed inside Git submodules, filtered by the parent's `sfdx-project.json` package directories, exactly like `sf fm build`.

## GitHub Actions

```yaml
- uses: actions/setup-java@v4
  with: { distribution: temurin, java-version: '17' }
- run: sf plugins install code-analyzer
- run: sf fm quality --ref-a origin/${{ github.base_ref }} --severity-threshold 2
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with: { sarif_file: quality-report/quality.sarif }
```
