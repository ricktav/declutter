import Foundation
import Combine

@MainActor
final class SettingsStore: ObservableObject {
    private static let urlKey = "declutter.baseURL"
    static let defaultBaseURL = "http://10.50.0.10:3000"

    @Published var baseURLString: String
    @Published var token: String
    @Published var lastPing: String?

    init() {
        let saved = UserDefaults.standard.string(forKey: Self.urlKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        baseURLString = (saved?.isEmpty == false) ? saved! : Self.defaultBaseURL
        token = KeychainStore.readToken() ?? ""
    }

    var baseURL: URL? {
        let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return URL(string: trimmed)
    }

    var isConfigured: Bool {
        baseURL != nil
    }

    func save() {
        let url = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(url, forKey: Self.urlKey)
        KeychainStore.writeToken(token.trimmingCharacters(in: .whitespacesAndNewlines))
        token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        baseURLString = url
        objectWillChange.send()
    }

    func makeAPI() throws -> HomeBaseAPI {
        guard let url = baseURL else {
            throw APIError.invalidURL
        }
        return HomeBaseAPI(baseURL: url, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
