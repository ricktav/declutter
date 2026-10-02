import Foundation

/// Device-only default Place for a capture, matching `flow.snapPlace` in `src/flow/data.ts`.
enum SnapPlaceStore {
    private static let key = "flow.snapPlace"

    static func get(_ captureId: Int) -> Place? {
        guard let raw = UserDefaults.standard.dictionary(forKey: key) as? [String: [String: Any]],
              let row = raw[String(captureId)]
        else { return nil }
        let houseId = row["houseId"] as? Int
        let floor = row["floor"] as? String ?? ""
        let room = row["room"] as? String ?? ""
        return Place(houseId: houseId, floor: floor, room: room)
    }

    static func set(_ captureId: Int, place: Place) {
        var all = UserDefaults.standard.dictionary(forKey: key) as? [String: [String: Any]] ?? [:]
        var row: [String: Any] = ["floor": place.floor, "room": place.room]
        if let id = place.houseId { row["houseId"] = id }
        all[String(captureId)] = row
        UserDefaults.standard.set(all, forKey: key)
    }
}

enum HereStore {
    private static let key = "declutter.lastLocation"

    static func load() -> Place {
        guard let raw = UserDefaults.standard.dictionary(forKey: key) else { return .empty }
        return Place(
            houseId: raw["houseId"] as? Int,
            floor: raw["floor"] as? String ?? "",
            room: raw["room"] as? String ?? ""
        )
    }

    static func save(_ place: Place) {
        var row: [String: Any] = ["floor": place.floor, "room": place.room]
        if let id = place.houseId { row["houseId"] = id }
        UserDefaults.standard.set(row, forKey: key)
    }
}
