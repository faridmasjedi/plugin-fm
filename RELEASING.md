# Releasing and repository rules

## Workflows

| Workflow                                    | When                                                     | What                                                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI` (`.github/workflows/ci.yml`)           | every pull request and push to `main`                    | install, compile + lint, unit tests, command snapshot, JSON schemas                                                                                                                                                                      |
| `Release` (`.github/workflows/release.yml`) | Actions → Release → Run workflow (patch / minor / major) | build and test `main`, bump the version, tag `vX.Y.Z`, GitHub release with the plugin tarball and generated notes, and the **NomadSF** image `ghcr.io/<owner>/nomadsf:X.Y.Z` + `latest` (Salesforce CLI, plugin-fm, Code Analyzer, Java) |

Local hooks (husky) run lint on commit and the full build + tests on push. They need `yarn` (v1) on the PATH.

## Only you can change `main`

`.github/rulesets/protect-main.json` protects the default branch: no deletion or force-push, changes only through a pull request with a code-owner review (`CODEOWNERS`: `@faridmasjedi`) and a green `CI / test`. Repository admins (you) and the GitHub Actions app (for the release commit) can bypass, so you can merge your own changes.

Rulesets on **private** repositories need GitHub Pro (or Team for organizations). After upgrading, apply it once:

```bash
gh api -X POST repos/faridmasjedi/plugin-fm/rulesets --input .github/rulesets/protect-main.json
```

Until then the repository is still only writable by you, because a personal repository has no other writers unless you invite collaborators.

## Using the image in other repositories

```yaml
container:
  image: ghcr.io/faridmasjedi/nomadsf:latest
  credentials: { username: '${{ github.actor }}', password: '${{ secrets.GHCR_TOKEN }}' } # token with read:packages
```

See `examples/github-release-train.yml` and `examples/github-dashboard-pages.yml`.
