export class Fire {
  constructor(position) {
    this.position = position;
    this.group = null;
    this.intensity = 0;
  }

  update() {}

  startSound() {}

  stopSound() {}
}

export class Smoke {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
  }

  start() {}

  update() {
    return 0;
  }

  stop() {}
}

export class ExitSign {
  constructor(position, blocked = false) {
    this.position = position;
    this.blocked = blocked;
    this.sprite = null;
  }

  setBlocked(blocked) {
    this.blocked = blocked;
  }
}
