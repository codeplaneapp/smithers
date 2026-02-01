import SwiftUI
import GhosttyKit

/// A card showing tool invocation details in the chat
struct ToolCard: View {
    let tool: ToolMessage
    let terminalManager: TerminalSessionManager?
    let workingDirectory: URL?
    let onOpenDrawer: (() -> Void)?
    @EnvironmentObject var ghostty: Ghostty.App
    @State private var isExpanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Header
            toolHeader

            // Tool input parameters (collapsible)
            if isExpanded && !tool.input.isEmpty {
                inputSection
            }

            // Tool result preview
            if let result = tool.result {
                resultSection(result)
            } else if tool.isRunning {
                runningIndicator
            }
        }
        .padding(12)
        .background(cardBackground)
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(borderColor, lineWidth: 1)
        )
    }

    // MARK: - Subviews

    private var toolHeader: some View {
        HStack(spacing: 8) {
            // Tool icon
            toolIcon
                .frame(width: 20, height: 20)

            // Tool name
            Text(tool.name)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.primary)

            // Status badge
            if let result = tool.result {
                statusBadge(success: result.success)
            } else if tool.isRunning {
                HStack(spacing: 4) {
                    ProgressView()
                        .scaleEffect(0.6)
                        .frame(width: 12, height: 12)
                    Text("Running")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
            }

            Spacer()

            // Open Terminal button (for Bash tools or if working directory is available)
            if shouldShowTerminalButton {
                Button(action: openTerminalHere) {
                    Image(systemName: "terminal")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .help("Open Terminal Here")
            }

            // Expand/collapse button
            Button(action: { isExpanded.toggle() }) {
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
            .help(isExpanded ? "Collapse details" : "Show details")
        }
    }

    private var inputSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Input")
                .font(.caption)
                .fontWeight(.medium)
                .foregroundColor(.secondary)

            Text(tool.input)
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(.primary)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .textBackgroundColor).opacity(0.5))
                .cornerRadius(4)
        }
    }

    private func resultSection(_ result: ToolResult) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Result")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundColor(.secondary)

                if !result.preview.isEmpty {
                    Spacer()

                    if result.preview.count < result.fullOutput.count {
                        Text("\(result.preview.count) of \(result.fullOutput.count) chars")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
            }

            if !result.preview.isEmpty {
                ScrollView {
                    Text(result.preview)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 120)
                .padding(8)
                .background(Color(nsColor: .textBackgroundColor).opacity(0.5))
                .cornerRadius(4)

                // "Open Output Viewer" button if truncated
                if result.preview.count < result.fullOutput.count {
                    Button(action: {
                        // TODO: Open output viewer with full content
                        print("Open output viewer for tool: \(tool.id)")
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "doc.text.magnifyingglass")
                                .font(.system(size: 11))
                            Text("View Full Output")
                                .font(.system(size: 11, weight: .medium))
                        }
                        .foregroundColor(.accentColor)
                    }
                    .buttonStyle(.plain)
                }
            } else {
                Text("(no output)")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .italic()
            }
        }
    }

    private var runningIndicator: some View {
        HStack(spacing: 6) {
            ProgressView()
                .scaleEffect(0.7)
            Text("Executing...")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private var toolIcon: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4)
                .fill(iconColor)

            Image(systemName: iconName)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(.white)
        }
    }

    private func statusBadge(success: Bool) -> some View {
        HStack(spacing: 3) {
            Image(systemName: success ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 10))
            Text(success ? "Success" : "Failed")
                .font(.caption2)
        }
        .foregroundColor(success ? .green : .red)
    }

    // MARK: - Computed Properties

    private var iconColor: Color {
        switch tool.name.lowercased() {
        case "read":
            return .blue
        case "edit", "write":
            return .orange
        case "bash":
            return .purple
        case "grep", "glob":
            return .teal
        case "websearch", "webfetch":
            return .indigo
        default:
            return .gray
        }
    }

    private var iconName: String {
        switch tool.name.lowercased() {
        case "read":
            return "doc.text"
        case "edit":
            return "pencil"
        case "write":
            return "doc.badge.plus"
        case "bash":
            return "terminal.fill"
        case "grep":
            return "magnifyingglass"
        case "glob":
            return "doc.on.doc"
        case "websearch":
            return "globe"
        case "webfetch":
            return "arrow.down.circle"
        default:
            return "wrench"
        }
    }

    private var cardBackground: Color {
        if let result = tool.result, !result.success {
            return Color.red.opacity(0.05)
        }
        return Color(nsColor: .controlBackgroundColor).opacity(0.5)
    }

    private var borderColor: Color {
        if let result = tool.result {
            return result.success ? Color.green.opacity(0.3) : Color.red.opacity(0.5)
        } else if tool.isRunning {
            return Color.blue.opacity(0.3)
        }
        return Color.secondary.opacity(0.2)
    }

    // MARK: - Terminal Integration

    private var shouldShowTerminalButton: Bool {
        // Show terminal button if we have terminal manager and working directory
        guard terminalManager != nil, onOpenDrawer != nil else { return false }
        return workingDirectory != nil
    }

    private func openTerminalHere() {
        guard let terminalManager = terminalManager,
              let workingDirectory = workingDirectory,
              let onOpenDrawer = onOpenDrawer else { return }

        // Open the drawer
        onOpenDrawer()

        // Reuse or open a new terminal tab at the working directory
        let tabId = terminalManager.reuseOrOpenTab(
            cwd: workingDirectory,
            title: tool.name
        )

        // Create the surface if needed
        if let tab = terminalManager.selectedTab, tab.surfaceView == nil {
            terminalManager.createSurface(for: tabId, ghosttyApp: ghostty)
        }
    }
}

// MARK: - Previews

#Preview("Read Tool - Success") {
    ToolCard(
        tool: ToolMessage(
            id: UUID(),
            name: "Read",
            input: "file_path: src/auth.py",
            result: ToolResult(
                success: true,
                fullOutput: """
                def authenticate(username, password):
                    # Validate credentials
                    if not username or not password:
                        return False

                    # Check database
                    user = db.get_user(username)
                    return user and user.check_password(password)
                """
            ),
            timestamp: Date()
        ),
        terminalManager: nil,
        workingDirectory: nil,
        onOpenDrawer: nil
    )
    .frame(width: 500)
    .padding()
}

#Preview("Bash Tool - Running") {
    ToolCard(
        tool: ToolMessage(
            id: UUID(),
            name: "Bash",
            input: "uv run pytest tests/test_auth.py",
            result: nil,
            timestamp: Date(),
            isRunning: true
        ),
        terminalManager: nil,
        workingDirectory: nil,
        onOpenDrawer: nil
    )
    .frame(width: 500)
    .padding()
}

#Preview("Edit Tool - Failed") {
    ToolCard(
        tool: ToolMessage(
            id: UUID(),
            name: "Edit",
            input: "file_path: src/auth.py\nold_string: ...\nnew_string: ...",
            result: ToolResult(
                success: false,
                fullOutput: "Error: old_string not found in file"
            ),
            timestamp: Date()
        ),
        terminalManager: nil,
        workingDirectory: nil,
        onOpenDrawer: nil
    )
    .frame(width: 500)
    .padding()
}

#Preview("Grep Tool - Long Output") {
    ToolCard(
        tool: ToolMessage(
            id: UUID(),
            name: "Grep",
            input: "pattern: TODO.*\npath: src/",
            result: ToolResult(
                success: true,
                fullOutput: (1...50).map { "src/file\($0).py:42: TODO: Fix this" }.joined(separator: "\n")
            ),
            timestamp: Date()
        ),
        terminalManager: nil,
        workingDirectory: nil,
        onOpenDrawer: nil
    )
    .frame(width: 500)
    .padding()
}

#Preview("Collapsed") {
    ToolCard(
        tool: ToolMessage(
            id: UUID(),
            name: "WebSearch",
            input: "query: Python async best practices",
            result: ToolResult(
                success: true,
                fullOutput: "Found 10 results..."
            ),
            timestamp: Date()
        ),
        terminalManager: nil,
        workingDirectory: nil,
        onOpenDrawer: nil
    )
    .frame(width: 500)
    .padding()
}

// Note: Terminal button integration can be tested in the full app
