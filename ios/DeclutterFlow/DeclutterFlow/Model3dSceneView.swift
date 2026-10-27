import SceneKit
import SwiftUI
import GLTFKit2

/// SceneKit orbit viewer for `.usdz` (ModelIO / SceneKit) and `.glb` / `.gltf` (GLTFKit2).
/// Failures are reported through `onFail` and never thrown into SwiftUI.
struct Model3dSceneView: UIViewRepresentable {
    let fileURL: URL
    let format: Model3dFormat
    var onFail: (Model3dFail, String?) -> Void
    var onReady: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.backgroundColor = UIColor(red: 244 / 255, green: 241 / 255, blue: 234 / 255, alpha: 1)
        view.antialiasingMode = .multisampling4X
        view.autoenablesDefaultLighting = false
        view.allowsCameraControl = true
        view.defaultCameraController.interactionMode = .orbitTurntable
        view.defaultCameraController.inertiaEnabled = true
        view.scene = SCNScene()
        context.coordinator.view = view
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {
        context.coordinator.view = uiView
        context.coordinator.bind(fileURL: fileURL, format: format, onFail: onFail, onReady: onReady)
    }

    final class Coordinator {
        weak var view: SCNView?
        private var loadedKey: String?
        private var cancelled = false

        deinit { cancelled = true }

        func bind(fileURL: URL, format: Model3dFormat, onFail: @escaping (Model3dFail, String?) -> Void, onReady: @escaping () -> Void) {
            let key = fileURL.path
            guard loadedKey != key else { return }
            loadedKey = key
            cancelled = false
            switch format {
            case .usdz:
                loadUsdz(fileURL, onFail: onFail, onReady: onReady)
            case .glb, .gltf:
                loadGltf(fileURL, onFail: onFail, onReady: onReady)
            case .js:
                onFail(.unsupported, "JS models use the web viewer.")
            }
        }

        private func loadUsdz(_ url: URL, onFail: @escaping (Model3dFail, String?) -> Void, onReady: @escaping () -> Void) {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                do {
                    let scene = try SCNScene(url: url, options: [
                        .createNormalsIfAbsent: true,
                    ])
                    DispatchQueue.main.async {
                        guard let self, !self.cancelled else { return }
                        self.present(scene, onFail: onFail, onReady: onReady, fail: .usdz)
                    }
                } catch {
                    DispatchQueue.main.async {
                        guard let self, !self.cancelled else { return }
                        onFail(.usdz, error.localizedDescription)
                    }
                }
            }
        }

        private func loadGltf(_ url: URL, onFail: @escaping (Model3dFail, String?) -> Void, onReady: @escaping () -> Void) {
            let once = ResumeOnce()
            GLTFAsset.load(with: url, options: [:]) { [weak self] _, status, asset, error, _ in
                guard let self else { return }
                switch status {
                case .complete:
                    guard once.take() else { return }
                    guard !self.cancelled else { return }
                    guard let asset else {
                        DispatchQueue.main.async { onFail(.parse, "GLTFKit2 returned no asset.") }
                        return
                    }
                    DispatchQueue.main.async {
                        guard !self.cancelled else { return }
                        let source = GLTFSCNSceneSource(asset: asset)
                        guard let scene = source.defaultScene else {
                            onFail(.parse, "GLTFKit2 produced no SceneKit scene.")
                            return
                        }
                        self.present(scene, onFail: onFail, onReady: onReady, fail: .parse)
                    }
                case .error:
                    guard once.take() else { return }
                    let detail = error?.localizedDescription
                    DispatchQueue.main.async {
                        guard !self.cancelled else { return }
                        onFail(.parse, detail)
                    }
                default:
                    break
                }
            }
        }

        private func present(_ scene: SCNScene, onFail: (Model3dFail, String?) -> Void, onReady: () -> Void, fail: Model3dFail) {
            guard let view else {
                onFail(fail, "Viewer is gone.")
                return
            }
            Model3dSceneLighting.addProductLights(to: scene)
            scene.background.contents = UIColor(red: 244 / 255, green: 241 / 255, blue: 234 / 255, alpha: 1)
            view.scene = scene
            if !Model3dSceneLighting.fitCamera(scene: scene, view: view) {
                onFail(fail, "The model has no visible geometry.")
                return
            }
            onReady()
        }
    }
}

/// One-shot latch so the GLTFKit2 progress handler cannot resume twice.
private final class ResumeOnce: @unchecked Sendable {
    private var taken = false
    private let lock = NSLock()
    func take() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if taken { return false }
        taken = true
        return true
    }
}

enum Model3dSceneLighting {
    /// Hemisphere + key + fill, same idea as `Model3dViewer.tsx` (metres, Y-up, no rescale).
    static func addProductLights(to scene: SCNScene) {
        let root = scene.rootNode

        let ambient = SCNLight()
        ambient.type = .ambient
        ambient.color = UIColor(red: 244 / 255, green: 241 / 255, blue: 234 / 255, alpha: 1)
        ambient.intensity = 550
        let ambientNode = SCNNode()
        ambientNode.name = "model3d.ambient"
        ambientNode.light = ambient
        root.addChildNode(ambientNode)

        let key = SCNLight()
        key.type = .directional
        key.color = UIColor.white
        key.intensity = 1150
        key.castsShadow = false
        let keyNode = SCNNode()
        keyNode.name = "model3d.key"
        keyNode.light = key
        keyNode.position = SCNVector3(2.4, 4.2, 2.8)
        keyNode.look(at: SCNVector3Zero)
        root.addChildNode(keyNode)

        let fill = SCNLight()
        fill.type = .directional
        fill.color = UIColor(red: 232 / 255, green: 228 / 255, blue: 216 / 255, alpha: 1)
        fill.intensity = 450
        fill.castsShadow = false
        let fillNode = SCNNode()
        fillNode.name = "model3d.fill"
        fillNode.light = fill
        fillNode.position = SCNVector3(-2.2, 1.6, -1.4)
        fillNode.look(at: SCNVector3Zero)
        root.addChildNode(fillNode)
    }

    /// Frames the object the way the Workbench does: 45° FOV, 1.7× padding, ¾ view.
    @discardableResult
    static func fitCamera(scene: SCNScene, view: SCNView) -> Bool {
        let root = scene.rootNode
        let (bmin, bmax) = boundsExcludingLights(root)
        let sx = bmax.x - bmin.x
        let sy = bmax.y - bmin.y
        let sz = bmax.z - bmin.z
        if !sx.isFinite || !sy.isFinite || !sz.isFinite { return false }
        if sx <= 0 && sy <= 0 && sz <= 0 { return false }

        let maxDim = max(max(sx, sy), max(sz, 0.05))
        let center = SCNVector3(
            (bmin.x + bmax.x) * 0.5,
            (bmin.y + bmax.y) * 0.5,
            (bmin.z + bmax.z) * 0.5
        )
        let fov = Float(45) * .pi / 180
        let dist = (maxDim / (2 * tan(fov / 2))) * 1.7

        let camera = SCNCamera()
        camera.fieldOfView = 45
        camera.zNear = max(Double(dist / 200), 0.01)
        camera.zFar = max(Double(dist * 80), 50)
        camera.wantsHDR = true

        let camNode = SCNNode()
        camNode.name = "model3d.camera"
        camNode.camera = camera
        camNode.position = SCNVector3(
            center.x + dist * 0.72,
            center.y + dist * 0.55,
            center.z + dist * 0.72
        )
        camNode.look(at: center)
        root.addChildNode(camNode)
        view.pointOfView = camNode
        view.defaultCameraController.target = center
        view.defaultCameraController.minimumVerticalAngle = -0.45 * .pi
        view.defaultCameraController.maximumVerticalAngle = 0.45 * .pi
        return true
    }

    private static func boundsExcludingLights(_ root: SCNNode) -> (SCNVector3, SCNVector3) {
        var minV = SCNVector3(Float.greatestFiniteMagnitude, Float.greatestFiniteMagnitude, Float.greatestFiniteMagnitude)
        var maxV = SCNVector3(-Float.greatestFiniteMagnitude, -Float.greatestFiniteMagnitude, -Float.greatestFiniteMagnitude)
        var found = false
        root.enumerateHierarchy { node, _ in
            if node.light != nil || node.camera != nil { return }
            if node.geometry == nil { return }
            let (lo, hi) = node.boundingBox
            let worldLo = node.convertPosition(lo, to: root)
            let worldHi = node.convertPosition(hi, to: root)
            let xs = [worldLo.x, worldHi.x]
            let ys = [worldLo.y, worldHi.y]
            let zs = [worldLo.z, worldHi.z]
            minV.x = min(minV.x, xs.min() ?? minV.x)
            minV.y = min(minV.y, ys.min() ?? minV.y)
            minV.z = min(minV.z, zs.min() ?? minV.z)
            maxV.x = max(maxV.x, xs.max() ?? maxV.x)
            maxV.y = max(maxV.y, ys.max() ?? maxV.y)
            maxV.z = max(maxV.z, zs.max() ?? maxV.z)
            found = true
        }
        if found { return (minV, maxV) }
        return root.boundingBox
    }
}
