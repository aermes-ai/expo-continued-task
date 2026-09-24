import Foundation
import Network
import os
import UIKit

// The app-process half of DebugLog: lifecycle notifications, power changes and the
// network path. Not for app extensions — see DebugLog.swift.
extension DebugLog {
  static func appStateString(_ state: UIApplication.State) -> String {
    switch state {
    case .active: return "active"
    case .inactive: return "inactive"
    case .background: return "background"
    @unknown default: return "unknown"
    }
  }

  // MARK: - Lifecycle, power and network (the app process only)

  private static var observers: [NSObjectProtocol] = []
  private static var pathMonitor: NWPathMonitor?

  /// Call once, on main. Logs every app lifecycle notification, thermal / Low Power / battery
  /// change, and every network path update with its raw values.
  static func startLifecycle() {
    guard enabled, observers.isEmpty, src != "widget" else { return }
    mainThread = pthread_mach_thread_np(pthread_self())
    UIDevice.current.isBatteryMonitoringEnabled = true
    setAppState(appStateString(UIApplication.shared.applicationState))
    log("app", "debug.start", [
      "channel": expoChannel() ?? NSNull(),
      "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "",
      "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
      "mb": footprintMb(), "thermal": thermal(), "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
    ].merging(battery()) { first, _ in first })

    let center = NotificationCenter.default
    let lifecycle: [(Notification.Name, String, String?)] = [
      (UIApplication.willResignActiveNotification, "willResignActive", "inactive"),
      (UIApplication.didEnterBackgroundNotification, "didEnterBackground", "background"),
      (UIApplication.willEnterForegroundNotification, "willEnterForeground", "inactive"),
      (UIApplication.didBecomeActiveNotification, "didBecomeActive", "active"),
      (UIApplication.willTerminateNotification, "willTerminate", nil),
      (UIApplication.didReceiveMemoryWarningNotification, "didReceiveMemoryWarning", nil),
      (UIApplication.protectedDataWillBecomeUnavailableNotification, "protectedDataWillBecomeUnavailable", nil),
      (UIApplication.protectedDataDidBecomeAvailableNotification, "protectedDataDidBecomeAvailable", nil),
    ]
    for (name, ev, state) in lifecycle {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
        if let state = state { setAppState(state) }
        let app = UIApplication.shared
        let remaining = app.backgroundTimeRemaining
        log("app", ev, [
          "appState": appStateString(app.applicationState),
          "backgroundTimeRemaining": remaining > 86400 ? -1 : remaining,
          "mb": footprintMb(), "thermal": thermal(),
          // By kind at every transition: what leaving gives back, and what returning re-inflates.
          "vm": footprintBreakdown(),
        ])
      })
    }
    observers.append(center.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil) { _ in
      log("power", "thermal", ["thermal": thermal()])
    })
    observers.append(center.addObserver(forName: Notification.Name.NSProcessInfoPowerStateDidChange, object: nil, queue: nil) { _ in
      log("power", "lowPower", ["lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled])
    })
    observers.append(center.addObserver(forName: UIDevice.batteryStateDidChangeNotification, object: nil, queue: .main) { _ in
      log("power", "battery", battery())
    })

    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { path in
      let status: String
      switch path.status {
      case .satisfied: status = "satisfied"
      case .unsatisfied: status = "unsatisfied"
      case .requiresConnection: status = "requiresConnection"
      @unknown default: status = "unknown"
      }
      let kinds: [(NWInterface.InterfaceType, String)] = [
        (.wifi, "wifi"), (.cellular, "cellular"), (.wiredEthernet, "wired"), (.loopback, "loopback"), (.other, "other"),
      ]
      log("net", "path", [
        "status": status,
        "isExpensive": path.isExpensive,
        "isConstrained": path.isConstrained,
        "interfaces": path.availableInterfaces.map { iface in kinds.first { $0.0 == iface.type }?.1 ?? "unknown" },
        "uses": kinds.filter { path.usesInterfaceType($0.0) }.map { $0.1 },
        "unsatisfiedReason": unsatisfiedReason(path),
      ])
    }
    monitor.start(queue: DispatchQueue(label: "expo-continued-task.debuglog.path"))
    pathMonitor = monitor

    // System memory pressure: "when resources become constrained" is when iOS picks which
    // continued task to end, and until now nothing said whether they were.
    let pressure = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: DispatchQueue.global(qos: .utility))
    pressure.setEventHandler {
      let event = pressure.data
      let level = event.contains(.critical) ? "critical" : event.contains(.warning) ? "warning" : "normal"
      var fields: [String: Any] = ["level": level, "mb": footprintMb(), "availableMb": availableMb()]
      fields["vm"] = footprintBreakdown()
      log("mem", "pressure", fields)
    }
    pressure.resume()
    pressureSource = pressure
  }

  private static var pressureSource: DispatchSourceMemoryPressure?
  /// The main thread's Mach port, taken on main by `startLifecycle`.
  private static var mainThread: mach_port_t = 0

  // MARK: - Where the CPU went

  /**
   * Where the footprint is, by kind. Measured on device, the background footprint sat at
   * 470–540 MB while the JS heap and its buffers were ~130–200 MB; the rest could not be named.
   * `graphics` is IOSurface/Metal (decoded images, map tiles), `internal` is anonymous memory
   * (malloc, JS heaps), `compressed` what the compressor holds, `mallocInUse` the malloc zones'
   * live bytes, `neural`/`media` the Neural Engine and media footprint counters. MB each.
   */
  static func footprintBreakdown() -> [String: Any] {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    guard result == KERN_SUCCESS else { return ["vm": "unavailable"] }
    func mb<T: BinaryInteger>(_ bytes: T) -> Double { (Double(bytes) / 1_048_576 * 10).rounded() / 10 }
    var stats = malloc_statistics_t()
    malloc_zone_statistics(nil, &stats)
    return [
      "footprint": mb(info.phys_footprint),
      "internal": mb(info.internal),
      "compressed": mb(info.compressed),
      "external": mb(info.external),
      "purgeable": mb(info.purgeable_volatile_pmap),
      "graphics": mb(info.ledger_tag_graphics_footprint),
      "neural": mb(info.ledger_tag_neural_footprint),
      "media": mb(info.ledger_tag_media_footprint),
      "mallocInUse": mb(stats.size_in_use),
    ]
  }

  /// Memory iOS says this process can still take before it is at its limit, MB (os_proc_available_memory).
  static func availableMb() -> Double {
    if #available(iOS 13.0, *) {
      return (Double(os_proc_available_memory()) / 1_048_576 * 10).rounded() / 10
    }
    return -1
  }

  /// The task's role as the scheduler sees it (TASK_CATEGORY_POLICY): foreground, background, …
  static func taskRole() -> String {
    var policy = task_category_policy_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_category_policy_data_t>.size / MemoryLayout<integer_t>.size)
    var getDefault: boolean_t = 0
    let result = withUnsafeMutablePointer(to: &policy) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_policy_get(mach_task_self_, task_policy_flavor_t(TASK_CATEGORY_POLICY), $0, &count, &getDefault)
      }
    }
    guard result == KERN_SUCCESS else { return "unknown(\(result))" }
    switch policy.role {
    case TASK_RENICED: return "reniced"
    case TASK_UNSPECIFIED: return "unspecified"
    case TASK_FOREGROUND_APPLICATION: return "foreground"
    case TASK_BACKGROUND_APPLICATION: return "background"
    case TASK_CONTROL_APPLICATION: return "control"
    case TASK_GRAPHICS_SERVER: return "graphics"
    case TASK_THROTTLE_APPLICATION: return "throttle"
    case TASK_NONUI_APPLICATION: return "nonui"
    case TASK_DEFAULT_APPLICATION: return "default"
    default: return "role(\(policy.role.rawValue))"
    }
  }

  private static func runState(_ state: integer_t) -> String {
    switch state {
    case TH_STATE_RUNNING: return "running"
    case TH_STATE_STOPPED: return "stopped"
    case TH_STATE_WAITING: return "waiting"
    case TH_STATE_UNINTERRUPTIBLE: return "uninterruptible"
    case TH_STATE_HALTED: return "halted"
    default: return "state(\(state))"
    }
  }

  /// One thread's reading: CPU share now, run state, seconds asleep, CPU used in total (ms).
  private static func threadReading(_ thread: thread_act_t) -> [String: Any]? {
    var info = thread_basic_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        thread_info(thread, thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
      }
    }
    guard result == KERN_SUCCESS else { return nil }
    let cpuMs = Int64(info.user_time.seconds) * 1000 + Int64(info.user_time.microseconds) / 1000
      + Int64(info.system_time.seconds) * 1000 + Int64(info.system_time.microseconds) / 1000
    return [
      "cpu": (Double(info.cpu_usage) / Double(TH_USAGE_SCALE) * 1000).rounded() / 10,
      "state": runState(info.run_state),
      "sleepS": info.sleep_time,
      "cpuMs": cpuMs,
    ]
  }

  private static func threadName(_ thread: thread_act_t) -> String {
    guard let pthread = pthread_from_mach_thread_np(thread) else { return "" }
    var buffer = [CChar](repeating: 0, count: 128)
    pthread_getname_np(pthread, &buffer, buffer.count)
    return String(cString: buffer)
  }

  /**
   * The threads that matter, read now: main, the JS thread, and the three busiest. In one run
   * on device the process got ~2 % of a CPU while main lagged 7 s, and whether that was starvation or a
   * thread blocked on something could not be told; `state` and `cpu` per thread tell it.
   */
  static func threadsSnapshot() -> [String: Any] {
    var list: thread_act_array_t?
    var count: mach_msg_type_number_t = 0
    guard task_threads(mach_task_self_, &list, &count) == KERN_SUCCESS, let threads = list else {
      return ["threads": "unavailable"]
    }
    defer {
      for i in 0..<Int(count) { mach_port_deallocate(mach_task_self_, threads[i]) }
      vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: threads)),
                    vm_size_t(Int(count) * MemoryLayout<thread_act_t>.stride))
    }
    var main: [String: Any]?
    var js: [String: Any]?
    var busy: [[String: Any]] = []
    for i in 0..<Int(count) {
      let thread = threads[i]
      guard var reading = threadReading(thread) else { continue }
      let name = threadName(thread)
      reading["name"] = name
      if thread == mainThread || (mainThread == 0 && i == 0) { main = reading }
      if js == nil, name.contains("JavaScript") || name.contains("hermes") { js = reading }
      busy.append(reading)
    }
    busy.sort { (($0["cpu"] as? Double) ?? 0) > (($1["cpu"] as? Double) ?? 0) }
    return [
      "threads": Int(count),
      "main": main ?? NSNull(),
      "js": js ?? NSNull(),
      "busiest": Array(busy.prefix(3)),
      "role": taskRole(),
      "availableMb": availableMb(),
      "vm": footprintBreakdown(),
    ]
  }

  private static func unsatisfiedReason(_ path: NWPath) -> String {
    if #available(iOS 14.2, *) {
      switch path.unsatisfiedReason {
      case .notAvailable: return "none"
      case .cellularDenied: return "cellularDenied"
      case .wifiDenied: return "wifiDenied"
      case .localNetworkDenied: return "localNetworkDenied"
      @unknown default: return "unknown"
      }
    }
    return "unavailable"
  }
}
