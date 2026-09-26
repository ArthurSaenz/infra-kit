# Publishing the infra-kit packages

The four packages (`@slip-stream-kit/config`, `infra-kit`, `@slip-stream-kit/eslint-plugin`,
`@slip-stream-kit/vite`) are released by CI from `main`, with no npm token anywhere, following
[The secure way to release an npm package in 2026](https://evilmartians.com/chronicles/the-secure-way-to-release-an-npm-package)
(Evil Martians). This page is the runbook: the release flow, and the one-time settings that live
on npmjs.com and github.com rather than in the repo.

## Release flow

```sh
node scripts/release-bump.mjs 0.12.0   # moves the six version fields, commits
git push origin main                   # .github/workflows/publish.yaml runs
```

1. **build job** installs with `--frozen-lockfile --ignore-scripts`, builds, packs the four
   tarballs into `release-artifacts/` (`scripts/pack-release.mjs`) and checks the packed manifests:
   the versions agree and no `workspace:`/`catalog:`/`link:`/`file:` range ships.
2. **publish job** installs nothing. It downloads the tarballs and runs `npm stage publish` for
   every version not yet on the registry (`scripts/publish-release.mjs`), config first. Only this
   job has `id-token: write`; npm signs the packages (provenance) through trusted publishing.
3. **You approve.** Open [Staged Packages](https://www.npmjs.com/) from the npm user menu and
   approve each package with 2FA, or from a terminal:

   ```sh
   npm stage list
   npm stage approve <stage-id>      # config first, then cli, eslint-plugin, vite
   ```

   [drydock](https://drydock.org) can e-mail the diff of every staged package before you approve.

4. **Laptop half**, once all four are live:

   ```sh
   node scripts/release-install.mjs   # pnpm add -g infra-kit@<version>; claude plugin update in every consumer
   ```

A re-run of a failed job skips what is already published, so a half-done release is finished by
re-running it, not by bumping again. `workflow_dispatch` with `dry_run` builds, packs, verifies and
runs `npm publish --dry-run` without staging anything: use it after changing the workflow or the
scripts.

Why there is no tag: the release trigger is the bump commit on `main`, and `main` is protected by a
ruleset (no force push, no deletion). The `Tags only by admins` ruleset exists anyway, so a tag can
never become a second, unguarded trigger.

## One-time settings (outside the repo)

### npmjs.com, for each of the four packages

Open the package's access settings, logged in as a maintainer:

- <https://www.npmjs.com/package/@slip-stream-kit/config/access>
- <https://www.npmjs.com/package/infra-kit/access>
- <https://www.npmjs.com/package/@slip-stream-kit/eslint-plugin/access>
- <https://www.npmjs.com/package/@slip-stream-kit/vite/access>

1. **Trusted Publisher** → GitHub Actions:
   - Organization or user: `ArthurSaenz`
   - Repository: `infra-kit`
   - Workflow filename: `publish.yaml`
   - Environment: empty
   - Enable only **Allow npm stage publish**. Plain `npm publish` stays denied, so a hijacked CI
     cannot release without your approval.
2. **Publishing access** → **Require two-factor authentication and disallow tokens**. This revokes
   every existing token, including the one in `~/.npmrc`; nothing else publishes these packages
   with a token, so nothing breaks.

Then revoke the laptop token itself at <https://www.npmjs.com/settings/~/tokens>. No `NPM_TOKEN`
secret was ever set on the repo.

### github.com

- **2FA** on the personal account: <https://github.com/settings/security>. A hardware key or a
  passkey is preferred.
- **Rulesets** (created through the API on 2026-09-26, listed at
  <https://github.com/ArthurSaenz/infra-kit/settings/rules>):
  - `main: no force push, no deletion` on the default branch;
  - `Tags only by admins`: restrict creations, bypass for repository admins.
- **Immutable releases**: <https://github.com/ArthurSaenz/infra-kit/settings>, section
  _Releases_. Not load-bearing while nothing creates GitHub Releases, but cheap to enable now.

## What the repo enforces

- `.github/workflows/publish.yaml`: build and publish as separate jobs, `id-token: write` on
  publish only, `persist-credentials: false`, no cache on the release path, every action pinned to
  a commit SHA.
- `.github/workflows/check-workflows.yaml`: zizmor lints every workflow on each push and PR.
- `.github/dependabot.yml`: keeps the pinned actions current, with a 7-day cooldown (zizmor's floor).
- Every package's `package.json` carries `repository` (`git+https://github.com/ArthurSaenz/infra-kit.git`
  plus `directory`): the registry refuses a provenance-signed tarball whose `repository.url` does not
  name the source repo (E422). A new package must copy the block before its first release.
- `pnpm-workspace.yaml`: `minimumReleaseAge: 4320` (3-day dependency cooldown, pnpm's default is
  1 day); dependency install scripts stay blocked by pnpm 12, `allowBuilds` lists the exceptions.
- `apps/infra-kit/{cli,vite}` depend on `@slip-stream-kit/config` as `workspace:^`, packed as
  `^<version>`, so one commit carries all four packages and no re-pin commit sits between two
  publishes.
