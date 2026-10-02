import SwiftUI

@main
struct DeclutterFlowApp: App {
    @StateObject private var settings = SettingsStore()
    @StateObject private var session = FlowSession()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .environmentObject(session)
                .preferredColorScheme(.light)
        }
    }
}
