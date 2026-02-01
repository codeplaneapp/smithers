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
                // TODO: Navigate to the result in the session
                print("Selected result: \(result.title)")
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
}

#Preview {
    SmithersView(
        workspaceRoot: FileManager.default.temporaryDirectory.path,
        agentBackend: "fake"
    )
    .frame(width: 1000, height: 600)
}
