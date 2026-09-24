import BackgroundTasks
import Foundation
import UIKit

// A BGContinuedProcessingTask around a long, user-started job (iOS 26+).
//
// The job is user-started foreground work that the user then leaves: exactly the case iOS 26
// added this task for. Submitted while the app is in front, it keeps the process running after
// a minimise and shows a system progress UI (done / total), until the work ends or iOS expires
// it — the user can cancel it from that UI, which also arrives as expiry.
//
// This class owns the TASK, not the work. The work is the JS job's unit loop; it asks
// `isRunning` at every unit boundary and parks the moment it turns false. So:
//
//   submit   register a fresh identifier, then submit the request (`.fail`: a job is worth
//            continuing now or not at all; a queued one would start after the work had parked).
//   launch   iOS hands the task over. Hold it and install the expiration handler.
//   progress completed/total per committed unit, onto `task.progress` and the subtitle.
//   expire   complete the task at once (a late completion is what gets an app killed) and flip
//            `isRunning` so the job parks at its next unit boundary.
//   end      the work finished or parked: complete the task. Never left running after.
//
// Never "Failed" (a product requirement). iOS's system UI says "Failed" for a task completed with
// `success: false`, so no path here passes false: an expiry (or Stop in the system UI) and an
// `end(success: false)` are presented as the planned stop JS already shows — retitled "Paused"
// over "Tap Resume in the app", the bar filled — and completed as a success. The real cause stays
// in the lifecycle log (`expired`, `ended {requested: false}`) and JS parks for Resume.
//
// Everything iOS 26 is behind `#if compiler(>=6.2)` as well as `#available`: the SDK that has
// these types ships with Swift 6.2 (Xcode 26), and an older Xcode must still build this module.
// There it compiles to the unsupported stub, and the JS falls back to the grace grant.
//
// API names and signatures were checked against Apple's BackgroundTasks documentation, not the
// SDK headers: the Xcode on the machine this was written on had only the iOS 18.2 SDK.
//
// Lifecycle log. A build in testing showed Apple's banner saying the task had failed, and
// nothing could say when or why. Every step now appends one line to
// Documents/<logDirectory>/<logFileName> — a file `devicectl` can pull off the device — as
// {kind:"continued", event, success?, completed, total, at, id}:
//   submitted | submit_failed | launched | progress_first | expired | ended
//   resign | resign_withdrawn   (the willResignActive safety net; see below)
//   progress (at most once per tick) | tick {sinceProgressMs} (every tick while running)
//
// The willResignActive safety net. The JS asks for the task whenever owed work
// starts in front; this is for work that is running with no task when the user leaves anyway.
// While JS has it ARMED (work running, no task live), the module's willResignActive observer
// submits here — on main, synchronously, while the app is still the foregrounded one, which is
// the only time iOS accepts a submission. The result waits in `resignResult` until JS, on its
// 'background' turn, takes it and adopts the task (`takeResign`). A resign that was only a
// Control Centre pull-down — the app back to active without JS ever adopting — is withdrawn on
// didBecomeActive, so no task is left running with nobody reporting its progress.
final class ContinuedTask {
  static let shared = ContinuedTask()

  /// Must match the wildcard in Info.plist's BGTaskSchedulerPermittedIdentifiers,
  /// e.g. `com.example.app.work.*` — a continued-processing identifier is the
  /// bundle id, optional context, and a submission-specific suffix.
  static var identifierPrefix: String { ContinuedTaskConfig.current.taskIdentifierPrefix }

  /// The lifecycle log's folder under Documents, the config's by default. Another job may
  /// submit under its own prefix — which must match a permitted wildcard, e.g.
  /// `com.example.app.work.*` — and log to its own folder; each submission says, and one
  /// without options is exactly the config's default.
  static var defaultLogDir: String { ContinuedTaskConfig.current.logDirectory }

  /// The planned-stop words, for an ending JS did not present itself (an expiry, an old bundle's
  /// `end(success: false)`). Keep them the same as the JS side's paused words.
  static var pausedTitle: String { ContinuedTaskConfig.current.pausedTitle }
  static var pausedSubtitle: String { ContinuedTaskConfig.current.pausedSubtitle }

  enum Phase: String {
    case none, pending, running, expired, ended
  }

  // All state behind one lock: submit runs on main, `state()` on the JS thread, the expiration
  // handler on whatever queue iOS picks.
  private let lock = NSLock()
  private var phase: Phase = .none
  private var identifier: String?
  private var task: BGTask?
  private var completed: Int64 = 0
  private var total: Int64 = 0
  private var subtitle = ""
  private var loggedFirstProgress = false
  /// When `progress` last arrived, and when a progress line was last written.
  private var lastProgressAt: Date?
  private var lastProgressLogAt: Date?
  /// While the task runs: a line every `tickSeconds`, whatever JS is doing. In one run in
  /// testing the task ran five minutes with nothing in any log; ticks with no progress say JS
  /// stalled, no ticks at all say the process was suspended.
  private var ticker: DispatchSourceTimer?
  /// 10 s (was 30): the gap between the last progress and an expiry, measured on device, was
  /// ~27 s, inside one 30 s tick.
  static let tickSeconds = 10
  /// The last willResignActive submission's result, until JS takes it (`takeResign`).
  private var resignResult: [String: Any]?
  /// A resign submission JS has not adopted yet: withdrawn if the app comes back without leaving.
  private var resignUnadopted = false
  private let logQueue = DispatchQueue(label: "expo-continued-task.lifecycle.log")
  /// The folder the current submission logs to (`defaultLogDir` unless it asked otherwise).
  private var logDir = ContinuedTask.defaultLogDir

  // MARK: ETA experiment
  //
  // iOS prompts "…is 28% complete. Do you want to continue…?" when "progression is slower than
  // expected" (WWDC25 227) and does not say how it forms that expectation. NSProgress has an
  // `estimatedTimeRemaining` we never set; this sets it from a moving average of the bar's real
  // rate, so an A/B can say whether iOS reads it. Behind `etaEnabled`: the UserDefaults key
  // `etaDefaultsKey` when JS has set it (the stored flag), else on outside production.
  static var etaKey: String { ContinuedTaskConfig.current.etaDefaultsKey }
  static var etaEnabled: Bool {
    if let set = UserDefaults.standard.object(forKey: etaKey) as? Bool { return set }
    return DebugLog.expoChannel() != "production"
  }
  /// Samples at least this far apart feed the average, so one fast report cannot swing it.
  static let etaSampleSeconds: TimeInterval = 5
  private var etaSample: (at: Date, fraction: Double)?
  /// Fraction per second, averaged; nil until two samples.
  private var etaRate: Double?
  /// What was last set on the task, for the tick's line.
  private var etaSet: TimeInterval?

  static var isSupported: Bool {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) { return true }
    #endif
    return false
  }

  /// Call on the main queue, from a user action, while the app is in front.
  func submit(
    title: String, subtitle: String, source: String = "js", prefix: String? = nil, logDir dir: String? = nil
  ) -> [String: Any] {
    guard ContinuedTask.isSupported else { return ["ok": false, "reason": "unsupported"] }
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      lock.lock()
      let busy = phase == .pending || phase == .running
      lock.unlock()
      if busy { return ["ok": true, "reason": "already"] }

      // Its folder before its first line: a job's lifecycle lands in its own log.
      lock.lock()
      logDir = dir ?? ContinuedTask.defaultLogDir
      lock.unlock()
      // A fresh suffix per submission: registering the same identifier twice kills the app,
      // and a job can be started more than once in a session.
      let id = "\(prefix ?? ContinuedTask.identifierPrefix).\(UUID().uuidString)"
      let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: nil) { [weak self] task in
        self?.launched(task, id: id)
      }
      guard registered else {
        log("submit_failed", ["reason": "identifierNotPermitted", "source": source])
        return ["ok": false, "reason": "identifierNotPermitted"]
      }

      let request = BGContinuedProcessingTaskRequest(identifier: id, title: title, subtitle: subtitle)
      request.strategy = .fail
      do {
        try BGTaskScheduler.shared.submit(request)
      } catch {
        log("submit_failed", ["reason": "submitFailed", "error": String(describing: error), "source": source])
        return ["ok": false, "reason": "submitFailed", "error": String(describing: error)]
      }
      lock.lock()
      phase = .pending
      identifier = id
      task = nil
      completed = 0
      total = 0
      self.subtitle = subtitle
      loggedFirstProgress = false
      etaSample = nil
      etaRate = nil
      etaSet = nil
      lock.unlock()
      log("submitted", ["id": id, "source": source])
      return ["ok": true]
    }
    #endif
    return ["ok": false, "reason": "unsupported"]
  }

  /// The safety net: submit at willResignActive (main, synchronous). Never throws.
  func submitAtResign(title: String, subtitle: String) {
    let result = submit(title: title, subtitle: subtitle, source: "resign")
    let accepted = (result["ok"] as? Bool) == true && result["reason"] == nil
    lock.lock()
    resignResult = result
    resignUnadopted = accepted
    lock.unlock()
    var line: [String: Any] = ["ok": accepted]
    if let reason = result["reason"] { line["reason"] = reason }
    log("resign", line)
  }

  /// JS, on the way out: what the safety net did, once. Nil when it did nothing.
  func takeResign() -> [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    let result = resignResult
    resignResult = nil
    resignUnadopted = false
    return result
  }

  /// didBecomeActive: a resign submission nobody adopted was a pull-down, not a leave. End it.
  func withdrawUnadoptedResign() {
    lock.lock()
    let withdraw = resignUnadopted
    resignUnadopted = false
    resignResult = nil
    lock.unlock()
    guard withdraw else { return }
    log("resign_withdrawn")
    end(success: true)
  }

  /// Per committed unit. Before the launch it is remembered and applied on launch.
  func progress(completed: Int64, total: Int64, subtitle: String) {
    lock.lock()
    let phaseNow = phase
    lock.unlock()
    // Every report, with what it found — the lifecycle log keeps one per tick.
    DebugLog.log("continued", "progress.call", [
      "completed": completed, "total": total, "subtitle": subtitle, "phase": phaseNow.rawValue,
    ])
    lock.lock()
    guard phase == .pending || phase == .running else { lock.unlock(); return }
    self.completed = max(0, completed)
    self.total = max(0, total)
    self.subtitle = subtitle
    let held = task
    let now = Date()
    lastProgressAt = now
    if total > 0 { noteRate(fraction: Double(max(0, completed)) / Double(total), at: now) }
    let logIt = lastProgressLogAt.map { now.timeIntervalSince($0) >= Double(ContinuedTask.tickSeconds) } ?? true
    if logIt { lastProgressLogAt = now }
    lock.unlock()
    if let held = held { apply(held) }
    if logIt { log("progress") }
  }

  /// Retitle the system UI before a planned stop completes the task: "Paused — iPhone is warm"
  /// over a stopped bar, where the running phase's title read as "Failed" on device.
  func retitle(title: String, subtitle: String) {
    lock.lock()
    if !subtitle.isEmpty { self.subtitle = subtitle }
    let line = self.subtitle
    lock.unlock()
    log("retitled", ["title": title])
    #if compiler(>=6.2)
    lock.lock()
    let held = task
    lock.unlock()
    // The same call `apply` makes every progress report, with the title changed.
    if #available(iOS 26.0, *), let continued = held as? BGContinuedProcessingTask {
      continued.updateTitle(title, subtitle: line)
      DebugLog.log("continued", "updateTitle", ["title": title, "subtitle": line, "from": "retitle"])
    } else {
      DebugLog.log("continued", "updateTitle.skipped", ["title": title, "held": held != nil])
    }
    #else
    _ = line
    #endif
  }

  /// The work finished or parked. Idempotent. `success: false` is what JS asked for, not what
  /// iOS is told: that ending is presented as paused and completed as a success (never "Failed").
  func end(success: Bool) {
    lock.lock()
    let held = task
    let before = phase
    let wasLive = phase == .pending || phase == .running
    if wasLive { phase = .ended }
    task = nil
    identifier = nil
    lock.unlock()
    stopTicker()
    // Written BEFORE the task is completed: completing it can be the last thing a backgrounded
    // process does before iOS suspends it (a build in testing had no `ended` line). An end that finds
    // the task already expired is logged too, with what it found.
    log("ended", ["success": true, "requested": success, "launched": held != nil, "wasLive": wasLive,
                  "phaseBefore": before.rawValue])
    // A pending task that launches after this completes itself in `launched`.
    if let held = held {
      if !success { presentPaused(held, from: "end") }
      DebugLog.log("continued", "setTaskCompleted", ["success": true, "requested": success, "from": "end"])
      held.setTaskCompleted(success: true)
    }
  }

  /// `phase` as a string, for the JS side's page-boundary check.
  func state() -> String {
    lock.lock()
    defer { lock.unlock() }
    return phase.rawValue
  }

  private func launched(_ launchedTask: BGTask, id: String) {
    lock.lock()
    guard id == identifier, phase == .pending else {
      lock.unlock()
      // Stale, or the work already ended before iOS got round to starting it.
      DebugLog.log("continued", "setTaskCompleted", ["success": true, "from": "launched_stale", "id": id])
      launchedTask.setTaskCompleted(success: true)
      return
    }
    phase = .running
    task = launchedTask
    lock.unlock()
    log("launched", ["id": id])
    startTicker()
    launchedTask.expirationHandler = { [weak self] in self?.expire(id: id) }
    apply(launchedTask)
  }

  private func expire(id: String) {
    // First, before any state: proof the handler ran at all.
    log("expiration_handler", ["id": id])
    lock.lock()
    guard id == identifier, let held = task else { lock.unlock(); return }
    phase = .expired
    task = nil
    identifier = nil
    lock.unlock()
    stopTicker()
    // iOS took it — expiry, or Stop in the system UI. The work parks for Resume, so the system UI
    // says paused, never "Failed" (a run in testing completed this with false). Logged
    // BEFORE completing, for the same reason as `end` (an earlier build had no `expired` line).
    // Only property writes before the completion: a late completion is what gets an app killed.
    log("expired", ["id": id])
    presentPaused(held, from: "expirationHandler")
    DebugLog.log("continued", "setTaskCompleted", [
      "success": true, "from": "expirationHandler", "presented": "paused", "id": id,
    ])
    held.setTaskCompleted(success: true)
  }

  /// The planned stop's face on a task about to be completed: "Paused" over "Tap Resume in
  /// the app", the bar filled — what JS's `end` does for its own stops (createContinuedTask.js).
  private func presentPaused(_ held: BGTask, from: String) {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *), let continued = held as? BGContinuedProcessingTask {
      continued.updateTitle(ContinuedTask.pausedTitle, subtitle: ContinuedTask.pausedSubtitle)
      let progress = continued.progress
      if progress.totalUnitCount <= 0 { progress.totalUnitCount = 1 }
      progress.completedUnitCount = progress.totalUnitCount
      DebugLog.log("continued", "updateTitle", [
        "title": ContinuedTask.pausedTitle, "subtitle": ContinuedTask.pausedSubtitle,
        "from": from, "completedUnitCount": progress.completedUnitCount,
      ])
      return
    }
    #endif
    DebugLog.log("continued", "updateTitle.skipped", ["title": ContinuedTask.pausedTitle, "from": from])
  }

  // MARK: - Ticks

  private func startTicker() {
    stopTicker()
    // A strict timer (no leeway coalescing) on a user-initiated queue: measured on device, the
    // utility-QoS ticks came 30-100 s apart while progress lines landed between them, so a
    // missing tick was not by itself proof of a suspension.
    let timer = DispatchSource.makeTimerSource(flags: .strict, queue: DispatchQueue.global(qos: .userInitiated))
    let every = DispatchTimeInterval.seconds(ContinuedTask.tickSeconds)
    timer.schedule(deadline: .now() + every, repeating: every, leeway: .milliseconds(100))
    timer.setEventHandler { [weak self] in
      guard let self = self else { return }
      self.lock.lock()
      let running = self.phase == .running
      let since = self.lastProgressAt.map { Int(Date().timeIntervalSince($0) * 1000) } ?? -1
      let id = self.identifier ?? ""
      self.lock.unlock()
      guard running else { return }
      // Everything readable off the main thread, now: what iOS might be
      // throttling on.
      let info = ProcessInfo.processInfo
      self.log("tick", [
        "sinceProgressMs": since,
        "id": id,
        "thermal": ContinuedTask.thermalString(info.thermalState),
        "lowPower": info.isLowPowerModeEnabled,
        "mb": DebugLog.footprintMb(),
      ])
      // Per thread, the task's role and what memory is left, off the tick's own queue.
      DebugLog.log("continued", "threads", DebugLog.threadsSnapshot())
      self.logEta()
      // What only main can say, from main: the app's state and the grace clock. A `tick` with
      // no `tick_main` after it says main was not running; `mainLagMs` says how late it ran.
      let queuedAt = Date()
      DispatchQueue.main.async {
        let app = UIApplication.shared
        let remaining = app.backgroundTimeRemaining
        var fields: [String: Any] = [
          "id": id,
          "appState": ContinuedTask.appStateString(app.applicationState),
          "backgroundTimeRemaining": remaining > 86400 ? -1 : Int(remaining),
          "mainLagMs": Int(Date().timeIntervalSince(queuedAt) * 1000),
        ]
        for (key, value) in DebugLog.battery() { fields[key] = value }
        self.log("tick_main", fields)
      }
    }
    lock.lock()
    ticker = timer
    lock.unlock()
    timer.resume()
  }

  private static func thermalString(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }

  private static func appStateString(_ state: UIApplication.State) -> String {
    switch state {
    case .active: return "active"
    case .inactive: return "inactive"
    case .background: return "background"
    @unknown default: return "unknown"
    }
  }

  private func stopTicker() {
    lock.lock()
    let timer = ticker
    ticker = nil
    lock.unlock()
    timer?.cancel()
  }

  // MARK: - Lifecycle log

  private var logURL: URL {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    lock.lock()
    let folder = logDir
    lock.unlock()
    let directory = documents.appendingPathComponent(folder, isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent(ContinuedTaskConfig.current.logFileName)
  }

  private static func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  /// One JSON line, with the progress as it stood. Written before returning — never queued behind
  /// a suspension the way an async append was in testing — and never throws.
  ///
  /// `O_APPEND` and a single `write`, not seek-then-write: other native code in the app may append
  /// to the same file from its own queue, and with O_APPEND the kernel places each write at the end, so
  /// neither writer can land on top of the other's line.
  private func log(_ event: String, _ extra: [String: Any] = [:]) {
    lock.lock()
    var record: [String: Any] = [
      "kind": "continued", "event": event, "completed": completed, "total": total,
    ]
    lock.unlock()
    record["at"] = ContinuedTask.iso(Date())
    for (key, value) in extra { record[key] = value }
    // Every lifecycle line in the debug log too, with the same fields.
    DebugLog.log("continued", event, record)
    let url = logURL
    logQueue.sync {
      guard let data = try? JSONSerialization.data(withJSONObject: record),
            var line = String(data: data, encoding: .utf8) else { return }
      line += "\n"
      let fd = open(url.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
      guard fd >= 0 else { return }
      defer { close(fd) }
      _ = line.withCString { pointer in write(fd, pointer, strlen(pointer)) }
    }
  }

  /// Under `lock`. Folds the bar's position into the rate average.
  private func noteRate(fraction: Double, at now: Date) {
    guard let sample = etaSample else { etaSample = (now, fraction); return }
    let seconds = now.timeIntervalSince(sample.at)
    guard seconds >= ContinuedTask.etaSampleSeconds else { return }
    let rate = max(0, fraction - sample.fraction) / seconds
    etaRate = etaRate.map { $0 * 0.7 + rate * 0.3 } ?? rate
    etaSample = (now, fraction)
  }

  /// Seconds to the end at the averaged rate, or nil while there is no rate to go on.
  private func etaSeconds() -> TimeInterval? {
    lock.lock()
    defer { lock.unlock() }
    guard total > 0, let rate = etaRate, rate > 0 else { return nil }
    let left = 1 - Double(completed) / Double(total)
    return min(86_400, max(1, left / rate))
  }

  /// The tick's ETA line: what the rate is, what would be set, and whether it was.
  private func logEta() {
    let eta = etaSeconds()
    lock.lock()
    let rate = etaRate
    let set = etaSet
    let fraction = total > 0 ? Double(completed) / Double(total) : 0
    lock.unlock()
    DebugLog.log("continued", "eta", [
      "enabled": ContinuedTask.etaEnabled,
      "fraction": (fraction * 100_000).rounded() / 100_000,
      "ratePerMin": rate.map { ($0 * 6000).rounded() / 100 } ?? NSNull(),
      "etaSec": eta.map { Int($0) } ?? NSNull(),
      "setSec": set.map { Int($0) } ?? NSNull(),
    ])
  }

  /// JS's stored flag: on, off, or nil to fall back to the build's default.
  static func setEtaEnabled(_ enabled: Bool?) {
    if let enabled = enabled { UserDefaults.standard.set(enabled, forKey: etaKey) }
    else { UserDefaults.standard.removeObject(forKey: etaKey) }
    DebugLog.log("continued", "eta.flag", ["enabled": enabled.map { $0 as Any } ?? NSNull(), "effective": etaEnabled])
  }

  private func apply(_ held: BGTask) {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *), let continued = held as? BGContinuedProcessingTask {
      lock.lock()
      let done = completed
      let all = total
      let line = subtitle
      lock.unlock()
      if all > 0 {
        continued.progress.totalUnitCount = all
        continued.progress.completedUnitCount = min(done, all)
        // The ETA experiment: only with a rate to go on, and only while enabled.
        if ContinuedTask.etaEnabled, let eta = etaSeconds() {
          continued.progress.estimatedTimeRemaining = eta
          lock.lock()
          etaSet = eta
          lock.unlock()
        }
        DebugLog.log("continued", "progress.applied", [
          "completedUnitCount": continued.progress.completedUnitCount,
          "totalUnitCount": continued.progress.totalUnitCount,
          "fraction": continued.progress.fractionCompleted,
        ])
        lock.lock()
        let first = !loggedFirstProgress
        loggedFirstProgress = true
        lock.unlock()
        if first { log("progress_first") }
      }
      if !line.isEmpty {
        continued.updateTitle(continued.title, subtitle: line)
        DebugLog.log("continued", "updateTitle", ["title": continued.title, "subtitle": line, "from": "apply"])
      }
    }
    #endif
  }
}
