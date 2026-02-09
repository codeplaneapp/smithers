import SwiftUI

@main
struct SmithersApp: App {
    @StateObject private var workspace: WorkspaceState
    @NSApplicationDelegateAdaptor(SmithersAppDelegate.self) private var appDelegate
    @StateObject private var tmuxKeyHandler: TmuxKeyHandler
    @StateObject private var updateController = UpdateController()
    @State private var windowCloseDelegate = WindowCloseDelegate()

    init() {
        let workspace = WorkspaceState()
        _workspace = StateObject(wrappedValue: workspace)
        _tmuxKeyHandler = StateObject(wrappedValue: TmuxKeyHandler(workspace: workspace))
        appDelegate.workspace = workspace
    }

    var body: some Scene {
        WindowGroup {
            ContentView(workspace: workspace, tmuxKeyHandler: tmuxKeyHandler)
                .preferredColorScheme(workspace.theme.colorScheme)
                .tint(workspace.theme.accentColor)
                .frame(minWidth: 700, minHeight: 400)
                .environment(\.openURL, OpenURLAction { url in
                    workspace.handleOpenURL(url) ? .handled : .systemAction
                })
                .onAppear {
                    workspace.hideWindowForLaunch()
                    handleLaunchArguments()
                    appDelegate.workspace = workspace
                    windowCloseDelegate.workspace = workspace
                    setInitialWindowSize()
                    configureWindowChrome()
                    tmuxKeyHandler.install()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates...") {
                    updateController.checkForUpdates()
                }
            }
            CommandGroup(replacing: .saveItem) {
                Button("Save") {
                    workspace.saveCurrentFile()
                }
                .keyboardShortcut("S", modifiers: [.command])
                Button("Save All") {
                    workspace.saveAllFiles()
                }
                .keyboardShortcut("S", modifiers: [.command, .shift])
            }
            CommandGroup(after: .newItem) {
                Button("Open Folder...") {
                    workspace.openFolderPanel()
                }
                .keyboardShortcut("O", modifiers: [.command, .shift])
                Button("Search in Files...") {
                    workspace.showSearchPanel()
                }
                .keyboardShortcut("F", modifiers: [.command, .shift])
            }
            CommandGroup(after: .newItem) {
                Button("New Terminal") {
                    workspace.openTerminal()
                }
                .keyboardShortcut("`", modifiers: [.command])
                Button(workspace.isNvimModeEnabled ? "Disable Neovim Mode" : "Enable Neovim Mode") {
                    workspace.toggleNvimMode()
                }
                .keyboardShortcut("N", modifiers: [.command, .shift])
                Button("Toggle Keyboard Shortcuts") {
                    workspace.toggleShortcutsPanel()
                }
                .keyboardShortcut("/", modifiers: [.command])
            }
            CommandGroup(after: .toolbar) {
                Button("Toggle Sidebar") {
                    workspace.toggleSidebarVisibility()
                }
                .keyboardShortcut("B", modifiers: [.command])
            }
            CommandGroup(replacing: .printItem) {
                Button("Go to File...") {
                    workspace.showCommandPalette()
                }
                .keyboardShortcut("P", modifiers: [.command])
            }
        }
        Settings {
            PreferencesView(workspace: workspace)
        }
    }

    private func setInitialWindowSize() {
        applyInitialWindowSize(retryCount: 5)
    }

    private func applyInitialWindowSize(retryCount: Int) {
        DispatchQueue.main.async {
            guard let screen = NSScreen.main else { return }
            guard let window = NSApp.windows.first(where: { $0.isKeyWindow || $0.isMainWindow }) ?? NSApp.windows.first else {
                if retryCount > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                        applyInitialWindowSize(retryCount: retryCount - 1)
                    }
                }
                return
            }
            let screenFrame = screen.visibleFrame
            let width = screenFrame.width * 0.85
            let height = screenFrame.height * 0.85
            let x = screenFrame.origin.x + (screenFrame.width - width) / 2
            let y = screenFrame.origin.y + (screenFrame.height - height) / 2
            if let savedFrame = WindowFrameStore.loadFrame(for: workspace.rootDirectory) {
                window.setFrame(WindowFrameStore.adjustedFrame(savedFrame), display: true)
            } else {
                window.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
            }
            WindowFrameStore.saveFrame(window.frame, for: workspace.rootDirectory)
            workspace.showWindowAfterLaunch()
        }
    }

    private func configureWindowChrome() {
        DispatchQueue.main.async {
            guard let window = NSApp.windows.first(where: { $0.isKeyWindow || $0.isMainWindow }) else { return }
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = true
            window.styleMask.insert(.fullSizeContentView)
            window.title = "Smithers"
            window.delegate = windowCloseDelegate
            workspace.refreshWindowTitle()
            workspace.applyWindowAppearance()
        }
    }

    private func handleLaunchArguments() {
        let args = ProcessInfo.processInfo.arguments
        var openItems: [URL] = []
        var index = 0
        while index < args.count {
            let arg = args[index]
            if arg == "-openDirectory", index + 1 < args.count {
                openItems.append(URL(fileURLWithPath: args[index + 1]))
                index += 2
                continue
            }
            if arg == "-openFile", index + 1 < args.count {
                openItems.append(URL(fileURLWithPath: args[index + 1]))
                index += 2
                continue
            }
            index += 1
        }
        if !openItems.isEmpty {
            workspace.handleExternalOpen(urls: openItems)
            return
        }
        if !appDelegate.hasPendingOpenRequests {
            workspace.restoreLastWorkspaceIfNeeded()
        }
    }
}
