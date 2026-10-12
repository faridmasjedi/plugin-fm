/**
 * Starter files written by `sf fm pipeline init`.
 */
export function pipelineTemplate(options: { targetOrg: string; baseBranch: string }): string {
  const { targetOrg, baseBranch } = options;
  return `# plugin-fm pipeline (optional)
#
# Every stage runs a command you can also run on its own, so you can adopt this
# file gradually or not at all. Run it with:   sf fm pipeline run
# Watch and approve steps in the dashboard:    sf fm dashboard
#
# Stage fields:
#   uses:   build | quality | deploy | check-duplicates | script | shell | approval
#   with:   flags for the command (same names as on the command line)
#   run:    script path (uses: script; .apex .sh .js .ts .py) or command line (uses: shell)
#   if:     success (default) | failure | always
#   manual: true            -> ask before running this stage
#   continue-on-error: true -> a failure is shown as a warning and the pipeline continues
#
# Values can reference earlier stages and the environment:
#   \${stages.<id>.result.<field>}  \${env.NAME}  \${run.id}  \${run.release}  \${run.branch}

name: Salesforce release
# release: \${env.RELEASE_NAME}   # groups runs on the dashboard; defaults to the branch name

stages:
  - id: build
    name: Build delta
    uses: build
    description: Changes since the last successful deployment of ${baseBranch}
    with:
      from-last-successful-deployment: true
      base-branch: ${baseBranch}
      ref-a: origin/${baseBranch}   # used until the first deployment tag exists
      output-dir: manifest

  - id: quality
    name: Code quality
    uses: quality
    description: PMD / ESLint / Code Analyzer on the changed files only
    with:
      ref-a: \${stages.build.result.refA}
      severity-threshold: 2
    continue-on-error: true

  - id: validate
    name: Validate in ${targetOrg}
    uses: deploy
    with:
      manifest: manifest
      target-org: ${targetOrg}
      mode: validation
      intelligent-tests: true
      progress: true

  - id: approve
    name: Release approval
    uses: approval
    description: Check the validation and quality results, then approve the deployment

  - id: pre-deploy
    name: Pre-deploy script
    uses: script
    run: .fm/scripts/pre-deploy.apex
    with:
      target-org: ${targetOrg}

  - id: deploy
    name: Deploy to ${targetOrg}
    uses: deploy
    with:
      mode: quick
      validation-id: \${stages.validate.result.validationId}
      target-org: ${targetOrg}
      tag-on-success: ${baseBranch}
      push-tag: true   # so the next CI run finds the tag
      progress: true

  - id: post-deploy
    name: Post-deploy script
    uses: script
    run: .fm/scripts/post-deploy.sh
    with:
      target-org: ${targetOrg}

  - id: notify-failure
    name: Notify on failure
    uses: shell
    if: failure
    run: echo "Pipeline \${run.id} failed for release \${run.release}"
`;
}

export const PRE_DEPLOY_APEX = `// Runs as anonymous Apex in the target org before the deployment (sf apex run).
// Example: switch off automation while metadata is deployed.
System.debug('Pre-deploy step for release ' + 'fm');
`;

export const POST_DEPLOY_SH = `#!/usr/bin/env bash
# Runs after the deployment. Available variables:
#   FM_TARGET_ORG, FM_RUN_ID, FM_RELEASE
set -euo pipefail
echo "Post-deploy step for \${FM_RELEASE} on \${FM_TARGET_ORG}"
# sf data import tree --plan data/plan.json --target-org "\${FM_TARGET_ORG}"
`;

export const WAVES_TEMPLATE = `# Deployment waves for 'sf fm build --waves' (optional).
#
# Each changed file goes to the FIRST wave whose types or paths match it; anything
# else goes to the default wave. Every wave becomes its own artifact in
# <output-dir>/<n>-<id>, so waves are never merged into one manifest.
#
#   types: metadata type names, or built-in groups @data-cloud, @omnistudio, @agentforce
#   paths: .gitignore-style patterns from the repository root

waves:
  - id: data-cloud
    name: Data Cloud
    types: ['@data-cloud']
    paths: []                      # e.g. force-app/main/data-cloud/**

  - id: core
    name: Core metadata            # everything else, including Agentforce
    default: true

  - id: omnistudio
    name: OmniStudio
    types: ['@omnistudio']
    paths: []                      # e.g. force-app/main/omnistudio/**
`;

export function trainTemplate(options: { targetOrg: string; baseBranch: string }): string {
  const { targetOrg, baseBranch } = options;
  const wave = (id: string): string => `\${stages.build.result.wavesById.${id}`;
  return `# plugin-fm release train (optional)
#
# Waves (see .fm/waves.yml): 1 Data Cloud -> 2 core (everything else, incl. Agentforce) -> 3 OmniStudio
#
#   Pull request:  build -> quality -> Data Cloud: validate -> [approve] -> deploy -> validate core (PR check)
#   Push (merge):  build -> deploy core -> OmniStudio: validate -> [approve] -> deploy -> tag
#
# The event comes from CI (GitHub: pull_request -> pr, push -> push) or --event.
# Approvals only run when FM_REQUIRE_APPROVAL is true (e.g. a repository variable).
# Stages for a wave without changes are skipped.

name: Salesforce release train

stages:
  - id: build
    name: Build waves
    uses: build
    with:
      from-last-successful-deployment: true
      base-branch: ${baseBranch}
      ref-a: origin/${baseBranch}   # used until the first deployment tag exists
      output-dir: manifest
      waves: true

  - id: quality
    name: Code quality
    uses: quality
    on: [pr]
    with:
      ref-a: \${stages.build.result.refA}
      severity-threshold: 2
    continue-on-error: true

  # ── Wave 1: Data Cloud (pull request) ─────────────────────────────
  - id: validate-data-cloud
    name: Validate Data Cloud
    uses: deploy
    on: [pr]
    when: ${wave('data-cloud')}.hasChanges}
    with:
      manifest: ${wave('data-cloud')}.dir}
      target-org: ${targetOrg}
      mode: validation
      test-level: NoTestRun
      destructive: post

  - id: approve-data-cloud
    name: Approve Data Cloud deployment
    uses: approval
    on: [pr]
    when:
      - ${wave('data-cloud')}.hasChanges}
      - \${env.FM_REQUIRE_APPROVAL}

  - id: deploy-data-cloud
    name: Deploy Data Cloud
    uses: deploy
    on: [pr]
    when: ${wave('data-cloud')}.hasChanges}
    with:
      manifest: ${wave('data-cloud')}.dir}
      target-org: ${targetOrg}
      mode: deployment
      test-level: NoTestRun
      destructive: post

  # ── Wave 2: core (pull request check, deployed on push) ───────────
  - id: validate-core
    name: Validate core metadata
    uses: deploy
    on: [pr]
    when: ${wave('core')}.hasChanges}
    with:
      manifest: ${wave('core')}.dir}
      target-org: ${targetOrg}
      mode: validation
      intelligent-tests: true
      destructive: post

  - id: deploy-core
    name: Deploy core metadata
    uses: deploy
    on: [push]
    when: ${wave('core')}.hasChanges}
    with:
      manifest: ${wave('core')}.dir}
      target-org: ${targetOrg}
      mode: deployment
      intelligent-tests: true
      destructive: post

  # ── Wave 3: OmniStudio (push) ─────────────────────────────────────
  - id: validate-omnistudio
    name: Validate OmniStudio
    uses: deploy
    on: [push]
    when: ${wave('omnistudio')}.hasChanges}
    with:
      manifest: ${wave('omnistudio')}.dir}
      target-org: ${targetOrg}
      mode: validation
      test-level: NoTestRun
      destructive: post

  - id: approve-omnistudio
    name: Approve OmniStudio deployment
    uses: approval
    on: [push]
    when:
      - ${wave('omnistudio')}.hasChanges}
      - \${env.FM_REQUIRE_APPROVAL}

  - id: deploy-omnistudio
    name: Deploy OmniStudio
    uses: deploy
    on: [push]
    when: ${wave('omnistudio')}.hasChanges}
    with:
      manifest: ${wave('omnistudio')}.dir}
      target-org: ${targetOrg}
      mode: deployment
      test-level: NoTestRun
      destructive: post

  # ── Release done: next build starts from here ─────────────────────
  - id: tag
    name: Tag deployed commit
    uses: tag
    on: [push]
    with:
      branch: ${baseBranch}
      push: true

  - id: notify-failure
    name: Notify on failure
    uses: shell
    if: failure
    run: echo "Release train \${run.id} (\${run.event}) failed for \${run.release}"
`;
}
