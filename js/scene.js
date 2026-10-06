import * as THREE from 'three';
import { ARENA, ARENAS, CAMERA } from './config.js';
import { platformsAt } from './fighter.js';

/**
 * Render quality tiers (DÜŞÜK / ORTA / YÜKSEK): pixel-ratio cap and
 * key-light shadow map size (0 = no shadows). In 'auto' mode phones start at
 * medium, other devices at high, and any device drops a tier when frames run
 * slow (see `reportFrame`). A fixed tier chosen in the menu is kept as is.
 */
const QUALITY = [
  { dpr: 0.85, shadow: 0 },
  { dpr: 1.25, shadow: 1024 },
  { dpr: 1.75, shadow: 2048 },
];
const SLOW_FRAME = 1 / 50;  // average frame time that triggers a downgrade
const SAMPLE_TIME = 2;      // seconds per measurement window
const WARMUP = 3;           // ignore the first seconds (shader compiles)

/**
 * Owns the renderer, camera, lights and the static arena.
 * Fighters are added later via `stage.scene.add(...)`.
 */
export function createStage(container) {
  const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  // On phones the high pixel density already smooths edges; MSAA on top of
  // it costs a lot of fill rate for little gain.
  const renderer = new THREE.WebGLRenderer({ antialias: !touch, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft costs several times more per pixel
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

  const autoTier = touch ? 1 : 2;
  let mode = 'auto';      // 'auto' or a fixed tier index
  let quality = autoTier;
  function applyQuality() {
    const q = QUALITY[quality];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.dpr));
    renderer.setSize(window.innerWidth, window.innerHeight);
    lights.key.castShadow = q.shadow > 0;
    if (q.shadow) {
      lights.key.shadow.mapSize.set(q.shadow, q.shadow);
      lights.key.shadow.map?.dispose();
      lights.key.shadow.map = null; // re-created at the new size
    }
  }
  applyQuality();

  // Frame-time monitor for automatic downgrades (never upgrades: a tier
  // change recompiles shaders, so it should happen at most twice).
  let monitorAge = 0;
  let windowTime = 0;
  let windowFrames = 0;
  function reportFrame(dt) {
    monitorAge += dt;
    if (mode !== 'auto' || monitorAge < WARMUP || quality === 0) return;
    windowTime += dt;
    windowFrames++;
    if (windowTime < SAMPLE_TIME) return;
    if (windowTime / windowFrames > SLOW_FRAME) {
      quality--;
      applyQuality();
      monitorAge = 0; // let the new tier settle before judging it
    }
    windowTime = 0;
    windowFrames = 0;
  }

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
    arena.floor.map = textures[idx].floor;
    arena.wall.map = textures[idx].wall;
    arena.floor.needsUpdate = arena.wall.needsUpdate = true;
    arena.pillar.color.setHex(a.pillar);
    arena.lip.emissive.setHex(a.torch);
    arena.flame.color.setHex(a.torch);
    arena.glow.color.setHex(a.torch);
    arena.pool.color.setHex(a.torch);
    arena.ember.color.setHex(a.torch);
    arena.emblem.color.setHex(a.torch);
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
   * Side-view tracking: centre on the fighters' bounding box and pull back
   * as they spread out (sideways or up onto platforms) so all stay in frame.
   * `points` are the fighters' feet positions [{ x, y }].
   */
  function updateCamera(dt, points) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const midX = (minX + maxX) / 2;
    // Raise the view toward fighters up on platforms, but keep the floor in shot.
    const lift = Math.min((minY + maxY) / 2, 1.8);
    // Wide phone screens show plenty of width: come closer so fighters
    // don't end up tiny on a short display.
    const closer = camera.aspect > 1.9 ? 0.82 : 1;
    const dist = closer * THREE.MathUtils.clamp(
      CAMERA.minDistance + Math.max((maxX - minX) * 0.6, (maxY - minY) * 1.4),
      CAMERA.minDistance, CAMERA.maxDistance,
    );
    const k = 1 - Math.exp(-CAMERA.followLerp * dt); // frame-rate independent lerp
    camTarget.x += (midX - camTarget.x) * k;
    camTarget.y += (1.4 + lift - camTarget.y) * k;
    camBase.x += (midX - camBase.x) * k;
    camBase.y += (CAMERA.height + lift - camBase.y) * k;
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

  /** Place the platforms for match time `clock` (moving ones slide along X). */
  function updatePlatforms(clock) {
    platformsAt(clock).forEach((p, i) => {
      arena.platforms[i].position.x = (p.x0 + p.x1) / 2;
    });
  }

  /** Ambient animation: torch flames flicker, banners stir. `time` in seconds. */
  function animate(time) {
    arena.updateEmbers(time);
    arena.flames.forEach(({ flame, glow }, i) => {
      const k = 1 + Math.sin(time * 13 + i * 2.1) * 0.12 + Math.sin(time * 29 + i) * 0.06;
      flame.scale.set(1, k, 1);
      glow.scale.setScalar(1.3 * (0.94 + k * 0.06));
    });
    // Negative X tilts the hanging cloth's tail toward the camera; it always
    // stays forward, so it never swings back into the wall.
    arena.bannerPivots.forEach((b, i) => {
      b.rotation.x = -0.04 - Math.sin(time * 0.9 + i * 1.7) * 0.025;
    });
  }

  return {
    renderer,
    scene,
    camera,
    updateCamera,
    updatePlatforms,
    animate,
    reportFrame,
    get quality() { return quality; },
    /** 'auto' (adaptive) or a fixed tier 0..2. */
    setQualityMode(m) {
      mode = m === 0 || m === 1 || m === 2 ? m : 'auto';
      quality = mode === 'auto' ? autoTier : mode;
      monitorAge = windowTime = windowFrames = 0;
      applyQuality();
    },
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
  // Tight around the arena so the shadow map's texels aren't wasted.
  key.shadow.camera.left = -11;
  key.shadow.camera.right = 11;
  key.shadow.camera.top = 9;
  key.shadow.camera.bottom = -2;
  scene.add(key);

  // Coloured rim lights give the arena its arcade mood.
  const rimRed = new THREE.PointLight(0xff2a2a, 30, 30);
  rimRed.position.set(-10, 5, -4);
  const rimBlue = new THREE.PointLight(0x2a6bff, 30, 30);
  rimBlue.position.set(10, 5, -4);
  scene.add(rimRed, rimBlue);
  return { hemi, key, rims: [rimRed, rimBlue] };
}

const smooth = (a, b, v) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Bake a brightness falloff into a plane's vertex colours; it multiplies the
 * texture, so light pools on the fight and fades into the gloom for free.
 * `fn(x, y)` gets the plane's local coordinates and returns 0..1.
 */
function bakeShade(geo, fn) {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) colors.fill(fn(pos.getX(i), pos.getY(i)), i * 3, i * 3 + 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** A wall slice with a round-topped opening: `w` wide, `h` tall, extruded `depth` along +Z. */
function archGeometry(w, h, opening, depth) {
  const r = opening / 2;
  const spring = h - r - 0.25; // a band of stone above the arch
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(-w / 2, h);
  s.lineTo(w / 2, h);
  s.lineTo(w / 2, 0);
  s.lineTo(r, 0);
  s.lineTo(r, spring);
  s.absarc(0, spring, r, 0, Math.PI, false);
  s.lineTo(-r, 0);
  s.lineTo(-w / 2, 0);
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 14 });
}

function addArena(scene) {
  // Floor: brightest where the fight is, darker toward the camera and the wall.
  const floor = new THREE.Mesh(
    bakeShade(new THREE.PlaneGeometry(60, 30, 40, 20), (x, y) => {
      const d = Math.hypot(x / 15, y / (y < 0 ? 6 : 10)); // local -y faces the camera
      return 1 - 0.55 * smooth(0.35, 1.2, d);
    }),
    new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.1, vertexColors: true })
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

  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x3a3440, roughness: 0.9 });
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x2a2a32, roughness: 0.5, metalness: 0.6 });
  const solid = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // Stone pillars marking the arena boundaries, with a plinth and a capital
  // (only the shaft casts a shadow; the trim isn't worth a shadow-pass draw).
  for (const side of [-1, 1]) {
    const x = side * (ARENA.halfWidth + 1.5);
    for (const [w, h, y] of [[1, 6, 3], [1.3, 0.35, 0.175], [1.3, 0.3, 5.85]]) {
      const block = solid(new THREE.BoxGeometry(w, h, w), pillarMat);
      block.position.set(x, y, -1.5);
      block.castShadow = h > 1;
      scene.add(block);
    }
  }

  // Back wall: fades into darkness toward the top and the far sides.
  const wall = new THREE.Mesh(
    bakeShade(new THREE.PlaneGeometry(60, 20, 30, 20), (x, y) =>
      (1 - 0.75 * smooth(2, 16, y + 10)) * (1 - 0.4 * smooth(10, 25, Math.abs(x)))),
    new THREE.MeshStandardMaterial({ roughness: 1, vertexColors: true })
  );
  wall.position.set(0, 10, -8);
  scene.add(wall);

  // Banners hanging from iron rods: emblem and swallow-tail cut drawn in
  // greys, so the per-arena colour tints them. They sway a little (animate).
  const bannerTex = bannerTexture();
  const bannerMats = [];
  const bannerPivots = [-5, 5].map((x) => {
    const mat = new THREE.MeshStandardMaterial({
      map: bannerTex, emissiveMap: bannerTex, emissiveIntensity: 0.14,
      alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95,
    });
    bannerMats.push(mat);
    const pivot = new THREE.Group();
    pivot.position.set(x, 6.4, -7.85); // high enough that the tail clears the platforms
    scene.add(pivot);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.8), mat);
    cloth.position.y = -1.42;
    pivot.add(cloth);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.75, 8), ironMat);
    rod.rotation.z = Math.PI / 2;
    pivot.add(rod);
    for (const end of [-0.9, 0.9]) {
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), ironMat);
      knob.position.x = end;
      pivot.add(knob);
    }
    return pivot;
  });

  // Platforms: stone slabs with a glowing front lip so their edge reads at a
  // glance. Each is a group centred on the platform so moving ones (see
  // updatePlatforms) carry their chains along. Side slabs rest on a stone
  // arch behind the fighting plane; the top one hangs on chains.
  const lipMat = new THREE.MeshStandardMaterial({ color: 0xffb060, emissive: 0xff8a2a, emissiveIntensity: 0.6, roughness: 0.5 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x15131a, roughness: 0.9 });
  const SLAB = ARENA.slab;
  const DEPTH = 1.8;
  const platforms = ARENA.platforms.map((p) => {
    const w = p.x1 - p.x0;
    const group = new THREE.Group();
    group.position.x = (p.x0 + p.x1) / 2;
    scene.add(group);

    const slab = solid(new THREE.BoxGeometry(w, SLAB, DEPTH), pillarMat);
    slab.position.y = p.y - SLAB / 2;
    group.add(slab);
    // A dark band along the underside of the front edge: the slab reads as thick, carved stone.
    const trim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.07, 0.06), trimMat);
    trim.position.set(0, p.y - SLAB + 0.035, DEPTH / 2 + 0.01);
    group.add(trim);

    const lip = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, 0.05), lipMat);
    lip.position.set(0, p.y - 0.03, DEPTH / 2);
    group.add(lip);

    if (!p.move) {
      const arch = solid(archGeometry(w - 0.2, p.y - SLAB, 1.9, 0.4), pillarMat);
      arch.position.z = -DEPTH / 2;
      group.add(arch);
    } else {
      for (const x of [-w / 2 + 0.3, w / 2 - 0.3]) {
        const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 6, 6), ironMat);
        chain.position.set(x, p.y + 3, -DEPTH / 2 + 0.2);
        group.add(chain);
      }
    }
    return group;
  });

  const details = addDetails(scene, pillarMat, ironMat);

  return {
    floor: floor.material, wall: wall.material, pillar: pillarMat, banners: bannerMats, bannerPivots,
    lip: lipMat, platforms, ...details,
  };
}

/**
 * Set dressing: back-wall columns with flickering torch flames, crates and
 * barrels by the boundary pillars, chains in the gloom and a floor emblem.
 * Everything is static and uses unlit or shared materials and no extra
 * lights, so it adds draw calls but almost no shading cost. Static meshes
 * skip per-frame matrix updates.
 */
function addDetails(scene, stoneMat, ironMat) {
  const freeze = (m) => {
    m.updateMatrix();
    m.matrixAutoUpdate = false;
    scene.add(m);
    return m;
  };

  // Columns along the back wall, each with a torch: an iron arm and bowl, a
  // two-layer flame, a glow halo and a soft pool of light on the stone.
  const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false };
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a, opacity: 0.85, ...additive });
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff0c8, opacity: 0.9, ...additive });
  const glowTex = glowTexture();
  const glowMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xff8a2a, opacity: 0.55, ...additive });
  const poolMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xff8a2a, opacity: 0.2, ...additive });
  const flameGeo = new THREE.ConeGeometry(0.14, 0.5, 8);
  const coreGeo = new THREE.ConeGeometry(0.07, 0.28, 8);
  const flames = [];
  for (const x of [-11, -2.6, 2.6, 11]) {
    const column = new THREE.Mesh(new THREE.BoxGeometry(1, 12, 0.7), stoneMat);
    column.position.set(x, 6, -7.6);
    freeze(column);
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.5, 0.9), stoneMat);
    plinth.position.set(x, 0.25, -7.6);
    freeze(plinth);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.42), ironMat);
    arm.position.set(x, 3.56, -7.04);
    freeze(arm);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.08, 0.2, 10), ironMat);
    bowl.position.set(x, 3.7, -6.84);
    freeze(bowl);

    const flame = new THREE.Group();
    flame.position.set(x, 3.8, -6.84);
    const outer = new THREE.Mesh(flameGeo, flameMat);
    outer.position.y = 0.25;
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.y = 0.14;
    flame.add(outer, core);
    scene.add(flame);
    const glow = new THREE.Sprite(glowMat);
    glow.position.set(x, 4.05, -6.8);
    glow.scale.setScalar(1.3);
    scene.add(glow);
    const pool = new THREE.Sprite(poolMat);
    pool.position.set(x, 3.95, -7.2);
    pool.scale.setScalar(3.4);
    scene.add(pool);
    flames.push({ flame, glow });
  }

  // Crates by the left pillar, barrels by the right one (behind the lane).
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9, map: crateTexture() });
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x4a2f1a, roughness: 0.85 });
  const band = new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.6, metalness: 0.4 });
  for (const [x, y, z, s, r] of [[-9.6, 0.45, -2.6, 0.9, 0.2], [-8.6, 0.4, -3.1, 0.8, -0.3], [-9.2, 1.3, -2.9, 0.8, 0.5]]) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), wood);
    crate.position.set(x, y, z);
    crate.rotation.y = r;
    freeze(crate);
  }
  const barrelGeo = new THREE.CylinderGeometry(0.38, 0.38, 1, 12);
  const bandGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.08, 12);
  for (const [x, z] of [[9.2, -2.5], [10.0, -3.2], [8.6, -3.4]]) {
    const barrel = new THREE.Mesh(barrelGeo, darkWood);
    barrel.position.set(x, 0.5, z);
    freeze(barrel);
    for (const y of [0.2, 0.8]) {
      const ring = new THREE.Mesh(bandGeo, band);
      ring.position.set(x, y, z);
      freeze(ring);
    }
  }

  // Chains hanging in the background.
  for (const [x, len] of [[-6.5, 4], [-5.9, 2.8], [7.2, 3.4]]) {
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 6), ironMat);
    chain.position.set(x, 10 - len / 2, -5.5);
    freeze(chain);
  }

  // Arena emblem painted on the floor, tinted per arena.
  const emblemMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.18, depthWrite: false });
  for (const [inner, outer] of [[2.2, 2.4], [1.2, 1.3]]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 48), emblemMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, ARENA.groundY + 0.008, -0.2);
    freeze(ring);
  }

  // Embers drifting up from the torches: one Points draw call.
  const EMBERS = 70;
  const emberPos = new Float32Array(EMBERS * 3);
  const emberSeed = Array.from({ length: EMBERS }, () => ({
    x: [-11, -2.6, 2.6, 11][Math.floor(Math.random() * 4)] + (Math.random() - 0.5) * 0.6,
    z: -6.9 + Math.random() * 0.6,
    speed: 0.4 + Math.random() * 0.6,
    offset: Math.random() * 10,
    drift: (Math.random() - 0.5) * 0.8,
  }));
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(emberPos, 3));
  const emberMat = new THREE.PointsMaterial({
    color: 0xffa040, size: 0.07, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const embers = new THREE.Points(emberGeo, emberMat);
  embers.frustumCulled = false;
  scene.add(embers);

  /** Each ember rises from its torch for a few metres, then starts over. */
  function updateEmbers(time) {
    emberSeed.forEach((e, i) => {
      const h = (time * e.speed + e.offset) % 5;
      emberPos[i * 3] = e.x + Math.sin(time * 1.3 + e.offset) * 0.2 + e.drift * h * 0.3;
      emberPos[i * 3 + 1] = 4.1 + h;
      emberPos[i * 3 + 2] = e.z;
    });
    emberGeo.attributes.position.needsUpdate = true;
  }

  return { flames, flame: flameMat, glow: glowMat, pool: poolMat, emblem: emblemMat, ember: emberMat, updateEmbers };
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

/** Soft round glow (white centre fading out) for additive halo sprites. */
export function glowTexture() {
  return canvasTexture(64, (g, n) => {
    const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
  });
}

/**
 * Banner cloth: white with grey trim and emblem (the material colour tints
 * it), cut into a swallow tail at the bottom (transparent, see alphaTest).
 */
function bannerTexture() {
  const canvas = document.createElement('canvas');
  const W = 128;
  const H = 256;
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(W, 0);
  g.lineTo(W, H - 4);
  g.lineTo(W / 2, H - 40);
  g.lineTo(0, H - 4);
  g.closePath();
  g.fill();
  g.fillStyle = '#9a9a9a';
  g.fillRect(0, 8, W, 8);
  g.fillRect(0, 22, W, 3);
  g.strokeStyle = '#9a9a9a';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(6, H - 26);
  g.lineTo(W / 2, H - 58);
  g.lineTo(W - 6, H - 26);
  g.stroke();
  // Emblem: a ring around a diamond.
  const cy = 112;
  g.lineWidth = 7;
  g.beginPath();
  g.arc(W / 2, cy, 36, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#8a8a8a';
  g.beginPath();
  g.moveTo(W / 2, cy - 24);
  g.lineTo(W / 2 + 17, cy);
  g.lineTo(W / 2, cy + 24);
  g.lineTo(W / 2 - 17, cy);
  g.closePath();
  g.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Light wood planks with a darker frame and brace (the material colour tints it). */
function crateTexture() {
  return canvasTexture(128, (g, n) => {
    g.fillStyle = '#e6dccf';
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(90, 60, 30, ${Math.random() * 0.12})`;
      g.fillRect(Math.random() * n, Math.random() * n, 10 + Math.random() * 30, 1);
    }
    g.strokeStyle = 'rgba(70, 45, 22, 0.55)';
    g.lineWidth = 2;
    for (let i = 1; i < 4; i++) {
      g.beginPath();
      g.moveTo(0, (i * n) / 4);
      g.lineTo(n, (i * n) / 4);
      g.stroke();
    }
    g.strokeStyle = 'rgba(60, 38, 18, 0.75)';
    g.lineWidth = 12;
    g.strokeRect(6, 6, n - 12, n - 12);
    g.lineWidth = 10;
    g.beginPath();
    g.moveTo(10, n - 10);
    g.lineTo(n - 10, 10);
    g.stroke();
  });
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
