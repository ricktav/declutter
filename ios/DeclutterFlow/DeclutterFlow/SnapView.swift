import SwiftUI
import PhotosUI

struct SnapView: View {
    @EnvironmentObject private var session: FlowSession
    var onGoSort: () -> Void
    var onChangeHere: () -> Void

    @State private var note = ""
    // Shared with the camera screen: one counter, one spinner, one error line.
    @StateObject private var uploader = SnapUploader()
    // Lives as long as the Snap tab, so the session stays warm between camera opens.
    @StateObject private var camera = SnapCamera()
    @State private var showCamera = false
    @State private var showScan = false
    @State private var libraryItems: [PhotosPickerItem] = []

    private var pending: [FlowCapture] { session.pendingCaptures }

    private var scanCaption: String {
        guard let id = session.here.roomId else { return "Pick a Place, then walk the walls" }
        if session.rooms.first(where: { $0.id == id })?.hasPlan == true {
            return "Rescan the plan for \(session.here.room)"
        }
        return "No floor plan yet — LiDAR 2D / 3D"
    }
    private var recent: [FlowCapture] {
        pending.filter { $0.kind == .image && $0.storageKey != nil }.prefix(8).map { $0 }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Button(action: onChangeHere) {
                    HStack(spacing: 8) {
                        Image(systemName: "mappin")
                            .foregroundStyle(FlowTheme.moss)
                        if session.here.hasRoom {
                            Text("Snaps go to ")
                                .foregroundStyle(FlowTheme.ink)
                            + Text(FlowLogic.placeLabel(session.here, houses: session.houses))
                                .fontWeight(.semibold)
                        } else {
                            Text("Set where you are (optional)")
                                .foregroundStyle(FlowTheme.muted)
                        }
                    }
                    .font(.system(size: 13))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.white, in: Capsule())
                    .overlay(Capsule().strokeBorder(Color(hex: 0xD5D9CD)))
                }
                .buttonStyle(.plain)

                VStack(spacing: 12) {
                    Button {
                        showCamera = true
                    } label: {
                        ZStack {
                            Circle()
                                .strokeBorder(FlowTheme.moss, lineWidth: 7)
                                .frame(width: 160, height: 160)
                            Circle()
                                .fill(FlowTheme.moss)
                                .frame(width: 112, height: 112)
                            if uploader.busy > 0 {
                                ProgressView().tint(FlowTheme.cream)
                            } else {
                                Image(systemName: "camera.fill")
                                    .font(.system(size: 36))
                                    .foregroundStyle(FlowTheme.cream)
                            }
                        }
                    }
                    .accessibilityLabel("Take a photo")

                    Text("One Photo for each Thing, or one Photo of a shelf.")
                        .font(.system(size: 13))
                        .foregroundStyle(FlowTheme.muted)
                        .multilineTextAlignment(.center)

                    PhotosPicker(selection: $libraryItems, maxSelectionCount: 12, matching: .images) {
                        Label("Photos from this device", systemImage: "photo.on.rectangle")
                            .font(.system(size: 13))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(hex: 0xD5D9CD)))
                    }

                    // Only on a LiDAR device; elsewhere the Place sheet in Find explains why.
                    if LiDARScan.isSupported {
                        Button { showScan = true } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "cube.transparent")
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Scan this Place")
                                        .font(.system(size: 13, weight: .semibold))
                                    Text(scanCaption)
                                        .font(.system(size: 11))
                                        .foregroundStyle(FlowTheme.muted)
                                }
                                Spacer()
                            }
                            .padding(12)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color(hex: 0xD5D9CD)))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: .infinity)

                HStack(spacing: 8) {
                    TextField("Or type a note or a link", text: $note)
                        .padding(12)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    Button {
                        Task { await addNote() }
                    } label: {
                        Image(systemName: "paperplane.fill")
                            .foregroundStyle(FlowTheme.cream)
                            .padding(12)
                            .background(FlowTheme.ink, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .opacity(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
                }

                ErrorLine(message: uploader.error)

                if let summary = uploader.failedSummary {
                    HStack(spacing: 8) {
                        Text(summary)
                            .font(.system(size: 12))
                            .foregroundStyle(Color(hex: 0x9B1C1C))
                        Spacer()
                        Button("Retry") {
                            Task { await uploader.retryFailed(session: session) }
                        }
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .disabled(uploader.busy > 0)
                    }
                }

                HStack {
                    (Text(uploader.savedCount > 0 ? "+\(uploader.savedCount) saved · " : "")
                        .foregroundStyle(FlowTheme.lime)
                        .fontWeight(.semibold)
                    + Text("\(pending.count)").fontWeight(.bold)
                    + Text(" waiting to sort"))
                        .font(.system(size: 13))
                        .foregroundStyle(FlowTheme.cream)
                    Spacer()
                    Button("Sort now") { onGoSort() }
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .foregroundStyle(FlowTheme.ink)
                        .background(FlowTheme.lime, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .disabled(pending.isEmpty)
                        .opacity(pending.isEmpty ? 0.4 : 1)
                }
                .padding(16)
                .background(FlowTheme.ink, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                if !recent.isEmpty {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                        ForEach(recent) { cap in
                            RemotePhoto(storageKey: cap.storageKey, api: session.api)
                                .aspectRatio(1, contentMode: .fit)
                        }
                    }
                }
            }
            .padding(.vertical, 8)
        }
        .fullScreenCover(isPresented: $showCamera) {
            SnapCameraScreen(camera: camera, uploader: uploader, onClose: { showCamera = false })
                .environmentObject(session)
        }
        .fullScreenCover(isPresented: $showScan) {
            RoomScanFlow(initialPlace: session.here, setsHere: true)
                .environmentObject(session)
        }
        .onAppear { camera.prepare() }
        .onChange(of: showScan) { _, scanning in
            // The LiDAR scan needs the camera to itself.
            if scanning { camera.stop() }
        }
        .onChange(of: libraryItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await uploadLibrary(items) }
        }
    }

    private func uploadLibrary(_ items: [PhotosPickerItem]) async {
        libraryItems = []
        for item in items {
            do {
                if let data = try await item.loadTransferable(type: Data.self),
                   let image = UIImage(data: data) {
                    await uploader.upload(image: image, session: session)
                }
            } catch {
                uploader.error = error.localizedDescription
            }
        }
    }

    private func addNote() async {
        let t = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let api = session.api else { return }
        uploader.error = nil
        do {
            let isURL = t.range(of: #"^https?://"#, options: [.regularExpression, .caseInsensitive]) != nil
            let row = try await api.inboxCreate(
                kind: isURL ? .link : .note,
                rawText: isURL ? nil : t,
                url: isURL ? t : nil
            )
            if session.here.hasRoom {
                SnapPlaceStore.set(row.id, place: session.here)
            }
            note = ""
            uploader.noteSaved()
            await session.refresh()
        } catch {
            uploader.error = error.localizedDescription
        }
    }
}
