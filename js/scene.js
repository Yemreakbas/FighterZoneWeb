import * as THREE from 'three';
import { ARENA, ARENAS, CAMERA } from './config.js';

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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0b16);
  scene.fog = new THREE.Fog(0x0b0b16, 18, 45);

  const camera = new THREE.PerspectiveCamera(
    CAMERA.fov, window.innerWidth / window.innerHeight, 0.1, 200
  );
  camera.position.set(0, CAMERA.height, CAMERA.distance);
  camera.lookAt(0, 1.4, 0);

  const lights = addLights(scene);
  const arena = addArena(scene);

  // Textures for every arena are generated once up front.
  const textures = ARENAS.map((a) => ({
    floor: stoneTexture(a.floor, 30, 15),
    wall: brickTexture(a.wall),
  }));
  let arenaIndex = -1;

  /** Re-skin the shared arena geometry and lighting. */
  function setArena(i) {
    const idx = ARENAS[i] ? i : 0;
    if (idx === arenaIndex) return;
    arenaIndex = idx;
    const a = ARENAS[idx];
    scene.background.setHex(a.sky);
    scene.fog.color.setHex(a.sky);
    lights.hemi.color.setHex(a.hemiSky);
    lights.hemi.groundColor.setHex(a.hemiGround);
    lights.hemi.intensity = a.hemi;
    lights.key.color.setHex(a.key);
    lights.key.intensity = a.keyIntensity;
    lights.rims.forEach((l, j) => l.color.setHex(a.rims[j]));
    arena.torches.forEach((l) => l.color.setHex(a.torch));
    arena.floor.map = textures[idx].floor;
    arena.wall.map = textures[idx].wall;
    arena.floor.needsUpdate = arena.wall.needsUpdate = true;
    arena.pillar.color.setHex(a.pillar);
    arena.banners.forEach((m, j) => {
      m.color.setHex(a.banners[j]);
      m.emissive.setHex(a.banners[j]);
    });
  }
  setArena(0);

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  // Smooth camera target and un-shaken base position, updated every frame.
  const camTarget = new THREE.Vector3(0, 1.4, 0);
  const camBase = camera.position.clone();
  let shakeAmt = 0;
  let zoomKick = 0; // metres pushed toward the action, decays back to 0

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
    camBase.x += (midX - camBase.x) * k;
    camBase.z += (dist - camBase.z) * k;

    // Shake is applied on top of the smoothed base so it never accumulates.
    camera.position.copy(camBase);
    if (zoomKick > 0.002) {
      camera.position.z -= zoomKick;
      zoomKick *= Math.exp(-6 * dt);
    }
    if (shakeAmt > 0.002) {
      camera.position.x += (Math.random() - 0.5) * shakeAmt;
      camera.position.y += (Math.random() - 0.5) * shakeAmt;
      shakeAmt *= Math.exp(-14 * dt);
    }
    camera.lookAt(camTarget);
  }

  return {
    renderer,
    scene,
    camera,
    updateCamera,
    setArena,
    shake: (amount) => { shakeAmt = Math.max(shakeAmt, amount); },
    /** Brief push-in toward the fighters for big impacts. */
    punchZoom: (amount) => { zoomKick = Math.max(zoomKick, amount); },
    render: () => renderer.render(scene, camera),
  };
}

function addLights(scene) {
  const hemi = new THREE.HemisphereLight(0x9aa8ff, 0x2a1010, 1.1);
  scene.add(hemi);

  // Soft fill from the camera side so the fighters' visible faces read.
  const fill = new THREE.DirectionalLight(0xffe8d0, 0.7);
  fill.position.set(0, 3, 12);
  scene.add(fill);

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
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
  return { hemi, key, rims: [rimRed, rimBlue] };
}

function addArena(scene) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 30),
    new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = ARENA.groundY;
  floor.receiveShadow = true;
  scene.add(floor);

  // Fighting plane marker.
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA.halfWidth * 2 + 2, 2.4),
    new THREE.MeshStandardMaterial({ color: 0x5a2020, roughness: 0.6, transparent: true, opacity: 0.25 })
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.y = ARENA.groundY + 0.005;
  lane.receiveShadow = true;
  scene.add(lane);

  // Stone pillars marking the arena boundaries.
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x3a3440, roughness: 0.9 });
  const torches = [];
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 1), pillarMat);
    pillar.position.set(side * (ARENA.halfWidth + 1.5), 3, -1.5);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    scene.add(pillar);

    const torch = new THREE.PointLight(0xff8a2a, 8, 8);
    torch.position.set(side * (ARENA.halfWidth + 1.5), 6.4, -0.8);
    scene.add(torch);
    torches.push(torch);
  }

  // Back wall.
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 20),
    new THREE.MeshStandardMaterial({ roughness: 1 })
  );
  wall.position.set(0, 10, -8);
  scene.add(wall);

  // Glowing banners (colours set per arena).
  const banners = [-5, 5].map((x) => {
    const mat = new THREE.MeshStandardMaterial({ emissiveIntensity: 0.12, roughness: 0.95 });
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 3.2), mat);
    banner.position.set(x, 4.4, -7.9);
    scene.add(banner);
    return mat;
  });

  return { floor: floor.material, wall: wall.material, pillar: pillarMat, torches, banners };
}

// ---------------------------------------------------------------------------
// Procedural textures (drawn on a canvas, so there are no image files to host)
// ---------------------------------------------------------------------------

function canvasTexture(size, draw, repeatX = 1, repeatY = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 4;
  return tex;
}

/** Large worn stone slabs; repeat is in tiles across the floor plane. */
function stoneTexture(palette, repeatX, repeatY) {
  const [cr, cg, cb] = palette.speck;
  return canvasTexture(256, (g, n) => {
    g.fillStyle = palette.base;
    g.fillRect(0, 0, n, n);
    // Speckle noise for a gritty surface.
    for (let i = 0; i < 2500; i++) {
      const v = (Math.random() - 0.5) * 30;
      g.fillStyle = `rgba(${cr + v}, ${cg + v}, ${cb + v}, 0.35)`;
      g.fillRect(Math.random() * n, Math.random() * n, 2, 2);
    }
    // Grout lines: 2x2 slabs per tile.
    g.strokeStyle = palette.grout;
    g.lineWidth = 4;
    g.strokeRect(0, 0, n, n);
    g.beginPath();
    g.moveTo(n / 2, 0); g.lineTo(n / 2, n);
    g.moveTo(0, n / 2); g.lineTo(n, n / 2);
    g.stroke();
  }, repeatX / 2, repeatY / 2);
}

function brickTexture(palette) {
  const [cr, cg, cb] = palette.brick;
  return canvasTexture(256, (g, n) => {
    g.fillStyle = palette.base;
    g.fillRect(0, 0, n, n);
    const rows = 8;
    const h = n / rows;
    const w = n / 4;
    for (let r = 0; r < rows; r++) {
      const offset = r % 2 ? w / 2 : 0;
      for (let c = -1; c < 5; c++) {
        const v = (Math.random() - 0.5) * 14;
        g.fillStyle = `rgb(${cr + v}, ${cg + v}, ${cb + v})`;
        g.fillRect(c * w + offset + 2, r * h + 2, w - 4, h - 4);
      }
    }
  }, 8, 4);
}
