import Foundation
import CryptoKit
import CoreGraphics

enum ChatHistoryStore {
    private static let currentVersion = 3

    @MainActor
    static func loadHistory(for rootDirectory: URL) -> [ChatMessage]? {
        guard let url = resolvedHistoryURL(for: rootDirectory) else { return nil }
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let payload = try? decoder.decode(ChatHistoryPayload.self, from: data) else { return nil }
        let imagesDir = imagesDirectory(for: rootDirectory)
        let messages = payload.messages.map { $0.asChatMessage(imagesDirectory: imagesDir) }
        return messages
    }

    static func saveHistory(_ messages: [ChatMessage], for rootDirectory: URL) {
        guard let url = historyURL(for: rootDirectory) else { return }
        let imagesDir = imagesDirectory(for: rootDirectory)
        if let imagesDir {
            try? FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)
        }
        var usedFiles = Set<String>()
        var payloadMessages: [ChatHistoryMessage] = []
        payloadMessages.reserveCapacity(messages.count)
        for message in messages {
            payloadMessages.append(ChatHistoryMessage(message, imagesDirectory: imagesDir, usedFiles: &usedFiles))
        }

        if let imagesDir {
            let fm = FileManager.default
            if let existing = try? fm.contentsOfDirectory(at: imagesDir, includingPropertiesForKeys: nil) {
                for fileURL in existing {
                    if !usedFiles.contains(fileURL.lastPathComponent) {
                        try? fm.removeItem(at: fileURL)
                    }
                }
            }
        }

        let payload = ChatHistoryPayload(
            version: currentVersion,
            rootPath: rootDirectory.standardizedFileURL.path,
            messages: payloadMessages
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(payload) else { return }
        let folder = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? data.write(to: url, options: [.atomic])
        if let legacy = legacyHistoryURL(for: rootDirectory), legacy.path != url.path {
            try? FileManager.default.removeItem(at: legacy)
        }
    }

    private static func historyDirectory(for rootDirectory: URL) -> URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let hash = hashedPath(rootDirectory.standardizedFileURL.path)
        return base
            .appendingPathComponent("Smithers", isDirectory: true)
            .appendingPathComponent("ChatHistory", isDirectory: true)
            .appendingPathComponent(hash, isDirectory: true)
    }

    private static func historyURL(for rootDirectory: URL) -> URL? {
        guard let directory = historyDirectory(for: rootDirectory) else { return nil }
        return directory.appendingPathComponent("history.json")
    }

    private static func legacyHistoryURL(for rootDirectory: URL) -> URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let directory = base
            .appendingPathComponent("Smithers", isDirectory: true)
            .appendingPathComponent("ChatHistory", isDirectory: true)
        let hash = hashedPath(rootDirectory.standardizedFileURL.path)
        return directory.appendingPathComponent("history-\(hash).json")
    }

    private static func resolvedHistoryURL(for rootDirectory: URL) -> URL? {
        if let url = historyURL(for: rootDirectory), FileManager.default.fileExists(atPath: url.path) {
            return url
        }
        return legacyHistoryURL(for: rootDirectory)
    }

    private static func imagesDirectory(for rootDirectory: URL) -> URL? {
        guard let directory = historyDirectory(for: rootDirectory) else { return nil }
        return directory.appendingPathComponent("images", isDirectory: true)
    }

    private static func hashedPath(_ path: String) -> String {
        let digest = SHA256.hash(data: Data(path.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

private struct ChatHistoryPayload: Codable {
    let version: Int
    let rootPath: String?
    let messages: [ChatHistoryMessage]

    init(version: Int, rootPath: String?, messages: [ChatHistoryMessage]) {
        self.version = version
        self.rootPath = rootPath
        self.messages = messages
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? container.decode(Int.self, forKey: .version)) ?? 1
        rootPath = try? container.decode(String.self, forKey: .rootPath)
        messages = (try? container.decode([ChatHistoryMessage].self, forKey: .messages)) ?? []
    }
}

private struct ChatHistoryMessage: Codable {
    let role: ChatHistoryRole
    let kind: ChatHistoryKind
    let images: [ChatHistoryImage]
    let turnId: String?
    let timestamp: Date

    init(role: ChatHistoryRole, kind: ChatHistoryKind, images: [ChatHistoryImage], turnId: String?, timestamp: Date) {
        self.role = role
        self.kind = kind
        self.images = images
        self.turnId = turnId
        self.timestamp = timestamp
    }

    init(_ message: ChatMessage, imagesDirectory: URL?, usedFiles: inout Set<String>) {
        role = ChatHistoryRole(message.role)
        kind = ChatHistoryKind(message.kind)
        images = message.images.map { image in
            let stored = ChatHistoryImage(image, imagesDirectory: imagesDirectory)
            if let fileName = stored.fileName {
                usedFiles.insert(fileName)
            }
            return stored
        }
        turnId = message.turnId
        timestamp = message.timestamp
    }

    func asChatMessage(imagesDirectory: URL?) -> ChatMessage {
        let restoredImages = images.compactMap { $0.asChatImage(imagesDirectory: imagesDirectory) }
        return ChatMessage(
            role: role.asChatRole(),
            kind: kind.asChatKind(),
            images: restoredImages,
            isStreaming: false,
            turnId: turnId,
            timestamp: timestamp
        )
    }

    private enum CodingKeys: String, CodingKey {
        case role
        case kind
        case images
        case turnId
        case timestamp
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = (try? container.decode(ChatHistoryRole.self, forKey: .role)) ?? .assistant
        kind = (try? container.decode(ChatHistoryKind.self, forKey: .kind)) ?? .text("")
        images = (try? container.decode([ChatHistoryImage].self, forKey: .images)) ?? []
        turnId = try? container.decode(String.self, forKey: .turnId)
        timestamp = (try? container.decode(Date.self, forKey: .timestamp)) ?? Date()
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(role, forKey: .role)
        try container.encode(kind, forKey: .kind)
        if !images.isEmpty {
            try container.encode(images, forKey: .images)
        }
        try container.encode(turnId, forKey: .turnId)
        try container.encode(timestamp, forKey: .timestamp)
    }
}

private struct ChatHistoryImage: Codable {
    let id: String
    let fileName: String?
    let data: String?
    let originalWidth: Double
    let originalHeight: Double

    init(id: String, fileName: String?, data: String?, originalWidth: Double, originalHeight: Double) {
        self.id = id
        self.fileName = fileName
        self.data = data
        self.originalWidth = originalWidth
        self.originalHeight = originalHeight
    }

    init(_ image: ChatImage, imagesDirectory: URL?) {
        id = image.id.uuidString
        let fileName = "\(id).png"
        if let imagesDirectory {
            let fileURL = imagesDirectory.appendingPathComponent(fileName)
            if FileManager.default.fileExists(atPath: fileURL.path) || ((try? image.data.write(to: fileURL, options: [.atomic])) != nil) {
                self.fileName = fileName
                self.data = nil
            } else {
                self.fileName = nil
                self.data = image.data.base64EncodedString()
            }
        } else {
            self.fileName = nil
            self.data = image.data.base64EncodedString()
        }
        originalWidth = Double(image.originalSize.width)
        originalHeight = Double(image.originalSize.height)
    }

    func asChatImage(imagesDirectory: URL?) -> ChatImage? {
        let size = CGSize(width: originalWidth, height: originalHeight)
        let uuid = UUID(uuidString: id)
        if let fileName, let imagesDirectory {
            let fileURL = imagesDirectory.appendingPathComponent(fileName)
            if let decoded = try? Data(contentsOf: fileURL) {
                return ChatImage.fromData(decoded, originalSize: size, id: uuid)
            }
        }
        if let data, let decoded = Data(base64Encoded: data) {
            return ChatImage.fromData(decoded, originalSize: size, id: uuid)
        }
        return nil
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case fileName
        case data
        case originalWidth
        case originalHeight
    }
}

private enum ChatHistoryRole: String, Codable {
    case user
    case assistant

    init(_ role: ChatMessage.Role) {
        switch role {
        case .user:
            self = .user
        case .assistant:
            self = .assistant
        }
    }

    func asChatRole() -> ChatMessage.Role {
        switch self {
        case .user:
            return .user
        case .assistant:
            return .assistant
        }
    }
}

private enum ChatHistoryKind: Codable {
    case text(String)
    case status(String)
    case command(CommandExecutionInfoPayload)
    case diffPreview(DiffPreviewPayload)
    case starterPrompt(title: String, suggestions: [String])

    private enum CodingKeys: String, CodingKey {
        case type
        case text
        case status
        case command
        case diffPreview
        case title
        case suggestions
    }

    private enum KindType: String, Codable {
        case text
        case status
        case command
        case diffPreview
        case starterPrompt
    }

    init(_ kind: ChatMessage.Kind) {
        switch kind {
        case .text(let text):
            self = .text(text)
        case .status(let status):
            self = .status(status)
        case .command(let info):
            self = .command(CommandExecutionInfoPayload(info))
        case .diffPreview(let preview):
            self = .diffPreview(DiffPreviewPayload(preview))
        case .starterPrompt(let title, let suggestions):
            self = .starterPrompt(title: title, suggestions: suggestions)
        }
    }

    func asChatKind() -> ChatMessage.Kind {
        switch self {
        case .text(let text):
            return .text(text)
        case .status(let status):
            return .status(status)
        case .command(let payload):
            return .command(payload.asCommandExecutionInfo())
        case .diffPreview(let payload):
            return .diffPreview(payload.asDiffPreview())
        case .starterPrompt(let title, let suggestions):
            return .starterPrompt(title: title, suggestions: suggestions)
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = (try? container.decode(KindType.self, forKey: .type)) ?? .text
        switch kind {
        case .text:
            let text = (try? container.decode(String.self, forKey: .text)) ?? ""
            self = .text(text)
        case .status:
            let status = (try? container.decode(String.self, forKey: .status)) ?? ""
            self = .status(status)
        case .command:
            let command = (try? container.decode(CommandExecutionInfoPayload.self, forKey: .command))
                ?? CommandExecutionInfoPayload.fallback
            self = .command(command)
        case .diffPreview:
            let preview = (try? container.decode(DiffPreviewPayload.self, forKey: .diffPreview))
                ?? DiffPreviewPayload.fallback
            self = .diffPreview(preview)
        case .starterPrompt:
            let title = (try? container.decode(String.self, forKey: .title)) ?? ""
            let suggestions = (try? container.decode([String].self, forKey: .suggestions)) ?? []
            self = .starterPrompt(title: title, suggestions: suggestions)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text):
            try container.encode(KindType.text, forKey: .type)
            try container.encode(text, forKey: .text)
        case .status(let status):
            try container.encode(KindType.status, forKey: .type)
            try container.encode(status, forKey: .status)
        case .command(let command):
            try container.encode(KindType.command, forKey: .type)
            try container.encode(command, forKey: .command)
        case .diffPreview(let preview):
            try container.encode(KindType.diffPreview, forKey: .type)
            try container.encode(preview, forKey: .diffPreview)
        case .starterPrompt(let title, let suggestions):
            try container.encode(KindType.starterPrompt, forKey: .type)
            try container.encode(title, forKey: .title)
            try container.encode(suggestions, forKey: .suggestions)
        }
    }
}

private struct CommandExecutionInfoPayload: Codable {
    let itemId: String
    let command: String
    let cwd: String
    let output: String
    let exitCode: Int?
    let status: CommandExecutionStatusPayload

    static let fallback = CommandExecutionInfoPayload(
        itemId: "",
        command: "",
        cwd: "",
        output: "",
        exitCode: nil,
        status: .completed
    )

    init(itemId: String, command: String, cwd: String, output: String, exitCode: Int?, status: CommandExecutionStatusPayload) {
        self.itemId = itemId
        self.command = command
        self.cwd = cwd
        self.output = output
        self.exitCode = exitCode
        self.status = status
    }

    init(_ info: CommandExecutionInfo) {
        itemId = info.itemId
        command = info.command
        cwd = info.cwd
        output = info.output
        exitCode = info.exitCode
        status = CommandExecutionStatusPayload(info.status)
    }

    func asCommandExecutionInfo() -> CommandExecutionInfo {
        CommandExecutionInfo(
            itemId: itemId,
            command: command,
            cwd: cwd,
            output: output,
            exitCode: exitCode,
            status: status.asCommandStatus()
        )
    }
}

private enum CommandExecutionStatusPayload: String, Codable {
    case running
    case completed

    init(_ status: CommandExecutionStatus) {
        switch status {
        case .running:
            self = .running
        case .completed:
            self = .completed
        }
    }

    func asCommandStatus() -> CommandExecutionStatus {
        switch self {
        case .running:
            return .running
        case .completed:
            return .completed
        }
    }
}

private struct DiffPreviewPayload: Codable {
    let turnId: String?
    let files: [String]
    let summary: String
    let previewLines: [String]
    let diff: String
    let status: PatchApplyStatusPayload

    static let fallback = DiffPreviewPayload(
        turnId: nil,
        files: [],
        summary: "",
        previewLines: [],
        diff: "",
        status: .completed
    )

    init(
        turnId: String?,
        files: [String],
        summary: String,
        previewLines: [String],
        diff: String,
        status: PatchApplyStatusPayload
    ) {
        self.turnId = turnId
        self.files = files
        self.summary = summary
        self.previewLines = previewLines
        self.diff = diff
        self.status = status
    }

    init(_ preview: DiffPreview) {
        turnId = preview.turnId
        files = preview.files
        summary = preview.summary
        previewLines = preview.previewLines
        diff = preview.diff
        status = PatchApplyStatusPayload(preview.status)
    }

    func asDiffPreview() -> DiffPreview {
        DiffPreview(
            id: UUID(),
            turnId: turnId,
            files: files,
            summary: summary,
            previewLines: previewLines,
            diff: diff,
            status: status.asPatchStatus()
        )
    }
}

private enum PatchApplyStatusPayload: String, Codable {
    case inProgress
    case completed
    case failed
    case declined

    init(_ status: PatchApplyStatus) {
        switch status {
        case .inProgress:
            self = .inProgress
        case .completed:
            self = .completed
        case .failed:
            self = .failed
        case .declined:
            self = .declined
        }
    }

    func asPatchStatus() -> PatchApplyStatus {
        PatchApplyStatus(rawValue: rawValue) ?? .completed
    }
}
