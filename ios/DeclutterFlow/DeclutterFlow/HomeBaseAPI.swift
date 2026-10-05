import Foundation

/// Encodes nil as JSON `null`. Synthesized Encodable leaves a nil Optional out,
/// and the server then reads "missing" instead of "clear it".
struct Nullable<Wrapped: Encodable>: Encodable {
    let value: Wrapped?
    init(_ value: Wrapped?) { self.value = value }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        if let value { try c.encode(value) } else { try c.encodeNil() }
    }
}

/// Typed HomeBase calls used by Flow. Shapes match `api/routers/*`.
actor HomeBaseAPI {
    private let client: TRPCClient
    let baseURL: URL
    let token: String

    init(baseURL: URL, token: String, houseId: Int?) {
        self.baseURL = baseURL
        self.token = token
        self.client = TRPCClient(baseURL: baseURL, token: token, houseId: houseId)
    }

    func ping() async throws -> PingResult {
        try await client.query("ping", as: PingResult.self)
    }

    func inboxList() async throws -> [FlowCapture] {
        try await client.query("inbox.list", as: [FlowCapture].self)
    }

    func inboxCreate(kind: CaptureKind, storageKey: String? = nil, fileName: String? = nil, mimeType: String? = nil, rawText: String? = nil, url: String? = nil) async throws -> InboxCreateResult {
        struct Input: Encodable {
            var kind: String
            var storageKey: String?
            var fileName: String?
            var mimeType: String?
            var rawText: String?
            var url: String?
        }
        return try await client.mutation(
            "inbox.create",
            input: Input(kind: kind.rawValue, storageKey: storageKey, fileName: fileName, mimeType: mimeType, rawText: rawText, url: url),
            as: InboxCreateResult.self
        )
    }

    func inboxTriage(id: Int) async throws -> TriageResult {
        struct Input: Encodable { var id: Int }
        return try await client.mutation("inbox.triage", input: Input(id: id), as: TriageResult.self)
    }

    func inboxAcceptMany(id: Int, roomId: Int?, items: [AcceptItemInput]) async throws -> AcceptManyResult {
        struct Input: Encodable {
            var id: Int
            var roomId: Int?
            var items: [AcceptItemInput]
        }
        return try await client.mutationKeepingNulls(
            "inbox.acceptMany",
            input: Input(id: id, roomId: roomId, items: items),
            as: AcceptManyResult.self
        )
    }

    func inboxDismiss(id: Int) async throws {
        struct Input: Encodable { var id: Int }
        _ = try await client.mutation("inbox.dismiss", input: Input(id: id), as: OkResult.self)
    }

    func itemsListAll(includeArchived: Bool) async throws -> [FlowItem] {
        struct Input: Encodable { var includeArchived: Bool }
        return try await client.query("items.listAll", input: Input(includeArchived: includeArchived), as: [FlowItem].self)
    }

    /// Put a Thing in a room; nil unplaces it within its house.
    func itemsUpdate(id: Int, roomId: Int?) async throws {
        struct Input: Encodable {
            var id: Int
            var roomId: Nullable<Int>
        }
        _ = try await client.mutationKeepingNulls("items.update", input: Input(id: id, roomId: Nullable(roomId)), as: OkResult.self)
    }

    func itemsSetVerification(id: Int, status: VerificationStatus) async throws {
        struct Input: Encodable {
            var id: Int
            var verificationStatus: String
        }
        _ = try await client.mutation(
            "items.setVerification",
            input: Input(id: id, verificationStatus: status.rawValue),
            as: OkResult.self
        )
    }

    func itemsSetArchived(id: Int, archived: Bool) async throws {
        struct Input: Encodable {
            var id: Int
            var archived: Bool
        }
        _ = try await client.mutation("items.setArchived", input: Input(id: id, archived: archived), as: OkResult.self)
    }

    func itemsSetDecision(id: Int, decision: ItemDecision?) async throws {
        struct Input: Encodable {
            var id: Int
            var decision: Nullable<String>
        }
        _ = try await client.mutationKeepingNulls(
            "items.setDecision",
            input: Input(id: id, decision: Nullable(decision?.rawValue)),
            as: OkResult.self
        )
    }

    func itemsPatchAttributes(id: Int, set: [String: String?]) async throws {
        struct Input: Encodable {
            var id: Int
            var set: [String: String?]
        }
        _ = try await client.mutation("items.patchAttributes", input: Input(id: id, set: set), as: OkResult.self)
    }

    func housesList() async throws -> [FlowHouse] {
        try await client.query("houses.list", as: [FlowHouse].self)
    }

    func areasList() async throws -> [FlowArea] {
        try await client.query("areas.list", as: [FlowArea].self)
    }

    /// Every house's rooms: the picker shows house chips, and labels need rooms of every house.
    func roomsList() async throws -> [FlowRoom] {
        struct Input: Encodable { var houseId: Nullable<Int> }
        return try await client.query("rooms.list", input: Input(houseId: Nullable<Int>(nil)), keepNulls: true, as: [FlowRoom].self)
    }

    /// Find-or-create a room by name in a house.
    func roomsEnsure(name: String, floor: String?, houseId: Int) async throws -> EnsureRoomResult {
        struct Input: Encodable {
            var name: String
            var floor: String?
            var houseId: Int
        }
        return try await client.mutation("rooms.ensure", input: Input(name: name, floor: floor, houseId: houseId), as: EnsureRoomResult.self)
    }

    func photosURL(key: String) async throws -> PhotoURL {
        struct Input: Encodable { var key: String }
        return try await client.query("photos.url", input: Input(key: key), as: PhotoURL.self)
    }

    func roomsGet(id: Int) async throws -> RoomInfo? {
        struct Input: Encodable { var id: Int }
        return try await client.query("rooms.get", input: Input(id: id), as: RoomInfo?.self)
    }

    /// Store a LiDAR (RoomPlan) scan as a room's plan. The server matches by houseId + name,
    /// so pass the picked room's own name to update it instead of creating a second room.
    /// `objects` (RoomPlan's furniture) become detected Things, merged like a GeoJSON rescan.
    func roomsUpsertFromScan(houseId: Int, name: String, floor: String?, geometry: RoomGeometryPayload) async throws -> UpsertScanResult {
        struct Geometry: Encodable {
            var walls: [RoomWall]
            var openings: [RoomOpening]
        }
        struct Input: Encodable {
            var houseId: Int
            var name: String
            var source: String
            var widthM: Double
            var depthM: Double
            var wallHeightM: Double
            var floor: String?
            var geometry: Geometry
            var objects: [ScanObjectPayload]
        }
        return try await client.mutation(
            "rooms.upsertFromScan",
            input: Input(
                houseId: houseId,
                name: name,
                source: "roomplan",
                widthM: geometry.widthM,
                depthM: geometry.depthM,
                wallHeightM: geometry.wallHeightM,
                floor: floor,
                geometry: Geometry(walls: geometry.walls, openings: geometry.openings),
                objects: geometry.objects
            ),
            as: UpsertScanResult.self
        )
    }

    func uploadInboxPhoto(jpeg: Data, fileName: String) async throws -> UploadedFile {
        try await client.upload(file: jpeg, fileName: fileName, mimeType: "image/jpeg", scope: "inbox")
    }

    func download(_ url: URL) async throws -> Data {
        try await client.data(for: url)
    }

    func resolvePhotoURL(_ relativeOrAbsolute: String) -> URL? {
        if let abs = URL(string: relativeOrAbsolute), abs.scheme != nil { return abs }
        let path = relativeOrAbsolute.hasPrefix("/") ? String(relativeOrAbsolute.dropFirst()) : relativeOrAbsolute
        return path.split(separator: "/").reduce(baseURL) { $0.appendingPathComponent(String($1)) }
    }
}
