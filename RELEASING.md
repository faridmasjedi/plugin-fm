# Releasing and repository rules

## Workflows

| Workflow                                    | When                                                     | What                                                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI` (`.github/workflows/ci.yml`)           | every pull request and push to `main`                    | install, compile + lint, unit tests, command snapshot, JSON schemas                                                                                                                                                                      |
| `Release` (`.github/workflows/release.yml`) | Actions → Release → Run workflow (patch / minor / major) | build and test `main`, bump the version, tag `vX.Y.Z`, GitHub release with the plugin tarball and generated notes, and the **NomadSF** image `ghcr.io/<owner>/nomadsf:X.Y.Z` + `latest` (Salesforce CLI, plugin-fm, Code Analyzer, Java) |

Local hooks (husky) run lint on commit and the full build + tests on push. They need `yarn` (v1) on the PATH.

## Only reviewed, green changes reach `main`

`.github/rulesets/protect-main.json` protects the default branch:

- no deletion and no force-push;
- changes only through a pull request, with a code-owner review (`CODEOWNERS`: `@faridmasjedi`), resolved conversations, and green `CI / test` and `CI / studio` on an up-to-date branch;
- repository admins (you) may bypass **only through a pull request** — you can merge your own pull requests without a second reviewer, but nobody pushes to `main` directly;
- the GitHub Actions app may bypass, for the release workflow's version-bump commit.

Rulesets need a public repository (or GitHub Pro / Team for a private one). Apply or update it with:

```bash
gh api -X POST repos/faridmasjedi/plugin-fm/rulesets --input .github/rulesets/protect-main.json
# later changes: gh api -X PUT repos/faridmasjedi/plugin-fm/rulesets/<id> --input .github/rulesets/protect-main.json
```

## Using the image in other repositories

```yaml
container:
  image: ghcr.io/faridmasjedi/nomadsf:latest
  credentials: { username: '${{ github.actor }}', password: '${{ secrets.GHCR_TOKEN }}' } # token with read:packages
```

See `examples/github-release-train.yml` and `examples/github-dashboard-pages.yml`.
