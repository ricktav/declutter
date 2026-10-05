import Foundation
import simd

#if canImport(RoomPlan)
import RoomPlan

/// Flatten a RoomPlan `CapturedRoom` into HomeBase `rooms.upsertFromScan` geometry.
/// Walls/doors/windows become kinded 2D polylines in meters; origin is the
/// bounding-box corner so the Workbench 2D/3D plan can draw them. The objects RoomPlan
/// found (tables, storage, beds, …) become footprints in the same frame.
enum RoomPlanGeometry {
    static func payload(from room: CapturedRoom) -> RoomGeometryPayload? {
        var raw: [(points: [SIMD2<Double>], kind: String)] = []
        raw += room.walls.compactMap { segment(from: $0, kind: "wall") }
        raw += room.doors.compactMap { segment(from: $0, kind: "door") }
        raw += room.windows.compactMap { segment(from: $0, kind: "window") }
        // RoomPlan (iOS 16+) reports open doorways as `openings`; draw them as doors.
        raw += room.openings.compactMap { segment(from: $0, kind: "door") }
        let objects = room.objects.map {
            ScanPlanFrame.RawObject(kind: kindName($0.category), transform: $0.transform, dimensions: $0.dimensions)
        }
        let height = room.walls.map { Double($0.dimensions.y) }.max() ?? 2.4
        return ScanPlanFrame.build(raw: raw, objects: objects, wallHeight: height)
    }

    /// The contract's kind strings, spelled out so they never depend on reflection
    /// metadata; a case a newer RoomPlan adds passes through as its own description.
    private static func kindName(_ category: CapturedRoom.Object.Category) -> String {
        switch category {
        case .storage: return "storage"
        case .refrigerator: return "refrigerator"
        case .stove: return "stove"
        case .bed: return "bed"
        case .sink: return "sink"
        case .washerDryer: return "washerDryer"
        case .toilet: return "toilet"
        case .bathtub: return "bathtub"
        case .oven: return "oven"
        case .dishwasher: return "dishwasher"
        case .table: return "table"
        case .sofa: return "sofa"
        case .chair: return "chair"
        case .fireplace: return "fireplace"
        case .television: return "television"
        case .stairs: return "stairs"
        @unknown default: return String(String(describing: category).prefix(32))
        }
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
}

#endif

// MARK: - scan-plan-frame (pure: no RoomPlan types, so a swiftc script can check this block on a Mac)

/// The plan frame of a scan, without RoomPlan types so it can be checked on its own:
/// straighten by the longest wall, shift to the min corner, round to millimetres, and put
/// every object in that same frame in the same pass.
enum ScanPlanFrame {
    struct RawObject {
        var kind: String
        var transform: simd_float4x4
        var dimensions: simd_float3
    }

    /// `rooms.upsertFromScan` takes at most 200 objects.
    static let maxObjects = 200

    static func build(raw: [(points: [SIMD2<Double>], kind: String)], objects: [RawObject], wallHeight: Double) -> RoomGeometryPayload? {
        guard !raw.isEmpty else { return nil }

        // The capture frame follows how the phone was held, so the room sits at an
        // arbitrary angle. Turn it so the longest wall is axis-aligned, by the smallest
        // turn in [0, 90°); doors, windows and objects turn with it.
        let rot = straighteningAngle(raw.filter { $0.kind == "wall" }.map(\.points))
        let turned = raw.map { w in
            (points: w.points.map { turn($0, by: rot) }, kind: w.kind)
        }
        let all = turned.flatMap(\.points)
        guard all.count >= 2, let minX = all.map(\.x).min(), let minY = all.map(\.y).min() else { return nil }
        let origin = SIMD2(minX, minY)

        // Shift to the min corner; widths come from the rounded points so none sticks out.
        // Objects do not widen the room: one that RoomPlan put through a wall stays as
        // found (partly outside), and widthM/depthM stay the wall box.
        let walls = turned.map { w in
            RoomWall(points: w.points.map { [mm($0.x - minX), mm($0.y - minY)] }, kind: w.kind)
        }
        let pts = walls.flatMap(\.points)
        let widthM = max(cmUp(pts.map { $0[0] }.max() ?? 0), 0.5)
        let depthM = max(cmUp(pts.map { $0[1] }.max() ?? 0), 0.5)
        return RoomGeometryPayload(
            walls: walls,
            openings: [],
            widthM: widthM,
            depthM: depthM,
            wallHeightM: (wallHeight * 100).rounded() / 100,
            objects: objects.prefix(maxObjects).map { objectFootprint($0, rotation: rot, origin: origin) }
        )
    }

    /// One object's footprint in the plan frame.
    ///
    /// Rotation sign. The plan is RoomPlan's floor seen from above: plan x = world x,
    /// plan y = world z, drawn y-down. ARKit's world is right-handed with +y up, so
    /// looking down +y with x to the right puts +z down the screen: the plan is the true
    /// top view, not a mirror image. An angle φ = atan2(py, px) in that y-down plan turns
    /// from +x towards +y, i.e. clockwise on screen.
    /// - The object's local x axis in world is the transform's column 0 = (ux, uy, uz);
    ///   on the plan it points along (ux, uz), so φ = atan2(uz, ux).
    /// - Straightening maps every plan point (x, y) to (x·c − y·s, x·s + y·c), which adds
    ///   `rotation` to every plan angle: φ' = φ + rotation.
    /// - The web 2D plan draws the footprint (w along x, d along y) with SVG
    ///   `rotate(-rotDeg)`; SVG's positive angle is clockwise in its y-down frame, so the
    ///   footprint's x axis ends at plan angle −rotDeg. Hence rotDeg = −φ'.
    /// - Check with 3D: the web (and FloorPlan3D) set rotation.y = rotDeg with plan y on
    ///   +z; a turn θ about +y maps x to (cos θ, 0, −sin θ), plan angle −θ. Same rule.
    /// - A RoomPlan yaw of +ψ about world +y maps local x to (cos ψ, 0, −sin ψ), so
    ///   φ = −ψ and, unstraightened, rotDeg = +ψ: RoomPlan's yaw and rotDeg agree in sign.
    /// So rotDeg = −(atan2(uz, ux) + rotation), in degrees, then folded into (−90, 90]:
    /// a rectangle turned by 180° is the same footprint.
    static func objectFootprint(_ object: RawObject, rotation: Double, origin: SIMD2<Double>) -> ScanObjectPayload {
        let t = object.transform
        let centre = turn(SIMD2(Double(t.columns.3.x), Double(t.columns.3.z)), by: rotation) - origin
        let ux = Double(t.columns.0.x), uz = Double(t.columns.0.z)
        let phi = atan2(uz, ux) + rotation
        let w = max(Double(object.dimensions.x), 0.1)
        let d = max(Double(object.dimensions.z), 0.1)
        return ScanObjectPayload(
            kind: object.kind,
            xM: mm(centre.x - w / 2),
            yM: mm(centre.y - d / 2),
            wM: mm(w),
            dM: mm(d),
            rotDeg: foldDegrees(-phi * 180 / .pi),
            hM: mm(max(Double(object.dimensions.y), 0))
        )
    }

    /// Fold an angle into (−90, 90], rounded to 0.1°.
    static func foldDegrees(_ deg: Double) -> Double {
        var r = (deg * 10).rounded() / 10
        r = r.truncatingRemainder(dividingBy: 180)
        if r <= -90 { r += 180 }
        if r > 90 { r -= 180 }
        return r == 0 ? 0 : r // no -0 on the wire
    }

    /// Turn a plan point by `angle` (radians) about the capture origin, to whole millimetres.
    static func turn(_ p: SIMD2<Double>, by angle: Double) -> SIMD2<Double> {
        let c = cos(angle), s = sin(angle)
        return SIMD2(mm(p.x * c - p.y * s), mm(p.x * s + p.y * c))
    }

    /// The turn (radians, in [0, π/2)) that makes the longest wall segment horizontal or vertical.
    static func straighteningAngle(_ walls: [[SIMD2<Double>]]) -> Double {
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

    static func mm(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }
    /// Up to the next centimetre; whole millimetres first so 3.4 stays 3.4, not 3.41.
    static func cmUp(_ v: Double) -> Double { ((v * 1000).rounded() / 10).rounded(.up) / 100 }
}

// MARK: - end scan-plan-frame

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
