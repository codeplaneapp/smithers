import SwiftUI
import WebKit

struct WebviewTabView: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> WKWebView {
        webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        // The WKWebView instance is owned by WorkspaceState.
    }
}
