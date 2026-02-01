import SwiftUI
import GhosttyKit

/// A collapsible drawer that displays terminal tabs
struct TerminalDrawerView: View {
    @EnvironmentObject var ghostty: Ghostty.App
    @ObservedObject var manager: TerminalSessionManager
    @Binding var isOpen: Bool

    private let minHeight: CGFloat = 40
    private let maxHeight: CGFloat = 600
    private let defaultHeight: CGFloat = 300

    @State private var drawerHeight: CGFloat = 300
    @State private var isDragging = false

    var body: some View {
        VStack(spacing: 0) {
            // Resize handle
            resizeHandle

            if isOpen {
                // Tab bar
                tabBar

                Divider()

                // Terminal content area
                terminalContent
                    .frame(height: drawerHeight)
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    // MARK: - Subviews

    private var resizeHandle: some View {
        HStack {
            // Toggle button
            Button(action: { withAnimation { isOpen.toggle() } }) {
                HStack(spacing: 4) {
                    Image(systemName: "terminal")
                        .foregroundColor(.secondary)
                    Text("Terminal")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Image(systemName: isOpen ? "chevron.down" : "chevron.up")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)

            Spacer()

            // Tab count indicator
            if !manager.tabs.isEmpty {
                Text("\(manager.tabs.count) tab\(manager.tabs.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 8)
            }
        }
        .frame(height: minHeight)
        .background(Color(nsColor: .controlBackgroundColor))
        .gesture(
            DragGesture()
                .onChanged { value in
                    if isOpen {
                        isDragging = true
                        let newHeight = drawerHeight - value.translation.height
                        drawerHeight = max(minHeight, min(maxHeight, newHeight))
                    }
                }
                .onEnded { _ in
                    isDragging = false
                }
        )
        .onHover { isHovering in
            if isOpen {
                NSCursor.resizeUpDown.set()
            }
        }
    }

    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(manager.tabs) { tab in
                    tabButton(for: tab)
                }

                // New tab button
                Button(action: manager.openNewTab) {
                    Image(systemName: "plus")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .frame(width: 24, height: 24)
                .help("New terminal tab")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .frame(height: 36)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func tabButton(for tab: TerminalTab) -> some View {
        Button(action: { manager.selectTab(tab.id) }) {
            HStack(spacing: 4) {
                Text(tab.title)
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundColor(manager.selectedTabId == tab.id ? .primary : .secondary)

                Button(action: { manager.closeTab(tab.id) }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .frame(width: 14, height: 14)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                manager.selectedTabId == tab.id
                    ? Color(nsColor: .selectedContentBackgroundColor)
                    : Color.clear
            )
            .cornerRadius(4)
        }
        .buttonStyle(.plain)
        .help(tab.workingDirectory?.path ?? "Terminal")
    }

    private var terminalContent: some View {
        Group {
            if let selectedTab = manager.selectedTab {
                if ghostty.readiness == .ready {
                    terminalView(for: selectedTab)
                } else {
                    placeholderView(message: "Loading Ghostty...")
                }
            } else if manager.tabs.isEmpty {
                placeholderView(message: "No terminal tabs open")
            } else {
                placeholderView(message: "Select a tab")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
    }

    private func terminalView(for tab: TerminalTab) -> some View {
        // Display the surface view if it exists
        Group {
            if let surfaceView = tab.surfaceView {
                GeometryReader { geo in
                    Ghostty.SurfaceRepresentable(view: surfaceView, size: geo.size)
                        .onChange(of: surfaceView.pwd) { newPwd in
                            // Update the working directory in the manager when it changes
                            if let pwdString = newPwd, !pwdString.isEmpty {
                                let url = URL(fileURLWithPath: pwdString)
                                manager.updateTabWorkingDirectory(tab.id, workingDirectory: url)
                            }
                        }
                }
            } else {
                placeholderView(message: "Terminal initializing...")
            }
        }
    }

    private func placeholderView(message: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "terminal")
                .font(.system(size: 32))
                .foregroundColor(.secondary.opacity(0.5))

            Text(message)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    @StateObject var manager = TerminalSessionManager()
    @State var isOpen = true

    return VStack {
        Spacer()
        TerminalDrawerView(
            manager: manager,
            isOpen: $isOpen
        )
    }
    .frame(width: 800, height: 600)
}
