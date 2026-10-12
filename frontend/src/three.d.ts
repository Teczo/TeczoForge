// Types for the small part of "three" that the 3D viewer uses (FRG-27).
// "three" has no types of its own, and the full types are a separate package that is not on
// the allowed list. So only what ModelViewer.tsx needs is described here. If the viewer starts
// to use more of three, add it below.

declare module "three" {
  export class Vector3 {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    set(x: number, y: number, z: number): this;
    copy(v: Vector3): this;
    add(v: Vector3): this;
    sub(v: Vector3): this;
    length(): number;
  }

  export class Box3 {
    setFromObject(object: Object3D): this;
    isEmpty(): boolean;
    getSize(target: Vector3): Vector3;
    getCenter(target: Vector3): Vector3;
  }

  export class Texture {
    dispose(): void;
  }

  export class Material {
    dispose(): void;
    [key: string]: unknown;
  }

  export class BufferGeometry {
    dispose(): void;
  }

  export class Object3D {
    position: Vector3;
    children: Object3D[];
    add(...objects: Object3D[]): this;
    traverse(callback: (object: Object3D) => void): void;
  }

  export class Mesh extends Object3D {
    isMesh: true;
    geometry: BufferGeometry;
    material: Material | Material[];
  }

  export class Scene extends Object3D {
    background: unknown;
    environment: Texture | null;
  }

  export class PerspectiveCamera extends Object3D {
    aspect: number;
    near: number;
    far: number;
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    updateProjectionMatrix(): void;
  }

  export class WebGLRenderer {
    domElement: HTMLCanvasElement;
    constructor(parameters?: { antialias?: boolean; alpha?: boolean });
    setPixelRatio(value: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setAnimationLoop(callback: (() => void) | null): void;
    render(scene: Object3D, camera: PerspectiveCamera): void;
    dispose(): void;
  }

  export class PMREMGenerator {
    constructor(renderer: WebGLRenderer);
    fromScene(scene: Scene, sigma?: number): { texture: Texture; dispose(): void };
    dispose(): void;
  }
}

declare module "three/addons/loaders/GLTFLoader.js" {
  import type { Object3D } from "three";
  export class GLTFLoader {
    loadAsync(url: string): Promise<{ scene: Object3D }>;
  }
}

declare module "three/addons/controls/OrbitControls.js" {
  import type { PerspectiveCamera, Vector3 } from "three";
  export class OrbitControls {
    target: Vector3;
    enableDamping: boolean;
    minDistance: number;
    maxDistance: number;
    constructor(camera: PerspectiveCamera, domElement: HTMLElement);
    update(): boolean;
    saveState(): void;
    reset(): void;
    dispose(): void;
  }
}

declare module "three/addons/environments/RoomEnvironment.js" {
  import type { Scene } from "three";
  export class RoomEnvironment extends Scene {
    dispose(): void;
  }
}
