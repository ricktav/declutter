import SwiftUI

/// Inline Thing-detail 3D panel. Downloads the file (Bearer when talking to HomeBase),
/// then hands it to SceneKit (USDZ / GLB / GLTF) or a bundled three.js WKWebView (route-1 JS).
/// Failures stay in this panel.
struct Model3dPanel: View {
    let rawUrl: String
    let baseURL: URL
    var api: HomeBaseAPI?
    var tall: Bool = false

    @State private var phase: Phase = .loading
    @State private var expanded = false
    @State private var workDir: URL?

    private enum Phase: Equatable {
        case loading
        case native(URL, Model3dFormat)
        case web(URL)
        case fail(Model3dFail, String?)
    }

    var body: some View {
        ZStack {
            Color(hex: Model3d.backdropHex)
            content
            if case .loading = phase {
                Text(Model3d.copy.loading)
                    .font(.system(size: 12))
                    .foregroundStyle(FlowTheme.muted)
            }
            if case let .fail(kind, _) = phase {
                VStack(spacing: 6) {
                    Text(Model3d.message(for: kind))
                        .font(.system(size: 12))
                        .foregroundStyle(FlowTheme.muted)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 16)
            }
            if !tall, canExpand {
                VStack {
                    HStack {
                        Spacer()
                        Button {
                            expanded = true
                        } label: {
                            Image(systemName: "arrow.up.left.and.arrow.down.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(FlowTheme.ink)
                                .padding(8)
                                .background(.white.opacity(0.85), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .accessibilityLabel(Model3d.copy.expand)
                        .padding(8)
                    }
                    Spacer()
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: tall ? nil : 224)
        .frame(maxHeight: tall ? .infinity : 224)
        .clipShape(RoundedRectangle(cornerRadius: tall ? 0 : 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: tall ? 0 : 12, style: .continuous)
                .strokeBorder(Color(hex: 0xD5D9CD))
        )
        .task(id: rawUrl) { await load() }
        .onDisappear { if !expanded { cleanup() } }
        .fullScreenCover(isPresented: $expanded) {
            NavigationStack {
                Model3dPanel(rawUrl: rawUrl, baseURL: baseURL, api: api, tall: true)
                    .ignoresSafeArea(edges: .bottom)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { expanded = false }
                        }
                    }
                    .navigationTitle("3D")
                    .navigationBarTitleDisplayMode(.inline)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .native(let url, let format):
            Model3dSceneView(
                fileURL: url,
                format: format,
                onFail: { kind, detail in phase = .fail(kind, detail) },
                onReady: {}
            )
        case .web(let dir):
            Model3dWebView(
                directory: dir,
                onFail: { kind, detail in phase = .fail(kind, detail) },
                onReady: {}
            )
        default:
            EmptyView()
        }
    }

    private var canExpand: Bool {
        switch phase {
        case .native, .web: return true
        default: return false
        }
    }

    private func load() async {
        phase = .loading
        cleanup()
        let trimmed = rawUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Model3d.hasUrl(trimmed) else {
            phase = .fail(.unsupported, nil)
            return
        }
        guard let src = Model3d.resolveSrc(trimmed), let url = Model3d.absoluteURL(src: src, baseURL: baseURL) else {
            phase = .fail(.unsupported, nil)
            return
        }
        let classified = Model3d.format(of: src)
        guard case .known(let format) = classified else {
            phase = .fail(.unsupported, nil)
            return
        }

        let data: Data
        do {
            if let api {
                data = try await api.download(url)
            } else {
                let (bytes, response) = try await URLSession.shared.data(from: url)
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    phase = .fail(.unreachable, "HTTP \(http.statusCode)")
                    return
                }
                data = bytes
            }
        } catch {
            phase = .fail(Model3d.fail(from: error, format: classified), error.localizedDescription)
            return
        }

        let dir: URL
        do {
            dir = try makeWorkDir(format: format, data: data, sourceURL: url)
        } catch {
            phase = .fail(.parse, error.localizedDescription)
            return
        }
        workDir = dir

        switch format {
        case .usdz, .glb, .gltf:
            let file = dir.appendingPathComponent(Self.modelFileName(format: format, sourceURL: url))
            phase = .native(file, format)
        case .js:
            let source = String(data: data, encoding: .utf8) ?? ""
            if !Model3d.looksLikeAgentModelModule(source) {
                phase = .fail(.agent, "Not an agent model module (missing export function build).")
                return
            }
            phase = .web(dir)
        }
    }

    private func makeWorkDir(format: Model3dFormat, data: Data, sourceURL: URL) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("model3d-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // The JS viewer always fetches ./model.js; native loaders take any name with the right suffix.
        let modelName = format == .js ? "model.js" : Self.modelFileName(format: format, sourceURL: sourceURL)
        try data.write(to: dir.appendingPathComponent(modelName), options: .atomic)

        if format == .js {
            try Self.copyBundleFile(name: "Model3dViewer", ext: "html", to: dir)
            try Self.copyBundleFile(name: "three.module", ext: "js", to: dir)
            try Self.copyBundleFile(name: "three.core", ext: "js", to: dir)
        }
        return dir
    }

    private static func modelFileName(format: Model3dFormat, sourceURL: URL) -> String {
        let last = sourceURL.path.split(separator: "/").last.map(String.init) ?? ""
        let ext: String
        switch format {
        case .glb: ext = "glb"
        case .gltf: ext = "gltf"
        case .usdz: ext = "usdz"
        case .js: ext = "js"
        }
        if last.lowercased().hasSuffix(".\(ext)") { return last }
        return "model.\(ext)"
    }

    private static func copyBundleFile(name: String, ext: String, to dir: URL) throws {
        let url =
            Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "Model3dWeb")
            ?? Bundle.main.url(forResource: name, withExtension: ext)
        guard let url else {
            throw NSError(domain: "Model3d", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Missing bundled \(name).\(ext).",
            ])
        }
        let dest = dir.appendingPathComponent(url.lastPathComponent)
        if FileManager.default.fileExists(atPath: dest.path) {
            try FileManager.default.removeItem(at: dest)
        }
        try FileManager.default.copyItem(at: url, to: dest)
    }

    private func cleanup() {
        if let workDir {
            try? FileManager.default.removeItem(at: workDir)
        }
        workDir = nil
    }
}

/// Thing-detail section: viewer when `model3dUrl` is set, nothing otherwise.
struct Model3dSection: View {
    let url: String?
    let baseURL: URL
    var api: HomeBaseAPI?

    var body: some View {
        if Model3d.hasUrl(url), let url {
            VStack(alignment: .leading, spacing: 8) {
                Text("3D model")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(FlowTheme.muted)
                    .textCase(.uppercase)
                Model3dPanel(rawUrl: url, baseURL: baseURL, api: api)
            }
        }
    }
}
