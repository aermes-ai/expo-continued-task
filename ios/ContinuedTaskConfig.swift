import Foundation

// The app's configuration, from the Info.plist dictionary `ExpoContinuedTask` that the package's
// config plugin writes (app.plugin.js). Every name the module uses on a device — the task
// identifier prefix, the lifecycle log's folder and file, the paused words, the grant's name,
// the ETA flag's key, and the optional native debug log — comes from here, so an app keeps the
// identifiers it already has on people's phones and a new app gets neutral ones.
struct ContinuedTaskConfig {
  struct DebugLogConfig {
    /// Folder under Documents, and the file name without `.jsonl`.
    let directory: String
    let fileName: String
    /// `src` on every line, so several writers can share one file.
    let source: String
    /// Optional App Group whose UserDefaults hold the gate (`enabledKey`) and its override.
    let appGroup: String?
    let enabledKey: String?
    let overrideKey: String?
  }

  /// A continued task's identifier is `<prefix>.<uuid>`; Info.plist must permit `<prefix>.*`.
  let taskIdentifierPrefix: String
  /// The lifecycle log: Documents/<logDirectory>/<logFileName>.
  let logDirectory: String
  let logFileName: String
  /// What an ending iOS forced (expiry, Stop, a late `end(success: false)`) says: never "Failed".
  let pausedTitle: String
  let pausedSubtitle: String
  /// UserDefaults key of the ETA experiment's flag.
  let etaDefaultsKey: String
  /// The grace grant's name in iOS's logs.
  let grantName: String
  /// The native debug log; nil (the default) writes nothing.
  let debugLog: DebugLogConfig?

  init(_ raw: [String: Any]) {
    let bundleId = Bundle.main.bundleIdentifier ?? "app"
    taskIdentifierPrefix = raw["taskIdentifierPrefix"] as? String ?? "\(bundleId).continued"
    logDirectory = raw["logDirectory"] as? String ?? "expo-continued-task"
    logFileName = raw["logFileName"] as? String ?? "continued.jsonl"
    pausedTitle = raw["pausedTitle"] as? String ?? "Paused"
    pausedSubtitle = raw["pausedSubtitle"] as? String ?? "Tap to resume"
    etaDefaultsKey = raw["etaDefaultsKey"] as? String ?? "expoContinuedTask.eta"
    grantName = raw["grantName"] as? String ?? "ExpoContinuedTask"
    if let log = raw["debugLog"] as? [String: Any] {
      debugLog = DebugLogConfig(
        directory: log["directory"] as? String ?? "expo-continued-task",
        fileName: log["fileName"] as? String ?? "native-debug",
        source: log["source"] as? String ?? "continued",
        appGroup: log["appGroup"] as? String,
        enabledKey: log["enabledKey"] as? String,
        overrideKey: log["overrideKey"] as? String
      )
    } else {
      debugLog = nil
    }
  }

  /// Read once from Info.plist. Tests (the Swift harness) set it before first use.
  static var current = ContinuedTaskConfig(
    Bundle.main.object(forInfoDictionaryKey: "ExpoContinuedTask") as? [String: Any] ?? [:]
  )
}
