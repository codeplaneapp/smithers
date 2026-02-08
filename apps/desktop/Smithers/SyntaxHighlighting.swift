import Foundation
import Dispatch
import AppKit
import STTextView
import SwiftTreeSitter

import TreeSitterSwift
import TreeSitterJavaScript
import TreeSitterPython
import TreeSitterJSON
import TreeSitterBash
import TreeSitterTypeScript
import TreeSitterTSX
import TreeSitterMarkdown
import TreeSitterMarkdownInline
import TreeSitterZig
import TreeSitterRust
import TreeSitterGo

struct SupportedLanguage {
    let language: Language
    let name: String
    let bundleName: String?

    static func fromFileName(_ fileName: String) -> SupportedLanguage? {
        let ext = (fileName as NSString).pathExtension
        if !ext.isEmpty {
            return from(fileExtension: ext)
        }
        switch fileName.lowercased() {
        case "makefile", "gnumakefile", "dockerfile":
            return make(tree_sitter_bash(), name: "Bash")
        default:
            return nil
        }
    }

    static func from(fileExtension ext: String) -> SupportedLanguage? {
        switch ext.lowercased() {
        case "swift":
            return make(tree_sitter_swift(), name: "Swift")
        case "js", "mjs", "cjs", "jsx":
            return make(tree_sitter_javascript(), name: "JavaScript")
        case "ts", "mts", "cts":
            return make(tree_sitter_typescript(), name: "TypeScript")
        case "tsx":
            return make(tree_sitter_tsx(), name: "TSX", bundleName: "TreeSitterTypeScript_TreeSitterTSX")
        case "py":
            return make(tree_sitter_python(), name: "Python")
        case "json":
            return make(tree_sitter_json(), name: "JSON")
        case "sh", "bash", "zsh":
            return make(tree_sitter_bash(), name: "Bash")
        case "md", "markdown":
            return make(tree_sitter_markdown(), name: "Markdown")
        case "zig", "zon":
            return make(tree_sitter_zig(), name: "Zig")
        case "rs":
            return make(tree_sitter_rust(), name: "Rust")
        case "go":
            return make(tree_sitter_go(), name: "Go")
        default:
            return nil
        }
    }

    private static func make(_ parser: OpaquePointer, name: String, bundleName: String? = nil) -> SupportedLanguage {
        SupportedLanguage(language: Language(language: parser), name: name, bundleName: bundleName)
    }
}

final class TreeSitterHighlighter {
    private struct HighlightSpan {
        let name: String
        let range: NSRange
    }

    private let parser = Parser()
    private let lang: SupportedLanguage
    private let query: Query?
    private let inlineParser: Parser?
    private let inlineQuery: Query?
    private let parseQueue = DispatchQueue(label: "com.smithers.syntaxHighlight", qos: .userInitiated)
    private var requestID: Int = 0
    private static let maxHighlightCharacters = 200_000
    private static let maxInlineHighlightCharacters = 80_000

    init(language: SupportedLanguage) {
        self.lang = language
        try? parser.setLanguage(language.language)

        let config: LanguageConfiguration?
        if let bundleName = language.bundleName {
            config = try? LanguageConfiguration(language.language, name: language.name, bundleName: bundleName)
        } else {
            config = try? LanguageConfiguration(language.language, name: language.name)
        }
        self.query = config?.queries[.highlights]

        if language.name == "Markdown" {
            let inlineLang = Language(language: tree_sitter_markdown_inline())
            let ip = Parser()
            try? ip.setLanguage(inlineLang)
            self.inlineParser = ip
            let inlineConfig = try? LanguageConfiguration(
                inlineLang, name: "MarkdownInline",
                bundleName: "TreeSitterMarkdown_TreeSitterMarkdownInline"
            )
            self.inlineQuery = inlineConfig?.queries[.highlights]
        } else {
            self.inlineParser = nil
            self.inlineQuery = nil
        }
    }

    func highlight(text: String, textView: STTextView) {
        requestID += 1
        let currentID = requestID
        guard let query else { return }
        let source = text
        let length = (source as NSString).length
        if length > Self.maxHighlightCharacters {
            return
        }

        let shouldInline = length <= Self.maxInlineHighlightCharacters

        parseQueue.async { [weak self, weak textView] in
            guard let self else { return }
            let highlights = self.computeHighlights(text: source, parser: self.parser, query: query)
            var inlineHighlights: [HighlightSpan] = []
            if shouldInline, let inlineParser = self.inlineParser, let inlineQuery = self.inlineQuery {
                inlineHighlights = self.computeHighlights(text: source, parser: inlineParser, query: inlineQuery)
            }

            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, let textView else { return }
                guard currentID == self.requestID else { return }
                self.applyHighlights(highlights + inlineHighlights, source: source, textView: textView)
            }
        }
    }

    private func computeHighlights(text: String, parser: Parser, query: Query) -> [HighlightSpan] {
        guard let tree = parser.parse(text) else { return [] }
        let cursor = query.execute(in: tree)
        let highlights = cursor
            .resolve(with: .init(string: text))
            .highlights()
        return highlights.map { HighlightSpan(name: $0.name, range: $0.range) }
    }

    private func applyHighlights(_ highlights: [HighlightSpan], source: String, textView: STTextView) {
        let fullRange = NSRange(location: 0, length: (source as NSString).length)
        guard let storage = (textView.textContentManager as? NSTextContentStorage)?.textStorage else { return }

        storage.beginEditing()
        storage.addAttributes([.foregroundColor: NSColor.white], range: fullRange)

        for highlight in highlights {
            let nsRange = highlight.range
            guard nsRange.location >= 0,
                  nsRange.location + nsRange.length <= fullRange.length
            else { continue }

            if let color = Self.colorForCapture(highlight.name) {
                storage.addAttribute(.foregroundColor, value: color, range: nsRange)
            }
            if let font = Self.fontForCapture(highlight.name) {
                storage.addAttribute(.font, value: font, range: nsRange)
            }
        }

        storage.endEditing()
    }

    private static func colorForCapture(_ name: String) -> NSColor? {
        let base = name.components(separatedBy: ".").first ?? name
        switch base {
        case "keyword":
            return NSColor(red: 0.78, green: 0.46, blue: 0.82, alpha: 1) // purple
        case "string":
            return NSColor(red: 0.90, green: 0.56, blue: 0.35, alpha: 1) // orange
        case "comment":
            return NSColor(white: 0.45, alpha: 1) // gray
        case "number", "float", "boolean":
            return NSColor(red: 0.82, green: 0.77, blue: 0.55, alpha: 1) // yellow
        case "type":
            return NSColor(red: 0.35, green: 0.75, blue: 0.78, alpha: 1) // teal
        case "function", "method":
            return NSColor(red: 0.40, green: 0.65, blue: 0.90, alpha: 1) // blue
        case "constant":
            return NSColor(red: 0.82, green: 0.77, blue: 0.55, alpha: 1) // yellow
        case "operator":
            return NSColor(red: 0.35, green: 0.75, blue: 0.78, alpha: 1) // teal
        case "punctuation":
            return NSColor(white: 0.70, alpha: 1) // light gray
        case "attribute":
            return NSColor(red: 0.90, green: 0.56, blue: 0.35, alpha: 1) // orange
        case "tag":
            return NSColor(red: 0.90, green: 0.40, blue: 0.40, alpha: 1) // red
        case "property", "field":
            return NSColor(red: 0.40, green: 0.65, blue: 0.90, alpha: 1) // blue
        case "constructor":
            return NSColor(red: 0.82, green: 0.77, blue: 0.55, alpha: 1) // yellow
        case "variable":
            if name == "variable.builtin" || name == "variable.parameter" {
                return NSColor(red: 0.78, green: 0.46, blue: 0.82, alpha: 1) // purple
            }
            return nil
        case "include", "namespace", "module":
            return NSColor(red: 0.78, green: 0.46, blue: 0.82, alpha: 1) // purple
        case "label":
            return NSColor(red: 0.40, green: 0.65, blue: 0.90, alpha: 1) // blue
        case "text":
            if name.contains("title") || name.contains("heading") {
                return NSColor(red: 0.90, green: 0.40, blue: 0.40, alpha: 1) // red for headings
            }
            if name.contains("uri") || name.contains("link") {
                return NSColor(red: 0.40, green: 0.65, blue: 0.90, alpha: 1) // blue for links
            }
            if name.contains("literal") {
                return NSColor(red: 0.90, green: 0.56, blue: 0.35, alpha: 1) // orange for code
            }
            if name.contains("reference") {
                return NSColor(red: 0.35, green: 0.75, blue: 0.78, alpha: 1) // teal for refs
            }
            if name.contains("emphasis") {
                return NSColor(white: 0.85, alpha: 1)
            }
            if name.contains("strong") {
                return NSColor(white: 0.95, alpha: 1)
            }
            return nil
        case "escape":
            return NSColor(red: 0.35, green: 0.75, blue: 0.78, alpha: 1) // teal
        case "embedded":
            return nil
        case "parameter":
            return NSColor(red: 0.82, green: 0.60, blue: 0.50, alpha: 1) // muted orange
        case "preproc":
            return NSColor(red: 0.78, green: 0.46, blue: 0.82, alpha: 1) // purple
        case "define":
            return NSColor(red: 0.78, green: 0.46, blue: 0.82, alpha: 1) // purple
        case "conditional", "repeat", "exception":
            return NSColor(red: 0.78, green: 0.46, blue: 0.82, alpha: 1) // purple (keyword-like)
        case "storageclass":
            return NSColor(red: 0.78, green: 0.46, blue: 0.82, alpha: 1) // purple
        case "none":
            return nil
        default:
            return nil
        }
    }

    private static func fontForCapture(_ name: String) -> NSFont? {
        let base = name.components(separatedBy: ".").first ?? name
        if base == "keyword" {
            return NSFont.monospacedSystemFont(ofSize: 13, weight: .medium)
        }
        if name.contains("title") || name.contains("strong") {
            return NSFont.monospacedSystemFont(ofSize: 13, weight: .bold)
        }
        return nil
    }
}
