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

struct RemotePhoto: View {
    let storageKey: String?
    var api: HomeBaseAPI?
    var cornerRadius: CGFloat = 12

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
        .task(id: storageKey) { await load() }
    }

    private func load() async {
        guard let storageKey, let api else { return }
        if let cached = PhotoCache.shared.image(for: storageKey) {
            image = cached
            return
        }
        do {
            let result = try await api.attachmentsURL(key: storageKey)
            guard let rel = result.url, let url = await api.resolvePhotoURL(rel) else {
                failed = true
                return
            }
            let data = try await api.download(url)
            if let ui = UIImage(data: data) {
                PhotoCache.shared.store(ui, for: storageKey)
                image = ui
            } else {
                failed = true
            }
        } catch {
            failed = true
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
