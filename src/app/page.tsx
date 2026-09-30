"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { FolderOpen } from "lucide-react";
import Toolbar from "@/components/Toolbar";
import Canvas, { type CanvasView } from "@/components/Canvas";
import Timeline from "@/components/Timeline";
import RightSidebar from "@/components/RightSidebar";
import ProjectSidebar from "@/components/ProjectSidebar";

import LayerPanel from "@/components/LayerPanel";
import TransformPanel from "@/components/TransformPanel";
import SquashPanel from "@/components/SquashPanel";
import TransparencyToggle from "@/components/TransparencyToggle";
import ExportDialog, {
  type ExportSize,
  type ExportLimit,
  type ExportPreset,
} from "@/components/ExportDialog";
import { exportGIF } from "@/lib/exportGif";
import { geometryPresets } from "@/lib/geometryPresets";
import { templateRegistry } from "@/lib/templateRegistry";
import { createTemplateProject } from "@/lib/createTemplateProject";

import { createEmptyProject, type Project } from "@/types/project";
import { updateProjectTimestamp } from "@/lib/projects";

import type { Frame } from "@/types/frame";
import { hasStabilization } from "@/types/frame";

import { normalizeFrames } from "@/lib/frameTransform";

import { assignStabilization, clearStabilization } from "@/lib/lsa";

import { useAutoStabilize } from "@/hooks/useAutoStabilize";

import { isStabilizationStale } from "@/types/project";
import { useTransparency } from "@/hooks/useTransparency";

import {
  loadProjects,
  saveProjects,
  loadFrameImage,
  saveFrameImage,
  deleteFrameImage,
  deleteProjectImages,
  loadActiveProjectId,
  saveActiveProjectId,
  saveLayerImage,
  loadProjectLayerImages,
  pruneLayerImages,
  deleteProjectLayerImages,
} from "@/lib/indexedDB";
import { loadHistory, saveHistory, clearHistory } from "@/lib/history";
import type { Snapshot } from "@/types/history";
import { layerReducer, type LayerAction } from "@/lib/layers/editor";
import { BLANK_LAYER_SIZE } from "@/lib/layers/constants";
import { applyMaskToPixels } from "@/lib/layers/maskOps";
import { removeFrameBackground } from "@/lib/sprite/removeBackground";
import {
  createBlankFrame,
  duplicateFrame,
  deleteFrame,
  reorderFrames,
} from "@/lib/frameOps";

import SpriteSheetCutter from "@/components/SpriteSheetCutter";

import { defaultFitPose } from "@/lib/layers/layerSpace";
import { clearTransforms } from "@/lib/frameTransform";
/* ---------- layer system ---------- */

import type { AdjustmentType, CanvasBackground } from "@/types/layer";
import { ADJUSTMENT_LABELS, DEFAULT_BACKGROUND, defaultAdjustment } from "@/types/layer";
import { useLayerEditor } from "@/hooks/useLayerEditor";
import {
  attachLayerSize,
  normalizeFrameLayers,
  syncBaseFromLegacy,
} from "@/lib/layers/migrate";
import {
  IMAGE_REF,
  collectLayerImages,
  decodeProject,
  encodeProjects,
  liveLayerKeys,
} from "@/lib/layers/serialize";
import {
  loadBitmap,
  preloadFrameBitmaps,
  reflattenIfStale,
} from "@/lib/layers/flatten";
import { createLayerId, findLayer } from "@/lib/layers/layerOps";
import { CANVAS_SIZE } from "@/lib/frameTransform";

/**
 * Where an import should land.
 *
 * The legacy flow only ever replaced `frame.image`, so a single numeric target
 * was enough. With layers the destination is two-dimensional — which frame AND
 * which layer, or a brand-new layer — so the intent is captured explicitly at
 * the moment the picker opens. Deriving it later from `editingIndex` would
 * break as soon as the user changed frames while the file dialog was open,
 * which is exactly the race the old `pendingImportTarget` comment warns about.
 */
type ImportIntent =
  | { kind: "replace-active"; frame: number }
  | { kind: "new-layer"; frame: number }
  | { kind: "slice" };

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [activeFrame, setActiveFrame] = useState(0);
  const [editingIndex, setEditingIndex] = useState(0);

  const stabilizer = useAutoStabilize<Frame>();

  const [isPlaying, setIsPlaying] = useState(false);
  const [selectionActive, setSelectionActive] = useState(false);
  /** Paint tools target the selected layer's mask (its thumbnail is picked). */
  const [editMask, setEditMask] = useState(false);
  const [previewFrame, setPreviewFrame] = useState(0);
  const [onionSkin, setOnionSkin] = useState(true);
  const [showProjects, setShowProjects] = useState(false);

 
  const [showLayerPanel, setShowLayerPanel] = useState(true);

  const [sliceFile, setSliceFile] = useState<File | null>(null);
  const [showCutter, setShowCutter] = useState(false);

  // Guide State
  const [showGuides, setShowGuides] = useState(true);
  const [guideMode, setGuideMode] = useState<"face" | "fullbody">("face");
  const { state: transparency, patch } = useTransparency();

  // Export State
  const [showExport, setShowExport] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving">("saved");
  const [exportPreset, setExportPreset] = useState<ExportPreset>("sticker");
  const [exportSize, setExportSize] = useState<ExportSize>(320);
  const [exportLimit, setExportLimit] = useState<ExportLimit>(512);

  const [canvasView, setCanvasView] = useState<CanvasView>({
    x: 0,
    y: 0,
    rotation: 0,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingImport = useRef<ImportIntent | null>(null);
  const saveProjectsTimer = useRef<number | null>(null);

  /**
   * The canvas container element, owned HERE rather than inside Canvas.
   *
   * `useLayerEditor` needs live DOMRect bounds to convert screen coordinates
   * into canvas space, and the hook has to live in page.tsx because page.tsx
   * owns the undo pipeline. Hoisting the ref is the smallest change that lets
   * both hold true; Canvas simply attaches it.
   */
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const getCanvasBounds = useCallback(
    () => canvasContainerRef.current?.getBoundingClientRect() ?? null,
    []
  );

  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const projectsRef = useRef<Project[]>([]);
  const deletedFrameImages = useRef(new Map<string, string>());
  const lastSavedImages = useRef(new Map<string, string | null>());
  const lastSavedLayerImages = useRef(new Map<string, string>());
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  // ---------- Load Projects ----------
  useEffect(() => {
    let cancelled = false;

    /**
     * Hydrate one persisted project into live, layered state.
     *
     * Three cases, in priority order:
     *   1. v3 documents: layer bitmaps live in the `layers` store, keyed by
     *      `${projectId}-${frameId}-${layerId}`; decodeProject re-attaches them.
     *   2. v1/v2 documents: pixels are either inline on `frame.image` or in the
     *      old `frames` store. `migrateFrame` has already produced a base layer
     *      with `image: null`, so the bitmap is grafted on here and
     *      `legacyPosePending` is set — which is what makes `attachLayerSize`
     *      reconstruct the pose from x/y/zoom/rotation and keep the artwork
     *      exactly where the animator left it.
     *   3. Sizes: every layer's `size` is resolved by decoding its bitmap now,
     *      so geometry, hit-testing and bounds are correct on the first frame
     *      rendered rather than one repaint later.
     */
    async function hydrateProject(raw: Project): Promise<Project> {
      const layerImages = await loadProjectLayerImages(raw.id).catch(
        () => new Map<string, string>()
      );

      const decoded = decodeProject(raw, layerImages);

      const frames = await Promise.all(
        decoded.frames.map(async (frame) => {
          let next = frame;

          const base = next.layers.find((l) => l.kind === "base") ?? null;

          // ---- case 2: legacy pixels ----
          if (base && !base.image) {
            const inline =
              frame.image && frame.image !== IMAGE_REF ? frame.image : null;
            const legacy =
              inline ??
              (await loadFrameImage(raw.id, frame.id).catch(() => null));

            if (legacy) {
              next = normalizeFrameLayers({
                ...next,
                image: legacy,
                layers: next.layers.map((l) =>
                  l.id === base.id ? { ...l, image: legacy } : l
                ),
                legacyPosePending: true,
                flattenKey: null,
              });
            }
          }

          // ---- case 3: resolve every layer's native size ----
          for (const layer of next.layers) {
            if (!layer.image) continue;
            if (layer.size.w > 0 && layer.size.h > 0 && !next.legacyPosePending) {
              continue;
            }
            const img = await loadBitmap(layer.image).catch(() => null);
            if (!img) continue;
            next = attachLayerSize(
              next,
              layer.id,
              img.naturalWidth,
              img.naturalHeight
            );
          }

          return syncBaseFromLegacy(next);
        })
      );

      return {
        ...decoded,
        frames,
        background: decoded.background ?? DEFAULT_BACKGROUND,
        thumbnail: frames.find((f) => f.image)?.image ?? null,
      };
    }

    async function restore() {
      try {
        const stored = (await loadProjects<Project[]>()) ?? [];

        if (!stored.length) {
          if (!cancelled) {
            const first = createEmptyProject("Animation 1");
            setProjects([first]);
            setActiveProjectId(first.id);
          }
          return;
        }

        const results = await Promise.allSettled(
          stored.map((project) => hydrateProject(project))
        );

        const restored = results.flatMap((r) =>
          r.status === "fulfilled" ? [r.value] : []
        );

        if (cancelled) return;

        if (!restored.length) {
          const first = createEmptyProject("Animation 1");
          setProjects([first]);
          setActiveProjectId(first.id);
          return;
        }

        setProjects(restored);

        const savedId = loadActiveProjectId();
        const projectExists = restored.some((p) => p.id === savedId);

        setActiveProjectId(projectExists ? savedId! : restored[0].id);

        const rawFrame = Number(localStorage.getItem("loop-active-frame"));
        const savedFrame = Number.isFinite(rawFrame) ? rawFrame : 0;

        const project =
          restored.find(
            (p) => p.id === (projectExists ? savedId : restored[0].id)
          ) ?? restored[0];

        const clamped = Math.min(
          Math.max(0, savedFrame),
          project.frames.length - 1
        );

        setActiveFrame(clamped);
        setEditingIndex(clamped);
        setPreviewFrame(clamped);
      } catch (err) {
        console.error("Restore failed; starting fresh", err);

        if (!cancelled) {
          const first = createEmptyProject("Animation 1");
          setProjects([first]);
          setActiveProjectId(first.id);
        }
      }
    }

    restore();

    return () => {
      cancelled = true;
    };
  }, []);

  // ---------- Keep projects ref updated ----------
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  // ---------- Restore history on startup ----------
  useEffect(() => {
    const history = loadHistory();
    undoStack.current = history.undo;
    redoStack.current = history.redo;
  }, []);

  useEffect(() => {
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
  }, [projects]);

  // ---------- Save history automatically ----------
  useEffect(() => {
    saveHistory(undoStack.current, redoStack.current);
  }, [projects]);

  // ---------- Save Projects ----------
  useEffect(() => {
    if (!projects.length) return;

    if (saveProjectsTimer.current) {
      clearTimeout(saveProjectsTimer.current);
    }

    saveProjectsTimer.current = window.setTimeout(() => {
      // Bitmaps NEVER travel inside the project record — a 24-frame, 4-layer
      // project would serialize tens of megabytes of base64 on every debounced
      // save. encodeProjects swaps each one for IMAGE_REF.
      saveProjects(encodeProjects(projects)).catch(console.error);

      const active = projects.find((p) => p.id === activeProjectId);
      if (active) {
        pruneLayerImages(active.id, liveLayerKeys(active)).catch(console.error);
      }
    }, 400);

    return () => {
      if (saveProjectsTimer.current) {
        clearTimeout(saveProjectsTimer.current);
      }
    };
  }, [projects, activeProjectId]);

  // ---------- Save Frame Images (flatten cache, legacy store) ----------
  useEffect(() => {
    const project = projects.find((p) => p.id === activeProjectId);
    if (!project) return;

    project.frames.forEach((frame) => {
      const last = lastSavedImages.current.get(frame.id);

      if (last === frame.image) return;

      if (frame.image) {
        setSaveStatus("saving");

        saveFrameImage(project.id, frame.id, frame.image)
          .then(() => {
            setSaveStatus("saved");
          })
          .catch((err) => {
            console.error(err);
            setSaveStatus("saved");
          });
      }

      lastSavedImages.current.set(frame.id, frame.image);
    });

    const validIds = new Set(project.frames.map((f) => f.id));

    lastSavedImages.current.forEach((_, id) => {
      if (!validIds.has(id)) {
        deleteFrameImage(project.id, id).catch(console.error);
        lastSavedImages.current.delete(id);
      }
    });
  }, [projects, activeProjectId]);

  // ---------- Save Layer Images ----------
  useEffect(() => {
    const project = projects.find((p) => p.id === activeProjectId);
    if (!project) return;

    const images = collectLayerImages(project);
    let pending = 0;

    images.forEach((image, key) => {
      if (lastSavedLayerImages.current.get(key) === image) return;

      pending++;
      setSaveStatus("saving");

      saveLayerImage(key, image)
        .then(() => {
          lastSavedLayerImages.current.set(key, image);
        })
        .catch(console.error)
        .finally(() => {
          pending--;
          if (pending === 0) setSaveStatus("saved");
        });
    });

    // Forget keys no live layer claims. The IndexedDB sweep itself is
    // debounced alongside the project save, because it walks a cursor.
    const live = liveLayerKeys(project);
    lastSavedLayerImages.current.forEach((_, key) => {
      if (!live.has(key)) lastSavedLayerImages.current.delete(key);
    });
  }, [projects, activeProjectId]);

  // ---------- Save Active Project & Frame ----------
  useEffect(() => {
    if (!activeProjectId) return;

    saveActiveProjectId(activeProjectId);
    localStorage.setItem("loop-active-frame", String(activeFrame));
  }, [activeProjectId, activeFrame]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );

  const fallbackFrames = useMemo(() => [createBlankFrame()], []);

const frames = activeProject?.frames.length
  ? activeProject.frames
  : fallbackFrames;

  const fps = activeProject?.fps ?? 12;
  const background = activeProject?.background ?? DEFAULT_BACKGROUND;

  const timelineFrames = useMemo(() => frames.map((f) => f.image), [frames]);

  const stabilizationPresent = useMemo(
    () => hasStabilization(frames),
    [frames]
  );

  const stabilizationStale = useMemo(() => {
    if (!activeProject?.stabilization) return false;

    const hashes = frames.map((f) => f.image ?? "");
    return isStabilizationStale(activeProject, hashes);
  }, [activeProject, frames]);

  const memoProjects = useMemo(() => projects, [projects]);
  const memoFrames = useMemo(() => frames, [frames]);

  // Frame shown on canvas
  const currentIndex = isPlaying ? previewFrame : activeFrame;

  // ---------- Playback ----------
  const durationSignature = useMemo(
    () => frames.map((f) => `${f.duration}:${!!f.image}`).join("|"),
    [frames]
  );

  useEffect(() => {
    if (!isPlaying) return;

    const sequence: number[] = [];

    frames.forEach((frame, index) => {
      if (!frame.image) return;

      const hold = Math.max(1, frame.duration || 1);
      for (let i = 0; i < hold; i++) sequence.push(index);
    });

    if (!sequence.length) return;

    let animationId = 0;
    let lastTime = performance.now();
    let position = 0;

    // Smooth resume: check if the previous frame is still valid in our new sequence
    setPreviewFrame((prev) => {
      position = sequence.includes(prev) ? sequence.indexOf(prev) : 0;
      return sequence[position];
    });

    const frameDuration = 1000 / fps;

    const animate = (time: number) => {
      if (time - lastTime >= frameDuration) {
        position = (position + 1) % sequence.length;
        setPreviewFrame(sequence[position]);
        lastTime += frameDuration;
      }
      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationId);
  }, [isPlaying, fps, durationSignature]);

  // ---------- Helpers (Centralized Pauses) ----------

  // pushUndo takes a single Project snapshot; activeFrame is captured at call time.
    const pushUndo = useCallback(
    (project: Project) => {
      console.log("pushUndo, stack size before:", undoStack.current.length);

      undoStack.current.push({
        projectId: project.id,
        project,
        activeFrame,
      });

      if (undoStack.current.length > 50) {
        undoStack.current.shift();
      }

      redoStack.current = [];
    },
    [activeFrame]
  );
  // Any project mutation forces playback to pause
  const updateProject = useCallback(
    (fn: (p: Project) => Project) => {
      setIsPlaying(false);

      const current = projectsRef.current.find((p) => p.id === activeProjectId);
      if (!current) return;

      pushUndo(structuredClone(current));

      setProjects((prev) => {
        const next = prev.map((p) =>
          p.id === activeProjectId ? updateProjectTimestamp(fn(p)) : p
        );

        projectsRef.current = next;
        return next;
      });
    },
    [activeProjectId, pushUndo]
  );

  const undo = useCallback(() => {
    console.log("undo called, stack size:", undoStack.current.length);
    const snapshot = undoStack.current.pop();
    if (!snapshot) return;

    const current = projectsRef.current.find(
      (p) => p.id === snapshot.projectId
    );
    if (!current) return;

    redoStack.current.push({
      projectId: current.id,
      project: { ...current },
      activeFrame,
    });

    const nextProjects = projectsRef.current.map((p) =>
      p.id === snapshot.projectId ? snapshot.project : p
    );

    projectsRef.current = nextProjects;
    setProjects(nextProjects);

    const restored = snapshot.project.frames.find((f) =>
      deletedFrameImages.current.has(f.id)
    );

    if (restored?.image) {
      saveFrameImage(
        snapshot.projectId,
        restored.id,
        restored.image
      ).catch(console.error);

      deletedFrameImages.current.delete(restored.id);
    }

    if (restored?.image) {
      saveFrameImage(snapshot.projectId, restored.id, restored.image).catch(
        console.error
      );
      deletedFrameImages.current.delete(restored.id);
    }

    setActiveProjectId(snapshot.projectId);
    setActiveFrame(snapshot.activeFrame);
    setEditingIndex(snapshot.activeFrame);
    setIsPlaying(false);
  }, [activeFrame]);

  

    const redo = useCallback(() => {
    const snapshot = redoStack.current.pop();
    if (!snapshot) return;

    const current = projectsRef.current.find(
      (p) => p.id === snapshot.projectId
    );
    if (!current) return;

    undoStack.current.push({
      projectId: current.id,
      project: { ...current },
      activeFrame,
    });

    const nextProjects = projectsRef.current.map((p) =>
      p.id === snapshot.projectId ? snapshot.project : p
    );

    projectsRef.current = nextProjects;
    setProjects(nextProjects);

    // Restore deleted image to IndexedDB
    const restored = snapshot.project.frames.find((f) =>
      deletedFrameImages.current.has(f.id)
    );

    if (restored?.image) {
      saveFrameImage(snapshot.projectId, restored.id, restored.image).catch(
        console.error
      );
      deletedFrameImages.current.delete(restored.id);
    }

    setActiveProjectId(snapshot.projectId);
    setActiveFrame(snapshot.activeFrame);
    setEditingIndex(snapshot.activeFrame);
    setIsPlaying(false);
  }, [activeFrame]);

    useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        ((el.tagName === "INPUT" &&
          // A slider keeps focus after a drag; undo must still work there.
          (el as HTMLInputElement).type !== "range") ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }

      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

      const key = e.key.toLowerCase();

      if (key === "i" && !e.shiftKey) {
        if (invertMaskShortcut.current()) e.preventDefault();
        return;
      }

      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (!selectionActive) undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        if (!selectionActive) redo();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, selectionActive]);

  // Any manual frame selection forces playback to pause
  const selectFrame = useCallback(
    (value: React.SetStateAction<number>) => {
      setIsPlaying(false);

      const next = typeof value === "function" ? value(activeFrame) : value;

      setActiveFrame(next);
      setEditingIndex(next);
      setPreviewFrame(next);
    },
    [activeFrame]
  );

  const handleHistoryCommit = useCallback(() => {
    const project = projectsRef.current.find((p) => p.id === activeProjectId);
    if (!project) return;

    pushUndo(structuredClone(project));
  }, [pushUndo, activeProjectId]);

  const handleHistoryPushFrame = useCallback(
    (frame: Frame) => {
      const current = projectsRef.current.find((p) => p.id === activeProjectId);
      if (!current) return;

      pushUndo(
        structuredClone({
          ...current,
          frames: current.frames.map((f) =>
            f.id === frame.id ? { ...frame } : f
          ),
        })
      );
    },
    [pushUndo, activeProjectId, activeFrame]
  );

  const handleAutoStabilize = useCallback(async () => {
    const project = projectsRef.current.find((p) => p.id === activeProjectId);
    if (!project) return;

    const solved = await stabilizer.run(project.frames);
    if (!solved) return;

    updateProject((p) => ({
      ...p,
      frames: assignStabilization(p.frames, solved),
      stabilization: {
        algorithmVersion: solved.provenance.algorithmVersion,
        inputHashes: solved.provenance.inputHashes,
        constantsFingerprint: solved.provenance.constantsFingerprint,
        appliedAt: Date.now(),
      },
    }));
  }, [activeProjectId, stabilizer, updateProject]);

  const handleClearStabilization = useCallback(() => {
    updateProject((p) => ({
      ...p,
      frames: clearStabilization(p.frames),
      stabilization: undefined,
    }));
  }, [updateProject]);

  // ---------- FIX: wrapped in useCallback so the reference is stable ----------
  // Previously a plain function, which got a new reference on every render.
  // That made commitFrame unstable → editor recreated → useLayerEditor sync
  // effect fired → setSelection → re-render → infinite loop.
  const updateCurrentFrame = useCallback(
    (updatedFrame: Frame) => {
      setProjects((prev) => {
        const current = prev.find((p) => p.id === activeProjectId);
        if (!current) return prev;

        const existing = current.frames.find((f) => f.id === updatedFrame.id);
        if (
          existing &&
          existing.image === updatedFrame.image &&
          existing.x === updatedFrame.x &&
          existing.y === updatedFrame.y &&
          existing.zoom === updatedFrame.zoom &&
          existing.rotation === updatedFrame.rotation &&
          existing.duration === updatedFrame.duration &&
          existing.stab?.dx === updatedFrame.stab?.dx &&
          existing.stab?.dy === updatedFrame.stab?.dy &&
          existing.layers === updatedFrame.layers &&
          existing.activeLayerId === updatedFrame.activeLayerId &&
          existing.crop === updatedFrame.crop &&
          existing.transparency === updatedFrame.transparency
        ) {
          // No real change — return SAME object so React bails out (no re-render).
          return prev;
        }

        const next = prev.map((p) => {
          if (p.id !== activeProjectId) return p;
          const updatedFrames = p.frames.map((f) =>
            f.id === updatedFrame.id ? updatedFrame : f
          );
          const thumbnail = updatedFrames.find((f) => f.image)?.image ?? null;
          return { ...p, frames: updatedFrames, thumbnail };
        });
        projectsRef.current = next;
        return next;
      });
    },
    [activeProjectId]
  );

  /* ================= layer editor plumbing ================= */

  const editFrame = memoFrames[editingIndex] ?? memoFrames[0];

  /**
   * Apply a reduced Frame to the document WITHOUT pushing undo.
   *
   * The split is deliberate and mirrors `useAutoStabilize`: the reducer decides
   * whether an action is undoable, the hook calls `onBeginHistory` once per
   * gesture, and this function is the pure write. Pushing undo here instead
   * would give a drag one snapshot per pointermove.
   */
  const commitFrame = useCallback(
    (next: Frame, _opts: { undoable: boolean }) => {
      setIsPlaying(false);
      updateCurrentFrame(next);
    },
    [updateCurrentFrame]
  );

  const editor = useLayerEditor({
    frame: editFrame,
    view: canvasView,
    getBounds: getCanvasBounds,
    onCommit: commitFrame,
    onBeginHistory: handleHistoryCommit,
    disabled: isPlaying || selectionActive,
  });

  /**
   * Recomposite `frame.image` whenever the layer stack changes.
   *
   * `frame.image` is the flatten CACHE: the timeline thumbnail, the GIF
   * exporter and the LSA content hash all still read it, which is what let the
   * layer system land without rewriting any of them. The reducer invalidates
   * the key on every mutation; this effect is the only thing that refills it.
   *
   * Debounced, and bitmaps are awaited first — the compositor is synchronous
   * and silently skips undecoded layers, so flattening early would drop them.
   * One stale frame is repaired per tick so an undo that invalidates twenty
   * frames does not block a single paint.
   */
  useEffect(() => {
    const project = projectsRef.current.find((p) => p.id === activeProjectId);
    if (!project) return;

    const stale =
      (project.frames[editingIndex]?.flattenKey === null
        ? project.frames[editingIndex]
        : null) ?? project.frames.find((f) => f.flattenKey === null);

    if (!stale) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      await preloadFrameBitmaps(stale.layers);
      if (cancelled) return;

      const next = reflattenIfStale(stale);
      if (next !== stale) updateCurrentFrame(next);
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projects, activeProjectId, editingIndex, updateCurrentFrame]);

  const handleBackgroundChange = useCallback(
    (next: CanvasBackground) => {
      updateProject((p) => ({ ...p, background: next }));
    },
    [updateProject]
  );

  /**
   * Remove the solid background baked into every frame's artwork (the colour
   * of the sheet it was cut from) and make that colour the canvas background.
   * The look is unchanged, but the colour no longer moves with the artwork,
   * and choosing Transparent afterwards removes it entirely. One undo step.
   */
  const [removingArtBg, setRemovingArtBg] = useState(false);
  const [artBgNotice, setArtBgNotice] = useState<string | null>(null);
  const removeArtBackground = async () => {
    const project = projectsRef.current.find((p) => p.id === activeProjectId);
    if (!project || removingArtBg) return;
    setRemovingArtBg(true);
    setArtBgNotice(null);
    try {
      const results = new Map<string, { layerId: string; image: string }>();
      const colours = new Map<number, number>();
      for (const f of project.frames) {
        const base = f.layers.find((l) => l.kind === "base");
        if (!base?.image) continue;
        const img = await loadBitmap(base.image).catch(() => null);
        if (!img) continue;
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) continue;
        ctx.drawImage(img, 0, 0);
        const out = removeFrameBackground(ctx.getImageData(0, 0, c.width, c.height));
        if (!out) continue;
        ctx.putImageData(out.image, 0, 0);
        results.set(f.id, { layerId: base.id, image: c.toDataURL("image/png") });
        colours.set(out.background, (colours.get(out.background) ?? 0) + 1);
      }
      if (!results.size) {
        setArtBgNotice("No solid background colour found in the frames.");
        return;
      }
      // Decode first, so the canvas never shows a frame without its artwork.
      await Promise.all([...results.values()].map((r) => loadBitmap(r.image).catch(() => null)));
      const [colour] = [...colours].sort((a, b) => b[1] - a[1])[0];
      const hex = `#${colour.toString(16).padStart(6, "0")}`;
      updateProject((p) => ({
        ...p,
        background: { ...p.background, transparent: false, color: hex },
        frames: p.frames.map((f) => {
          const r = results.get(f.id);
          return r
            ? {
                ...f,
                layers: f.layers.map((l) => (l.id === r.layerId ? { ...l, image: r.image } : l)),
                flattenKey: null,
              }
            : f;
        }),
      }));
      setArtBgNotice(
        `Removed from ${results.size} frame${results.size === 1 ? "" : "s"}. ` +
          "The colour is now a steady background; pick Transparent to remove it."
      );
    } finally {
      setRemovingArtBg(false);
    }
  };

  /**
   * Clear the active layer's pixels.
   *
   * Written here rather than as a reducer action because it is the legacy
   * "Clear" button and must keep its exact meaning: blank the bitmap, keep the
   * layer and its transform. The two post-mutation invariants the reducer
   * normally applies — re-derive the legacy fields, invalidate the flatten
   * cache — are applied explicitly so the compatibility contract is not
   * quietly bypassed.
   */
  const clearActiveLayerPixels = useCallback(() => {
    updateProject((project) => {
      const frames = project.frames.map((frame, index) => {
        if (index !== editingIndex) return frame;

        const targetId = frame.activeLayerId;
        const layers = frame.layers.map((l) =>
          l.id === targetId ? { ...l, image: null, crop: null, strokes: [] } : l
        );

        return syncBaseFromLegacy({
          ...frame,
          layers,
          image: null,
          flattenKey: null,
        });
      });

      return {
        ...project,
        frames,
        thumbnail: frames.find((f) => f.image)?.image ?? null,
      };
    });
  }, [editingIndex, updateProject]);

  const openPicker = (intent: ImportIntent) => {
    setIsPlaying(false);
    pendingImport.current = intent;
    fileInputRef.current?.click();
  };

  const readImageDataUrl = (file: File) =>
    new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) =>
        resolve(typeof e.target?.result === "string" ? e.target.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });

  /** One blank layer on every frame, same name everywhere; one undo step.
   *  Frames already at the layer limit are left as they are. */
  const addBlankLayerAllFrames = () => {
    const name = `Layer ${editFrame.layers.length}`;
    const size = { w: BLANK_LAYER_SIZE, h: BLANK_LAYER_SIZE };
    const linkId = createLayerId();
    updateProject((project) => ({
      ...project,
      frames: project.frames.map((f) =>
        layerReducer(f, { type: "layer/add", image: null, size, name, linkId })
      ),
    }));
  };

  /** An adjustment layer recolours the whole animation, so it goes on every
   *  frame, linked, as one undo step. */
  const addAdjustmentLayer = (type: AdjustmentType) => {
    const linkId = createLayerId();
    const adjust = defaultAdjustment(type);
    const name = ADJUSTMENT_LABELS[type];
    updateProject((project) => ({
      ...project,
      frames: project.frames.map((f) =>
        layerReducer(f, { type: "layer/add", image: null, size: { w: 0, h: 0 }, name, linkId, adjust })
      ),
    }));
  };

  /** Apply `fn` to the project without an undo step: slider drags push theirs
   *  once, when the drag starts (`onBeginEdit`). */
  const updateProjectQuiet = (fn: (p: Project) => Project) => {
    setIsPlaying(false);
    setProjects((prev) => {
      const next = prev.map((p) =>
        p.id === activeProjectId ? updateProjectTimestamp(fn(p)) : p
      );
      projectsRef.current = next;
      return next;
    });
  };

  /**
   * Layer panel edits. Settings of a layer that has linked copies on other
   * frames (blend, alpha lock, clipping, opacity, adjustment) change every
   * copy. Toggles are one undo step each; slider drags one per drag.
   */
  const dispatchLayerPanel = (action: LayerAction) => {
    // A new mask is where painting goes next, as in Photoshop.
    if (action.type === "layer/maskAdd") setEditMask(true);
    if (action.type === "layer/maskDelete") setEditMask(false);
    const linked =
      action.type === "layer/maskAdd" ||
      action.type === "layer/maskSet" ||
      action.type === "layer/maskDelete" ||
      action.type === "layer/blend" ||
      action.type === "layer/alphaLock" ||
      action.type === "layer/clip" ||
      action.type === "layer/opacity" ||
      action.type === "layer/adjust";
    if (!linked || isPlaying || selectionActive) {
      editor.dispatch(action);
      return;
    }
    const layer = editFrame.layers.find((l) => l.id === action.id);
    const linkId = layer?.linkId;
    // Adjustment sliders always come here, so their undo is per drag.
    if (!layer || (!linkId && action.type !== "layer/adjust")) {
      editor.dispatch(action);
      return;
    }
    const apply = (project: Project): Project => ({
      ...project,
      frames: project.frames.map((f) => {
        const twin = linkId
          ? f.layers.find((l) => l.linkId === linkId)
          : f.id === editFrame.id ? layer : undefined;
        return twin ? layerReducer(f, { ...action, id: twin.id }) : f;
      }),
    });
    if (action.type === "layer/opacity" || action.type === "layer/adjust") updateProjectQuiet(apply);
    else updateProject(apply);
  };

  /** Apply Mask: bake the mask into the layer's pixels (every linked copy,
   *  each with its own mask) as one undo step. */
  const applyingMask = useRef(false);
  const applyLayerMask = async (id: string) => {
    const layer = editFrame.layers.find((l) => l.id === id);
    if (!layer?.mask || layer.adjust || applyingMask.current) return;
    const project = projectsRef.current.find((p) => p.id === activeProjectId);
    if (!project) return;
    applyingMask.current = true;
    try {
      const targets = project.frames
        .map((f) => ({
          frameId: f.id,
          twin: layer.linkId
            ? f.layers.find((l) => l.linkId === layer.linkId)
            : f.id === editFrame.id ? f.layers.find((l) => l.id === id) : undefined,
        }))
        .filter((t) => t.twin?.mask);
      const baked = new Map<string, { id: string; image: string }>();
      for (const t of targets) {
        const image = await applyMaskToPixels(t.twin!);
        if (!image) return; // a decode failed: change nothing
        baked.set(t.frameId, { id: t.twin!.id, image });
      }
      // Decode before swapping in, so the canvas never shows the layer blank.
      await Promise.all([...baked.values()].map((b) => loadBitmap(b.image).catch(() => null)));
      setEditMask(false);
      updateProject((p) => ({
        ...p,
        frames: p.frames.map((f) => {
          const b = baked.get(f.id);
          return b ? layerReducer(f, { type: "layer/maskApplied", id: b.id, image: b.image }) : f;
        }),
      }));
    } finally {
      applyingMask.current = false;
    }
  };

  /** Ctrl+I: invert the targeted mask. */
  const invertMaskShortcut = useRef<() => boolean>(() => false);
  invertMaskShortcut.current = () => {
    const l = editFrame.layers.find((x) => x.id === editor.primary?.id);
    if (!editMask || !l?.mask || l.locked || isPlaying || selectionActive) return false;
    dispatchLayerPanel({ type: "layer/maskSet", id: l.id, patch: { inverted: !l.mask.inverted } });
    return true;
  };

  const handleImport = (file: File) => {
  setIsPlaying(false);

  const intent = pendingImport.current ?? {
    kind: "replace-active" as const,
    frame: editingIndex,
  };
  pendingImport.current = null;

  void (async () => {
    if (intent.kind === "slice") {
      setSliceFile(file);
      setShowCutter(true);
      return;
    }

    const dataUrl = await readImageDataUrl(file);
    if (!dataUrl) return;

    const bitmap = await loadBitmap(dataUrl).catch(() => null);
    if (!bitmap) return;

    const size = { w: bitmap.naturalWidth, h: bitmap.naturalHeight };

    updateProject((project) => {
      const nextFrames = project.frames.map((f, i) => {
        if (i !== intent.frame) return f;

        const action: LayerAction =
          intent.kind === "new-layer"
            ? { type: "layer/add", image: dataUrl, size }
            : {
                type: "layer/setImage",
                id: f.activeLayerId,
                image: dataUrl,
                size,
              };

        return layerReducer(f, action);
      });

      return {
        ...project,
        frames: nextFrames,
        thumbnail: nextFrames.find((f) => f.image)?.image ?? project.thumbnail,
      };
    });

    selectFrame(intent.frame);
  })();
};
  
     const createProject = useCallback(() => {
  const project = createEmptyProject(
    `Animation ${projectsRef.current.length + 1}`
  );

  stabilizer.cancel();
  stabilizer.reset();

  setProjects((prev) => {
    const next = [...prev, project];
    projectsRef.current = next;
    return next;
  });

  setActiveProjectId(project.id);
  setActiveFrame(0);
  setEditingIndex(0);
  setPreviewFrame(0);
  setIsPlaying(false);
}, [stabilizer]);

const renameProject = useCallback((id: string, name: string) => {
  setProjects((prev) => {
    const next = prev.map((p) =>
      p.id === id ? updateProjectTimestamp({ ...p, name }) : p
    );
    projectsRef.current = next;
    return next;
  });
}, []);

const deleteProject = useCallback(
  (id: string) => {
    const current = projectsRef.current;
    if (current.length <= 1) return;

    const remaining = current.filter((p) => p.id !== id);

    stabilizer.cancel();
    stabilizer.reset();

    deleteProjectImages(id).catch(console.error);
    deleteProjectLayerImages(id).catch(console.error);

    projectsRef.current = remaining;
    setProjects(remaining);

    if (id === activeProjectId) {
      setActiveProjectId(remaining[0].id);
      setActiveFrame(0);
      setEditingIndex(0);
      setPreviewFrame(0);
      setIsPlaying(false);
    }
  },
  [activeProjectId, stabilizer]
);  
  return (
    <main className="flex h-screen flex-col overflow-hidden bg-[#0F1117] text-white">
      <Toolbar
        isPlaying={isPlaying}
        saveStatus={saveStatus}
        onPlay={() => setIsPlaying((v) => !v)}
        onUndo={undo}
        onRedo={redo}
        onImport={() =>
          openPicker({ kind: "replace-active", frame: editingIndex })
        }
        onSlice={() => openPicker({ kind: "slice" })}
        onExport={() => setShowExport(true)}
        onAutoStabilize={handleAutoStabilize}
        onClearStabilization={handleClearStabilization}
        stabilizeStatus={stabilizer.status}
        stabilizeProgress={stabilizer.progress}
        hasStabilization={stabilizationPresent}
        stabilizationStale={stabilizationStale}
      />

      <section className="flex min-h-0 flex-1">
        <div className="flex shrink-0 border-r border-white/10 bg-[#11151D]">
          <button
            onClick={() => setShowProjects((v) => !v)}
            title={showProjects ? "Hide projects" : "Show projects"}
            aria-label="Toggle projects"
            className={`flex w-12 flex-col items-center gap-1 pt-4 text-xs ${
              showProjects ? "text-white" : "text-zinc-400 hover:text-white"
            }`}
          >
            <FolderOpen size={20} />
          </button>

          {showProjects && (
            <ProjectSidebar
              projects={memoProjects}
              activeProject={activeProjectId}
              onSelect={(id) => {
                if (id === activeProjectId) return;

                stabilizer.cancel();
                stabilizer.reset();

                setActiveProjectId(id);
                setActiveFrame(0);
                setEditingIndex(0);
                setIsPlaying(false);
              }}
              onCreate={createProject}
              onRename={renameProject}
              onDelete={deleteProject}
            />
          )}
        </div>
        

  

        <Canvas
          projectId={activeProject?.id ?? ""}
          editMask={editMask}
          containerRef={canvasContainerRef}
          background={background}
          transparency={transparency}
          editor={editor}
          frame={
            isPlaying
              ? memoFrames[currentIndex] ?? memoFrames[0]
              : memoFrames[editingIndex] ?? memoFrames[0]
          }
          editFrame={editFrame}
          onSaveStatusChange={setSaveStatus}
          previousFrame={(() => {
            const i = isPlaying ? previewFrame : editingIndex;
            return i > 0 ? frames[i - 1] ?? null : null;
          })()}
          onionSkin={onionSkin}
          isPlaying={isPlaying}
          view={canvasView}
          onViewChange={setCanvasView}
          onImport={() =>
            openPicker({ kind: "replace-active", frame: editingIndex })
          }
          onImageDrop={handleImport}
          onChange={updateCurrentFrame}
          onHistoryCommit={handleHistoryCommit}
          onHistoryPushFrame={handleHistoryPushFrame}
          onUndo={undo}
          onRedo={redo}
          onSelectionActiveChange={setSelectionActive}
          canUndo={undoStack.current.length > 0}
          canRedo={redoStack.current.length > 0}
          showGuides={showGuides}
          guideMode={guideMode}
        />

        {showLayerPanel && (
          <LayerPanel
            layers={editFrame.layers}
            selection={editor.selection}
            disabled={isPlaying || selectionActive}
            onSelect={editor.select}
            dispatch={dispatchLayerPanel}
            onAddImage={() =>
              openPicker({ kind: "new-layer", frame: editingIndex })
            }
            onAddBlankAllFrames={addBlankLayerAllFrames}
            onAddAdjustment={addAdjustmentLayer}
            editMask={editMask}
            onEditMaskChange={setEditMask}
            onApplyMask={applyLayerMask}
            onBeginEdit={handleHistoryCommit}
          />
        )}

        <RightSidebar
          activeFrame={activeFrame}
          fps={fps}
          onFpsChange={(value) =>
            updateProject((project) => ({
              ...project,
              fps: value,
            }))
          }
          onionSkin={onionSkin}
          onToggleOnion={setOnionSkin}
          duration={frames[activeFrame]?.duration ?? 1}
          onDurationChange={(value) =>
            updateProject((project) => {
              const next = [...project.frames];
              next[activeFrame] = {
                ...next[activeFrame],
                duration: value,
              };
              return { ...project, frames: next };
            })
          }
          showGuides={showGuides}
          onToggleGuides={setShowGuides}
          guideMode={guideMode}
          onGuideModeChange={setGuideMode}
          transparency={transparency}
          onTransparencyChange={patch}
        >
                    <details className="border-t border-white/10">
            <summary className="cursor-pointer select-none list-none p-3 text-xs font-semibold tracking-wide text-zinc-400 hover:text-white">
              ▸ TRANSFORM
            </summary>

          <TransformPanel
            layer={editor.primary}
            disabled={isPlaying || selectionActive}
            dispatch={editor.dispatch}
            onStraightenTool={() => editor.setTool("straighten")}
            onCropTool={() => editor.beginCrop()}
          />
                    </details>
          <details className="border-t border-white/10">
            <summary className="cursor-pointer select-none list-none p-3 text-xs font-semibold tracking-wide text-zinc-400 hover:text-white">
              ▸ SQUASH &amp; STRETCH
            </summary>
            <SquashPanel
              layer={
                editor.primary && !editor.primary.adjust
                  ? editor.primary
                  : editFrame.layers.find((l) => l.kind === "base") ?? null
              }
              disabled={isPlaying || selectionActive}
              dispatch={editor.dispatch}
              onEnd={editor.endGesture}
            />
          </details>
          <TransparencyToggle
            background={background}
            onChange={handleBackgroundChange}
            disabled={isPlaying}
            onRemoveArtBackground={removeArtBackground}
            removingArtBackground={removingArtBg}
            artBackgroundNotice={artBgNotice}
          />
        </RightSidebar>
      </section>

      <Timeline
        frames={timelineFrames}
        background={background}
        activeFrame={activeFrame}
        onFrameSelect={selectFrame}
        onReorder={(from, to) => {
          const insertAt = from < to ? to - 1 : to;

          updateProject((project) => {
            const next = [...project.frames];

            const moved = next.splice(from, 1)[0];
            next.splice(insertAt, 0, moved);

            return {
              ...project,
              frames: next,
            };
          });

          selectFrame(insertAt);
        }}
        onAddFrame={() => {
          const target = frames.length;

          updateProject((project) => ({
            ...project,
            frames: [...project.frames, createBlankFrame()],
          }));

          selectFrame(target);
        }}
        onImportFrame={(frame) => {
          selectFrame(frame);
          openPicker({ kind: "replace-active", frame });
        }}
                onClear={clearActiveLayerPixels}
        onDuplicate={() => {
          const target = editingIndex + 1;

          updateProject((project) => {
            const next = [...project.frames];

            next.splice(target, 0, duplicateFrame(next[editingIndex]));

            return {
              ...project,
              frames: next,
            };
          });

          selectFrame(target);
        }}
        onDeleteFrame={() => {
          if (frames.length === 1) {
            updateProject((project) => ({
              ...project,
              frames: [createBlankFrame()],
              thumbnail: null,
            }));

            selectFrame(0);
            return;
          }

          const frameToDelete = frames[editingIndex];

          if (frameToDelete?.image && activeProject) {
            deletedFrameImages.current.set(
              frameToDelete.id,
              frameToDelete.image
            );

            deleteFrameImage(activeProject.id, frameToDelete.id).catch(
              console.error
            );
          }

          updateProject((project) => {
            const result = deleteFrame(project.frames, editingIndex);

            return {
              ...project,
              frames: result.frames,
              thumbnail: result.frames.find((f) => f.image)?.image ?? null,
            };
          });

          const result = deleteFrame(frames, editingIndex);
          selectFrame(result.nextIndex);
        }}

      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];

          if (file) {
            handleImport(file);
          } else {
            pendingImport.current = null;
          }

          e.currentTarget.value = "";
        }}
      />

      <ExportDialog
        open={showExport}
        preset={exportPreset}
        size={exportSize}
        limit={exportLimit}
        onPresetChange={(preset) => {
          setExportPreset(preset);

          switch (preset) {
            case "sticker":
              setExportSize(320);
              setExportLimit(512);
              break;

            case "emoji":
              setExportSize(128);
              setExportLimit(256);
              break;

            case "hd":
              setExportSize(512);
              setExportLimit("none");
              break;

            case "custom":
              break;
          }
        }}
        onSizeChange={setExportSize}
        onLimitChange={setExportLimit}
        onClose={() => setShowExport(false)}
        onExport={async () => {
          try {
            let finalSize: ExportSize = exportSize;
            let finalLimit: ExportLimit = exportLimit;

            switch (exportPreset) {
              case "sticker":
                finalSize = 320;
                finalLimit = 512;
                break;
              case "emoji":
                finalSize = 128;
                finalLimit = 256;
                break;
              case "hd":
                finalSize = 512;
                finalLimit = "none";
                break;
            }

            // Background is DOCUMENT state, so it goes to the exporter: an
            // opaque canvas means no transparent index in the GIF.
            const blob = await exportGIF(
              frames,
              finalSize,
              fps,
              finalLimit,
              background
            );
            const url = URL.createObjectURL(blob);

            const link = document.createElement("a");
            link.href = url;
            link.download = `${activeProject?.name || "animation"}.gif`;
            document.body.appendChild(link);
            link.click();
            link.remove();

            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (err) {
            console.error(err);
            alert("GIF export failed. Please try again.");
          } finally {
            setShowExport(false);
          }
        }}
      />

      {/* Manual grid cutter — sibling of ExportDialog */}
      {showCutter && sliceFile && (
        <SpriteSheetCutter
          source={sliceFile}
          onCancel={() => {
            setShowCutter(false);
            setSliceFile(null);
          }}
          onSliced={(grid, sliced) => {
            stabilizer.cancel();
            stabilizer.reset();
            setShowCutter(false);
            setSliceFile(null);

            void (async () => {
              // Each cell becomes its own frame whose BASE layer holds the
              // pixels. Sizes are resolved before the frames land so the
              // lattice Ω is identical across frames — the invariant the LSA
              // decoder rejects a project for violating.
              const built = await Promise.all(
  sliced.map(async (image) => {
    const blank = createBlankFrame();
    const base = blank.layers[0];
    const bitmap = await loadBitmap(image).catch(() => null);

    const size = bitmap
      ? { w: bitmap.naturalWidth, h: bitmap.naturalHeight }
      : { w: 0, h: 0 };

    const withImage: Frame = {
      ...blank,
      image,
      layers: blank.layers.map((l) =>
        l.id === base.id
          ? {
              ...l,
              image,
              size,
              crop: null,
              pose: defaultFitPose(size.w, size.h),
            }
          : l
      ),
      legacyPosePending: false,
      flattenKey: null,
    };

    return syncBaseFromLegacy(clearTransforms(withImage));
  })
);

              updateProject((project) => ({
                ...project,
                frames: built.length ? built : [createBlankFrame()],
                thumbnail: sliced[0] ?? null,
              }));

              selectFrame(0);
            })();
          }}
        />
      )}
    </main>
  );
}
