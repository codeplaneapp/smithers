import SwiftUI
import AppKit

class WorkspaceState: ObservableObject {
    @Published var rootDirectory: URL?
    @Published var fileTree: [FileItem] = []
    @Published var selectedFileURL: URL?
    @Published var editorText: String = """
    func hello() {
        print("Hello, Smithers!")
    }

    hello()
    """

    func openDirectory(_ url: URL) {
        rootDirectory = url
        fileTree = FileItem.loadTree(at: url)
        selectedFileURL = nil
        editorText = ""
    }

    func selectFile(_ url: URL) {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
            return
        }
        selectedFileURL = url
        editorText = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }

    func openFolderPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            openDirectory(url)
        }
    }
}
