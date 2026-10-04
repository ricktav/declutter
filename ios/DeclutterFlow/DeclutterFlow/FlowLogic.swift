import Foundation

/// Mirrors `src/flow/data.ts` so Sort / Act / Find hide the same rows.
enum FlowLogic {
    /// A "Later" Decision comes back into Act after a week.
    static let laterDays = 7

    static func isReal(_ item: FlowItem) -> Bool {
        item.verificationStatus != .rejected
    }

    static func needsCheck(_ item: FlowItem) -> Bool {
        item.status == .active && item.verificationStatus == .detected
    }

    static func isUnplaced(_ item: FlowItem) -> Bool {
        item.status == .active && isReal(item) && !needsCheck(item) && !hasPlace(item)
    }

    static func hasPlace(_ item: FlowItem) -> Bool {
        let room = item.room?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !room.isEmpty || item.roomId != nil
    }

    static func needsDecision(_ item: FlowItem) -> Bool {
        guard item.status == .active, isReal(item), !needsCheck(item) else { return false }
        if item.decision == nil { return true }
        if item.decision != .later { return false }
        guard let decidedAt = item.decidedAt else { return false }
        return Date().timeIntervalSince(decidedAt) > Double(laterDays) * 86_400
    }

    static func isDecided(_ item: FlowItem) -> Bool {
        guard let d = item.decision else { return false }
        return d != .later
    }

    static func placeLabel(_ place: Place, houses: [FlowHouse]) -> String {
        placeLabel(houseId: place.houseId, floor: place.floor, room: place.room, houses: houses)
    }

    static func placeLabel(houseId: Int?, floor: String?, room: String?, houses: [FlowHouse]) -> String {
        let house = houseId.flatMap { id in houses.first(where: { $0.id == id })?.name }
        return [house, emptyToNil(floor), emptyToNil(room)].compactMap { $0 }.joined(separator: " › ")
    }

    static func placeLabel(_ item: FlowItem, houses: [FlowHouse]) -> String {
        placeLabel(houseId: item.houseId, floor: item.floor, room: item.room, houses: houses)
    }

    static func usableSuggestion(_ capture: FlowCapture) -> TriageSuggestion? {
        capture.suggestion
    }

    static func isGeojsonKey(_ key: String?) -> Bool {
        guard let key else { return false }
        return key.range(of: #"\.(geo)?json$"#, options: .regularExpression) != nil
    }

    static func isFloorScan(_ capture: FlowCapture) -> Bool {
        capture.kind == .scan || isGeojsonKey(capture.storageKey)
    }

    /// Name matches for the Sort typeahead. Active Things only, rejected hidden.
    static func matchingItems(
        _ items: [FlowItem],
        query: String,
        excluding: Set<Int> = [],
        preferHouseId: Int? = nil,
        limit: Int = 8
    ) -> [FlowItem] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard q.count >= 2 else { return [] }
        return items
            .filter { isReal($0) && $0.status == .active && !excluding.contains($0.id) }
            .compactMap { item -> (FlowItem, Int, Bool)? in
                let name = item.name.lowercased()
                guard name.contains(q) else { return nil }
                let score: Int
                if name == q { score = 0 }
                else if name.hasPrefix(q) { score = 1 }
                else { score = 2 }
                let sameHouse = preferHouseId != nil && item.houseId == preferHouseId
                return (item, score, sameHouse)
            }
            .sorted { a, b in
                if a.1 != b.1 { return a.1 < b.1 }
                if a.2 != b.2 { return a.2 }
                return a.0.name.count < b.0.name.count
            }
            .prefix(limit)
            .map(\.0)
    }

    static func itemSubtitle(_ item: FlowItem, houses: [FlowHouse]) -> String {
        [item.areaName, placeLabel(item, houses: houses)]
            .compactMap { $0 }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    static func sortRank(_ capture: FlowCapture) -> Int {
        if isFloorScan(capture) { return 2 }
        if capture.kind == .image { return 0 }
        return 1
    }

    private static func emptyToNil(_ s: String?) -> String? {
        let t = s?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? nil : t
    }
}
