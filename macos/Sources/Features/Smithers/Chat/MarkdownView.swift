import SwiftUI
import AppKit

/// A view that renders markdown content with syntax highlighting for code blocks
struct MarkdownView: View {
    let content: String
    let isStreaming: Bool

    @State private var parsedContent: ParsedMarkdown?
    @State private var contentHash: Int = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let parsed = parsedContent {
                ForEach(Array(parsed.blocks.enumerated()), id: \.offset) { index, block in
                    blockView(for: block)
                }
            } else {
                // Fallback to simple text while parsing
                Text(content)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            parseContent()
        }
        .onChange(of: content) { _ in
            let newHash = content.hashValue
            if newHash != contentHash {
                contentHash = newHash
                parseContent()
            }
        }
    }

    @ViewBuilder
    private func blockView(for block: MarkdownBlock) -> some View {
        switch block {
        case .text(let attributedString):
            Text(attributedString)
                .textSelection(.enabled)
                .font(.system(size: 14))

        case .codeBlock(let code, let language):
            CodeBlockView(code: code, language: language)
        }
    }

    private func parseContent() {
        // For streaming content, parse synchronously to avoid flicker
        // For finalized content, we could parse in background if needed
        parsedContent = MarkdownParser.parse(content)
    }
}

/// Represents a parsed markdown document
struct ParsedMarkdown {
    let blocks: [MarkdownBlock]
}

/// A block in markdown content
enum MarkdownBlock {
    case text(AttributedString)
    case codeBlock(code: String, language: String?)
}

/// Parser for markdown content
struct MarkdownParser {
    static func parse(_ markdown: String) -> ParsedMarkdown {
        var blocks: [MarkdownBlock] = []

        // Split content by code blocks
        let pattern = #"```(\w+)?\n([\s\S]*?)```"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            // Fallback: parse as single text block
            if let attributed = try? AttributedString(
                markdown: markdown,
                options: AttributedString.MarkdownParsingOptions(
                    interpretedSyntax: .inlineOnlyPreservingWhitespace
                )
            ) {
                blocks.append(.text(styled(attributed)))
            }
            return ParsedMarkdown(blocks: blocks)
        }

        let nsString = markdown as NSString
        let matches = regex.matches(in: markdown, options: [], range: NSRange(location: 0, length: nsString.length))

        var lastIndex = 0

        for match in matches {
            // Add text before code block
            if match.range.location > lastIndex {
                let textRange = NSRange(location: lastIndex, length: match.range.location - lastIndex)
                let text = nsString.substring(with: textRange)
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    if let attributed = try? AttributedString(
                        markdown: text,
                        options: AttributedString.MarkdownParsingOptions(
                            interpretedSyntax: .inlineOnlyPreservingWhitespace
                        )
                    ) {
                        blocks.append(.text(styled(attributed)))
                    }
                }
            }

            // Extract language and code
            var language: String?
            if match.numberOfRanges > 1, match.range(at: 1).location != NSNotFound {
                language = nsString.substring(with: match.range(at: 1))
            }

            let codeRange = match.range(at: 2)
            let code = nsString.substring(with: codeRange)

            blocks.append(.codeBlock(code: code, language: language))

            lastIndex = match.range.location + match.range.length
        }

        // Add remaining text
        if lastIndex < nsString.length {
            let textRange = NSRange(location: lastIndex, length: nsString.length - lastIndex)
            let text = nsString.substring(with: textRange)
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if let attributed = try? AttributedString(
                    markdown: text,
                    options: AttributedString.MarkdownParsingOptions(
                        interpretedSyntax: .inlineOnlyPreservingWhitespace
                    )
                ) {
                    blocks.append(.text(styled(attributed)))
                }
            }
        }

        return ParsedMarkdown(blocks: blocks)
    }

    /// Apply consistent styling to markdown text
    private static func styled(_ attributedString: AttributedString) -> AttributedString {
        var result = attributedString

        // Style inline code
        for run in result.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                let range = run.range
                result[range].backgroundColor = NSColor.textBackgroundColor.withAlphaComponent(0.1)
                result[range].font = .monospacedSystemFont(ofSize: 13, weight: .regular)
            }
        }

        return result
    }
}

/// A view that renders a code block with syntax highlighting
struct CodeBlockView: View {
    let code: String
    let language: String?

    @State private var isHovered = false
    @State private var copiedToClipboard = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header with language and copy button
            HStack {
                if let lang = language {
                    Text(lang)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.secondary)
                        .textCase(.lowercase)
                } else {
                    Text("code")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.secondary)
                }

                Spacer()

                // Copy button (appears on hover)
                if isHovered || copiedToClipboard {
                    Button(action: copyToClipboard) {
                        HStack(spacing: 4) {
                            Image(systemName: copiedToClipboard ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 10))
                            Text(copiedToClipboard ? "Copied" : "Copy")
                                .font(.system(size: 10, weight: .medium))
                        }
                        .foregroundColor(copiedToClipboard ? .green : .secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))

            // Code content with syntax highlighting
            SyntaxHighlightedCodeView(code: code, language: language)
                .padding(12)
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.5))
        .cornerRadius(6)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
        )
        .onHover { hovering in
            isHovered = hovering
            if !hovering {
                // Reset copied state after hover ends
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    copiedToClipboard = false
                }
            }
        }
    }

    private func copyToClipboard() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)

        withAnimation {
            copiedToClipboard = true
        }

        // Reset after 2 seconds
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            withAnimation {
                copiedToClipboard = false
            }
        }
    }
}

/// A view that renders code with syntax highlighting
struct SyntaxHighlightedCodeView: View {
    let code: String
    let language: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(highlightedCode)
                .font(.system(size: 13, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Apply basic syntax highlighting based on language
    private var highlightedCode: AttributedString {
        var attributed = AttributedString(code)

        // Apply basic syntax highlighting based on language
        if let lang = language?.lowercased() {
            switch lang {
            case "python", "py":
                attributed = highlightPython(code)
            case "swift":
                attributed = highlightSwift(code)
            case "javascript", "js", "typescript", "ts":
                attributed = highlightJavaScript(code)
            case "bash", "sh", "shell":
                attributed = highlightBash(code)
            case "json":
                attributed = highlightJSON(code)
            default:
                // Generic highlighting for keywords
                attributed = highlightGeneric(code)
            }
        } else {
            // No language specified - use generic highlighting
            attributed = highlightGeneric(code)
        }

        return attributed
    }

    // MARK: - Language-Specific Highlighters

    private func highlightPython(_ code: String) -> AttributedString {
        var result = AttributedString(code)

        let keywords = ["def", "class", "import", "from", "return", "if", "else", "elif", "for", "while", "in", "is", "not", "and", "or", "try", "except", "finally", "with", "as", "async", "await", "lambda", "None", "True", "False"]

        result = highlightKeywords(in: result, keywords: keywords, color: .systemPurple)
        result = highlightStrings(in: result, color: .systemRed)
        result = highlightComments(in: result, pattern: #"#.*$"#, color: .systemGreen)

        return result
    }

    private func highlightSwift(_ code: String) -> AttributedString {
        var result = AttributedString(code)

        let keywords = ["func", "var", "let", "class", "struct", "enum", "protocol", "extension", "import", "return", "if", "else", "guard", "for", "while", "switch", "case", "break", "continue", "self", "nil", "true", "false", "private", "public", "internal", "static", "async", "await"]

        result = highlightKeywords(in: result, keywords: keywords, color: .systemPurple)
        result = highlightStrings(in: result, color: .systemRed)
        result = highlightComments(in: result, pattern: #"//.*$"#, color: .systemGreen)

        return result
    }

    private func highlightJavaScript(_ code: String) -> AttributedString {
        var result = AttributedString(code)

        let keywords = ["function", "const", "let", "var", "class", "import", "export", "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "async", "await", "try", "catch", "finally", "null", "undefined", "true", "false", "new", "this"]

        result = highlightKeywords(in: result, keywords: keywords, color: .systemPurple)
        result = highlightStrings(in: result, color: .systemRed)
        result = highlightComments(in: result, pattern: #"//.*$"#, color: .systemGreen)

        return result
    }

    private func highlightBash(_ code: String) -> AttributedString {
        var result = AttributedString(code)

        let keywords = ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "exit", "export", "source", "echo", "cd", "ls", "grep", "find", "sed", "awk"]

        result = highlightKeywords(in: result, keywords: keywords, color: .systemPurple)
        result = highlightStrings(in: result, color: .systemRed)
        result = highlightComments(in: result, pattern: #"#.*$"#, color: .systemGreen)

        return result
    }

    private func highlightJSON(_ code: String) -> AttributedString {
        var result = AttributedString(code)

        // Highlight JSON keys (strings followed by colon)
        result = highlightPattern(in: result, pattern: #""[^"]+"\s*:"#, color: .systemBlue)
        // Highlight string values
        result = highlightStrings(in: result, color: .systemRed)
        // Highlight numbers, booleans, null
        result = highlightPattern(in: result, pattern: #"\b(true|false|null|\d+\.?\d*)\b"#, color: .systemOrange)

        return result
    }

    private func highlightGeneric(_ code: String) -> AttributedString {
        var result = AttributedString(code)

        // Highlight common keywords across languages
        let keywords = ["function", "class", "def", "if", "else", "for", "while", "return", "import", "const", "let", "var"]
        result = highlightKeywords(in: result, keywords: keywords, color: .systemPurple)
        result = highlightStrings(in: result, color: .systemRed)

        return result
    }

    // MARK: - Helper Methods

    private func highlightKeywords(in text: AttributedString, keywords: [String], color: NSColor) -> AttributedString {
        var result = text
        let string = String(text.characters)

        for keyword in keywords {
            let pattern = "\\b\(keyword)\\b"
            result = highlightPattern(in: result, pattern: pattern, color: color)
        }

        return result
    }

    private func highlightStrings(in text: AttributedString, color: NSColor) -> AttributedString {
        var result = text
        // Match single and double quoted strings
        result = highlightPattern(in: result, pattern: #""[^"\\]*(\\.[^"\\]*)*""#, color: color)
        result = highlightPattern(in: result, pattern: #"'[^'\\]*(\\.[^'\\]*)*'"#, color: color)
        return result
    }

    private func highlightComments(in text: AttributedString, pattern: String, color: NSColor) -> AttributedString {
        return highlightPattern(in: text, pattern: pattern, color: color)
    }

    private func highlightPattern(in text: AttributedString, pattern: String, color: NSColor) -> AttributedString {
        var result = text
        let string = String(text.characters)

        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else {
            return result
        }

        let nsString = string as NSString
        let matches = regex.matches(in: string, options: [], range: NSRange(location: 0, length: nsString.length))

        for match in matches.reversed() {
            if let range = Range(match.range, in: string) {
                let start = AttributedString.Index(range.lowerBound, within: result)
                let end = AttributedString.Index(range.upperBound, within: result)

                if let start = start, let end = end {
                    result[start..<end].foregroundColor = Color(nsColor: color)
                }
            }
        }

        return result
    }
}

#Preview("Simple Markdown") {
    MarkdownView(
        content: """
        Here's some **bold text** and *italic text*.

        And some `inline code`.
        """,
        isStreaming: false
    )
    .frame(width: 600)
    .padding()
}

#Preview("With Code Block") {
    MarkdownView(
        content: """
        I'll help you fix the authentication bug. Here's the solution:

        ```python
        def authenticate(username, password):
            # Validate credentials
            if not username or not password:
                return False

            # Check expiration
            if token.is_expired():
                return False

            return True
        ```

        This adds proper validation.
        """,
        isStreaming: false
    )
    .frame(width: 600)
    .padding()
}

#Preview("Multiple Code Blocks") {
    MarkdownView(
        content: """
        First, let's update the Swift code:

        ```swift
        func validateToken(_ token: String) -> Bool {
            guard !token.isEmpty else { return false }
            return checkExpiration(token)
        }
        ```

        Then update the Python backend:

        ```python
        def validate_token(token: str) -> bool:
            if not token or is_expired(token):
                return False
            return True
        ```

        This ensures consistency across both layers.
        """,
        isStreaming: false
    )
    .frame(width: 600)
    .padding()
}
