import { describe, expect, it } from "vitest";
import type { RoomGeometry } from "@db/schema";
import { snapPosToWalls } from "../lib/snapToWall";

// a 4 x 3 m room drawn as four wall segments
const box: RoomGeometry["walls"] = [
  { points: [[0, 0], [4, 0]] },
  { points: [[4, 0], [4, 3]] },
  { points: [[4, 3], [0, 3]] },
  { points: [[0, 3], [0, 0]] },
];
const pos = (xM: number, yM: number, wM = 1, dM = 0.5, rotDeg = 0) => ({ xM, yM, wM, dM, rotDeg, hM: 0.8, baseM: 0 });

describe("snapPosToWalls", () => {
  it("snaps a box 0.36 m off the left wall flush", () => {
    const r = snapPosToWalls(pos(0.36, 1.2), box, 4, 3)!;
    expect(r.side).toBe("left");
    expect(r.kind).toBe("wall");
    expect(r.movedM).toBeCloseTo(0.36);
    expect(r.pos).toEqual({ ...pos(0, 1.2) });
  });

  it("pulls a box that sits through the wall back to flush", () => {
    const r = snapPosToWalls(pos(-0.28, 1.2), box, 4, 3)!;
    expect(r.side).toBe("left");
    expect(r.movedM).toBeCloseTo(0.28);
    expect(r.pos.xM).toBeCloseTo(0);
  });

  it("uses the rotated footprint", () => {
    // 2 x 0.5 turned 90 deg: its footprint is 0.5 wide and 2 deep
    const p = pos(0.05, 0.8, 2, 0.5, 90); // centre (1.05, 1.05); footprint x 0.8..1.3, y 0.05..2.05
    const r = snapPosToWalls(p, box, 4, 3)!;
    expect(r.side).toBe("top");
    expect(r.movedM).toBeCloseTo(0.05);
    expect(r.pos.yM).toBeCloseTo(0.75);
    expect(r.pos.xM).toBe(0.05);
    expect(r.pos.rotDeg).toBe(90);
    // unrotated, the same box would be 0.8 m from the top: too far, and 0.05 from the left
    expect(snapPosToWalls({ ...p, rotDeg: 0 }, box, 4, 3)!.side).toBe("left");
  });

  it("pulls back a Thing whose centre is already through the wall, never pushes it out", () => {
    const r = snapPosToWalls(pos(-0.28, 1.2, 0.5), box, 4, 3)!; // centre x -0.03
    expect(r.side).toBe("left");
    expect(r.movedM).toBeCloseTo(0.28);
    expect(r.pos.xM).toBeCloseTo(0);
  });

  it("in an L-shaped room snaps to the inner wall from the room side", () => {
    // 4 x 4 minus the quadrant x > 1.5, y > 1.5: the walls' bounding-box centre (2, 2) lies outside the room
    const L: RoomGeometry["walls"] = [
      { points: [[0, 0], [4, 0]] },
      { points: [[4, 0], [4, 1.5]] },
      { points: [[4, 1.5], [1.5, 1.5]] },
      { points: [[1.5, 1.5], [1.5, 4]] },
      { points: [[1.5, 4], [0, 4]] },
      { points: [[0, 4], [0, 0]] },
    ];
    const near = snapPosToWalls(pos(1.1, 3, 0.3, 0.3), L, 4, 4)!;
    expect(near).toMatchObject({ side: "right", kind: "wall" });
    expect(near.pos.xM).toBeCloseTo(1.2);
    expect(near.movedM).toBeCloseTo(0.1);
    const far = snapPosToWalls(pos(0.9, 3, 0.3, 0.3), L, 4, 4)!;
    expect(far).toMatchObject({ side: "right" });
    expect(far.pos.xM).toBeCloseTo(1.2);
    expect(far.movedM).toBeCloseTo(0.3);
  });

  it("returns movedM 0 for a Thing already flush", () => {
    const r = snapPosToWalls(pos(0, 1.2), box, 4, 3)!;
    expect(r).toMatchObject({ side: "left", movedM: 0 });
    expect(r.pos.xM).toBe(0);
  });

  it("on a tie the first wall segment in order wins", () => {
    // 0.2 from the top wall (segment 0) and 0.2 from the left wall (segment 3)
    const r = snapPosToWalls(pos(0.2, 0.2), box, 4, 3)!;
    expect(r.side).toBe("top");
    expect(r.pos).toMatchObject({ xM: 0.2, yM: 0 });
  });

  it("uses the outer box only when the room has no straight wall segments", () => {
    // one straight wall far away: no box fallback to the left edge
    const far: RoomGeometry["walls"] = [{ points: [[4, 0], [4, 3]] }];
    expect(snapPosToWalls(pos(0.2, 1.2), far, 4, 3)).toBeNull();
  });

  it("returns null when no wall is within 0.5 m", () => {
    expect(snapPosToWalls(pos(1.5, 1.2), box, 4, 3)).toBeNull();
  });

  it("picks the nearer of two walls", () => {
    // 0.3 from the right wall (x 2.7..3.7), 0.2 from the bottom (y 2.3..2.8)
    const r = snapPosToWalls(pos(2.7, 2.3), box, 4, 3)!;
    expect(r.side).toBe("bottom");
    expect(r.movedM).toBeCloseTo(0.2);
    expect(r.pos.yM).toBeCloseTo(2.5);
    expect(r.pos.xM).toBe(2.7);
  });

  it("counts a door or window segment as its wall line", () => {
    const walls: RoomGeometry["walls"] = [
      { points: [[0, 0], [4, 0]] },
      { points: [[4, 0], [4, 1]] },
      { points: [[4, 1], [4, 2]], kind: "window" },
      { points: [[4, 2], [4, 3]] },
      { points: [[0, 3], [0, 0]] },
    ];
    const r = snapPosToWalls(pos(2.8, 1.25), walls, 4, 3)!; // x 2.8..3.8, y 1.25..1.75: only the window reaches it
    expect(r).toMatchObject({ side: "right", kind: "window" });
    expect(r.pos.xM).toBeCloseTo(3);
  });

  it("skips diagonal segments and falls back to the room's outer box", () => {
    const diag: RoomGeometry["walls"] = [{ points: [[0, 0], [4, 3]] }];
    const r = snapPosToWalls(pos(0.2, 1.2), diag, 4, 3)!;
    expect(r).toMatchObject({ side: "left", kind: "wall" });
    expect(r.pos.xM).toBeCloseTo(0);
    expect(snapPosToWalls(pos(0.2, 1.2), diag, null, null)).toBeNull();
  });
});
