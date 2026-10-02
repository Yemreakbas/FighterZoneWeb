import * as THREE from 'three';
import { ARENA, CAMERA } from './config.js';

/**
 * Owns the renderer, camera, lights and the static arena.
 * Fighters are added later via `stage.scene.add(...)`.
 */
export function createStage(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0b16);
  scene.fog = new THREE.Fog(0x0b0b16, 18, 45);

  const camera = new THREE.PerspectiveCamera(
    CAMERA.fov, window.innerWidth / window.innerHeight, 0.1, 200
  );
  camera.position.set(0, CAMERA.height, CAMERA.distance);
  camera.lookAt(0, 1.4, 0);

  addLights(scene);
  addArena(scene);

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  // Smooth camera target, updated every frame.
  const camTarget = new THREE.Vector3(0, 1.4, 0);

  /**
   * Side-view tracking: centre on the midpoint between the fighters and
   * pull back as they separate so both always stay in frame.
   */
  function updateCamera(dt, xA = 0, xB = 0) {
    const midX = (xA + xB) / 2;
    const spread = Math.abs(xA - xB);
    const dist = THREE.MathUtils.clamp(
      CAMERA.minDistance + spread * 0.6, CAMERA.minDistance, CAMERA.maxDistance
    );
    const k = 1 - Math.exp(-CAMERA.followLerp * dt); // frame-rate independent lerp
    camTarget.x += (midX - camTarget.x) * k;
    camera.position.x += (midX - camera.position.x) * k;
    camera.position.z += (dist - camera.position.z) * k;
    camera.lookAt(camTarget);
  }

  return {
    renderer,
    scene,
    camera,
    updateCamera,
    render: () => renderer.render(scene, camera),
  };
}

function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0x8899ff, 0x220a0a, 0.6));

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(5, 12, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -14;
  key.shadow.camera.right = 14;
  key.shadow.camera.top = 10;
  key.shadow.camera.bottom = -4;
  scene.add(key);

  // Coloured rim lights give the arena its arcade mood.
  const rimRed = new THREE.PointLight(0xff2a2a, 30, 30);
  rimRed.position.set(-10, 5, -4);
  const rimBlue = new THREE.PointLight(0x2a6bff, 30, 30);
  rimBlue.position.set(10, 5, -4);
  scene.add(rimRed, rimBlue);
}

function addArena(scene) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 30),
    new THREE.MeshStandardMaterial({ color: 0x1a1a24, roughness: 0.85, metalness: 0.1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = ARENA.groundY;
  floor.receiveShadow = true;
  scene.add(floor);

  // Fighting plane marker.
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA.halfWidth * 2 + 2, 2.4),
    new THREE.MeshStandardMaterial({ color: 0x2b1d1d, roughness: 0.6 })
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.y = ARENA.groundY + 0.005;
  lane.receiveShadow = true;
  scene.add(lane);

  // Stone pillars marking the arena boundaries.
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x3a3440, roughness: 0.9 });
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 1), pillarMat);
    pillar.position.set(side * (ARENA.halfWidth + 1.5), 3, -1.5);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    scene.add(pillar);

    const torch = new THREE.PointLight(0xff8a2a, 8, 8);
    torch.position.set(side * (ARENA.halfWidth + 1.5), 6.4, -0.8);
    scene.add(torch);
  }

  // Back wall.
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 20),
    new THREE.MeshStandardMaterial({ color: 0x14121c, roughness: 1 })
  );
  wall.position.set(0, 10, -8);
  scene.add(wall);
}
