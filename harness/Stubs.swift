// A fake BackgroundTasks, recording what the task is told: the harness drives ContinuedTask's
// real code through submit → launch → expiry / end.
import Foundation

class BGTask {
  var expirationHandler: (() -> Void)?
  var completions: [Bool] = []
  var events: [String] = []
  func setTaskCompleted(success: Bool) { completions.append(success); events.append("completed(\(success))") }
}

final class BGContinuedProcessingTask: BGTask {
  private(set) var title: String
  private(set) var subtitle: String
  let progress = Progress(totalUnitCount: 0)
  init(title: String, subtitle: String) { self.title = title; self.subtitle = subtitle }
  func updateTitle(_ title: String, subtitle: String) {
    self.title = title; self.subtitle = subtitle; events.append("updateTitle(\(title)|\(subtitle))")
  }
}

class BGTaskRequest { let identifier: String; init(identifier: String) { self.identifier = identifier } }
final class BGContinuedProcessingTaskRequest: BGTaskRequest {
  enum SubmissionStrategy { case fail, queue }
  var strategy: SubmissionStrategy = .queue
  let title: String
  let subtitle: String
  init(identifier: String, title: String, subtitle: String) {
    self.title = title; self.subtitle = subtitle; super.init(identifier: identifier)
  }
}

final class BGTaskScheduler {
  static let shared = BGTaskScheduler()
  var handlers: [String: (BGTask) -> Void] = [:]
  var launchedTask: BGContinuedProcessingTask?
  func register(forTaskWithIdentifier id: String, using: DispatchQueue?, launchHandler: @escaping (BGTask) -> Void) -> Bool {
    handlers[id] = launchHandler; return true
  }
  func submit(_ request: BGTaskRequest) throws {
    guard let r = request as? BGContinuedProcessingTaskRequest else { return }
    pending = r
  }
  var pending: BGContinuedProcessingTaskRequest?
  /// iOS launches the task after `submit` returns, as it does on device.
  func launchPending() -> BGContinuedProcessingTask {
    let r = pending!
    pending = nil
    let task = BGContinuedProcessingTask(title: r.title, subtitle: r.subtitle)
    launchedTask = task
    handlers[r.identifier]?(task)
    return task
  }
}
