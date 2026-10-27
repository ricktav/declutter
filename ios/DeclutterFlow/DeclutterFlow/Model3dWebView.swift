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

        init(onFail: @escaping (Model3dFail, String?) -> Void, onReady: @escaping () -> Void) {
            self.onFail = onFail
            self.onReady = onReady
        }

        func load(directory: URL, in webView: WKWebView) {
            if loadedDir == directory { return }
            loadedDir = directory
            let html = directory.appendingPathComponent("Model3dViewer.html")
            webView.loadFileURL(html, allowingReadAccessTo: directory)
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
