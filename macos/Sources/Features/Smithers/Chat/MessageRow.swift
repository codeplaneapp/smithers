import SwiftUI

/// A single message row in the chat transcript
struct MessageRow: View {
    let message: ChatMessage
    @State private var animationPhase: Double = 0

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Avatar/icon
            avatar
                .frame(width: 28, height: 28)

            // Message content
            VStack(alignment: .leading, spacing: 4) {
                // Role label (only for assistant)
                if message.role == .assistant {
                    HStack(spacing: 6) {
                        Text("Assistant")
                            .font(.caption)
                            .fontWeight(.medium)
                            .foregroundColor(.secondary)

                        // Streaming indicator
                        if message.isStreaming {
                            HStack(spacing: 2) {
                                ForEach(0..<3) { index in
                                    Circle()
                                        .fill(Color.secondary)
                                        .frame(width: 4, height: 4)
                                        .opacity(streamingOpacity(for: index))
                                }
                            }
                        }
                    }
                }

                // Message text with markdown rendering
                MarkdownView(content: message.content, isStreaming: message.isStreaming)
                    .frame(maxWidth: .infinity, alignment: .leading)

                // Timestamp
                HStack(spacing: 4) {
                    Text(message.timestamp, style: .time)
                        .font(.caption2)
                        .foregroundColor(.secondary)

                    if message.isStreaming {
                        Text("streaming...")
                            .font(.caption2)
                            .foregroundColor(.secondary.opacity(0.7))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(backgroundColor)
        .onAppear {
            if message.isStreaming {
                startStreamingAnimation()
            }
        }
        .onChange(of: message.isStreaming) { isStreaming in
            if isStreaming {
                startStreamingAnimation()
            }
        }
    }

    // MARK: - Computed Properties

    /// Calculate opacity for streaming indicator dots
    private func streamingOpacity(for index: Int) -> Double {
        let offset = Double(index) * 0.33
        let phase = (animationPhase + offset).truncatingRemainder(dividingBy: 1.0)
        return 0.3 + (0.7 * sin(phase * .pi * 2))
    }

    /// Start the streaming animation
    private func startStreamingAnimation() {
        withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
            animationPhase = 1.0
        }
    }


    // MARK: - Subviews

    private var avatar: some View {
        ZStack {
            Circle()
                .fill(avatarColor)

            Image(systemName: avatarIcon)
                .font(.system(size: 14))
                .foregroundColor(.white)
        }
    }

    private var avatarColor: Color {
        switch message.role {
        case .user:
            return Color.blue
        case .assistant:
            return Color.purple
        }
    }

    private var avatarIcon: String {
        switch message.role {
        case .user:
            return "person.fill"
        case .assistant:
            return "sparkles"
        }
    }

    private var backgroundColor: Color {
        message.role == .user ? Color.clear : Color(nsColor: .controlBackgroundColor).opacity(0.3)
    }
}

#Preview("User Message") {
    MessageRow(message: ChatMessage(
        id: UUID(),
        role: .user,
        content: "Can you help me fix the authentication bug in auth.py?",
        timestamp: Date()
    ))
    .frame(width: 600)
}

#Preview("Assistant Message") {
    MessageRow(message: ChatMessage(
        id: UUID(),
        role: .assistant,
        content: "I'll help you fix the authentication bug. Let me first read the auth.py file to understand the current implementation.",
        timestamp: Date()
    ))
    .frame(width: 600)
}

#Preview("Long Message") {
    MessageRow(message: ChatMessage(
        id: UUID(),
        role: .assistant,
        content: """
        I've analyzed the authentication code and found the issue. The problem is in the `validate_token()` function on line 42. Currently, it's not properly checking the token expiration time.

        Here's what needs to be fixed:
        1. Add proper expiration validation
        2. Handle edge cases for null tokens
        3. Add logging for failed attempts

        Let me make these changes now.
        """,
        timestamp: Date()
    ))
    .frame(width: 600)
}

#Preview("Markdown Message") {
    MessageRow(message: ChatMessage(
        id: UUID(),
        role: .assistant,
        content: """
        I'll help you fix the authentication bug. Here's what I found:

        ## Analysis

        The issue is in `auth.py:42` where the token validation is incomplete.

        ### Problems
        - Missing **expiration checks**
        - No handling for `null` tokens
        - Missing error logging

        ### Code Example
        ```python
        def validate_token(token):
            if not token or token.is_expired():
                log.error("Invalid token")
                return False
            return True
        ```

        I'll make these changes now.
        """,
        timestamp: Date()
    ))
    .frame(width: 600)
}

#Preview("Streaming Message") {
    MessageRow(message: ChatMessage(
        id: UUID(),
        role: .assistant,
        content: "I'm analyzing the authentication code and will help you fix",
        timestamp: Date(),
        isStreaming: true
    ))
    .frame(width: 600)
}
