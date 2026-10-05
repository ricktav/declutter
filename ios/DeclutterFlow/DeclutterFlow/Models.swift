import Foundation

enum ItemDecision: String, Codable, CaseIterable, Identifiable, Hashable {
    case keep, sell, donate, toss, later
    var id: String { rawValue }
}

enum ItemStatus: String, Codable {
    case active, archived
}

enum VerificationStatus: String, Codable {
    case detected, confirmed, rejected
}

enum CaptureKind: String, Codable {
    case note, link, image, file, scan, voice
}

enum CaptureStatus: String, Codable {
    case pending, triaged, dismissed, processed
}

/// A place is a room (AGENTS.md: Flow's `Place = { roomId }`). `houseId`, `floor`
/// and `room` are display copies taken from `rooms.list` when the place was picked.
struct Place: Codable, Hashable, Equatable {
    var roomId: Int?
    var houseId: Int?
    var floor: String
    var room: String

    static let empty = Place(roomId: nil, houseId: nil, floor: "", room: "")

    var hasRoom: Bool { roomId != nil }
}

extension Place {
    init(room r: FlowRoom) {
        self.init(roomId: r.id, houseId: r.houseId, floor: r.floor ?? "", room: r.name)
    }
}

struct FlowHouse: Codable, Identifiable, Hashable {
    let id: Int
    var name: String
    var address: String?
    var itemCount: Int?
}

struct FlowArea: Codable, Identifiable, Hashable {
    let id: Int
    var slug: String
    var name: String
    var icon: String?
    var color: String?
    var description: String?
    var itemCount: Int?
}

/// A row of `rooms.list`.
struct FlowRoom: Codable, Identifiable, Hashable {
    let id: Int
    var houseId: Int
    var name: String
    var floor: String?
    var parentRoomId: Int?
    var hasGeometry: Bool
    var itemCount: Int
    var widthM: Double?
    var depthM: Double?

    /// The app's one "has a plan" rule (see `RoomPlanRule`), as far as `rooms.list` can tell:
    /// it sends `hasGeometry` (walls stored) but not the walls themselves.
    var hasPlan: Bool { RoomPlanRule.hasPlan(widthM: widthM, depthM: depthM, hasWalls: hasGeometry) }
}

/// A Place has a plan when it has walls and a size above 10 cm each way. Find, Snap,
/// the scan screen and the Place sheet all use this rule.
enum RoomPlanRule {
    static func hasPlan(widthM: Double?, depthM: Double?, hasWalls: Bool) -> Bool {
        hasWalls && (widthM ?? 0) > 0.1 && (depthM ?? 0) > 0.1
    }
}

/// The room `items.listAll` joins onto each Thing.
struct FlowRoomRef: Codable, Hashable {
    let id: Int
    var name: String
    var floor: String?
    var houseId: Int
    var hasGeometry: Bool?
}

struct EnsureRoomResult: Codable {
    var id: Int
    var created: Bool
}

struct FlowItem: Codable, Identifiable, Hashable {
    let id: Int
    var areaId: Int
    var houseId: Int?
    var roomId: Int?
    var parentId: Int?
    var name: String
    var description: String?
    var status: ItemStatus
    var verificationStatus: VerificationStatus
    var attributes: [String: AttributeValue]?
    /// `items.listAll` sends the room as an object, `room: {id, name, floor, houseId, hasGeometry}`.
    var roomRef: FlowRoomRef?
    var decision: ItemDecision?
    var decidedAt: Date?
    var createdAt: Date?
    var updatedAt: Date?
    var archivedAt: Date?
    var imageKey: String?
    var areaName: String?
    var areaSlug: String?

    enum CodingKeys: String, CodingKey {
        case id, areaId, houseId, roomId, parentId, name, description, status, verificationStatus, attributes
        case roomRef = "room"
        case decision, decidedAt, createdAt, updatedAt, archivedAt, imageKey, areaName, areaSlug
    }

    /// Room name and floor for labels and search.
    var room: String? { roomRef?.name }
    var floor: String? { roomRef?.floor }
}

enum AttributeValue: Codable, Hashable {
    case string(String)
    case number(Double)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else {
            self = .string("")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        }
    }

    var string: String {
        switch self {
        case .string(let s): return s
        case .number(let n):
            return n.rounded() == n ? String(Int(n)) : String(n)
        }
    }

    var number: Double? {
        switch self {
        case .number(let n): return n
        case .string(let s): return Double(s.replacingOccurrences(of: ",", with: "."))
        }
    }
}

struct FlowCapture: Codable, Identifiable, Hashable {
    let id: Int
    var kind: CaptureKind
    var rawText: String?
    var url: String?
    var storageKey: String?
    var contentHash: String?
    var status: CaptureStatus
    var suggestion: TriageSuggestion?
    var createdAt: Date?
}

struct TriageSuggestion: Codable, Hashable {
    var note: String?
    var floor: String?
    var room: String?
    /// The suggested room resolved within the session house (`x-house-id`); nil when there is no such room yet.
    var roomId: Int?
    var items: [TriageSpottedItem] = []

    enum CodingKeys: String, CodingKey { case note, floor, room, roomId, items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        floor = try c.decodeIfPresent(String.self, forKey: .floor)
        room = try c.decodeIfPresent(String.self, forKey: .room)
        roomId = try c.decodeIfPresent(Int.self, forKey: .roomId)
        items = try c.decodeIfPresent([TriageSpottedItem].self, forKey: .items) ?? []
    }
}

struct TriageSpottedItem: Codable, Hashable {
    var itemName: String
    var areaSlug: String
    var matchedItemId: Int?
    var matchedItemName: String?
    var isNewItem: Bool
    var attributes: [String: String]?
    var confidence: String?
    /// Where the AI saw it on the Photo; nil when the model gave no frame.
    var box: PhotoBox?

    enum CodingKeys: String, CodingKey {
        case itemName, areaSlug, matchedItemId, matchedItemName, isNewItem, attributes, confidence, box
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemName = try c.decode(String.self, forKey: .itemName)
        areaSlug = try c.decode(String.self, forKey: .areaSlug)
        matchedItemId = try c.decodeIfPresent(Int.self, forKey: .matchedItemId)
        matchedItemName = try c.decodeIfPresent(String.self, forKey: .matchedItemName)
        isNewItem = try c.decode(Bool.self, forKey: .isNewItem)
        attributes = try c.decodeIfPresent([String: String].self, forKey: .attributes)
        confidence = try c.decodeIfPresent(String.self, forKey: .confidence)
        // A malformed frame drops the frame, never the suggestion.
        if let b = try? c.decodeIfPresent(PhotoBox.self, forKey: .box), b.isUsable {
            box = b
        } else {
            box = nil
        }
    }
}

/// A frame on a Photo: centre x/y and width/height in percent of the image (the `CropBox`
/// convention of `pins.detect`).
struct PhotoBox: Codable, Hashable {
    var xPct: Double
    var yPct: Double
    var wPct: Double
    var hPct: Double

    /// The frame in a view of `size` that shows the whole image (aspect-fit, same aspect).
    func rect(in size: CGSize) -> CGRect {
        CGRect(
            x: (xPct - wPct / 2) / 100 * size.width,
            y: (yPct - hPct / 2) / 100 * size.height,
            width: wPct / 100 * size.width,
            height: hPct / 100 * size.height
        )
    }

    var isUsable: Bool {
        [xPct, yPct, wPct, hPct].allSatisfy { $0.isFinite } && wPct > 0 && hPct > 0
    }
}

struct UploadedFile: Codable {
    var key: String
    var size: Int
    var mimeType: String
    var fileName: String
    var contentHash: String?
}

struct PingResult: Codable {
    var ok: Bool
    var ts: Double?
}

struct InboxCreateResult: Codable {
    var id: Int
    var storageKey: String?
}

struct TriageResult: Codable {
    var ok: Bool
    var suggestion: TriageSuggestion?
    var error: String?
    var retryable: Bool?
}

struct AcceptManyResult: Codable {
    var ok: Bool
    var created: Int?
}

struct OkResult: Codable {
    var ok: Bool
}

struct PhotoURL: Codable { var url: String? }

/// One polyline of a room plan, in metres from the room's origin (`RoomGeometry.walls`).
struct RoomWall: Codable, Hashable {
    var points: [[Double]]
    /// "wall", "door" or "window"; absent means "wall".
    var kind: String?
}

/// An edge-based opening (`RoomGeometry.openings`). RoomPlan scans send none.
struct RoomOpening: Codable, Hashable {
    var edge: String
    var offsetM: Double
    var widthM: Double
    var connectsTo: Int?
}

/// A Thing's footprint on its room's plan (`items.pos`).
struct ItemPos: Codable, Hashable {
    var xM: Double
    var yM: Double
    var wM: Double
    var dM: Double
    var rotDeg: Double
    var hM: Double?
    /// Height of the footprint's base above the floor; sent back unchanged on a move.
    var baseM: Double?
}

/// `rooms.get`: the room row plus its Things. Geometry fields decode leniently,
/// so a room imported from another source (MappedIn) never breaks the sheet.
struct RoomInfo: Codable, Identifiable {
    var id: Int
    var name: String
    var houseId: Int?
    var floor: String?
    var source: String?
    var widthM: Double?
    var depthM: Double?
    var wallHeightM: Double?
    var walls: [RoomWall]?
    var openings: [RoomOpening]?
    var items: [RoomItem]?

    enum CodingKeys: String, CodingKey {
        case id, name, houseId, floor, source, widthM, depthM, wallHeightM, walls, openings, items
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        houseId = try c.decodeIfPresent(Int.self, forKey: .houseId)
        floor = try? c.decodeIfPresent(String.self, forKey: .floor)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        widthM = try? c.decodeIfPresent(Double.self, forKey: .widthM)
        depthM = try? c.decodeIfPresent(Double.self, forKey: .depthM)
        wallHeightM = try? c.decodeIfPresent(Double.self, forKey: .wallHeightM)
        walls = try? c.decodeIfPresent([RoomWall].self, forKey: .walls)
        openings = try? c.decodeIfPresent([RoomOpening].self, forKey: .openings)
        items = try c.decodeIfPresent([RoomItem].self, forKey: .items)
    }

    var hasPlan: Bool {
        RoomPlanRule.hasPlan(widthM: widthM, depthM: depthM, hasWalls: !(walls ?? []).isEmpty)
    }

    var geometryPayload: RoomGeometryPayload? {
        guard hasPlan, let w = widthM, let d = depthM, let walls else { return nil }
        return RoomGeometryPayload(
            walls: walls,
            openings: openings ?? [],
            widthM: w,
            depthM: d,
            wallHeightM: wallHeightM ?? 2.4
        )
    }
}

/// A Thing in `rooms.get`: the full item row (verification, status, attributes) plus its footprint.
struct RoomItem: Codable, Identifiable, Hashable {
    var id: Int
    var name: String
    var pos: ItemPos?
    var verificationStatus: VerificationStatus?
    var status: ItemStatus?
    var attributes: [String: AttributeValue]?

    enum CodingKeys: String, CodingKey { case id, name, pos, verificationStatus, status, attributes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        pos = try? c.decodeIfPresent(ItemPos.self, forKey: .pos)
        verificationStatus = try? c.decodeIfPresent(VerificationStatus.self, forKey: .verificationStatus)
        status = try? c.decodeIfPresent(ItemStatus.self, forKey: .status)
        attributes = try? c.decodeIfPresent([String: AttributeValue].self, forKey: .attributes)
    }

    /// A scan or AI made it and nobody confirmed it yet: the plan draws it dimmed and dashed.
    var isDetected: Bool { verificationStatus == .detected }

    /// Shown on the plan: active and not rejected (Flow never shows rejected Things).
    var isOnPlan: Bool { verificationStatus != .rejected && status != .archived }
}

extension RoomInfo {
    /// The Things the plan draws and lists.
    var planItems: [RoomItem] { (items ?? []).filter(\.isOnPlan) }
}

/// A row of `rooms.scans`: one recorded scan of a room, newest first.
struct RoomScanRow: Codable, Identifiable, Hashable {
    var id: Int
    var source: String
    var scanDate: Date?
    var createdAt: Date?
    var revertedAt: Date?
    var counts: ScanThingCounts
}

/// `rooms.revertScan`.
struct RevertScanResult: Codable {
    var restored: Int
    var deleted: Int
    var kept: Int
}

/// `photos.ensureForCapture`.
struct EnsurePhotoResult: Codable {
    var photoId: Int
}

/// `photos.attachToItem`.
struct AttachPhotoResult: Codable {
    var photoId: Int
    var itemId: Int
    var roomId: Int?
}

/// A room plan in metres, as drawn by `FloorPlanView` and sent to `rooms.upsertFromScan`.
struct RoomGeometryPayload: Codable, Hashable {
    var walls: [RoomWall]
    var openings: [RoomOpening]
    var widthM: Double
    var depthM: Double
    var wallHeightM: Double
    /// What RoomPlan found in the room, in the same plan frame as `walls`. Only a fresh
    /// scan carries these; a plan loaded from `rooms.get` shows its Things instead.
    var objects: [ScanObjectPayload] = []
}

/// One RoomPlan object for `rooms.upsertFromScan`'s `objects`: its footprint in the plan
/// frame (metres, origin at the room's min corner, y down the plan), like `items.pos`.
struct ScanObjectPayload: Codable, Hashable {
    /// RoomPlan's category in lower camel case (`table`, `washerDryer`, …).
    var kind: String
    /// Min corner of the unrotated footprint; it turns by `rotDeg` about its centre.
    var xM: Double
    var yM: Double
    var wM: Double
    var dM: Double
    /// Same sign as `items.pos.rotDeg`: the 2D plan draws it turned by -rotDeg (y down).
    var rotDeg: Double
    var hM: Double
}

/// `rooms.upsertFromScan` returns `{ id, created }` (created: the room row was new), plus
/// `things` when the scan sent objects: how the scan's Things merged into the room.
struct UpsertScanResult: Codable {
    var id: Int
    var created: Bool
    var things: ScanThingCounts?
}

struct ScanThingCounts: Codable, Hashable {
    var matched: Int
    var moved: Int
    var created: Int
    var missing: Int
}

struct AcceptItemInput: Encodable {
    var areaId: Int
    var itemId: Int?
    var itemName: String
    var attributes: [String: String]?
    /// The frame this Thing came from; the server pins and crops it on the capture's Photo.
    var box: PhotoBox? = nil

    enum CodingKeys: String, CodingKey { case areaId, itemId, itemName, attributes, box }

    /// The server requires `itemId` and accepts null (null = a new Thing). Synthesized
    /// Encodable would leave a nil out, which the server rejects as "Required".
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(areaId, forKey: .areaId)
        try c.encode(itemId, forKey: .itemId)
        try c.encode(itemName, forKey: .itemName)
        try c.encodeIfPresent(attributes, forKey: .attributes)
        try c.encodeIfPresent(box, forKey: .box)
    }
}

enum SellKeys {
    static let askPrice = "sell.ask_price"
    static let channel = "sell.channel"
    static let listedAt = "sell.listed_at"
    static let soldPrice = "sell.sold_price"
    static let soldAt = "sell.sold_at"
    static let donateTo = "donate.to"
}
