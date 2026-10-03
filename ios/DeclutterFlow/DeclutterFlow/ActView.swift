import SwiftUI

struct ActView: View {
    @EnvironmentObject private var session: FlowSession
    @EnvironmentObject private var settings: SettingsStore

    @State private var houseId: Int?
    @State private var allHouses = true
    /// The default house is applied once; after that the chips are the user's.
    @State private var houseDefaulted = false
    @State private var room: String?
    @State private var skipped: [Int] = []
    @State private var last: (id: Int, prev: ItemDecision?, name: String)?
    @State private var listOpen: ItemDecision?
    @State private var error: String?
    @State private var deciding = false

    private let noRoom = "__none__"

    private var inHouse: [FlowItem] {
        session.visibleItems.filter { it in
            !FlowLogic.needsCheck(it) && (allHouses || it.houseId == houseId)
        }
    }

    private var rooms: [(String, Int)] {
        var m: [String: Int] = [:]
        for it in inHouse where it.status == .active {
            let key = (it.room?.isEmpty == false ? it.room! : noRoom)
            m[key, default: 0] += 1
        }
        return m.sorted { $0.value > $1.value }
    }

    private var scope: [FlowItem] {
        inHouse.filter { it in
            room == nil || (it.room?.isEmpty == false ? it.room : noRoom) == room
        }
    }

    private var total: Int { scope.filter { $0.status == .active || FlowLogic.isDecided($0) }.count }
    private var done: Int { scope.filter(FlowLogic.isDecided).count }
    private var queue: [FlowItem] { scope.filter(FlowLogic.needsDecision) }
    private var ordered: [FlowItem] {
        queue.filter { !skipped.contains($0.id) } + queue.filter { skipped.contains($0.id) }
    }
    private var current: FlowItem? { ordered.first }

    private var listDecisions: [ItemDecision] { [.sell, .donate, .toss] }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Chip(title: "All houses", selected: allHouses) {
                            allHouses = true
                            houseId = nil
                            room = nil
                        }
                        ForEach(session.houses) { h in
                            Chip(title: h.name, selected: !allHouses && houseId == h.id) {
                                allHouses = false
                                houseId = h.id
                                room = nil
                            }
                        }
                    }
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        roomChip("Every room", selected: room == nil) { room = nil }
                        ForEach(rooms, id: \.0) { r, n in
                            roomChip("\(r == noRoom ? "No room" : r) \(n)", selected: room == r) { room = r }
                        }
                    }
                }

                HStack(spacing: 16) {
                    ProgressRing(value: done, total: total)
                    VStack(spacing: 6) {
                        ForEach(listDecisions, id: \.self) { d in
                            let n = inHouse.filter { $0.status == .active && $0.decision == d }.count
                            Button {
                                listOpen = d
                            } label: {
                                HStack {
                                    Text(d.listTitle).font(.system(size: 13, weight: .semibold))
                                    Spacer()
                                    Text("\(n)").font(.system(size: 13, design: .rounded))
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .foregroundStyle(d.color)
                                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(d.color))
                            }
                            .disabled(n == 0)
                            .opacity(n == 0 ? 0.4 : 1)
                        }
                    }
                }
                .padding(12)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color(hex: 0xD5D9CD)))

                if let last {
                    Button {
                        Task { await decide(id: last.id, decision: last.prev) }
                        self.last = nil
                    } label: {
                        Label("Undo “\(last.name)”", systemImage: "arrow.uturn.backward")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                            .underline()
                    }
                    .frame(maxWidth: .infinity)
                }

                ErrorLine(message: error)

                if !session.ready {
                    Text("Loading…").font(.system(size: 13)).foregroundStyle(FlowTheme.muted).frame(maxWidth: .infinity).padding(.vertical, 40)
                } else if let current {
                    VStack(alignment: .leading, spacing: 12) {
                        RemotePhoto(storageKey: current.imageKey, api: session.api)
                            .aspectRatio(4 / 3, contentMode: .fit)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(current.name).font(.system(size: 17, weight: .semibold))
                            Text([current.areaName, FlowLogic.placeLabel(current, houses: session.houses).isEmpty ? "no Place yet" : FlowLogic.placeLabel(current, houses: session.houses)].compactMap { $0 }.joined(separator: " · ")
                                 + (current.decision == .later ? " · was Later" : ""))
                                .font(.system(size: 12))
                                .foregroundStyle(FlowTheme.muted)
                        }
                        HStack {
                            Text("Keep it?")
                                .font(.system(size: 15, weight: .bold, design: .rounded))
                            Spacer()
                            Button("skip") {
                                skipped.removeAll { $0 == current.id }
                                skipped.append(current.id)
                            }
                            .font(.system(size: 12, design: .rounded))
                            .foregroundStyle(FlowTheme.muted)
                            .underline()
                        }
                        DecisionButtons(disabled: deciding) { d in
                            Task { await pick(current, d) }
                        }
                        Text("\(ordered.count) left to decide")
                            .font(.system(size: 12, design: .rounded))
                            .foregroundStyle(FlowTheme.muted)
                            .frame(maxWidth: .infinity)
                    }
                    .padding(12)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color(hex: 0xD5D9CD)))
                    .id(current.id)
                } else {
                    EmptyState(
                        title: total == 0 ? "No Things here yet" : "Everything here is decided",
                        caption: total == 0 ? "Snap and sort Things first." : "Pick another room, or work through the lists above."
                    )
                }
            }
            .padding(.vertical, 4)
        }
        .onAppear {
            // open on the Settings house (the one the API sends as x-house-id),
            // else the house of the current Place, else all houses
            guard !houseDefaulted else { return }
            houseDefaulted = true
            if let start = settings.houseId ?? session.here.houseId {
                houseId = start
                allHouses = false
            }
        }
        .sheet(item: Binding(
            get: { listOpen.map { DecisionListToken(decision: $0) } },
            set: { listOpen = $0?.decision }
        )) { token in
            DecisionListSheet(decision: token.decision, houseId: allHouses ? nil : houseId)
                .environmentObject(session)
        }
    }

    private func roomChip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .foregroundStyle(FlowTheme.ink)
                .background(selected ? FlowTheme.moss.opacity(0.12) : Color.white, in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? FlowTheme.moss : Color(hex: 0xD5D9CD)))
        }
        .buttonStyle(.plain)
    }

    private func pick(_ item: FlowItem, _ d: ItemDecision) async {
        last = (item.id, item.decision, item.name)
        await decide(id: item.id, decision: d)
    }

    private func decide(id: Int, decision: ItemDecision?) async {
        guard let api = session.api else { return }
        deciding = true
        error = nil
        do {
            try await api.itemsSetDecision(id: id, decision: decision)
            await session.refresh()
        } catch {
            self.error = error.localizedDescription
        }
        deciding = false
    }
}

private struct DecisionListToken: Identifiable {
    let decision: ItemDecision
    var id: String { decision.rawValue }
}

private struct DecisionListSheet: View {
    @EnvironmentObject private var session: FlowSession
    let decision: ItemDecision
    var houseId: Int?
    @Environment(\.dismiss) private var dismiss

    private var scoped: [FlowItem] {
        session.visibleItems.filter { it in
            !FlowLogic.needsCheck(it) && (houseId == nil || it.houseId == houseId)
        }
    }

    private var live: [FlowItem] {
        scoped.filter { $0.status == .active && $0.decision == decision }
    }

    private var gone: [FlowItem] {
        scoped
            .filter { $0.status == .archived && $0.decision == decision }
            .sorted { ($0.archivedAt ?? .distantPast) > ($1.archivedAt ?? .distantPast) }
    }

    @State private var showGone = false
    @State private var error: String?

    var body: some View {
        FlowSheet(title: decision.listTitle, onClose: { dismiss() }) {
            VStack(alignment: .leading, spacing: 12) {
                ErrorLine(message: error)
                if live.isEmpty {
                    Text("Nothing left on this list.")
                        .font(.system(size: 13))
                        .foregroundStyle(FlowTheme.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                } else {
                    ForEach(live) { it in
                        HStack(spacing: 12) {
                            RemotePhoto(storageKey: it.imageKey, api: session.api, cornerRadius: 8)
                                .frame(width: 56, height: 56)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(it.name).font(.system(size: 14, weight: .medium)).lineLimit(1)
                                Text(FlowLogic.placeLabel(it, houses: session.houses).isEmpty ? "no Place" : FlowLogic.placeLabel(it, houses: session.houses))
                                    .font(.system(size: 11))
                                    .foregroundStyle(FlowTheme.muted)
                                    .lineLimit(1)
                                Button("undo Decision") {
                                    Task { await clear(it) }
                                }
                                .font(.system(size: 11))
                                .foregroundStyle(FlowTheme.muted)
                                .underline()
                            }
                            Spacer()
                            Button("Gone") {
                                Task { await archive(it) }
                            }
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .foregroundStyle(FlowTheme.cream)
                            .background(FlowTheme.ink, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .padding(8)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))
                    }
                }
                if !gone.isEmpty {
                    Button {
                        showGone.toggle()
                    } label: {
                        HStack {
                            Image(systemName: showGone ? "chevron.down" : "chevron.right")
                            Text(decision == .sell ? "Sold" : "Gone")
                                .font(.system(size: 13, weight: .semibold, design: .rounded))
                            Text("\(gone.count)").foregroundStyle(FlowTheme.muted)
                        }
                    }
                    .buttonStyle(.plain)
                    if showGone {
                        ForEach(gone) { it in
                            HStack {
                                RemotePhoto(storageKey: it.imageKey, api: session.api, cornerRadius: 6)
                                    .frame(width: 40, height: 40)
                                Text(it.name).font(.system(size: 13)).lineLimit(1)
                                Spacer()
                                Button("Restore") {
                                    Task { await restore(it) }
                                }
                                .font(.system(size: 11))
                                .underline()
                            }
                        }
                    }
                }
            }
        }
        .onAppear { showGone = live.isEmpty }
    }

    private func archive(_ it: FlowItem) async {
        guard let api = session.api else { return }
        do {
            try await api.itemsSetArchived(id: it.id, archived: true)
            await session.refresh()
        } catch { self.error = error.localizedDescription }
    }

    private func clear(_ it: FlowItem) async {
        guard let api = session.api else { return }
        do {
            try await api.itemsSetDecision(id: it.id, decision: nil)
            await session.refresh()
        } catch { self.error = error.localizedDescription }
    }

    private func restore(_ it: FlowItem) async {
        guard let api = session.api else { return }
        do {
            try await api.itemsSetArchived(id: it.id, archived: false)
            await session.refresh()
        } catch { self.error = error.localizedDescription }
    }
}
