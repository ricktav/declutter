import SwiftUI

#if canImport(RoomPlan)
import RoomPlan
import UIKit

/// Full-screen RoomPlan capture. Done stops the session and returns a processed room.
struct RoomCaptureScreen: UIViewControllerRepresentable {
    var onComplete: (CapturedRoom) -> Void
    var onCancel: () -> Void
    var onError: (String) -> Void

    func makeUIViewController(context: Context) -> RoomCaptureHost {
        RoomCaptureHost(onComplete: onComplete, onCancel: onCancel, onError: onError)
    }

    func updateUIViewController(_ uiViewController: RoomCaptureHost, context: Context) {}
}

final class RoomCaptureHost: UIViewController, RoomCaptureViewDelegate {
    var onComplete: (CapturedRoom) -> Void
    var onCancel: () -> Void
    var onError: (String) -> Void

    private var captureView: RoomCaptureView!
    private var finishing = false

    init(onComplete: @escaping (CapturedRoom) -> Void, onCancel: @escaping () -> Void, onError: @escaping (String) -> Void) {
        self.onComplete = onComplete
        self.onCancel = onCancel
        self.onError = onError
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:)") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        captureView = RoomCaptureView(frame: view.bounds)
        captureView.translatesAutoresizingMaskIntoConstraints = false
        captureView.delegate = self
        view.addSubview(captureView)

        let bar = UIToolbar()
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.barStyle = .black
        let cancel = UIBarButtonItem(title: "Cancel", style: .plain, target: self, action: #selector(cancelTapped))
        cancel.tintColor = .white
        let title = UIBarButtonItem(title: "Scan this Place", style: .plain, target: nil, action: nil)
        title.tintColor = .white
        title.isEnabled = false
        let done = UIBarButtonItem(title: "Done", style: .done, target: self, action: #selector(doneTapped))
        done.tintColor = UIColor(red: 0.82, green: 1, blue: 0, alpha: 1)
        let flexL = UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil)
        let flexR = UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil)
        bar.items = [cancel, flexL, title, flexR, done]
        view.addSubview(bar)

        NSLayoutConstraint.activate([
            captureView.topAnchor.constraint(equalTo: view.topAnchor),
            captureView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            captureView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            captureView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !finishing else { return }
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if !finishing {
            captureView.captureSession.stop()
        }
    }

    @objc private func cancelTapped() {
        finishing = true
        captureView.captureSession.stop()
        onCancel()
    }

    @objc private func doneTapped() {
        finishing = true
        captureView.captureSession.stop()
    }

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        if let error {
            onError(error.localizedDescription)
            return false
        }
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        if let error {
            onError(error.localizedDescription)
            return
        }
        onComplete(processedResult)
    }
}
#endif
