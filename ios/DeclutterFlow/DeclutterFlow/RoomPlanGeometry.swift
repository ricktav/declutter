import Foundation
import simd

#if canImport(RoomPlan)
import RoomPlan

/// Flatten a RoomPlan `CapturedRoom` into HomeBase `rooms.upsertFromScan` geometry.
/// Walls/doors/windows become kinded 2D polylines in meters; origin is the
/// bounding-box corner so the Workbench 2D/3D plan can draw them.
enum RoomPlanGeometry {
    static func payload(from room: CapturedRoom) -> RoomGeometryPayload? {
        var walls: [RoomWall] = []
        walls += room.walls.compactMap { wall(from: $0, kind: "wall") }
        walls += room.doors.compactMap { wall(from: $0, kind: "door") }
        walls += room.windows.compactMap { wall(from: $0, kind: "window") }
        if #available(iOS 17.0, *) {
            walls += room.openings.compactMap { wall(from: $0, kind: "door") }
        }
        let points = walls.flatMap(\.points)
        guard points.count >= 2 else { return nil }

        let minX = points.map { $0[0] }.min() ?? 0
        let minZ = points.map { $0[1] }.min() ?? 0
        let shifted = walls.map { w in
            RoomWall(
                points: w.points.map { [($0[0] - minX).rounded3, ($0[1] - minZ).rounded3] },
                kind: w.kind
            )
        }
        let shiftedPts = shifted.flatMap(\.points)
        let widthM = max((shiftedPts.map { $0[0] }.max() ?? 0).rounded2, 0.5)
        let depthM = max((shiftedPts.map { $0[1] }.max() ?? 0).rounded2, 0.5)
        let height = room.walls.map { Double($0.dimensions.y) }.max() ?? 2.4
        return RoomGeometryPayload(
            walls: shifted,
            openings: [],
            widthM: widthM,
            depthM: depthM,
            wallHeightM: height.rounded2
        )
    }

    private static func wall(from surface: CapturedRoom.Surface, kind: String) -> RoomWall? {
        let half = surface.dimensions.x / 2
        guard half > 0.05 else { return nil }
        let a = surface.transform * SIMD4<Float>(-half, 0, 0, 1)
        let b = surface.transform * SIMD4<Float>(half, 0, 0, 1)
        // RoomPlan is Y-up. Use X/Z; flip Z so the plan is not mirrored vs. the capture.
        return RoomWall(
            points: [
                [Double(a.x).rounded3, Double(-a.z).rounded3],
                [Double(b.x).rounded3, Double(-b.z).rounded3],
            ],
            kind: kind
        )
    }
}

private extension Double {
    var rounded2: Double { (self * 100).rounded() / 100 }
    var rounded3: Double { (self * 1000).rounded() / 1000 }
}
#endif

enum LiDARScan {
    static var isSupported: Bool {
        #if canImport(RoomPlan)
        if #available(iOS 16.0, *) {
            return RoomCaptureSession.isSupported
        }
        #endif
        return false
    }
}
