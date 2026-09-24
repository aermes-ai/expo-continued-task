# @aermes/expo-continued-task

**Long, user-started work that keeps running after the user leaves your app on iOS**, using the `BGContinuedProcessingTask` added in iOS 26. The system shows its own progress banner with a Stop button, and your work keeps going in the background.

Getting that to *actually keep running* took a lot of on-device measurement. This package ships the rules we learned, already applied:

| Rule | Why (measured on a real iPhone) |
|---|---|
| **Start only from a tap**, with the app in front | Tasks submitted without a person's action launched, but the process was suspended under them: about one unit of work per 30 s, then expiry. Apple: "Submission needs to occur as a result of a person's action." |
| **The progress bar is weighted by cost, and stays under 100 % while work is owed** | A bar that crawled made iOS ask the user "…is 28% complete. Do you want to continue?" and then expire the task. A bar that hit 100 % with work still owed was expired within about 30 s. |
| **Never "Failed"** | `setTaskCompleted(success: false)`, or a bar left short of its total, shows "Failed". Every ending here completes as a success: "Paused · Tap to resume" when it stopped, or your "done" line when it finished. |
| **Notify before the task ends** | Completing the task can be the last thing a backgrounded process does. The done/paused notification is sent first, and a dead-man's notification covers a process iOS froze. |
| **Memory pressure means expiry** | iOS expired the task 19–43 s after a memory-pressure warning, in every case we saw. Keep your units small. |
| **Older iOS still works** | Without continued tasks, the unit in hand finishes under the ~30 s `beginBackgroundTask` grant, and the job stops cleanly at the boundary. |

Measured results: a job ran **45 minutes fully in the background** under one task. Time is variable, though: the same work got 6 minutes at night after a memory warning. Design for cut-and-resume.

## Install

```sh
npx expo install @aermes/expo-continued-task
```

```json
// app.json
{
  "expo": {
    "plugins": [
      ["@aermes/expo-continued-task", { "taskIdentifierPrefix": "com.yourcompany.yourapp.work" }]
    ]
  }
}
```

The config plugin adds `com.yourcompany.yourapp.work.*` to `BGTaskSchedulerPermittedIdentifiers` and `processing` to `UIBackgroundModes`. Then rebuild the native app (`npx expo prebuild` / EAS Build). This needs a development build; it doesn't work in Expo Go.

## A long job, in one call

```js
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as bg from '@aermes/expo-continued-task';
import { createContinuedJob } from '@aermes/expo-continued-task';

const exporter = createContinuedJob({
  name: 'export',
  bg,
  appState: AppState,
  size: () => items.length,           // how many units are owed
  step: async () => exportNext(),     // one unit; resolve false when none are left
  seedMs: 500,                        // what one unit costs in the background, measured (ms)
  words: {
    title: 'Exporting photos',
    line: ({ done, total }) => `${done} of ${total}`,
    done: ({ total }) => `${total} exported`,
  },
  notifications: {                    // optional
    Notifications,
    done: { title: 'Export finished', body: 'Your photos are ready' },
    paused: { title: 'Export paused', body: 'Tap to resume' },
  },
});

<Button title="Export" onPress={() => exporter.start()} />   // from a tap, app in front
useEffect(() => exporter.listen({ open, top, resume: () => exporter.start(), canResume: () => true }), []);
```

## A short job (the ~30 s after the user leaves)

```js
import { createGraceOnlyJob } from '@aermes/expo-continued-task';

const flush = createGraceOnlyJob({ name: 'flush', step: async () => flushOne(), appState: AppState, bg });
flush.start();
```

## Config plugin options

| Option | Default | What |
|---|---|---|
| `taskIdentifierPrefix` | `<bundleId>.continued` | Tasks are `<prefix>.<uuid>` |
| `extraTaskIdentifierPrefixes` | `[]` | More prefixes a job may submit under (`taskPrefix`) |
| `logDirectory`, `logFileName` | `expo-continued-task`, `continued.jsonl` | Lifecycle log in Documents |
| `pausedTitle`, `pausedSubtitle` | `Paused`, `Tap to resume` | What an ending iOS forced says |
| `grantName` | `ExpoContinuedTask` | The grace grant's name in iOS logs |
| `debugLog` | off | `{directory, fileName, source, appGroup?, enabledKey?, overrideKey?}`: a native JSONL debug log |

## Building blocks

For more control (several phases, your own UI or Live Activity), use the pieces `createContinuedJob` is made of:
- `createContinuedTask`: submit, progress, `say`, never-Failed `end`, `beforeEnd` hooks, and the willResignActive safety net.
- `createCostBar`: the honest progress bar.
- `createNotifier`: namespaced notifications with per-run dedupe, the dead-man's switch and tap routing.
- `createForegroundBridge`: the grace grant around a minimise.
- `defineBackgroundJob`, `anyBusy`: an app-wide "is anything working?".

### Advanced: a two-phase job with its own UI

`createExecutor`, `createGuards`, `createCoordinator` and `createIndicatorPublisher` (and `policy`) are the machinery a job assembles itself when it has a **main** phase (e.g. a pass that reads what is to be done) and a **follow-up** phase that works through it in chunks, under windows, a continued task and the foreground. Their names are neutral:

- phases are `main` and `followUp` (`DEFAULT_PHASES`); `createContinuedTask({phases})` and `createCoordinator({phases})` take your own names;
- `createContinuedTask`: `begin({phase, done, total, followUpPending})`, `armResignNet({armed, phase, followUpPending, subtitle})`;
- `createCoordinator`: `beginTask({phase})`, `syncResignNet({mainRunning, followUpRunning, line})`, `minimiseHandOff({followUpRunning, openUnits, leave, passContext, stopMidChunk})`;
- `createExecutor`: `onFollowUp` (the chunk loop starting and ending), `setOnItem` (each item inside a chunk); the run's summary and `onChunk` report `items`, and `onChunk` passes on `work`'s `groupIds`;
- `createGuards({device, windowState})`: the device port's window state is `device.windowState()`, or pass `windowState` if your module names it otherwise;
- `createIndicatorPublisher({processingWindow})`: the `{pending, subscribe}` window the sweep waits on.

Everything the package **writes** — phase names, debug categories and events, trace marks, summary keys, log lines — is neutral by default and injectable, so an app already shipping its own words keeps emitting exactly those: `phases`, `createCoordinator({vocabulary})` (`COORDINATOR_VOCABULARY`: `debugCategory`, `beginTask`, `awaitingResume`, `followUpPendingKey`) and `createExecutor({vocabulary})` (`EXECUTOR_VOCABULARY`: `items`, `groupIds`, `groups`, `onItem`, `onFollowUp`).

## TypeScript and Jest

- TypeScript declarations ship with the package (`types/`), for the root and every subpath export.
- The package ships its source as modern JavaScript, the way Metro expects it. If your app's Jest config uses `transformIgnorePatterns`, let this package through, e.g. with `jest-expo`:

  ```js
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@aermes/expo-continued-task)'],
  ```

- Under Jest there is no native module: every native call is a no-op and `isAvailable` is `false`. Pass your own `bg` double to `createContinuedJob` (it takes the native functions as an argument) to test your job.

## Limits

- iOS only. On Android every call is a no-op.
- `BGContinuedProcessingTask` needs iOS 26 and Xcode 26. On older systems the grace grant is all there is.
- iOS decides how long a task lives. This package makes it as likely as we know how, not guaranteed.

## License

MIT © Aermes
