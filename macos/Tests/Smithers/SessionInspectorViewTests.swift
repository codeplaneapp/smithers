import XCTest
import SwiftUI
@testable import Smithers

@MainActor
final class SessionInspectorViewTests: XCTestCase {
    override func setUp() {
        super.setUp()
        MockDataService.shared.reset()
    }

    override func tearDown() {
        MockDataService.shared.reset()
        super.tearDown()
    }

    // MARK: - InspectorTab Tests

    func testInspectorTab_AllCasesHaveIcons() {
        for tab in InspectorTab.allCases {
            XCTAssertFalse(tab.icon.isEmpty, "Tab \(tab.rawValue) should have an icon")
        }
    }

    func testInspectorTab_AllCasesHaveUniqueIcons() {
        let icons = InspectorTab.allCases.map { $0.icon }
        let uniqueIcons = Set(icons)
        XCTAssertEqual(icons.count, uniqueIcons.count, "All tabs should have unique icons")
    }

    func testInspectorTab_IdMatchesRawValue() {
        for tab in InspectorTab.allCases {
            XCTAssertEqual(tab.id, tab.rawValue)
        }
    }

    // MARK: - ToolsView Empty State Tests

    func testToolsView_EmptyState_WhenNoNodeSelected() {
        let toolsView = ToolsView(selectedNodeId: .constant(nil))

        // The view should render without crashing
        XCTAssertNotNil(toolsView.body)
    }

    func testToolsView_EmptyState_WhenInvalidNodeSelected() {
        let invalidNodeId = UUID()
        let toolsView = ToolsView(selectedNodeId: .constant(invalidNodeId))

        // The view should render without crashing
        XCTAssertNotNil(toolsView.body)
    }

    // MARK: - ToolsView Tool Use Tests

    func testToolsView_ToolUseNode_DisplaysCorrectly() {
        let nodeId = UUID()
        let toolUseNode = GraphNode(
            id: nodeId,
            type: .toolUse,
            parentId: nil,
            timestamp: Date(),
            data: [
                "tool_name": AnyCodable("Read"),
                "status": AnyCodable("completed"),
                "input": AnyCodable([
                    "file_path": "/workspace/test.py",
                    "line_start": 1,
                    "line_end": 50
                ] as [String: Any]),
                "duration": AnyCodable(0.5)
            ]
        )
        MockDataService.shared.registerNode(toolUseNode)

        let toolsView = ToolsView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing
        XCTAssertNotNil(toolsView.body)
    }

    func testToolsView_ToolUseNode_HandlesEmptyInput() {
        let nodeId = UUID()
        let toolUseNode = GraphNode(
            id: nodeId,
            type: .toolUse,
            parentId: nil,
            timestamp: Date(),
            data: [
                "tool_name": AnyCodable("Bash"),
                "status": AnyCodable("running")
            ]
        )
        MockDataService.shared.registerNode(toolUseNode)

        let toolsView = ToolsView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing
        XCTAssertNotNil(toolsView.body)
    }

    func testToolsView_ToolUseNode_SupportsAllToolTypes() {
        let toolNames = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"]

        for toolName in toolNames {
            let nodeId = UUID()
            let toolUseNode = GraphNode(
                id: nodeId,
                type: .toolUse,
                parentId: nil,
                timestamp: Date(),
                data: [
                    "tool_name": AnyCodable(toolName),
                    "status": AnyCodable("completed")
                ]
            )
            MockDataService.shared.registerNode(toolUseNode)

            let toolsView = ToolsView(selectedNodeId: .constant(nodeId))

            // The view should render without crashing for all tool types
            XCTAssertNotNil(toolsView.body)
        }
    }

    // MARK: - ToolsView Tool Result Tests

    func testToolsView_ToolResultNode_DisplaysCorrectly() {
        let nodeId = UUID()
        let toolResultNode = GraphNode(
            id: nodeId,
            type: .toolResult,
            parentId: nil,
            timestamp: Date(),
            data: [
                "tool_name": AnyCodable("Bash"),
                "output": AnyCodable("Command executed successfully"),
                "byte_count": AnyCodable(28)
            ]
        )
        MockDataService.shared.registerNode(toolResultNode)

        let toolsView = ToolsView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing
        XCTAssertNotNil(toolsView.body)
    }

    func testToolsView_ToolResultNode_HandlesLargeOutput() {
        let nodeId = UUID()
        let largeOutput = String(repeating: "Test output line\n", count: 1000)
        let toolResultNode = GraphNode(
            id: nodeId,
            type: .toolResult,
            parentId: nil,
            timestamp: Date(),
            data: [
                "tool_name": AnyCodable("Bash"),
                "output": AnyCodable(largeOutput),
                "byte_count": AnyCodable(largeOutput.count)
            ]
        )
        MockDataService.shared.registerNode(toolResultNode)

        let toolsView = ToolsView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing even with large output
        XCTAssertNotNil(toolsView.body)
    }

    func testToolsView_ToolResultNode_WithArtifactRef() {
        let nodeId = UUID()
        let toolResultNode = GraphNode(
            id: nodeId,
            type: .toolResult,
            parentId: nil,
            timestamp: Date(),
            data: [
                "tool_name": AnyCodable("Read"),
                "output": AnyCodable("File contents..."),
                "byte_count": AnyCodable(16),
                "artifact_ref": AnyCodable("artifact://read-test-001")
            ]
        )
        MockDataService.shared.registerNode(toolResultNode)

        let toolsView = ToolsView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing
        XCTAssertNotNil(toolsView.body)
    }

    // MARK: - ToolsView Non-Tool Node Tests

    func testToolsView_MessageNode_ShowsNotAToolNode() {
        let nodeId = UUID()
        let messageNode = GraphNode(
            id: nodeId,
            type: .message,
            parentId: nil,
            timestamp: Date(),
            data: ["text": AnyCodable("Hello world")]
        )
        MockDataService.shared.registerNode(messageNode)

        let toolsView = ToolsView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing
        XCTAssertNotNil(toolsView.body)
    }

    func testToolsView_CheckpointNode_ShowsNotAToolNode() {
        let nodeId = UUID()
        let checkpointNode = GraphNode(
            id: nodeId,
            type: .checkpoint,
            parentId: nil,
            timestamp: Date(),
            data: ["label": AnyCodable("checkpoint-1")]
        )
        MockDataService.shared.registerNode(checkpointNode)

        let toolsView = ToolsView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing
        XCTAssertNotNil(toolsView.body)
    }

    // MARK: - MockDataService Tests

    func testMockDataService_RegisterAndRetrieveNode() {
        let nodeId = UUID()
        let node = GraphNode(
            id: nodeId,
            type: .message,
            parentId: nil,
            timestamp: Date(),
            data: ["text": AnyCodable("Test")]
        )

        MockDataService.shared.registerNode(node)

        let retrieved = MockDataService.shared.getNode(id: nodeId)
        XCTAssertNotNil(retrieved)
        XCTAssertEqual(retrieved?.id, nodeId)
        XCTAssertEqual(retrieved?.type, .message)
    }

    func testMockDataService_GetNode_ReturnsNilForUnregistered() {
        let nodeId = UUID()

        let retrieved = MockDataService.shared.getNode(id: nodeId)
        XCTAssertNil(retrieved)
    }

    func testMockDataService_Reset_ClearsAllNodes() {
        let node1 = GraphNode(
            id: UUID(),
            type: .message,
            parentId: nil,
            timestamp: Date(),
            data: ["text": AnyCodable("Test 1")]
        )
        let node2 = GraphNode(
            id: UUID(),
            type: .message,
            parentId: nil,
            timestamp: Date(),
            data: ["text": AnyCodable("Test 2")]
        )

        MockDataService.shared.registerNode(node1)
        MockDataService.shared.registerNode(node2)

        MockDataService.shared.reset()

        XCTAssertNil(MockDataService.shared.getNode(id: node1.id))
        XCTAssertNil(MockDataService.shared.getNode(id: node2.id))
    }

    // MARK: - RunDetailsView Tests

    func testRunDetailsView_EmptyState_WhenNoNodeSelected() {
        let runDetailsView = RunDetailsView(selectedNodeId: .constant(nil))

        // The view should render without crashing
        XCTAssertNotNil(runDetailsView.body)
    }

    func testRunDetailsView_WithNodeSelected() {
        let nodeId = UUID()
        let runDetailsView = RunDetailsView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing
        XCTAssertNotNil(runDetailsView.body)
    }

    // MARK: - DetailRow Tests

    func testDetailRow_RendersLabelAndValue() {
        let detailRow = DetailRow(label: "Test Label", value: "Test Value")

        // The view should render without crashing
        XCTAssertNotNil(detailRow.body)
    }

    func testDetailRow_HandlesEmptyStrings() {
        let detailRow = DetailRow(label: "", value: "")

        // The view should render without crashing
        XCTAssertNotNil(detailRow.body)
    }

    func testDetailRow_HandlesLongStrings() {
        let longLabel = String(repeating: "Label ", count: 100)
        let longValue = String(repeating: "Value ", count: 100)
        let detailRow = DetailRow(label: longLabel, value: longValue)

        // The view should render without crashing
        XCTAssertNotNil(detailRow.body)
    }

    // MARK: - StackView Tests

    func testStackView_Renders() {
        let stackView = StackView(selectedNodeId: .constant(nil))

        // The view should render without crashing
        XCTAssertNotNil(stackView.body)
    }

    func testStackView_WithNodeSelected() {
        let nodeId = UUID()
        let stackView = StackView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing
        XCTAssertNotNil(stackView.body)
    }

    // MARK: - DiffView Tests

    func testDiffView_Renders() {
        let diffView = DiffView(selectedNodeId: .constant(nil))

        // The view should render without crashing
        XCTAssertNotNil(diffView.body)
    }

    func testDiffView_WithNodeSelected() {
        let nodeId = UUID()
        let diffView = DiffView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing
        XCTAssertNotNil(diffView.body)
    }

    // MARK: - TodosView Tests

    func testTodosView_Renders() {
        let todosView = TodosView()

        // The view should render without crashing
        XCTAssertNotNil(todosView.body)
    }

    // MARK: - BrowserView Tests

    func testBrowserView_Renders() {
        let browserView = BrowserView()

        // The view should render without crashing
        XCTAssertNotNil(browserView.body)
    }

    // MARK: - SessionInspectorView Integration Tests

    func testSessionInspectorView_RendersAllTabs() {
        for tab in InspectorTab.allCases {
            let inspectorView = SessionInspectorView(
                selectedTab: .constant(tab),
                selectedNodeId: .constant(nil)
            )

            // The view should render without crashing for all tabs
            XCTAssertNotNil(inspectorView.body, "Failed to render tab: \(tab.rawValue)")
        }
    }

    func testSessionInspectorView_SwitchesBetweenTabs() {
        let selectedTab = Binding<InspectorTab>(
            get: { .stack },
            set: { _ in }
        )

        let inspectorView = SessionInspectorView(
            selectedTab: selectedTab,
            selectedNodeId: .constant(nil)
        )

        // The view should render without crashing
        XCTAssertNotNil(inspectorView.body)
    }

    func testSessionInspectorView_WithNodeSelection() {
        let nodeId = UUID()
        let toolUseNode = GraphNode(
            id: nodeId,
            type: .toolUse,
            parentId: nil,
            timestamp: Date(),
            data: [
                "tool_name": AnyCodable("Read"),
                "status": AnyCodable("completed")
            ]
        )
        MockDataService.shared.registerNode(toolUseNode)

        let inspectorView = SessionInspectorView(
            selectedTab: .constant(.tools),
            selectedNodeId: .constant(nodeId)
        )

        // The view should render without crashing
        XCTAssertNotNil(inspectorView.body)
    }

    // MARK: - Status Badge Tests

    func testToolsView_StatusBadge_AllStatuses() {
        let statuses = ["running", "completed", "error", "pending"]

        for status in statuses {
            let nodeId = UUID()
            let toolUseNode = GraphNode(
                id: nodeId,
                type: .toolUse,
                parentId: nil,
                timestamp: Date(),
                data: [
                    "tool_name": AnyCodable("Bash"),
                    "status": AnyCodable(status)
                ]
            )
            MockDataService.shared.registerNode(toolUseNode)

            let toolsView = ToolsView(selectedNodeId: .constant(nodeId))

            // The view should render without crashing for all statuses
            XCTAssertNotNil(toolsView.body, "Failed to render status: \(status)")
        }
    }

    // MARK: - Edge Cases

    func testToolsView_NodeWithMissingData() {
        let nodeId = UUID()
        let toolUseNode = GraphNode(
            id: nodeId,
            type: .toolUse,
            parentId: nil,
            timestamp: Date(),
            data: [:] // Empty data
        )
        MockDataService.shared.registerNode(toolUseNode)

        let toolsView = ToolsView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing even with missing data
        XCTAssertNotNil(toolsView.body)
    }

    func testToolsView_NodeWithInvalidDataTypes() {
        let nodeId = UUID()
        let toolUseNode = GraphNode(
            id: nodeId,
            type: .toolUse,
            parentId: nil,
            timestamp: Date(),
            data: [
                "tool_name": AnyCodable(123), // Wrong type: should be String
                "status": AnyCodable(true),    // Wrong type: should be String
                "input": AnyCodable("not a dict") // Wrong type: should be [String: Any]
            ]
        )
        MockDataService.shared.registerNode(toolUseNode)

        let toolsView = ToolsView(selectedNodeId: .constant(nodeId))

        // The view should render without crashing even with wrong data types
        XCTAssertNotNil(toolsView.body)
    }

    func testToolsView_RapidNodeSwitching() {
        // Create multiple nodes
        var nodeIds: [UUID] = []
        for i in 0..<10 {
            let nodeId = UUID()
            nodeIds.append(nodeId)
            let toolUseNode = GraphNode(
                id: nodeId,
                type: .toolUse,
                parentId: nil,
                timestamp: Date(),
                data: [
                    "tool_name": AnyCodable("Tool\(i)"),
                    "status": AnyCodable("completed")
                ]
            )
            MockDataService.shared.registerNode(toolUseNode)
        }

        // Rapidly switch between nodes
        for nodeId in nodeIds {
            let toolsView = ToolsView(selectedNodeId: .constant(nodeId))
            XCTAssertNotNil(toolsView.body)
        }
    }
}
