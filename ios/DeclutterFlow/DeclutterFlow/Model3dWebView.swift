import SwiftUI
import WebKit

/// Hosts the bundled three.js page for route-1 `.js` modules (`export function build(THREE)`).
/// The page is local (no CDN). Failures come back through `onFail` and stay in the panel.
struct Model3dWebView: UIViewRepresentable {
    let directory: URL
    var onFail: (Model3dFail, String?) -> Void
    var onReady: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFail: onFail, onReady: onReady) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        config.userContentController.add(context.coordinator, name: "model3d")
        // ES module imports from file:// are blocked in WKWebView; serve the staged folder on a private scheme.
        config.setURLSchemeHandler(context.coordinator.files, forURLScheme: Model3dFileScheme.scheme)
        config.suppressesIncrementalRendering = true

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 244 / 255, green: 241 / 255, blue: 234 / 255, alpha: 1)
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = context.coordinator
        context.coordinator.webView = web
        return web
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onFail = onFail
        context.coordinator.onReady = onReady
        context.coordinator.load(directory: directory, in: webView)
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.stopLoading()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "model3d")
        coordinator.cancelled = true
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var onFail: (Model3dFail, String?) -> Void
        var onReady: () -> Void
        weak var webView: WKWebView?
        var cancelled = false
        private var loadedDir: URL?
        let files = Model3dFileScheme()

        init(onFail: @escaping (Model3dFail, String?) -> Void, onReady: @escaping () -> Void) {
            self.onFail = onFail
            self.onReady = onReady
        }

        func load(directory: URL, in webView: WKWebView) {
            if loadedDir == directory { return }
            loadedDir = directory
            files.root = directory
            webView.load(URLRequest(url: URL(string: "\(Model3dFileScheme.scheme)://local/Model3dViewer.html")!))
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !cancelled else { return }
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            if type == "loaded" {
                onReady()
                return
            }
            if type == "fail" {
                let kindRaw = (body["kind"] as? String) ?? "parse"
                let detail = body["detail"] as? String
                let kind: Model3dFail
                switch kindRaw {
                case "unsupported": kind = .unsupported
                case "unreachable": kind = .unreachable
                case "agent": kind = .agent
                case "usdz": kind = .usdz
                default: kind = .parse
                }
                onFail(kind, detail)
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            guard !cancelled else { return }
            onFail(.parse, error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            guard !cancelled else { return }
            onFail(.parse, error.localizedDescription)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard !cancelled else { return }
            onFail(.parse, "The 3D page stopped.")
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if navigationAction.navigationType == .other || navigationAction.navigationType == .reload {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }
    }
}

/// Serves files from one staged folder (`Model3dViewer.html`, three.js, `model.js`) to the WKWebView.
final class Model3dFileScheme: NSObject, WKURLSchemeHandler {
    static let scheme = "declutter-model3d"
    var root: URL?

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let root, let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        let base = root.standardizedFileURL
        let file = base.appendingPathComponent(url.path.split(separator: "/").joined(separator: "/")).standardizedFileURL
        guard file.path.hasPrefix(base.path + "/"), let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!)
            urlSchemeTask.didFinish()
            return
        }
        let mime: String
        switch file.pathExtension.lowercased() {
        case "html": mime = "text/html; charset=utf-8"
        case "js", "mjs": mime = "text/javascript; charset=utf-8"
        default: mime = "application/octet-stream"
        }
        let headers = ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-store"]
        urlSchemeTask.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
