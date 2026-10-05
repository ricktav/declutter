import SwiftUI

/// A Thing tapped on a Place plan: check it (Confirm / Reject), rename it, take a Photo of
/// it, or move its box on the 2D plan. `onChanged` reloads the plan and the session.
struct PlanThingSheet: View {
    @EnvironmentObject private var session: FlowSession
    @EnvironmentObject private var uploader: SnapUploader
    @Environment(\.dismiss) private var dismiss

    let item: RoomItem
    var onChanged: () async -> Void
    /// Close this sheet and drag the Thing's box on the plan.
    var onMove: () -> Void

    @StateObject private var camera = SnapCamera()
    @State private var name: String
    @State private var status: VerificationStatus?
    @State private var busy = false
    @State private var error: String?
    @State private var showCamera = false

    init(item: RoomItem, onChanged: @escaping () async -> Void, onMove: @escaping () -> Void) {
        self.item = item
        self.onChanged = onChanged
        self.onMove = onMove
        _name = State(initialValue: item.name)
        _status = State(initialValue: item.verificationStatus)
    }

    /// The `items.listAll` row: area, cover Photo and the Thing the camera attaches to.
    private var flowItem: FlowItem? {
        session.items.first(where: { $0.id == item.id })
    }

    private var savedName: String { flowItem?.name ?? item.name }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var kindLine: String {
        var parts: [String] = []
        if let k = item.attributes?["scan_kind"]?.string, !k.isEmpty {
            parts.append("Scanned as \(Self.words(k))")
        }
        if let a = flowItem?.areaName { parts.append(a) }
        if let p = item.pos {
            parts.append(String(format: "%.1f × %.1f m", p.wM, p.dM))
        }
        return parts.isEmpty ? "No kind yet" : parts.joined(separator: " · ")
    }

    var body: some View {
        FlowSheet(title: savedName, onClose: { dismiss() }) {
            VStack(alignment: .leading, spacing: 12) {
                if let key = flowItem?.imageKey {
                    RemotePhoto(storageKey: key, api: session.api)
                        .frame(maxWidth: .infinity)
                        .frame(height: 140)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Thing")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(FlowTheme.muted)
                            .textCase(.uppercase)
                        Spacer()
                        statusPill
                    }
                    HStack(spacing: 8) {
                        TextField("Name", text: $name)
                            .font(.system(size: 15, weight: .medium))
                            .textInputAutocapitalization(.sentences)
                            .submitLabel(.done)
                            .onSubmit { Task { await rename() } }
                        if !trimmedName.isEmpty, trimmedName != savedName {
                            Button("Save") { Task { await rename() } }
                                .font(.system(size: 13, weight: .semibold, design: .rounded))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .foregroundStyle(FlowTheme.cream)
                                .background(FlowTheme.ink, in: Capsule())
                                .disabled(busy)
                        }
                    }
                    Text(kindLine)
                        .font(.system(size: 12))
                        .foregroundStyle(FlowTheme.muted)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: 0xD5D9CD)))

                if status == .detected {
                    Text("The scan found this. Is it right?")
                        .font(.system(size: 12))
                        .foregroundStyle(FlowTheme.moss)
                }
                HStack(spacing: 10) {
                    actionButton("Confirm", systemImage: "checkmark", fg: FlowTheme.cream, bg: FlowTheme.keep) {
                        Task { await setStatus(.confirmed) }
                    }
                    .disabled(busy || status == .confirmed)
                    .opacity(status == .confirmed ? 0.45 : 1)
                    actionButton("Reject", systemImage: "xmark", fg: FlowTheme.cream, bg: FlowTheme.toss) {
                        Task { await setStatus(.rejected) }
                    }
                    .disabled(busy)
                }

                actionButton("Take a Photo of it", systemImage: "camera.fill", fg: FlowTheme.ink, bg: FlowTheme.lime) {
                    showCamera = true
                }
                .disabled(busy || flowItem == nil)

                actionButton("Move on the plan", systemImage: "arrow.up.and.down.and.arrow.left.and.right", fg: FlowTheme.ink, bg: Color.white, border: true) {
                    onMove()
                }
                .disabled(busy || item.pos == nil)

                ErrorLine(message: error)
            }
        }
        .onAppear { camera.prepare() }
        .fullScreenCover(isPresented: $showCamera) {
            SnapCameraScreen(camera: camera, forItem: flowItem, onClose: {
                showCamera = false
                Task { await onChanged() }
            })
            .environmentObject(session)
            .environmentObject(uploader)
        }
    }

    private var statusPill: some View {
        let (label, color): (String, Color) = switch status {
        case .confirmed: ("Confirmed", FlowTheme.keep)
        case .rejected: ("Rejected", FlowTheme.toss)
        case .detected: ("Detected · check it", FlowTheme.sell)
        case nil: ("Unknown", FlowTheme.muted)
        }
        return Text(label)
            .font(.system(size: 11, weight: .semibold, design: .rounded))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: Capsule())
    }

    private func actionButton(_ title: String, systemImage: String, fg: Color, bg: Color, border: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .foregroundStyle(fg)
                .background(bg, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    if border {
                        RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(FlowTheme.ink)
                    }
                }
        }
        .buttonStyle(.plain)
    }

    private func setStatus(_ s: VerificationStatus) async {
        guard let api = session.api else { return }
        busy = true
        error = nil
        do {
            try await api.itemsSetVerification(id: item.id, status: s)
            status = s
            await onChanged()
            // A rejected Thing leaves the plan, so its sheet goes too.
            if s == .rejected { dismiss() }
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    private func rename() async {
        let n = trimmedName
        guard let api = session.api, !n.isEmpty, n != savedName else { return }
        busy = true
        error = nil
        do {
            try await api.itemsRename(id: item.id, name: n)
            name = n
            await onChanged()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    /// "washerDryer" → "washer dryer".
    private static func words(_ camel: String) -> String {
        var out = ""
        for ch in camel {
            if ch.isUppercase, !out.isEmpty { out.append(" ") }
            out.append(contentsOf: ch.lowercased())
        }
        return out
    }
}
