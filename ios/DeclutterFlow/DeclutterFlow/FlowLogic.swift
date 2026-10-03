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
        item.roomId != nil
    }

    /// Floors in building order: the default floors in their own order, then the rest by name.
    static func sortFloors(_ floors: [String]) -> [String] {
        let order = FlowTheme.defaultFloors
        func rank(_ f: String) -> Int { order.firstIndex(of: f.lowercased()) ?? order.count }
        return Array(Set(floors)).sorted { rank($0) != rank($1) ? rank($0) < rank($1) : $0 < $1 }
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
