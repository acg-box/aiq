'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AmbientLight,
  BufferGeometry,
  DirectionalLight,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { formatHumanDuration } from '../data/format-duration.ts';
import type { ExactEfficiencyRow } from './scientific-evidence-resolution.ts';
import {
  createConfigurationThreeScale,
  projectConfigurationThreePoint,
  resolveConfigurationThreePoints,
} from './configuration-workbench-three.ts';

type RenderStatus = 'loading' | 'ready' | 'unavailable';
type PointObject = {
  mesh: Mesh;
  outline: Mesh | null;
  frontier: boolean;
};

function cssColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function canCreateWebGlContext(): boolean {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!context) return false;
  context.getExtension('WEBGL_lose_context')?.loseContext();
  return true;
}

export function ConfigurationThreeChart({
  allRows,
  rows,
  focusId,
  onFocus,
}: {
  allRows: readonly ExactEfficiencyRow[];
  rows: readonly ExactEfficiencyRow[];
  focusId: string | null;
  onFocus: (id: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const pointObjects = useRef(new Map<string, PointObject>());
  const renderScene = useRef<(() => void) | null>(null);
  const resetScene = useRef<(() => void) | null>(null);
  const rotateScene = useRef<((horizontal: number, vertical: number) => void) | null>(null);
  const zoomScene = useRef<((direction: 'in' | 'out') => void) | null>(null);
  const onFocusRef = useRef(onFocus);
  const [status, setStatus] = useState<RenderStatus>('loading');
  const allPoints = useMemo(() => resolveConfigurationThreePoints(allRows), [allRows]);
  const visiblePoints = useMemo(
    () => resolveConfigurationThreePoints(rows, allRows),
    [allRows, rows],
  );
  const scale = useMemo(() => createConfigurationThreeScale(allPoints), [allPoints]);
  const focusedPoint = visiblePoints.find(({ id }) => id === focusId) ?? null;

  useEffect(() => {
    onFocusRef.current = onFocus;
  }, [onFocus]);

  useEffect(() => {
    for (const [id, object] of pointObjects.current) {
      const selected = id === focusId;
      object.mesh.scale.setScalar(selected ? 1.55 : 1);
      if (object.outline) object.outline.visible = selected || object.frontier;
    }
    renderScene.current?.();
  }, [focusId]);

  useEffect(() => {
    const container = host.current;
    if (!container || !scale || visiblePoints.length === 0) return undefined;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    setStatus('loading');

    const setup = () => {
      try {
        if (!canCreateWebGlContext()) {
          if (!disposed) setStatus('unavailable');
          return;
        }
        if (disposed) return;

        const scene = new Scene();
        const camera = new OrthographicCamera(-1.8, 1.8, 1.35, -1.35, 0.1, 50);
        camera.position.set(2.8, 2.15, 3.2);
        const renderer = new WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: 'low-power',
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        renderer.setClearColor(0x000000, 0);
        renderer.domElement.setAttribute('aria-hidden', 'true');
        renderer.domElement.dataset.threeCanvas = 'aiq-ability-time-cost';
        container.replaceChildren(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = false;
        controls.enablePan = false;
        controls.minZoom = 0.7;
        controls.maxZoom = 2.4;
        controls.target.set(0, -0.05, 0);
        controls.update();

        scene.add(new AmbientLight(0xffffff, 1.7));
        const directional = new DirectionalLight(0xffffff, 2.2);
        directional.position.set(3, 5, 4);
        scene.add(directional);

        const lineMaterial = new LineBasicMaterial({
          color: cssColor('--line-bright', '#7a8490'),
          transparent: true,
          opacity: 0.72,
        });
        const gridMaterial = new LineBasicMaterial({
          color: cssColor('--line', '#d9dde2'),
          transparent: true,
          opacity: 0.4,
        });
        const axisGeometry = new BufferGeometry().setFromPoints([
          new Vector3(-1, -1, -1),
          new Vector3(1.08, -1, -1),
          new Vector3(-1, -1, -1),
          new Vector3(-1, 1.08, -1),
          new Vector3(-1, -1, -1),
          new Vector3(-1, -1, 1.08),
        ]);
        scene.add(new LineSegments(axisGeometry, lineMaterial));

        const gridPoints: Vector3[] = [];
        for (const value of [-0.5, 0, 0.5, 1]) {
          gridPoints.push(
            new Vector3(value, -1, -1),
            new Vector3(value, -1, 1),
            new Vector3(-1, -1, value),
            new Vector3(1, -1, value),
          );
        }
        const gridGeometry = new BufferGeometry().setFromPoints(gridPoints);
        scene.add(new LineSegments(gridGeometry, gridMaterial));

        const sphereGeometry = new SphereGeometry(0.075, 24, 16);
        const outlineGeometry = new SphereGeometry(0.105, 16, 12);
        const familyColors = {
          Sol: cssColor('--data-lime', '#347761'),
          Terra: cssColor('--data-cyan', '#267687'),
          Luna: cssColor('--data-violet', '#665b91'),
        } as const;
        const localPointObjects = new Map<string, PointObject>();
        const selectableMeshes: Mesh[] = [];
        for (const point of visiblePoints) {
          const projected = projectConfigurationThreePoint(point, scale);
          const material = new MeshStandardMaterial({
            color: familyColors[point.family],
            roughness: 0.38,
            metalness: 0.08,
          });
          const mesh = new Mesh(sphereGeometry, material);
          mesh.position.set(projected.x, projected.y, projected.z);
          if (point.id === focusId) mesh.scale.setScalar(1.55);
          mesh.userData.id = point.id;
          scene.add(mesh);
          selectableMeshes.push(mesh);

          const outlineMaterial = new MeshBasicMaterial({
            color: cssColor('--frontier', '#202833'),
            wireframe: true,
            transparent: true,
            opacity: point.frontier ? 0.82 : 0.62,
          });
          const outline = new Mesh(outlineGeometry, outlineMaterial);
          outline.position.copy(mesh.position);
          outline.userData.frontier = point.frontier;
          outline.visible = point.frontier || point.id === focusId;
          scene.add(outline);
          localPointObjects.set(point.id, { mesh, outline, frontier: point.frontier });
        }
        pointObjects.current = localPointObjects;

        const render = () => renderer.render(scene, camera);
        renderScene.current = render;
        const reset = () => {
          camera.position.set(2.8, 2.15, 3.2);
          camera.zoom = 1;
          camera.updateProjectionMatrix();
          controls.target.set(0, -0.05, 0);
          controls.update();
          render();
        };
        resetScene.current = reset;
        rotateScene.current = (horizontal, vertical) => {
          controls.rotateLeft(horizontal);
          controls.rotateUp(vertical);
          controls.update();
          render();
        };
        zoomScene.current = (direction) => {
          if (direction === 'in') controls.dollyIn(1.18);
          else controls.dollyOut(1.18);
          controls.update();
          render();
        };

        const resize = () => {
          const width = Math.max(container.clientWidth, 280);
          const height = Math.max(container.clientHeight, 320);
          const aspect = width / height;
          camera.left = -1.55 * aspect;
          camera.right = 1.55 * aspect;
          camera.top = 1.55;
          camera.bottom = -1.55;
          camera.updateProjectionMatrix();
          renderer.setSize(width, height, false);
          render();
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(container);
        controls.addEventListener('change', render);

        const raycaster = new Raycaster();
        const pointer = new Vector2();
        let pointerStart: readonly [number, number] | null = null;
        const handlePointerDown = (event: PointerEvent) => {
          pointerStart = [event.clientX, event.clientY];
        };
        const handlePointerUp = (event: PointerEvent) => {
          if (
            !pointerStart ||
            Math.hypot(event.clientX - pointerStart[0], event.clientY - pointerStart[1]) > 5
          ) {
            pointerStart = null;
            return;
          }
          pointerStart = null;
          const bounds = renderer.domElement.getBoundingClientRect();
          pointer.set(
            ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
            -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
          );
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects(selectableMeshes, false)[0];
          const id = typeof hit?.object.userData.id === 'string' ? hit.object.userData.id : null;
          if (id) onFocusRef.current(id);
        };
        renderer.domElement.addEventListener('pointerdown', handlePointerDown);
        renderer.domElement.addEventListener('pointerup', handlePointerUp);

        const handleThemeChange = () => {
          lineMaterial.color.set(cssColor('--line-bright', '#7a8490'));
          gridMaterial.color.set(cssColor('--line', '#d9dde2'));
          for (const point of visiblePoints) {
            const object = localPointObjects.get(point.id);
            const material = object?.mesh.material;
            if (material instanceof MeshStandardMaterial) {
              material.color.set(
                point.family === 'Sol'
                  ? cssColor('--data-lime', '#347761')
                  : point.family === 'Terra'
                    ? cssColor('--data-cyan', '#267687')
                    : cssColor('--data-violet', '#665b91'),
              );
            }
            const outlineMaterial = object?.outline?.material;
            if (outlineMaterial instanceof MeshBasicMaterial) {
              outlineMaterial.color.set(cssColor('--frontier', '#202833'));
            }
          }
          render();
        };
        window.addEventListener('aiq-themechange', handleThemeChange);

        const handleContextLost = (event: Event) => {
          event.preventDefault();
          setStatus('unavailable');
        };
        renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
        resize();
        setStatus('ready');

        cleanup = () => {
          resizeObserver.disconnect();
          controls.removeEventListener('change', render);
          controls.dispose();
          window.removeEventListener('aiq-themechange', handleThemeChange);
          renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
          renderer.domElement.removeEventListener('pointerup', handlePointerUp);
          renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
          for (const object of localPointObjects.values()) {
            if (object.mesh.material instanceof Material) object.mesh.material.dispose();
            if (object.outline?.material instanceof Material) object.outline.material.dispose();
          }
          sphereGeometry.dispose();
          outlineGeometry.dispose();
          axisGeometry.dispose();
          gridGeometry.dispose();
          lineMaterial.dispose();
          gridMaterial.dispose();
          renderer.dispose();
          container.replaceChildren();
          pointObjects.current.clear();
          renderScene.current = null;
          resetScene.current = null;
          rotateScene.current = null;
          zoomScene.current = null;
        };
      } catch {
        if (!disposed) setStatus('unavailable');
      }
    };

    setup();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [scale, visiblePoints]);

  if (!scale || visiblePoints.length === 0) {
    return (
      <p className="workbench-empty-chart">
        The 3D view needs complete AIQ, time, and API-equivalent cost evidence. The filtered rows
        remain available in the 2D time view and table.
      </p>
    );
  }

  return (
    <figure
      className="configuration-three"
      aria-labelledby="configuration-three-title"
      data-three-render-state={status}
    >
      <figcaption className="configuration-three-heading">
        <div>
          <strong id="configuration-three-title">AIQ × time × cost</strong>
          <span>Drag to rotate · pinch or wheel to zoom · select a configuration to focus</span>
        </div>
      </figcaption>
      <div className="configuration-three-actions" aria-label="Keyboard 3D view controls">
        <button
          type="button"
          onClick={() => rotateScene.current?.(Math.PI / 12, 0)}
          disabled={status !== 'ready'}
        >
          Rotate left
        </button>
        <button
          type="button"
          onClick={() => rotateScene.current?.(-Math.PI / 12, 0)}
          disabled={status !== 'ready'}
        >
          Rotate right
        </button>
        <button
          type="button"
          onClick={() => rotateScene.current?.(0, Math.PI / 18)}
          disabled={status !== 'ready'}
        >
          Rotate up
        </button>
        <button
          type="button"
          onClick={() => zoomScene.current?.('in')}
          disabled={status !== 'ready'}
        >
          Zoom in
        </button>
        <button
          type="button"
          onClick={() => zoomScene.current?.('out')}
          disabled={status !== 'ready'}
        >
          Zoom out
        </button>
        <button type="button" onClick={() => resetScene.current?.()} disabled={status !== 'ready'}>
          Reset view
        </button>
      </div>
      <div className="configuration-three-stage">
        <div ref={host} className="configuration-three-canvas" aria-hidden="true" />
        {status === 'loading' ? (
          <p className="configuration-three-status" role="status">
            Loading the optional 3D view…
          </p>
        ) : null}
        {status === 'unavailable' ? (
          <p className="configuration-three-status" role="status">
            3D is unavailable in this browser. Use either 2D view or the complete table below.
          </p>
        ) : null}
      </div>
      <dl className="configuration-three-axes" aria-label="Three-dimensional axis ranges">
        <div>
          <dt>Time · X</dt>
          <dd>
            {formatHumanDuration(scale.durationMinimumMs)} →{' '}
            {formatHumanDuration(scale.durationMaximumMs)} · lower is better
          </dd>
        </div>
        <div>
          <dt>AIQ · Y</dt>
          <dd>0 → 100 · higher is better</dd>
        </div>
        <div>
          <dt>Cost · Z</dt>
          <dd>
            ${scale.costMinimumUsd.toFixed(4)} → ${scale.costMaximumUsd.toFixed(2)} · lower is
            better
          </dd>
        </div>
      </dl>
      <div className="configuration-three-focus" aria-label="Focus a plotted configuration">
        {visiblePoints.map((point) => (
          <button
            key={point.id}
            type="button"
            aria-pressed={focusId === point.id}
            onClick={() => onFocus(point.id === focusId ? null : point.id)}
          >
            <span
              className={`family-dot family-${point.family.toLowerCase()}`}
              aria-hidden="true"
            />
            {point.label}
          </button>
        ))}
      </div>
      <p className="workbench-chart-note" aria-live="polite">
        {focusedPoint
          ? `${focusedPoint.label} · AIQ ${focusedPoint.score.toFixed(1)} · ${formatHumanDuration(focusedPoint.durationMs)} · $${focusedPoint.costUsd.toFixed(4)}${focusedPoint.frontier ? ' · Pareto frontier' : ''}`
          : `${visiblePoints.length}/${rows.length} filtered configurations have complete time and cost evidence. AIQ remains independent.`}
      </p>
    </figure>
  );
}
