// The three.js scene behind WireframeViewer. This file (and WireframeViewer.tsx,
// its only importer) is the ONLY place `three` may be imported: both live in the
// lazily loaded viewer chunk, so the main bundle never pays for three.js.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { DecodedBundle } from '../../lib/swf';
import { boundsOf, markerRadius, orbitFitDistance, viewInset, type Bounds } from '../../lib/wireframe';
import type { WireMarker } from './markers';

const BACKGROUND = 0x07111f; // --t-bg
const LINE_COLOR = 0x3fd0ff; // --t-accent
const LINE_OPACITY = 0.32;
const MARKER_COLOR = 0x3be38b; // --t-good
const SELECTED_COLOR = 0xffffff;
const FOV_DEG = 35;
/** Opening view: three-quarter, from the front and above (the approved spike's camera). */
const HOME_DIR = new Vector3(-37, 21, -46).normalize();
const HOME_ELEVATION = Math.asin(HOME_DIR.y);
const FIT_MARGIN = 1.08;
const AUTO_ROTATE_SPEED = 0.6;
const SELECTED_SCALE = 1.8;
const HOVER_SCALE = 1.35;
const HALO_SCALE = 3.4;
/**
 * How far the orbit target travels from the ship's centre toward a selected port
 * (1 = the port itself, as in the full-window spike). The panel is small: going
 * all the way slides half of a long ship out of view when a nose or tail port is
 * picked, so the view pans part-way — the port moves toward the middle and the
 * ship stays readable.
 */
const FOCUS_BLEND = 0.5;
/** Smallest pointer target for a marker, in CSS pixels (markers on a capital ship are tiny). */
const MIN_HIT_PX = 10;
/** A press that moves less than this is a click, not a drag. */
const CLICK_SLOP_PX = 5;

export interface StageOptions {
  reducedMotion: boolean;
  onSelect(id: string): void;
  /** `label` null = nothing hovered; x/y are CSS pixels inside the host. */
  onHover(label: string | null, x: number, y: number): void;
  /** The GL context was lost; the stage is no longer drawing. */
  onContextLost(): void;
}

interface MarkerMesh extends Mesh<SphereGeometry, MeshBasicMaterial> {
  userData: { id: string; label: string };
}

export class WireframeStage {
  private readonly host: HTMLElement;
  private readonly opts: StageOptions;
  private readonly renderer: WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV_DEG, 1, 0.1, 5000);
  private readonly controls: OrbitControls;
  /** Everything in bundle space, shifted so the bundle centre sits at the origin. */
  private readonly ship = new Group();
  private readonly lineGeometry = new BufferGeometry();
  private readonly lineMaterial: LineBasicMaterial;
  private readonly sphere = new SphereGeometry(1, 20, 14);
  private readonly halo: Mesh<SphereGeometry, MeshBasicMaterial>;
  private readonly positions: Float32Array;
  private readonly bounds: Bounds;
  /** Orbit target of the opening view (scene space). */
  private readonly home = new Vector3();
  private readonly markerSize: number;
  private readonly resizeObserver: ResizeObserver | null;
  private markers: MarkerMesh[] = [];
  private selectedId: string | null = null;
  private hovered: MarkerMesh | null = null;
  private goal: Vector3 | null = null;
  private interacted = false;
  private disposed = false;
  private frame = 0;
  private last = 0;
  private width = 0;
  private height = 0;
  private insetRight = 0;
  private down: { x: number; y: number } | null = null;
  private readonly scratch = new Vector3();
  private readonly delta = new Vector3();

  /** Throws when a WebGL context cannot be created. */
  constructor(host: HTMLElement, decoded: DecodedBundle, opts: StageOptions) {
    this.host = host;
    this.opts = opts;
    this.positions = decoded.positions;
    this.bounds = boundsOf(decoded.positions);
    this.markerSize = markerRadius(this.bounds.radius);

    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(BACKGROUND, 1);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 't-wire-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(this.canvas);

    const [cx, cy, cz] = decoded.header.center;
    this.ship.position.set(-cx, -cy, -cz);
    this.scene.add(this.ship);
    this.home.set(this.bounds.center[0] - cx, this.bounds.center[1] - cy, this.bounds.center[2] - cz);

    this.lineGeometry.setAttribute('position', new BufferAttribute(decoded.positions, 3));
    this.lineMaterial = new LineBasicMaterial({
      color: LINE_COLOR,
      transparent: true,
      opacity: LINE_OPACITY,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const lines = new LineSegments(this.lineGeometry, this.lineMaterial);
    lines.frustumCulled = false;
    this.ship.add(lines);

    this.halo = new Mesh(
      this.sphere,
      new MeshBasicMaterial({
        color: LINE_COLOR,
        transparent: true,
        opacity: 0.38,
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.halo.renderOrder = 1;
    this.halo.visible = false;
    this.ship.add(this.halo);

    const r = this.bounds.radius;
    this.camera.near = Math.max(r / 500, 0.005);
    this.camera.far = r * 80;
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = !opts.reducedMotion;
    this.controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
    this.controls.minDistance = r * 0.06;
    this.controls.maxDistance = r * 10;
    this.controls.addEventListener('start', this.onControlStart);

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: true });
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);

    this.resize();
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
    this.resizeObserver?.observe(host);
    this.frame = requestAnimationFrame(this.tick);
  }

  /** Replace the hardpoint markers (keeps the current selection highlighted). */
  setMarkers(list: WireMarker[]): void {
    if (this.disposed) return;
    for (const m of this.markers) {
      this.ship.remove(m);
      m.material.dispose();
    }
    this.hovered = null;
    this.markers = list.map((mk) => {
      const mesh = new Mesh(
        this.sphere,
        new MeshBasicMaterial({ color: MARKER_COLOR, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
      ) as MarkerMesh;
      mesh.position.set(mk.xyz[0], mk.xyz[1], mk.xyz[2]);
      mesh.scale.setScalar(this.markerSize);
      mesh.renderOrder = 2;
      mesh.userData = { id: mk.id, label: mk.label };
      this.ship.add(mesh);
      return mesh;
    });
    this.applySelection();
  }

  /**
   * Highlight a marker. With `focus`, the view also pans toward it (FOCUS_BLEND)
   * and auto-rotation stops (a port was picked); without, only the highlight moves.
   * An id with no marker (a port the model has no node for) clears the highlight
   * and leaves the camera alone.
   */
  setSelected(id: string | null, focus: boolean): void {
    if (this.disposed) return;
    this.selectedId = id;
    const mesh = this.applySelection();
    if (!focus || !mesh) return;
    this.controls.autoRotate = false;
    this.interacted = true;
    const to = mesh.getWorldPosition(new Vector3()).lerp(this.home, 1 - FOCUS_BLEND);
    if (this.opts.reducedMotion) {
      this.panTo(to);
      this.goal = null;
    } else {
      this.goal = to;
    }
  }

  /**
   * CSS pixels on the right of the host covered by an overlay (the ship stats):
   * the ship is framed for, and centred in, what is left (see `viewInset`).
   */
  setInsetRight(px: number): void {
    if (this.disposed || px === this.insetRight) return;
    this.insetRight = px;
    if (this.width === 0 || this.height === 0) return;
    this.applyView();
    if (!this.interacted) this.frameHome();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    // Removed BEFORE forceContextLoss(), which fires this very event.
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.controls.removeEventListener('start', this.onControlStart);
    this.controls.dispose();
    for (const m of this.markers) m.material.dispose();
    this.markers = [];
    this.halo.material.dispose();
    this.sphere.dispose();
    this.lineGeometry.dispose();
    this.lineMaterial.dispose();
    this.renderer.dispose();
    try {
      this.renderer.forceContextLoss();
    } catch {
      /* the context may already be gone */
    }
    this.canvas.remove();
  }

  // ----- internals -----

  private applySelection(): MarkerMesh | null {
    let found: MarkerMesh | null = null;
    for (const m of this.markers) {
      const on = m.userData.id === this.selectedId;
      m.material.color.set(on ? SELECTED_COLOR : MARKER_COLOR);
      m.material.opacity = on ? 1 : 0.9;
      m.renderOrder = on ? 3 : 2;
      if (on) found = m;
    }
    this.halo.visible = found != null;
    if (found) this.halo.position.copy(found.position);
    this.scaleMarkers(0);
    return found;
  }

  /** `pulse` in [-1, 1] breathes the selected marker and its halo. */
  private scaleMarkers(pulse: number): void {
    for (const m of this.markers) {
      const on = m.userData.id === this.selectedId;
      const k = on ? SELECTED_SCALE * (1 + 0.12 * pulse) : m === this.hovered ? HOVER_SCALE : 1;
      m.scale.setScalar(this.markerSize * k);
    }
    if (this.halo.visible) {
      this.halo.scale.setScalar(this.markerSize * HALO_SCALE * (1 + 0.22 * pulse));
      this.halo.material.opacity = 0.38 - 0.14 * pulse;
    }
  }

  /** Put the camera on the opening three-quarter view, framed to the panel's shape. */
  private frameHome(): void {
    const { freeWidth } = viewInset(this.width, this.insetRight);
    const aspect = freeWidth > 0 && this.height > 0 ? freeWidth / this.height : 1;
    const [cx, cy, cz] = this.bounds.center;
    const dist = orbitFitDistance(this.positions, [cx, cy, cz], HOME_ELEVATION, FOV_DEG, aspect, FIT_MARGIN);
    this.controls.target.copy(this.home);
    this.camera.position.copy(this.home).addScaledVector(HOME_DIR, dist);
    this.controls.maxDistance = Math.max(this.bounds.radius * 10, dist * 3);
    this.camera.far = Math.max(this.bounds.radius * 80, dist * 8);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private resize(): void {
    if (this.disposed) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.applyView();
    // Until the user takes the camera, keep the ship framed for the new shape.
    if (!this.interacted) this.frameHome();
    this.renderer.render(this.scene, this.camera);
  }

  /** Projection for the current size, shifted so the scene centre sits in the uncovered part. */
  private applyView(): void {
    const { shift } = viewInset(this.width, this.insetRight);
    this.camera.aspect = this.width / this.height;
    if (shift > 0) this.camera.setViewOffset(this.width, this.height, shift, 0, this.width, this.height);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  private readonly tick = (now: number): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
    if (this.width === 0 || this.height === 0) return;
    const dt = Math.min((now - (this.last || now)) / 1000, 0.1);
    this.last = now;
    if (this.goal) {
      const next = this.scratch.copy(this.controls.target).lerp(this.goal, 1 - Math.exp(-dt * 7));
      if (next.distanceTo(this.goal) < this.bounds.radius * 1e-3) {
        next.copy(this.goal);
        this.goal = null;
      }
      this.panTo(next);
    }
    if (!this.opts.reducedMotion) this.scaleMarkers(Math.sin(now / 420));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  /** Move the orbit target, carrying the camera along (a pan: angle and zoom are kept). */
  private panTo(target: Vector3): void {
    this.camera.position.add(this.delta.subVectors(target, this.controls.target));
    this.controls.target.copy(target);
  }

  /** The marker under a host-relative point: the closest on screen, with a minimum pixel target. */
  private pick(x: number, y: number): MarkerMesh | null {
    if (this.width === 0 || this.height === 0) return null;
    const tan = Math.tan((this.camera.fov * Math.PI) / 360);
    let best: MarkerMesh | null = null;
    let bestD = Infinity;
    for (const m of this.markers) {
      const p = m.getWorldPosition(this.scratch);
      const depth = p.distanceTo(this.camera.position);
      p.project(this.camera);
      if (p.z < -1 || p.z > 1) continue; // behind the camera or beyond the far plane
      const sx = (p.x * 0.5 + 0.5) * this.width;
      const sy = (-p.y * 0.5 + 0.5) * this.height;
      const radiusPx = (m.scale.x * this.height) / (2 * tan * Math.max(depth, 1e-6));
      const d = Math.hypot(sx - x, sy - y);
      if (d <= Math.max(radiusPx * 1.15, MIN_HIT_PX) && d < bestD) {
        best = m;
        bestD = d;
      }
    }
    return best;
  }

  private local(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private setHover(m: MarkerMesh | null, x: number, y: number): void {
    if (m !== this.hovered) {
      this.hovered = m;
      this.canvas.style.cursor = m ? 'pointer' : '';
      if (this.opts.reducedMotion) this.scaleMarkers(0);
    }
    this.opts.onHover(m ? m.userData.label : null, x, y);
  }

  private stopAuto(): void {
    this.interacted = true;
    this.controls.autoRotate = false;
  }

  private readonly onControlStart = (): void => {
    // The user took the camera: stop spinning and stop easing toward a port.
    this.stopAuto();
    this.goal = null;
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.stopAuto();
    this.down = this.local(e);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const { x, y } = this.local(e);
    // While dragging, the camera is moving: no tooltip.
    if (e.buttons !== 0) this.setHover(null, x, y);
    else this.setHover(this.pick(x, y), x, y);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const start = this.down;
    this.down = null;
    if (!start || e.button !== 0) return;
    const { x, y } = this.local(e);
    if (Math.hypot(x - start.x, y - start.y) > CLICK_SLOP_PX) return;
    const m = this.pick(x, y);
    if (!m) return;
    // Clicking the port that is already selected changes no prop: focus it here.
    if (m.userData.id === this.selectedId) this.setSelected(this.selectedId, true);
    this.opts.onSelect(m.userData.id);
  };

  private readonly onPointerLeave = (): void => {
    this.down = null;
    this.setHover(null, 0, 0);
  };

  private readonly onWheel = (): void => {
    this.stopAuto();
  };

  /** Double-click empty space: back to the opening view. */
  private readonly onDoubleClick = (e: MouseEvent): void => {
    const { x, y } = this.local(e);
    if (this.pick(x, y)) return;
    this.goal = null;
    this.frameHome();
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    if (this.disposed) return;
    this.opts.onContextLost();
  };
}
