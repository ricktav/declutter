import Foundation
import simd

#if canImport(RoomPlan)
import RoomPlan

/// Flatten a RoomPlan `CapturedRoom` into HomeBase `rooms.upsertFromScan` geometry.
/// Walls/doors/windows become kinded 2D polylines in meters; origin is the
/// bounding-box corner so the Workbench 2D/3D plan can draw them.
enum RoomPlanGeometry {
    static func payload(from room: CapturedRoom) -> RoomGeometryPayload? {
        var raw: [(points: [SIMD2<Double>], kind: String)] = []
        raw += room.walls.compactMap { segment(from: $0, kind: "wall") }
        raw += room.doors.compactMap { segment(from: $0, kind: "door") }
        raw += room.windows.compactMap { segment(from: $0, kind: "window") }
        // RoomPlan (iOS 16+) reports open doorways as `openings`; draw them as doors.
        raw += room.openings.compactMap { segment(from: $0, kind: "door") }
        guard !raw.isEmpty else { return nil }

        // The capture frame follows how the phone was held, so the room sits at an
        // arbitrary angle. Turn it so the longest wall is axis-aligned, by the smallest
        // turn in [0, 90°); doors and windows turn with it.
        let rot = straighteningAngle(raw.filter { $0.kind == "wall" }.map(\.points))
        let c = cos(rot), s = sin(rot)
        let turned = raw.map { w in
            (points: w.points.map { p in
                SIMD2(Self.mm(p.x * c - p.y * s), Self.mm(p.x * s + p.y * c))
            }, kind: w.kind)
        }
        let all = turned.flatMap(\.points)
        guard all.count >= 2, let minX = all.map(\.x).min(), let minY = all.map(\.y).min() else { return nil }

        // Shift to the min corner; widths come from the rounded points so none sticks out.
        let walls = turned.map { w in
            RoomWall(points: w.points.map { [Self.mm($0.x - minX), Self.mm($0.y - minY)] }, kind: w.kind)
        }
        let pts = walls.flatMap(\.points)
        let widthM = max(Self.cmUp(pts.map { $0[0] }.max() ?? 0), 0.5)
        let depthM = max(Self.cmUp(pts.map { $0[1] }.max() ?? 0), 0.5)
        let height = room.walls.map { Double($0.dimensions.y) }.max() ?? 2.4
        return RoomGeometryPayload(
            walls: walls,
            openings: [],
            widthM: widthM,
            depthM: depthM,
            wallHeightM: (height * 100).rounded() / 100
        )
    }

    /// The turn (radians, in [0, π/2)) that makes the longest wall segment horizontal or vertical.
    private static func straighteningAngle(_ walls: [[SIMD2<Double>]]) -> Double {
        var best: (len: Double, angle: Double) = (0, 0)
        for pts in walls {
            for (a, b) in zip(pts, pts.dropFirst()) {
                let d = b - a
                let len = (d.x * d.x + d.y * d.y).squareRoot()
                if len > best.len { best = (len, atan2(d.y, d.x)) }
            }
        }
        let quarter = Double.pi / 2
        let r = (-best.angle).truncatingRemainder(dividingBy: quarter)
        return r < 0 ? r + quarter : r
    }

    /// A surface's centre line on the floor, in metres. RoomPlan is ARKit's frame:
    /// +x right, +y up, and seen from above +z points down the screen, which is the
    /// plan's +y (the Workbench 2D and 3D views draw plan-y downward / along +z).
    private static func segment(from surface: CapturedRoom.Surface, kind: String) -> (points: [SIMD2<Double>], kind: String)? {
        let half = surface.dimensions.x / 2
        guard half > 0.05 else { return nil }
        let a = surface.transform * SIMD4<Float>(-half, 0, 0, 1)
        let b = surface.transform * SIMD4<Float>(half, 0, 0, 1)
        return (points: [SIMD2(Double(a.x), Double(a.z)), SIMD2(Double(b.x), Double(b.z))], kind: kind)
    }

    private static func mm(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }
    /// Up to the next centimetre; whole millimetres first so 3.4 stays 3.4, not 3.41.
    private static func cmUp(_ v: Double) -> Double { ((v * 1000).rounded() / 10).rounded(.up) / 100 }
}

#endif

/// RoomPlan needs a LiDAR iPhone or iPad. The simulator and other devices report false,
/// and the scan screens show a short note instead of opening the capture view.
enum LiDARScan {
    static var isSupported: Bool {
        #if canImport(RoomPlan) && !targetEnvironment(simulator)
        return RoomCaptureSession.isSupported
        #else
        return false
        #endif
    }
}
