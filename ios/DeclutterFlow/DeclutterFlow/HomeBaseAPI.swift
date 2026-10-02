import Foundation

/// Typed HomeBase calls used by Flow. Shapes match `api/routers/*`.
actor HomeBaseAPI {
    private let client: TRPCClient
    let baseURL: URL
    let token: String

    init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
        self.client = TRPCClient(baseURL: baseURL, token: token)
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

    func inboxAcceptMany(id: Int, houseId: Int?, floor: String?, room: String?, items: [AcceptItemInput]) async throws -> AcceptManyResult {
        struct Input: Encodable {
            var id: Int
            var houseId: Int?
            var floor: String?
            var room: String?
            var items: [AcceptItemInput]
        }
        return try await client.mutationKeepingNulls(
            "inbox.acceptMany",
            input: Input(id: id, houseId: houseId, floor: floor, room: room, items: items),
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

    func itemsUpdate(id: Int, houseId: Int?, floor: String?, room: String?) async throws {
        struct Input: Encodable {
            var id: Int
            var houseId: Int?
            var floor: String?
            var room: String?
        }
        _ = try await client.mutation(
            "items.update",
            input: Input(id: id, houseId: houseId, floor: floor, room: room),
            as: OkResult.self
        )
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
            var decision: String?
        }
        _ = try await client.mutationKeepingNulls(
            "items.setDecision",
            input: Input(id: id, decision: decision?.rawValue),
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

    func mapListLocations() async throws -> [FlowLocation] {
        try await client.query("map.listLocations", as: [FlowLocation].self)
    }

    func attachmentsURL(key: String) async throws -> AttachmentURL {
        struct Input: Encodable { var key: String }
        return try await client.query("attachments.url", input: Input(key: key), as: AttachmentURL.self)
    }

    func roomsGet(id: Int) async throws -> RoomInfo? {
        struct Input: Encodable { var id: Int }
        return try await client.query("rooms.get", input: Input(id: id), as: RoomInfo?.self)
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
