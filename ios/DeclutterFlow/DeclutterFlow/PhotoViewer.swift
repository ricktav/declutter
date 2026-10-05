import SwiftUI
import UIKit

/// Full-screen Photo viewer: pinch between 1× and 6×, double-tap toggles 1× / 3× around the tap,
/// pan when zoomed, swipe down (at 1×) or Close to dismiss. Backed by a UIScrollView, which
/// handles pinch, pan and bounce more reliably than stacked SwiftUI gestures.
struct PhotoViewer: View {
    let image: UIImage
    var onClose: () -> Void

    /// 0…1 while a swipe-down is in progress; fades the black background.
    @State private var dragProgress: CGFloat = 0

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black
                .opacity(1 - dragProgress * 0.7)
                .ignoresSafeArea()
            ZoomableImage(image: image, onDrag: { dragProgress = $0 }, onDismiss: onClose)
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
        }
        .statusBarHidden()
        .presentationBackground(.clear)
    }
}

private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    var onDrag: (CGFloat) -> Void
    var onDismiss: () -> Void

    func makeUIView(context: Context) -> ZoomScrollView {
        let view = ZoomScrollView(image: image)
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

    func scrollViewDidZoom(_ scrollView: UIScrollView) { centreContent() }

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
