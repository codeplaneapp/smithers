import SwiftUI

// MARK: - Xcode Preview for SmithersView

/// Full-window preview of the Smithers UI
/// Open this file in Xcode and use the Canvas preview (Cmd+Option+Enter)
#Preview("Smithers App") {
    SmithersView(
        workspaceRoot: FileManager.default.temporaryDirectory.path,
        agentBackend: "fake"
    )
    .frame(width: 1000, height: 700)
}

#Preview("Sidebar Only") {
    SessionSidebar(
        sessions: .constant(Session.mockSessions),
        selectedSessionId: .constant(Session.mockSessions.first?.id)
    )
    .frame(width: 250, height: 600)
}

#Preview("Detail - With Session") {
    let manager = SessionManager(
        workspaceRoot: FileManager.default.temporaryDirectory.path,
        agentBackend: "fake"
    )
    return SessionDetail(
        session: Session.mockSessions.first,
        sessionManager: manager
    )
    .frame(width: 700, height: 500)
}

#Preview("Detail - Empty") {
    let manager = SessionManager(
        workspaceRoot: FileManager.default.temporaryDirectory.path,
        agentBackend: "fake"
    )
    return SessionDetail(
        session: nil,
        sessionManager: manager
    )
    .frame(width: 700, height: 500)
}
