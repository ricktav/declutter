import Foundation
import Combine

@MainActor
final class SettingsStore: ObservableObject {
    private static let urlKey = "declutter.baseURL"
    private static let houseKey = "declutter.houseId"
    static let defaultBaseURL = "http://10.50.0.10:3001"

    @Published var baseURLString: String
    @Published var token: String
    @Published var lastPing: String?
    @Published var houseId: Int?

    init() {
        let saved = UserDefaults.standard.string(forKey: Self.urlKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        baseURLString = (saved?.isEmpty == false) ? saved! : Self.defaultBaseURL
        token = KeychainStore.readToken() ?? ""
        let savedHouse = UserDefaults.standard.integer(forKey: Self.houseKey)
        houseId = savedHouse > 0 ? savedHouse : nil
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
        if let houseId {
            UserDefaults.standard.set(houseId, forKey: Self.houseKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.houseKey)
        }
        objectWillChange.send()
    }

    func makeAPI() throws -> HomeBaseAPI {
        guard let url = baseURL else {
            throw APIError.invalidURL
        }
        return HomeBaseAPI(baseURL: url, token: token.trimmingCharacters(in: .whitespacesAndNewlines), houseId: houseId)
    }
}
