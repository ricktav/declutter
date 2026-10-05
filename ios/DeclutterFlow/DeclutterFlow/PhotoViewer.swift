import SwiftUI
import UIKit

/// Full-screen Photo viewer: pinch between 1× and 6×, double-tap toggles 1× / 3× around the tap,
/// pan when zoomed, swipe down (at 1×) or Close to dismiss. Backed by a UIScrollView, which
/// handles pinch, pan and bounce more reliably than stacked SwiftUI gestures.
struct PhotoViewer: View {
    let image: UIImage
    /// The AI's frames on this Photo; they zoom and pan with it and open a bubble on a tap.
    var frames: [FrameSpec] = []
    var onClose: () -> Void
    /// Set when the Photo is one of a Thing's: shows "Crop" (the caller closes the viewer).
    var onCrop: (() -> Void)? = nil

    /// 0…1 while a swipe-down is in progress; fades the black background.
    @State private var dragProgress: CGFloat = 0

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black
                .opacity(1 - dragProgress * 0.7)
                .ignoresSafeArea()
            ZoomableImage(image: image, frames: frames, onDrag: { dragProgress = $0 }, onDismiss: onClose)
                .ignoresSafeArea()
            Button(action: onClose) {
                Text("Close")
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .foregroundStyle(FlowTheme.ink)
                    .background(FlowTheme.cream, in: Capsule())
            }
            .padding(16)
            .opacity(1 - dragProgress)
            .accessibilityLabel("Close the Photo")
            if let onCrop {
                Button(action: onCrop) {
                    Label("Crop", systemImage: "crop")
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .foregroundStyle(FlowTheme.ink)
                        .background(FlowTheme.lime, in: Capsule())
                }
                .padding(16)
                .opacity(1 - dragProgress)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .accessibilityLabel("Crop the Photo")
            }
        }
        .statusBarHidden()
        .presentationBackground(.clear)
    }
}

private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    let frames: [FrameSpec]
    var onDrag: (CGFloat) -> Void
    var onDismiss: () -> Void

    func makeUIView(context: Context) -> ZoomScrollView {
        let view = ZoomScrollView(image: image)
        view.setFrames(frames)
        view.onDrag = onDrag
        view.onDismiss = onDismiss
        return view
    }

    func updateUIView(_ view: ZoomScrollView, context: Context) {
        view.onDrag = onDrag
        view.onDismiss = onDismiss
        if view.imageView.image !== image {
            view.setImage(image)
        }
    }
}

final class ZoomScrollView: UIScrollView, UIScrollViewDelegate {
    let imageView = UIImageView()
    var onDrag: ((CGFloat) -> Void)?
    var onDismiss: (() -> Void)?

    private var laidOutFor: CGSize = .zero
    private var frameViews: [FrameMark] = []
    private var bubble: UILabel?
    private let dismissPan = UIPanGestureRecognizer()
    private let dismissGate = DismissGate()
    private static let doubleTapScale: CGFloat = 3

    init(image: UIImage) {
        super.init(frame: .zero)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 6
        bouncesZoom = true
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        decelerationRate = .fast
        backgroundColor = .clear

        imageView.image = image
        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = true
        addSubview(imageView)

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        tap.require(toFail: doubleTap)
        addGestureRecognizer(tap)

        dismissPan.addTarget(self, action: #selector(handleDismissPan(_:)))
        dismissPan.maximumNumberOfTouches = 1
        dismissGate.view = self
        dismissPan.delegate = dismissGate
        addGestureRecognizer(dismissPan)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func setImage(_ image: UIImage) {
        imageView.image = image
        laidOutFor = .zero
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != laidOutFor, bounds.width > 0, bounds.height > 0 {
            laidOutFor = bounds.size
            setZoomScale(1, animated: false)
            let fit = fitSize()
            imageView.frame = CGRect(origin: .zero, size: fit)
            contentSize = fit
        }
        layoutFrames()
        centreContent()
    }

    /// The image's size at 1×: aspect-fit inside the screen.
    private func fitSize() -> CGSize {
        guard let size = imageView.image?.size, size.width > 0, size.height > 0 else { return bounds.size }
        let scale = min(bounds.width / size.width, bounds.height / size.height)
        return CGSize(width: size.width * scale, height: size.height * scale)
    }

    /// Keeps the image centred while it is smaller than the screen in either direction.
    private func centreContent() {
        let dx = max(0, (bounds.width - contentSize.width) / 2)
        let dy = max(0, (bounds.height - contentSize.height) / 2)
        let inset = UIEdgeInsets(top: dy, left: dx, bottom: dy, right: dx)
        if contentInset != inset { contentInset = inset }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centreContent()
        applyFrameScale()
    }

    // MARK: AI frames

    /// A frame is a subview of the image view, so it scales and pans with the Photo. Its border
    /// and badge are counter-scaled to stay the same size on screen.
    func setFrames(_ specs: [FrameSpec]) {
        frameViews.forEach { $0.removeFromSuperview() }
        frameViews = specs.map { FrameMark(spec: $0) }
        frameViews.forEach { imageView.addSubview($0) }
        // small ones on top
        frameViews.sort { $0.spec.box.wPct * $0.spec.box.hPct > $1.spec.box.wPct * $1.spec.box.hPct }
        frameViews.forEach { imageView.bringSubviewToFront($0) }
        setNeedsLayout()
    }

    private func layoutFrames() {
        let size = imageView.bounds.size
        for v in frameViews {
            let r = v.spec.box.rect(in: size)
            v.frame = CGRect(x: r.minX, y: r.minY, width: max(r.width, 22), height: max(r.height, 22))
        }
        applyFrameScale()
    }

    private func applyFrameScale() {
        let z = max(zoomScale, 0.01)
        frameViews.forEach { $0.setScreenScale(z) }
        if let bubble { placeBubble(bubble) }
    }

    @objc private func handleTap(_ g: UITapGestureRecognizer) {
        let p = g.location(in: imageView)
        bubble?.removeFromSuperview()
        bubble = nil
        // the smallest frame under the finger
        let hit = frameViews.filter { $0.frame.insetBy(dx: -8 / zoomScale, dy: -8 / zoomScale).contains(p) }
            .min { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
        guard let hit else { return }
        let label = PaddedLabel()
        label.numberOfLines = 0
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.textColor = .white
        label.backgroundColor = UIColor(FlowTheme.ink).withAlphaComponent(0.92)
        label.layer.cornerRadius = 8
        label.layer.masksToBounds = true
        label.text = hit.bubbleText
        label.tag = frameViews.firstIndex(of: hit) ?? 0
        imageView.addSubview(label)
        bubble = label
        placeBubble(label)
    }

    /// Anchored above the frame's top edge (below when there is no room), constant size on screen.
    private func placeBubble(_ label: UILabel) {
        guard frameViews.indices.contains(label.tag) else { return }
        let f = frameViews[label.tag].frame
        let z = max(zoomScale, 0.01)
        label.transform = .identity
        let maxW = min(220, bounds.width - 24)
        let fit = label.sizeThatFits(CGSize(width: maxW, height: .greatestFiniteMagnitude))
        let w = min(maxW, fit.width), h = fit.height
        label.bounds = CGRect(x: 0, y: 0, width: w, height: h)
        label.layer.anchorPoint = CGPoint(x: 0, y: 1)
        let gap = 6 / z
        var x = f.minX
        x = min(x, imageView.bounds.width - w / z)
        x = max(0, x)
        var y = f.minY - gap
        if y - h / z < 0 { label.layer.anchorPoint = CGPoint(x: 0, y: 0); y = f.maxY + gap }
        label.layer.position = CGPoint(x: x, y: y)
        label.transform = CGAffineTransform(scaleX: 1 / z, y: 1 / z)
    }

    @objc private func handleDoubleTap(_ g: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale + 0.01 {
            setZoomScale(minimumZoomScale, animated: true)
            return
        }
        let p = g.location(in: imageView)
        let w = bounds.width / Self.doubleTapScale
        let h = bounds.height / Self.doubleTapScale
        zoom(to: CGRect(x: p.x - w / 2, y: p.y - h / 2, width: w, height: h), animated: true)
    }

    /// A swipe down only starts at 1× (when zoomed, a drag pans), and runs beside the scroll
    /// view's own pan, which has nothing to scroll at 1×.
    private final class DismissGate: NSObject, UIGestureRecognizerDelegate {
        weak var view: ZoomScrollView?

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let view, let pan = g as? UIPanGestureRecognizer else { return false }
            guard view.zoomScale <= view.minimumZoomScale + 0.01 else { return false }
            let v = pan.velocity(in: view)
            return v.y > 0 && v.y > abs(v.x)
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }
    }

    @objc private func handleDismissPan(_ g: UIPanGestureRecognizer) {
        // Measured in the superview: this view itself moves with the drag.
        let dy = max(0, g.translation(in: superview).y)
        switch g.state {
        case .changed:
            transform = CGAffineTransform(translationX: 0, y: dy)
            onDrag?(min(dy / 300, 1))
        case .ended where dy > 120 || g.velocity(in: superview).y > 900:
            onDismiss?()
        case .ended, .cancelled, .failed:
            UIView.animate(withDuration: 0.2) { self.transform = .identity }
            onDrag?(0)
        default:
            break
        }
    }
}

/// One AI frame on the Photo: a border and a number badge (and for a matched Thing its name),
/// kept at the same size on screen at any zoom.
private final class FrameMark: UIView {
    let spec: FrameSpec
    private let badge = UILabel()
    private let nameTag = UILabel()

    var isMatched: Bool { spec.rowId == nil }

    init(spec: FrameSpec) {
        self.spec = spec
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        let color: UIColor = isMatched ? UIColor(FlowTheme.moss) : (spec.checked ? UIColor(FlowTheme.lime) : UIColor.white.withAlphaComponent(0.85))
        layer.borderColor = color.cgColor

        badge.text = "\(spec.number)"
        badge.font = .systemFont(ofSize: 11, weight: .bold)
        badge.textAlignment = .center
        badge.textColor = isMatched ? .white : UIColor(FlowTheme.ink)
        badge.backgroundColor = color
        badge.layer.cornerRadius = 4
        badge.layer.masksToBounds = true
        badge.bounds = CGRect(x: 0, y: 0, width: spec.number > 9 ? 24 : 18, height: 18)
        badge.layer.anchorPoint = .zero
        addSubview(badge)

        if isMatched {
            nameTag.text = spec.name
            nameTag.font = .systemFont(ofSize: 10, weight: .semibold)
            nameTag.textColor = .white
            nameTag.backgroundColor = UIColor(FlowTheme.moss)
            nameTag.layer.cornerRadius = 3
            nameTag.layer.masksToBounds = true
            nameTag.layer.anchorPoint = CGPoint(x: 0, y: 1)
            addSubview(nameTag)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func setScreenScale(_ z: CGFloat) {
        layer.borderWidth = 2 / z
        let inv = CGAffineTransform(scaleX: 1 / z, y: 1 / z)
        badge.layer.position = CGPoint(x: -1 / z, y: -1 / z)
        badge.transform = inv
        if isMatched {
            let size = nameTag.sizeThatFits(CGSize(width: 200, height: 15))
            nameTag.bounds = CGRect(x: 0, y: 0, width: min(size.width + 8, max(40, bounds.width * z)), height: 15)
            nameTag.layer.position = CGPoint(x: 0, y: -1 / z)
            nameTag.transform = inv
        }
    }

    var bubbleText: String {
        var lines = [spec.name, isMatched ? "Already in the inventory" : "New"]
        if let c = spec.confidence, !c.isEmpty { lines.append("Confidence: \(c)") }
        return lines.joined(separator: "\n")
    }
}

private final class PaddedLabel: UILabel {
    private let pad = UIEdgeInsets(top: 6, left: 10, bottom: 6, right: 10)
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: pad)) }
    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let inner = super.sizeThatFits(CGSize(width: size.width - pad.left - pad.right, height: size.height))
        return CGSize(width: inner.width + pad.left + pad.right, height: inner.height + pad.top + pad.bottom)
    }
}
