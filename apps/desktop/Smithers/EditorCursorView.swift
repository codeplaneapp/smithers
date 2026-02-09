import AppKit
import QuartzCore

enum EditorCursorShape: String, CaseIterable, Codable {
    case bar
    case block
    case underline
}

final class EditorCursorView: NSView {
    enum MotionKind {
        case short
        case long
    }

    struct SpringConfig {
        let mass: CGFloat
        let stiffness: CGFloat
        let damping: CGFloat
        let initialVelocity: CGFloat
    }

    var cursorColor: NSColor = .white {
        didSet { updateColors() }
    }
    var outlineColor: NSColor = .white {
        didSet { updateColors() }
    }
    var showsOutlineWhenInactive: Bool = true {
        didSet { updateColors() }
    }
    var isActive: Bool = true {
        didSet {
            updateColors()
            updateBlinking()
        }
    }
    var blinkEnabled: Bool = true {
        didSet { updateBlinking() }
    }
    var blinkDelay: CFTimeInterval = 0.5
    var blinkDuration: CFTimeInterval = 0.7

    private let shortSpring = SpringConfig(mass: 1, stiffness: 820, damping: 90, initialVelocity: 0)
    private let longSpring = SpringConfig(mass: 1, stiffness: 320, damping: 45, initialVelocity: 0)
    private var hasFrame = false
    private var lastFrame: NSRect = .zero

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        layer?.cornerRadius = 0
        layer?.masksToBounds = true
        updateColors()
        updateBlinking()
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateLayerScale()
        updateColors()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateLayerScale()
        updateColors()
    }

    func move(to rect: NSRect, motion: MotionKind, restartBlink: Bool) {
        let snapped = snapToPixel(rect)
        guard snapped.width > 0, snapped.height > 0 else { return }
        if !hasFrame {
            hasFrame = true
            lastFrame = snapped
            setFrameWithoutAnimation(snapped)
            if restartBlink {
                restartBlinking()
            }
            return
        }
        if snapped.equalTo(lastFrame) {
            if restartBlink {
                restartBlinking()
            }
            return
        }

        let fromFrame = lastFrame
        lastFrame = snapped
        setFrameWithoutAnimation(snapped)

        guard let layer else { return }
        let config = motion == .long ? longSpring : shortSpring

        let fromPosition = CGPoint(x: fromFrame.midX, y: fromFrame.midY)
        let toPosition = CGPoint(x: snapped.midX, y: snapped.midY)
        let fromBounds = CGRect(x: 0, y: 0, width: fromFrame.width, height: fromFrame.height)
        let toBounds = CGRect(x: 0, y: 0, width: snapped.width, height: snapped.height)

        layer.removeAnimation(forKey: "cursor-position")
        layer.removeAnimation(forKey: "cursor-bounds")

        let positionAnim = springAnimation(
            keyPath: "position",
            from: fromPosition,
            to: toPosition,
            config: config
        )
        let boundsAnim = springAnimation(
            keyPath: "bounds",
            from: fromBounds,
            to: toBounds,
            config: config
        )
        layer.add(positionAnim, forKey: "cursor-position")
        layer.add(boundsAnim, forKey: "cursor-bounds")

        if restartBlink {
            restartBlinking()
        }
    }

    func setVisible(_ visible: Bool) {
        if visible == !isHidden { return }
        isHidden = !visible
        if visible {
            updateBlinking()
        } else {
            layer?.removeAnimation(forKey: "cursor-blink")
            layer?.removeAnimation(forKey: "cursor-position")
            layer?.removeAnimation(forKey: "cursor-bounds")
            layer?.opacity = 0
        }
    }

    private func setFrameWithoutAnimation(_ rect: NSRect) {
        guard let layer else {
            frame = rect
            return
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        frame = rect
        layer.position = CGPoint(x: rect.midX, y: rect.midY)
        layer.bounds = CGRect(x: 0, y: 0, width: rect.width, height: rect.height)
        CATransaction.commit()
    }

    private func updateLayerScale() {
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        layer?.contentsScale = scale
    }

    private func updateColors() {
        guard let layer else { return }
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        if isActive {
            layer.backgroundColor = cursorColor.cgColor
            layer.borderWidth = 0
            layer.borderColor = nil
        } else if showsOutlineWhenInactive {
            layer.backgroundColor = NSColor.clear.cgColor
            layer.borderColor = outlineColor.cgColor
            layer.borderWidth = 1 / scale
        } else {
            layer.backgroundColor = cursorColor.withAlphaComponent(0.35).cgColor
            layer.borderWidth = 0
            layer.borderColor = nil
        }
    }

    private func updateBlinking() {
        guard blinkEnabled, isActive, !isHidden else {
            layer?.removeAnimation(forKey: "cursor-blink")
            layer?.opacity = 1
            return
        }
        restartBlinking()
    }

    private func restartBlinking() {
        guard blinkEnabled, isActive, !isHidden else { return }
        guard let layer else { return }
        layer.removeAnimation(forKey: "cursor-blink")
        layer.opacity = 1
        let anim = CABasicAnimation(keyPath: "opacity")
        anim.fromValue = 1
        anim.toValue = 0
        anim.duration = blinkDuration
        anim.autoreverses = true
        anim.repeatCount = .infinity
        anim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        anim.beginTime = CACurrentMediaTime() + blinkDelay
        anim.isRemovedOnCompletion = false
        layer.add(anim, forKey: "cursor-blink")
    }

    private func springAnimation(keyPath: String, from: Any, to: Any, config: SpringConfig) -> CASpringAnimation {
        let anim = CASpringAnimation(keyPath: keyPath)
        anim.fromValue = from
        anim.toValue = to
        anim.mass = config.mass
        anim.stiffness = config.stiffness
        anim.damping = config.damping
        anim.initialVelocity = config.initialVelocity
        anim.duration = anim.settlingDuration
        anim.isRemovedOnCompletion = true
        return anim
    }

    private func snapToPixel(_ rect: NSRect) -> NSRect {
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        func snap(_ value: CGFloat) -> CGFloat {
            (value * scale).rounded(.toNearestOrAwayFromZero) / scale
        }
        let width = max(1, snap(rect.size.width))
        let height = max(1, snap(rect.size.height))
        return NSRect(
            x: snap(rect.origin.x),
            y: snap(rect.origin.y),
            width: width,
            height: height
        )
    }
}
