import SwiftUI

private enum FindLens: String, CaseIterable, Identifiable {
    case things = "Things"
    case places = "Places"
    var id: String { rawValue }
}

struct FindView: View {
    @EnvironmentObject private var session: FlowSession
    @State private var q = ""
    @State private var lens: FindLens = .things
    @State private var open: FlowItem?
    @State private var openPlace: PlaceToken?

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

    private var placeRows: [PlaceToken] {
        let terms = q.lowercased().split(whereSeparator: \.isWhitespace).map(String.init).filter { !$0.isEmpty }
        var rows: [PlaceToken] = session.locations.map { loc in
            let place = Place(houseId: loc.houseId, floor: loc.floor ?? "", room: loc.room)
            return PlaceToken(place: place, roomId: session.scannedRoom(for: place)?.id, thingCount: loc.count)
        }
        for room in session.scannedRooms where !rows.contains(where: { $0.roomId == room.id }) {
            let place = Place(houseId: room.houseId, floor: "", room: room.name)
            rows.append(PlaceToken(place: place, roomId: room.id, thingCount: 0))
        }
        if terms.isEmpty { return rows.sorted { $0.thingCount > $1.thingCount } }
        return rows.filter { token in
            let hay = [
                token.place.room,
                token.place.floor,
                session.houses.first(where: { $0.id == token.place.houseId })?.name,
            ]
            .compactMap { $0 }
            .joined(separator: " ")
            .lowercased()
            return terms.allSatisfy { hay.contains($0) }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(FlowTheme.muted)
                TextField("Search a Thing, a room or a kind", text: $q)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .padding(14)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))

            Picker("Lens", selection: $lens) {
                ForEach(FindLens.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            if q.isEmpty {
                Text(lens == .things ? "Recently changed" : "Places")
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
            } else if lens == .places {
                if placeRows.isEmpty {
                    EmptyState(title: "No Places yet", caption: "Snap and sort Things first, or scan a Place from Snap.")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(placeRows) { token in
                                Button { openPlace = token } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: token.roomId == nil ? "cube.transparent" : "square.split.bottomrightquarter")
                                            .foregroundStyle(FlowTheme.moss)
                                            .frame(width: 36)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(token.place.room)
                                                .font(.system(size: 15, weight: .medium))
                                                .foregroundStyle(FlowTheme.ink)
                                            Text(FlowLogic.placeLabel(token.place, houses: session.houses))
                                                .font(.system(size: 12))
                                                .foregroundStyle(FlowTheme.muted)
                                                .lineLimit(1)
                                        }
                                        Spacer()
                                        Text(token.roomId == nil ? "No plan" : "2D / 3D")
                                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                                            .foregroundStyle(token.roomId == nil ? FlowTheme.muted : FlowTheme.moss)
                                        Text("\(token.thingCount)")
                                            .font(.system(size: 12, design: .rounded))
                                            .foregroundStyle(FlowTheme.muted)
                                    }
                                    .padding(12)
                                    .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))
                                }
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
                                    RemotePhoto(storageKey: it.imageKey, api: session.api, cornerRadius: 8)
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
        }
        .sheet(item: $openPlace) { token in
            RoomDetailView(place: token.place, roomId: token.roomId)
                .environmentObject(session)
        }
    }
}

struct PlaceToken: Identifiable, Hashable {
    var place: Place
    var roomId: Int?
    var thingCount: Int
    var id: String { "\(place.houseId ?? 0)|\(place.floor)|\(place.room)|\(roomId ?? 0)" }
}

private struct ThingSheet: View {
    @EnvironmentObject private var session: FlowSession
    let item: FlowItem
    @Environment(\.dismiss) private var dismiss
    @State private var roomInfo: RoomInfo?
    @State private var deciding = false
    @State private var showRoom = false
    @State private var showScan = false

    private var live: FlowItem {
        session.items.first(where: { $0.id == item.id }) ?? item
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
                        Text("Room plan “\(roomInfo.name)” · \(roomInfo.items?.count ?? 0) Things")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                    } else if live.room != nil, !(live.room ?? "").isEmpty {
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
                    FloorPlanView(geometry: geo, items: roomInfo?.items ?? [])
                    Button { showRoom = true } label: {
                        Text("Open Place · 2D / 3D")
                            .font(.system(size: 13, weight: .semibold))
                            .frame(maxWidth: .infinity)
                    }
                } else if live.houseId != nil, !(live.room ?? "").isEmpty {
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
            RoomDetailView(
                place: Place(houseId: live.houseId, floor: live.floor ?? "", room: live.room ?? ""),
                roomId: live.roomId ?? roomInfo?.id
            )
            .environmentObject(session)
        }
        .fullScreenCover(isPresented: $showScan) {
            RoomScanFlow(initialPlace: Place(houseId: live.houseId, floor: live.floor ?? "", room: live.room ?? "")) {
                Task { await loadRoom(); await session.refresh() }
            }
            .environmentObject(session)
        }
    }

    private func loadRoom() async {
        guard let api = session.api else { return }
        if let id = live.roomId {
            roomInfo = try? await api.roomsGet(id: id)
            return
        }
        if let scanned = session.scannedRoom(houseId: live.houseId, name: live.room) {
            roomInfo = try? await api.roomsGet(id: scanned.id)
        }
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
