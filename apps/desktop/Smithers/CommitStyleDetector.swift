import Foundation

struct CommitStyleDetector {
    /// Analyze commit messages to detect the repository's commit style
    static func detect(from messages: [String]) -> CommitStyle {
        guard !messages.isEmpty else { return .freeform }

        let filtered = messages.filter { msg in
            let trimmed = msg.trimmingCharacters(in: .whitespacesAndNewlines)
            return !trimmed.isEmpty && !trimmed.hasPrefix("(empty)")
        }
        guard !filtered.isEmpty else { return .freeform }

        var conventionalCount = 0
        var emojiConventionalCount = 0
        var ticketPrefixedCount = 0
        var imperativeCount = 0
        var detectedTicketPrefix: String?

        let conventionalPrefixes = ["feat:", "fix:", "chore:", "docs:", "style:", "refactor:", "perf:", "test:", "build:", "ci:", "revert:"]
        let conventionalWithScope = try? NSRegularExpression(pattern: "^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\\(.*\\):", options: [])

        let ticketPattern = try? NSRegularExpression(pattern: "^([A-Z]{2,10})-\\d+", options: [])

        let imperativeVerbs = ["Add", "Fix", "Update", "Remove", "Refactor", "Implement", "Create", "Delete", "Move", "Rename", "Change", "Set", "Use", "Make", "Enable", "Disable", "Allow", "Prevent", "Handle", "Support", "Improve", "Optimize", "Clean", "Extract", "Merge", "Split", "Replace", "Convert", "Simplify", "Reorganize"]

        for msg in filtered {
            let firstLine = msg.components(separatedBy: "\n").first ?? msg
            let trimmed = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)

            // Check emoji conventional
            let hasLeadingEmoji = trimmed.first?.unicodeScalars.contains {
                $0.properties.isEmoji || $0.properties.isEmojiPresentation
            } ?? false
            if hasLeadingEmoji {
                let afterEmoji = trimmed.drop { c in
                    c.unicodeScalars.allSatisfy { $0.properties.isEmoji || $0.properties.isEmojiPresentation || $0.value == 0xFE0F || $0 == " " }
                }
                let afterEmojiStr = String(afterEmoji).trimmingCharacters(in: .whitespaces)
                if conventionalPrefixes.contains(where: { afterEmojiStr.lowercased().hasPrefix($0) }) {
                    emojiConventionalCount += 1
                    continue
                }
            }

            // Check conventional commits
            if conventionalPrefixes.contains(where: { trimmed.lowercased().hasPrefix($0) }) {
                conventionalCount += 1
                continue
            }
            if let conventionalWithScope,
               conventionalWithScope.firstMatch(in: trimmed.lowercased(), range: NSRange(trimmed.startIndex..., in: trimmed)) != nil {
                conventionalCount += 1
                continue
            }

            // Check ticket prefixed
            if let ticketPattern,
               let match = ticketPattern.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
               let prefixRange = Range(match.range(at: 1), in: trimmed) {
                ticketPrefixedCount += 1
                detectedTicketPrefix = String(trimmed[prefixRange])
                continue
            }

            // Check imperative mood
            if imperativeVerbs.contains(where: { trimmed.hasPrefix($0 + " ") || trimmed == $0 }) {
                imperativeCount += 1
                continue
            }
        }

        let total = filtered.count
        let threshold = Double(total) * 0.4

        if Double(emojiConventionalCount) >= threshold {
            return .emojiConventional
        }
        if Double(conventionalCount) >= threshold {
            return .conventional
        }
        if Double(ticketPrefixedCount) >= threshold, let prefix = detectedTicketPrefix {
            return .ticketPrefixed(prefix)
        }
        if Double(imperativeCount) >= threshold {
            return .imperative
        }

        return .freeform
    }

    /// Detect commit style from a jj repository
    static func detectFromRepo(jjService: JJService) async -> CommitStyle {
        do {
            let changes = try await jjService.log(revset: "ancestors(trunk(), 30)", limit: 30)
            let messages = changes.map { $0.description.components(separatedBy: "\n").first ?? "" }
            return detect(from: messages)
        } catch {
            return .freeform
        }
    }
}
