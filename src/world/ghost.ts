import { Material, Mesh, Object3D, Sprite } from 'three';

/**
 * Ghosting: hide a whole storey out of the way without touching the materials
 * it shares with every other storey.
 *
 * Each mesh gets one cloned material per traversal (textures are shared by
 * reference), so a ghosted floor costs no new GPU uploads and restores to the
 * exact material instances it started with. Used when one floor is focused: the
 * storeys above disappear instead of hiding the floor you are looking at.
 */

interface GhostMark {
  originals: Material | Material[];
  clones: Material[];
  castShadow: boolean;
  receiveShadow: boolean;
  wasVisible: boolean;
}

const marks = new WeakMap<Object3D, GhostMark>();

function cloneMaterial(source: Material, cache: Map<Material, Material>): Material {
  let clone = cache.get(source);
  if (!clone) {
    clone = source.clone();
    clone.userData.ghostBaseOpacity = source.opacity;
    cache.set(source, clone);
  }
  return clone;
}

function hide(material: Material): void {
  material.transparent = true;
  material.opacity = 0;
  material.depthWrite = false;
  material.visible = false;
}

function mark(node: Mesh | Sprite, cache: Map<Material, Material>): GhostMark {
  const existing = marks.get(node);
  if (existing) return existing;

  const material = node.material as Material | Material[];
  const source = Array.isArray(material) ? material : [material];
  const clones = source.map((m) => cloneMaterial(m, cache));
  const ghost: GhostMark = {
    originals: material,
    clones,
    castShadow: node instanceof Mesh ? node.castShadow : false,
    receiveShadow: node instanceof Mesh ? node.receiveShadow : false,
    wasVisible: node.visible,
  };
  marks.set(node, ghost);
  if (node instanceof Mesh) {
    node.material = Array.isArray(material) ? clones : clones[0];
    node.castShadow = false;
    node.receiveShadow = true;
  } else {
    node.material = clones[0] as typeof node.material;
  }
  return ghost;
}

/** Hide (or restore, at true) an object tree. Cheap to call again with the same value. */
export function setGroupGhost(root: Object3D, hideFlag: boolean): void {
  if (!hideFlag) {
    restoreGroup(root);
    root.userData.ghosted = false;
    return;
  }

  const cache = new Map<Material, Material>();
  root.traverse((object) => {
    if (object instanceof Mesh || object instanceof Sprite) {
      const ghost = mark(object, cache);
      for (const clone of ghost.clones) hide(clone);
      object.visible = false;
    }
  });
  root.userData.ghosted = true;
}

/** Put the original materials back and release the clones. */
export function restoreGroup(root: Object3D): void {
  root.traverse((object) => {
    const ghost = marks.get(object);
    if (!ghost) return;

    if (object instanceof Mesh) object.material = ghost.originals;
    else if (object instanceof Sprite) object.material = ghost.originals as Sprite['material'];
    if (object instanceof Mesh) {
      object.castShadow = ghost.castShadow;
      object.receiveShadow = ghost.receiveShadow;
    }
    object.visible = ghost.wasVisible;
    for (const clone of ghost.clones) clone.dispose();
    marks.delete(object);
  });
}
