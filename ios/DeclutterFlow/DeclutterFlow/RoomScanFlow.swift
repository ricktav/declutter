import SwiftUI

/// Pick a Place, scan it with RoomPlan, preview 2D/3D, then `rooms.upsertFromScan`.
struct RoomScanFlow: View {
    @EnvironmentObject private var session: FlowSession
    @Environment(\.dismiss) private var dismiss

    var initialPlace: Place
    /// True from Snap: the scanned Place becomes "where you are". Find and the Place sheet leave Here alone.
    var setsHere: Bool
    var onSaved: (() -> Void)?

    @State private var place: Place
    @State private var pickPlace = false
    @State private var capturing = false
    @State private var geometry: RoomGeometryPayload?
    @State private var error: String?
    @State private var saving = false
    /// Set once the scan is saved with objects: how its Things merged into the Place.
    @State private var savedThings: ScanThingCounts?

    init(initialPlace: Place, setsHere: Bool = false, onSaved: (() -> Void)? = nil) {
        self.initialPlace = initialPlace
        self.setsHere = setsHere
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
                    Text("A LiDAR scan of this Place becomes its floor plan (2D and 3D) in HomeBase, and the furniture it finds becomes detected Things. Things already filed here stay in this Place.")
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

                    if room?.hasPlan == true {
                        Text("This Place already has a plan. A new scan replaces its walls and moves the Things an earlier scan found; its other Things stay.")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                    }

                    if !LiDARScan.isSupported {
                        EmptyState(
                            title: "Needs a LiDAR iPhone",
                            caption: "Scanning a Place needs an iPhone or iPad Pro with LiDAR. The rest of Flow works on this device."
                        )
                    }

                    if let savedThings {
                        Text(Self.summary(savedThings))
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(FlowTheme.ink)
                        Text("They are detected Things in this Place: confirm or fix them in Sort.")
                            .font(.system(size: 12))
                            .foregroundStyle(FlowTheme.muted)
                        Button {
                            onSaved?()
                            dismiss()
                        } label: {
                            Text("Done")
                                .font(.system(size: 14, weight: .semibold, design: .rounded))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .foregroundStyle(FlowTheme.ink)
                                .background(FlowTheme.lime, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    } else if let geometry {
                        FloorPlanView(geometry: geometry)
                        if !geometry.objects.isEmpty {
                            Text(geometry.objects.count == 1 ? "1 object found; it becomes a Thing in this Place." : "\(geometry.objects.count) objects found; they become Things in this Place.")
                                .font(.system(size: 12))
                                .foregroundStyle(FlowTheme.muted)
                        }
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
                    Button("Close") {
                        if savedThings != nil { onSaved?() }
                        dismiss()
                    }
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
            if setsHere, let saved = session.rooms.first(where: { $0.id == result.id }) {
                session.setHere(Place(room: saved))
            }
            if let things = result.things, things.matched + things.created + things.missing > 0 {
                // Stay open to say what the scan did to the Place's Things; Done closes.
                savedThings = things
            } else {
                onSaved?()
                dismiss()
            }
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }

    /// "3 Things found, 1 moved, 1 new · 1 missing": matched counts the ones already here.
    static func summary(_ t: ScanThingCounts) -> String {
        let found = t.matched + t.created
        var parts = [found == 1 ? "1 Thing found" : "\(found) Things found"]
        if t.moved > 0 { parts.append("\(t.moved) moved") }
        if t.created > 0 && t.matched > 0 { parts.append("\(t.created) new") }
        var line = parts.joined(separator: ", ")
        if t.missing > 0 { line += " · \(t.missing) not seen this time" }
        return line
    }
}
