import Foundation
import Network
// SmithersShared sources are compiled as part of the Smithers target (see project.yml)

@MainActor
final class SmithersIPCServer {
    private struct WaitRequest {
        let id: UUID
        let connection: SmithersIPCConnection
        var pending: Set<URL>
        var opened: Set<URL>
    }

    private let queue = DispatchQueue(label: "com.smithers.ipc")
    private var listener: NWListener?
    private weak var workspace: WorkspaceState?
    private var openObserverID: UUID?
    private var closeObserverID: UUID?
    private var connections: [ObjectIdentifier: SmithersIPCConnection] = [:]
    private var waitRequests: [UUID: WaitRequest] = [:]

    func configure(workspace: WorkspaceState?) {
        let currentID = self.workspace.map(ObjectIdentifier.init)
        let newID = workspace.map(ObjectIdentifier.init)
        if currentID != newID {
            detachObservers()
        }
        self.workspace = workspace
        if let workspace, openObserverID == nil, closeObserverID == nil {
            attachObservers(to: workspace)
        }
        if listener == nil {
            startListener()
        }
    }

    func stop() {
        notifyAllWaiters(message: "Server stopped")
        detachObservers()
        workspace = nil
        listener?.cancel()
        listener = nil
        connections.removeAll()
        waitRequests.removeAll()
        try? FileManager.default.removeItem(atPath: SmithersIPC.socketPath)
    }

    func notifyAllWaiters(message: String? = nil) {
        let pending = Array(waitRequests.keys)
        for id in pending {
            finishWaitRequest(id, message: message)
        }
    }

    private func attachObservers(to workspace: WorkspaceState) {
        openObserverID = workspace.addFileOpenObserver { [weak self] url in
            self?.handleFileOpened(url)
        }
        closeObserverID = workspace.addFileCloseObserver { [weak self] url in
            self?.handleFileClosed(url)
        }
    }

    private func detachObservers() {
        if let id = openObserverID, let workspace {
            workspace.removeFileOpenObserver(id)
        }
        if let id = closeObserverID, let workspace {
            workspace.removeFileCloseObserver(id)
        }
        openObserverID = nil
        closeObserverID = nil
    }

    private func startListener() {
        do {
            try FileManager.default.removeItem(atPath: SmithersIPC.socketPath)
        } catch {
            // Ignore stale socket cleanup errors.
        }

        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .unix(path: SmithersIPC.socketPath)
        do {
            listener = try NWListener(using: parameters)
        } catch {
            WorkspaceState.debugLog("[IPC] Failed to start listener: \(error)")
            listener = nil
            return
        }

        listener?.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in
                self?.accept(connection)
            }
        }
        listener?.start(queue: queue)
    }

    private func accept(_ connection: NWConnection) {
        let ipcConnection = SmithersIPCConnection(connection: connection, queue: queue)
        let id = ObjectIdentifier(ipcConnection)
        connections[id] = ipcConnection
        ipcConnection.onRequest = { [weak self, weak ipcConnection] data in
            Task { @MainActor in
                guard let self, let ipcConnection else { return }
                self.handleRequest(data, from: ipcConnection)
            }
        }
        ipcConnection.onClose = { [weak self, weak ipcConnection] in
            Task { @MainActor in
                guard let self, let ipcConnection else { return }
                self.connectionDidClose(ipcConnection)
            }
        }
        ipcConnection.start()
    }

    private func handleRequest(_ data: Data, from connection: SmithersIPCConnection) {
        guard let request = try? JSONDecoder().decode(SmithersIPCRequest.self, from: data) else {
            sendError("Invalid request.", to: connection)
            return
        }
        guard let workspace else {
            sendError("Workspace not ready.", to: connection)
            return
        }
        guard !request.items.isEmpty else {
            sendError("No items provided.", to: connection)
            return
        }

        var openRequests: [WorkspaceState.ExternalOpenRequest] = []
        var waitTargets: [URL] = []
        openRequests.reserveCapacity(request.items.count)

        for item in request.items {
            let url = URL(fileURLWithPath: item.path).standardizedFileURL
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
            let isDirectory = exists && isDir.boolValue
            let line = isDirectory ? nil : normalizePositive(item.line)
            let column = line == nil ? nil : normalizePositive(item.column)
            openRequests.append(WorkspaceState.ExternalOpenRequest(url: url, line: line, column: column))
            if item.wait == true, !isDirectory {
                waitTargets.append(url)
            }
        }

        workspace.handleExternalOpen(requests: openRequests)

        guard !waitTargets.isEmpty else {
            sendOK(to: connection)
            return
        }

        let pending = Set(waitTargets.map { $0.standardizedFileURL })
        var opened: Set<URL> = []
        for url in pending where workspace.isFileOpen(url) {
            opened.insert(url)
        }
        let waitRequest = WaitRequest(id: UUID(), connection: connection, pending: pending, opened: opened)
        waitRequests[waitRequest.id] = waitRequest
    }

    private func handleFileOpened(_ url: URL) {
        guard !waitRequests.isEmpty else { return }
        let normalized = url.standardizedFileURL
        let current = waitRequests
        for (id, var request) in current {
            guard request.pending.contains(normalized) else { continue }
            request.opened.insert(normalized)
            waitRequests[id] = request
        }
    }

    private func handleFileClosed(_ url: URL) {
        guard !waitRequests.isEmpty else { return }
        let normalized = url.standardizedFileURL
        var completed: [UUID] = []
        let current = waitRequests
        for (id, var request) in current {
            guard request.pending.contains(normalized) else { continue }
            guard request.opened.contains(normalized) else { continue }
            request.pending.remove(normalized)
            request.opened.remove(normalized)
            if request.pending.isEmpty {
                completed.append(id)
            } else {
                waitRequests[id] = request
            }
        }
        for id in completed {
            finishWaitRequest(id, message: nil)
        }
    }

    private func finishWaitRequest(_ id: UUID, message: String?) {
        guard let request = waitRequests.removeValue(forKey: id) else { return }
        if let message {
            sendOK(message: message, to: request.connection)
        } else {
            sendOK(to: request.connection)
        }
    }

    private func connectionDidClose(_ connection: SmithersIPCConnection) {
        connections.removeValue(forKey: ObjectIdentifier(connection))
        let ids = waitRequests.compactMap { key, value in
            value.connection === connection ? key : nil
        }
        for id in ids {
            waitRequests.removeValue(forKey: id)
        }
    }

    private func sendOK(message: String? = nil, to connection: SmithersIPCConnection) {
        let response = SmithersIPCResponse(status: .ok, message: message)
        send(response, to: connection)
    }

    private func sendError(_ message: String, to connection: SmithersIPCConnection) {
        let response = SmithersIPCResponse(status: .error, message: message)
        send(response, to: connection)
    }

    private func send(_ response: SmithersIPCResponse, to connection: SmithersIPCConnection) {
        guard let data = try? JSONEncoder().encode(response) else {
            connection.close()
            return
        }
        var payload = data
        payload.append(0x0A)
        connection.send(payload) {
            connection.close()
        }
    }

    private func normalizePositive(_ value: Int?) -> Int? {
        guard let value, value > 0 else { return nil }
        return value
    }
}

final class SmithersIPCConnection {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private var buffer = Data()
    private var didReceiveRequest = false

    var onRequest: ((Data) -> Void)?
    var onClose: (() -> Void)?

    init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed(_), .cancelled:
                self?.onClose?()
            default:
                break
            }
        }
        connection.start(queue: queue)
        receiveNext()
    }

    func send(_ data: Data, completion: (() -> Void)? = nil) {
        connection.send(content: data, completion: .contentProcessed { _ in
            completion?()
        })
    }

    func close() {
        connection.cancel()
    }

    private func receiveNext() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data {
                buffer.append(data)
            }
            if let line = extractLine(), !didReceiveRequest {
                didReceiveRequest = true
                onRequest?(line)
            }
            if isComplete || error != nil {
                onClose?()
                return
            }
            receiveNext()
        }
    }

    private func extractLine() -> Data? {
        guard let newlineIndex = buffer.firstIndex(of: 0x0A) else { return nil }
        let line = buffer.prefix(upTo: newlineIndex)
        buffer.removeSubrange(...newlineIndex)
        return Data(line)
    }
}
