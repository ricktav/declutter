import Foundation

/// Place <-> a UserDefaults dictionary. A place saved before rooms had ids has
/// no `roomId`, so it loads as "no place" and the room is picked once more.
enum PlaceCoding {
    static func row(_ place: Place) -> [String: Any] {
        var row: [String: Any] = ["floor": place.floor, "room": place.room]
        if let id = place.roomId { row["roomId"] = id }
        if let id = place.houseId { row["houseId"] = id }
        return row
    }

    static func place(_ row: [String: Any]) -> Place {
        guard let roomId = row["roomId"] as? Int else { return .empty }
        return Place(
            roomId: roomId,
            houseId: row["houseId"] as? Int,
            floor: row["floor"] as? String ?? "",
            room: row["room"] as? String ?? ""
        )
    }
}

/// Device-only default Place for a capture, matching `flow.snapPlace` in `src/flow/data.ts`.
enum SnapPlaceStore {
    private static let key = "flow.snapPlace"

    static func get(_ captureId: Int) -> Place? {
        guard let raw = UserDefaults.standard.dictionary(forKey: key) as? [String: [String: Any]],
              let row = raw[String(captureId)]
        else { return nil }
        let place = PlaceCoding.place(row)
        return place.hasRoom ? place : nil
    }

    static func set(_ captureId: Int, place: Place) {
        var all = UserDefaults.standard.dictionary(forKey: key) as? [String: [String: Any]] ?? [:]
        all[String(captureId)] = PlaceCoding.row(place)
        UserDefaults.standard.set(all, forKey: key)
    }
}

enum HereStore {
    private static let key = "declutter.lastLocation"

    static func load() -> Place {
        guard let raw = UserDefaults.standard.dictionary(forKey: key) else { return .empty }
        return PlaceCoding.place(raw)
    }

    static func save(_ place: Place) {
        UserDefaults.standard.set(PlaceCoding.row(place), forKey: key)
    }
}
