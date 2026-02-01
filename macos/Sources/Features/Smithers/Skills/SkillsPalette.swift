import SwiftUI

/// Skills command palette (⌘K)
/// Displays available skills for the user to run
struct SkillsPalette: View {
    @Binding var isPresented: Bool
    let sessionId: String
    let onSelectSkill: (Skill, String?) -> Void

    @State private var searchText = ""
    @State private var selectedSkillId: String?
    @State private var skillArgs = ""
    @FocusState private var searchFocused: Bool

    var filteredSkills: [Skill] {
        if searchText.isEmpty {
            return SkillRegistry.builtinSkills
        }
        let lowercased = searchText.lowercased()
        return SkillRegistry.builtinSkills.filter { skill in
            skill.name.lowercased().contains(lowercased) ||
            skill.description.lowercased().contains(lowercased) ||
            skill.id.lowercased().contains(lowercased)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Search field
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                TextField("Search skills...", text: $searchText)
                    .textFieldStyle(.plain)
                    .focused($searchFocused)
                    .onSubmit {
                        runFirstSkill()
                    }
            }
            .padding()
            .background(Color(nsColor: .controlBackgroundColor))

            Divider()

            // Skills list
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(filteredSkills) { skill in
                        SkillRow(
                            skill: skill,
                            isSelected: selectedSkillId == skill.id,
                            onSelect: {
                                if selectedSkillId == skill.id {
                                    // Double-select: run immediately
                                    runSkill(skill)
                                } else {
                                    selectedSkillId = skill.id
                                }
                            }
                        )
                    }

                    if filteredSkills.isEmpty {
                        Text("No skills found")
                            .foregroundColor(.secondary)
                            .padding()
                    }
                }
            }

            // Args input (if a skill is selected)
            if let skillId = selectedSkillId,
               let skill = SkillRegistry.skill(withId: skillId) {
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    Text("Arguments (optional)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    TextField("Enter arguments...", text: $skillArgs)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Spacer()
                        Button("Cancel") {
                            selectedSkillId = nil
                            skillArgs = ""
                        }
                        .keyboardShortcut(.cancelAction)
                        Button("Run") {
                            runSkill(skill)
                        }
                        .keyboardShortcut(.defaultAction)
                    }
                }
                .padding()
                .background(Color(nsColor: .controlBackgroundColor))
            }
        }
        .frame(width: 500, height: 400)
        .onAppear {
            searchFocused = true
        }
    }

    private func runFirstSkill() {
        guard let firstSkill = filteredSkills.first else { return }
        runSkill(firstSkill)
    }

    private func runSkill(_ skill: Skill) {
        let args = skillArgs.isEmpty ? nil : skillArgs
        onSelectSkill(skill, args)
        isPresented = false
        // Reset state
        searchText = ""
        selectedSkillId = nil
        skillArgs = ""
    }
}

/// Row for a single skill in the palette
private struct SkillRow: View {
    let skill: Skill
    let isSelected: Bool
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                // Icon
                if let icon = skill.icon {
                    Image(systemName: icon)
                        .font(.title3)
                        .foregroundColor(isSelected ? .accentColor : .secondary)
                        .frame(width: 24)
                } else {
                    Rectangle()
                        .fill(Color.clear)
                        .frame(width: 24)
                }

                // Name and description
                VStack(alignment: .leading, spacing: 2) {
                    Text(skill.name)
                        .font(.body)
                        .foregroundColor(isSelected ? .primary : .primary)
                    Text(skill.description)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                // Mode badge
                Text(skill.mode == .sideAction ? "Side Action" : "Agent Run")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.secondary.opacity(0.1))
                    )
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(isSelected ? Color.accentColor.opacity(0.1) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    SkillsPalette(
        isPresented: .constant(true),
        sessionId: "test-session",
        onSelectSkill: { skill, args in
            print("Selected skill: \(skill.name), args: \(args ?? "none")")
        }
    )
}
