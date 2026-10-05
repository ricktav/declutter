import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case http(status: Int, message: String)
    case rpc(message: String, code: String?)
    case decode(String)
    case unauthorized
    case message(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The server address is not a valid URL."
        case .http(_, let message):
            return message
        case .rpc(let message, _):
            return message
        case .decode(let message):
            return message
        case .unauthorized:
            return "App token required"
        case .message(let message):
            return message
        }
    }

    var isUnauthorized: Bool {
        switch self {
        case .unauthorized: return true
        case .rpc(_, let code): return code == "UNAUTHORIZED"
        case .http(let status, _): return status == 401
        default: return false
        }
    }
}

/// Minimal tRPC HTTP client for HomeBase (`/api/trpc`, SuperJSON transformer).
/// Queries use GET; mutations use POST. Input is SuperJSON `{ "json": ... }`.
actor TRPCClient {
    private let baseURL: URL
    private let token: String
    private let houseId: Int?
    private let session: URLSession

    init(baseURL: URL, token: String, houseId: Int? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.houseId = houseId
        self.session = session
    }

    func query<T: Decodable>(_ path: String, input: (any Encodable)? = nil, keepNulls: Bool = false, as type: T.Type = T.self) async throws -> T {
        var components = URLComponents(url: trpcURL(path), resolvingAgainstBaseURL: false)
        if let input {
            let wrapped = try Self.encodeSuperJSON(input, stripNulls: !keepNulls)
            components?.queryItems = [URLQueryItem(name: "input", value: String(data: wrapped, encoding: .utf8))]
            // queryItems leaves "+" as is, and the server reads it as a space (a storage key may contain "+")
            let encoded = components?.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
            components?.percentEncodedQuery = encoded
        }
        guard let url = components?.url else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        applyAuth(&request)
        return try await send(request, as: type)
    }

    func mutation<T: Decodable>(_ path: String, input: (any Encodable)? = nil, as type: T.Type = T.self) async throws -> T {
        let body: Data
        if let input {
            body = try Self.encodeSuperJSON(input, stripNulls: true)
        } else {
            body = Data(#"{"json":null}"#.utf8)
        }
        return try await post(path, body: body, as: type)
    }

    /// Same as `mutation`, but keeps JSON nulls (needed for `items.setDecision` undo).
    func mutationKeepingNulls<T: Decodable>(_ path: String, input: (any Encodable), as type: T.Type = T.self) async throws -> T {
        try await post(path, body: try Self.encodeSuperJSON(input, stripNulls: false), as: type)
    }

    private func post<T: Decodable>(_ path: String, body: Data, as type: T.Type) async throws -> T {
        let url = trpcURL(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)
        request.httpBody = body
        return try await send(request, as: type)
    }

    func upload(file data: Data, fileName: String, mimeType: String, scope: String) async throws -> UploadedFile {
        let url = baseURL.appendingPathComponent("api").appendingPathComponent("upload")
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body = Data()
        body.append(multipart(boundary: boundary, name: "scope", value: scope))
        body.append(multipartFile(boundary: boundary, name: "file", fileName: fileName, mimeType: mimeType, data: data))
        body.append(Data("--\(boundary)--\r\n".utf8))
        request.httpBody = body

        let (respData, response) = try await session.data(for: request)
        try Self.throwIfHTTPError(response, data: respData)
        do {
            return try JSONDecoder().decode(UploadedFile.self, from: respData)
        } catch {
            throw APIError.decode("Upload response was not understood.")
        }
    }

    func data(for url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        applyAuth(&request)
        let (data, response) = try await session.data(for: request)
        try Self.throwIfHTTPError(response, data: data)
        return data
    }

    private func trpcURL(_ path: String) -> URL {
        path.split(separator: "/").reduce(baseURL.appendingPathComponent("api").appendingPathComponent("trpc")) {
            $0.appendingPathComponent(String($1))
        }
    }

    private func applyAuth(_ request: inout URLRequest) {
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        // the session house (AGENTS.md: x-house-id); without it, lists cover every house
        if let houseId {
            request.setValue(String(houseId), forHTTPHeaderField: "x-house-id")
        }
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            throw APIError.unauthorized
        }
        try Self.throwIfHTTPError(response, data: data)
        return try Self.decodeTRPC(data, as: type)
    }

    private static func encodeSuperJSON(_ input: any Encodable, stripNulls: Bool = true) throws -> Data {
        let json = try JSONEncoder.trpc.encode(input)
        var object = try JSONSerialization.jsonObject(with: json)
        if stripNulls { object = dropNulls(object) }
        let envelope: [String: Any] = ["json": object]
        return try JSONSerialization.data(withJSONObject: envelope)
    }

    private static func dropNulls(_ value: Any) -> Any {
        if let dict = value as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, v) in dict where !(v is NSNull) {
                out[k] = dropNulls(v)
            }
            return out
        }
        if let arr = value as? [Any] {
            return arr.map { dropNulls($0) }
        }
        return value
    }

    private static func decodeTRPC<T: Decodable>(_ data: Data, as type: T.Type) throws -> T {
        let root = try JSONSerialization.jsonObject(with: data)
        if let dict = root as? [String: Any] {
            if let error = dict["error"] {
                throw parseRPCError(error)
            }
            if let result = dict["result"] as? [String: Any], let payload = result["data"] {
                let json = unwrapSuperJSON(payload)
                if json is NSNull {
                    return try JSONDecoder.trpc.decode(type, from: Data("null".utf8))
                }
                let encoded = try JSONSerialization.data(withJSONObject: json)
                do {
                    return try JSONDecoder.trpc.decode(type, from: encoded)
                } catch {
                    throw APIError.decode("Could not read \(type): \(error.localizedDescription)")
                }
            }
        }
        throw APIError.decode("Unexpected tRPC response.")
    }

    private static func unwrapSuperJSON(_ value: Any) -> Any {
        guard let dict = value as? [String: Any], dict["json"] != nil else { return value }
        return dict["json"] as Any
    }

    private static func parseRPCError(_ value: Any) -> APIError {
        let json = unwrapSuperJSON(value)
        guard let dict = json as? [String: Any] else {
            return APIError.rpc(message: "Request failed.", code: nil)
        }
        let message = (dict["message"] as? String) ?? "Request failed."
        let data = dict["data"] as? [String: Any]
        let code = data?["code"] as? String
        if code == "UNAUTHORIZED" || message.localizedCaseInsensitiveContains("token") {
            return .unauthorized
        }
        return .rpc(message: message, code: code)
    }

    private static func throwIfHTTPError(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        if (200...299).contains(http.statusCode) { return }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let err = obj["error"], !(err is String) {
            // tRPC answers a failed procedure with HTTP 4xx and {"error":{"json":{message,code,data}}}.
            throw parseRPCError(err)
        }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = obj["error"] as? String ?? obj["message"] as? String {
            throw APIError.http(status: http.statusCode, message: message)
        }
        let text = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
        throw APIError.http(status: http.statusCode, message: text)
    }

    private func multipart(boundary: String, name: String, value: String) -> Data {
        var d = Data()
        d.append(Data("--\(boundary)\r\n".utf8))
        d.append(Data("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".utf8))
        d.append(Data("\(value)\r\n".utf8))
        return d
    }

    private func multipartFile(boundary: String, name: String, fileName: String, mimeType: String, data: Data) -> Data {
        var d = Data()
        d.append(Data("--\(boundary)\r\n".utf8))
        d.append(Data("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(fileName)\"\r\n".utf8))
        d.append(Data("Content-Type: \(mimeType)\r\n\r\n".utf8))
        d.append(data)
        d.append(Data("\r\n".utf8))
        return d
    }
}

extension JSONDecoder {
    static let trpc: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self) {
                if let date = ISO8601DateFormatter.trpc.date(from: s) { return date }
                if let date = ISO8601DateFormatter.trpcFractional.date(from: s) { return date }
            }
            if let n = try? c.decode(Double.self) {
                if n > 1_000_000_000_000 { return Date(timeIntervalSince1970: n / 1000) }
                return Date(timeIntervalSince1970: n)
            }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not a date")
        }
        return d
    }()
}

extension JSONEncoder {
    static let trpc: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = []
        return e
    }()
}

extension ISO8601DateFormatter {
    static let trpc: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static let trpcFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
