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

    /// The picked room as `rooms.list` has it: its exact name keeps the upsert on the same row.
    private var room: FlowRoom? {
        guard let id = place.roomId else { return nil }
        return session.rooms.first(where: { $0.id == id })
    }

    private var canSave: Bool { place.hasRoom && (room?.houseId ?? place.houseId) != nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("A LiDAR scan of this Place becomes its floor plan (2D and 3D) in HomeBase. Things already filed here stay in this Place.")
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

                    if room?.hasGeometry == true {
                        Text("This Place already has a plan. A new scan replaces its walls; its Things stay.")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                    }

                    if !LiDARScan.isSupported {
                        EmptyState(
                            title: "Needs a LiDAR iPhone",
                            caption: "Scanning a Place needs an iPhone or iPad Pro with LiDAR. The rest of Flow works on this device."
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
                        .disabled(saving || !canSave)
                    } else if LiDARScan.isSupported {
                        Button {
                            if canSave {
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
                rooms: session.rooms,
                onCreate: { name, floor, houseId in try await session.ensureRoom(name: name, floor: floor, houseId: houseId) },
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
        guard let api = session.api, place.hasRoom, let houseId = room?.houseId ?? place.houseId else {
            error = "Pick a Place before saving."
            return
        }
        let name = room?.name ?? place.room
        let floor = room?.floor ?? (place.floor.isEmpty ? nil : place.floor)
        saving = true
        error = nil
        do {
            let result = try await api.roomsUpsertFromScan(houseId: houseId, name: name, floor: floor, geometry: geometry)
            await session.refresh()
            if let saved = session.rooms.first(where: { $0.id == result.id }) {
                session.setHere(Place(room: saved))
            }
            onSaved?()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}
