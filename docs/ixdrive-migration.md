# iXDrive moved to id7-apps

On 10 November 2026, iXDrive moved to the separate local repository:

`/Users/Suhail/Development/id7-apps`

Migration commit there: `882f7136f655c7c003f185aef90e73389a8351f3`.

The new repository contains `apps/ixdrive`, both iXDrive test suites, the shared
MGU build/runtime/preview toolkit, a new-app generator, English-only builds,
CI checks, and the project handoff in `docs/CONTEXT.md` and `AGENTS.md`.

Open that working folder for future iXDrive changes. From there:

```sh
npm test
npm run build:preview -- ixdrive
npm run new:app -- my_app "My App"
```

The move was verified with byte comparisons of app code/artwork/tests, the full
supported test suite, and previews built from a clean export of committed files.
The SDK is not included, so installable packages still need a local BMW SDK.

The previous app revisions remain in this repository's Git history. eDrive and
all other original apps remain here. Local build outputs are not source files
and were not migrated or removed.
