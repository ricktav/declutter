import SwiftUI

/// Colors and type from the web Flow UI (`src/flow/`).
enum FlowTheme {
    static let ink = Color(hex: 0x282C20)
    static let inkMuted = Color(hex: 0x3A3F2E)
    static let cream = Color(hex: 0xF4F4ED)
    static let muted = Color(hex: 0x6E7563)
    static let mutedText = Color(hex: 0xB4B8A5)
    static let lime = Color(hex: 0xD2FF00)
    static let moss = Color(hex: 0x3C5D41)
    static let keep = Color(hex: 0x2F7A45)
    static let sell = Color(hex: 0x9E6A08)
    static let donate = Color(hex: 0x2D689B)
    static let toss = Color(hex: 0xAD432B)
    static let later = Color(hex: 0x6E7563)
    static let page = Color(hex: 0xF4F4ED)
    static let card = Color.white
    static let hatchA = Color(hex: 0xE4E8DC)
    static let hatchB = Color(hex: 0xD5D9CD)

    static let defaultFloors = ["basement", "ground", "1", "2", "3", "attic"]
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }
}

extension ItemDecision {
    var color: Color {
        switch self {
        case .keep: return FlowTheme.keep
        case .sell: return FlowTheme.sell
        case .donate: return FlowTheme.donate
        case .toss: return FlowTheme.toss
        case .later: return FlowTheme.later
        }
    }

    var label: String {
        switch self {
        case .keep: return "Keep"
        case .sell: return "Sell"
        case .donate: return "Donate"
        case .toss: return "Toss"
        case .later: return "Later"
        }
    }

    var listTitle: String {
        switch self {
        case .sell: return "Sell list"
        case .donate: return "Donate box"
        case .toss: return "Toss run"
        default: return label
        }
    }
}
