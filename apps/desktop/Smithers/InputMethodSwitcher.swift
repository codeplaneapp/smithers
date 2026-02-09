import AppKit
import Carbon

@MainActor
final class InputMethodSwitcher {
    private var isActive = false
    private var currentMode: NvimModeKind = .normal
    private var lastInsertInputSourceID: String?
    private var lastNormalInputSourceID: String?
    private var observer: NSObjectProtocol?

    init() {
        observer = NotificationCenter.default.addObserver(
            forName: NSTextInputContext.keyboardSelectionDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleInputSourceChange()
        }
        captureCurrentInputSource()
    }

    deinit {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    func setActive(_ active: Bool) {
        guard active != isActive else { return }
        isActive = active
        if active {
            captureCurrentInputSource()
            applyMode(currentMode)
        }
    }

    func setMode(_ mode: NvimModeKind) {
        currentMode = mode
        guard isActive else { return }
        applyMode(mode)
    }

    private func handleInputSourceChange() {
        guard let source = currentInputSource() else { return }
        updateStoredSources(from: source)
    }

    private func captureCurrentInputSource() {
        guard let source = currentInputSource() else { return }
        updateStoredSources(from: source)
        if lastNormalInputSourceID == nil,
           let layout = currentKeyboardLayoutInputSource(),
           let id = inputSourceID(layout) {
            lastNormalInputSourceID = id
        }
    }

    private func updateStoredSources(from source: TISInputSource) {
        guard let id = inputSourceID(source) else { return }
        if isInputMethod(source) {
            lastInsertInputSourceID = id
        } else {
            lastNormalInputSourceID = id
        }
    }

    private func applyMode(_ mode: NvimModeKind) {
        guard let source = currentInputSource() else { return }
        let currentID = inputSourceID(source)
        let isIme = isInputMethod(source)
        if mode == .insert {
            guard !isIme,
                  let targetID = lastInsertInputSourceID,
                  targetID != currentID else { return }
            selectInputSource(id: targetID)
        } else {
            guard isIme else { return }
            if let targetID = lastNormalInputSourceID {
                guard targetID != currentID else { return }
                selectInputSource(id: targetID)
            } else if let layout = currentKeyboardLayoutInputSource(),
                      let layoutID = inputSourceID(layout),
                      layoutID != currentID {
                lastNormalInputSourceID = layoutID
                selectInputSource(id: layoutID)
            }
        }
    }

    private func currentInputSource() -> TISInputSource? {
        guard let source = TISCopyCurrentKeyboardInputSource() else { return nil }
        return source.takeRetainedValue()
    }

    private func currentKeyboardLayoutInputSource() -> TISInputSource? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource() else { return nil }
        return source.takeRetainedValue()
    }

    private func inputSourceID(_ source: TISInputSource) -> String? {
        guard let ptr = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return nil }
        let value = Unmanaged<CFTypeRef>.fromOpaque(ptr).takeUnretainedValue()
        return value as? String
    }

    private func inputSourceCategory(_ source: TISInputSource) -> String? {
        guard let ptr = TISGetInputSourceProperty(source, kTISPropertyInputSourceCategory) else { return nil }
        let value = Unmanaged<CFTypeRef>.fromOpaque(ptr).takeUnretainedValue()
        return value as? String
    }

    private func inputSourceIsASCIICapable(_ source: TISInputSource) -> Bool? {
        guard let ptr = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsASCIICapable) else { return nil }
        let value = Unmanaged<CFTypeRef>.fromOpaque(ptr).takeUnretainedValue()
        if let bool = value as? Bool {
            return bool
        }
        if let number = value as? NSNumber {
            return number.boolValue
        }
        return nil
    }

    private func isInputMethod(_ source: TISInputSource) -> Bool {
        if let category = inputSourceCategory(source),
           category == (kTISCategoryKeyboardInputMethod as String) {
            return true
        }
        if let asciiCapable = inputSourceIsASCIICapable(source) {
            return !asciiCapable
        }
        return false
    }

    private func selectInputSource(id: String) {
        guard let source = inputSource(forID: id) else { return }
        TISSelectInputSource(source)
    }

    private func inputSource(forID id: String) -> TISInputSource? {
        let props = [kTISPropertyInputSourceID as String: id] as CFDictionary
        guard let list = TISCreateInputSourceList(props, false) else { return nil }
        let array = list.takeRetainedValue() as NSArray
        guard let first = array.firstObject else { return nil }
        return first as! TISInputSource
    }
}
