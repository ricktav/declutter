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
    @State private var mode: PlanMode = .plan2d

    var body: some View {
        VStack(spacing: 8) {
            Picker("Lens", selection: $mode) {
                ForEach(PlanMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            Group {
                if mode == .plan2d {
                    FloorPlan2D(geometry: geometry, items: items)
                } else {
                    FloorPlan3D(geometry: geometry, items: items)
                }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(1, contentMode: .fit)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color(hex: 0xD5D9CD)))
            Text(String(format: "%.1f × %.1f m · wall %.1f m", geometry.widthM, geometry.depthM, geometry.wallHeightM))
                .font(.system(size: 11, design: .rounded))
                .foregroundStyle(FlowTheme.muted)
        }
    }
}

struct FloorPlan2D: View {
    let geometry: RoomGeometryPayload
    var items: [RoomItem] = []

    var body: some View {
        Canvas { context, size in
            let pad: CGFloat = 18
            let sx = (size.width - pad * 2) / max(geometry.widthM, 0.5)
            let sy = (size.height - pad * 2) / max(geometry.depthM, 0.5)
            let s = min(sx, sy)
            let ox = (size.width - geometry.widthM * s) / 2
            let oy = (size.height - geometry.depthM * s) / 2
            func pt(_ x: Double, _ y: Double) -> CGPoint {
                CGPoint(x: ox + x * s, y: oy + y * s)
            }

            let floor = Path(CGRect(x: ox, y: oy, width: geometry.widthM * s, height: geometry.depthM * s))
            context.fill(floor, with: .color(Color(hex: 0xF0F2EA)))
            context.stroke(floor, with: .color(Color(hex: 0xD5D9CD)), lineWidth: 1)

            for wall in geometry.walls {
                guard wall.points.count >= 2 else { continue }
                var path = Path()
                path.move(to: pt(wall.points[0][0], wall.points[0][1]))
                for p in wall.points.dropFirst() {
                    path.addLine(to: pt(p[0], p[1]))
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

            for it in items {
                guard let p = it.pos else { continue }
                let rect = CGRect(x: ox + p.xM * s, y: oy + p.yM * s, width: p.wM * s, height: p.dM * s)
                context.fill(Path(roundedRect: rect, cornerRadius: 2), with: .color(FlowTheme.moss.opacity(0.35)))
                context.stroke(Path(roundedRect: rect, cornerRadius: 2), with: .color(FlowTheme.moss), lineWidth: 1)
            }
        }
        .padding(4)
    }
}

struct FloorPlan3D: UIViewRepresentable {
    let geometry: RoomGeometryPayload
    var items: [RoomItem] = []

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.scene = buildScene()
        view.allowsCameraControl = true
        view.autoenablesDefaultLighting = true
        view.backgroundColor = UIColor(red: 0.96, green: 0.96, blue: 0.93, alpha: 1)
        view.antialiasingMode = .multisampling4X
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {
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
                node.eulerAngles.y = -atan2(dy, dx)
                scene.rootNode.addChildNode(node)
            }
        }

        for it in items {
            guard let p = it.pos else { continue }
            let box = SCNBox(width: max(p.wM, 0.2), height: max(p.hM ?? 0.7, 0.3), length: max(p.dM, 0.2), chamferRadius: 0)
            box.firstMaterial?.diffuse.contents = UIColor(red: 0.24, green: 0.36, blue: 0.25, alpha: 0.85)
            let node = SCNNode(geometry: box)
            node.position = SCNVector3(p.xM + p.wM / 2, (p.hM ?? 0.7) / 2, p.yM + p.dM / 2)
            node.eulerAngles.y = -p.rotDeg * .pi / 180
            scene.rootNode.addChildNode(node)
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
}
