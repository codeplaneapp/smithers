import Foundation

enum NvimModeKind: String, CaseIterable, Codable {
    case normal
    case insert
    case visual
    case command

    var displayName: String {
        rawValue.capitalized
    }
}

enum ShortcutCategory: String, CaseIterable, Identifiable {
    case general = "General"
    case tabs = "Tabs"
    case commandPalette = "Command Palette"
    case search = "Search"
    case neovim = "Neovim"

    var id: String { rawValue }

    static let ordered: [ShortcutCategory] = [
        .general,
        .tabs,
        .commandPalette,
        .search,
        .neovim,
    ]
}

enum ShortcutContext: Hashable {
    case always
    case prefixActive
    case commandPaletteOpen
    case searchOpen
    case neovimMode(NvimModeKind)
}

struct ShortcutEntry: Identifiable, Hashable {
    let id: String
    let keys: String
    let label: String
    let category: ShortcutCategory
    let context: ShortcutContext
}

enum ShortcutCatalog {
    static let entries: [ShortcutEntry] = [
        // General
        ShortcutEntry(
            id: "save",
            keys: "⌘S",
            label: "Save",
            category: .general,
            context: .always
        ),
        ShortcutEntry(
            id: "save-all",
            keys: "⇧⌘S",
            label: "Save All",
            category: .general,
            context: .always
        ),
        ShortcutEntry(
            id: "open-folder",
            keys: "⇧⌘O",
            label: "Open Folder",
            category: .general,
            context: .always
        ),
        ShortcutEntry(
            id: "go-to-file",
            keys: "⌘P",
            label: "Go to File",
            category: .general,
            context: .always
        ),
        ShortcutEntry(
            id: "search",
            keys: "⇧⌘F",
            label: "Search",
            category: .general,
            context: .always
        ),
        ShortcutEntry(
            id: "new-terminal",
            keys: "⌘`",
            label: "New Terminal",
            category: .general,
            context: .always
        ),
        ShortcutEntry(
            id: "toggle-neovim",
            keys: "⇧⌘N",
            label: "Toggle Neovim",
            category: .general,
            context: .always
        ),

        // Tabs (tmux prefix)
        ShortcutEntry(
            id: "tab-new-terminal",
            keys: "C",
            label: "New Terminal",
            category: .tabs,
            context: .prefixActive
        ),
        ShortcutEntry(
            id: "tab-next",
            keys: "N",
            label: "Next Tab",
            category: .tabs,
            context: .prefixActive
        ),
        ShortcutEntry(
            id: "tab-prev",
            keys: "P",
            label: "Prev Tab",
            category: .tabs,
            context: .prefixActive
        ),
        ShortcutEntry(
            id: "tab-select",
            keys: "1-9",
            label: "Select Tab",
            category: .tabs,
            context: .prefixActive
        ),
        ShortcutEntry(
            id: "tab-close",
            keys: "&",
            label: "Close Tab",
            category: .tabs,
            context: .prefixActive
        ),

        // Command Palette
        ShortcutEntry(
            id: "palette-nav",
            keys: "↑/↓",
            label: "Navigate",
            category: .commandPalette,
            context: .commandPaletteOpen
        ),
        ShortcutEntry(
            id: "palette-select",
            keys: "Enter",
            label: "Select",
            category: .commandPalette,
            context: .commandPaletteOpen
        ),
        ShortcutEntry(
            id: "palette-close",
            keys: "Esc",
            label: "Close",
            category: .commandPalette,
            context: .commandPaletteOpen
        ),
        ShortcutEntry(
            id: "palette-command",
            keys: ">",
            label: "Command Mode",
            category: .commandPalette,
            context: .commandPaletteOpen
        ),

        // Search
        ShortcutEntry(
            id: "search-close",
            keys: "Esc",
            label: "Close",
            category: .search,
            context: .searchOpen
        ),

        // Neovim Normal
        ShortcutEntry(
            id: "nvim-normal-insert",
            keys: "i",
            label: "Insert before cursor",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-append",
            keys: "a",
            label: "Insert after cursor",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-open-line",
            keys: "o",
            label: "New line below",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-delete-line",
            keys: "dd",
            label: "Delete line",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-yank-line",
            keys: "yy",
            label: "Yank line",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-paste",
            keys: "p",
            label: "Paste",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-undo",
            keys: "u",
            label: "Undo",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-redo",
            keys: "⌃R",
            label: "Redo",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-search",
            keys: "/",
            label: "Search",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-write",
            keys: ":w",
            label: "Save",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-quit",
            keys: ":q",
            label: "Quit",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-top",
            keys: "gg",
            label: "Go to top",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-bottom",
            keys: "G",
            label: "Go to bottom",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-next-word",
            keys: "w",
            label: "Next word",
            category: .neovim,
            context: .neovimMode(.normal)
        ),
        ShortcutEntry(
            id: "nvim-normal-prev-word",
            keys: "b",
            label: "Prev word",
            category: .neovim,
            context: .neovimMode(.normal)
        ),

        // Neovim Insert
        ShortcutEntry(
            id: "nvim-insert-normal",
            keys: "Esc",
            label: "Return to normal",
            category: .neovim,
            context: .neovimMode(.insert)
        ),
        ShortcutEntry(
            id: "nvim-insert-normal-ctrl",
            keys: "⌃[",
            label: "Return to normal",
            category: .neovim,
            context: .neovimMode(.insert)
        ),

        // Neovim Visual
        ShortcutEntry(
            id: "nvim-visual-yank",
            keys: "y",
            label: "Yank selection",
            category: .neovim,
            context: .neovimMode(.visual)
        ),
        ShortcutEntry(
            id: "nvim-visual-delete",
            keys: "d",
            label: "Delete selection",
            category: .neovim,
            context: .neovimMode(.visual)
        ),
        ShortcutEntry(
            id: "nvim-visual-indent",
            keys: ">",
            label: "Indent",
            category: .neovim,
            context: .neovimMode(.visual)
        ),
        ShortcutEntry(
            id: "nvim-visual-outdent",
            keys: "<",
            label: "Unindent",
            category: .neovim,
            context: .neovimMode(.visual)
        ),
        ShortcutEntry(
            id: "nvim-visual-exit",
            keys: "Esc",
            label: "Exit visual",
            category: .neovim,
            context: .neovimMode(.visual)
        ),

        // Neovim Command
        ShortcutEntry(
            id: "nvim-command-exec",
            keys: "Enter",
            label: "Run command",
            category: .neovim,
            context: .neovimMode(.command)
        ),
        ShortcutEntry(
            id: "nvim-command-exit",
            keys: "Esc",
            label: "Cancel",
            category: .neovim,
            context: .neovimMode(.command)
        ),
    ]
}
