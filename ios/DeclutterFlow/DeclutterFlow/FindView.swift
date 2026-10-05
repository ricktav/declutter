import SwiftUI

/// What Find lists: Things, or Places (rooms) with their floor plans.
private enum FindScope: String, CaseIterable, Identifiable {
    case things = "Things"
    case places = "Places"
    var id: String { rawValue }
}

struct FindView: View {
    @EnvironmentObject private var session: FlowSession
    /// The app's Snap uploader: "Take a Photo of it" on a Place plan uploads through it.
    @EnvironmentObject private var uploader: SnapUploader
    @State private var q = ""
    @State private var scope: FindScope = .things
    @State private var open: FlowItem?
    @State private var openPlace: FlowRoom?

    private var results: [FlowItem] {
        let live = session.visibleItems.filter { $0.status == .active }
        let terms = q.lowercased().split(whereSeparator: \.isWhitespace).map(String.init).filter { !$0.isEmpty }
        let scored = live.filter { it in
            if terms.isEmpty { return true }
            let hay = [
                it.name,
                it.description,
                it.room,
                it.floor,
                it.areaName,
                session.houses.first(where: { $0.id == it.houseId })?.name,
            ]
            .compactMap { $0 }
            .joined(separator: " ")
            .lowercased()
            return terms.allSatisfy { hay.contains($0) }
        }
        return Array(scored.prefix(terms.isEmpty ? 20 : 60))
    }

    /// Every room of every house (`rooms.list` with `houseId: null`), busiest first.
    private var placeRows: [FlowRoom] {
        let terms = q.lowercased().split(whereSeparator: \.isWhitespace).map(String.init).filter { !$0.isEmpty }
        let rows = session.rooms.filter { r in
            if terms.isEmpty { return true }
            let hay = [r.name, r.floor, session.houses.first(where: { $0.id == r.houseId })?.name]
                .compactMap { $0 }
                .joined(separator: " ")
                .lowercased()
            return terms.allSatisfy { hay.contains($0) }
        }
        return rows.sorted { $0.itemCount != $1.itemCount ? $0.itemCount > $1.itemCount : $0.name < $1.name }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(FlowTheme.muted)
                TextField(scope == .things ? "Search a Thing, a room or a kind" : "Search a Place", text: $q)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .padding(14)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))

            Picker("Find", selection: $scope) {
                ForEach(FindScope.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            if q.isEmpty {
                Text(scope == .things ? "Recently changed" : "Places")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(FlowTheme.muted)
                    .textCase(.uppercase)
            }

            if !session.ready {
                Text("Loading…")
                    .font(.system(size: 13))
                    .foregroundStyle(FlowTheme.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            } else if scope == .places {
                if placeRows.isEmpty && !q.isEmpty {
                    EmptyState(title: "Nothing found", caption: "Try a shorter word, a room or a floor name.")
                } else if placeRows.isEmpty {
                    EmptyState(title: "No Places yet", caption: "Pick a Place in Snap or Sort first, then scan it here.")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(placeRows) { r in
                                Button { openPlace = r } label: { placeRow(r) }
                                    .buttonStyle(.plain)
                            }
                        }
                    }
                }
            } else if results.isEmpty {
                EmptyState(title: "Nothing found", caption: "Try a shorter word, a room name or a kind such as “cable”.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(results) { it in
                            Button {
                                open = it
                            } label: {
                                HStack(spacing: 12) {
                                    RemotePhoto(storageKey: it.imageKey, api: session.api, cornerRadius: 8, zoomable: false)
                                        .frame(width: 56, height: 56)
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack {
                                            Text(it.name)
                                                .font(.system(size: 15, weight: .medium))
                                                .foregroundStyle(FlowTheme.ink)
                                                .lineLimit(1)
                                            DecisionBadge(decision: it.decision)
                                        }
                                        Text(FlowLogic.placeLabel(it, houses: session.houses).isEmpty ? "no Place yet" : FlowLogic.placeLabel(it, houses: session.houses))
                                            .font(.system(size: 12))
                                            .foregroundStyle(FlowTheme.muted)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                }
                                .padding(8)
                                .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .sheet(item: $open) { item in
            ThingSheet(item: item)
                .environmentObject(session)
                .environmentObject(uploader)
        }
        .sheet(item: $openPlace) { r in
            RoomDetailView(place: Place(room: r))
                .environmentObject(session)
                .environmentObject(uploader)
        }
        .onAppear { openFromLaunchArgument() }
        .onChange(of: session.ready) { _, _ in openFromLaunchArgument() }
    }

    private func placeRow(_ r: FlowRoom) -> some View {
        HStack(spacing: 12) {
            Image(systemName: r.hasPlan ? "square.split.bottomrightquarter" : "cube.transparent")
                .foregroundStyle(FlowTheme.moss)
                .frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(r.name)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(FlowTheme.ink)
                // House and floor only: the name is on the line above.
                let whereLabel = FlowLogic.placeLabel(houseId: r.houseId, floor: r.floor, room: nil, houses: session.houses)
                if !whereLabel.isEmpty {
                    Text(whereLabel)
                        .font(.system(size: 12))
                        .foregroundStyle(FlowTheme.muted)
                        .lineLimit(1)
                }
            }
            Spacer()
            Text(r.hasPlan ? "2D / 3D" : "No plan")
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(r.hasPlan ? FlowTheme.moss : FlowTheme.muted)
            Text("\(r.itemCount)")
                .font(.system(size: 12, design: .rounded))
                .foregroundStyle(FlowTheme.muted)
        }
        .padding(12)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))
    }

    /// `-flow.openItemId <id>` (launch argument) opens that Thing once the list is loaded; used for Simulator screenshots.
    private func openFromLaunchArgument() {
        let id = UserDefaults.standard.integer(forKey: "flow.openItemId")
        guard session.ready, id > 0, open == nil else { return }
        open = session.items.first(where: { $0.id == id })
    }
}

private struct ThingSheet: View {
    @EnvironmentObject private var session: FlowSession
    @EnvironmentObject private var uploader: SnapUploader
    let item: FlowItem
    @Environment(\.dismiss) private var dismiss
    @State private var roomInfo: RoomInfo?
    @State private var deciding = false
    @State private var showRoom = false
    @State private var showScan = false

    private var live: FlowItem {
        session.items.first(where: { $0.id == item.id }) ?? item
    }

    /// The Thing's Place, from `rooms.list` when it is loaded (else the room `items.listAll` joined on).
    private var place: Place? {
        guard let id = live.roomId else { return nil }
        if let r = session.rooms.first(where: { $0.id == id }) { return Place(room: r) }
        return Place(roomId: id, houseId: live.roomRef?.houseId ?? live.houseId, floor: live.floor ?? "", room: live.room ?? "")
    }

    var body: some View {
        FlowSheet(title: live.name, onClose: { dismiss() }) {
            VStack(alignment: .leading, spacing: 12) {
                if live.imageKey != nil {
                    RemotePhoto(storageKey: live.imageKey, api: session.api)
                        .aspectRatio(4 / 3, contentMode: .fit)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Where")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(FlowTheme.muted)
                        .textCase(.uppercase)
                    Text(FlowLogic.placeLabel(live, houses: session.houses).isEmpty ? "No Place yet" : FlowLogic.placeLabel(live, houses: session.houses))
                        .font(.system(size: 15, weight: .medium))
                    if let a = live.areaName {
                        Text(a).font(.system(size: 12)).foregroundStyle(FlowTheme.muted)
                    }
                    if let roomInfo, roomInfo.hasPlan {
                        Text("Place plan “\(roomInfo.name)” · \(roomInfo.items?.count ?? 0) Things")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                    } else if roomInfo != nil {
                        Text("No floor plan yet for this Place")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))

                if let geo = roomInfo?.geometryPayload {
                    FloorPlanView(geometry: geo, items: roomInfo?.planItems ?? [])
                    Button { showRoom = true } label: {
                        Text("Open Place · 2D / 3D")
                            .font(.system(size: 13, weight: .semibold))
                            .frame(maxWidth: .infinity)
                    }
                } else if roomInfo != nil, place != nil {
                    Button { showScan = true } label: {
                        Label("Scan this Place", systemImage: "cube.transparent")
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .foregroundStyle(FlowTheme.cream)
                            .background(FlowTheme.ink, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }

                Text("Decision")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(FlowTheme.muted)
                    .textCase(.uppercase)
                DecisionButtons(current: live.decision, disabled: deciding) { d in
                    Task { await setDecision(d == live.decision ? nil : d) }
                }
                Text("Open this Thing in the Workbench on a computer to edit details or use another Lens.")
                    .font(.system(size: 12))
                    .foregroundStyle(FlowTheme.moss)
                    .frame(maxWidth: .infinity)
            }
        }
        .task { await loadRoom() }
        .sheet(isPresented: $showRoom) {
            if let place {
                RoomDetailView(place: place)
                    .environmentObject(session)
                    .environmentObject(uploader)
            }
        }
        .fullScreenCover(isPresented: $showScan) {
            if let place {
                RoomScanFlow(initialPlace: place) {
                    Task { await loadRoom() }
                }
                .environmentObject(session)
            }
        }
    }

    private func loadRoom() async {
        guard let id = live.roomId, let api = session.api else { return }
        roomInfo = try? await api.roomsGet(id: id)
    }

    private func setDecision(_ d: ItemDecision?) async {
        guard let api = session.api else { return }
        deciding = true
        do {
            try await api.itemsSetDecision(id: item.id, decision: d)
            await session.refresh()
        } catch {}
        deciding = false
    }
}
