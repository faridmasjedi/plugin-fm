#!/bin/bash
# ============================================================
# SF FM QUALITY - Examples
# ============================================================

# Scan the files a pull request changes, compared to main
sf fm quality --ref-a origin/main --ref-b HEAD

# Use the team's PMD ruleset and only block on Critical findings
sf fm quality --ref-a origin/main --pmd-ruleset config/pmd/ruleset.xml --severity-threshold 1

# Only PMD and ESLint (no Code Analyzer)
sf fm quality --ref-a origin/main --engine pmd --engine eslint

# Security rules only, via Code Analyzer
sf fm quality --ref-a origin/main --rule-selector Security

# Whole project, report without failing (e.g. a nightly baseline)
sf fm quality --all --warn-only --output-dir quality-baseline

# Same baseline the pipeline uses: everything since the last successful deployment of main
REF_A=$(git rev-list -n 1 "$(git tag --list 'sf-deploy-success/main/*' --sort=-creatordate | head -1)")
sf fm quality --ref-a "$REF_A"
