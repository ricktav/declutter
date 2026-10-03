import SwiftUI

/// Pick a place: a room of a house, or a new room by name (`rooms.ensure`).
/// The same list for "Where are you?" and "Where is it?", like web Flow's LocationSheet.
struct LocationPicker: View {
    let title: String
    let value: Place
    var allowClear: Bool = false
    let houses: [FlowHouse]
    let rooms: [FlowRoom]
    var onCreate: (_ name: String, _ floor: String?, _ houseId: Int) async throws -> Place
    var onPick: (Place) -> Void
    var onClose: () -> Void

    @State private var houseId: Int?
    @State private var floor: String
    @State private var room: String
    @State private var busy = false
    @State private var error: String?

    init(
        title: String,
        value: Place,
        allowClear: Bool = false,
        houses: [FlowHouse],
        rooms: [FlowRoom],
        defaultHouseId: Int? = nil,
        onCreate: @escaping (_ name: String, _ floor: String?, _ houseId: Int) async throws -> Place,
        onPick: @escaping (Place) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.title = title
        self.value = value
        self.allowClear = allowClear
        self.houses = houses
        self.rooms = rooms
        self.onCreate = onCreate
        self.onPick = onPick
        self.onClose = onClose
        _houseId = State(initialValue: value.houseId ?? defaultHouseId ?? houses.first?.id)
        _floor = State(initialValue: value.floor)
        _room = State(initialValue: "")
    }

    private var inHouse: [FlowRoom] { rooms.filter { $0.houseId == houseId } }
    private var known: [FlowRoom] {
        inHouse.sorted { $0.itemCount != $1.itemCount ? $0.itemCount > $1.itemCount : $0.name < $1.name }
    }
    private var floors: [String] {
        let present = FlowLogic.sortFloors(inHouse.compactMap(\.floor).filter { !$0.isEmpty })
        return present.isEmpty ? FlowTheme.defaultFloors : present
    }
    private var newName: String { room.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        FlowSheet(title: title, onClose: onClose) {
            VStack(alignment: .leading, spacing: 16) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(houses) { h in
                            Chip(title: h.name, selected: h.id == houseId) { houseId = h.id }
                        }
                    }
                }

                if !known.isEmpty {
                    Text("Rooms")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(FlowTheme.muted)
                        .textCase(.uppercase)
                    ForEach(known) { r in
                        let on = value.roomId == r.id
                        Button {
                            pick(Place(room: r))
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(r.name)
                                        .font(.system(size: 15, weight: .medium))
                                        .foregroundStyle(FlowTheme.ink)
                                    if let f = r.floor, !f.isEmpty {
                                        Text(f).font(.system(size: 12)).foregroundStyle(FlowTheme.muted)
                                    }
                                }
                                Spacer()
                                Text("\(r.itemCount)")
                                    .font(.system(size: 12, design: .rounded))
                                    .foregroundStyle(FlowTheme.muted)
                                if on {
                                    Image(systemName: "checkmark").foregroundStyle(FlowTheme.moss)
                                }
                            }
                            .padding(12)
                            .background(on ? FlowTheme.moss.opacity(0.1) : Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(on ? FlowTheme.moss : Color(hex: 0xD5D9CD))
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("New room")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(FlowTheme.muted)
                        .textCase(.uppercase)
                    Picker("Floor", selection: $floor) {
                        Text("Floor…").tag("")
                        ForEach(floors, id: \.self) { f in
                            Text(f).tag(f)
                        }
                    }
                    .pickerStyle(.menu)
                    .padding(10)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    TextField("Room name, for example Keuken", text: $room)
                        .textInputAutocapitalization(.words)
                        .padding(12)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    Button {
                        Task { await create() }
                    } label: {
                        Text(busy ? "Saving…" : "Use this room")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .foregroundStyle(FlowTheme.cream)
                            .background(FlowTheme.ink, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .disabled(newName.isEmpty || houseId == nil || busy)
                    .opacity(newName.isEmpty || houseId == nil || busy ? 0.4 : 1)
                    ErrorLine(message: error)
                }
                .padding(12)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color(hex: 0xD5D9CD)))

                if allowClear {
                    Button("No place") {
                        pick(.empty)
                    }
                    .font(.system(size: 13))
                    .foregroundStyle(FlowTheme.muted)
                    .underline()
                }
            }
        }
    }

    private func create() async {
        guard !newName.isEmpty, let houseId else { return }
        busy = true
        error = nil
        do {
            pick(try await onCreate(newName, floor.isEmpty ? nil : floor, houseId))
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    private func pick(_ place: Place) {
        onPick(place)
        onClose()
    }
}
