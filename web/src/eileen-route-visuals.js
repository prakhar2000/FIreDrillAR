import * as THREE from 'three';

export function addRouteChevrons(parent, points) {
  for (let i = 1; i < points.length; i++) {
    const direction = points[i].clone().sub(points[i - 1]); direction.y = 0;
    const length = direction.length();
    if (length < 0.15) continue;
    direction.normalize();
    const count = Math.min(30, Math.max(1, Math.ceil(length / 0.65)));
    for (let j = 0; j < count; j++) {
      const shape = new THREE.Shape();
      shape.moveTo(-0.16, -0.08); shape.lineTo(0, 0.12); shape.lineTo(0.16, -0.08);
      shape.lineTo(0.16, -0.20); shape.lineTo(0, 0); shape.lineTo(-0.16, -0.20); shape.closePath();
      const geometry = new THREE.ShapeGeometry(shape); geometry.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x66ff99, side: THREE.DoubleSide }));
      mesh.rotation.y = Math.atan2(-direction.x, -direction.z);
      mesh.position.copy(points[i - 1]).addScaledVector(direction, length * (j + 0.5) / count);
      mesh.scale.setScalar(Math.min(1, length / 0.4)); parent.add(mesh);
    }
  }
}
