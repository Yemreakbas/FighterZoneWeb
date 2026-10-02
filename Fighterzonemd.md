# PROJECT SPECIFICATION: Web-Based 3D P2P Fighting Game (Three.js)

**Context & Role:**
You are an expert game developer and senior software engineer. I need you to develop a fully functional, static web-based 3D fighting game (Mortal Kombat style 1v1 and vs Bot mode) using Three.js and PeerJS. 

Read the following architectural constraints and gameplay mechanics carefully before writing any code. Strict adherence to these rules is mandatory.

## 1. STRICT ARCHITECTURAL CONSTRAINTS

*   **Hosting & File Paths (CRITICAL):**
    *   The project will be hosted on Cloudflare Pages under a static subfolder structure (e.g., `games/fighter-game/`).
    *   **NO ABSOLUTE PATHS:** Never use absolute root paths like `/assets/...` or `/style.css`.
    *   **STRICTLY RELATIVE PATHS:** All asset and file references must begin with `./` (e.g., `./assets/model.glb`, `./textures/bg.png`, `./style.css`, `./js/main.js`).
*   **Tech Stack & Build System:**
    *   Use pure HTML, CSS, and ES Modules (Vanilla JS).
    *   **NO BUILD TOOLS:** Do not use Webpack, Vite, npm, or any Node.js build steps. The code must be runnable directly in the browser.
    *   **CDNs ONLY:** Load Three.js, PeerJS, and any other required libraries via CDN using `<script type="importmap">` or standard `<script src="...">` tags.
*   **Networking Architecture (Multiplayer):**
    *   **NO EXTERNAL SERVERS:** Do not use custom Node.js servers, Socket.io, or paid WebSocket services.
    *   **P2P ONLY:** Use PeerJS (WebRTC) for all multiplayer requirements.
    *   **Lobby/Host System:** 
        *   Player 1 clicks "Oda Kur (Host)" and the system generates a random 4-6 digit Room Code.
        *   Player 2 clicks "Odaya Katıl (Join)", enters the code, and connects directly to Player 1's browser.
    *   **State Authority (Master-Slave):** The Host is the authoritative server. The game loop, physics, collision detection, and state synchronization run strictly on the Host. The Host broadcasts JSON state packets via P2P `DataConnection` to the Client. The Client only sends input commands (e.g., `{ input: 'PUNCH' }`) and renders the received state.

## 2. GAME DESIGN & MECHANICS

### A. Core Gameplay (Mortal Kombat Style)
*   **Camera & Perspective:** 2.5D perspective. 3D characters moving on a 2D plane (X and Y axis movement, limited Z axis for depth/dodging if necessary, but keep it simple initially). Side-view camera tracking the midpoint between the two fighters.
*   **Characters:** For this initial build, use modular Three.js primitive shapes (e.g., BoxGeometry for torso, cylinders for limbs) grouped into a `THREE.Group` so they can be easily replaced with GLTF models later.
*   **Actions:** 
    *   Idle, Move Left/Right, Jump, Crouch.
    *   Basic Attack (Punch), Heavy Attack (Kick), Block.
*   **Hitboxes & Hurtboxes:** Implement basic AABB (Axis-Aligned Bounding Box) collision or distance-based hit detection between character attack points and the opponent's body.
*   **Health System:** 100 HP per player. Display a classic top-screen health bar UI (using HTML/CSS overlaid on the canvas).

### B. Game Modes
1.  **Multiplayer (P2P):** 1v1 over PeerJS as described in the networking constraints.
2.  **Single Player vs Bot (AI):** If a player chooses to play solo, they fight an AI opponent.
    *   **Progressive Difficulty:** The bot's behavior must scale. Round 1: Slow reactions, rarely blocks. Round 2+: Faster movement, aggressive combos, higher probability of blocking user attacks.
    *   The bot logic should run in the standard Host game loop.

## 3. IMPLEMENTATION ROADMAP (Expected Outputs)

Please generate the necessary code files cleanly. You can split them into logical ES modules (e.g., `./js/game.js`, `./js/network.js`, `./js/player.js`) or provide a single, highly structured `index.html` with well-commented inline modules.

**Required Components:**
1.  **`index.html`:** The main entry point, containing the UI overlay (Main Menu, Host/Join buttons, Room Code display, Health Bars), the Canvas container, and the Import Maps.
2.  **Network Logic:** Functions for initializing PeerJS, creating a host ID from a short code (e.g., prefixing the 4-digit code to avoid PeerJS ID collisions), connecting, and handling the JSON payload stream.
3.  **Game Engine / Loop:** RequestAnimationFrame loop. Delta time calculation. 
4.  **Physics & Combat:** Hitbox checking, state machines for character animations (even if procedural/math-based for primitives), knockback logic.

## 4. CODE QUALITY & SENIOR GUIDELINES
*   Write defensive code. Handle PeerJS connection drops or latency gracefully.
*   Use `const` and `let` appropriately. 
*   Comment complex logic (especially the WebRTC state interpolation and 3D hitbox math).
*   Keep the UI modern but minimal (CSS flexbox, glassmorphism or retro arcade style).

**Begin your response by writing the code files.** I am ready to implement this directly into my Cloudflare Pages static setup.