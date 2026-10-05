import AVFoundation
import SwiftUI
import UIKit

// MARK: - Engine (AVCaptureSession on its own queue)

/// Owns the capture session. Every session call runs on `queue`, never on the main thread,
/// so configuring and starting the camera does not block the UI.
final class SnapCameraEngine: NSObject, @unchecked Sendable {
    enum StartResult: Sendable {
        case running
        case failed(String)
    }

    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private let queue = DispatchQueue(label: "homebase.snap.camera")
    private var configured = false
    private let lock = NSLock()
    private var pending: [Int64: (Result<Data, Error>) -> Void] = [:]

    /// The best back camera: a multi-camera device switches to the ultra-wide for close-ups.
    static func backCamera() -> AVCaptureDevice? {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera],
            mediaType: .video,
            position: .back
        ).devices.first
    }

    /// Configures without starting (no camera indicator), so the first open is quicker.
    func prepare() {
        queue.async { [self] in
            _ = configureIfNeeded()
        }
    }

    func start() async -> StartResult {
        await withCheckedContinuation { cont in
            queue.async { [self] in
                if let problem = configureIfNeeded() {
                    cont.resume(returning: .failed(problem))
                    return
                }
                if !session.isRunning {
                    session.startRunning()
                }
                cont.resume(returning: session.isRunning ? .running : .failed("The camera did not start."))
            }
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning {
                session.stopRunning()
            }
        }
    }

    /// Takes one JPEG. `rotationAngle` comes from the rotation coordinator, so a Photo taken
    /// with the phone held sideways is saved the right way up.
    func capture(rotationAngle: CGFloat?) async throws -> Data {
        try await withCheckedThrowingContinuation { cont in
            queue.async { [self] in
                guard session.isRunning else {
                    cont.resume(throwing: SnapCameraError.notRunning)
                    return
                }
                if let angle = rotationAngle,
                   let connection = output.connection(with: .video),
                   connection.isVideoRotationAngleSupported(angle) {
                    connection.videoRotationAngle = angle
                }
                let settings: AVCapturePhotoSettings
                if output.availablePhotoCodecTypes.contains(.jpeg) {
                    settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
                } else {
                    settings = AVCapturePhotoSettings()
                }
                settings.photoQualityPrioritization = .balanced
                lock.lock()
                pending[settings.uniqueID] = { cont.resume(with: $0) }
                lock.unlock()
                output.capturePhoto(with: settings, delegate: self)
            }
        }
    }

    /// Runs on `queue`. Returns a message when the camera cannot be used.
    private func configureIfNeeded() -> String? {
        if configured { return nil }
        guard let device = Self.backCamera() else { return "No camera on this device." }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { return "The camera is busy." }
            session.addInput(input)
        } catch {
            return error.localizedDescription
        }
        guard session.canAddOutput(output) else { return "The camera cannot take Photos." }
        session.addOutput(output)
        output.maxPhotoQualityPrioritization = .balanced
        configured = true
        return nil
    }

    private func finish(_ id: Int64, _ result: Result<Data, Error>) {
        lock.lock()
        let done = pending.removeValue(forKey: id)
        lock.unlock()
        done?(result)
    }
}

extension SnapCameraEngine: AVCapturePhotoCaptureDelegate {
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let id = photo.resolvedSettings.uniqueID
        if let error {
            finish(id, .failure(error))
        } else if let data = photo.fileDataRepresentation() {
            finish(id, .success(data))
        } else {
            finish(id, .failure(SnapCameraError.noData))
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        // Covers a capture that ended without a photo callback.
        finish(resolvedSettings.uniqueID, .failure(error ?? SnapCameraError.noData))
    }
}

enum SnapCameraError: LocalizedError {
    case notRunning, noData

    var errorDescription: String? {
        switch self {
        case .notRunning: return "The camera is not running."
        case .noData: return "The camera returned no Photo."
        }
    }
}

// MARK: - Model (main actor)

/// The camera as SnapView and SnapCameraScreen see it. SnapView owns one, so the session
/// stays configured and running while the Snap tab is open: the second open is instant.
@MainActor
final class SnapCamera: ObservableObject {
    enum State: Equatable {
        case idle, starting, running, noCamera, denied
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    let engine = SnapCameraEngine()
    private var rotation: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?
    private weak var previewLayer: AVCaptureVideoPreviewLayer?
    private var idleStop: Task<Void, Never>?

    /// Stop a camera nobody looked at for this long (battery); restarting is fast.
    private static let idleSeconds: UInt64 = 120

    deinit {
        idleStop?.cancel()
        engine.stop()
    }

    var hasCamera: Bool { SnapCameraEngine.backCamera() != nil }

    /// Configure ahead of the first open when access was already given. Never asks.
    func prepare() {
        guard hasCamera, AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return }
        engine.prepare()
    }

    func start() async {
        idleStop?.cancel()
        guard hasCamera else {
            state = .noCamera
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            break
        case .notDetermined:
            state = .starting
            guard await AVCaptureDevice.requestAccess(for: .video) else {
                state = .denied
                return
            }
        default:
            state = .denied
            return
        }
        if state != .running { state = .starting }
        switch await engine.start() {
        case .running: state = .running
        case .failed(let message): state = .failed(message)
        }
    }

    /// The camera screen closed: keep running for a while so the next open is instant.
    func stopSoon() {
        idleStop?.cancel()
        idleStop = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.idleSeconds * 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.stop()
        }
    }

    /// Stop now (another screen needs the camera, e.g. the LiDAR scan).
    func stop() {
        idleStop?.cancel()
        idleStop = nil
        engine.stop()
        if state == .running || state == .starting { state = .idle }
    }

    /// Hooks a preview layer to the session and keeps it level.
    func attach(_ layer: AVCaptureVideoPreviewLayer) {
        layer.session = engine.session
        layer.videoGravity = .resizeAspectFill
        rotationObservation = nil
        rotation = nil
        guard let device = SnapCameraEngine.backCamera() else { return }
        let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: layer)
        rotation = coordinator
        previewLayer = layer
        rotationObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .new]) { [weak self] c, _ in
            let angle = c.videoRotationAngleForHorizonLevelPreview
            Task { @MainActor [weak self] in self?.levelPreview(angle) }
        }
    }

    private func levelPreview(_ angle: CGFloat) {
        if let connection = previewLayer?.connection, connection.isVideoRotationAngleSupported(angle) {
            connection.videoRotationAngle = angle
        }
    }

    func capture() async throws -> Data {
        try await engine.capture(rotationAngle: rotation?.videoRotationAngleForHorizonLevelCapture)
    }
}

// MARK: - Preview

final class CameraPreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

struct CameraPreview: UIViewRepresentable {
    let camera: SnapCamera

    func makeUIView(context: Context) -> CameraPreviewView {
        let view = CameraPreviewView()
        view.backgroundColor = .black
        camera.attach(view.previewLayer)
        return view
    }

    func updateUIView(_ uiView: CameraPreviewView, context: Context) {}
}

// MARK: - Screen

/// Stay-open camera for Snap: take a Photo, then Delete, Keep, or Keep and take another.
/// Uploads run in the background through the shared `SnapUploader`.
struct SnapCameraScreen: View {
    @EnvironmentObject private var session: FlowSession
    @ObservedObject var camera: SnapCamera
    @ObservedObject var uploader: SnapUploader
    var onClose: () -> Void

    private struct Shot {
        let jpeg: Data
        let preview: UIImage
    }

    @State private var shot: Shot?
    @State private var capturing = false
    @State private var flash = false
    @State private var captureError: String?

    private var placeLabel: String {
        session.here.hasRoom ? FlowLogic.placeLabel(session.here, houses: session.houses) : "No Place set"
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            content

            if let shot {
                Color.clear
                    .overlay(
                        Image(uiImage: shot.preview)
                            .resizable()
                            .scaledToFill()
                    )
                    .clipped()
                    .ignoresSafeArea()
            }

            Color.white
                .opacity(flash ? 0.7 : 0)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            VStack(spacing: 12) {
                topBar
                Spacer()
                errors
                if shot != nil {
                    decisionBar
                } else {
                    shutterBar
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .statusBarHidden()
        .task { await camera.start() }
        .onDisappear { camera.stopSoon() }
    }

    @ViewBuilder
    private var content: some View {
        switch camera.state {
        case .running:
            CameraPreview(camera: camera)
                .ignoresSafeArea()
        case .idle, .starting:
            ProgressView().tint(FlowTheme.cream)
        case .noCamera:
            note(
                title: "No camera on this device",
                caption: "Pick a Photo from this device on the Snap screen instead."
            )
        case .denied:
            note(
                title: "Flow may not use the camera",
                caption: "Allow Camera for Flow in Settings to take Photos of your Things.",
                showSettings: true
            )
        case .failed(let message):
            note(title: "The camera did not start", caption: message)
        }
    }

    private func note(title: String, caption: String, showSettings: Bool = false) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "camera")
                .font(.system(size: 32))
                .foregroundStyle(FlowTheme.mutedText)
            Text(title)
                .font(.system(size: 17, weight: .semibold, design: .rounded))
                .foregroundStyle(FlowTheme.cream)
            Text(caption)
                .font(.system(size: 13))
                .foregroundStyle(FlowTheme.mutedText)
                .multilineTextAlignment(.center)
            if showSettings, let url = URL(string: UIApplication.openSettingsURLString) {
                Link("Open Settings", destination: url)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .foregroundStyle(FlowTheme.ink)
                    .background(FlowTheme.lime, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
        .padding(.horizontal, 32)
    }

    private var topBar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "mappin")
                    .foregroundStyle(FlowTheme.lime)
                Text(placeLabel)
                    .lineLimit(1)
                    .foregroundStyle(session.here.hasRoom ? FlowTheme.cream : FlowTheme.mutedText)
            }
            .font(.system(size: 13, weight: .medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.black.opacity(0.5), in: Capsule())

            Spacer(minLength: 8)

            Button(action: onClose) {
                Text("Close")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(FlowTheme.cream)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color.black.opacity(0.5), in: Capsule())
            }
            .accessibilityLabel("Close the camera")
        }
    }

    @ViewBuilder
    private var errors: some View {
        if let captureError {
            ErrorLine(message: captureError)
        }
        if let summary = uploader.failedSummary {
            HStack(spacing: 8) {
                ErrorLine(message: [summary, uploader.error].compactMap { $0 }.joined(separator: " "))
                Button("Retry") {
                    Task { await uploader.retryFailed(session: session) }
                }
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .foregroundStyle(FlowTheme.ink)
                .background(FlowTheme.lime, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .disabled(uploader.busy > 0)
            }
        }
    }

    private var shutterBar: some View {
        HStack(alignment: .center) {
            VStack(spacing: 4) {
                Group {
                    if let thumb = uploader.lastKept {
                        Image(uiImage: thumb)
                            .resizable()
                            .scaledToFill()
                    } else {
                        Color.white.opacity(0.12)
                    }
                }
                .frame(width: 52, height: 52)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.white.opacity(0.6)))
                Text("\(uploader.savedCount) saved")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(FlowTheme.lime)
            }
            .frame(width: 80)

            Spacer()

            Button(action: takePhoto) {
                ZStack {
                    Circle()
                        .strokeBorder(Color.white, lineWidth: 5)
                        .frame(width: 82, height: 82)
                    Circle()
                        .fill(capturing ? FlowTheme.mutedText : Color.white)
                        .frame(width: 66, height: 66)
                }
            }
            .disabled(capturing || camera.state != .running)
            .opacity(camera.state == .running ? 1 : 0.35)
            .accessibilityLabel("Take a Photo")

            Spacer()

            VStack(spacing: 4) {
                if uploader.busy > 0 {
                    ProgressView().tint(FlowTheme.cream)
                    Text("Uploading \(uploader.busy)")
                        .font(.system(size: 11))
                        .foregroundStyle(FlowTheme.cream)
                }
            }
            .frame(width: 80)
        }
        .padding(.bottom, 8)
    }

    private var decisionBar: some View {
        HStack(spacing: 10) {
            decisionButton("Delete", systemImage: "trash", fg: FlowTheme.cream, bg: FlowTheme.toss) {
                shot = nil
            }
            decisionButton("Keep", systemImage: "checkmark", fg: FlowTheme.ink, bg: FlowTheme.cream) {
                keep(another: false)
            }
            decisionButton("Keep, another", systemImage: "camera.fill", fg: FlowTheme.ink, bg: FlowTheme.lime) {
                keep(another: true)
            }
        }
        .padding(.bottom, 8)
    }

    private func decisionButton(_ title: String, systemImage: String, fg: Color, bg: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.system(size: 18, weight: .semibold))
                Text(title)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .foregroundStyle(fg)
            .background(bg, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func takePhoto() {
        guard !capturing, shot == nil, camera.state == .running else { return }
        capturing = true
        captureError = nil
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        flash = true
        withAnimation(.easeOut(duration: 0.25)) { flash = false }
        Task {
            defer { capturing = false }
            do {
                let jpeg = try await camera.capture()
                guard let preview = await Self.previewImage(jpeg) else {
                    captureError = "Could not read that Photo."
                    return
                }
                shot = Shot(jpeg: jpeg, preview: preview)
            } catch {
                captureError = error.localizedDescription
            }
        }
    }

    private func keep(another: Bool) {
        guard let shot else { return }
        self.shot = nil
        uploader.lastKept = shot.preview
        let place = session.here
        Task { await uploader.upload(jpeg: shot.jpeg, place: place, session: session) }
        if !another {
            onClose()
        }
    }

    /// A screen-sized copy for the frozen view and the thumbnail; decoded off the main thread.
    private static func previewImage(_ jpeg: Data) async -> UIImage? {
        guard let image = UIImage(data: jpeg) else { return nil }
        let longest: CGFloat = 1600
        let size = image.size
        guard size.width > 0, size.height > 0 else { return image }
        let scale = min(1, longest / max(size.width, size.height))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        return await image.byPreparingThumbnail(ofSize: target) ?? image
    }
}
