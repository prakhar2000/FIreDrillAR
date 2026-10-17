import * as THREE from 'three';

export function createAlignment(pose, start, floorY, clockwiseDegrees = 0, scale = 1) {
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(clockwiseDegrees)) throw new Error('Enter a positive model scale and a valid facing angle.');
  const q = new THREE.Quaternion().fromArray(pose.quaternion).normalize();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  if (Math.hypot(forward.x, forward.z) < 0.1) throw new Error('Look horizontally ahead before aligning.');
  const sourceYaw = Math.atan2(-forward.x, -forward.z);
  const targetYaw = -THREE.MathUtils.degToRad(clockwiseDegrees);
  return {
    origin: new THREE.Vector3(pose.position[0], 0, pose.position[2]),
    target: new THREE.Vector3(start.x, floorY, start.z),
    rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), targetYaw - sourceYaw),
    scale, sessionId: pose.sessionId,
  };
}

export function alignPose(pose, alignment) {
  if (!alignment || pose.sessionId !== alignment.sessionId) return null;
  const position = new THREE.Vector3().fromArray(pose.position).sub(alignment.origin)
    .applyQuaternion(alignment.rotation).multiplyScalar(alignment.scale).add(alignment.target);
  const quaternion = alignment.rotation.clone().multiply(new THREE.Quaternion().fromArray(pose.quaternion)).normalize();
  return { position: position.toArray(), quaternion: quaternion.toArray() };
}
