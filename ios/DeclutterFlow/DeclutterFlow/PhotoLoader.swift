import SwiftUI
import UIKit

@MainActor
final class PhotoCache: ObservableObject {
    static let shared = PhotoCache()
    private let memory = NSCache<NSString, UIImage>()

    func image(for key: String) -> UIImage? {
        memory.object(forKey: key as NSString)
    }

    func store(_ image: UIImage, for key: String) {
        memory.setObject(image, forKey: key as NSString)
    }

    func clear() {
        memory.removeAllObjects()
    }
}

/// Loads a Photo by storage key, from the memory cache when it is there.
@MainActor
enum PhotoLoading {
    static func load(_ storageKey: String, api: HomeBaseAPI) async -> UIImage? {
        if let cached = PhotoCache.shared.image(for: storageKey) { return cached }
        do {
            let result = try await api.photosURL(key: storageKey)
            guard let rel = result.url, let url = await api.resolvePhotoURL(rel) else { return nil }
            let data = try await api.download(url)
            guard let ui = UIImage(data: data) else { return nil }
            PhotoCache.shared.store(ui, for: storageKey)
            return ui
        } catch {
            return nil
        }
    }

    /// Loads an image by the URL the server handed out (e.g. `photos.sourcePhoto`), cached
    /// by that URL.
    static func load(url relativeOrAbsolute: String, api: HomeBaseAPI) async -> UIImage? {
        let cacheKey = "url:" + relativeOrAbsolute
        if let cached = PhotoCache.shared.image(for: cacheKey) { return cached }
        do {
            guard let url = await api.resolvePhotoURL(relativeOrAbsolute) else { return nil }
            let data = try await api.download(url)
            guard let ui = UIImage(data: data) else { return nil }
            PhotoCache.shared.store(ui, for: cacheKey)
            return ui
        } catch {
            return nil
        }
    }
}

/// Opens the loaded image in `PhotoViewer` on a tap. Left off where a tap already means
/// something else (a row that opens a Thing, a strip that picks a Photo).
private struct OpensViewer: ViewModifier {
    let image: UIImage?
    let enabled: Bool
    /// Shows "Crop" in the viewer; called once the viewer has closed.
    var onCrop: (() -> Void)? = nil
    @State private var open = false
    @State private var cropAfterClose = false

    func body(content: Content) -> some View {
        if enabled {
            content
                .contentShape(Rectangle())
                .onTapGesture { if image != nil { open = true } }
                .fullScreenCover(isPresented: $open, onDismiss: {
                    // A full-screen cover can only open once this one is gone.
                    if cropAfterClose {
                        cropAfterClose = false
                        onCrop?()
                    }
                }) {
                    if let image {
                        PhotoViewer(
                            image: image,
                            onClose: { open = false },
                            onCrop: onCrop.map { _ in { cropAfterClose = true; open = false } }
                        )
                    }
                }
        } else {
            content
        }
    }
}

struct RemotePhoto: View {
    let storageKey: String?
    var api: HomeBaseAPI?
    var cornerRadius: CGFloat = 12
    /// Tap opens the full-screen viewer.
    var zoomable: Bool = true
    /// Set when this is one of a Thing's Photos: the viewer then offers "Crop".
    var onCrop: (() -> Void)? = nil

    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            HatchBackground()
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if storageKey == nil {
                Image(systemName: "photo")
                    .font(.title2)
                    .foregroundStyle(FlowTheme.muted)
            } else if failed {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(FlowTheme.muted)
            } else {
                ProgressView()
                    .tint(FlowTheme.moss)
            }
        }
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .modifier(OpensViewer(image: image, enabled: zoomable, onCrop: onCrop))
        .task(id: storageKey) { await load() }
    }

    private func load() async {
        guard let storageKey, let api else { return }
        failed = false
        if let ui = await PhotoLoading.load(storageKey, api: api) {
            image = ui
        } else {
            failed = true
        }
    }
}

/// A Photo shown whole (aspect-fit) inside a box of `aspect`, with `overlay` laid over exactly
/// the image's own rectangle, so percent coordinates on the image line up at any size.
/// Tapping the image (outside anything the overlay handles) opens the viewer.
struct FittedRemotePhoto<Overlay: View>: View {
    let storageKey: String?
    var api: HomeBaseAPI?
    var aspect: CGFloat = 4 / 3
    var cornerRadius: CGFloat = 12
    @ViewBuilder var overlay: (CGSize) -> Overlay

    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            HatchBackground()
            if let image, image.size.width > 0, image.size.height > 0 {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(image.size.width / image.size.height, contentMode: .fit)
                    .modifier(OpensViewer(image: image, enabled: true))
                    .overlay {
                        GeometryReader { geo in overlay(geo.size) }
                    }
            } else if storageKey == nil {
                Image(systemName: "photo").font(.title2).foregroundStyle(FlowTheme.muted)
            } else if failed {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(FlowTheme.muted)
            } else {
                ProgressView().tint(FlowTheme.moss)
            }
        }
        .aspectRatio(aspect, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .task(id: storageKey) {
            guard let storageKey, let api else { return }
            failed = false
            if let ui = await PhotoLoading.load(storageKey, api: api) {
                image = ui
            } else {
                failed = true
            }
        }
    }
}

struct HatchBackground: View {
    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(FlowTheme.hatchA))
            var path = Path()
            let step: CGFloat = 9
            var x = -size.height
            while x < size.width + size.height {
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x + size.height, y: size.height))
                x += step
            }
            context.stroke(path, with: .color(FlowTheme.hatchB), lineWidth: 1)
        }
    }
}
