# Contributing

Thanks for helping. Bug reports with a device log attached, fixes and docs are all welcome.

This repository is a mirror of the package as it lives in Aermes' app monorepo, where it ships in a production iOS app. Open issues and pull requests here as usual; accepted changes are applied upstream and come back to this repository with the next sync, so your change may arrive here inside a sync commit rather than as your original commit.

## Layout

| Path | What |
|---|---|
| `src/` | The JavaScript API. `index.js` is the root export; `native.js` wraps the native module (every call is a no-op without it). |
| `src/__tests__/` | Jest tests, run against doubles of the native module and `AppState`. |
| `types/` | TypeScript declarations for the root and every subpath export; `types/__typecheck__/usage.ts` exercises them. |
| `ios/` | The Swift native module: `ContinuedTask.swift` (the continued task and grace grant), config, debug log. |
| `app.plugin.js` | The config plugin (Info.plist identifiers, background mode, module options). |
| `harness/` | Runs `ContinuedTask.swift`'s real code against a fake BackgroundTasks on a simulator. |
| `test/` | Jest setup (the `expo-modules-core` double). |
| `example/` | A one-screen Expo app using the package from source. Not published. |
| `.github/workflows/ci.yml` | CI: tests, typecheck, `npm pack`, the Swift harness, and an example build. |

## Checks

```sh
npm install --legacy-peer-deps
npm test                                   # the Jest suite
```

Typecheck the declarations against the real peer types, as CI does:

```sh
npm install --no-save --no-audit --no-fund typescript@5 react-native@0.81 expo-modules-core@3 expo-notifications@0.32
npx tsc -p types/tsconfig.json
```

The Swift harness, on a Mac with Xcode (it needs a booted iOS simulator):

```sh
xcrun simctl boot "iPhone 16"              # or any available simulator
harness/run.sh                             # or: harness/run.sh <simulator-udid>
```

It compiles `ios/ContinuedTask.swift` with the iOS 26 code paths switched on against stubbed BackgroundTasks, so it runs on any Xcode, and checks that every ending completes as a success.

Check what would be published: `npm pack --dry-run`. `example/` and this file must not be in the list.

## The example app

`example/` builds the package from source into a small app. See [example/README.md](example/README.md). To check that it builds, as CI does:

```sh
cd example
npm install --no-audit --no-fund
npx expo prebuild -p ios --no-install
(cd ios && pod install)
xcodebuild -workspace ios/*.xcworkspace -scheme ContinuedTaskExample -sdk iphonesimulator \
  -configuration Debug -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
```

Anything touching the native side or the task's lifecycle should also be tried on an iPhone on iOS 26, built with Xcode 26: start, minimise, Stop from the system UI, and let one run finish. Say in the PR what you saw.

## Rules a change must keep

These are why the package exists; each one came from a task that iOS killed or marked "Failed" on a real device.

- **Start only from a tap, with the app in front.** Tasks submitted without a person's action were launched, but the process was suspended under them and they expired. Never start work from launch, a timer, or a background event.
- **Never "Failed".** `setTaskCompleted(success: false)`, or a bar left short of its total, shows "Failed" to the user. Every ending completes with success: "Paused" when the work stopped early, the done line when it finished.
- **The bar stays under 100 % while work is owed.** A bar that reached 100 % with work left was expired within about 30 s, and one that crawled made iOS ask the user whether to continue. The bar is weighted by measured cost and capped while units are owed.
- **Notify before the task ends.** Completing the task can be the last thing a backgrounded process gets to do, so the done / paused notification goes out first (a `beforeEnd` hook), with a dead-man's notification for a process iOS freezes.

Also: the JavaScript ships over the air but the Swift only in a binary, so new JS must keep working on a binary without a new native function (check with `has(...)` in `native.js`, and fall back).

## Pull requests

- One change per PR, with a test when it changes behaviour (`src/__tests__/`), and declarations updated in `types/` when it changes the API.
- Add a line under "Unreleased" in `CHANGELOG.md`.
- `npm test`, the typecheck and the harness pass.
