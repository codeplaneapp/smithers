import SwiftUI

struct FileTreeSidebar: View {
    @ObservedObject var workspace: WorkspaceState

    var body: some View {
        Group {
            if workspace.fileTree.isEmpty {
                VStack(spacing: 12) {
                    Text("No folder open")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("NoFolderLabel")
                    Button("Open Folder...") {
                        workspace.openFolderPanel()
                    }
                    .accessibilityIdentifier("OpenFolderButton")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: $workspace.selectedFileURL) {
                    ForEach(workspace.fileTree) { item in
                        FileTreeRow(item: item, workspace: workspace)
                    }
                }
                .listStyle(.sidebar)
                .accessibilityIdentifier("FileTreeList")
                .onChange(of: workspace.selectedFileURL) { _, newValue in
                    if let url = newValue {
                        workspace.selectFile(url)
                    }
                }
            }
        }
    }
}

struct FileTreeRow: View {
    let item: FileItem
    @ObservedObject var workspace: WorkspaceState
    @State private var isExpanded = false

    var body: some View {
        if item.isFolder {
            folderRow
        } else {
            fileLabel
                .tag(item.id)
                .accessibilityIdentifier("FileTreeItem_\(item.name)")
        }
    }

    @ViewBuilder
    private var folderRow: some View {
        HStack(spacing: 4) {
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .rotationEffect(isExpanded ? .degrees(90) : .zero)
                .animation(.easeInOut(duration: 0.15), value: isExpanded)
                .frame(width: 10)
            Image(systemName: "folder.fill")
                .foregroundStyle(.blue)
            Text(item.name)
        }
        .contentShape(Rectangle())
        .onTapGesture { isExpanded.toggle() }
        .accessibilityIdentifier("FileTreeItem_\(item.name)")

        if isExpanded, let children = item.children {
            ForEach(children) { child in
                FileTreeRow(item: child, workspace: workspace)
                    .padding(.leading, 16)
            }
        }
    }

    private var fileLabel: some View {
        Label {
            Text(item.name)
        } icon: {
            Image(systemName: "doc.text")
                .foregroundStyle(.secondary)
        }
    }
}
