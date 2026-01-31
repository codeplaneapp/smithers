import SwiftUI
import GhosttyKit

/// Identifies a terminal tab
struct TerminalTab: Identifiable {
    let id: UUID
    var title: String
    var workingDirectory: URL?
    var surfaceView: Ghostty.SurfaceView?

    init(id: UUID = UUID(), title: String, workingDirectory: URL? = nil, surfaceView: Ghostty.SurfaceView? = nil) {
        self.id = id
        self.title = title
        self.workingDirectory = workingDirectory
        self.surfaceView = surfaceView
    }
}

/// Manages terminal tabs and their lifecycle
@MainActor
class TerminalSessionManager: ObservableObject {
    @Published private(set) var tabs: [TerminalTab] = []
    @Published var selectedTabId: UUID?

    var selectedTab: TerminalTab? {
        guard let selectedTabId else { return nil }
        return tabs.first { $0.id == selectedTabId }
    }

    // MARK: - Tab Operations

    /// Opens a new terminal tab with the specified parameters
    /// - Parameters:
    ///   - cwd: The working directory for the terminal (defaults to home directory)
    ///   - title: The title for the tab (auto-generated if nil)
    /// - Returns: The ID of the created tab
    @discardableResult
    func openTab(cwd: URL? = nil, title: String? = nil) -> UUID {
        let tabId = UUID()
        let workingDir = cwd ?? FileManager.default.homeDirectoryForCurrentUser
        let tabTitle = title ?? workingDir.lastPathComponent

        let tab = TerminalTab(
            id: tabId,
            title: tabTitle,
            workingDirectory: workingDir,
            surfaceView: nil  // Will be created lazily when needed
        )

        tabs.append(tab)
        selectedTabId = tabId

        return tabId
    }

    /// Opens a new terminal tab with default settings
    func openNewTab() {
        openTab()
    }

    /// Reuses an existing tab with matching working directory or opens a new one
    /// - Parameters:
    ///   - cwd: The working directory to match
    ///   - title: The title for a new tab if one is created
    /// - Returns: The ID of the reused or created tab
    @discardableResult
    func reuseOrOpenTab(cwd: URL, title: String? = nil) -> UUID {
        // Try to find an existing tab with the same working directory
        if let existingTab = tabs.first(where: { $0.workingDirectory == cwd }) {
            selectedTabId = existingTab.id
            return existingTab.id
        }

        // No matching tab found, create a new one
        return openTab(cwd: cwd, title: title)
    }

    /// Selects a tab by ID
    func selectTab(_ id: UUID) {
        guard tabs.contains(where: { $0.id == id }) else { return }
        selectedTabId = id
    }

    /// Closes a tab by ID
    func closeTab(_ id: UUID) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }

        // Clean up the surface view if it exists
        if let surfaceView = tabs[index].surfaceView {
            // Surface cleanup will happen automatically via deinit
            _ = surfaceView
        }

        tabs.remove(at: index)

        // Update selection
        if selectedTabId == id {
            if !tabs.isEmpty {
                // Select adjacent tab (prefer next, fallback to previous)
                let newIndex = min(index, tabs.count - 1)
                selectedTabId = tabs[newIndex].id
            } else {
                selectedTabId = nil
            }
        }
    }

    /// Closes all tabs
    func closeAllTabs() {
        tabs.removeAll()
        selectedTabId = nil
    }

    /// Updates the title of a tab
    func updateTabTitle(_ id: UUID, title: String) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs[index].title = title
    }

    /// Updates the working directory of a tab
    func updateTabWorkingDirectory(_ id: UUID, workingDirectory: URL) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs[index].workingDirectory = workingDirectory
    }

    // MARK: - Surface Management

    /// Attaches a surface view to a tab
    func attachSurface(_ id: UUID, surfaceView: Ghostty.SurfaceView) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs[index].surfaceView = surfaceView
    }

    /// Creates and attaches a surface view to a tab
    /// - Parameters:
    ///   - id: The tab ID
    ///   - ghosttyApp: The Ghostty app instance
    func createSurface(for id: UUID, ghosttyApp: Ghostty.App) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        guard let app = ghosttyApp.app else { return }
        let tab = tabs[index]

        // Create the surface view with working directory
        let surfaceView = Ghostty.SurfaceView(app, baseConfig: nil)

        tabs[index].surfaceView = surfaceView
    }
}
