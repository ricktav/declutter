import SwiftUI

/// One Place (a room): its 2D / 3D plan from `rooms.get`, or a LiDAR scan when it has none.
struct RoomDetailView: View {
    @EnvironmentObject private var session: FlowSession
    @EnvironmentObject private var uploader: SnapUploader
    @EnvironmentObject private var camera: SnapCamera
    @Environment(\.dismiss) private var dismiss

    let place: Place

    @State private var info: RoomInfo?
    @State private var loaded = false
    @State private var scan = false
    @State private var error: String?
    @State private var scans: [RoomScanRow] = []
    /// The Thing whose sheet is open (tapped on the plan).
    @State private var selected: RoomItem?
    /// The Thing being dragged on the 2D plan.
    @State private var movingId: Int?
    /// The scan whose "Undo this scan" waits for its inline confirm.
    @State private var confirmUndo: Int?
    @State private var undoing = false
    @State private var undoResult: String?
    /// Large while moving a Thing, so the whole plan is in reach of the finger.
    @State private var detent: PresentationDetent = .medium

    private var label: String {
        let l = FlowLogic.placeLabel(place, houses: session.houses)
        return l.isEmpty ? "No Place" : l
    }

    var body: some View {
        FlowSheet(title: place.room.isEmpty ? "Place" : place.room, onClose: { dismiss() }, detent: $detent,
                  detents: movingId != nil ? [.large] : [.medium, .large],
                  scrollDisabled: movingId != nil) {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Place")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(FlowTheme.muted)
                        .textCase(.uppercase)
                    Text(label)
                        .font(.system(size: 15, weight: .medium))
                    if let info {
                        Text("\(info.planItems.count) Things in this Place")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))

                if let geo = info?.geometryPayload {
                    if let id = movingId {
                        moveBanner(id)
                    }
                    FloorPlanView(
                        geometry: geo,
                        items: info?.planItems ?? [],
                        selectedId: selected?.id,
                        movingId: movingId,
                        onTapItem: { selected = $0 },
                        onMove: { it, pos in move(it, to: pos) }
                    )
                    if movingId == nil, !(info?.planItems.isEmpty ?? true) {
                        Text("Tap a Thing on the plan to check it, take a Photo of it or move it.")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.moss)
                            .frame(maxWidth: .infinity)
                    }
                    Button {
                        scan = true
                    } label: {
                        Label("Rescan this Place", systemImage: "cube.transparent")
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .foregroundStyle(FlowTheme.ink)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(FlowTheme.ink))
                    }
                } else if loaded {
                    EmptyState(
                        title: "No floor plan yet",
                        caption: "Scan this Place with LiDAR to add a 2D / 3D plan. Things already here stay put."
                    )
                    Button {
                        scan = true
                    } label: {
                        Label("Scan this Place", systemImage: "cube.transparent")
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .foregroundStyle(FlowTheme.cream)
                            .background(FlowTheme.ink, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                ErrorLine(message: error)
                if !scans.isEmpty {
                    scansList
                }
            }
        }
        .task { await load() }
        // A drag on the plan must never swipe the Place away mid-move.
        .interactiveDismissDisabled(movingId != nil)
        .fullScreenCover(isPresented: $scan) {
            RoomScanFlow(initialPlace: place) {
                Task { await reload() }
            }
            .environmentObject(session)
        }
        .sheet(item: $selected) { it in
            PlanThingSheet(
                item: it,
                ownerRoomName: ownerRoomName(of: it),
                onChanged: { await reload() },
                onMove: {
                    selected = nil
                    undoResult = nil
                    detent = .large
                    movingId = it.id
                }
            )
            .environmentObject(session)
            .environmentObject(uploader)
            .environmentObject(camera)
        }
        .onChange(of: scan) { _, on in
            if on {
                undoResult = nil
                // The LiDAR scan needs the camera to itself.
                Task { await camera.stop() }
            }
        }
    }

    /// The child room a rolled-up Thing really sits in; nil for a Thing of this Place.
    private func ownerRoomName(of it: RoomItem) -> String? {
        guard it.isRolledUp(into: place.roomId), let owner = it.ownerRoomId else { return nil }
        return session.rooms.first(where: { $0.id == owner })?.name ?? "its own Place"
    }

    private func moveBanner(_ id: Int) -> some View {
        let name = info?.planItems.first(where: { $0.id == id })?.name ?? "the Thing"
        return HStack(spacing: 10) {
            Image(systemName: "hand.draw")
                .foregroundStyle(FlowTheme.ink)
            Text("Drag \(name) on the plan. Each release saves.")
                .font(.system(size: 13, weight: .medium))
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Done") {
                movingId = nil
                detent = .medium
            }
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .foregroundStyle(FlowTheme.ink)
                .background(FlowTheme.lime, in: Capsule())
        }
        .padding(10)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(FlowTheme.ink))
    }

    /// Newest first; only the newest scan that is not undone can be undone (the server's rule).
    private var scansList: some View {
        let undoable = scans.first(where: { $0.revertedAt == nil })?.id
        return VStack(alignment: .leading, spacing: 8) {
            Text("Scans")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(FlowTheme.muted)
                .textCase(.uppercase)
            if let undoResult {
                Text(undoResult)
                    .font(.system(size: 12))
                    .foregroundStyle(FlowTheme.moss)
            }
            ForEach(scans) { row in
                scanRow(row, undoable: row.id == undoable)
            }
        }
    }

    private func scanRow(_ row: RoomScanRow, undoable: Bool) -> some View {
        let undone = row.revertedAt != nil
        let c = row.counts
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if let d = row.scanDate ?? row.createdAt {
                    Text(d, format: .dateTime.day().month(.abbreviated).year().hour().minute())
                        .font(.system(size: 14, weight: .medium))
                }
                Text(Self.sourceLabel(row.source))
                    .font(.system(size: 12))
                    .foregroundStyle(FlowTheme.muted)
                Spacer()
                if undone {
                    Text("Undone")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(FlowTheme.muted)
                }
            }
            Text("\(c.matched) matched (\(c.moved) moved) · \(c.created) new · \(c.missing) missing")
                .font(.system(size: 12))
                .foregroundStyle(FlowTheme.muted)
            if undoable {
                if confirmUndo == row.id {
                    Text("Walls and Thing positions go back to before this scan. Things it added are deleted, unless someone changed them since.")
                        .font(.system(size: 12))
                        .foregroundStyle(FlowTheme.ink)
                    HStack(spacing: 8) {
                        Button("Undo this scan") { Task { await undo(row.id) } }
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .foregroundStyle(FlowTheme.cream)
                            .background(FlowTheme.toss, in: Capsule())
                            .disabled(undoing)
                        Button("Keep it") { confirmUndo = nil }
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .foregroundStyle(FlowTheme.ink)
                            .overlay(Capsule().strokeBorder(Color(hex: 0xD5D9CD)))
                            .disabled(undoing)
                        if undoing { ProgressView() }
                    }
                } else {
                    Button("Undo this scan") { confirmUndo = row.id }
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(FlowTheme.toss)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))
        .opacity(undone ? 0.5 : 1)
    }

    private static func sourceLabel(_ source: String) -> String {
        switch source {
        case "roomplan": return "LiDAR"
        case "mappedin": return "MappedIn"
        case "manual": return "By hand"
        default: return source
        }
    }

    /// `withSession`: also reload the session (once), else only when the plan shows Things
    /// the session does not know yet (a fresh scan made them; their sheets need them).
    private func load(withSession: Bool = false) async {
        defer { loaded = true }
        guard let api = session.api, let id = place.roomId else { return }
        do {
            info = try await api.roomsGet(id: id)
        } catch {
            self.error = error.localizedDescription
        }
        // An older server has no scan history; the plan still works.
        scans = (try? await api.roomsScans(roomId: id)) ?? []
        let known = Set(session.items.map(\.id))
        if withSession || info?.planItems.contains(where: { !known.contains($0.id) }) == true {
            await session.refresh()
        }
    }

    /// After a change on this Place: the plan, its scans and every list in the app.
    /// An earlier "Scan undone" line no longer describes the Place, so it goes.
    private func reload() async {
        undoResult = nil
        await load(withSession: true)
    }

    /// Called from the drag's end: the box takes its new place in this same update (no
    /// frame where it jumps back), then the save runs.
    private func move(_ it: RoomItem, to pos: ItemPos) {
        // A Thing of a child room carries a pos shifted into this Place's frame: never save it.
        guard !it.isRolledUp(into: place.roomId), let api = session.api else { return }
        if let i = info?.items?.firstIndex(where: { $0.id == it.id }) {
            info?.items?[i].pos = pos
        }
        error = nil
        Task {
            do {
                try await api.itemsSetPos(id: it.id, pos: pos)
            } catch {
                self.error = "Could not move \(it.name): \(error.localizedDescription)"
            }
            await reload()
        }
    }

    private func undo(_ scanId: Int) async {
        guard let api = session.api else { return }
        undoing = true
        error = nil
        var result: String?
        do {
            let r = try await api.roomsRevertScan(scanId: scanId)
            result = "Scan undone: \(r.restored) restored, \(r.deleted) deleted, \(r.kept) kept."
            confirmUndo = nil
            movingId = nil
            detent = .medium
        } catch {
            self.error = error.localizedDescription
        }
        undoing = false
        await reload()
        undoResult = result
    }
}
