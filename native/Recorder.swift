import AppKit
import ApplicationServices
import Carbon
import Foundation

enum RecorderError: Error { case message(String) }

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    AXUIElementSetMessagingTimeout(element, 0.02)
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success { return value }
    return nil
}
func axElement(_ value: AnyObject?) -> AXUIElement? {
    guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func elementData(_ element: AXUIElement?) -> [String: Any] {
    guard let element = element else { return [:] }
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    let subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
    var result: [String: Any] = ["role": role, "subrole": subrole]
    let secure = subrole == "AXSecureTextField"
    for (field, key) in [("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute), ("identifier", kAXIdentifierAttribute), ("placeholder", kAXPlaceholderValueAttribute)] {
        if let value = attribute(element, key) as? String { result[field] = String(value.prefix(2048)) }
    }
    if !secure, let value = attribute(element, kAXValueAttribute) as? String { result["value"] = String(value.prefix(2048)) }
    if secure { result["secure"] = true }
    return result
}

final class InputTapWorker {
    weak var owner: Recorder?
    let generation = UUID().uuidString
    private var tap: CFMachPort?
    private var thread: Thread?
    private var loop: CFRunLoop?
    private var stopped = false
    private let lock = NSLock()

    init(owner: Recorder) throws {
        self.owner = owner
        let types: [CGEventType] = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .keyDown, .scrollWheel]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, info in
            if let info = info, let copy = event.copy() {
                let worker = Unmanaged<InputTapWorker>.fromOpaque(info).takeUnretainedValue()
                let observedAt = Date()
                DispatchQueue.main.async { [weak worker] in
                    guard let worker = worker, let owner = worker.owner,
                          owner.tapWorker?.generation == worker.generation else { return }
                    owner.input(type, copy, observedAt: observedAt)
                }
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: Unmanaged.passUnretained(self).toOpaque())
        guard tap != nil else { throw RecorderError.message("macOS refused the passive event tap; recheck Input Monitoring and Accessibility.") }
    }
    func start() {
        guard let tap = tap else { return }
        let thread = Thread {
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            let current = CFRunLoopGetCurrent()
            self.lock.lock(); self.loop = current; self.lock.unlock()
            CFRunLoopAddSource(current, source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            while true {
                self.lock.lock(); let stopped = self.stopped; self.lock.unlock()
                if stopped { break }
                CFRunLoopRunInMode(.defaultMode, 0.2, false)
            }
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
            CFRunLoopRemoveSource(current, source, .commonModes)
            self.lock.lock(); self.loop = nil; self.lock.unlock()
            self.thread = nil
        }
        self.thread = thread
        thread.name = "RecordReplay.input-tap"
        thread.start()
    }
    func enable() { if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) } }
    func stop() {
        lock.lock(); stopped = true; let current = loop; lock.unlock()
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let current = current { CFRunLoopWakeUp(current) }
    }
    deinit { if let tap = tap { CFMachPortInvalidate(tap) } }
}

final class Recorder: NSObject, NSApplicationDelegate {
    var endpointFile: String
    var root: URL
    var metadata: [String: Any] = ["isRecording": false]
    var directory: URL?
    var writer: FileHandle?
    var recording = false
    var sequence = 0
    var allowedApps: Set<String> = []
    var tapWorker: InputTapWorker?
    var observer: AXObserver?
    var observerApp: AXUIElement?
    var observerPID: pid_t = 0
    var timeout: Timer?
    var sampleTimer: Timer?
    var snapshotTask: DispatchWorkItem?
    var textTask: DispatchWorkItem?
    var textBuffer = ""
    var textContext: [String: Any] = [:]
    var lastTree: [String] = []
    var lastWindow = ""
    var lastBundle = ""
    var statusItem: NSStatusItem?
    var dragOrigin: [String: Any]?
    var workspaceObserver: Any?
    let notifications = [kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification, kAXSelectedTextChangedNotification, kAXValueChangedNotification, kAXLayoutChangedNotification]

    init(endpointFile: String) {
        self.endpointFile = endpointFile
        self.root = URL(fileURLWithPath: endpointFile).deletingLastPathComponent()
        super.init()
        if let data = try? Data(contentsOf: root.appendingPathComponent("latest.json")),
           let previous = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            metadata = previous
            if previous["isRecording"] as? Bool == true {
                metadata["isRecording"] = false
                metadata["endedAt"] = timestamp()
                metadata["endReason"] = "recorder_process_exited"
                if let path = previous["sessionDirectoryPath"] as? String {
                    directory = URL(fileURLWithPath: path)
                    saveMetadata()
                }
            }
        }
    }
    func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem?.button?.title = "◌ RR"
        let menu = NSMenu()
        menu.addItem(withTitle: "Record Replay — idle", action: nil, keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        for (title, action) in [("Stop and keep recording", #selector(stopMenu)), ("Cancel and discard recording", #selector(cancelMenu))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        let quit = NSMenuItem(title: "Quit recorder", action: #selector(quitMenu), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        statusItem?.menu = menu
        DispatchQueue.global(qos: .utility).async { self.pollCommands() }
    }
    @objc func stopMenu() { _ = stop(reason: "stopped_from_menu") }
    @objc func cancelMenu() { _ = stop(reason: "cancelled") }
    @objc func quitMenu() { _ = stop(reason: "recorder_quit"); NSApp.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) { if recording { _ = stop(reason: "recorder_quit") } }

    func http(_ endpoint: [String: Any], route: String, payload: [String: Any]? = nil) -> [String: Any]? {
        guard let port = endpoint["port"] as? Int, let token = endpoint["token"] as? String,
              let url = URL(string: "http://127.0.0.1:\(port)\(route)") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 25
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let payload = payload {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        let session = URLSession(configuration: configuration)
        let semaphore = DispatchSemaphore(value: 0)
        var result: [String: Any]?
        session.dataTask(with: request) { data, _, _ in
            if let data = data { result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 27)
        session.invalidateAndCancel()
        return result
    }
    func pollCommands() {
        while true {
            autoreleasepool {
                guard let data = try? Data(contentsOf: URL(fileURLWithPath: endpointFile)),
                      let endpoint = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let command = http(endpoint, route: "/command"), let id = command["id"] as? String else {
                    Thread.sleep(forTimeInterval: 0.5)
                    return
                }
                var reply: [String: Any] = ["id": id]
                DispatchQueue.main.sync {
                    do { reply["result"] = try self.handle(command) }
                    catch RecorderError.message(let message) { reply["error"] = message }
                    catch { reply["error"] = error.localizedDescription }
                }
                _ = http(endpoint, route: "/reply", payload: reply)
            }
        }
    }
    func permissions() -> [String: Any] {
        let ax = AXIsProcessTrusted()
        let input = CGPreflightListenEventAccess()
        return ["accessibility": ax, "inputMonitoring": input, "ready": ax && input,
                "appPath": Bundle.main.bundlePath, "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
                "instructions": "Enable Record Replay in System Settings → Privacy & Security → Accessibility and Input Monitoring, then quit and restart the idle recorder. Status checks do not request permissions."]
    }
    func handle(_ command: [String: Any]) throws -> [String: Any] {
        switch command["method"] as? String {
        case "permissions": return permissions()
        case "status": return metadata
        case "start":
            var args = command["args"] as? [String: Any] ?? [:]
            args["expiresAt"] = command["expiresAt"]
            args["requestId"] = command["id"]
            return try start(args)
        case "stop": return stop(reason: "stopped")
        case "cancel": return stop(reason: "cancelled")
        case "quit":
            guard !recording else { throw RecorderError.message("Stop or cancel the active recording before restarting the recorder") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
            return ["quitting": true]
        default: throw RecorderError.message("Unknown native operation")
        }
    }
    func start(_ args: [String: Any]) throws -> [String: Any] {
        if recording { return metadata }
        guard permissions()["ready"] as? Bool == true else { throw RecorderError.message("Accessibility and Input Monitoring grants are required for Record Replay. Run recording_permissions for the exact app path.") }
        let duration = args["maxDurationSeconds"] as? Int ?? 1800
        guard duration >= 1 && duration <= 1800 else { throw RecorderError.message("Duration must be 1–1800 seconds") }
        let apps = args["appBundleIds"] as? [String] ?? []
        let alert = NSAlert()
        alert.messageText = "Record your workflow?"
        alert.informativeText = "Capture mouse actions, typed text, selected text and accessibility content for up to \(duration) seconds. Scope: \(apps.isEmpty ? "all foreground applications" : apps.joined(separator: ", ")). Use the RR menu to Stop or Cancel. Record only the intended workflow."
        alert.addButton(withTitle: "Start Recording")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { throw RecorderError.message("User declined recording") }
        if let expires = args["expiresAt"] as? Double, Date().timeIntervalSince1970 * 1000 >= expires {
            throw RecorderError.message("The start request expired before confirmation; no recording was started")
        }
        guard let requestId = args["requestId"] as? String,
              let endpointData = try? Data(contentsOf: URL(fileURLWithPath: endpointFile)),
              let endpoint = try? JSONSerialization.jsonObject(with: endpointData) as? [String: Any],
              http(endpoint, route: "/request-live?id=\(requestId)")?["alive"] as? Bool == true else {
            throw RecorderError.message("The requesting client disconnected or cancelled; no recording was started")
        }
        let worker = try InputTapWorker(owner: self)
        tapWorker = worker
        sequence = 0
        allowedApps = Set(apps)
        lastTree = []; lastWindow = ""; lastBundle = ""
        textBuffer = ""; textContext = [:]
        let sessionID = UUID().uuidString
        let session = root.appendingPathComponent("sessions").appendingPathComponent(sessionID)
        do {
            try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let events = session.appendingPathComponent("events.jsonl")
            guard FileManager.default.createFile(atPath: events.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw RecorderError.message("Could not create the event stream") }
            writer = try FileHandle(forWritingTo: events)
            directory = session
            metadata = ["sessionId": sessionID, "sessionDirectoryPath": session.path, "eventsPath": events.path,
                        "metadataPath": session.appendingPathComponent("session.json").path, "isRecording": true,
                        "startedAt": timestamp(), "maxDurationSeconds": duration, "eventCount": 0, "appBundleIds": apps,
                        "producer": "scoheart-record-replay/0.1.0"]
            recording = true
            saveMetadata()
            worker.start()
            statusItem?.button?.title = "● REC"
            statusItem?.menu?.item(at: 0)?.title = "Recording — \(duration)s maximum"
            emit(kind: "session_started", payload: [:], context: [:])
            workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in
                self.flushText(); self.snapshot(kind: "application_changed")
            }
            sampleTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in self.snapshot(kind: "ui_changed") }
            timeout = Timer.scheduledTimer(withTimeInterval: Double(duration), repeats: false) { _ in _ = self.stop(reason: "duration_limit") }
            snapshot(kind: "ui_initial")
            return metadata
        } catch {
            worker.stop(); tapWorker = nil
            throw error
        }
    }
    func stop(reason: String) -> [String: Any] {
        guard recording else { return metadata }
        flushText()
        if reason != "storage_error" { emit(kind: "session_ended", payload: ["reason": reason], context: [:]) }
        recording = false
        timeout?.invalidate(); timeout = nil
        sampleTimer?.invalidate(); sampleTimer = nil
        textTask?.cancel(); snapshotTask?.cancel()
        if let workspaceObserver = workspaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver) }
        workspaceObserver = nil
        removeObserver()
        tapWorker?.stop(); tapWorker = nil
        try? writer?.synchronize(); try? writer?.close(); writer = nil
        metadata["isRecording"] = false; metadata["endedAt"] = timestamp(); metadata["endReason"] = reason
        if reason == "cancelled", let directory = directory {
            do {
                try FileManager.default.removeItem(at: directory.appendingPathComponent("events.jsonl"))
                metadata["eventCount"] = 0
            } catch {
                metadata["endReason"] = "cancel_failed"
                metadata["discardError"] = error.localizedDescription
            }
        }
        saveMetadata()
        statusItem?.button?.title = "◌ RR"
        statusItem?.menu?.item(at: 0)?.title = "Record Replay — idle"
        return metadata
    }
    func saveMetadata() {
        guard let data = try? JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys]) else { return }
        for destination in [directory?.appendingPathComponent("session.json"), root.appendingPathComponent("latest.json")] {
            if let destination = destination {
                try? data.write(to: destination, options: .atomic)
                try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            }
        }
    }
    func emit(kind: String, payload: [String: Any], context: [String: Any]) {
        guard recording, let writer = writer else { return }
        sequence += 1
        var record = context
        record["id"] = sequence; record["timestamp"] = timestamp(); record["kind"] = kind
        for (key, value) in payload { record[key] = value }
        do {
            var data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            data.append(10)
            try writer.write(contentsOf: data)
            metadata["eventCount"] = sequence
            if sequence % 20 == 0 { saveMetadata() }
        } catch {
            metadata["writeError"] = error.localizedDescription
            _ = stop(reason: "storage_error")
        }
    }
    func context() -> ([String: Any], AXUIElement?, AXUIElement?)? {
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != getpid(), let bundle = app.bundleIdentifier,
              allowedApps.isEmpty || allowedApps.contains(bundle), !IsSecureEventInputEnabled() else { return nil }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.05)
        let focused = axElement(attribute(application, kAXFocusedUIElementAttribute))
        if let focused = focused, attribute(focused, kAXSubroleAttribute) as? String == "AXSecureTextField" { return nil }
        let window = axElement(attribute(application, kAXFocusedWindowAttribute))
        var windowData: [String: Any] = [:]
        if let window = window {
            windowData["title"] = attribute(window, kAXTitleAttribute) as? String ?? ""
            if let url = attribute(window, kAXDocumentAttribute) as? String { windowData["url"] = url }
        }
        return (["app": ["name": app.localizedName ?? bundle, "bundleIdentifier": bundle, "processIdentifier": app.processIdentifier], "window": windowData], window, focused)
    }
    func modifiers(_ event: CGEvent) -> [String] {
        let pairs: [(CGEventFlags, String)] = [(.maskCommand, "command"), (.maskControl, "control"), (.maskAlternate, "option"), (.maskShift, "shift")]
        return pairs.filter { event.flags.contains($0.0) }.map { $0.1 }
    }
    func input(_ type: CGEventType, _ event: CGEvent, observedAt: Date) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if recording { tapWorker?.enable() }
            return
        }
        guard recording else { return }
        guard let (originalInfo, _, focused) = context() else { flushText(); dragOrigin = nil; return }
        var info = originalInfo
        info["inputObservedAt"] = ISO8601DateFormatter().string(from: observedAt)
        info["inputTimestampNanoseconds"] = String(event.timestamp)
        let target = elementData(focused)
        let mods = modifiers(event)
        if type == .keyDown {
            var characters = [UniChar](repeating: 0, count: 32)
            var length = 0
            event.keyboardGetUnicodeString(maxStringLength: 32, actualStringLength: &length, unicodeString: &characters)
            let text = String(utf16CodeUnits: characters, count: length)
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            if !mods.contains("command") && !mods.contains("control") && !text.isEmpty && text.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) {
                var previous = textContext; previous.removeValue(forKey: "keyboard")
                previous.removeValue(forKey: "inputObservedAt"); previous.removeValue(forKey: "inputTimestampNanoseconds")
                if !textBuffer.isEmpty && !NSDictionary(dictionary: previous).isEqual(to: originalInfo) { flushText() }
                textContext = info
                textContext["keyboard"] = ["target": target, "modifiers": mods]
                textBuffer += text
                textTask?.cancel()
                let task = DispatchWorkItem { self.flushText() }
                textTask = task
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: task)
            } else {
                flushText()
                emit(kind: "key", payload: ["keyboard": ["keyCode": keyCode, "keyEquivalent": text, "modifiers": mods, "target": target]], context: info)
            }
        } else {
            flushText()
            var atPoint: AXUIElement?
            let point = event.location
            AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &atPoint)
            var mouse: [String: Any] = ["x": point.x, "y": point.y, "button": event.getIntegerValueField(.mouseEventButtonNumber), "modifiers": mods, "target": elementData(atPoint)]
            if [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type) { dragOrigin = mouse }
            if [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type) {
                mouse["clickCount"] = event.getIntegerValueField(.mouseEventClickState)
                if let origin = dragOrigin, let x = origin["x"] as? Double, let y = origin["y"] as? Double, hypot(x - point.x, y - point.y) > 5 { mouse["origin"] = origin; mouse["destination"] = ["x": point.x, "y": point.y] }
                dragOrigin = nil
            }
            if type == .scrollWheel { mouse["deltaY"] = event.getIntegerValueField(.scrollWheelEventDeltaAxis1); mouse["deltaX"] = event.getIntegerValueField(.scrollWheelEventDeltaAxis2) }
            emit(kind: type == .scrollWheel ? "scroll" : "mouse", payload: ["mouse": mouse, "eventType": type.rawValue], context: info)
        }
        scheduleSnapshot()
    }
    func flushText() {
        textTask?.cancel(); textTask = nil
        guard !textBuffer.isEmpty else { return }
        var keyboard = textContext["keyboard"] as? [String: Any] ?? [:]
        keyboard["text"] = textBuffer
        var info = textContext; info.removeValue(forKey: "keyboard")
        textBuffer = ""; textContext = [:]
        emit(kind: "text", payload: ["keyboard": keyboard], context: info)
    }
    func scheduleSnapshot() {
        snapshotTask?.cancel()
        let task = DispatchWorkItem { self.snapshot(kind: "ui_changed") }
        snapshotTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: task)
    }
    func removeObserver() {
        if let observer = observer {
            if let app = observerApp { for notification in notifications { AXObserverRemoveNotification(observer, app, notification as CFString) } }
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        observer = nil; observerApp = nil; observerPID = 0
    }
    func observe(_ pid: pid_t) {
        if observerPID == pid { return }
        removeObserver()
        let app = AXUIElementCreateApplication(pid)
        var newObserver: AXObserver?
        if AXObserverCreate(pid, { _, _, _, info in
            if let info = info { Unmanaged<Recorder>.fromOpaque(info).takeUnretainedValue().scheduleSnapshot() }
        }, &newObserver) == .success, let created = newObserver {
            observer = created; observerApp = app; observerPID = pid
            for notification in notifications { AXObserverAddNotification(created, app, notification as CFString, Unmanaged.passUnretained(self).toOpaque()) }
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        }
    }
    func snapshot(kind: String) {
        guard recording, let (info, window, focused) = context(), let window = window else { return }
        if let pid = (info["app"] as? [String: Any])?["processIdentifier"] as? Int32 { observe(pid) }
        var lines: [String] = [], visited: [AXUIElement] = []
        var complete = true
        var renderedBytes = 0
        let deadline = ProcessInfo.processInfo.systemUptime + 0.2
        func visit(_ element: AXUIElement, depth: Int) {
            guard !visited.contains(where: { CFEqual($0, element) }) else { return }
            visited.append(element)
            guard depth < 10 && lines.count < 512 && ProcessInfo.processInfo.systemUptime < deadline else { complete = false; return }
            let details = elementData(element)
            let data = (try? JSONSerialization.data(withJSONObject: details, options: [.sortedKeys])) ?? Data()
            let line = String(repeating: "  ", count: depth) + (String(data: data, encoding: .utf8) ?? "{}")
            guard renderedBytes + line.utf8.count <= 48000 else { complete = false; return }
            renderedBytes += line.utf8.count
            lines.append(line)
            if details["secure"] as? Bool == true { return }
            if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] { for child in children { visit(child, depth: depth + 1) } }
        }
        visit(window, depth: 0)
        let bundle = (info["app"] as? [String: Any])?["bundleIdentifier"] as? String ?? ""
        let identity = "\(bundle):\(CFHash(window))"
        if lines == lastTree && identity == lastWindow && kind == "ui_changed" { return }
        let mode = identity == lastWindow && !lastTree.isEmpty ? "diff" : "full"
        var rendered = lines.joined(separator: "\n")
        if mode == "diff" {
            rendered = lines.difference(from: lastTree).map { change in
                switch change { case .insert(let offset, let line, _): return "+ \(offset) \(line)"; case .remove(let offset, let line, _): return "- \(offset) \(line)" }
            }.joined(separator: "\n")
        }
        var payload: [String: Any] = ["ax": ["mode": mode, "text": rendered, "complete": complete, "lineCount": lines.count]]
        if let focused = focused, let selectedText = attribute(focused, kAXSelectedTextAttribute) as? String, !selectedText.isEmpty {
            payload["selection"] = ["target": elementData(focused), "selectedText": String(selectedText.prefix(4096))]
        }
        emit(kind: kind, payload: payload, context: info)
        lastTree = lines; lastWindow = identity; lastBundle = bundle
    }
}

let arguments = CommandLine.arguments
guard let flag = arguments.firstIndex(of: "--endpoint-file"), arguments.count > flag + 1 else { exit(2) }
let recorder = Recorder(endpointFile: arguments[flag + 1])
let application = NSApplication.shared
application.delegate = recorder
application.run()
