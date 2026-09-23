import AppKit
import ApplicationServices

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func threadID(in element: AXUIElement) -> String? {
    if attribute(element, "AXRole") as? String == "AXWebArea",
       let url = attribute(element, "AXURL") as? URL,
       url.scheme == "t3code",
       let fragment = url.fragment,
       let candidate = fragment.split(separator: "/").last,
       UUID(uuidString: String(candidate)) != nil {
        return String(candidate)
    }
    for child in attribute(element, "AXChildren") as? [AXUIElement] ?? [] {
        if let id = threadID(in: child) { return id }
    }
    return nil
}

guard AXIsProcessTrusted() else {
    fputs("Accessibility access is required to read the T3 Code window.\n", stderr)
    exit(2)
}

let app = NSWorkspace.shared.runningApplications.first { $0.localizedName == "T3 Code (Alpha)" }
if let app {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let windows = attribute(root, "AXWindows") as? [AXUIElement] ?? []
    for window in windows {
        guard (attribute(window, "AXMain") as? NSNumber)?.boolValue == true else { continue }
        if let id = threadID(in: window) { print(id) }
        break
    }
}
