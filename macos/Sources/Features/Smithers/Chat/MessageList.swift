import SwiftUI

/// A scrollable list of chat messages with auto-scroll behavior
struct MessageList: View {
    let items: [ChatItem]
    var onRestoreCheckpoint: ((String) -> Void)?
    var onForkCheckpoint: ((String) -> Void)?
    @State private var isAtBottom = true
    @State private var scrollProxy: ScrollViewProxy?
    @State private var lastItemId: UUID?

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            chatItemView(item)
                                .id(item.id)
                        }

                        // Invisible anchor at the bottom
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                            .onAppear {
                                // User scrolled to bottom
                                isAtBottom = true
                            }
                            .onDisappear {
                                // User scrolled away from bottom
                                isAtBottom = false
                            }
                    }
                }
                .onAppear {
                    scrollProxy = proxy
                    scrollToBottom(animated: false)
                }
                .onChange(of: items.count) { _ in
                    // Auto-scroll only if user is at bottom
                    if isAtBottom {
                        scrollToBottom(animated: true)
                    }
                }
                .onChange(of: lastItemContent) { _ in
                    // Handle streaming updates to last item
                    if isAtBottom, isLastItemStreaming {
                        scrollToBottom(animated: false)
                    }
                }
                .onChange(of: items.last?.id) { newId in
                    lastItemId = newId
                }
            }

            // "Jump to latest" button (shown when not at bottom)
            if !isAtBottom && items.count > 0 {
                jumpToBottomButton
                    .padding(.bottom, 16)
            }
        }
    }

    // MARK: - Subviews

    @ViewBuilder
    private func chatItemView(_ item: ChatItem) -> some View {
        switch item {
        case .message(let message):
            MessageRow(message: message)
        case .tool(let tool):
            ToolCard(tool: tool)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
        case .checkpoint(let checkpoint):
            CheckpointCard(
                checkpoint: checkpoint,
                onRestore: onRestoreCheckpoint,
                onFork: onForkCheckpoint
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    private var jumpToBottomButton: some View {
        Button(action: {
            scrollToBottom(animated: true)
        }) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 12, weight: .medium))
                Text("Jump to latest")
                    .font(.system(size: 13, weight: .medium))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                Capsule()
                    .fill(Color.accentColor)
            )
            .foregroundColor(.white)
        }
        .buttonStyle(.plain)
        .shadow(color: .black.opacity(0.1), radius: 4, y: 2)
    }

    // MARK: - Helpers

    private var lastItemContent: String? {
        guard let lastItem = items.last else { return nil }
        switch lastItem {
        case .message(let msg):
            return msg.content
        case .tool(let tool):
            return tool.result?.preview
        case .checkpoint(let checkpoint):
            return checkpoint.label
        }
    }

    private var isLastItemStreaming: Bool {
        guard let lastItem = items.last else { return false }
        switch lastItem {
        case .message(let msg):
            return msg.isStreaming
        case .tool(let tool):
            return tool.isRunning
        case .checkpoint:
            return false
        }
    }

    private func scrollToBottom(animated: Bool) {
        guard let proxy = scrollProxy else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.3)) {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        } else {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
        isAtBottom = true
    }
}

#Preview("Empty") {
    MessageList(items: [])
        .frame(width: 600, height: 400)
}

#Preview("Messages and Tools") {
    MessageList(items: [
        .message(ChatMessage(
            id: UUID(),
            role: .user,
            content: "Help me fix the authentication bug",
            timestamp: Date().addingTimeInterval(-120)
        )),
        .message(ChatMessage(
            id: UUID(),
            role: .assistant,
            content: "I'll help you with that. Let me read the authentication file first.",
            timestamp: Date().addingTimeInterval(-100)
        )),
        .tool(ToolMessage(
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
                    return True
                """
            ),
            timestamp: Date().addingTimeInterval(-80)
        )),
        .message(ChatMessage(
            id: UUID(),
            role: .assistant,
            content: "I found the issue. The token validation is missing expiration checks. Let me fix that now.",
            timestamp: Date().addingTimeInterval(-60)
        )),
        .tool(ToolMessage(
            id: UUID(),
            name: "Edit",
            input: "file_path: src/auth.py\nold_string: return True\nnew_string: return check_expiration(token)",
            result: nil,
            timestamp: Date(),
            isRunning: true
        )),
    ])
    .frame(width: 600, height: 400)
}

#Preview("Many Items") {
    MessageList(items: (0..<10).flatMap { i -> [ChatItem] in
        [
            .message(ChatMessage(
                id: UUID(),
                role: .user,
                content: "User message \(i + 1): Can you help with task \(i)?",
                timestamp: Date().addingTimeInterval(Double(-300 + i * 30))
            )),
            .tool(ToolMessage(
                id: UUID(),
                name: ["Read", "Bash", "Grep"][i % 3],
                input: "Sample input for tool \(i)",
                result: ToolResult(success: true, fullOutput: "Output \(i)"),
                timestamp: Date().addingTimeInterval(Double(-290 + i * 30))
            )),
        ]
    })
    .frame(width: 600, height: 400)
}
