import Foundation
import Combine

@MainActor
final class FlowSession: ObservableObject {
    @Published var items: [FlowItem] = []
    @Published var captures: [FlowCapture] = []
    @Published var houses: [FlowHouse] = []
    @Published var areas: [FlowArea] = []
    @Published var rooms: [FlowRoom] = []
    @Published var here: Place = HereStore.load()
    @Published var ready = false
    @Published var loading = false
    @Published var errorMessage: String?
    @Published var needsAuth = false

    private(set) var api: HomeBaseAPI?

    var visibleItems: [FlowItem] {
        items.filter(FlowLogic.isReal)
    }

    var pendingCaptures: [FlowCapture] {
        captures.filter { $0.status == .pending }
    }

    var sortCount: Int {
        pendingCaptures.count
            + visibleItems.filter(FlowLogic.needsCheck).count
            + visibleItems.filter(FlowLogic.isUnplaced).count
    }

    func setHere(_ place: Place) {
        here = place
        HereStore.save(place)
    }

    /// Find-or-create a room (`rooms.ensure`), then reload rooms so pickers and labels see it.
    func ensureRoom(name: String, floor: String?, houseId: Int) async throws -> Place {
        guard let api else { throw APIError.message("Set a server address in Settings.") }
        let res = try await api.roomsEnsure(name: name, floor: floor, houseId: houseId)
        rooms = try await api.roomsList()
        if let r = rooms.first(where: { $0.id == res.id }) { return Place(room: r) }
        return Place(roomId: res.id, houseId: houseId, floor: floor ?? "", room: name)
    }

    func attach(settings: SettingsStore) {
        do {
            api = try settings.makeAPI()
            PhotoCache.shared.clear()
        } catch {
            api = nil
        }
    }

    func refresh() async {
        guard let api else {
            errorMessage = "Set a server address in Settings."
            ready = false
            return
        }
        loading = true
        errorMessage = nil
        needsAuth = false
        do {
            async let itemsTask = api.itemsListAll(includeArchived: true)
            async let capturesTask = api.inboxList()
            async let housesTask = api.housesList()
            async let areasTask = api.areasList()
            async let roomsTask = api.roomsList()
            items = try await itemsTask
            captures = try await capturesTask
            houses = try await housesTask
            areas = try await areasTask
            rooms = try await roomsTask
            ready = true
        } catch let err as APIError {
            if err.isUnauthorized {
                needsAuth = true
                errorMessage = "This server asks for its app token."
            } else {
                errorMessage = err.localizedDescription
            }
            ready = false
        } catch {
            errorMessage = error.localizedDescription
            ready = false
        }
        loading = false
    }
}
