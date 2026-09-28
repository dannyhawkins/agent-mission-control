# Releasing

Releases are tagged from `main` whenever we choose. There is no release branch and no git flow.
Versions are plain semver, `0.x` while in alpha, and every `0.x` GitHub release is marked
pre-release. The root `package.json` version is the one version number: `amc --version`, the
hub's `/api/health`, the tarball names and the Homebrew formula all come from it.

## Cutting a release

1. On an up-to-date `main`, bump `version` in the root `package.json` (for example `0.1.0` to
   `0.2.0`). Change nothing else by hand: release notes and `CHANGELOG.md` come from the
   commit history.
2. Commit it as `chore(release): vX.Y.Z` and push `main`.
3. Tag that commit and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The tag must be `v` plus the `package.json` version exactly, or the workflow fails before
building anything. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix(hub):`, ...), because the release notes are grouped by type. Anything else still
appears, under "Other".

## What the workflow does

`.github/workflows/release.yml`, on a pushed `v*` tag:

1. Checks the tag against the root `package.json` version.
2. Builds the web UI, then cross-compiles `amc` for darwin-arm64, darwin-x64, linux-x64 and
   linux-arm64 on one Ubuntu runner (`bun apps/cli/build.ts --all`, what `task build:bin:all`
   runs). It checks each binary's format with `file` and runs the linux-x64 one's `--version`.
3. Packages each as `amc-<version>-<os>-<arch>.tar.gz` holding `amc`, `README.md` and `LICENSE`
   (when present), and writes `SHA256SUMS`.
4. Writes release notes with [git-cliff](https://git-cliff.org) (`cliff.toml`) over the commits
   since the previous `v*` tag. The first release covers all history. It also checks that the
   intro of `CHANGELOG.md` matches the `header` in `cliff.toml`; keep the two identical.
5. Creates the GitHub release `vX.Y.Z` with the tarballs, `SHA256SUMS` and the notes, marked
   pre-release for any `0.x` version.
6. Regenerates `CHANGELOG.md` on `main` from all history and pushes it as
   `docs(changelog): vX.Y.Z` (skipped in later notes). The tagged commit carries the previous
   changelog; the release notes are the record for that version.
7. Renders `Formula/amc.rb` from `packaging/homebrew/amc.rb.tmpl` and `SHA256SUMS`
   (`scripts/render-formula.ts`) and pushes it to
   [dannyhawkins/homebrew-tap](https://github.com/dannyhawkins/homebrew-tap), so that
   `brew install dannyhawkins/tap/amc` picks up the new version. Without the
   `HOMEBREW_TAP_TOKEN` secret this step is skipped with a warning and the release still
   succeeds; the rendered formula is in the run's `release-meta` artifact to push by hand.

### Dry runs

Run the same build, packaging and notes without releasing anything:

```sh
gh workflow run release.yml --ref <branch> -f dry_run=true
```

A dry run uploads each tarball and a `release-meta` artifact (`SHA256SUMS`, `notes.md`, `amc.rb`,
and a `CHANGELOG.md` preview) to the workflow run, and creates no release, tag, changelog
commit or tap commit. `dry_run` defaults to true.
The optional `version` input must match `package.json` if given. A non-dry dispatch creates the
tag and release from the commit it ran on, and is refused anywhere but `main`. Pull requests
that change the release workflow, `cliff.toml`, `CHANGELOG.md`, `packaging/`,
`scripts/render-formula.ts` or `apps/cli/build.ts` get a dry run automatically.

## HOMEBREW_TAP_TOKEN

The default `GITHUB_TOKEN` can only write to this repository, so pushing the formula needs a
token for the tap. Create a fine-grained personal access token at
<https://github.com/settings/personal-access-tokens/new>:

- Resource owner: `dannyhawkins`
- Repository access: Only select repositories, `dannyhawkins/homebrew-tap`
- Permissions: Repository permissions, Contents: Read and write
- An expiry you will remember to renew. An expired token shows up as a failed tap step.

Then add it to this repository as an Actions secret named `HOMEBREW_TAP_TOKEN`:

```sh
gh secret set HOMEBREW_TAP_TOKEN --repo dannyhawkins/agent-mission-control
```

## While the repositories are private

Homebrew fetches formula URLs anonymously, so this repository and the tap must both stay
public for `brew install dannyhawkins/tap/amc` to work. A tarball can also be fetched directly
with `gh release download vX.Y.Z --repo dannyhawkins/agent-mission-control --pattern '*darwin-arm64*'`.
