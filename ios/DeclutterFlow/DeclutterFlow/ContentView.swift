import SwiftUI

enum FlowTab: String, CaseIterable, Identifiable {
    case snap, sort, act, find
    var id: String { rawValue }

    var label: String {
        switch self {
        case .snap: return "Snap"
        case .sort: return "Sort"
        case .act: return "Act"
        case .find: return "Find"
        }
    }

    var symbol: String {
        switch self {
        case .snap: return "camera.fill"
        case .sort: return "tray.fill"
        case .act: return "scalemass"
        case .find: return "magnifyingglass"
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var session: FlowSession

    // `-flow.initialTab find` (launch argument) opens on that tab; used for Simulator screenshots
    @State private var tab: FlowTab = FlowTab(rawValue: UserDefaults.standard.string(forKey: "flow.initialTab") ?? "") ?? .snap
    @State private var showHere = false
    @State private var showSettings = false
    // Above the tab switch: Snap uploads (and their retry queue) outlive a tab change.
    @StateObject private var uploader = SnapUploader()
    // One camera session for the app: Snap and "Take a Photo of it" on a Place plan share it.
    @StateObject private var camera = SnapCamera()

    var body: some View {
        VStack(spacing: 0) {
            header
            if let err = session.errorMessage, !session.ready {
                ErrorLine(message: err)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
            }
            Group {
                switch tab {
                case .snap:
                    SnapView(onGoSort: { tab = .sort }, onChangeHere: { showHere = true })
                        .environmentObject(uploader)
                        .environmentObject(camera)
                case .sort:
                    ScrollView { SortView().padding(.vertical, 4) }
                case .act:
                    ActView()
                case .find:
                    FindView()
                        .environmentObject(uploader)
                        .environmentObject(camera)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            tabBar
        }
        .background(FlowTheme.page.ignoresSafeArea())
        .sheet(isPresented: $showHere) {
            LocationPicker(
                title: "Where are you?",
                value: session.here,
                allowClear: true,
                houses: session.houses,
                rooms: session.rooms,
                defaultHouseId: settings.houseId,
                onCreate: { name, floor, houseId in try await session.ensureRoom(name: name, floor: floor, houseId: houseId) },
                onPick: { session.setHere($0) },
                onClose: { showHere = false }
            )
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                SettingsView(embedded: true)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { showSettings = false }
                        }
                    }
            }
        }
        .task { await boot() }
        .onChange(of: session.needsAuth) { _, needs in
            if needs { showSettings = true }
        }
    }

    private var header: some View {
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                Text("⌂ Flow")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(FlowTheme.cream)
                Button { showHere = true } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "mappin")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(FlowTheme.lime)
                        Text(session.here.hasRoom ? FlowLogic.placeLabel(session.here, houses: session.houses) : "Where are you?")
                            .font(.system(size: 12))
                            .lineLimit(1)
                            .foregroundStyle(FlowTheme.cream)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(FlowTheme.inkMuted, in: Capsule())
                }
                .buttonStyle(.plain)
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape.fill")
                        .foregroundStyle(FlowTheme.mutedText)
                }
                .accessibilityLabel("Settings")
            }
            WordRow()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(FlowTheme.ink.ignoresSafeArea(edges: .top))
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(FlowTab.allCases) { t in
                Button {
                    tab = t
                } label: {
                    VStack(spacing: 2) {
                        Image(systemName: t.symbol)
                            .font(.system(size: 18))
                        Text(t.label)
                            .font(.system(size: 11, weight: tab == t ? .semibold : .regular, design: .rounded))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .foregroundStyle(tab == t ? FlowTheme.ink : FlowTheme.muted)
                    .background(tab == t ? FlowTheme.lime : Color.white)
                    .overlay(alignment: .topTrailing) {
                        if t == .snap, !uploader.failed.isEmpty {
                            Text("\(uploader.failed.count)")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(FlowTheme.toss, in: Capsule())
                                .offset(x: -18, y: 4)
                                .accessibilityLabel(uploader.failedSummary ?? "")
                        }
                        if t == .sort, session.sortCount > 0 {
                            Text("\(session.sortCount)")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(FlowTheme.toss, in: Capsule())
                                .offset(x: -18, y: 4)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .background(Color.white.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Divider() }
    }

    /// Attach and load without saving: launch-argument values (`-declutter.baseURL`,
    /// `-declutter.houseId`) stay in the argument domain; only "Save and ping" persists Settings.
    private func boot() async {
        session.attach(settings: settings)
        await session.refresh()
        if session.needsAuth || !session.ready {
            showSettings = session.needsAuth || settings.token.isEmpty
        }
    }
}
