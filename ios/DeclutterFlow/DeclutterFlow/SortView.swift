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

/// Skipped Sort cards, per device, in the order they were skipped (`flow.sort.skipped`).
enum SortSkipStore {
    static let key = "flow.sort.skipped"

    static func load() -> [String] {
        UserDefaults.standard.stringArray(forKey: key) ?? []
    }

    static func save(_ ids: [String]) {
        UserDefaults.standard.set(ids, forKey: key)
    }

    /// Moves `id` to the end of the stored list; built from the stored list, so skips that are
    /// not visible now (another filter, not loaded yet) keep their place. Keeps the last 300.
    static func skip(_ id: String) -> [String] {
        var ids = load().filter { $0 != id }
        ids.append(id)
        ids = Array(ids.suffix(300))
        save(ids)
        return ids
    }

    /// Drops capture cards ("c<id>") seen leaving the queue (listed with a status other than
    /// pending). A capture missing from the loaded window is kept; other cards stay.
    static func prune(handledCaptureIds: Set<Int>) -> [String] {
        let ids = load()
        let kept = ids.filter { id in
            guard id.hasPrefix("c"), let n = Int(id.dropFirst()) else { return true }
            return !handledCaptureIds.contains(n)
        }
        if kept != ids { save(kept) }
        return kept
    }
}

struct SortView: View {
    @EnvironmentObject private var session: FlowSession
    @State private var filter: SortFilter = .all
    @State private var skipped: [String] = SortSkipStore.load()
    /// A card picked from the strip; shown first until it is filed or skipped.
    @State private var picked: String?

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
        let skippedInOrder = skipped.compactMap { id in visible.first { $0.id == id } }
        let list = visible.filter { !skipped.contains($0.id) } + skippedInOrder
        if let picked, let card = list.first(where: { $0.id == picked }) {
            return [card] + list.filter { $0.id != picked }
        }
        return list
    }

    /// Pending captures for the strip: the queue order, skipped ones last in skip order.
    private var stripCaptures: [FlowCapture] {
        let all = cards.compactMap { card -> FlowCapture? in
            if case .capture(let c) = card { return c } else { return nil }
        }
        let open = all.filter { !skipped.contains("c\($0.id)") }
        let later = skipped.compactMap { id in all.first { "c\($0.id)" == id } }
        return open + later
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

            if session.ready, stripCaptures.count >= 2 {
                pickStrip
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
        .onAppear { prune() }
        .onChange(of: session.captures.filter { $0.status != .pending }.map(\.id)) { _, _ in prune() }
        .onChange(of: session.ready) { _, _ in prune() }
    }

    private var pickStrip: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Pick a Photo")
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(FlowTheme.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(stripCaptures) { cap in
                        let id = "c\(cap.id)"
                        let current = ordered.first?.id == id
                        Button {
                            pick(id)
                        } label: {
                            stripThumb(cap)
                                .frame(width: 64, height: 64)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .strokeBorder(current ? FlowTheme.ink : Color(hex: 0xD5D9CD), lineWidth: current ? 3 : 1)
                                )
                                .opacity(skipped.contains(id) && !current ? 0.6 : 1)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(current ? "Current Photo" : "Pick this Photo")
                    }
                }
                .padding(2)
            }
        }
    }

    @ViewBuilder
    private func stripThumb(_ cap: FlowCapture) -> some View {
        if cap.kind == .image, cap.storageKey != nil {
            RemotePhoto(storageKey: cap.storageKey, api: session.api, cornerRadius: 8, zoomable: false)
        } else {
            Image(systemName: FlowLogic.isFloorScan(cap) ? "map" : (cap.url != nil ? "link" : "doc.text"))
                .foregroundStyle(FlowTheme.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(hex: 0xF0F2EA), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }

    private func pick(_ id: String) {
        picked = id
        if filter != .all && filter != .capture { filter = .all }
    }

    private func skip(_ card: SortCard) {
        if picked == card.id { picked = nil }
        skipped = SortSkipStore.skip(card.id)
    }

    private func prune() {
        guard session.ready else { return }
        skipped = SortSkipStore.prune(handledCaptureIds: Set(session.captures.filter { $0.status != .pending }.map(\.id)))
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
    var box: PhotoBox? = nil
    /// The frame's number: its place among the suggestion's framed objects, so it stays the same
    /// whatever is hidden.
    var frameNumber: Int? = nil
}

/// One frame to draw on the capture Photo.
private struct FrameSpec: Identifiable {
    let id: String
    let number: Int
    let box: PhotoBox
    let name: String
    /// nil for an object already in the inventory (no row to toggle).
    let rowId: UUID?
    let checked: Bool
}

private struct CaptureCard: View {
    @EnvironmentObject private var session: FlowSession
    @EnvironmentObject private var settings: SettingsStore
    let capture: FlowCapture
    var onSkip: () -> Void

    @State private var rows: [DraftRow] = []
    @State private var extra = ""
    @State private var place: Place = .empty
    @State private var placeOpen = false
    @State private var error: String?
    @State private var busy = false
    @State private var asking = false
    /// The row whose frame was tapped last.
    @State private var highlighted: UUID?
    /// Leave out frames of rows that are unticked or already in the inventory.
    @AppStorage("flow.sort.hideHandled") private var hideHandled = true

    private var suggestion: TriageSuggestion? { FlowLogic.usableSuggestion(capture) }
    private var isGeo: Bool { FlowLogic.isFloorScan(capture) }
    private var matched: [TriageSpottedItem] {
        suggestion?.items.filter { !$0.isNewItem && $0.matchedItemName != nil } ?? []
    }
    /// Frame number per row id, 1-based, in row order; rows without a frame have none.
    /// Frame number per suggestion item index (1-based, in suggestion order, framed items only).
    private var frameNumbering: [Int: Int] {
        var out: [Int: Int] = [:]
        for (i, item) in (suggestion?.items ?? []).enumerated() where item.box != nil {
            out[i] = out.count + 1
        }
        return out
    }

    /// Names of objects already in the inventory, with their frame number when they have one.
    private var matchedLabels: [String] {
        let numbers = frameNumbering
        return (suggestion?.items ?? []).enumerated().compactMap { i, item in
            guard !item.isNewItem, let name = item.matchedItemName else { return nil }
            return numbers[i].map { "\(name) (\($0))" } ?? name
        }
    }

    private var hasFrames: Bool { suggestion?.items.contains { $0.box != nil } ?? false }

    /// Frames to draw, largest first so a small frame inside a big one stays on top.
    private var frameSpecs: [FrameSpec] {
        var out: [FrameSpec] = []
        for row in rows {
            guard let box = row.box, let n = row.frameNumber else { continue }
            if hideHandled && !row.checked { continue }
            out.append(FrameSpec(id: "r\(row.id)", number: n, box: box, name: row.name, rowId: row.id, checked: row.checked))
        }
        if !hideHandled {
            let numbers = frameNumbering
            for (i, item) in (suggestion?.items ?? []).enumerated() where !item.isNewItem && item.matchedItemName != nil {
                guard let box = item.box, let n = numbers[i] else { continue }
                out.append(FrameSpec(id: "m\(i)", number: n, box: box, name: item.matchedItemName ?? item.itemName, rowId: nil, checked: false))
            }
        }
        return out.sorted { $0.box.wPct * $0.box.hPct > $1.box.wPct * $1.box.hPct }
    }

    private var chosen: [DraftRow] {
        rows.filter { $0.checked && !$0.name.trimmingCharacters(in: .whitespaces).isEmpty && $0.areaId != nil }
    }

    var body: some View {
        CardShell(question: isGeo ? "A floor scan" : "What is it?", onSkip: onSkip) {
            preview
            if !isGeo, hasFrames {
                Toggle("Hide handled", isOn: $hideHandled)
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(FlowTheme.muted)
                    .tint(FlowTheme.moss)
                    .controlSize(.mini)
            }
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
                    Text("Already in the inventory: \(matchedLabels.joined(separator: ", "))")
                        .font(.system(size: 12))
                        .foregroundStyle(FlowTheme.muted)
                }
                ForEach($rows) { $row in
                    HStack(alignment: .top, spacing: 8) {
                        if let n = row.frameNumber {
                            FrameBadge(number: n, on: row.checked)
                                .padding(.top, 6)
                        }
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
                            .fill(highlighted == row.id ? FlowTheme.lime.opacity(0.25) : Color.clear)
                    )
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(row.checked ? FlowTheme.moss : Color(hex: 0xD5D9CD), lineWidth: highlighted == row.id ? 2 : 1)
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
                rooms: session.rooms,
                defaultHouseId: session.here.houseId ?? settings.houseId,
                onCreate: { name, floor, houseId in try await session.ensureRoom(name: name, floor: floor, houseId: houseId) },
                onPick: { place = $0 },
                onClose: { placeOpen = false }
            )
        }
    }

    @ViewBuilder
    private var preview: some View {
        if capture.kind == .image, capture.storageKey != nil {
            FittedRemotePhoto(storageKey: capture.storageKey, api: session.api) { size in
                frames(in: size)
            }
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

    /// The frames, at the same place on the image at any size. Only a frame's border (16 pt
    /// wide) and its number take a tap, which toggles and highlights the row; a tap inside the
    /// frame reaches the Photo and opens the viewer.
    private func frames(in size: CGSize) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(frameSpecs) { f in
                let r = f.box.rect(in: size)
                let lit = f.rowId != nil && highlighted == f.rowId
                let w = max(r.width, 22)
                let h = max(r.height, 22)
                ZStack(alignment: .topLeading) {
                    Rectangle()
                        .strokeBorder(
                            f.checked ? FlowTheme.lime : Color.white.opacity(0.85),
                            style: StrokeStyle(lineWidth: lit ? 3 : 2, dash: f.checked ? [] : [5, 3])
                        )
                        .background(lit ? FlowTheme.lime.opacity(0.15) : Color.clear)
                        .contentShape(Rectangle().stroke(lineWidth: 16))
                        .onTapGesture { if let id = f.rowId { toggle(id) } }
                    FrameBadge(number: f.number, on: f.checked)
                        .offset(x: -2, y: -2)
                        .contentShape(Rectangle())
                        .onTapGesture { if let id = f.rowId { toggle(id) } }
                }
                .shadow(color: .black.opacity(0.35), radius: 1)
                .allowsHitTesting(f.rowId != nil)
                .frame(width: w, height: h)
                .position(x: r.midX, y: r.midY)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Frame \(f.number): \(f.name)")
                .accessibilityAddTraits(f.rowId != nil ? .isButton : [])
                .accessibilityAction { if let id = f.rowId { toggle(id) } }
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
    }

    private func toggle(_ id: UUID) {
        guard let i = rows.firstIndex(where: { $0.id == id }) else { return }
        rows[i].checked.toggle()
        highlighted = id
    }

    private func seed() {
        seedRowsFromSuggestion()
        if let snapped = SnapPlaceStore.get(capture.id) {
            place = snapped
        } else if let rid = suggestion?.roomId, let r = session.rooms.first(where: { $0.id == rid }) {
            place = Place(room: r)
        } else {
            place = session.here
        }
    }

    private func seedRowsFromSuggestion() {
        guard let suggestion else { return }
        let numbers = frameNumbering
        rows = suggestion.items.enumerated()
            .filter { $0.element.isNewItem || $0.element.matchedItemName == nil }
            .map { i, s in
                DraftRow(
                    name: s.itemName,
                    areaId: session.areas.first(where: { $0.slug == s.areaSlug })?.id ?? session.areas.first?.id,
                    checked: true,
                    attributes: s.attributes,
                    box: s.box,
                    frameNumber: numbers[i]
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
                roomId: place.roomId,
                items: chosen.map {
                    AcceptItemInput(
                        areaId: $0.areaId!,
                        itemId: nil,
                        itemName: $0.name.trimmingCharacters(in: .whitespaces),
                        attributes: $0.attributes,
                        box: $0.box
                    )
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

/// The number shared by a frame on the Photo and its row.
private struct FrameBadge: View {
    let number: Int
    let on: Bool

    var body: some View {
        Text("\(number)")
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundStyle(FlowTheme.ink)
            .frame(minWidth: 18, minHeight: 18)
            .background(on ? FlowTheme.lime : Color.white, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
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
    @EnvironmentObject private var settings: SettingsStore
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
                rooms: session.rooms,
                defaultHouseId: session.here.houseId ?? settings.houseId,
                onCreate: { name, floor, houseId in try await session.ensureRoom(name: name, floor: floor, houseId: houseId) },
                onPick: { p in Task { await put(p) } },
                onClose: { open = false }
            )
        }
    }

    private func put(_ p: Place) async {
        guard let api = session.api, p.hasRoom else { return }
        busy = true
        do {
            try await api.itemsUpdate(id: item.id, roomId: p.roomId)
            await session.refresh()
        } catch {
            busy = false
        }
    }
}
