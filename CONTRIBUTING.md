# Contributing

Thanks for your interest! The code is licensed under the [Elastic License 2.0](LICENSE.md) (see also [NOTICE](NOTICE.md)).
With a contribution you confirm that you have the right to submit it, and you grant the author a perpetual, irrevocable, worldwide,
royalty-free and non-exclusive right to use, modify, distribute and relicense it as part of WebManager.

## Bugs and requests

Open an issue with the version, operating system and a log excerpt (without passwords/tokens). **Do not report security vulnerabilities
publicly**, see [.github/SECURITY.md](.github/SECURITY.md).

## Pull requests

1. Branch from `main`, keep the change small and self-contained.
2. Run the tests (see README → Development); new logic gets a test.
3. All user-facing text in the source is English (the English text is the key of the translations). After changing texts run `php scripts/i18n.php sync de` and translate the new entries (see manual, “Languages”).
4. Add an entry to `CHANGELOG.md`.

## Publishing a release (maintainers)

```bash
echo 0.1.0 > VERSION                  # new version number (SemVer)
# CHANGELOG.md: add a section "## [0.1.0]"
git commit -am "Release 0.1.0" && git push
git tag 0.1.0 && git push origin 0.1.0
```

The tag starts `.github/workflows/release.yml`: it checks that tag and `VERSION` match, runs the tests, builds
`webmanager-<version>.tar.gz` with its `.sha256` and creates the GitHub release with the CHANGELOG section as notes, followed by a fixed footer with the update and installation commands
(the files themselves are distributed by the update server `updates.drimzo.cc`, see its `bin/add-release.sh`).
Every installation notices it within 2 hours at the latest and shows it in the dashboard (patch versions are installed on their own
when the automatic mode is enabled). Manually you can still use `scripts/publish-release.sh`.

The tag is the plain version number **without** `v`.
