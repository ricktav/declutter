import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var session: FlowSession
    var embedded: Bool = false

    @State private var busy = false
    @State private var status: String?
    @State private var ok = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Talk to HomeBase on your LAN. Same APP_TOKEN as the web Flow / Workbench.")
                    .font(.system(size: 13))
                    .foregroundStyle(FlowTheme.muted)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Server base URL")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(FlowTheme.muted)
                    TextField("http://10.50.0.10:3001", text: $settings.baseURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .padding(12)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("APP_TOKEN")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(FlowTheme.muted)
                    SecureField("Stored in the Keychain", text: $settings.token)
                        .textContentType(.password)
                        .padding(12)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    Text("Sent as Authorization: Bearer. Leave empty only if the server has no APP_TOKEN.")
                        .font(.system(size: 11))
                        .foregroundStyle(FlowTheme.muted)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("House")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(FlowTheme.muted)
                    Picker("House", selection: $settings.houseId) {
                        Text("All houses").tag(Int?.none)
                        ForEach(session.houses) { h in
                            Text(h.name).tag(Int?.some(h.id))
                        }
                    }
                    .pickerStyle(.menu)
                    .padding(10)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    Text("Sent as x-house-id, like the house switcher in web Flow: Sort, Act and Find show this house. Saved with Save and ping.")
                        .font(.system(size: 11))
                        .foregroundStyle(FlowTheme.muted)
                }

                Button {
                    Task { await ping() }
                } label: {
                    HStack {
                        if busy { ProgressView().tint(FlowTheme.ink) }
                        Text(busy ? "Checking…" : "Save and ping")
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .foregroundStyle(FlowTheme.ink)
                    .background(FlowTheme.lime, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .disabled(busy)

                if let status {
                    Text(status)
                        .font(.system(size: 13))
                        .foregroundStyle(ok ? FlowTheme.keep : FlowTheme.toss)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Cleartext HTTP")
                        .font(.system(size: 13, weight: .semibold))
                    Text("This app allows arbitrary HTTP so it can reach a LAN server such as http://10.50.0.10:3001. iOS will also ask to use the local network. Prefer HTTPS if you expose HomeBase beyond your LAN.")
                        .font(.system(size: 12))
                        .foregroundStyle(FlowTheme.muted)
                }
                .padding(12)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                WordRow()
            }
            .padding(16)
        }
        .background(FlowTheme.page)
        .navigationTitle(embedded ? "Settings" : "⌂ Flow")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func ping() async {
        busy = true
        status = nil
        ok = false
        settings.save()
        session.attach(settings: settings)
        do {
            let api = try settings.makeAPI()
            let result = try await api.ping()
            ok = result.ok
            status = result.ok ? "Server is up. Token accepted." : "Ping returned ok=false."
            settings.lastPing = status
            if result.ok {
                await session.refresh()
            }
        } catch let err as APIError {
            ok = false
            status = err.isUnauthorized ? "App token rejected (or missing)." : err.localizedDescription
            settings.lastPing = status
        } catch {
            ok = false
            status = error.localizedDescription
        }
        busy = false
    }
}
