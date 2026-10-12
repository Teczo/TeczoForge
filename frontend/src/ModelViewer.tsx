import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Box3, PMREMGenerator, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import type { Mesh, Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CubeIcon, DownloadIcon } from "./Icons";

// The 3D viewer (FRG-27). Shows a .glb model: drag to rotate, scroll or pinch to zoom,
// right-drag to move. "Reset view" goes back to the first view.
// This file is the only one that uses "three". Media.tsx loads it only when a model is shown,
// so other pages do not download three.

type ModelViewerProps = { url: string; alt: string; style?: CSSProperties };

export default function ModelViewer({ url, alt, style }: ModelViewerProps) {
  const box = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let stopped = false;

    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    element.appendChild(renderer.domElement);

    // A soft room light, so the model's textures and metal parts look right.
    const scene = new Scene();
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;

    const camera = new PerspectiveCamera(40, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;

    // Keep the picture the size of the box, also in full screen.
    const resize = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });

    let model: Object3D | null = null;
    new GLTFLoader()
      .loadAsync(url)
      .then((gltf) => {
        if (stopped) {
          disposeModel(gltf.scene);
          return;
        }
        model = gltf.scene;
        scene.add(model);

        // Put the model in the middle and move the camera back until all of it fits.
        const bounds = new Box3().setFromObject(model);
        const center = bounds.getCenter(new Vector3());
        const size = bounds.isEmpty() ? 1 : bounds.getSize(new Vector3()).length() || 1;
        model.position.sub(center);
        camera.near = size / 100;
        camera.far = size * 100;
        camera.updateProjectionMatrix();
        camera.position.set(size * 0.6, size * 0.35, size * 0.9);
        controls.target.set(0, 0, 0);
        controls.minDistance = size * 0.1;
        controls.maxDistance = size * 10;
        controls.update();
        controls.saveState(); // "Reset view" goes back here.
        setState("ready");
      })
      .catch((error) => {
        console.error("Could not show the 3D model:", error);
        if (!stopped) setState("error");
      });

    return () => {
      stopped = true;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      controlsRef.current = null;
      if (model) disposeModel(model);
      environment.dispose();
      room.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url]);

  const fileName = url.split("/").pop() ?? url;
  return (
    <div className="model-viewer" style={style} title={alt}>
      <div className="model-viewer-canvas" ref={box} />
      {state !== "ready" && (
        <div className="model-viewer-note">
          <CubeIcon size={48} />
          <span>{state === "loading" ? "Loading 3D model..." : "This 3D model could not be shown. Download it to open it in another program."}</span>
          <span className="file-tile-name">{fileName}</span>
        </div>
      )}
      <div className="model-viewer-bar">
        {state === "ready" && <span className="model-viewer-hint">Drag to rotate. Scroll to zoom.</span>}
        {state === "ready" && (
          <button type="button" className="button" onClick={() => controlsRef.current?.reset()}>
            Reset view
          </button>
        )}
        <a className="button" href={url} download>
          <DownloadIcon size={18} /> Download
        </a>
      </div>
    </div>
  );
}

// Free the model's memory on the graphics card.
function disposeModel(model: Object3D) {
  model.traverse((object) => {
    if (!(object as Mesh).isMesh) return;
    const mesh = object as Mesh;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      // Textures are the material's values that have a dispose function (map, normalMap, ...).
      for (const value of Object.values(material)) {
        if (isDisposable(value)) value.dispose();
      }
      material.dispose();
    }
  });
}

function isDisposable(value: unknown): value is { isTexture: true; dispose(): void } {
  return typeof value === "object" && value !== null && (value as { isTexture?: boolean }).isTexture === true;
}
