import SwiftUI

/// One Place (a room): its 2D / 3D plan from `rooms.get`, or a LiDAR scan when it has none.
struct RoomDetailView: View {
    @EnvironmentObject private var session: FlowSession
    @Environment(\.dismiss) private var dismiss

    let place: Place

    @State private var info: RoomInfo?
    @State private var loaded = false
    @State private var scan = false
    @State private var error: String?

    private var label: String {
        let l = FlowLogic.placeLabel(place, houses: session.houses)
        return l.isEmpty ? "No Place" : l
    }

    var body: some View {
        FlowSheet(title: place.room.isEmpty ? "Place" : place.room, onClose: { dismiss() }) {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Place")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(FlowTheme.muted)
                        .textCase(.uppercase)
                    Text(label)
                        .font(.system(size: 15, weight: .medium))
                    if let info {
                        Text("\(info.items?.count ?? 0) Things in this Place")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))

                if let geo = info?.geometryPayload {
                    FloorPlanView(geometry: geo, items: info?.items ?? [])
                    Button {
                        scan = true
                    } label: {
                        Label("Rescan this Place", systemImage: "cube.transparent")
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .foregroundStyle(FlowTheme.ink)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(FlowTheme.ink))
                    }
                } else if loaded {
                    EmptyState(
                        title: "No floor plan yet",
                        caption: "Scan this Place with LiDAR to add a 2D / 3D plan. Things already here stay put."
                    )
                    Button {
                        scan = true
                    } label: {
                        Label("Scan this Place", systemImage: "cube.transparent")
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .foregroundStyle(FlowTheme.cream)
                            .background(FlowTheme.ink, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                ErrorLine(message: error)
            }
        }
        .task { await load() }
        .fullScreenCover(isPresented: $scan) {
            RoomScanFlow(initialPlace: place) {
                Task { await load() }
            }
            .environmentObject(session)
        }
    }

    private func load() async {
        defer { loaded = true }
        guard let api = session.api, let id = place.roomId else { return }
        do {
            info = try await api.roomsGet(id: id)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
