// ContinuedTask behaviour harness. Run with ./run.sh; see there.
import Foundation

// An app's config, as its app.json would pass it to the config plugin: the checks below are the
// behaviour a real app shipped with names like these hard-coded, before they became config.
ContinuedTaskConfig.current = ContinuedTaskConfig([
  "taskIdentifierPrefix": "com.example.app.scan",
  "logDirectory": "example-app",
  "logFileName": "lifecycle.jsonl",
  "pausedTitle": "Paused",
  "pausedSubtitle": "Tap Resume in the app",
  "etaDefaultsKey": "exampleApp.eta",
  "grantName": "ExampleAppGrant",
])

var failures = 0
func check(_ ok: Bool, _ what: String) { print((ok ? "PASS " : "FAIL ") + what); if !ok { failures += 1 } }

// 1. iOS expires a running task mid-job.
let scan = ContinuedTask.shared
_ = scan.submit(title: "Processing", subtitle: "0 of 600 · on iPhone")
let t1 = BGTaskScheduler.shared.launchPending()
scan.progress(completed: 23000, total: 100000, subtitle: "140 of 600 · on iPhone")
t1.expirationHandler!()
check(t1.completions == [true], "expiry completes with success:true (got \(t1.completions))")
check(t1.title == "Paused" && t1.subtitle == "Tap Resume in the app", "expiry retitles Paused / Tap Resume in the app (got \(t1.title) | \(t1.subtitle))")
check(t1.progress.completedUnitCount == t1.progress.totalUnitCount && t1.progress.totalUnitCount == 100000, "expiry fills the bar (got \(t1.progress.completedUnitCount)/\(t1.progress.totalUnitCount))")
check(t1.events.last == "completed(true)" && t1.events.contains("updateTitle(Paused|Tap Resume in the app)"), "retitled before completing: \(t1.events.suffix(2))")
check(scan.state() == "expired", "phase is expired, so JS sees it stale and parks (got \(scan.state()))")

// 2. Expiry before any progress: the bar still fills (0 of 0 would read as nothing done).
_ = scan.submit(title: "Exporting", subtitle: "On this iPhone")
let t2 = BGTaskScheduler.shared.launchPending()
t2.expirationHandler!()
check(t2.completions == [true] && t2.progress.fractionCompleted == 1, "expiry with no progress: success:true, filled (\(t2.progress.completedUnitCount)/\(t2.progress.totalUnitCount))")

// 3. An old bundle's end(success: false).
_ = scan.submit(title: "Exporting", subtitle: "On this iPhone")
let t3 = BGTaskScheduler.shared.launchPending()
scan.progress(completed: 400, total: 100000, subtitle: "400 of 24,000 · on iPhone")
scan.end(success: false)
check(t3.completions == [true], "end(success:false) completes with success:true (got \(t3.completions))")
check(t3.title == "Paused" && t3.progress.fractionCompleted == 1, "end(success:false) presents paused, filled")

// 4. A planned stop JS already presented is left as JS set it.
_ = scan.submit(title: "Processing", subtitle: "x")
let t4 = BGTaskScheduler.shared.launchPending()
scan.retitle(title: "Paused · iPhone is warm", subtitle: "Tap Resume in the app")
scan.progress(completed: 100000, total: 100000, subtitle: "Tap Resume in the app")
scan.end(success: true)
check(t4.completions == [true] && t4.title == "Paused · iPhone is warm", "end(success:true) keeps JS's own paused title (got \(t4.title))")

// 5. Expiry after end: nothing more is sent.
t4.expirationHandler?()
check(t4.completions == [true], "a late expiry after end completes nothing twice")

// 6. A submission with no options is the config's default — its prefix, its log folder.
let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
func lines(_ folder: String) -> [String] {
  let url = documents.appendingPathComponent(folder).appendingPathComponent("lifecycle.jsonl")
  return ((try? String(contentsOf: url, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
}
let defaultBefore = lines("example-app").count
_ = scan.submit(title: "Exporting", subtitle: "On this iPhone")
check(BGTaskScheduler.shared.pending?.identifier.hasPrefix("com.example.app.scan.") == true,
      "no options: the default prefix (got \(BGTaskScheduler.shared.pending?.identifier ?? "nil"))")
let t6 = BGTaskScheduler.shared.launchPending()
scan.end(success: true)
check(lines("example-app").count > defaultBefore && t6.completions == [true], "no options: lifecycle in Documents/example-app/lifecycle.jsonl")

// 7. Another job: its own prefix under the work wildcard, its own log folder; the default's untouched.
try? FileManager.default.removeItem(at: documents.appendingPathComponent("uploads"))
let defaultAt = lines("example-app").count
_ = scan.submit(title: "Uploading", subtitle: "x", prefix: "com.example.app.work.uploads", logDir: "uploads")
check(BGTaskScheduler.shared.pending?.identifier.hasPrefix("com.example.app.work.uploads.") == true,
      "prefix option: the job's identifier (got \(BGTaskScheduler.shared.pending?.identifier ?? "nil"))")
let t7 = BGTaskScheduler.shared.launchPending()
scan.end(success: false)
check(t7.completions == [true], "another job's end(success:false) still completes success:true")
check(lines("uploads").contains { $0.contains("\"submitted\"") }, "logDir option: the job's lifecycle in Documents/uploads")
check(lines("example-app").count == defaultAt, "logDir option: nothing in the default log")

// 8. The next plain submission is the default's again.
_ = scan.submit(title: "Processing", subtitle: "x")
check(BGTaskScheduler.shared.pending?.identifier.hasPrefix("com.example.app.scan.") == true, "options do not stick")
_ = BGTaskScheduler.shared.launchPending()
scan.end(success: true)
check(lines("example-app").count > defaultAt, "and it logs to the default folder again")

// 9. Another app's config (none of the names above): its prefix, its log file, its paused words.
ContinuedTaskConfig.current = ContinuedTaskConfig([
  "taskIdentifierPrefix": "com.example.app.work", "logDirectory": "example", "logFileName": "continued.jsonl",
  "pausedSubtitle": "Tap to resume",
])
try? FileManager.default.removeItem(at: documents.appendingPathComponent("example"))
_ = scan.submit(title: "Exporting", subtitle: "x")
check(BGTaskScheduler.shared.pending?.identifier.hasPrefix("com.example.app.work.") == true, "config: the app's own prefix")
let t9 = BGTaskScheduler.shared.launchPending()
t9.expirationHandler!()
check(t9.completions == [true] && t9.title == "Paused" && t9.subtitle == "Tap to resume", "config: the app's paused words, success:true (got \(t9.title) | \(t9.subtitle))")
let exampleLog = documents.appendingPathComponent("example/continued.jsonl")
check(((try? String(contentsOf: exampleLog, encoding: .utf8)) ?? "").contains("\"expired\""), "config: the lifecycle in Documents/example/continued.jsonl")

// 10. No config at all: neutral defaults.
let neutral = ContinuedTaskConfig([:])
check(neutral.pausedTitle == "Paused" && neutral.pausedSubtitle == "Tap to resume" && neutral.logDirectory == "expo-continued-task"
      && neutral.logFileName == "continued.jsonl" && neutral.debugLog == nil && neutral.taskIdentifierPrefix.hasSuffix(".continued"),
      "defaults are neutral: no app's names, debug log off")

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
