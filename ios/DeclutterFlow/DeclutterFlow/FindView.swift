import SwiftUI

struct FindView: View {
    @EnvironmentObject private var session: FlowSession
    @State private var q = ""
    @State private var open: FlowItem?

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

            if q.isEmpty {
                Text("Recently changed")
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
    }
}

private struct ThingSheet: View {
    @EnvironmentObject private var session: FlowSession
    let item: FlowItem
    @Environment(\.dismiss) private var dismiss
    @State private var roomInfo: RoomInfo?
    @State private var deciding = false

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
                    if let roomInfo {
                        Text("Room plan “\(roomInfo.name)” · \(roomInfo.items?.count ?? 0) Things")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))

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
