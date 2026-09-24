# Changelog

## Unreleased

- `example/`: a one-screen Expo app that runs a 120-unit job with the system banner, notifications, and Start / Stop, using the package from source. CI builds it for the simulator.
- `CONTRIBUTING.md`: the repository layout, how to run the tests, typecheck, Swift harness and example, and the rules a change must keep.
- README: a Troubleshooting section (symptom, cause, fix).

## 0.1.0

First public release. This is the code Aermes ships in its iOS app.

- Native module `ExpoContinuedTask`:
  - `BGContinuedProcessingTask` (iOS 26+): submit from a tap, report progress, retitle, a resign safety net, and endings that are never "Failed";
  - the `beginBackgroundTask` grace grant, including a pre-grant at willResignActive;
  - a lifecycle log, and an optional native debug log.
- Config plugin: task identifiers, the `processing` background mode, and every name the module uses on a device.
- JS API:
  - one-call helpers: `createContinuedJob`, `createGraceOnlyJob`;
  - building blocks: `createContinuedTask`, `createCostBar`, `createNotifier`, `createForegroundBridge`, `defineBackgroundJob` and the busy registry;
  - advanced, for a two-phase job with its own UI: `createExecutor`, `createGuards`, `createCoordinator`, `createIndicatorPublisher`, `connectIndicator` and `policy`. Phase names, debug categories and summary keys are neutral by default and injectable (`phases`, `vocabulary`).
- TypeScript declarations for the whole API.
