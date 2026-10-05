import SwiftUI
import SceneKit
import UIKit

enum PlanMode: String, CaseIterable, Identifiable {
    case plan2d = "2D"
    case plan3d = "3D"
    var id: String { rawValue }
}

struct FloorPlanView: View {
    let geometry: RoomGeometryPayload
    var items: [RoomItem] = []
    /// Drawn highlighted (the Thing whose sheet is open, or the one being moved).
    var selectedId: Int? = nil
    /// While set, the 2D plan drags this Thing; each release calls `onMove`.
    var movingId: Int? = nil
    /// nil: the boxes are not tappable (the Thing sheet's small plan).
    var onTapItem: ((RoomItem) -> Void)? = nil
    var onMove: ((RoomItem, ItemPos) -> Void)? = nil
    @State private var mode: PlanMode = .plan2d

    var body: some View {
        VStack(spacing: 8) {
            Picker("Plan view", selection: $mode) {
                ForEach(PlanMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .disabled(movingId != nil)
            Group {
                if mode == .plan2d {
                    FloorPlan2D(
                        geometry: geometry,
                        items: items,
                        selectedId: selectedId ?? movingId,
                        movingId: movingId,
                        onTapItem: onTapItem,
                        onMove: onMove
                    )
                } else {
                    FloorPlan3D(geometry: geometry, items: items, onTapItem: onTapItem)
                }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(1, contentMode: .fit)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(movingId != nil ? FlowTheme.ink : Color(hex: 0xD5D9CD), lineWidth: movingId != nil ? 2 : 1))
            Text(String(format: "%.1f × %.1f m · wall %.1f m", geometry.widthM, geometry.depthM, geometry.wallHeightM))
                .font(.system(size: 11, design: .rounded))
                .foregroundStyle(FlowTheme.muted)
        }
        // Moving is a 2D drag; the 3D view would only orbit.
        .onChange(of: movingId) { _, id in
            if id != nil { mode = .plan2d }
        }
    }
}

/// Metres to points for a plan drawn in a view of `size`, shared by drawing and hit-testing.
struct PlanLayout {
    let s: CGFloat
    let ox: CGFloat
    let oy: CGFloat

    init(size: CGSize, geometry: RoomGeometryPayload, pad: CGFloat = 18) {
        let sx = (size.width - pad * 2) / max(geometry.widthM, 0.5)
        let sy = (size.height - pad * 2) / max(geometry.depthM, 0.5)
        s = max(min(sx, sy), 1)
        ox = (size.width - geometry.widthM * s) / 2
        oy = (size.height - geometry.depthM * s) / 2
    }

    func pt(_ x: Double, _ y: Double) -> CGPoint {
        CGPoint(x: ox + x * s, y: oy + y * s)
    }

    func centre(_ p: ItemPos) -> CGPoint {
        pt(p.xM + p.wM / 2, p.yM + p.dM / 2)
    }

    /// Like the Workbench 2D plan: turned by -rotDeg about the footprint's centre
    /// (y points down, so that is counter-clockwise as seen from above).
    func box(_ p: ItemPos) -> Path {
        let w = p.wM * s, d = p.dM * s
        let centred = Path(roundedRect: CGRect(x: -w / 2, y: -d / 2, width: w, height: d), cornerRadius: 2)
        let c = centre(p)
        let turn = CGAffineTransform(translationX: c.x, y: c.y).rotated(by: -p.rotDeg * .pi / 180)
        return centred.applying(turn)
    }

    /// True when `point` falls in the footprint, with a few points of slack for tiny boxes.
    func contains(_ p: ItemPos, _ point: CGPoint, slack: CGFloat = 6) -> Bool {
        let c = centre(p)
        let dx = point.x - c.x, dy = point.y - c.y
        // Undo the box's turn of -rotDeg.
        let a = p.rotDeg * .pi / 180
        let lx = dx * cos(a) - dy * sin(a)
        let ly = dx * sin(a) + dy * cos(a)
        return abs(lx) <= p.wM * s / 2 + slack && abs(ly) <= p.dM * s / 2 + slack
    }

    /// The smallest footprint under `point`: a small Thing on a table wins over the table.
    func hit(_ items: [RoomItem], at point: CGPoint) -> RoomItem? {
        items
            .filter { it in it.pos.map { contains($0, point) } ?? false }
            .min { ($0.pos!.wM * $0.pos!.dM) < ($1.pos!.wM * $1.pos!.dM) }
    }
}

/// A Thing's name on the 2D plan: where it goes and how it is hit, shared by drawing and taps.
struct PlanLabel {
    let item: RoomItem
    let text: String
    /// The label's white backing, in canvas points; the text is centred in it.
    let rect: CGRect

    /// A label short enough for a plan: whole names up to `max` characters, else cut with "…".
    static func short(_ name: String, max: Int = 16) -> String {
        let t = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count <= max ? t : String(t.prefix(max - 1)) + "…"
    }

    static let fontSize: CGFloat = 9

    private static let uiFont: UIFont = {
        let base = UIFont.systemFont(ofSize: fontSize, weight: .semibold)
        guard let rounded = base.fontDescriptor.withDesign(.rounded) else { return base }
        return UIFont(descriptor: rounded, size: fontSize)
    }()

    static func textSize(_ text: String) -> CGSize {
        let s = (text as NSString).size(withAttributes: [.font: uiFont])
        return CGSize(width: ceil(s.width), height: ceil(s.height))
    }

    /// Inside a footprint that holds the label even turned by its rotation, else below it,
    /// else above it when below would cover a label already placed; always inside the canvas.
    static func place(_ placed: [(RoomItem, ItemPos)], layout: PlanLayout, canvas: CGSize) -> [PlanLabel] {
        var out: [PlanLabel] = []
        for (it, p) in placed {
            let text = short(it.name)
            let t = textSize(text)
            let lw = t.width + 6, lh = t.height + 2
            let a = p.rotDeg * .pi / 180
            let c = abs(cos(a)), sn = abs(sin(a))
            // The label stays upright; the box is turned. It fits when its corners do.
            let inside = lw / 2 * c + lh / 2 * sn <= p.wM * layout.s / 2 - 1
                && lw / 2 * sn + lh / 2 * c <= p.dM * layout.s / 2 - 1
            let bounds = layout.box(p).boundingRect
            func backing(_ centre: CGPoint) -> CGRect {
                CGRect(x: centre.x - lw / 2, y: centre.y - lh / 2, width: lw, height: lh)
            }
            var rect = inside
                ? backing(layout.centre(p))
                : backing(CGPoint(x: bounds.midX, y: bounds.maxY + lh / 2 + 1))
            if !inside, out.contains(where: { $0.rect.intersects(rect) }) {
                rect = backing(CGPoint(x: bounds.midX, y: bounds.minY - lh / 2 - 1))
            }
            rect.origin.x = min(max(rect.origin.x, 1), max(canvas.width - lw - 1, 1))
            rect.origin.y = min(max(rect.origin.y, 1), max(canvas.height - lh - 1, 1))
            out.append(PlanLabel(item: it, text: text, rect: rect))
        }
        return out
    }
}

struct FloorPlan2D: View {
    let geometry: RoomGeometryPayload
    var items: [RoomItem] = []
    var selectedId: Int? = nil
    var movingId: Int? = nil
    var onTapItem: ((RoomItem) -> Void)? = nil
    var onMove: ((RoomItem, ItemPos) -> Void)? = nil

    /// The finger's travel while dragging the moving Thing, in points. A gesture state, so a
    /// drag the system cancels (a sheet or scroll taking over) puts the box back by itself.
    @GestureState private var drag: CGSize = .zero

    /// Where the moving Thing ends up for a drag of `t` points: whole centimetres, centre kept in the room.
    private func moved(_ p: ItemPos, by t: CGSize, layout: PlanLayout) -> ItemPos {
        var q = p
        let x = p.xM + t.width / layout.s
        let y = p.yM + t.height / layout.s
        q.xM = (min(max(x, -p.wM / 2), geometry.widthM - p.wM / 2) * 100).rounded() / 100
        q.yM = (min(max(y, -p.dM / 2), geometry.depthM - p.dM / 2) * 100).rounded() / 100
        return q
    }

    /// Every placed Thing with the footprint it is drawn at (the moving one follows the finger).
    private func footprints(layout: PlanLayout, offset: CGSize) -> [(RoomItem, ItemPos)] {
        items.compactMap { it in
            guard var p = it.pos else { return nil }
            if it.id == movingId, offset != .zero { p = moved(p, by: offset, layout: layout) }
            return (it, p)
        }
    }

    var body: some View {
        GeometryReader { proxy in
            let layout = PlanLayout(size: proxy.size, geometry: geometry)
            let offset = drag // read here, so a drag redraws the Canvas
            let placed = footprints(layout: layout, offset: offset)
            let labels = PlanLabel.place(placed, layout: layout, canvas: proxy.size)
            Canvas { context, _ in
                draw(in: &context, layout: layout, placed: placed, labels: labels)
            }
            .contentShape(Rectangle())
            .onTapGesture(coordinateSpace: .local) { location in
                guard movingId == nil, let onTapItem else { return }
                // Labels are drawn on top, so they win; the last drawn is the topmost.
                if let label = labels.last(where: { $0.rect.insetBy(dx: -3, dy: -3).contains(location) }) {
                    onTapItem(label.item)
                } else if let it = layout.hit(items, at: location) {
                    onTapItem(it)
                }
            }
            .highPriorityGesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .updating($drag) { v, state, _ in state = v.translation }
                    .onEnded { v in
                        guard let id = movingId,
                              let it = items.first(where: { $0.id == id }),
                              let p = it.pos,
                              hypot(v.translation.width, v.translation.height) > 2 else { return }
                        // The parent sets the new pos synchronously, in the same update that
                        // resets `drag`, so the box never jumps back for a frame.
                        onMove?(it, moved(p, by: v.translation, layout: layout))
                    },
                including: movingId != nil && onMove != nil ? .all : .subviews
            )
        }
        .padding(4)
    }

    private func draw(in context: inout GraphicsContext, layout: PlanLayout, placed: [(RoomItem, ItemPos)], labels: [PlanLabel]) {
        let s = layout.s
        let floor = Path(CGRect(x: layout.ox, y: layout.oy, width: geometry.widthM * s, height: geometry.depthM * s))
        context.fill(floor, with: .color(Color(hex: 0xF0F2EA)))
        context.stroke(floor, with: .color(Color(hex: 0xD5D9CD)), lineWidth: 1)

        for wall in geometry.walls {
            guard wall.points.count >= 2 else { continue }
            var path = Path()
            path.move(to: layout.pt(wall.points[0][0], wall.points[0][1]))
            for p in wall.points.dropFirst() {
                path.addLine(to: layout.pt(p[0], p[1]))
            }
            let kind = wall.kind ?? "wall"
            if kind == "door" {
                context.stroke(path, with: .color(Color(hex: 0xD9A13B)), style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
            } else if kind == "window" {
                context.stroke(path, with: .color(Color(hex: 0x2D689B)), lineWidth: 3)
            } else {
                context.stroke(path, with: .color(FlowTheme.ink), lineWidth: 2)
            }
        }

        // Footprints first, then every label on top, so a label is never under another box.
        for (it, p) in placed {
            let box = layout.box(p)
            let selected = it.id == selectedId
            if it.isDetected {
                context.fill(box, with: .color(FlowTheme.moss.opacity(selected ? 0.3 : 0.12)))
                context.stroke(box, with: .color(FlowTheme.moss.opacity(0.75)), style: StrokeStyle(lineWidth: selected ? 2 : 1, dash: [3, 2]))
            } else {
                context.fill(box, with: .color(FlowTheme.moss.opacity(selected ? 0.55 : 0.35)))
                context.stroke(box, with: .color(FlowTheme.moss), lineWidth: selected ? 2 : 1)
            }
            if selected {
                context.stroke(box, with: .color(FlowTheme.ink), lineWidth: 2)
            }
        }

        for label in labels {
            let text = Text(label.text)
                .font(.system(size: PlanLabel.fontSize, weight: .semibold, design: .rounded))
                .foregroundColor(label.item.isDetected ? FlowTheme.muted : FlowTheme.ink)
            context.fill(Path(roundedRect: label.rect, cornerRadius: 3), with: .color(Color.white.opacity(label.item.isDetected ? 0.6 : 0.8)))
            context.draw(context.resolve(text), at: CGPoint(x: label.rect.midX, y: label.rect.midY), anchor: .center)
        }
    }
}

struct FloorPlan3D: UIViewRepresentable {
    let geometry: RoomGeometryPayload
    var items: [RoomItem] = []
    var onTapItem: ((RoomItem) -> Void)? = nil

    final class Coordinator: NSObject {
        var sceneKey: Int?
        var items: [RoomItem] = []
        var onTapItem: ((RoomItem) -> Void)?

        /// A tap on a box (`item:<id>`) or its label (`label:<id>`) opens that Thing. Labels are
        /// drawn over everything, so a label under the finger wins over a nearer box.
        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard let view = g.view as? SCNView, let onTapItem else { return }
            let hits = view.hitTest(g.location(in: view), options: [
                .searchMode: SCNHitTestSearchMode.all.rawValue,
                .ignoreHiddenNodes: true,
            ])
            func thing(_ prefix: String) -> RoomItem? {
                for hit in hits {
                    var node: SCNNode? = hit.node
                    while let n = node {
                        if let name = n.name, name.hasPrefix(prefix), let id = Int(name.dropFirst(prefix.count)) {
                            return items.first(where: { $0.id == id })
                        }
                        node = n.parent
                    }
                }
                return nil
            }
            if let it = thing("label:") ?? thing("item:") {
                onTapItem(it)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Changes only when the room or its Things' footprints change.
    private var sceneKey: Int {
        var h = Hasher()
        h.combine(geometry)
        for it in items {
            h.combine(it.id)
            h.combine(it.pos)
            h.combine(it.name)
            h.combine(it.verificationStatus)
        }
        return h.finalize()
    }

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.scene = buildScene()
        context.coordinator.sceneKey = sceneKey
        context.coordinator.items = items
        context.coordinator.onTapItem = onTapItem
        view.addGestureRecognizer(UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:))))
        view.allowsCameraControl = true
        view.autoenablesDefaultLighting = true
        view.backgroundColor = UIColor(red: 0.96, green: 0.96, blue: 0.93, alpha: 1)
        view.antialiasingMode = .multisampling4X
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {
        context.coordinator.items = items
        context.coordinator.onTapItem = onTapItem
        // Rebuilding on every SwiftUI update would reset the orbit the viewer set.
        let key = sceneKey
        guard key != context.coordinator.sceneKey else { return }
        context.coordinator.sceneKey = key
        uiView.scene = buildScene()
    }

    private func buildScene() -> SCNScene {
        let scene = SCNScene()
        let h = max(geometry.wallHeightM, 0.8)
        let floor = SCNNode(geometry: SCNPlane(width: geometry.widthM, height: geometry.depthM))
        floor.geometry?.firstMaterial?.diffuse.contents = UIColor(white: 0.92, alpha: 1)
        floor.eulerAngles.x = -.pi / 2
        floor.position = SCNVector3(geometry.widthM / 2, 0, geometry.depthM / 2)
        scene.rootNode.addChildNode(floor)

        for wall in geometry.walls {
            guard wall.points.count >= 2 else { continue }
            for i in 0..<(wall.points.count - 1) {
                let a = wall.points[i], b = wall.points[i + 1]
                let dx = b[0] - a[0], dy = b[1] - a[1]
                let len = hypot(dx, dy)
                guard len > 0.05 else { continue }
                let kind = wall.kind ?? "wall"
                let thickness = kind == "wall" ? 0.08 : 0.05
                let box = SCNBox(width: len, height: kind == "window" ? h * 0.4 : h, length: thickness, chamferRadius: 0)
                if kind == "door" {
                    box.firstMaterial?.diffuse.contents = UIColor(red: 0.85, green: 0.63, blue: 0.23, alpha: 1)
                } else if kind == "window" {
                    box.firstMaterial?.diffuse.contents = UIColor(red: 0.18, green: 0.41, blue: 0.61, alpha: 0.55)
                } else {
                    box.firstMaterial?.diffuse.contents = UIColor(red: 0.16, green: 0.17, blue: 0.13, alpha: 1)
                }
                let node = SCNNode(geometry: box)
                node.position = SCNVector3((a[0] + b[0]) / 2, (kind == "window" ? h * 0.55 : h / 2), (a[1] + b[1]) / 2)
                node.eulerAngles.y = Float(-atan2(dy, dx))
                scene.rootNode.addChildNode(node)
            }
        }

        let labelHeight = min(max(max(geometry.widthM, geometry.depthM) * 0.035, 0.1), 0.3)
        for it in items {
            guard let p = it.pos else { continue }
            let height = max(p.hM ?? 0.7, 0.3)
            let box = SCNBox(width: max(p.wM, 0.2), height: height, length: max(p.dM, 0.2), chamferRadius: 0)
            box.firstMaterial?.diffuse.contents = it.isDetected
                ? UIColor(red: 0.24, green: 0.36, blue: 0.25, alpha: 0.35)
                : UIColor(red: 0.24, green: 0.36, blue: 0.25, alpha: 0.85)
            let node = SCNNode(geometry: box)
            node.name = "item:\(it.id)"
            node.position = SCNVector3(p.xM + p.wM / 2, height / 2, p.yM + p.dM / 2)
            node.eulerAngles.y = Float(p.rotDeg * .pi / 180) // as the Workbench 3D view: rotation.y = rotDeg
            scene.rootNode.addChildNode(node)

            // The label floats above the box and always faces the viewer; a sibling of the
            // box, so it does not turn with it.
            let label = Self.labelNode(PlanLabel.short(it.name, max: 22), dim: it.isDetected, height: labelHeight)
            label.name = "label:\(it.id)"
            label.position = SCNVector3(p.xM + p.wM / 2, height + labelHeight * 0.9, p.yM + p.dM / 2)
            scene.rootNode.addChildNode(label)
        }

        let camera = SCNNode()
        camera.camera = SCNCamera()
        camera.camera?.fieldOfView = 45
        let cx = geometry.widthM / 2
        let cz = geometry.depthM / 2
        let dist = max(geometry.widthM, geometry.depthM) * 1.4
        camera.position = SCNVector3(cx + dist * 0.35, dist * 0.9, cz + dist * 0.55)
        camera.eulerAngles = SCNVector3(-0.85, 0.35, 0)
        scene.rootNode.addChildNode(camera)
        return scene
    }

    /// A billboard with the name drawn on it; drawn over walls so it never hides behind one.
    private static func labelNode(_ text: String, dim: Bool, height: Double) -> SCNNode {
        let image = labelImage(text, dim: dim)
        let aspect = image.size.width / max(image.size.height, 1)
        let plane = SCNPlane(width: height * aspect, height: height)
        let m = plane.firstMaterial!
        m.diffuse.contents = image
        m.lightingModel = .constant
        m.isDoubleSided = true
        m.readsFromDepthBuffer = false
        m.writesToDepthBuffer = false
        let node = SCNNode(geometry: plane)
        node.renderingOrder = 10
        node.constraints = [SCNBillboardConstraint()]
        return node
    }

    private static func labelImage(_ text: String, dim: Bool) -> UIImage {
        let font = UIFont.systemFont(ofSize: 30, weight: .semibold)
        let ink = dim ? UIColor(red: 0.43, green: 0.46, blue: 0.39, alpha: 1) : UIColor(red: 0.16, green: 0.17, blue: 0.13, alpha: 1)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink]
        let t = (text as NSString).size(withAttributes: attrs)
        let size = CGSize(width: ceil(t.width) + 28, height: ceil(t.height) + 14)
        return UIGraphicsImageRenderer(size: size).image { _ in
            let rect = CGRect(origin: .zero, size: size)
            let pill = UIBezierPath(roundedRect: rect.insetBy(dx: 1, dy: 1), cornerRadius: (size.height - 2) / 2)
            UIColor(white: 1, alpha: dim ? 0.75 : 0.95).setFill()
            pill.fill()
            ink.withAlphaComponent(dim ? 0.5 : 0.8).setStroke()
            pill.lineWidth = 2
            if dim { pill.setLineDash([6, 4], count: 2, phase: 0) }
            pill.stroke()
            (text as NSString).draw(at: CGPoint(x: 14, y: 7), withAttributes: attrs)
        }
    }
}
