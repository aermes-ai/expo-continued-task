import ExpoModulesCore
import UIKit

// Requests an iOS background-execution grant (UIApplication.beginBackgroundTask) so work in
// flight (e.g. upload prep: an iCloud download + compress) can finish after the user backgrounds
// the app. iOS grants ~30s–3min; the actual file uploads use a background URLSession and
// continue beyond that. Ref-counted so concurrent builds share a single OS task.
//
// The minimise pre-grant. Apple, on beginBackgroundTask: "Call this
// method as early as possible before starting your task, preferably before your app actually
// enters the background. The method requests the task assertion for your app asynchronously. If
// you call this method shortly before your app is due to be suspended, there's a chance that the
// system might suspend your app before that task assertion is granted." JS only hears of a
// minimise after the fact (RN's AppState 'background'), and its begin() hops to main again — in
// testing, with JS busy mid-job, the process stopped a second after leaving. So while JS has ARMED it, this
// module takes one grant itself on willResignActive — before the app is in the background, on
// main, synchronously — and holds it until JS says its minimise is handled
// (`releaseMinimiseGrant`), the app is active again, or iOS expires it. All grant state is
// main-thread only.
public class ExpoContinuedTaskModule: Module {
  private var taskId: UIBackgroundTaskIdentifier = .invalid
  private var refCount = 0
  private var minimiseArmed = false
  private var minimiseGranted = false
  /// The safety net: submit the continued task at willResignActive while JS has this armed (work
  /// running, no task live). Main-thread only, like the grant state.
  private var resignNetArmed = false
  private var resignTitle = ""
  private var resignSubtitle = ""
  private var observers: [NSObjectProtocol] = []

  /// The grant's name in iOS's own logs, the config's by default (a job may name its own: `beginNamed`).
  static var defaultGrantName: String { ContinuedTaskConfig.current.grantName }

  /// Main thread only. `name` names a NEW grant; a retained one keeps the name it began with.
  private func acquire(name: String? = nil) {
    let name = name ?? ExpoContinuedTaskModule.defaultGrantName
    refCount += 1
    if taskId == .invalid {
      taskId = UIApplication.shared.beginBackgroundTask(withName: name) {
        // Expiration handler: iOS is reclaiming the grant — release cleanly.
        DebugLog.log("grant", "expired", ["refCount": self.refCount, "minimise": self.minimiseGranted])
        if self.taskId != .invalid {
          UIApplication.shared.endBackgroundTask(self.taskId)
          self.taskId = .invalid
        }
        self.refCount = 0
        self.minimiseGranted = false
      }
      let remaining = UIApplication.shared.backgroundTimeRemaining
      var fields: [String: Any] = [
        "valid": taskId != .invalid, "refCount": refCount, "remaining": remaining > 86400 ? -1 : remaining,
      ]
      // Only a named grant says its name: the default grant's line is as it was.
      if name != ExpoContinuedTaskModule.defaultGrantName { fields["name"] = name }
      DebugLog.log("grant", "begin", fields)
    } else {
      DebugLog.log("grant", "retain", ["refCount": refCount])
    }
  }

  /// Main thread only.
  private func release() {
    refCount = max(0, refCount - 1)
    DebugLog.log("grant", "release", ["refCount": refCount, "ends": refCount == 0 && taskId != .invalid])
    if refCount == 0, taskId != .invalid {
      UIApplication.shared.endBackgroundTask(taskId)
      taskId = .invalid
    }
  }

  /// Main thread only.
  private func releaseMinimise() {
    guard minimiseGranted else { return }
    minimiseGranted = false
    release()
  }

  // End any outstanding grant if the module is torn down mid-task, so it can't leak.
  deinit {
    if self.taskId != .invalid {
      UIApplication.shared.endBackgroundTask(self.taskId)
      self.taskId = .invalid
    }
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoContinuedTask")

    OnCreate {
      // The debug log's app-level lines: lifecycle, power, network path (DebugLogLifecycle).
      DispatchQueue.main.async { DebugLog.startLifecycle() }
      let center = NotificationCenter.default
      // Posted on main, synchronously, as the app stops being active — before it is in the
      // background. A Control Centre pull-down posts it too; didBecomeActive hands that back.
      observers.append(center.addObserver(
        forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
      ) { [weak self] _ in
        guard let self = self else { return }
        // The continued task first: the submission needs the app still in front, and this is
        // the last moment it is. The grant below covers the gap either way.
        DebugLog.log("bgtask", "willResignActive", [
          "resignNetArmed": self.resignNetArmed, "minimiseArmed": self.minimiseArmed, "minimiseGranted": self.minimiseGranted,
        ])
        if self.resignNetArmed {
          self.resignNetArmed = false
          ContinuedTask.shared.submitAtResign(title: self.resignTitle, subtitle: self.resignSubtitle)
        }
        guard self.minimiseArmed, !self.minimiseGranted else { return }
        self.minimiseGranted = true
        self.acquire()
      })
      observers.append(center.addObserver(
        forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
      ) { [weak self] _ in
        self?.releaseMinimise()
        ContinuedTask.shared.withdrawUnadoptedResign()
      })
    }

    OnDestroy {
      observers.forEach { NotificationCenter.default.removeObserver($0) }
      observers.removeAll()
    }

    Function("begin") { () -> Void in
      DispatchQueue.main.async { self.acquire() }
    }

    // The same grant, named for the job that asked (iOS's logs name the assertion).
    // `begin()` is unchanged; a JS bundle only calls this on a binary that has it.
    Function("beginNamed") { (name: String) -> Void in
      DispatchQueue.main.async { self.acquire(name: name.isEmpty ? ExpoContinuedTaskModule.defaultGrantName : name) }
    }

    // JS arms the pre-grant while it has a minimise handler that will release it — e.g. the
    // job's provider, mounted. Unarmed, nothing is held on the way out.
    Function("armMinimiseGrant") { (armed: Bool) -> Void in
      DebugLog.log("bgtask", "armMinimiseGrant", ["armed": armed])
      DispatchQueue.main.async {
        self.minimiseArmed = armed
        if !armed { self.releaseMinimise() }
      }
    }

    // The minimise has been handled (its own begin/end pair done): hand the pre-grant back.
    Function("releaseMinimiseGrant") { () -> Void in
      DebugLog.log("bgtask", "releaseMinimiseGrant")
      DispatchQueue.main.async { self.releaseMinimise() }
    }

    // Seconds of grace iOS says are left, or -1 when no grant is held. Unlike a
    // BGProcessingTask window, `backgroundTimeRemaining` is a real number the OS publishes,
    // so a job's scheduler can decide whether the chunk in flight fits in
    // the grace before minimise turns into suspension.
    Function("remaining") { () -> Double in
      if self.taskId == .invalid { return -1 }
      let remaining = UIApplication.shared.backgroundTimeRemaining
      // iOS reports .greatestFiniteMagnitude while in the foreground.
      return remaining > 86400 ? -1 : remaining
    }

    // The job's BGContinuedProcessingTask (iOS 26+). See ContinuedTask.swift.
    // `continuedSupported` false means this binary or this OS cannot run one, and the caller
    // uses the grace grant above instead.
    Function("continuedSupported") { () -> Bool in
      ContinuedTask.isSupported
    }

    AsyncFunction("continuedBegin") { (title: String, subtitle: String) -> [String: Any] in
      DebugLog.log("bgtask", "continuedBegin", ["title": title, "subtitle": subtitle])
      let result = ContinuedTask.shared.submit(title: title, subtitle: subtitle)
      DebugLog.log("bgtask", "continuedBegin.result", result)
      return result
    }
    .runOnQueue(.main)

    // A submission for another job — its own identifier prefix (permitted by a wildcard such as
    // `com.example.app.work.*`) and its own lifecycle log folder. `continuedBegin` is unchanged
    // and remains the config's default.
    AsyncFunction("continuedBeginWith") { (title: String, subtitle: String, options: [String: Any]) -> [String: Any] in
      let prefix = options["prefix"] as? String
      let logDir = options["logDir"] as? String
      DebugLog.log("bgtask", "continuedBegin", [
        "title": title, "subtitle": subtitle, "prefix": prefix.map { $0 as Any } ?? NSNull(), "logDir": logDir.map { $0 as Any } ?? NSNull(),
      ])
      let result = ContinuedTask.shared.submit(title: title, subtitle: subtitle, prefix: prefix, logDir: logDir)
      DebugLog.log("bgtask", "continuedBegin.result", result)
      return result
    }
    .runOnQueue(.main)

    Function("continuedProgress") { (completed: Double, total: Double, subtitle: String) -> Void in
      ContinuedTask.shared.progress(completed: Int64(completed), total: Int64(total), subtitle: subtitle)
    }

    // The title a planned stop leaves on the system UI, before it completes.
    Function("continuedRetitle") { (title: String, subtitle: String) -> Void in
      DebugLog.log("bgtask", "continuedRetitle", ["title": title, "subtitle": subtitle])
      ContinuedTask.shared.retitle(title: title, subtitle: subtitle)
    }

    Function("continuedEnd") { (success: Bool) -> Void in
      DebugLog.log("bgtask", "continuedEnd", ["success": success, "phase": ContinuedTask.shared.state()])
      ContinuedTask.shared.end(success: success)
    }

    // The willResignActive safety net. JS arms it while work runs with no task live,
    // with the lines the task would carry; disarming clears it.
    Function("continuedArmResign") { (armed: Bool, title: String, subtitle: String) -> Void in
      DebugLog.log("bgtask", "continuedArmResign", ["armed": armed, "title": title, "subtitle": subtitle])
      DispatchQueue.main.async {
        self.resignNetArmed = armed && ContinuedTask.isSupported
        self.resignTitle = title
        self.resignSubtitle = subtitle
      }
    }

    // What the safety net did at the last willResignActive, once: {ok, reason?}, or nil.
    Function("continuedTakeResign") { () -> [String: Any]? in
      let taken = ContinuedTask.shared.takeResign()
      DebugLog.log("bgtask", "continuedTakeResign", ["result": taken.map { $0 as Any } ?? NSNull()])
      return taken
    }

    // The ETA experiment's flag, from JS's stored flag ('on' / 'off');
    // nil returns to the build's default (on outside production).
    Function("continuedEtaEnabled") { (enabled: Bool?) -> Bool in
      ContinuedTask.setEtaEnabled(enabled)
      return ContinuedTask.etaEnabled
    }

    // Process CPU ms, for the JS debug log's work-vs-wait split. Any thread.
    Function("cpuTimeMs") { () -> Double in
      Double(DebugLog.cpuTimeMs())
    }

    Function("continuedState") { () -> String in
      ContinuedTask.shared.state()
    }

    Function("end") { () -> Void in
      DispatchQueue.main.async { self.release() }
    }
  }
}
