import SwiftUI

/// A card showing checkpoint details in the chat
struct CheckpointCard: View {
    let checkpoint: CheckpointMessage
    var onRestore: ((String) -> Void)?
    var onFork: ((String) -> Void)?
    @State private var isExpanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Header
            checkpointHeader

            // Checkpoint metadata (collapsible)
            if isExpanded {
                metadataSection
            }

            // Action buttons
            actionButtons
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

    private var checkpointHeader: some View {
        HStack(spacing: 8) {
            // Checkpoint icon
            checkpointIcon
                .frame(width: 20, height: 20)

            // Checkpoint label
            Text(checkpoint.label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.primary)

            Spacer()

            // Timestamp
            Text(formatTimestamp(checkpoint.timestamp))
                .font(.caption2)
                .foregroundColor(.secondary)

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

    private var metadataSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let jjCommitId = checkpoint.jjCommitId {
                metadataRow(label: "Commit", value: String(jjCommitId.prefix(12)))
            }
            if let bookmarkName = checkpoint.bookmarkName {
                metadataRow(label: "Bookmark", value: bookmarkName)
            }
            metadataRow(label: "ID", value: String(checkpoint.checkpointId.prefix(8)))
        }
        .padding(.leading, 28)
    }

    private func metadataRow(label: String, value: String) -> some View {
        HStack(spacing: 8) {
            Text(label + ":")
                .font(.caption)
                .foregroundColor(.secondary)
                .frame(width: 70, alignment: .leading)
            Text(value)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(.primary)
        }
    }

    private var actionButtons: some View {
        HStack(spacing: 8) {
            Button(action: {
                onRestore?(checkpoint.checkpointId)
            }) {
                HStack(spacing: 4) {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 11))
                    Text("Restore")
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundColor(.accentColor)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Color.accentColor.opacity(0.1))
                .cornerRadius(4)
            }
            .buttonStyle(.plain)
            .help("Restore code to this checkpoint")

            Button(action: {
                onFork?(checkpoint.checkpointId)
            }) {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 11))
                    Text("Fork")
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundColor(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Color.secondary.opacity(0.1))
                .cornerRadius(4)
            }
            .buttonStyle(.plain)
            .help("Create a new session from this checkpoint")

            Spacer()
        }
    }

    private var checkpointIcon: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.orange)

            Image(systemName: "bookmark.fill")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(.white)
        }
    }

    // MARK: - Helpers

    private func formatTimestamp(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private var cardBackground: Color {
        Color.orange.opacity(0.05)
    }

    private var borderColor: Color {
        Color.orange.opacity(0.3)
    }
}

// MARK: - Previews

#Preview("Basic Checkpoint") {
    CheckpointCard(
        checkpoint: CheckpointMessage(
            id: UUID(),
            checkpointId: "cp-abc123",
            label: "Before refactoring auth",
            jjCommitId: "f8e3a2b1c9d4e5f6a7b8c9d0e1f2a3b4",
            bookmarkName: "checkpoint-cp-abc123",
            timestamp: Date().addingTimeInterval(-3600)
        ),
        onRestore: { id in
            print("Restore checkpoint: \(id)")
        },
        onFork: { id in
            print("Fork from checkpoint: \(id)")
        }
    )
    .frame(width: 500)
    .padding()
}

#Preview("Collapsed") {
    CheckpointCard(
        checkpoint: CheckpointMessage(
            id: UUID(),
            checkpointId: "cp-xyz789",
            label: "Working state before experiment",
            jjCommitId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
            bookmarkName: "checkpoint-cp-xyz789",
            timestamp: Date().addingTimeInterval(-86400)
        )
    )
    .frame(width: 500)
    .padding()
}

#Preview("Expanded") {
    CheckpointCard(
        checkpoint: CheckpointMessage(
            id: UUID(),
            checkpointId: "cp-def456",
            label: "Checkpoint after fixing bug #42",
            jjCommitId: "1234567890abcdefghijklmnopqrstuvwxyz",
            bookmarkName: "checkpoint-cp-def456",
            timestamp: Date().addingTimeInterval(-7200)
        )
    )
    .frame(width: 500)
    .padding()
    .onAppear {
        // Simulate expanded state in preview
    }
}
