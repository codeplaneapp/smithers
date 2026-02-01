import Foundation

/// All event types from the Agent Runtime Protocol
enum AgentEventType: String, Codable {
    // Daemon lifecycle
    case daemonReady = "daemon.ready"
    case daemonError = "daemon.error"

    // Session events
    case sessionCreated = "session.created"
    case sessionClosed = "session.closed"

    // Run control
    case runStarted = "run.started"
    case runFinished = "run.finished"
    case runCancelled = "run.cancelled"
    case runError = "run.error"

    // Streaming
    case assistantDelta = "assistant.delta"
    case assistantFinal = "assistant.final"

    // Tools
    case toolStart = "tool.start"
    case toolOutputRef = "tool.output_ref"
    case toolEnd = "tool.end"

    // Checkpoints
    case checkpointCreated = "checkpoint.created"
    case checkpointRestored = "checkpoint.restored"

    // Stack operations
    case stackRebased = "stack.rebased"
    case syncStatus = "sync.status"

    // Subagents
    case subagentStart = "subagent.start"
    case subagentEnd = "subagent.end"

    // Skills
    case skillStart = "skill.start"
    case skillResult = "skill.result"
    case skillEnd = "skill.end"

    // Forms
    case formCreate = "form.create"
    case formSubmit = "form.submit"

    // Search
    case searchResults = "search.results"

    // Generic error
    case error = "error"
}

/// A protocol event received from agentd
struct AgentEvent: Codable, Identifiable {
    let id: UUID
    let type: AgentEventType
    let data: [String: AnyCodable]
    let timestamp: Date

    init(type: AgentEventType, data: [String: AnyCodable] = [:]) {
        self.id = UUID()
        self.type = type
        self.data = data
        self.timestamp = Date()
    }
}

/// Type-erased Codable for JSON data
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            value = string
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            value = NSNull()
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let string as String:
            try container.encode(string)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let bool as Bool:
            try container.encode(bool)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encodeNil()
        }
    }
}
