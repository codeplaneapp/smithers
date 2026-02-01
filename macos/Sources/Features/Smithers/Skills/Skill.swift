import Foundation

/// Execution mode for a skill
enum SkillMode: String, Codable {
    /// Produces artifact, not appended to chat
    case sideAction = "side_action"
    /// Creates run nodes + optionally appends messages
    case agentRun = "agent_run"
}

/// Metadata about a skill
struct Skill: Identifiable, Codable {
    /// Unique identifier for this skill
    let id: String
    /// Display name for this skill
    let name: String
    /// Optional description of what this skill does
    let description: String
    /// Execution mode for this skill
    let mode: SkillMode
    /// Optional icon name for UI display (SF Symbol name)
    let icon: String?

    init(id: String, name: String, description: String = "", mode: SkillMode = .sideAction, icon: String? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.mode = mode
        self.icon = icon
    }
}

/// Hard-coded registry of built-in skills
/// In v2, this will be loaded from Python or a manifest
struct SkillRegistry {
    /// All available skills
    static let builtinSkills: [Skill] = [
        Skill(
            id: "summarize",
            name: "Summarize Session",
            description: "Create a concise summary of the session history",
            mode: .sideAction,
            icon: "doc.text"
        ),
        Skill(
            id: "plan",
            name: "Create Implementation Plan",
            description: "Generate a structured plan for implementing a task",
            mode: .sideAction,
            icon: "list.bullet.clipboard"
        ),
    ]

    /// Get a skill by ID
    static func skill(withId id: String) -> Skill? {
        builtinSkills.first { $0.id == id }
    }
}
