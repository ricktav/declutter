import SwiftUI

private enum SortFilter: String, CaseIterable, Identifiable {
    case all, capture, check, place
    var id: String { rawValue }
    var label: String {
        switch self {
        case .all: return "All"
        case .capture: return "Photos"
        case .check: return "Check"
        case .place: return "Place"
        }
    }
}

private enum SortCard: Identifiable {
    case capture(FlowCapture)
    case check(FlowItem)
    case place(FlowItem)

    var id: String {
        switch self {
        case .capture(let c): return "c\(c.id)"
        case .check(let i): return "k\(i.id)"
        case .place(let i): return "p\(i.id)"
        }
    }

    var kind: SortFilter {
        switch self {
        case .capture: return .capture
        case .check: return .check
        case .place: return .place
        }
    }
}

struct SortView: View {
    @EnvironmentObject private var session: FlowSession
    @State private var filter: SortFilter = .all
    @State private var skipped: [String] = []

    private var cards: [SortCard] {
        let captures = session.pendingCaptures
            .sorted { FlowLogic.sortRank($0) < FlowLogic.sortRank($1) }
            .map { SortCard.capture($0) }
        let checks = session.visibleItems.filter(FlowLogic.needsCheck).map { SortCard.check($0) }
        let places = session.visibleItems.filter(FlowLogic.isUnplaced).map { SortCard.place($0) }
        return captures + checks + places
    }

    private func count(_ f: SortFilter) -> Int {
        f == .all ? cards.count : cards.filter { $0.kind == f }.count
    }

    private var ordered: [SortCard] {
        let visible = cards.filter { filter == .all || $0.kind == filter }
        return visible.filter { !skipped.contains($0.id) } + visible.filter { skipped.contains($0.id) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(SortFilter.allCases) { f in
                        Chip(title: "\(f.label) \(count(f))", selected: filter == f) { filter = f }
                    }
                }
            }

            if !session.ready {
                Text("Loading…")
                    .font(.system(size: 13))
                    .foregroundStyle(FlowTheme.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            } else if let card = ordered.first {
                Group {
                    switch card {
                    case .capture(let c):
                        CaptureCard(capture: c, onSkip: { skip(card) })
                    case .check(let i):
                        CheckCard(item: i, onSkip: { skip(card) })
                    case .place(let i):
                        PlaceCard(item: i, onSkip: { skip(card) })
                    }
                }
                .id(card.id)
                Text("\(ordered.count) left in this list")
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(FlowTheme.muted)
                    .frame(maxWidth: .infinity)
            } else {
                EmptyState(
                    title: "Nothing to sort",
                    caption: "Everything is named, checked and placed. Snap more Things, or go to Act to decide what stays."
                )
            }
        }
    }

    private func skip(_ card: SortCard) {
        skipped.removeAll { $0 == card.id }
        skipped.append(card.id)
    }
}

private struct CardShell<Content: View>: View {
    let question: String
    var onSkip: () -> Void
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(question)
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                Spacer()
                Button("skip", action: onSkip)
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(FlowTheme.muted)
                    .underline()
            }
            content()
        }
        .padding(12)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color(hex: 0xD5D9CD)))
        .shadow(color: .black.opacity(0.04), radius: 4, y: 2)
    }
}

private struct DraftRow: Identifiable {
    let id = UUID()
    var name: String
    var areaId: Int?
    var checked: Bool
    var attributes: [String: String]?
}

private struct CaptureCard: View {
    @EnvironmentObject private var session: FlowSession
    let capture: FlowCapture
    var onSkip: () -> Void

    @State private var rows: [DraftRow] = []
    @State private var extra = ""
    @State private var place: Place = .empty
    @State private var placeOpen = false
    @State private var error: String?
    @State private var busy = false
    @State private var asking = false

    private var suggestion: TriageSuggestion? { FlowLogic.usableSuggestion(capture) }
    private var isGeo: Bool { FlowLogic.isFloorScan(capture) }
    private var matched: [TriageSpottedItem] {
        suggestion?.items.filter { !$0.isNewItem && $0.matchedItemName != nil } ?? []
    }
    private var chosen: [DraftRow] {
        rows.filter { $0.checked && !$0.name.trimmingCharacters(in: .whitespaces).isEmpty && $0.areaId != nil }
    }

    var body: some View {
        CardShell(question: isGeo ? "A floor scan" : "What is it?", onSkip: onSkip) {
            preview
            if isGeo {
                Text("Floor scans are imported in the Workbench inbox. This Lens stays on Things you can hold.")
                    .font(.system(size: 13))
                    .foregroundStyle(FlowTheme.muted)
            } else {
                if let note = suggestion?.note, !note.isEmpty {
                    Text(note).font(.system(size: 12)).foregroundStyle(FlowTheme.muted).lineLimit(3)
                }
                if suggestion == nil {
                    Button {
                        Task { await askAI() }
                    } label: {
                        HStack {
                            if asking { ProgressView() }
                            else { Image(systemName: "sparkles") }
                            Text(asking ? "Looking at the Photo…" : "Ask AI what this is")
                                .font(.system(size: 14, weight: .semibold, design: .rounded))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .foregroundStyle(FlowTheme.moss)
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(FlowTheme.moss, style: StrokeStyle(lineWidth: 2, dash: [6]))
                        )
                    }
                    .disabled(asking)
                }
                if !matched.isEmpty {
                    Text("Already in the inventory: \(matched.compactMap(\.matchedItemName).joined(separator: ", "))")
                        .font(.system(size: 12))
                        .foregroundStyle(FlowTheme.muted)
                }
                ForEach($rows) { $row in
                    HStack(alignment: .top, spacing: 8) {
                        Toggle("", isOn: $row.checked).labelsHidden().tint(FlowTheme.moss)
                        VStack(alignment: .leading, spacing: 4) {
                            TextField("Name", text: $row.name)
                                .font(.system(size: 14, weight: .medium))
                            Picker("Kind", selection: Binding(
                                get: { row.areaId ?? session.areas.first?.id ?? 0 },
                                set: { row.areaId = $0 }
                            )) {
                                ForEach(session.areas) { a in
                                    Text(a.name).tag(a.id)
                                }
                            }
                            .pickerStyle(.menu)
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                        }
                    }
                    .padding(8)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(row.checked ? FlowTheme.moss : Color(hex: 0xD5D9CD))
                    )
                    .opacity(row.checked ? 1 : 0.6)
                }
                HStack {
                    TextField(rows.isEmpty ? "Type what it is" : "Add another Thing", text: $extra)
                        .padding(10)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(hex: 0xD5D9CD)))
                    Button {
                        let n = extra.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !n.isEmpty else { return }
                        rows.append(DraftRow(name: n, areaId: session.areas.first?.id, checked: true))
                        extra = ""
                    } label: {
                        Image(systemName: "plus")
                            .padding(10)
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(hex: 0xD5D9CD)))
                    }
                    .disabled(extra.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Button { placeOpen = true } label: {
                    HStack {
                        Image(systemName: "mappin").foregroundStyle(FlowTheme.moss)
                        Text(place.hasRoom ? FlowLogic.placeLabel(place, houses: session.houses) : "No Place yet")
                            .font(.system(size: 13))
                            .lineLimit(1)
                        Spacer()
                        Text("change").font(.system(size: 12)).foregroundStyle(FlowTheme.muted).underline()
                    }
                    .padding(10)
                    .background(Color(hex: 0xF0F2EA), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                ErrorLine(message: error)
                HStack(spacing: 8) {
                    Button {
                        Task { await file() }
                    } label: {
                        Text(busy ? "Filing…" : (chosen.count > 1 ? "File \(chosen.count) Things" : "File it"))
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .foregroundStyle(FlowTheme.cream)
                            .background(FlowTheme.ink, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .disabled(chosen.isEmpty || busy)
                    .opacity(chosen.isEmpty || busy ? 0.4 : 1)
                    Button {
                        Task { await dismiss() }
                    } label: {
                        Label("Not a Thing", systemImage: "xmark")
                            .font(.system(size: 13))
                            .foregroundStyle(FlowTheme.muted)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 14)
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))
                    }
                    .disabled(busy)
                }
            }
        }
        .onAppear { seed() }
        .onChange(of: capture.suggestion) { _, _ in
            if rows.isEmpty { seedRowsFromSuggestion() }
        }
        .sheet(isPresented: $placeOpen) {
            LocationPicker(
                title: "Where is it?",
                value: place,
                houses: session.houses,
                locations: session.locations,
                onPick: { place = $0 },
                onClose: { placeOpen = false }
            )
        }
    }

    @ViewBuilder
    private var preview: some View {
        if capture.kind == .image, capture.storageKey != nil {
            RemotePhoto(storageKey: capture.storageKey, api: session.api)
                .aspectRatio(4 / 3, contentMode: .fit)
        } else if isGeo {
            Text("GeoJSON floor scan")
                .font(.system(size: 13))
                .foregroundStyle(FlowTheme.muted)
                .frame(maxWidth: .infinity)
                .padding(24)
                .background(Color(hex: 0xF0F2EA), in: RoundedRectangle(cornerRadius: 12))
        } else if let url = capture.url {
            Text(url).font(.system(size: 14)).foregroundStyle(FlowTheme.moss).underline()
        } else {
            Text(capture.rawText ?? "(file without a preview)")
                .font(.system(size: 14))
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(hex: 0xF0F2EA), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func seed() {
        seedRowsFromSuggestion()
        if let snapped = SnapPlaceStore.get(capture.id) {
            place = snapped
        } else if let s = suggestion, let room = s.room, !room.isEmpty {
            place = Place(houseId: session.here.houseId, floor: s.floor ?? "", room: room)
        } else {
            place = session.here
        }
    }

    private func seedRowsFromSuggestion() {
        guard let suggestion else { return }
        rows = suggestion.items
            .filter { $0.isNewItem || $0.matchedItemName == nil }
            .map { s in
                DraftRow(
                    name: s.itemName,
                    areaId: session.areas.first(where: { $0.slug == s.areaSlug })?.id ?? session.areas.first?.id,
                    checked: true,
                    attributes: s.attributes
                )
            }
    }

    private func askAI() async {
        guard let api = session.api else { return }
        asking = true
        error = nil
        do {
            let res = try await api.inboxTriage(id: capture.id)
            if res.ok {
                await session.refresh()
            } else {
                error = res.error ?? "Triage failed."
            }
        } catch {
            self.error = error.localizedDescription
        }
        asking = false
    }

    private func file() async {
        guard let api = session.api else { return }
        busy = true
        error = nil
        do {
            _ = try await api.inboxAcceptMany(
                id: capture.id,
                houseId: place.houseId,
                floor: place.floor.isEmpty ? nil : place.floor,
                room: place.room.isEmpty ? nil : place.room,
                items: chosen.map {
                    AcceptItemInput(areaId: $0.areaId!, itemId: nil, itemName: $0.name.trimmingCharacters(in: .whitespaces), attributes: $0.attributes)
                }
            )
            await session.refresh()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    private func dismiss() async {
        guard let api = session.api else { return }
        busy = true
        do {
            try await api.inboxDismiss(id: capture.id)
            await session.refresh()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}

private struct CheckCard: View {
    @EnvironmentObject private var session: FlowSession
    let item: FlowItem
    var onSkip: () -> Void
    @State private var busy = false

    var body: some View {
        CardShell(question: "Is this right?", onSkip: onSkip) {
            if item.imageKey != nil {
                RemotePhoto(storageKey: item.imageKey, api: session.api)
                    .aspectRatio(4 / 3, contentMode: .fit)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(item.name).font(.system(size: 17, weight: .semibold))
                Text([item.areaName, FlowLogic.placeLabel(item, houses: session.houses)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 12))
                    .foregroundStyle(FlowTheme.muted)
                if let d = item.description, !d.isEmpty {
                    Text(d).font(.system(size: 12)).foregroundStyle(FlowTheme.muted).lineLimit(2)
                }
            }
            HStack(spacing: 8) {
                Button {
                    Task { await set(.confirmed) }
                } label: {
                    Text("Yes, it is")
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .foregroundStyle(.white)
                        .background(FlowTheme.keep, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                Button {
                    Task { await set(.rejected) }
                } label: {
                    Text("No, remove")
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .foregroundStyle(FlowTheme.toss)
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(FlowTheme.toss, lineWidth: 2))
                }
            }
            .disabled(busy)
            .opacity(busy ? 0.4 : 1)
            Text("Fix details in the Workbench")
                .font(.system(size: 12))
                .foregroundStyle(FlowTheme.muted)
                .frame(maxWidth: .infinity)
        }
    }

    private func set(_ status: VerificationStatus) async {
        guard let api = session.api else { return }
        busy = true
        do {
            try await api.itemsSetVerification(id: item.id, status: status)
            await session.refresh()
        } catch {
            busy = false
        }
    }
}

private struct PlaceCard: View {
    @EnvironmentObject private var session: FlowSession
    let item: FlowItem
    var onSkip: () -> Void
    @State private var open = false
    @State private var busy = false

    var body: some View {
        CardShell(question: "Where is it?", onSkip: onSkip) {
            RemotePhoto(storageKey: item.imageKey, api: session.api)
                .aspectRatio(4 / 3, contentMode: .fit)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.system(size: 17, weight: .semibold))
                if let a = item.areaName { Text(a).font(.system(size: 12)).foregroundStyle(FlowTheme.muted) }
            }
            if session.here.hasRoom {
                Button {
                    Task { await put(session.here) }
                } label: {
                    VStack(spacing: 2) {
                        Text("Here").font(.system(size: 14, weight: .semibold, design: .rounded))
                        Text(FlowLogic.placeLabel(session.here, houses: session.houses))
                            .font(.system(size: 12))
                            .opacity(0.75)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .foregroundStyle(FlowTheme.cream)
                    .background(FlowTheme.ink, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .disabled(busy)
            }
            Button {
                open = true
            } label: {
                Text(session.here.hasRoom ? "Another Place…" : "Pick a Place…")
                    .font(.system(size: 14))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))
            }
        }
        .sheet(isPresented: $open) {
            LocationPicker(
                title: "Where is it?",
                value: session.here,
                houses: session.houses,
                locations: session.locations,
                onPick: { p in Task { await put(p) } },
                onClose: { open = false }
            )
        }
    }

    private func put(_ p: Place) async {
        guard let api = session.api else { return }
        busy = true
        do {
            try await api.itemsUpdate(
                id: item.id,
                houseId: p.houseId,
                floor: p.floor.isEmpty ? nil : p.floor,
                room: p.room.isEmpty ? nil : p.room
            )
            await session.refresh()
        } catch {
            busy = false
        }
    }
}
