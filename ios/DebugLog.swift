import Foundation
import UIKit

// The test-build debug log, native side.
//
// An app's JS debug writer can append to e.g. Documents/<directory>/debug.jsonl; this appends
// the same line shape to Documents/<directory>/native-debug.jsonl, so a pull script can sort
// both into one timeline:
//
//   {"t": wall ms, "m": monotonic ms, "launch": id, "seq": n, "src": "bgtask", "app": state,
//    "cat": "...", "ev": "...", ...fields}
//
// One file per pod would be simpler to reason about; one file for the whole app is simpler to
// pull. Each line is ONE `write` on an O_APPEND descriptor, so writers in other pods (a copy of
// this file with its own `src`) and other queues cannot interleave inside a line.
//
// Written before returning, never queued: the point of the file is the last line before iOS
// suspends or kills the process, and an async append is exactly what goes missing then.
//
// App-process only (lifecycle notifications, NWPathMonitor): DebugLogLifecycle.swift. An app
// extension (the widget) copies this file alone — `UIApplication.shared` does not compile there.
//
// Pods cannot share a Swift file without depending on each other, so this file can be COPIED
// verbatim into each pod that logs, with only `src` differing (e.g. "continued" here, another
// native module's own name, "widget" for a widget extension — the widget writes to the App
// Group container instead, see `directory`).
//
// Gate: ON unless the build's update channel (Expo.plist EXUpdatesRequestHeaders
// expo-channel-name) is "production"; with no channel, ON only for a sandbox receipt
// (beta-testing / development builds). An App Group Bool at `overrideKey` wins. The app writes
// the result to the App Group at `enabledKey` for the widget, which cannot read Expo.plist.
enum DebugLog {
  /// Every name from the app's configuration (ContinuedTaskConfig.debugLog); with none, off.
  private static let config = ContinuedTaskConfig.current.debugLog
  static let src = config?.source ?? "continued"

  static let appGroup = config?.appGroup ?? ""
  static let enabledKey = config?.enabledKey ?? ""
  static let overrideKey = config?.overrideKey ?? ""
  static let maxBytes: UInt64 = 20 * 1024 * 1024
  static let launch = Int64(Date().timeIntervalSince1970 * 1000)

  private static let lock = NSLock()
  private static var seq: Int64 = 0
  /// The app's state as the lifecycle observers last saw it; `applicationState` is main-only.
  private static var appState = "unknown"

  /// The widget asks the App Group on every line: its process can start before the
  /// app has written the flag and outlive the write, and a `static let` kept the first answer for
  /// good. The app process decides once, from its own build.
  static var enabled: Bool { config == nil ? false : (src == "widget" ? widgetEnabled() : appEnabled) }

  static func widgetEnabled() -> Bool {
    let group = UserDefaults(suiteName: appGroup)
    if let forced = group?.object(forKey: overrideKey) as? Bool { return forced }
    return group?.bool(forKey: enabledKey) ?? false
  }

  private static let appEnabled: Bool = {
    let group = appGroup.isEmpty ? nil : UserDefaults(suiteName: appGroup)
    if !overrideKey.isEmpty, let forced = group?.object(forKey: overrideKey) as? Bool { return forced }
    let on: Bool
    if let channel = expoChannel() {
      on = channel != "production"
    } else {
      on = Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
    }
    if !enabledKey.isEmpty { group?.set(on, forKey: enabledKey) }
    return on
  }()

  static func expoChannel() -> String? {
    guard let url = Bundle.main.url(forResource: "Expo", withExtension: "plist"),
          let plist = NSDictionary(contentsOf: url) as? [String: Any],
          let headers = plist["EXUpdatesRequestHeaders"] as? [String: Any] else { return nil }
    return headers["expo-channel-name"] as? String
  }

  private static var directory: URL? {
    let base: URL?
    if src == "widget" {
      base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    } else {
      base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    }
    guard let root = base else { return nil }
    let dir = root.appendingPathComponent(config?.directory ?? "expo-continued-task", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private static var fileName: String { src == "widget" ? "widget-debug" : (config?.fileName ?? "native-debug") }

  static func setAppState(_ state: String) {
    lock.lock()
    appState = state
    lock.unlock()
  }

  /// One line. Never throws; a no-op when the gate is off.
  static func log(_ cat: String, _ ev: String, _ fields: [String: Any] = [:]) {
    guard enabled, let dir = directory else { return }
    lock.lock()
    seq += 1
    var record: [String: Any] = [
      "t": Int64(Date().timeIntervalSince1970 * 1000),
      "m": Int64(ProcessInfo.processInfo.systemUptime * 1000),
      "c": cpuTimeMs(),
      "launch": launch,
      "seq": seq,
      "src": src,
      "app": appState,
      "cat": cat,
      "ev": ev,
    ]
    for (key, value) in fields { record[key] = JSONSerialization.isValidJSONObject([value]) ? value : String(describing: value) }
    defer { lock.unlock() }
    guard let data = try? JSONSerialization.data(withJSONObject: record),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    let url = dir.appendingPathComponent("\(fileName).jsonl")
    rotateIfNeeded(url, dir: dir)
    let fd = open(url.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    guard fd >= 0 else { return }
    defer { close(fd) }
    _ = line.withCString { pointer in write(fd, pointer, strlen(pointer)) }
  }

  private static func rotateIfNeeded(_ url: URL, dir: URL) {
    guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? UInt64,
          size > maxBytes else { return }
    let old = dir.appendingPathComponent("\(fileName).1.jsonl")
    try? FileManager.default.removeItem(at: old)
    try? FileManager.default.moveItem(at: url, to: old)
  }

  // MARK: - Readings

  /// This process's CPU time so far, user + system, in ms. On every line as `c`: a gap in
  /// `t` with none in `c` is time the process was suspended or blocked, not working.
  static func cpuTimeMs() -> Int64 {
    var usage = rusage()
    guard getrusage(RUSAGE_SELF, &usage) == 0 else { return -1 }
    let user = Int64(usage.ru_utime.tv_sec) * 1000 + Int64(usage.ru_utime.tv_usec) / 1000
    let system = Int64(usage.ru_stime.tv_sec) * 1000 + Int64(usage.ru_stime.tv_usec) / 1000
    return user + system
  }

  /// `phys_footprint` in MB — the number jetsam compares — or -1.
  static func footprintMb() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    guard result == KERN_SUCCESS else { return -1 }
    return (Double(info.phys_footprint) / 1_048_576 * 10).rounded() / 10
  }

  static func thermal() -> String {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }

  /// Battery, from UIDevice (main thread; monitoring switched on by `startLifecycle`).
  static func battery() -> [String: Any] {
    let device = UIDevice.current
    let state: String
    switch device.batteryState {
    case .charging: state = "charging"
    case .full: state = "full"
    case .unplugged: state = "unplugged"
    default: state = "unknown"
    }
    return ["battery": state, "charging": device.batteryState == .charging || device.batteryState == .full,
            "level": device.batteryLevel]
  }
}
