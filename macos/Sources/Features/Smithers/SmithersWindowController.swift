import AppKit
import SwiftUI

class SmithersWindowController: NSWindowController {
    convenience init(workspaceRoot: String? = nil) {
        // Use provided workspace root, or default to home directory
        let workspace = workspaceRoot ?? FileManager.default.homeDirectoryForCurrentUser.path

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1000, height: 600),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Smithers"
        window.center()
        window.contentView = NSHostingView(
            rootView: SmithersView(
                workspaceRoot: workspace,
                sandboxMode: "host",
                agentBackend: "fake"
            )
        )

        self.init(window: window)
    }

    static func createWindow(workspaceRoot: String? = nil) -> SmithersWindowController {
        let controller = SmithersWindowController(workspaceRoot: workspaceRoot)
        controller.showWindow(nil)
        return controller
    }
}
