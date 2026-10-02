import SwiftUI

struct LocationPicker: View {
    let title: String
    let value: Place
    var allowClear: Bool = false
    let houses: [FlowHouse]
    let locations: [FlowLocation]
    var onPick: (Place) -> Void
    var onClose: () -> Void

    @State private var houseId: Int?
    @State private var floor: String
    @State private var room: String

    init(
        title: String,
        value: Place,
        allowClear: Bool = false,
        houses: [FlowHouse],
        locations: [FlowLocation],
        onPick: @escaping (Place) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.title = title
        self.value = value
        self.allowClear = allowClear
        self.houses = houses
        self.locations = locations
        self.onPick = onPick
        self.onClose = onClose
        _houseId = State(initialValue: value.houseId ?? houses.first?.id)
        _floor = State(initialValue: value.floor)
        _room = State(initialValue: "")
    }

    private var house: FlowHouse? { houses.first(where: { $0.id == houseId }) }
    private var floors: [String] { house?.floors ?? FlowTheme.defaultFloors }
    private var known: [FlowLocation] {
        locations.filter { $0.houseId == houseId }.sorted { $0.count > $1.count }
    }

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
                    Text("Rooms with things")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(FlowTheme.muted)
                        .textCase(.uppercase)
                    ForEach(known) { loc in
                        let on = value.houseId == loc.houseId && value.room == loc.room && (value.floor) == (loc.floor ?? "")
                        Button {
                            pick(Place(houseId: loc.houseId, floor: loc.floor ?? "", room: loc.room))
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(loc.room)
                                        .font(.system(size: 15, weight: .medium))
                                        .foregroundStyle(FlowTheme.ink)
                                    if let f = loc.floor, !f.isEmpty {
                                        Text(f).font(.system(size: 12)).foregroundStyle(FlowTheme.muted)
                                    }
                                }
                                Spacer()
                                Text("\(loc.count)")
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
                    if !floors.isEmpty {
                        Picker("Floor", selection: $floor) {
                            Text("Floor…").tag("")
                            ForEach(floors, id: \.self) { f in
                                Text(f).tag(f)
                            }
                        }
                        .pickerStyle(.menu)
                        .padding(10)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    TextField("Room name, for example Keuken", text: $room)
                        .textInputAutocapitalization(.words)
                        .padding(12)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    Button {
                        let name = room.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !name.isEmpty, let houseId else { return }
                        pick(Place(houseId: houseId, floor: floor, room: name))
                    } label: {
                        Text("Use this room")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .foregroundStyle(FlowTheme.cream)
                            .background(FlowTheme.ink, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .disabled(room.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || houseId == nil)
                    .opacity(room.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || houseId == nil ? 0.4 : 1)
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

    private func pick(_ place: Place) {
        onPick(place)
        onClose()
    }
}
