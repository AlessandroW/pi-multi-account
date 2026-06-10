# Contributing to pi-multi-account

Thanks for your interest in improving pi-multi-account! Issues and pull
requests are welcome. All PRs are reviewed by the maintainer before merge.

## Ground rules

- **Never include secrets.** This project only handles SHA-256 fingerprints of
  credentials — never paste tokens, API keys, or `auth.json` contents into
  issues, PRs, logs, or tests.
- Keep each PR focused on a single concern.
- Discuss large or breaking changes in an issue first.

## Development setup

```bash
git clone https://github.com/Sarrius/pi-multi-account.git
cd pi-multi-account
npm install
```

Requirements: Node.js >= 22.

## Before you open a PR

```bash
npm run check        # TypeScript type-check (tsc --noEmit)
npm run pack:check   # npm pack --dry-run — verify the published file set
```

CI runs the same checks on every pull request; they must pass before review.

## Coding guidelines

- The whole extension lives in `index.ts`. Match the surrounding style.
- Prefer small, well-commented guards over clever one-liners — failover logic is
  safety-critical (a bad loop can peg a machine).
- Update `CHANGELOG.md` under a new version / `Unreleased` heading describing the
  user-visible effect of your change.

## Releasing (maintainer only)

1. Bump `version` in `package.json` and update `CHANGELOG.md`.
2. `npm run check && npm publish`.
3. Tag and push: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
4. Create the GitHub release for the tag.
