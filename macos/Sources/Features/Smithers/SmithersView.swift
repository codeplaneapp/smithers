import SwiftUI

/// Root view for the Smithers app - combines sidebar and session detail
struct SmithersView: View {
    @StateObject private var sessionManager: SessionManager
    @State private var selectedSessionId: UUID?
    @State private var showSearch: Bool = false
    @State private var selectedSearchResult: SearchResult?

    init(workspaceRoot: String, sandboxMode: String = "host", agentBackend: String = "fake") {
        _sessionManager = StateObject(wrappedValue: SessionManager(
            workspaceRoot: workspaceRoot,
            sandboxMode: sandboxMode,
            agentBackend: agentBackend
        ))
    }

    var body: some View {
        NavigationSplitView {
            SessionSidebar(
                sessions: $sessionManager.sessions,
                selectedSessionId: $selectedSessionId
            )
            .navigationSplitViewColumnWidth(min: 200, ideal: 250, max: 300)
        } detail: {
            SessionDetail(
                session: selectedSession,
                sessionManager: sessionManager
            )
        }
        .frame(minWidth: 800, minHeight: 500)
        .task {
            do {
                try await sessionManager.start()
            } catch {
                print("Failed to start session manager: \(error)")
            }
        }
        .onDisappear {
            sessionManager.stop()
        }
        .sheet(isPresented: $showSearch) {
            SearchView(
                isPresented: $showSearch,
                selectedResult: $selectedSearchResult,
                sessionManager: sessionManager
            )
        }
        .onChange(of: selectedSearchResult) { result in
            if let result = result {
                navigateToSearchResult(result)
            }
        }
        .backport.onKeyPress("f") { modifiers in
            if modifiers.contains(.command) {
                showSearch.toggle()
                return .handled
            }
            return .ignored
        }
    }

    private var selectedSession: Session? {
        sessionManager.sessions.first { $0.id == selectedSessionId }
    }

    private func navigateToSearchResult(_ result: SearchResult) {
        // Parse the session ID from the result
        guard let sessionId = UUID(uuidString: result.sessionId) else {
            print("Invalid session ID in search result: \(result.sessionId)")
            return
        }

        // Switch to the session
        selectedSessionId = sessionId

        // TODO: Navigate to the specific node (result.nodeId) once we have node selection sync
        if let nodeId = result.nodeId {
            print("Navigate to node: \(nodeId) in session: \(sessionId)")
            // For now, just print. In the future, we'll need to:
            // 1. Pass nodeId to SessionDetail (via @Binding or environment)
            // 2. Scroll chat view to the node or select it in graph view
        } else {
            print("Navigated to session: \(sessionId)")
        }

        // Clear the selected result
        selectedSearchResult = nil
    }
}

#Preview {
    SmithersView(
        workspaceRoot: FileManager.default.temporaryDirectory.path,
        agentBackend: "fake"
    )
    .frame(width: 1000, height: 600)
}
