# Smithers UI Design Prompt

You are designing the UI/UX for **Smithers**, a native macOS terminal application that provides a chat-based interface to Claude AI agents. Your goal is to design a production-ready UI that renders Claude Code sessions in a clean, usable way—similar to ChatGPT or Claude's web interface, but built as a native desktop app.

---

## Product Vision

Smithers is a **native macOS application** that:
1. Runs Claude AI agents locally using the **Claude Agent SDK** (Python)
2. Displays agent sessions in a **chat-style UI** with a sidebar for session management
3. Eventually integrates **libghostty** for terminal rendering (but that's a future phase)

**For this design phase**, focus on the chat UI—rendering Claude's responses, user messages, tool usage, and streaming output in a native SwiftUI interface.

---

## Technology Stack

### Frontend (macOS App)
- **Language**: Swift 5.9+
- **UI Framework**: SwiftUI (macOS 13+)
- **Build System**: Xcode + Zig (see build commands below)
- **Terminal Rendering**: libghostty (future integration)

### Backend (AI Agent)
- **Language**: Python 3.12+
- **SDK**: `claude_agent_sdk` (Claude Agent SDK)
- **Package Manager**: uv

### Build Commands
```bash
# Build and run the macOS app
zig build run

# Run Python tests
zig build test

# Type check Python
zig build check

# Clean build artifacts
zig build clean
```

---

## Claude Agent SDK Overview

The Claude Agent SDK (formerly Claude Code SDK) provides the AI capabilities. Here's how it works:

### Basic Usage
```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions

async def main():
    async for message in query(
        prompt="Find and fix the bug in auth.py",
        options=ClaudeAgentOptions(allowed_tools=["Read", "Edit", "Bash"])
    ):
        print(message)  # Stream messages as Claude works

asyncio.run(main())
```

### Message Types from SDK
The SDK streams these message types that the UI must render:

1. **AssistantMessage** - Claude's thinking/reasoning text
   - Contains `content` blocks (text, tool_use, etc.)
   
2. **ToolUseBlock** - When Claude calls a tool
   - `name`: Tool name (Read, Edit, Bash, Glob, etc.)
   - `input`: Tool parameters
   
3. **ToolResultBlock** - Result after tool execution
   - `tool_use_id`: Links to the ToolUseBlock
   - `content`: The result (file contents, command output, etc.)

4. **ResultMessage** - Final result with cost/usage info
   - `subtype`: "success" | "error" | etc.
   - Contains usage statistics

### Built-in Tools
- **Read** - Read file contents
- **Edit** - Edit files
- **Bash** - Run terminal commands
- **Glob** - Find files by pattern
- **Grep** - Search file contents
- **WebSearch** - Search the web
- **WebFetch** - Fetch web pages

### Session Management
```python
from claude_agent_sdk import ClaudeSDKClient

async with ClaudeSDKClient() as client:
    # First exchange
    async for msg in client.query("Analyze this codebase"):
        handle(msg)
    
    # Follow-up in same session (maintains context)
    async for msg in client.query("Now fix the bugs you found"):
        handle(msg)
```

---

## Current UI Implementation

### Existing Files (in `macos/Sources/Features/Smithers/`)

#### Session.swift
```swift
struct Session: Identifiable {
    let id: UUID
    var title: String
    var createdAt: Date
    var isActive: Bool
}

enum SessionGroup: String, CaseIterable {
    case today = "Today"
    case yesterday = "Yesterday"
    case lastWeek = "Last Week"
    case older = "Older"
}
```

#### SmithersView.swift
```swift
struct SmithersView: View {
    @State private var sessions: [Session]
    @State private var selectedSessionId: UUID?

    var body: some View {
        NavigationSplitView {
            SessionSidebar(sessions: $sessions, selectedSessionId: $selectedSessionId)
        } detail: {
            SessionDetail(session: selectedSession)
        }
    }
}
```

#### SessionSidebar.swift
- Left sidebar showing all sessions grouped by date
- "New Chat" button at top
- Sessions grouped: Today, Yesterday, Last Week, Older
- Settings button at bottom

#### SessionDetail.swift
- Main content area (currently a placeholder)
- Header with session title and status
- Terminal-like placeholder content
- Input bar at bottom with text field + send button

---

## Design Requirements

### 1. Chat Message Rendering

Design how to render different message types:

**User Messages**
- Right-aligned or clearly distinct from Claude
- Show the prompt text
- Timestamp

**Assistant Messages** (Claude's responses)
- Left-aligned or full-width
- Render markdown (code blocks, lists, headers)
- Support streaming (show text appearing character by character)
- Syntax highlighting for code

**Tool Usage Display**
- Collapsible sections showing tool calls
- Icon for each tool type (📁 Read, ✏️ Edit, 💻 Bash, etc.)
- Show input parameters (file path, command, etc.)
- Show output/result (expandable if long)
- Loading state while tool is executing

**Thinking/Reasoning** (optional)
- Collapsed by default
- Shows Claude's internal reasoning
- Lighter/muted styling

### 2. Input Area

Design the message input:
- Multi-line text input (expands as needed)
- Send button (⌘+Enter to send)
- Attachment support (files, images) - future
- Stop button when agent is running
- Clear visual state: idle, running, error

### 3. Session Sidebar

Enhance the existing sidebar:
- Session previews (first line of last message)
- Search/filter sessions
- Session actions (rename, delete, duplicate)
- Active session indicator (pulsing dot, different color)
- Keyboard navigation

### 4. Status Indicators

Design status displays for:
- Agent running (spinner, progress)
- Tool execution in progress
- Error states (with retry option)
- Token/cost usage (optional, in header)
- Session connection status

### 5. Streaming Experience

The SDK streams messages in real-time. Design for:
- Text appearing character by character (typewriter effect)
- Tool calls appearing as they happen
- Smooth scroll-to-bottom behavior
- Ability to stop mid-stream

---

## Visual Design Guidelines

### Color Palette
Use macOS system colors for native feel:
- `Color(nsColor: .textBackgroundColor)` - Main background
- `Color(nsColor: .controlBackgroundColor)` - Sidebar, input area
- `Color.accentColor` - Primary actions
- Semantic colors: `.green` (success), `.red` (error), `.orange` (warning)

### Typography
- **Monospace**: `.system(size: 13, design: .monospaced)` for code/terminal
- **Headlines**: `.headline` for session titles
- **Body**: `.body` for messages
- **Caption**: `.caption` for timestamps, metadata

### Layout
- Sidebar: 200-300pt width
- Main content: Flexible, min 500pt
- Message bubbles: Max 80% width, proper padding
- Input bar: Fixed at bottom, ~60pt height

### Animations
- Message appear: Subtle fade-in
- Tool collapse/expand: Smooth disclosure
- Loading: System-style spinner
- Streaming text: No animation (just append)

---

## Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      SwiftUI Views                          │
│  ┌─────────────┐  ┌──────────────────────────────────────┐  │
│  │SessionSidebar│  │           SessionDetail              │  │
│  │             │  │  ┌─────────────────────────────────┐ │  │
│  │ • Sessions  │  │  │        MessageList              │ │  │
│  │ • New Chat  │  │  │  • UserMessage                  │ │  │
│  │             │  │  │  • AssistantMessage             │ │  │
│  │             │  │  │  • ToolUseView                  │ │  │
│  │             │  │  │  • ToolResultView               │ │  │
│  │             │  │  └─────────────────────────────────┘ │  │
│  │             │  │  ┌─────────────────────────────────┐ │  │
│  │             │  │  │         InputBar                │ │  │
│  └─────────────┘  │  └─────────────────────────────────┘ │  │
│                   └──────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    SessionManager                           │
│  • Manages active Claude SDK client                         │
│  • Streams messages to UI                                   │
│  • Persists sessions to disk/SQLite                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                Python Process (claude_agent_sdk)            │
│  • Runs as subprocess or via PyBridge                       │
│  • Communicates via JSON-RPC or stdout                      │
│  • Handles all Claude API interaction                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Python-Swift Communication

Design the bridge between Swift UI and Python SDK:

### Option A: Subprocess with JSON-RPC
```swift
// Swift side
class AgentProcess {
    func send(prompt: String) async -> AsyncStream<AgentMessage>
    func stop()
}
```

```python
# Python side - agent_bridge.py
import json
import sys
from claude_agent_sdk import query, ClaudeAgentOptions

async def handle_query(prompt: str, session_id: str):
    async for message in query(prompt=prompt, options=...):
        # Serialize and send to stdout
        print(json.dumps(serialize_message(message)), flush=True)
```

### Option B: Unix Domain Socket
- More robust for long-running sessions
- Bidirectional communication
- Better for interruption handling

### Option C: Embedded Python
- Use PythonKit or similar
- Most integrated but complex

**Recommendation**: Start with Option A (subprocess + JSON) for simplicity.

---

## Message Models (Swift)

```swift
enum MessageContent: Identifiable {
    case text(String)
    case toolUse(ToolUse)
    case toolResult(ToolResult)
    case error(AgentError)
}

struct Message: Identifiable {
    let id: UUID
    let role: MessageRole  // .user, .assistant
    let content: [MessageContent]
    let timestamp: Date
    var isStreaming: Bool
}

struct ToolUse: Identifiable {
    let id: String
    let name: String  // "Read", "Edit", "Bash", etc.
    let input: [String: Any]
    var status: ToolStatus  // .pending, .running, .success, .error
}

struct ToolResult: Identifiable {
    let id: String
    let toolUseId: String
    let content: String
    var isExpanded: Bool
}
```

---

## Deliverables

Please provide:

1. **Component Hierarchy** - SwiftUI view structure with props/state
2. **Message Rendering Specs** - How each message type should look
3. **Interaction Patterns** - User flows for common actions
4. **State Management** - How to handle streaming, sessions, errors
5. **Visual Mockups** (descriptions) - Key screen states
6. **Swift-Python Bridge Design** - Communication protocol spec

---

## Reference UIs

For inspiration, consider:
- **ChatGPT** - Clean message layout, code blocks, streaming
- **Claude.ai** - Artifact rendering, thinking blocks
- **Cursor** - IDE integration, tool call display
- **Warp** - Modern terminal with AI features
- **GitHub Copilot Chat** - VS Code sidebar chat

---

## Constraints

1. **macOS Only** - No iOS/cross-platform concerns
2. **SwiftUI** - No UIKit/AppKit unless necessary
3. **Native Feel** - Must feel like a macOS app, not a web wrapper
4. **Performance** - Handle long sessions (1000+ messages) smoothly
5. **Accessibility** - VoiceOver support, keyboard navigation

---

## Questions to Answer

1. How should we handle very long tool outputs (e.g., large file reads)?
2. Should tool calls be inline or in a separate panel?
3. How do we show cost/token usage without cluttering the UI?
4. What's the best way to render streaming markdown?
5. How should errors be displayed and recovered from?
6. Should sessions auto-save or require explicit save?

---

## Success Criteria

The design is successful if:
- A user can start a new chat and get a response from Claude
- Tool usage is visible but not overwhelming
- Sessions persist and can be resumed
- The app feels native and responsive
- Streaming messages feel natural and fast
- Errors are recoverable without data loss
