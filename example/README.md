# expo-continued-task example

One screen, one job: **Start** runs 120 simulated units of about a second each through `createContinuedJob`, with the system progress banner, notifications, and a **Stop** button. The package is used from source (`"@aermes/expo-continued-task": "file:.."`), so edits to `../src` show up on reload.

## Run it on an iPhone

Continued tasks (`BGContinuedProcessingTask`) need **iOS 26 on a real device**, and an app **built with Xcode 26** (an older Xcode compiles the continued-task code out, and `continuedSupported()` is `false` everywhere). On a simulator, or on older iOS, only the ~30 s grace fallback runs.

```sh
cd example
npm install
npx expo prebuild -p ios
npx expo run:ios --device
```

`run:ios --device` asks which connected iPhone to use and signs with your team. The bundle id is `com.example.continuedtask`; change it in `app.json` (and `taskIdentifierPrefix` with it) if your team can't sign that id.

## What to expect

1. On launch the app asks for notification permission. Allow it, to see the done / paused notifications.
2. The screen shows `isAvailable` (the native module is linked: `true` in this build) and `continuedSupported()` (`true` only on iOS 26 with an Xcode 26 build).
3. Tap **Start**. The count goes up about once a second. The task can only start like this, from a tap with the app in front.
4. Leave the app (swipe home). The system shows a progress banner, "Example work", with "n of 120" under it and a Stop button, and the count keeps going. Come back and the screen has kept up.
5. Tap **Stop** in the system UI (or let iOS expire the task). The unit in hand finishes, the job stops at the boundary, the banner shows **"Paused"** with "Tap to resume", and a "Example work paused" notification arrives. It never shows "Failed". Tap the notification to open the app, then **Start** to carry on from where it stopped.
6. Let it run to 120: the banner ends on "120 units done" and the "finished" notification arrives, sent before the task ends.

The in-app **Stop** button does the same as the system one: the job stops at the next unit boundary and the task ends as a paused success.

On a simulator, or an iPhone below iOS 26: tap Start and leave, and the unit in hand finishes inside the grace grant, then the job stops and you get the paused notification. No banner.

## How it's wired

- `app.json` adds the config plugin with `taskIdentifierPrefix: "com.example.continuedtask.work"`, which writes `com.example.continuedtask.work.*` to `BGTaskSchedulerPermittedIdentifiers` and `processing` to `UIBackgroundModes`.
- `metro.config.js` watches the package root (`..`) and resolves every dependency from this folder's `node_modules`, so there is one copy of React and React Native.
- `App.js` creates the job once, at module scope, since the job listens to `AppState` for as long as the app runs.
