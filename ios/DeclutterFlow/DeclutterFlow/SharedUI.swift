import SwiftUI

struct ErrorLine: View {
    let message: String?
    var body: some View {
        if let message, !message.isEmpty {
            Text(message)
                .font(.system(size: 12))
                .foregroundStyle(Color(hex: 0x9B1C1C))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(hex: 0xFEF2F2), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }
}

struct EmptyState: View {
    let title: String
    var caption: String?

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.system(size: 15, weight: .semibold, design: .rounded))
            if let caption {
                Text(caption)
                    .font(.system(size: 13))
                    .foregroundStyle(FlowTheme.muted)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 20)
        .padding(.vertical, 40)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [5]))
                .foregroundStyle(Color(hex: 0xD5D9CD))
        )
    }
}

struct DecisionButtons: View {
    var current: ItemDecision?
    var disabled: Bool = false
    var onPick: (ItemDecision) -> Void

    var body: some View {
        VStack(spacing: 8) {
            button(.keep)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(ItemDecision.allCases.filter { $0 != .keep }) { d in
                    button(d)
                }
            }
        }
    }

    private func button(_ d: ItemDecision) -> some View {
        Button {
            onPick(d)
        } label: {
            Text(d.label)
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .foregroundStyle(current == d ? Color.white : d.color)
                .background(current == d ? d.color : d.color.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(d.color, lineWidth: 2)
                )
        }
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }
}

struct DecisionBadge: View {
    let decision: ItemDecision?
    var body: some View {
        if let decision {
            Text(decision.label.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .tracking(0.4)
                .foregroundStyle(decision.color)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(decision.color))
        }
    }
}

struct ProgressRing: View {
    let value: Int
    let total: Int
    var size: CGFloat = 96
    var label: String = "decided"

    var body: some View {
        let frac = total > 0 ? min(1, Double(value) / Double(total)) : 0
        ZStack {
            Circle()
                .stroke(Color(hex: 0xD4D8CC), lineWidth: 9)
            Circle()
                .trim(from: 0, to: frac)
                .stroke(FlowTheme.moss, style: StrokeStyle(lineWidth: 9, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text("\(value) / \(total)")
                    .font(.system(size: size / 5.5, weight: .bold, design: .rounded))
                Text(label)
                    .font(.system(size: size / 11))
                    .foregroundStyle(FlowTheme.muted)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("\(value) of \(total) \(label)")
    }
}

struct Chip: View {
    let title: String
    var selected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .foregroundStyle(selected ? FlowTheme.cream : FlowTheme.ink)
                .background(selected ? FlowTheme.ink : Color.white, in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? Color.clear : Color(hex: 0xD5D9CD)))
        }
        .buttonStyle(.plain)
    }
}

struct FlowSheet<Content: View>: View {
    let title: String
    var onClose: () -> Void
    /// Set to drive the sheet's height from the content (e.g. large while dragging on a plan).
    var detent: Binding<PresentationDetent>? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Color(hex: 0xD5D9CD))
                .frame(width: 40, height: 4)
                .padding(.top, 10)
            HStack {
                Text(title)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .foregroundStyle(FlowTheme.muted)
                        .padding(6)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            ScrollView {
                content()
                    .padding(.horizontal, 16)
                    .padding(.bottom, 28)
            }
        }
        .background(FlowTheme.page)
        .modifier(SheetDetents(detent: detent))
        .presentationDragIndicator(.hidden)
    }
}

private struct SheetDetents: ViewModifier {
    var detent: Binding<PresentationDetent>?

    func body(content: Content) -> some View {
        if let detent {
            content.presentationDetents([.medium, .large], selection: detent)
        } else {
            content.presentationDetents([.medium, .large])
        }
    }
}

struct WordRow: View {
    var body: some View {
        Text("Thing · Place · Photo · Decision · Lens")
            .font(.system(size: 10, weight: .medium, design: .rounded))
            .tracking(0.4)
            .foregroundStyle(FlowTheme.mutedText)
    }
}
