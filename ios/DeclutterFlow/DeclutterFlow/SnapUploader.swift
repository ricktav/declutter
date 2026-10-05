import SwiftUI
import UIKit

/// Uploads Snap Photos to the inbox. Shared by `SnapView` and `SnapCameraScreen`, so the
/// "saved" counter, the busy spinner and upload errors are the same on both screens.
/// ContentView owns it, above the tab switch, so a failed Photo survives a tab change.
@MainActor
final class SnapUploader: ObservableObject {
    /// A Photo that did not upload; it stays here so it can be retried.
    struct Failed: Identifiable {
        let id = UUID()
        let jpeg: Data
        let place: Place
    }

    @Published private(set) var busy = 0
    /// Photos saved (camera and library); notes are counted by SnapView.
    @Published private(set) var savedCount = 0
    @Published var error: String?
    @Published private(set) var failed: [Failed] = []
    /// Small preview of the last Photo saved in the camera.
    @Published var lastKept: UIImage?

    /// Library path: encode a picked image, then upload it.
    func upload(image: UIImage, session: FlowSession) async {
        guard let jpeg = PhotoJPEG.encode(image) else {
            error = "Could not encode that Photo."
            return
        }
        await upload(jpeg: jpeg, place: session.here, session: session)
    }

    /// Uploads one JPEG and files it in the inbox. `place` is the Place at the moment the
    /// Photo was taken. On failure the Photo goes to `failed` for a retry.
    @discardableResult
    func upload(jpeg: Data, place: Place, session: FlowSession) async -> Bool {
        guard let api = session.api else {
            error = "Set a server address in Settings."
            failed.append(Failed(jpeg: jpeg, place: place))
            return false
        }
        busy += 1
        error = nil
        var ok = false
        do {
            let up = try await api.uploadInboxPhoto(jpeg: jpeg, fileName: PhotoJPEG.fileName())
            let kind: CaptureKind = up.mimeType.hasPrefix("image/") ? .image : .file
            let row = try await api.inboxCreate(
                kind: kind,
                storageKey: up.key,
                fileName: up.fileName,
                mimeType: up.mimeType
            )
            if place.hasRoom {
                SnapPlaceStore.set(row.id, place: place)
            }
            savedCount += 1
            ok = true
        } catch {
            self.error = error.localizedDescription
            failed.append(Failed(jpeg: jpeg, place: place))
        }
        busy -= 1
        // Serial snaps: reload the lists once the last upload of a burst is done.
        if busy == 0 {
            await session.refresh()
        }
        return ok
    }

    /// Uploads every failed Photo again; the ones that fail again go back in the queue.
    func retryFailed(session: FlowSession) async {
        let queue = failed
        failed = []
        for f in queue {
            await upload(jpeg: f.jpeg, place: f.place, session: session)
        }
    }

    var failedSummary: String? {
        guard !failed.isEmpty else { return nil }
        let n = failed.count
        return n == 1 ? "1 Photo did not upload." : "\(n) Photos did not upload."
    }
}

enum PhotoJPEG {
    static func encode(_ image: UIImage, quality: CGFloat = 0.85) -> Data? {
        image.jpegData(compressionQuality: quality)
    }

    static func fileName() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss-SSS"
        return "snap-\(f.string(from: Date())).jpg"
    }
}
