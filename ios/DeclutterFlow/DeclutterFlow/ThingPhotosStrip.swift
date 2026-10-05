import SwiftUI
import UIKit

/// One Photo in a Thing's strip: one of its own (the cover first), or a scene Photo the
/// Thing is pinned in.
private struct StripPhoto: Identifiable, Hashable {
    let photo: ItemPhoto
    let isCover: Bool
    /// A Photo of the scene (not the Thing's own) where a pin marks the Thing.
    let isScene: Bool
    /// The pin's frame on a scene Photo.
    let pinBox: PhotoBox?
    var id: Int { photo.id }
}

private enum CropError: LocalizedError {
    case notCropped
    var errorDescription: String? { "Could not crop this Photo." }
}

/// What the crop screen opens with, and how its frame is saved.
private struct CropJob: Identifiable {
    let id = UUID()
    let source: PhotoCropSource
    let initialBox: PhotoBox?
    let save: (PhotoBox) async throws -> Void
}

/// "Photos" on a Thing sheet: the Thing's Photos and the scene Photos it is pinned in, with
/// Crop on the selected one. Cropping a cutout crops it again from its original; cropping a
/// whole Photo gives the Thing a cutout of it. `cropCoverRequest` changing opens Crop on the
/// cover (the zoom viewer of the sheet's big Photo asks for that).
struct ThingPhotosStrip: View {
    @EnvironmentObject private var session: FlowSession
    let itemId: Int
    let itemName: String
    /// The Thing's cover (`items.listAll` imageKey): shown first and marked.
    let coverKey: String?
    var cropCoverRequest: Int = 0
    /// After a save: refresh the session (and a plan).
    var onSaved: () async -> Void

    @State private var photos: [ItemPhoto] = []
    @State private var pins: [ItemPin] = []
    @State private var loaded = false
    @State private var selectedId: Int?
    @State private var preparing = false
    @State private var error: String?
    @State private var job: CropJob?
    @State private var viewing: UIImage?
    @State private var cropAfterViewer = false

    private var entries: [StripPhoto] {
        let own = photos.map { StripPhoto(photo: $0, isCover: $0.storageKey == coverKey, isScene: false, pinBox: nil) }
        let ordered = own.filter(\.isCover) + own.filter { !$0.isCover }
        let ownIds = Set(photos.map(\.id))
        var seen = Set<Int>()
        // Only pins someone confirmed: an unchecked suggestion may mark the wrong thing.
        let scenes: [StripPhoto] = pins.filter { $0.status == "confirmed" }.compactMap { pin in
            guard let p = pin.photo, !ownIds.contains(p.id), seen.insert(p.id).inserted else { return nil }
            return StripPhoto(photo: p, isCover: false, isScene: true, pinBox: pin.box)
        }
        return ordered + scenes
    }

    private var selected: StripPhoto? {
        entries.first(where: { $0.id == selectedId }) ?? entries.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Photos")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(FlowTheme.muted)
                    .textCase(.uppercase)
                Spacer()
                if let selected {
                    Button {
                        Task { await startCrop(selected) }
                    } label: {
                        if preparing {
                            ProgressView().tint(FlowTheme.ink).frame(width: 52)
                        } else {
                            Label("Crop", systemImage: "crop")
                        }
                    }
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .foregroundStyle(FlowTheme.ink)
                    .background(FlowTheme.lime, in: Capsule())
                    .disabled(preparing || !canCrop(selected))
                    .opacity(canCrop(selected) ? 1 : 0.45)
                    .accessibilityLabel("Crop the selected Photo")
                }
            }
            if entries.isEmpty {
                Text(loaded ? "No Photos of this Thing yet" : "Loading Photos…")
                    .font(.system(size: 12))
                    .foregroundStyle(FlowTheme.muted)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(entries) { e in
                            thumb(e)
                        }
                    }
                    .padding(.vertical, 2)
                }
                if let selected {
                    Text(caption(selected))
                        .font(.system(size: 12))
                        .foregroundStyle(FlowTheme.muted)
                }
            }
            ErrorLine(message: error)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))
        .task(id: itemId) { await load() }
        .onChange(of: cropCoverRequest) { _, _ in
            Task {
                // Asked from the cover's viewer before the strip has loaded: load first.
                if !loaded { await load() }
                guard let cover = entries.first(where: \.isCover) ?? entries.first(where: { !$0.isScene }) else {
                    error = "Could not crop this Photo: its Photos did not load."
                    return
                }
                selectedId = cover.id
                await startCrop(cover)
            }
        }
        .fullScreenCover(item: $job) { job in
            PhotoCropScreen(
                title: itemName,
                source: job.source,
                initialBox: job.initialBox,
                api: session.api,
                onCancel: { self.job = nil },
                onSave: { box in
                    try await job.save(box)
                    self.job = nil
                    await load()
                    await onSaved()
                }
            )
        }
        .background {
            // The viewer sits on its own view: one view takes one full-screen cover at a time.
            Color.clear
                .fullScreenCover(isPresented: Binding(get: { viewing != nil }, set: { if !$0 { viewing = nil } }), onDismiss: {
                    if cropAfterViewer, let selected {
                        cropAfterViewer = false
                        Task { await startCrop(selected) }
                    }
                }) {
                    if let viewing {
                        PhotoViewer(image: viewing, onClose: { self.viewing = nil }, onCrop: {
                            cropAfterViewer = true
                            self.viewing = nil
                        })
                    }
                }
        }
    }

    private func thumb(_ e: StripPhoto) -> some View {
        let isSelected = e.id == selected?.id
        return Button {
            if isSelected {
                Task { await openViewer(e) }
            } else {
                selectedId = e.id
            }
        } label: {
            RemotePhoto(storageKey: e.photo.storageKey, api: session.api, cornerRadius: 8, zoomable: false)
                .frame(width: 64, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(alignment: .bottomLeading) {
                    if e.isCover || e.isScene {
                        Text(e.isCover ? "Cover" : "Place")
                            .font(.system(size: 9, weight: .semibold, design: .rounded))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .foregroundStyle(FlowTheme.cream)
                            .background(FlowTheme.ink.opacity(0.8), in: Capsule())
                            .padding(3)
                    }
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(isSelected ? FlowTheme.ink : Color.clear, lineWidth: 2)
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(e.isCover ? "Cover Photo" : e.isScene ? "Photo of the Place" : "Photo") \(e.photo.id)")
    }

    private func caption(_ e: StripPhoto) -> String {
        if e.isScene { return "Photo of the Place · Crop cuts this Thing out of it" }
        if e.photo.isCutout, e.photo.sourceCaptureId != nil { return "Cropped Photo · Crop frames it again from the full Photo" }
        if e.photo.isCutout { return "Cropped from a Photo that is no longer available" }
        return "Full Photo · Crop gives the Thing a cropped Photo · tap again to zoom"
    }

    /// A cropped Photo with no full Photo behind it cannot be framed again, and cropping the
    /// crop would pile up smaller copies.
    private func canCrop(_ e: StripPhoto) -> Bool {
        e.isScene || !e.photo.isCutout || e.photo.sourceCaptureId != nil
    }

    private func load() async {
        guard let api = session.api else { return }
        do {
            photos = try await api.photosListForItem(itemId: itemId)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        // Scene Photos are extra: the strip works without them.
        pins = (try? await api.pinsListForItem(itemId: itemId)) ?? []
        loaded = true
        if let id = selectedId, !entries.contains(where: { $0.id == id }) { selectedId = nil }
    }

    private func openViewer(_ e: StripPhoto) async {
        guard let api = session.api else { return }
        if let ui = await PhotoLoading.load(e.photo.storageKey, api: api) { viewing = ui }
    }

    /// Picks the image and the save for a Photo:
    /// - a cutout with its original: crop the original again (`photos.recrop`), frame prefilled;
    /// - anything else: crop a cutout out of it (`photos.createCutout`). When the Thing already
    ///   has a cutout of the same original, that one is cropped again instead (the server keeps
    ///   one cutout per Thing and original).
    private func startCrop(_ e: StripPhoto) async {
        guard let api = session.api else {
            error = "Could not crop this Photo: no server."
            return
        }
        guard canCrop(e) else {
            error = "This Photo was cropped from a Photo that is no longer available."
            return
        }
        preparing = true
        error = nil
        defer { preparing = false }
        let p = e.photo
        var original: SourcePhotoResult?
        if p.sourceCaptureId != nil {
            do {
                original = try await api.photosSourcePhoto(photoId: p.id)
            } catch {
                self.error = error.localizedDescription
                return
            }
            // The server crops from the original; with that gone it cannot crop this Photo.
            guard original?.available == true, original?.url != nil else {
                self.error = "The full Photo is no longer available, so this Photo cannot be cropped."
                return
            }
        }
        let source: PhotoCropSource = original?.url.map { .url($0) } ?? .key(p.storageKey)
        let itemId = itemId
        let ownCutout: ItemPhoto? = p.sourceCaptureId.flatMap { cap in
            photos.first(where: { $0.sourceCaptureId == cap && $0.isCutout })
        }
        let knownCutoutIds = Set(photos.filter(\.isCutout).map(\.id))

        if !e.isScene, p.isCutout, original != nil {
            job = CropJob(source: source, initialBox: original?.cropBox ?? p.cropBox) { box in
                _ = try await api.photosRecrop(photoId: p.id, box: box)
            }
        } else if let cut = ownCutout {
            job = CropJob(source: source, initialBox: cut.cropBox ?? e.pinBox) { box in
                _ = try await api.photosRecrop(photoId: cut.id, box: box)
            }
        } else {
            job = CropJob(source: source, initialBox: e.pinBox) { box in
                let r = try await api.photosCreateCutout(itemId: itemId, sourcePhotoId: p.id, box: box)
                // The server keeps one cropped Photo per Thing and full Photo and hands that one
                // back unchanged: crop it again, but only when it is a cropped Photo we know (never
                // a full Photo, which recrop would overwrite).
                if !r.created {
                    guard knownCutoutIds.contains(r.id) else { throw CropError.notCropped }
                    _ = try await api.photosRecrop(photoId: r.id, box: box)
                }
            }
        }
    }
}
