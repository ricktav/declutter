import SwiftUI
import UIKit

/// Where the crop screen gets its image: a stored Photo by key, or a URL the server handed
/// out (the original behind a cutout, from `photos.sourcePhoto`).
enum PhotoCropSource: Hashable {
    case key(String)
    case url(String)
}

/// Full-screen crop of one Photo: the image fit on black, pinch to zoom (1×–6×), pan when
/// zoomed, double-tap toggles 1× / 3×. A frame with four corner handles sits on the image:
/// a corner moves only itself (the opposite corner stays), a drag inside the frame moves it,
/// a drag outside pans the image. The frame lives in image coordinates, so zoom never
/// changes the saved box: centre + size in percent of the image (`PhotoBox`).
struct PhotoCropScreen: View {
    let title: String
    let source: PhotoCropSource
    /// The cutout's current frame when cropping again; nil starts with a centred 60% frame.
    let initialBox: PhotoBox?
    let api: HomeBaseAPI?
    var onCancel: () -> Void
    /// Saves the frame; a thrown error stays on the screen.
    var onSave: (PhotoBox) async throws -> Void

    @State private var image: UIImage?
    @State private var failed = false
    @State private var box: PhotoBox
    @State private var saving = false
    @State private var error: String?

    init(title: String, source: PhotoCropSource, initialBox: PhotoBox?, api: HomeBaseAPI?, onCancel: @escaping () -> Void, onSave: @escaping (PhotoBox) async throws -> Void) {
        self.title = title
        self.source = source
        self.initialBox = initialBox
        self.api = api
        self.onCancel = onCancel
        self.onSave = onSave
        _box = State(initialValue: CropEdges(initialBox).box)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Cancel", action: onCancel)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(FlowTheme.cream)
                    .disabled(saving)
                Spacer()
                Text(title)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(FlowTheme.cream)
                    .lineLimit(1)
                Spacer()
                Button {
                    Task { await save() }
                } label: {
                    if saving {
                        ProgressView().tint(FlowTheme.ink).frame(width: 40)
                    } else {
                        Text("Save")
                    }
                }
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .foregroundStyle(FlowTheme.ink)
                .background(FlowTheme.lime, in: Capsule())
                .disabled(saving || image == nil)
                .opacity(image == nil ? 0.5 : 1)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            ZStack {
                if let image {
                    CropCanvasView(image: image, initialBox: box) { box = $0 }
                } else if failed {
                    VStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle")
                        Text("This Photo could not be loaded.")
                            .font(.system(size: 13))
                    }
                    .foregroundStyle(FlowTheme.mutedText)
                } else {
                    ProgressView().tint(FlowTheme.cream)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            VStack(spacing: 8) {
                if let error {
                    ErrorLine(message: error)
                }
                Text("Drag a corner to frame the Thing · drag inside to move · pinch to zoom")
                    .font(.system(size: 12))
                    .foregroundStyle(FlowTheme.mutedText)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(Color.black.ignoresSafeArea())
        .statusBarHidden()
        .task { await load() }
    }

    private func load() async {
        guard let api else {
            failed = true
            return
        }
        failed = false
        let ui: UIImage? = switch source {
        case .key(let key): await PhotoLoading.load(key, api: api)
        case .url(let url): await PhotoLoading.load(url: url, api: api)
        }
        if let ui, ui.size.width > 0, ui.size.height > 0 {
            // The box is in percent, so a smaller copy crops the same; a full phone Photo
            // would cost far more memory than the screen can show.
            image = PhotoLoading.downsampled(ui, maxPixels: 3000)
            failed = false
        } else {
            failed = true
        }
    }

    private func save() async {
        saving = true
        error = nil
        do {
            try await onSave(CropEdges(box).roundedBox)
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}

/// A frame as its four edges in percent of the image, clamped to the image with a minimum
/// size. `PhotoBox` (centre + size) is what the server takes.
struct CropEdges: Equatable {
    static let minPct: Double = 4

    var left: Double
    var top: Double
    var right: Double
    var bottom: Double

    /// The frame of `box`, clamped; nil gives a centred 60% frame.
    init(_ box: PhotoBox?) {
        guard let b = box, b.isUsable else {
            self.init(left: 20, top: 20, right: 80, bottom: 80)
            return
        }
        self.init(left: b.xPct - b.wPct / 2, top: b.yPct - b.hPct / 2, right: b.xPct + b.wPct / 2, bottom: b.yPct + b.hPct / 2)
    }

    init(left: Double, top: Double, right: Double, bottom: Double) {
        let (l, r) = Self.clampSpan(left, right)
        let (t, b) = Self.clampSpan(top, bottom)
        self.left = l
        self.top = t
        self.right = r
        self.bottom = b
    }

    /// Clamps a span to 0…100 and makes it at least `minPct` wide.
    private static func clampSpan(_ a: Double, _ b: Double) -> (Double, Double) {
        var lo = min(max(min(a, b), 0), 100)
        var hi = min(max(max(a, b), 0), 100)
        if hi - lo < minPct {
            let mid = min(max((lo + hi) / 2, minPct / 2), 100 - minPct / 2)
            lo = mid - minPct / 2
            hi = mid + minPct / 2
        }
        return (lo, hi)
    }

    var box: PhotoBox {
        PhotoBox(xPct: (left + right) / 2, yPct: (top + bottom) / 2, wPct: right - left, hPct: bottom - top)
    }

    /// The box with two decimals: plenty for a crop, and tidy in the database.
    var roundedBox: PhotoBox {
        func r(_ v: Double) -> Double { (v * 100).rounded() / 100 }
        let b = box
        return PhotoBox(xPct: r(b.xPct), yPct: r(b.yPct), wPct: r(b.wPct), hPct: r(b.hPct))
    }

    /// The frame in a view of `size` showing the whole image.
    func rect(in size: CGSize) -> CGRect {
        CGRect(
            x: left / 100 * size.width,
            y: top / 100 * size.height,
            width: (right - left) / 100 * size.width,
            height: (bottom - top) / 100 * size.height
        )
    }
}

private struct CropCanvasView: UIViewRepresentable {
    let image: UIImage
    let initialBox: PhotoBox
    var onChange: (PhotoBox) -> Void

    func makeUIView(context: Context) -> CropScrollView {
        let view = CropScrollView(image: image, edges: CropEdges(initialBox))
        view.canvas.onChange = { onChange($0.box) }
        return view
    }

    func updateUIView(_ view: CropScrollView, context: Context) {
        view.canvas.onChange = { onChange($0.box) }
    }
}

/// The zooming scroll view: `canvas` (image + frame) is its zoomed content.
final class CropScrollView: UIScrollView, UIScrollViewDelegate {
    let canvas: CropCanvas
    private var laidOutFor: CGSize = .zero
    private static let doubleTapScale: CGFloat = 3
    /// Room around the image so a corner handle on the image's edge stays reachable.
    private static let margin: CGFloat = 22

    init(image: UIImage, edges: CropEdges) {
        canvas = CropCanvas(image: image, edges: edges)
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
        addSubview(canvas)

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != laidOutFor, bounds.width > 0, bounds.height > 0 {
            laidOutFor = bounds.size
            setZoomScale(1, animated: false)
            let fit = fitSize()
            canvas.frame = CGRect(origin: .zero, size: fit)
            contentSize = fit
            canvas.setZoom(1)
        }
        centreContent()
    }

    /// The image's size at 1×: aspect-fit inside the view, less the margin.
    private func fitSize() -> CGSize {
        let size = canvas.imageSize
        let w = max(bounds.width - 2 * Self.margin, 1)
        let h = max(bounds.height - 2 * Self.margin, 1)
        guard size.width > 0, size.height > 0 else { return CGSize(width: w, height: h) }
        let scale = min(w / size.width, h / size.height)
        return CGSize(width: size.width * scale, height: size.height * scale)
    }

    /// Centres the image while it is smaller than the view, and always keeps the margin.
    private func centreContent() {
        let dx = max(Self.margin, (bounds.width - contentSize.width) / 2)
        let dy = max(Self.margin, (bounds.height - contentSize.height) / 2)
        let inset = UIEdgeInsets(top: dy, left: dx, bottom: dy, right: dx)
        if contentInset != inset { contentInset = inset }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { canvas }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centreContent()
        canvas.setZoom(zoomScale)
    }

    /// Where the last touch went down, in the canvas: "inside the frame" is decided there,
    /// not where the finger is once the pan threshold is passed.
    private var touchDownInCanvas: CGPoint?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if event?.type == .touches {
            touchDownInCanvas = convert(point, to: canvas)
        }
        return super.hitTest(point, with: event)
    }

    /// The scroll view's own pan does not start on the frame or a handle (those drags move the
    /// frame), except with two fingers, or when the frame fills everything in view (there is
    /// nothing else to pan from).
    override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        if g === panGestureRecognizer {
            if g.numberOfTouches >= 2 { return super.gestureRecognizerShouldBegin(g) }
            let visible = convert(bounds, to: canvas).intersection(canvas.bounds)
            let frameFillsView = !visible.isNull && canvas.frameRect.contains(visible)
            let at = touchDownInCanvas ?? g.location(in: canvas)
            if !frameFillsView, canvas.grabsTouch(at: at) { return false }
        }
        return super.gestureRecognizerShouldBegin(g)
    }

    @objc private func handleDoubleTap(_ g: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale + 0.01 {
            setZoomScale(minimumZoomScale, animated: true)
            return
        }
        let p = g.location(in: canvas)
        let w = bounds.width / Self.doubleTapScale
        let h = bounds.height / Self.doubleTapScale
        zoom(to: CGRect(x: p.x - w / 2, y: p.y - h / 2, width: w, height: h), animated: true)
    }
}

/// The image with the frame drawn over it, in the image view's own coordinates: it zooms
/// and pans with the image. Handles are scaled back by the zoom so they keep their size.
final class CropCanvas: UIView {
    var onChange: ((CropEdges) -> Void)?
    private(set) var edges: CropEdges

    private let imageView = UIImageView()
    private let dim = CAShapeLayer()
    private let border = CAShapeLayer()
    private let grid = CAShapeLayer()
    private let moveArea = UIView()
    private var handles: [CropHandle] = []
    private var zoom: CGFloat = 1
    private var dragStart: CropEdges?

    var imageSize: CGSize { imageView.image?.size ?? .zero }

    /// The frame in canvas coordinates.
    var frameRect: CGRect { edges.rect(in: bounds.size) }

    init(image: UIImage, edges: CropEdges) {
        self.edges = edges
        super.init(frame: .zero)
        imageView.image = image
        imageView.contentMode = .scaleToFill
        addSubview(imageView)

        dim.fillRule = .evenOdd
        dim.fillColor = UIColor.black.withAlphaComponent(0.55).cgColor
        layer.addSublayer(dim)
        grid.strokeColor = UIColor.white.withAlphaComponent(0.35).cgColor
        grid.fillColor = nil
        layer.addSublayer(grid)
        border.strokeColor = UIColor(red: 0.82, green: 1, blue: 0, alpha: 1).cgColor
        border.fillColor = nil
        layer.addSublayer(border)

        moveArea.backgroundColor = .clear
        moveArea.accessibilityLabel = "Crop frame"
        let move = UIPanGestureRecognizer(target: self, action: #selector(handleMove(_:)))
        move.maximumNumberOfTouches = 1
        moveArea.addGestureRecognizer(move)
        addSubview(moveArea)

        for corner in CropHandle.Corner.allCases {
            let h = CropHandle(corner: corner)
            let pan = UIPanGestureRecognizer(target: self, action: #selector(handleCorner(_:)))
            pan.maximumNumberOfTouches = 1
            h.addGestureRecognizer(pan)
            addSubview(h)
            handles.append(h)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        imageView.frame = bounds
        layoutFrame()
    }

    func setZoom(_ z: CGFloat) {
        zoom = max(z, 0.01)
        layoutFrame()
    }

    /// True when a touch here starts a frame drag (a handle or inside the frame).
    func grabsTouch(at p: CGPoint) -> Bool {
        handles.contains { $0.frame.contains(p) } || moveArea.frame.contains(p)
    }

    /// Handles stick out past the image's edge; they still take touches there.
    override func point(inside p: CGPoint, with event: UIEvent?) -> Bool {
        bounds.contains(p) || handles.contains { $0.frame.contains(p) }
    }

    private func layoutFrame() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let r = edges.rect(in: bounds.size)
        let outside = UIBezierPath(rect: bounds)
        outside.append(UIBezierPath(rect: r))
        dim.frame = bounds
        dim.path = outside.cgPath
        border.frame = bounds
        border.path = UIBezierPath(rect: r).cgPath
        border.lineWidth = 2 / zoom
        let g = UIBezierPath()
        for i in 1...2 {
            let x = r.minX + r.width * CGFloat(i) / 3
            let y = r.minY + r.height * CGFloat(i) / 3
            g.move(to: CGPoint(x: x, y: r.minY))
            g.addLine(to: CGPoint(x: x, y: r.maxY))
            g.move(to: CGPoint(x: r.minX, y: y))
            g.addLine(to: CGPoint(x: r.maxX, y: y))
        }
        grid.frame = bounds
        grid.path = g.cgPath
        grid.lineWidth = 1 / zoom
        CATransaction.commit()

        moveArea.frame = r
        for h in handles {
            h.transform = CGAffineTransform(scaleX: 1 / zoom, y: 1 / zoom)
            h.center = CGPoint(x: h.corner.isLeft ? r.minX : r.maxX, y: h.corner.isTop ? r.minY : r.maxY)
        }
    }

    private func update(_ e: CropEdges) {
        guard e != edges else { return }
        edges = e
        layoutFrame()
        onChange?(e)
    }

    /// Drag deltas in percent of the image. `translation(in: self)` is already in the
    /// canvas's own (unzoomed) coordinates, so zoom does not change the result.
    private func deltaPct(_ g: UIPanGestureRecognizer) -> (Double, Double) {
        let t = g.translation(in: self)
        return (Double(t.x / bounds.width * 100), Double(t.y / bounds.height * 100))
    }

    @objc private func handleMove(_ g: UIPanGestureRecognizer) {
        switch g.state {
        case .began:
            dragStart = edges
        case .changed:
            guard let s = dragStart else { return }
            let (dx, dy) = deltaPct(g)
            let w = s.right - s.left
            let h = s.bottom - s.top
            let l = min(max(s.left + dx, 0), 100 - w)
            let t = min(max(s.top + dy, 0), 100 - h)
            update(CropEdges(left: l, top: t, right: l + w, bottom: t + h))
        default:
            dragStart = nil
        }
    }

    @objc private func handleCorner(_ g: UIPanGestureRecognizer) {
        guard let corner = (g.view as? CropHandle)?.corner else { return }
        switch g.state {
        case .began:
            dragStart = edges
        case .changed:
            guard let s = dragStart else { return }
            let (dx, dy) = deltaPct(g)
            let m = CropEdges.minPct
            var e = s
            if corner.isLeft {
                e.left = min(max(s.left + dx, 0), s.right - m)
            } else {
                e.right = min(max(s.right + dx, s.left + m), 100)
            }
            if corner.isTop {
                e.top = min(max(s.top + dy, 0), s.bottom - m)
            } else {
                e.bottom = min(max(s.bottom + dy, s.top + m), 100)
            }
            update(e)
        default:
            dragStart = nil
        }
    }
}

/// A corner handle: a 36 pt touch target with a visible knob, kept at screen size by the canvas.
final class CropHandle: UIView {
    enum Corner: CaseIterable {
        case topLeft, topRight, bottomLeft, bottomRight
        var isLeft: Bool { self == .topLeft || self == .bottomLeft }
        var isTop: Bool { self == .topLeft || self == .topRight }
    }

    let corner: Corner
    private static let side: CGFloat = 36
    private static let knob: CGFloat = 18

    init(corner: Corner) {
        self.corner = corner
        super.init(frame: CGRect(x: 0, y: 0, width: Self.side, height: Self.side))
        backgroundColor = .clear
        let k = CALayer()
        let o = (Self.side - Self.knob) / 2
        k.frame = CGRect(x: o, y: o, width: Self.knob, height: Self.knob)
        k.cornerRadius = Self.knob / 2
        k.backgroundColor = UIColor(red: 0.82, green: 1, blue: 0, alpha: 1).cgColor
        k.borderColor = UIColor(red: 0.16, green: 0.17, blue: 0.13, alpha: 1).cgColor
        k.borderWidth = 2
        k.shadowColor = UIColor.black.cgColor
        k.shadowOpacity = 0.4
        k.shadowRadius = 3
        k.shadowOffset = .zero
        layer.addSublayer(k)
        isAccessibilityElement = true
        accessibilityLabel = switch corner {
        case .topLeft: "Top left corner"
        case .topRight: "Top right corner"
        case .bottomLeft: "Bottom left corner"
        case .bottomRight: "Bottom right corner"
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
