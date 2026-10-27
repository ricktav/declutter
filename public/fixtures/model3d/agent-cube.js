/**
 * FIXTURE ONLY — not inventory data.
 *
 * Same contract as a homebase-3d route-1 agent module:
 *   export function build(THREE) → Object3D / Group in metres, Y-up.
 *
 * A 20 cm moss-green cube so the Workbench viewer can be tried on a test
 * instance without a real generated model.
 */
export function build(THREE) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.2, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x5a7a52, roughness: 0.4, metalness: 0.05 }),
  );
  mesh.position.y = 0.1;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}
