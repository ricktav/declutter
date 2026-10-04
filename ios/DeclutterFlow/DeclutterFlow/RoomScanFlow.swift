import SwiftUI

/// Pick a Place, scan it with RoomPlan, preview 2D/3D, then `rooms.upsertFromScan`.
struct RoomScanFlow: View {
    @EnvironmentObject private var session: FlowSession
    @Environment(\.dismiss) private var dismiss

    var initialPlace: Place
    var onSaved: (() -> Void)?

    @State private var place: Place
    @State private var pickPlace = false
    @State private var capturing = false
    @State private var geometry: RoomGeometryPayload?
    @State private var error: String?
    @State private var saving = false

    init(initialPlace: Place, onSaved: (() -> Void)? = nil) {
        self.initialPlace = initialPlace
        self.onSaved = onSaved
        _place = State(initialValue: initialPlace)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("A LiDAR scan of this Place becomes the floor plan (2D and 3D) in HomeBase. Things already filed here keep their names.")
                        .font(.system(size: 13))
                        .foregroundStyle(FlowTheme.muted)

                    Button { pickPlace = true } label: {
                        HStack {
                            Image(systemName: "mappin").foregroundStyle(FlowTheme.moss)
                            Text(place.hasRoom ? FlowLogic.placeLabel(place, houses: session.houses) : "Pick a Place first")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(FlowTheme.ink)
                            Spacer()
                            Text("change").font(.system(size: 12)).foregroundStyle(FlowTheme.muted).underline()
                        }
                        .padding(12)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))
                    }
                    .buttonStyle(.plain)

                    if let existing = session.scannedRoom(for: place) {
                        Text("This Place already has a plan (room #\(existing.id)). A new scan replaces the walls and keeps the same room row.")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                    }

                    if !LiDARScan.isSupported {
                        EmptyState(
                            title: "LiDAR not on this device",
                            caption: "RoomPlan needs an iPhone or iPad with LiDAR (Pro). The rest of Flow still works. Open this on a Pro device to scan a Place."
                        )
                    }

                    if let geometry {
                        FloorPlanView(geometry: geometry)
                        Button {
                            Task { await save(geometry) }
                        } label: {
                            HStack {
                                if saving { ProgressView().tint(FlowTheme.ink) }
                                Text(saving ? "Saving…" : "Save this Place plan")
                                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .foregroundStyle(FlowTheme.ink)
                            .background(FlowTheme.lime, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .disabled(saving || !place.hasRoom || place.houseId == nil)
                    } else if LiDARScan.isSupported {
                        Button {
                            if place.hasRoom, place.houseId != nil {
                                capturing = true
                            } else {
                                pickPlace = true
                            }
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
                    WordRow()
                }
                .padding(16)
            }
            .background(FlowTheme.page)
            .navigationTitle("Scan a Place")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .sheet(isPresented: $pickPlace) {
            LocationPicker(
                title: "Which Place?",
                value: place,
                houses: session.houses,
                locations: session.locations,
                onPick: { place = $0 },
                onClose: { pickPlace = false }
            )
        }
        #if canImport(RoomPlan)
        .fullScreenCover(isPresented: $capturing) {
            RoomCaptureScreen(
                onComplete: { room in
                    capturing = false
                    if let payload = RoomPlanGeometry.payload(from: room) {
                        geometry = payload
                        error = nil
                    } else {
                        error = "The scan had no walls we could read. Walk the walls again and tap Done."
                    }
                },
                onCancel: { capturing = false },
                onError: { message in
                    capturing = false
                    error = message
                }
            )
            .ignoresSafeArea()
        }
        #endif
    }

    private func save(_ geometry: RoomGeometryPayload) async {
        guard let api = session.api, let houseId = place.houseId, place.hasRoom else {
            error = "Pick a Place (house and room name) before saving."
            return
        }
        saving = true
        error = nil
        do {
            let result = try await api.roomsUpsertFromScan(houseId: houseId, name: place.room, geometry: geometry)
            await session.linkItems(toRoomId: result.id, place: place)
            session.setHere(place)
            await session.refresh()
            onSaved?()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}
