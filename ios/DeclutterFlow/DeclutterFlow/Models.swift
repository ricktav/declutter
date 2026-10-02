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

struct Place: Codable, Hashable, Equatable {
    var houseId: Int?
    var floor: String
    var room: String

    static let empty = Place(houseId: nil, floor: "", room: "")

    var hasRoom: Bool { !room.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

struct FlowHouse: Codable, Identifiable, Hashable {
    let id: Int
    var name: String
    var address: String?
    var floors: [String]?
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

struct FlowLocation: Codable, Hashable, Identifiable {
    var houseId: Int?
    var floor: String?
    var room: String
    var count: Int
    var houseName: String?

    var id: String { "\(houseId ?? 0)|\(floor ?? "")|\(room)" }
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
    var floor: String?
    var room: String?
    var decision: ItemDecision?
    var decidedAt: Date?
    var createdAt: Date?
    var updatedAt: Date?
    var archivedAt: Date?
    var imageKey: String?
    var areaName: String?
    var areaSlug: String?
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
    var items: [TriageSpottedItem] = []

    enum CodingKeys: String, CodingKey { case note, floor, room, items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        floor = try c.decodeIfPresent(String.self, forKey: .floor)
        room = try c.decodeIfPresent(String.self, forKey: .room)
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

struct AttachmentURL: Codable {
    var url: String?
}

struct RoomInfo: Codable, Identifiable {
    var id: Int
    var name: String
    var houseId: Int?
    var items: [RoomItem]?
}

struct RoomItem: Codable, Identifiable {
    var id: Int
    var name: String
}

struct AcceptItemInput: Encodable {
    var areaId: Int
    var itemId: Int?
    var itemName: String
    var attributes: [String: String]?
}

enum SellKeys {
    static let askPrice = "sell.ask_price"
    static let channel = "sell.channel"
    static let listedAt = "sell.listed_at"
    static let soldPrice = "sell.sold_price"
    static let soldAt = "sell.sold_at"
    static let donateTo = "donate.to"
}
