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

    /// Stops without waiting (deinit).
    func stopNow() {
        queue.async { [self] in
            if session.isRunning {
                session.stopRunning()
            }
        }
    }

    /// Returns once the session has stopped, so another screen can take the camera.
    func stop() async {
        await withCheckedContinuation { cont in
            queue.async { [self] in
                if session.isRunning {
                    session.stopRunning()
                }
                cont.resume()
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
        if let problem = addInputAndOutput(device) {
            // Leave a clean session behind so the next open can try again.
            session.inputs.forEach { session.removeInput($0) }
            session.outputs.forEach { session.removeOutput($0) }
            return problem
        }
        configured = true
        return nil
    }

    /// Runs on `queue` inside begin/commitConfiguration.
    private func addInputAndOutput(_ device: AVCaptureDevice) -> String? {
        session.sessionPreset = .photo
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { return "The camera is busy." }
            session.addInput(input)
        } catch {
            return error.localizedDescription
        }
        // A multi-camera device starts at its widest lens (zoom 1 = ultra-wide). Open at the
        // main lens like the Camera app; the device still switches to ultra-wide for close-ups.
        if device.isVirtualDevice {
            do {
                try device.lockForConfiguration()
                device.videoZoomFactor = device.virtualDeviceSwitchOverVideoZoomFactors.first.map { CGFloat(truncating: $0) } ?? 1
                device.unlockForConfiguration()
            } catch {
                // Keep the default zoom.
            }
        }
        guard session.canAddOutput(output) else { return "The camera cannot take Photos." }
        session.addOutput(output)
        output.maxPhotoQualityPrioritization = .balanced
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
/// stays configured while the Snap tab is open and a reopen soon after a close is instant.
@MainActor
final class SnapCamera: ObservableObject {
    enum State: Equatable {
        case idle, starting, running, noCamera, denied
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    let engine = SnapCameraEngine()
    /// True while the camera screen is on screen; an interruption that ends then restarts it.
    var visible = false
    private var rotation: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?
    private weak var previewLayer: AVCaptureVideoPreviewLayer?
    private var idleStop: Task<Void, Never>?
    private var starting: Task<Void, Never>?
    /// Bumped by every stop, so a start that finishes after a stop does not report running.
    private var generation = 0
    private var observers: [NSObjectProtocol] = []

    /// Keep running this long after the screen closes (battery); restarting is fast.
    private static let idleSeconds: UInt64 = 10

    init() {
        let center = NotificationCenter.default
        // A runtime error (e.g. a media services reset) stopped the session: restart it if on screen.
        observers.append(center.addObserver(forName: .AVCaptureSessionRuntimeError, object: engine.session, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.lost()
                self?.resumeIfVisible()
            }
        })
        // An interruption: wait for it to end.
        observers.append(center.addObserver(forName: .AVCaptureSessionWasInterrupted, object: engine.session, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.lost() }
        })
        observers.append(center.addObserver(forName: .AVCaptureSessionInterruptionEnded, object: engine.session, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.resumeIfVisible() }
        })
    }

    deinit {
        idleStop?.cancel()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        engine.stopNow()
    }

    var hasCamera: Bool { SnapCameraEngine.backCamera() != nil }

    /// Configure ahead of the first open when access was already given. Never asks.
    func prepare() {
        guard hasCamera, AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return }
        engine.prepare()
    }

    /// Starts the session; a second call while one is under way waits for the first.
    func start() async {
        idleStop?.cancel()
        idleStop = nil
        // Wait for a start under way; if a stop landed during it, start again.
        var seen: Task<Void, Never>?
        while let current = starting, current != seen {
            await current.value
            if state == .running { return }
            seen = current
        }
        let task = Task { await run() }
        starting = task
        await task.value
        if starting == task { starting = nil }
    }

    private func run() async {
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
        let gen = generation
        let result = await engine.start()
        guard gen == generation else {
            // Stopped while starting: leave it stopped.
            await engine.stop()
            return
        }
        switch result {
        case .running: state = .running
        case .failed(let message): state = .failed(message)
        }
    }

    /// The camera screen closed: keep running briefly so a quick reopen is instant.
    func stopSoon() {
        idleStop?.cancel()
        idleStop = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.idleSeconds * 1_000_000_000)
            guard !Task.isCancelled else { return }
            await self?.stop()
        }
    }

    /// Stops now and returns once the session is down (e.g. before the LiDAR scan).
    func stop() async {
        idleStop?.cancel()
        idleStop = nil
        generation += 1
        if state == .running || state == .starting { state = .idle }
        await engine.stop()
    }

    /// A runtime error or an interruption stopped the session; the next open restarts it.
    private func lost() {
        if state == .running || state == .starting { state = .idle }
    }

    private func resumeIfVisible() {
        guard visible else { return }
        Task { await start() }
    }

    /// Hooks a preview layer to the session and keeps it level.
    func attach(_ layer: AVCaptureVideoPreviewLayer) {
        layer.session = engine.session
        layer.videoGravity = .resizeAspect
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

/// Stay-open camera for Snap: take a Photo, then Delete, Save, or Save and take another.
/// Uploads run in the background through the shared `SnapUploader`.
/// Preview and review use the same 3:4 frame as the saved Photo, so what you see is what is saved.
struct SnapCameraScreen: View {
    @EnvironmentObject private var session: FlowSession
    @EnvironmentObject private var uploader: SnapUploader
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var camera: SnapCamera
    /// "Take a Photo of it": each saved Photo is also attached to this Thing.
    var forItem: FlowItem? = nil
    var onClose: () -> Void

    private struct Shot {
        let jpeg: Data
        let preview: UIImage
    }

    @State private var shot: Shot?
    @State private var capturing = false
    @State private var flash = false
    @State private var captureError: String?
    /// Photos saved on this screen of `forItem`.
    @State private var savedOfItem = 0

    /// The Place the Photo is filed under: the Thing's own Place when it is for a Thing.
    private var shotPlace: Place {
        if let forItem, let roomId = forItem.roomId {
            if let r = session.rooms.first(where: { $0.id == roomId }) { return Place(room: r) }
            return Place(roomId: roomId, houseId: forItem.roomRef?.houseId ?? forItem.houseId, floor: forItem.floor ?? "", room: forItem.room ?? "")
        }
        return session.here
    }

    private var placeLabel: String {
        if let forItem { return "Photo of \(forItem.name)" }
        return session.here.hasRoom ? FlowLogic.placeLabel(session.here, houses: session.houses) : "No Place set"
    }

    private var savedLabel: String {
        let n = forItem == nil ? uploader.savedCount : savedOfItem
        return n == 1 ? "1 Photo saved" : "\(n) Photos saved"
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 12) {
                topBar
                    .padding(.horizontal, 16)
                Spacer(minLength: 0)
                frame
                Spacer(minLength: 0)
                Group {
                    if shot != nil {
                        decisionBar
                    } else {
                        shutterBar
                    }
                }
                .padding(.horizontal, 16)
            }
            .padding(.vertical, 12)
        }
        .statusBarHidden()
        .task { await camera.start() }
        .onAppear { camera.visible = true }
        .onDisappear {
            camera.visible = false
            camera.stopSoon()
        }
        .onChange(of: scenePhase) { _, phase in
            Task {
                if phase == .active {
                    await camera.start()
                } else {
                    await camera.stop()
                }
            }
        }
    }

    /// Live preview or the frozen Photo, both letterboxed in a 3:4 frame.
    private var frame: some View {
        Color.black
            .aspectRatio(3.0 / 4.0, contentMode: .fit)
            .overlay { content }
            .overlay {
                if let shot {
                    ZStack {
                        Color.black
                        Image(uiImage: shot.preview)
                            .resizable()
                            .scaledToFit()
                    }
                }
            }
            .overlay {
                Color.white
                    .opacity(flash ? 0.7 : 0)
                    .allowsHitTesting(false)
            }
            .overlay(alignment: .bottom) {
                errors
                    .padding(12)
            }
            .clipped()
    }

    @ViewBuilder
    private var content: some View {
        switch camera.state {
        case .running:
            CameraPreview(camera: camera)
        case .starting:
            ProgressView().tint(FlowTheme.cream)
        case .idle:
            VStack(spacing: 10) {
                Text("The camera is paused")
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(FlowTheme.cream)
                Button("Try again") {
                    Task { await camera.start() }
                }
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .foregroundStyle(FlowTheme.ink)
                .background(FlowTheme.lime, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
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
                Image(systemName: forItem == nil ? "mappin" : "camera.viewfinder")
                    .foregroundStyle(FlowTheme.lime)
                Text(placeLabel)
                    .lineLimit(1)
                    .foregroundStyle(forItem != nil || session.here.hasRoom ? FlowTheme.cream : FlowTheme.mutedText)
            }
            .font(.system(size: 13, weight: .medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.white.opacity(0.12), in: Capsule())

            Spacer(minLength: 8)

            Button(action: onClose) {
                Text("Close")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(FlowTheme.cream)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.12), in: Capsule())
            }
            .accessibilityLabel("Close the camera")
        }
    }

    @ViewBuilder
    private var errors: some View {
        VStack(spacing: 6) {
            if let captureError {
                ErrorLine(message: captureError)
            }
            // An attach that failed after the upload worked: not in the retry queue, so say it here.
            if forItem != nil, uploader.failedSummary == nil, let err = uploader.error {
                ErrorLine(message: err)
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
                Text(savedLabel)
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(FlowTheme.lime)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(width: 96)

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
            .frame(width: 96)
        }
        .padding(.bottom, 8)
    }

    private var decisionBar: some View {
        HStack(spacing: 10) {
            decisionButton("Delete", systemImage: "trash", fg: FlowTheme.cream, bg: FlowTheme.toss) {
                shot = nil
            }
            decisionButton("Save", systemImage: "checkmark", fg: FlowTheme.ink, bg: FlowTheme.cream) {
                save(another: false)
            }
            decisionButton("Save, another", systemImage: "camera.fill", fg: FlowTheme.ink, bg: FlowTheme.lime) {
                save(another: true)
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

    private func save(another: Bool) {
        guard let shot else { return }
        self.shot = nil
        uploader.lastKept = shot.preview
        let place = shotPlace
        let target = forItem.map { SnapUploader.PhotoTarget(id: $0.id, name: $0.name, roomId: $0.roomId) }
        if target != nil { savedOfItem += 1 }
        Task { await uploader.upload(jpeg: shot.jpeg, place: place, session: session, forItem: target) }
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
