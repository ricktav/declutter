import Foundation
import Combine

@MainActor
final class FlowSession: ObservableObject {
    @Published var items: [FlowItem] = []
    @Published var captures: [FlowCapture] = []
    @Published var houses: [FlowHouse] = []
    @Published var areas: [FlowArea] = []
    @Published var locations: [FlowLocation] = []
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
            async let locationsTask = api.mapListLocations()
            items = try await itemsTask
            captures = try await capturesTask
            houses = try await housesTask
            areas = try await areasTask
            locations = try await locationsTask
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
