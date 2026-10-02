import SwiftUI
import UIKit

struct CameraPicker: UIViewControllerRepresentable {
    var onImage: (UIImage) -> Void
    var onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.onImage(image)
            } else {
                parent.onCancel()
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onCancel()
        }
    }

    static var isAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }
}

enum PhotoJPEG {
    static func encode(_ image: UIImage, quality: CGFloat = 0.85) -> Data? {
        image.jpegData(compressionQuality: quality)
    }

    static func fileName() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        return "snap-\(f.string(from: Date())).jpg"
    }
}
