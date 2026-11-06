import Foundation

/// How a stored `model3dUrl` is classified and resolved. Mirrors `src/lib/model3dView.ts`.
enum Model3dFormat: String {
    case glb, gltf, usdz, js
}

enum Model3dFormatOrUnknown: Equatable {
    case known(Model3dFormat)
    case unknown
}

enum Model3dFail: Equatable {
    case unsupported
    case unreachable
    case parse
    case agent
    case usdz
}

enum Model3d {
    static let formats: [Model3dFormat] = [.glb, .gltf, .usdz, .js]

    static let copy = (
        loading: "Loading 3D model…",
        missing: "No model file yet — homebase-3d can write one later.",
        unsupported: "This model format cannot be shown here.",
        unreachable: "The 3D model could not be reached.",
        parse: "The 3D model could not be read.",
        agent: "The agent module failed to load or threw.",
        usdz: "USDZ could not be opened.",
        hasModel: "3D",
        expand: "Full screen"
    )

    /// Warm paper the Workbench viewer uses (`#f4f1ea`).
    static let backdropHex: UInt32 = 0xF4F1EA

    static func hasUrl(_ url: String?) -> Bool {
        guard let url else { return false }
        return !url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Same-origin path the server can GET, or the remote http(s) URL as stored.
    static func resolveSrc(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if s.hasPrefix("local/") {
            return "/uploads/" + s.dropFirst("local/".count)
        }
        if s.hasPrefix("/uploads/") { return s }
        if s.lowercased().hasPrefix("http://") || s.lowercased().hasPrefix("https://") { return s }
        return nil
    }

    static func format(of url: String) -> Model3dFormatOrUnknown {
        let path = url.split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init)?.lowercased() ?? url.lowercased()
        if path.hasSuffix(".glb") { return .known(.glb) }
        if path.hasSuffix(".gltf") { return .known(.gltf) }
        if path.hasSuffix(".usdz") { return .known(.usdz) }
        if path.hasSuffix(".js") || path.hasSuffix(".mjs") { return .known(.js) }
        return .unknown
    }

    /// Route-1 modules are `export function build(THREE)` (optionally async).
    static func looksLikeAgentModelModule(_ source: String) -> Bool {
        var stripped = source
        while let start = stripped.range(of: "/*") {
            if let end = stripped.range(of: "*/", range: start.upperBound..<stripped.endIndex) {
                stripped.replaceSubrange(start.lowerBound..<end.upperBound, with: "")
            } else {
                break
            }
        }
        let noLineComments = stripped.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
            .map { line -> String in
                let s = String(line)
                return s.range(of: #"^\s*//"#, options: .regularExpression) != nil ? "" : s
            }
            .joined(separator: "\n")
        return noLineComments.range(of: #"\bexport\s+(?:async\s+)?function\s+build\s*\("#, options: .regularExpression) != nil
            || noLineComments.range(of: #"\bexport\s*\{[^}]*\bbuild\b[^}]*\}"#, options: .regularExpression) != nil
    }

    static func message(for fail: Model3dFail) -> String {
        switch fail {
        case .unsupported: return copy.unsupported
        case .unreachable: return copy.unreachable
        case .parse: return copy.parse
        case .agent: return copy.agent
        case .usdz: return copy.usdz
        }
    }

    static func fail(from error: Error, format: Model3dFormatOrUnknown) -> Model3dFail {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        if message.range(of: "unsupport|format", options: [.regularExpression, .caseInsensitive]) != nil {
            return .unsupported
        }
        if message.range(of: "HTTP|fetch|network|Could not connect|timed out|offline|404|not be reached", options: [.regularExpression, .caseInsensitive]) != nil {
            return .unreachable
        }
        if case .known(.js) = format { return .agent }
        if case .known(.usdz) = format { return .usdz }
        return .parse
    }

    static func absoluteURL(src: String, baseURL: URL) -> URL? {
        if let abs = URL(string: src), abs.scheme == "http" || abs.scheme == "https" { return abs }
        let path = src.hasPrefix("/") ? String(src.dropFirst()) : src
        return path.split(separator: "/").reduce(baseURL) { $0.appendingPathComponent(String($1)) }
    }
}

extension FlowItem {
    var hasModel3d: Bool { Model3d.hasUrl(model3dUrl) }
}

extension RoomItem {
    var hasModel3d: Bool { Model3d.hasUrl(model3dUrl) }
}
