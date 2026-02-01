import Foundation

/// A request to send to agentd
struct AgentRequest: Encodable {
    let id: String
    let method: String
    let params: [String: AnyCodable]

    init(method: String, params: [String: Any] = [:]) {
        self.id = UUID().uuidString
        self.method = method
        self.params = params.mapValues { AnyCodable($0) }
    }

    /// Create a session
    static func createSession(workspaceRoot: String) -> AgentRequest {
        AgentRequest(method: "session.create", params: ["workspace_root": workspaceRoot])
    }

    /// Send a message to a session
    static func sendMessage(sessionId: String, message: String, surfaces: [[String: Any]] = []) -> AgentRequest {
        AgentRequest(method: "session.send", params: [
            "session_id": sessionId,
            "message": message,
            "surfaces": surfaces,
        ])
    }

    /// Cancel a run
    static func cancelRun(runId: String) -> AgentRequest {
        AgentRequest(method: "run.cancel", params: ["run_id": runId])
    }

    /// Run a skill
    static func runSkill(sessionId: String, skillId: String, args: String? = nil) -> AgentRequest {
        var params: [String: Any] = [
            "session_id": sessionId,
            "skill_id": skillId,
        ]
        if let args = args {
            params["args"] = args
        }
        return AgentRequest(method: "skill.run", params: params)
    }

    /// Create a checkpoint
    static func createCheckpoint(sessionId: String, message: String, sessionNodeId: String? = nil) -> AgentRequest {
        var params: [String: Any] = [
            "session_id": sessionId,
            "message": message,
        ]
        if let sessionNodeId = sessionNodeId {
            params["session_node_id"] = sessionNodeId
        }
        return AgentRequest(method: "checkpoint.create", params: params)
    }

    /// Restore a checkpoint
    static func restoreCheckpoint(sessionId: String, checkpointId: String) -> AgentRequest {
        AgentRequest(method: "checkpoint.restore", params: [
            "session_id": sessionId,
            "checkpoint_id": checkpointId,
        ])
    }

    /// Search events
    static func searchEvents(query: String, sessionId: String? = nil, limit: Int = 50) -> AgentRequest {
        var params: [String: Any] = [
            "query": query,
            "limit": limit,
        ]
        if let sessionId = sessionId {
            params["session_id"] = sessionId
        }
        return AgentRequest(method: "search.events", params: params)
    }

    /// Search checkpoints
    static func searchCheckpoints(query: String, sessionId: String? = nil, limit: Int = 50) -> AgentRequest {
        var params: [String: Any] = [
            "query": query,
            "limit": limit,
        ]
        if let sessionId = sessionId {
            params["session_id"] = sessionId
        }
        return AgentRequest(method: "search.checkpoints", params: params)
    }

    /// Search all content (events and checkpoints)
    static func searchAll(query: String, sessionId: String? = nil, limit: Int = 50) -> AgentRequest {
        var params: [String: Any] = [
            "query": query,
            "limit": limit,
        ]
        if let sessionId = sessionId {
            params["session_id"] = sessionId
        }
        return AgentRequest(method: "search.all", params: params)
    }
}
