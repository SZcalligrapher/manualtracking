import { FINGERS, buildTrackingKeyframes, convexHull, fingertipPointsForHands } from "./finger-tracking.js?v=20260810-17";

const COLORS = Object.fromEntries(FINGERS.map(finger => [finger.id, finger.color]));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clone = value => JSON.parse(JSON.stringify(value));
const HANDS = [
  { id: "left", label: "左手" },
  { id: "right", label: "右手" },
];
const DEFAULT_ACTIVE_FINGER_IDS = HANDS.flatMap(hand => FINGERS.map(finger => `${hand.id}:${finger.id}`));
const OVERLAY_EFFECT_LABELS = {
  none: "无",
  glitch: "故障闪切",
  "neon-scan": "霓虹扫描",
  shockwave: "冲击波",
  "dark-focus": "暗场聚焦",
  feedback: "反馈残影",
  "rgb-split": "RGB 分离",
  "pixel-poster": "像素海报",
  "liquid-warp": "液态扭曲",
  "raster-slice": "扫描切片",
};

function normalizeOverlayEffect(value) {
  return Object.hasOwn(OVERLAY_EFFECT_LABELS, value) ? value : "none";
}

function isSmoothableTrackingPoint(point) {
  return point && point.hand !== "Custom" && !point.id?.startsWith("custom:") && !String(point.source || "").startsWith("manual");
}

export function smoothTrackingKeyframes(keyframes, { enabled = true, threshold = .02, maxGap = 6 } = {}) {
  const safeThreshold = clamp(Number(threshold) || .02, .005, .08);
  const safeMaxGap = Math.max(1, Math.round(Number(maxGap) || 1));
  const tracks = new Map();
  for (const keyframe of keyframes || []) {
    for (const point of keyframe.points || []) {
      if (!isSmoothableTrackingPoint(point)) continue;
      if (!Number.isFinite(point.trackingRawX)) point.trackingRawX = point.x;
      if (!Number.isFinite(point.trackingRawY)) point.trackingRawY = point.y;
      point.x = point.trackingRawX;
      point.y = point.trackingRawY;
      if (!tracks.has(point.id)) tracks.set(point.id, []);
      tracks.get(point.id).push({ frame: keyframe.frame, point });
    }
  }
  if (!enabled) return { changedPoints: 0, eligiblePoints: [...tracks.values()].reduce((sum, track) => sum + track.length, 0) };

  let changedPoints = 0;
  for (const track of tracks.values()) {
    track.sort((a, b) => a.frame - b.frame);
    for (let index = 1; index < track.length - 1; index++) {
      const previous = track[index - 1];
      const current = track[index];
      const next = track[index + 1];
      if (current.frame - previous.frame > safeMaxGap || next.frame - current.frame > safeMaxGap) continue;
      const px = previous.point.trackingRawX;
      const py = previous.point.trackingRawY;
      const cx = current.point.trackingRawX;
      const cy = current.point.trackingRawY;
      const nx = next.point.trackingRawX;
      const ny = next.point.trackingRawY;
      const beforeDistance = Math.hypot(cx - px, cy - py);
      const afterDistance = Math.hypot(nx - cx, ny - cy);
      const neighborDistance = Math.hypot(nx - px, ny - py);
      if (beforeDistance > safeThreshold || afterDistance > safeThreshold || neighborDistance > safeThreshold * 1.8) continue;
      const smoothedX = (px + nx) / 2;
      const smoothedY = (py + ny) / 2;
      if (Math.hypot(smoothedX - cx, smoothedY - cy) <= 1e-7) continue;
      current.point.x = smoothedX;
      current.point.y = smoothedY;
      changedPoints++;
    }
  }
  return { changedPoints, eligiblePoints: [...tracks.values()].reduce((sum, track) => sum + track.length, 0) };
}

export function buildMaskShapes(points) {
  const safePoints = points || [];
  const hasCustomPoint = safePoints.some(point => point.hand === "Custom" || point.id?.startsWith("custom:"));
  if (!hasCustomPoint) {
    const byId = new Map(safePoints.map(point => [point.id, point]));
    const pairedFingers = FINGERS.map(finger => finger.id).filter(fingerId =>
      byId.has(`left:${fingerId}`) && byId.has(`right:${fingerId}`));
    if (pairedFingers.length >= 2) {
      const shapes = [];
      for (let index = 0; index < pairedFingers.length - 1; index++) {
        const first = pairedFingers[index];
        const second = pairedFingers[index + 1];
        shapes.push([
          byId.get(`right:${first}`),
          byId.get(`right:${second}`),
          byId.get(`left:${second}`),
          byId.get(`left:${first}`),
        ]);
      }
      return shapes;
    }
  }
  const hull = convexHull(safePoints);
  return hull.length >= 3 ? [hull] : [];
}

export function createEditor({ mode = "desktop" } = {}) {
  const $ = selector => document.querySelector(selector);
  const canvas = $("#stage");
  const ctx = canvas.getContext("2d");
  const overlaySourceCanvas = document.createElement("canvas");
  const overlaySourceCtx = overlaySourceCanvas.getContext("2d");
  const overlayAuxCanvas = document.createElement("canvas");
  const overlayAuxCtx = overlayAuxCanvas.getContext("2d");
  const overlayFeedbackCanvas = document.createElement("canvas");
  const overlayFeedbackCtx = overlayFeedbackCanvas.getContext("2d");
  const overlayBaseCanvas = document.createElement("canvas");
  const overlayBaseCtx = overlayBaseCanvas.getContext("2d");
  const overlayMaskCanvas = document.createElement("canvas");
  const overlayMaskCtx = overlayMaskCanvas.getContext("2d");
  const video = $("#sourceVideo");
  const stageWrap = $("#stageWrap");
  const emptyState = $("#emptyState");
  const timeline = $("#timeline");
  const scroller = $("#timelineScroller");
  let draggingId = null;
  let lastRender = 0;
  let raf = 0;
  let toastTimer = 0;
  let pendingManualRangeStart = null;
  let selectedOverlayId = null;
  let overlayPointerEdit = null;
  let manualRangePointerEdit = null;
  let exportRenderMode = false;
  let lastActiveOverlayId = null;
  let feedbackOverlayId = null;
  let feedbackFrame = -1;

  const project = {
    schema: "manual-tracking.project.v1",
    title: "未命名手势项目",
    fps: 30,
    width: 1280,
    height: 720,
    duration: 8,
    currentFrame: 0,
    video: null,
    overlays: [],
    maskTrackVersion: 1,
    keyframes: [],
    fingerSelectionKeyframes: [{ frame: 0, activeIds: [...DEFAULT_ACTIVE_FINGER_IDS] }],
    manualCorrectionRanges: [],
    autoFillMissingFingers: false,
    manualCorrectionFollow: true,
    manualCorrectionThreshold: .04,
    trackingSmoothingEnabled: true,
    trackingSmoothingThreshold: .02,
    customPointIndex: 1,
  };

  function frameCount() { return Math.max(1, Math.round(project.duration * project.fps)); }
  function currentTime() { return project.currentFrame / project.fps; }
  function frameAtTime(time) { return clamp(Math.round(time * project.fps), 0, frameCount()); }

  function fitCanvasToStage() {
    const availableWidth = stageWrap.clientWidth;
    const availableHeight = stageWrap.clientHeight;
    if (!availableWidth || !availableHeight || !canvas.width || !canvas.height) return;
    const aspect = canvas.width / canvas.height;
    let displayWidth = availableWidth;
    let displayHeight = displayWidth / aspect;
    if (displayHeight > availableHeight) {
      displayHeight = availableHeight;
      displayWidth = displayHeight * aspect;
    }
    canvas.style.width = `${Math.max(1, displayWidth)}px`;
    canvas.style.height = `${Math.max(1, displayHeight)}px`;
  }

  if ("ResizeObserver" in window) new ResizeObserver(fitCanvasToStage).observe(stageWrap);
  window.addEventListener("resize", fitCanvasToStage);
  requestAnimationFrame(fitCanvasToStage);

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1500);
  }

  function setVideoElement(element, metadata) {
    project.video = metadata;
    project.width = element.videoWidth || 1280;
    project.height = element.videoHeight || 720;
    project.duration = Number.isFinite(element.duration) ? element.duration : 8;
    canvas.width = project.width;
    canvas.height = project.height;
    fitCanvasToStage();
    emptyState.hidden = true;
    updateProjectStatus();
    setFrame(0);
    rebuildTimeline();
  }

  function loadTracking(landmarkData) {
    if (landmarkData.schema === "manual-tracking.project.v1") {
      restoreProject(landmarkData);
      return;
    }
    if (!landmarkData.frames) throw new Error("轨迹文件里没有 frames");
    applyLandmarkTracking(landmarkData);
    const totalPoints = project.keyframes.reduce((sum, item) => sum + item.points.length, 0);
    rebuildTimeline();
    render();
    showToast(`已生成 ${project.keyframes.length} 个关键帧、${totalPoints} 个可见指尖`);
  }

  function restoreProject(data) {
    const keepVideo = project.video;
    const keepOverlays = project.overlays.filter(layer => layer.element);
    Object.assign(project, clone(data));
    delete project.audio;
    project.fingerSelectionKeyframes = normalizeFingerSelectionKeyframes(data.fingerSelectionKeyframes);
    project.manualCorrectionRanges = normalizeManualCorrectionRanges(data.manualCorrectionRanges);
    if (!Array.isArray(data.manualCorrectionRanges)) {
      project.manualCorrectionRanges = normalizeManualCorrectionRanges(project.keyframes
        .filter(keyframe => keyframe.points.some(point => point.source === "manual" && DEFAULT_ACTIVE_FINGER_IDS.includes(point.id)))
        .map(keyframe => ({ startFrame: keyframe.frame, endFrame: keyframe.frame })));
    }
    project.autoFillMissingFingers = data.autoFillMissingFingers === true;
    project.manualCorrectionFollow = data.manualCorrectionFollow !== false;
    project.manualCorrectionThreshold = normalizeManualCorrectionThreshold(data.manualCorrectionThreshold);
    project.trackingSmoothingEnabled = data.trackingSmoothingEnabled !== false;
    project.trackingSmoothingThreshold = normalizeTrackingSmoothingThreshold(data.trackingSmoothingThreshold);
    pendingManualRangeStart = null;
    if (keepVideo && data.video?.name === keepVideo.name) project.video = keepVideo;
    project.overlays = (data.overlays || []).map(saved => {
      const matched = keepOverlays.find(layer => layer.id === saved.id) || keepOverlays.find(layer => layer.name === saved.name);
      return matched ? { ...saved, element: matched.element, url: matched.url } : saved;
    });
    project.maskTrackVersion = 1;
    normalizeOverlayClips({ repack: data.maskTrackVersion !== 1 });
    selectedOverlayId = activeOverlayAt(project.currentFrame)?.id || project.overlays[0]?.id || null;
    normalizeProjectPointData();
    canvas.width = project.width;
    canvas.height = project.height;
    fitCanvasToStage();
    rebuildManualFollowTracks();
    emptyState.hidden = true;
    updateProjectStatus();
    rebuildLayers();
    rebuildTimeline();
    setFrame(project.currentFrame || 0);
    showToast("工程已载入；媒体文件需要按名称重新关联");
  }

  function serializeProject() {
    normalizeProjectPointData();
    return {
      schema: project.schema,
      title: project.title,
      fps: project.fps,
      width: project.width,
      height: project.height,
      duration: project.duration,
      currentFrame: project.currentFrame,
      video: project.video ? stripRuntime(project.video) : null,
      overlays: project.overlays.map(stripRuntime),
      maskTrackVersion: project.maskTrackVersion,
      keyframes: clone(project.keyframes),
      fingerSelectionKeyframes: clone(project.fingerSelectionKeyframes),
      manualCorrectionRanges: clone(project.manualCorrectionRanges),
      autoFillMissingFingers: project.autoFillMissingFingers,
      manualCorrectionFollow: project.manualCorrectionFollow,
      manualCorrectionThreshold: project.manualCorrectionThreshold,
      trackingSmoothingEnabled: project.trackingSmoothingEnabled,
      trackingSmoothingThreshold: project.trackingSmoothingThreshold,
      customPointIndex: project.customPointIndex,
      exportedAt: new Date().toISOString(),
    };
  }

  function stripRuntime(asset) {
    const { element, url, file, ...safe } = asset;
    return safe;
  }

  function applyLandmarkTracking(landmarkData, { preserveEdits = false, forceSelectedFingers = false } = {}) {
    const manualOverrides = preserveEdits
      ? project.keyframes.flatMap(keyframe => keyframe.points
          .filter(point => point.source === "manual" || point.hand === "Custom")
          .map(point => ({ frame: keyframe.frame, point: clone(point) })))
      : [];
    const selectionKeyframes = clone(project.fingerSelectionKeyframes);
    const manualCorrectionRanges = clone(project.manualCorrectionRanges);
    const autoFillMissingFingers = project.autoFillMissingFingers;
    const manualCorrectionFollow = project.manualCorrectionFollow;
    const manualCorrectionThreshold = project.manualCorrectionThreshold;
    project.keyframes = buildTrackingKeyframes(landmarkData, project.fps, {
      forceFingerIdsAtFrame: forceSelectedFingers ? frame => [...activeFingerIdsAt(frame)] : undefined,
    });
    if (!preserveEdits) {
      project.fingerSelectionKeyframes = [{ frame: 0, activeIds: [...DEFAULT_ACTIVE_FINGER_IDS] }];
      project.manualCorrectionRanges = [];
      project.autoFillMissingFingers = false;
    } else {
      project.fingerSelectionKeyframes = selectionKeyframes;
      project.manualCorrectionRanges = manualCorrectionRanges;
      project.autoFillMissingFingers = autoFillMissingFingers;
      project.manualCorrectionFollow = manualCorrectionFollow;
      project.manualCorrectionThreshold = manualCorrectionThreshold;
      for (const override of manualOverrides) {
        const keyframe = ensureKeyframe(override.frame);
        const index = keyframe.points.findIndex(point => point.id === override.point.id);
        if (index >= 0) {
          if (override.point.source === "manual" && DEFAULT_ACTIVE_FINGER_IDS.includes(override.point.id)) {
            override.point.manualBaseX = keyframe.points[index].x;
            override.point.manualBaseY = keyframe.points[index].y;
            override.point.manualBaseSource = keyframe.points[index].source || "auto";
          }
          keyframe.points[index] = override.point;
        }
        else keyframe.points.push(override.point);
        keyframe.source = "manual";
      }
    }
    normalizeProjectPointData();
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
  }

  function applyDetectedHandsAtCurrentFrame(hands) {
    const frame = project.currentFrame;
    const activeIds = [...activeFingerIdsAt(frame)];
    const detected = repairDuplicateFingerPoints(fingertipPointsForHands(hands, { forceFingerIds: activeIds }));
    const activeDetected = detected.filter(point => activeIds.includes(point.id));
    const detectedIds = new Set(activeDetected.map(point => point.id));
    const keyframe = ensureKeyframe(frame);
    const previousById = new Map(keyframe.points.map(point => [point.id, point]));
    const preservedPoints = keyframe.points.filter(point =>
      point.hand === "Custom" || activeIds.includes(point.id) && !detectedIds.has(point.id));
    keyframe.points = preservedPoints.concat(activeDetected);
    keyframe.source = keyframe.points.some(point => point.source === "manual" || point.hand === "Custom") ? "manual" : "auto";
    const changedPoints = activeDetected.filter(point => {
      const previous = previousById.get(point.id);
      return !previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 1e-6;
    }).length;
    normalizeProjectPointData();
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
    return {
      detectedHands: hands.length,
      detectedPoints: detected.length,
      activePoints: activeDetected.length,
      changedPoints,
    };
  }

  function attachOverlayMedia(id, asset) {
    const layer = project.overlays.find(item => item.id === id) || project.overlays.find(item => item.name === asset.name);
    if (!layer) return false;
    Object.assign(layer, asset);
    layer.mediaDuration = asset.duration || layer.mediaDuration || layerMediaDuration(layer);
    rebuildLayers();
    rebuildTimeline();
    render();
    return true;
  }

  function setKeyframes(keyframes) {
    project.keyframes = keyframes.sort((a, b) => a.frame - b.frame);
    normalizeProjectPointData();
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
  }

  function normalizeFingerSelectionKeyframes(keyframes) {
    const normalized = (keyframes || [])
      .map(item => ({
        frame: clamp(Math.round(Number(item.frame) || 0), 0, frameCount()),
        activeIds: [...new Set((item.activeIds || []).filter(id => DEFAULT_ACTIVE_FINGER_IDS.includes(id)))],
      }))
      .sort((a, b) => a.frame - b.frame);
    if (!normalized.some(item => item.frame === 0)) {
      normalized.unshift({ frame: 0, activeIds: [...DEFAULT_ACTIVE_FINGER_IDS] });
    }
    return normalized.filter((item, index, all) => all.findIndex(other => other.frame === item.frame) === index);
  }

  function fingerSelectionKeyframeAt(frame) {
    let active = project.fingerSelectionKeyframes[0];
    for (const keyframe of project.fingerSelectionKeyframes) {
      if (keyframe.frame > frame) break;
      active = keyframe;
    }
    return active;
  }

  function activeFingerIdsAt(frame) {
    return new Set(fingerSelectionKeyframeAt(frame)?.activeIds || DEFAULT_ACTIVE_FINGER_IDS);
  }

  function fingerSelectionRangeAt(frame) {
    let index = 0;
    for (let i = 0; i < project.fingerSelectionKeyframes.length; i++) {
      if (project.fingerSelectionKeyframes[i].frame > frame) break;
      index = i;
    }
    return {
      startFrame: project.fingerSelectionKeyframes[index]?.frame ?? 0,
      endFrame: project.fingerSelectionKeyframes[index + 1]?.frame ?? frameCount() + 1,
    };
  }

  function normalizeManualCorrectionRanges(ranges) {
    const normalized = (ranges || []).map(range => ({
      startFrame: clamp(Math.round(Number(range.startFrame) || 0), 0, frameCount()),
      endFrame: clamp(Math.round(Number(range.endFrame) || 0), 0, frameCount()),
    })).map(range => ({
      startFrame: Math.min(range.startFrame, range.endFrame),
      endFrame: Math.max(range.startFrame, range.endFrame),
    })).sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);

    const merged = [];
    for (const range of normalized) {
      const previous = merged.at(-1);
      if (previous && range.startFrame <= previous.endFrame + 1) {
        previous.endFrame = Math.max(previous.endFrame, range.endFrame);
      } else {
        merged.push(range);
      }
    }
    return merged;
  }

  function manualCorrectionRangeAt(frame) {
    return project.manualCorrectionRanges.find(range => frame >= range.startFrame && frame <= range.endFrame) || null;
  }

  function setManualRangeStart() {
    pendingManualRangeStart = project.currentFrame;
    render();
    showToast(`已把第 ${project.currentFrame} 帧设为手动区间起点`);
  }

  function finishManualRange() {
    if (pendingManualRangeStart === null) return;
    project.manualCorrectionRanges = normalizeManualCorrectionRanges([
      ...project.manualCorrectionRanges,
      { startFrame: pendingManualRangeStart, endFrame: project.currentFrame },
    ]);
    pendingManualRangeStart = null;
    restoreManualPointsOutsideRanges();
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
    showToast("手动修正区间已写入时间轴");
  }

  function removeManualRangeAt(frame) {
    const range = manualCorrectionRangeAt(frame);
    if (!range) return;
    project.manualCorrectionRanges = project.manualCorrectionRanges.filter(item => item !== range);
    restoreManualPointsOutsideRanges();
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
    showToast("已删除当前手动修正区间，恢复自动轨迹");
  }

  function pointPriority(point) {
    if (point.source === "manual") return 4;
    if (point.source === "manual-follow") return 3;
    if (point.source === "auto-filled") return 2;
    return 1;
  }

  function repairDuplicateFingerPoints(points) {
    const output = [];
    const byFinger = new Map();
    for (const point of points || []) {
      if (point.hand === "Custom" || !DEFAULT_ACTIVE_FINGER_IDS.includes(point.id)) {
        output.push(point);
        continue;
      }
      const fingerId = point.finger || point.id.split(":")[1];
      if (!byFinger.has(fingerId)) byFinger.set(fingerId, []);
      byFinger.get(fingerId).push(point);
    }

    for (const [fingerId, fingerPoints] of byFinger) {
      const hasDuplicateId = new Set(fingerPoints.map(point => point.id)).size !== fingerPoints.length;
      if (!hasDuplicateId) {
        output.push(...fingerPoints);
        continue;
      }

      const sorted = [...fingerPoints].sort((a, b) => a.x - b.x);
      const clusters = [];
      for (const point of sorted) {
        const cluster = clusters.at(-1);
        if (!cluster || Math.abs(point.x - cluster.at(-1).x) > .08) clusters.push([point]);
        else cluster.push(point);
      }
      const representatives = clusters.map(cluster => [...cluster].sort((a, b) =>
        pointPriority(b) - pointPriority(a) || (b.confidence || 0) - (a.confidence || 0))[0]);

      if (representatives.length === 1) {
        output.push(representatives[0]);
        continue;
      }
      const leftmost = representatives[0];
      const rightmost = representatives.at(-1);
      output.push(assignPointSide(leftmost, "Right", fingerId));
      output.push(assignPointSide(rightmost, "Left", fingerId));
    }

    const unique = new Map();
    for (const point of output) {
      const existing = unique.get(point.id);
      if (!existing || pointPriority(point) > pointPriority(existing)) unique.set(point.id, point);
    }
    return [...unique.values()];
  }

  function assignPointSide(point, side, fingerId) {
    const finger = FINGERS.find(item => item.id === fingerId);
    return {
      ...point,
      id: `${side.toLowerCase()}:${fingerId}`,
      hand: side,
      finger: fingerId,
      label: `${side === "Left" ? "左" : "右"}${finger?.label || fingerId}`,
    };
  }

  function normalizeProjectPointData() {
    for (const keyframe of project.keyframes) {
      const activeIds = activeFingerIdsAt(keyframe.frame);
      keyframe.points = repairDuplicateFingerPoints(keyframe.points)
        .filter(point => point.hand === "Custom" || activeIds.has(point.id));
    }
  }

  function setFingerSelectionAt(frame, activeIds) {
    const safeFrame = clamp(Math.round(frame), 0, frameCount());
    let keyframe = project.fingerSelectionKeyframes.find(item => item.frame === safeFrame);
    if (!keyframe) {
      keyframe = { frame: safeFrame, activeIds: [] };
      project.fingerSelectionKeyframes.push(keyframe);
    }
    keyframe.activeIds = DEFAULT_ACTIVE_FINGER_IDS.filter(id => activeIds.includes(id));
    project.fingerSelectionKeyframes.sort((a, b) => a.frame - b.frame);
    normalizeProjectPointData();
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
  }

  function removeFingerSelectionAt(frame) {
    const safeFrame = Math.round(frame);
    if (safeFrame === 0) return;
    const before = project.fingerSelectionKeyframes.length;
    project.fingerSelectionKeyframes = project.fingerSelectionKeyframes.filter(item => item.frame !== safeFrame);
    if (project.fingerSelectionKeyframes.length === before) return;
    normalizeProjectPointData();
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
    showToast("已删除当前选择切换，继续沿用上一段");
  }

  function nearestKeyframes(frame) {
    let before = null;
    let after = null;
    for (const keyframe of project.keyframes) {
      if (keyframe.frame <= frame) before = keyframe;
      if (keyframe.frame >= frame) { after = keyframe; break; }
    }
    return { before, after };
  }

  function pointsAt(frame) {
    const exact = project.keyframes.find(keyframe => keyframe.frame === frame);
    if (exact) return clone(exact.points);
    const { before, after } = nearestKeyframes(frame);
    if (!before && !after) return [];
    if (!before) return clone(after.points);
    if (!after) return clone(before.points);
    const t = (frame - before.frame) / Math.max(1, after.frame - before.frame);
    const aMap = new Map(before.points.map(point => [point.id, point]));
    const bMap = new Map(after.points.map(point => [point.id, point]));
    const visibleIds = t < .5 ? [...aMap.keys()] : [...bMap.keys()];
    return visibleIds.map(id => {
      const a = aMap.get(id);
      const b = bMap.get(id);
      if (a && b) return { ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, source: "interpolated" };
      return clone(a || b);
    });
  }

  function displayPointsAt(frame) {
    const activeIds = activeFingerIdsAt(frame);
    const points = repairDuplicateFingerPoints(pointsAt(frame))
      .filter(point => point.hand === "Custom" || activeIds.has(point.id));
    if (!project.autoFillMissingFingers) return points;
    const present = new Set(points.map(point => point.id));
    for (const id of activeIds) {
      if (present.has(id)) continue;
      const inferred = inferredFingerPointAt(id, frame);
      if (inferred) {
        points.push(inferred);
        present.add(id);
      }
    }
    return points;
  }

  function inferredFingerPointAt(id, frame) {
    const { startFrame, endFrame } = fingerSelectionRangeAt(frame);
    let before = null;
    let after = null;
    for (const keyframe of project.keyframes) {
      if (keyframe.frame < startFrame || keyframe.frame >= endFrame) continue;
      const point = keyframe.points.find(item => item.id === id);
      if (!point) continue;
      if (keyframe.frame <= frame) before = { frame: keyframe.frame, point };
      if (keyframe.frame >= frame) {
        after = { frame: keyframe.frame, point };
        break;
      }
    }
    if (!before && !after) return null;
    if (before && after && before.frame !== after.frame) {
      const t = (frame - before.frame) / (after.frame - before.frame);
      return {
        ...clone(before.point),
        x: before.point.x + (after.point.x - before.point.x) * t,
        y: before.point.y + (after.point.y - before.point.y) * t,
        source: "auto-filled",
        fillMode: "interpolated",
      };
    }
    const reference = before || after;
    return {
      ...clone(reference.point),
      source: "auto-filled",
      fillMode: before ? "held" : "backfilled",
    };
  }

  function ensureKeyframe(frame) {
    let keyframe = project.keyframes.find(item => item.frame === frame);
    if (keyframe) return keyframe;
    keyframe = { frame, time: frame / project.fps, points: pointsAt(frame), source: "manual" };
    project.keyframes.push(keyframe);
    project.keyframes.sort((a, b) => a.frame - b.frame);
    rebuildTimeline();
    return keyframe;
  }

  function normalizeManualCorrectionThreshold(value) {
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, .005, .25) : .04;
  }

  function normalizeTrackingSmoothingThreshold(value) {
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, .005, .08) : .02;
  }

  function applyTrackingSmoothing() {
    return smoothTrackingKeyframes(project.keyframes, {
      enabled: project.trackingSmoothingEnabled,
      threshold: normalizeTrackingSmoothingThreshold(project.trackingSmoothingThreshold),
      maxGap: Math.max(1, Math.ceil(project.fps / 5)),
    });
  }

  function restoreManualFollowRawPoints() {
    for (const keyframe of project.keyframes) {
      keyframe.points = keyframe.points.filter(point => {
        if (point.source !== "manual-follow" && point.source !== "manual-offset") return true;
        if (point.generatedByManualFollow) return false;
        if (Number.isFinite(point.rawX)) point.x = point.rawX;
        if (Number.isFinite(point.rawY)) point.y = point.rawY;
        point.source = point.rawSource || "auto";
        delete point.rawX;
        delete point.rawY;
        delete point.rawSource;
        delete point.generatedByManualFollow;
        return true;
      });
    }
  }

  function estimateRawPointAt(id, frame, startFrame, endFrame) {
    let before = null;
    let after = null;
    for (const keyframe of project.keyframes) {
      if (keyframe.frame < startFrame || keyframe.frame >= endFrame) continue;
      const point = keyframe.points.find(item => item.id === id && item.source !== "manual");
      if (!point) continue;
      if (keyframe.frame < frame) before = { frame: keyframe.frame, point };
      if (keyframe.frame > frame) {
        after = { frame: keyframe.frame, point };
        break;
      }
    }
    if (before && after) {
      const t = (frame - before.frame) / Math.max(1, after.frame - before.frame);
      return {
        x: before.point.x + (after.point.x - before.point.x) * t,
        y: before.point.y + (after.point.y - before.point.y) * t,
      };
    }
    return before?.point || after?.point || null;
  }

  function restoreManualPointsOutsideRanges() {
    restoreManualFollowRawPoints();
    for (const keyframe of project.keyframes) {
      if (manualCorrectionRangeAt(keyframe.frame)) continue;
      const { startFrame, endFrame } = fingerSelectionRangeAt(keyframe.frame);
      for (const point of keyframe.points) {
        if (point.source !== "manual" || !DEFAULT_ACTIVE_FINGER_IDS.includes(point.id)) continue;
        const estimated = estimateRawPointAt(point.id, keyframe.frame, startFrame, endFrame);
        const baseX = Number.isFinite(point.manualBaseX) ? point.manualBaseX : estimated?.x;
        const baseY = Number.isFinite(point.manualBaseY) ? point.manualBaseY : estimated?.y;
        if (!Number.isFinite(baseX) || !Number.isFinite(baseY)) continue;
        point.x = baseX;
        point.y = baseY;
        point.source = point.manualBaseSource || "auto";
        delete point.manualBaseX;
        delete point.manualBaseY;
        delete point.manualBaseSource;
      }
    }
  }

  function rebuildManualFollowTracks() {
    restoreManualFollowRawPoints();
    applyTrackingSmoothing();
    if (!project.manualCorrectionFollow) return;
    const thresholdPx = normalizeManualCorrectionThreshold(project.manualCorrectionThreshold)
      * Math.hypot(project.width, project.height);
    const anchors = project.keyframes.flatMap(keyframe => keyframe.points
      .filter(point => point.source === "manual" && DEFAULT_ACTIVE_FINGER_IDS.includes(point.id))
      .map(point => ({ frame: keyframe.frame, id: point.id })))
      .sort((a, b) => a.frame - b.frame);

    for (const anchor of anchors) {
      if (!activeFingerIdsAt(anchor.frame).has(anchor.id)) continue;
      const correctionRange = manualCorrectionRangeAt(anchor.frame);
      if (!correctionRange) continue;
      const anchorKeyframe = project.keyframes.find(keyframe => keyframe.frame === anchor.frame);
      let accepted = anchorKeyframe?.points.find(point => point.id === anchor.id);
      if (!accepted) continue;
      const selectionRange = fingerSelectionRangeAt(anchor.frame);
      const endFrame = Math.min(selectionRange.endFrame, correctionRange.endFrame + 1);

      for (const keyframe of project.keyframes) {
        if (keyframe.frame <= anchor.frame) continue;
        if (keyframe.frame >= endFrame || !activeFingerIdsAt(keyframe.frame).has(anchor.id)) break;
        let point = keyframe.points.find(item => item.id === anchor.id);
        if (point?.source === "manual") break;
        const rawX = point?.x;
        const rawY = point?.y;
        const isMissing = !point;
        const distancePx = isMissing ? Infinity : Math.hypot(
          (rawX - accepted.x) * project.width,
          (rawY - accepted.y) * project.height,
        );

        if (isMissing || distancePx > thresholdPx) {
          if (!point) {
            point = {
              ...clone(accepted),
              source: "manual-follow",
              generatedByManualFollow: true,
            };
            keyframe.points.push(point);
          } else {
            point.rawX = rawX;
            point.rawY = rawY;
            point.rawSource = point.source;
            point.source = "manual-follow";
          }
          point.x = accepted.x;
          point.y = accepted.y;
        }
        accepted = point;
      }
    }
  }

  function updatePoint(id, x, y) {
    if (DEFAULT_ACTIVE_FINGER_IDS.includes(id) && !manualCorrectionRangeAt(project.currentFrame)) return;
    const keyframe = ensureKeyframe(project.currentFrame);
    let point = keyframe.points.find(item => item.id === id);
    if (!point) {
      const seed = displayPointsAt(project.currentFrame).find(item => item.id === id);
      if (!seed) return;
      point = { ...seed };
      delete point.fillMode;
      keyframe.points.push(point);
    }
    if (point.source !== "manual" && DEFAULT_ACTIVE_FINGER_IDS.includes(point.id)) {
      point.manualBaseX = Number.isFinite(point.rawX) ? point.rawX : point.x;
      point.manualBaseY = Number.isFinite(point.rawY) ? point.rawY : point.y;
      point.manualBaseSource = point.rawSource || point.source || "auto";
    }
    point.x = clamp(x, 0, 1);
    point.y = clamp(y, 0, 1);
    point.source = "manual";
    delete point.rawX;
    delete point.rawY;
    delete point.rawSource;
    delete point.generatedByManualFollow;
    keyframe.source = "manual";
    render();
  }

  function addPoint() {
    const keyframe = ensureKeyframe(project.currentFrame);
    const id = `custom:${project.customPointIndex++}`;
    keyframe.points.push({ id, label: `手动点 ${project.customPointIndex - 1}`, finger: "custom", hand: "Custom", x: .5, y: .5, confidence: 1, color: "#ffffff", source: "manual" });
    render();
  }

  function addFingerPoint(id) {
    if (!manualCorrectionRangeAt(project.currentFrame)) {
      showToast("请先在时间轴设置手动修正区间");
      return;
    }
    const keyframe = ensureKeyframe(project.currentFrame);
    if (keyframe.points.some(point => point.id === id)) return;
    const [handId, fingerId] = id.split(":");
    const hand = HANDS.find(item => item.id === handId);
    const finger = FINGERS.find(item => item.id === fingerId);
    const sameHandPoints = displayPointsAt(project.currentFrame).filter(point => point.hand?.toLowerCase() === handId);
    const center = sameHandPoints.length
      ? sameHandPoints.reduce((sum, point) => ({ x: sum.x + point.x / sameHandPoints.length, y: sum.y + point.y / sameHandPoints.length }), { x: 0, y: 0 })
      : { x: .5, y: .5 };
    keyframe.points.push({
      id,
      hand: handId === "left" ? "Left" : "Right",
      finger: fingerId,
      label: `${hand?.label || handId}${finger?.label || fingerId}`,
      x: clamp(center.x, 0, 1),
      y: clamp(center.y, 0, 1),
      confidence: 1,
      color: finger?.color || "#fff",
      source: "manual",
    });
    project.autoFillMissingFingers = true;
    keyframe.source = "manual";
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
    showToast(`已补上${hand?.label || ""}${finger?.label || "手指"}，请拖到准确位置`);
  }

  function removePoint(id) {
    const keyframe = ensureKeyframe(project.currentFrame);
    keyframe.points = keyframe.points.filter(point => point.id !== id);
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
  }

  function clipLengthFrames(layer) {
    return Math.max(1, Math.round(layer.endFrame) - Math.round(layer.startFrame) + 1);
  }

  function layerMediaDuration(layer) {
    if (Number.isFinite(layer.mediaDuration)) return layer.mediaDuration;
    if (layer.kind === "video" && Number.isFinite(layer.element?.duration)) return layer.element.duration;
    return layer.kind === "image" ? 3 : project.duration;
  }

  function normalizeOverlayClips({ repack = false } = {}) {
    let cursor = 0;
    for (const layer of project.overlays) {
      layer.enabled = layer.enabled !== false;
      layer.opacity = Number.isFinite(Number(layer.opacity)) ? clamp(Number(layer.opacity), 0, 1) : 1;
      layer.maskMode = layer.maskMode === "outside" ? "outside" : "inside";
      layer.effect = normalizeOverlayEffect(layer.effect);
      layer.effectIntensity = Number.isFinite(Number(layer.effectIntensity))
        ? clamp(Number(layer.effectIntensity), .2, 1)
        : .75;
      layer.mediaDuration = layerMediaDuration(layer);
      layer.sourceStartTime = clamp(Number(layer.sourceStartTime) || 0, 0, Math.max(layer.mediaDuration - .001, 0));
      const defaultLength = Math.max(1, Math.min(
        Math.round(layer.mediaDuration * project.fps) || project.fps * 3,
        frameCount() + 1,
      ));
      const savedLength = Number.isFinite(Number(layer.startFrame)) && Number.isFinite(Number(layer.endFrame))
        ? Math.max(1, Math.round(layer.endFrame) - Math.round(layer.startFrame) + 1)
        : defaultLength;
      if (repack) {
        layer.startFrame = cursor;
        layer.endFrame = Math.min(frameCount(), cursor + defaultLength - 1);
        cursor = layer.endFrame + 1;
      } else {
        layer.startFrame = clamp(Math.round(Number(layer.startFrame) || 0), 0, frameCount());
        layer.endFrame = clamp(layer.startFrame + savedLength - 1, layer.startFrame, frameCount());
      }
    }
  }

  function activeOverlayAt(frame) {
    return project.overlays.filter(layer =>
      layer.enabled && frame >= layer.startFrame && frame <= layer.endFrame).at(-1) || null;
  }

  function detectionSourceAt(frame = project.currentFrame) {
    const safeFrame = clamp(Math.round(frame), 0, frameCount());
    const layer = activeOverlayAt(safeFrame);
    if (layer?.element) {
      return {
        element: layer.element,
        sourceType: "overlay",
        name: layer.name,
        kind: layer.kind,
        maskMode: layer.maskMode,
        time: layer.kind === "video"
          ? clamp(layer.sourceStartTime + (safeFrame - layer.startFrame) / project.fps, 0, Math.max(layerMediaDuration(layer) - .002, 0))
          : null,
      };
    }
    return {
      element: video,
      sourceType: "original",
      name: project.video?.name || "原视频",
      kind: "video",
      maskMode: null,
      time: Math.min(safeFrame / project.fps, Math.max((video?.duration || project.duration) - .002, 0)),
    };
  }

  function selectedOverlay() {
    return project.overlays.find(layer => layer.id === selectedOverlayId) || null;
  }

  function selectOverlay(id, { jump = false } = {}) {
    const layer = project.overlays.find(item => item.id === id);
    if (!layer) return;
    selectedOverlayId = id;
    if (jump) setFrame(layer.startFrame);
    rebuildLayers();
    rebuildTimeline();
    render();
  }

  function packOverlayClips() {
    let cursor = 0;
    for (const layer of project.overlays) {
      const length = clipLengthFrames(layer);
      layer.startFrame = clamp(cursor, 0, frameCount());
      layer.endFrame = clamp(layer.startFrame + length - 1, layer.startFrame, frameCount());
      cursor = layer.endFrame + 1;
    }
  }

  function moveOverlay(id, direction) {
    const index = project.overlays.findIndex(layer => layer.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= project.overlays.length) return;
    [project.overlays[index], project.overlays[target]] = [project.overlays[target], project.overlays[index]];
    packOverlayClips();
    rebuildLayers();
    rebuildTimeline();
    setFrame(selectedOverlay()?.startFrame || 0);
    showToast(direction < 0 ? "片段已前移" : "片段已后移");
  }

  function reorderOverlayBefore(sourceId, targetId) {
    if (!sourceId || sourceId === targetId) return;
    const sourceIndex = project.overlays.findIndex(layer => layer.id === sourceId);
    let targetIndex = project.overlays.findIndex(layer => layer.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = project.overlays.splice(sourceIndex, 1);
    if (sourceIndex < targetIndex) targetIndex -= 1;
    project.overlays.splice(targetIndex, 0, source);
    packOverlayClips();
    rebuildLayers();
    rebuildTimeline();
    render();
    showToast("已按时间轴拖拽顺序重新排列");
  }

  function splitCandidateAt(frame = project.currentFrame) {
    const selected = selectedOverlay();
    if (selected && frame >= selected.startFrame && frame <= selected.endFrame) return selected;
    return activeOverlayAt(frame);
  }

  function canSplitOverlayAt(frame = project.currentFrame) {
    const layer = splitCandidateAt(frame);
    return Boolean(layer && frame > layer.startFrame && frame <= layer.endFrame);
  }

  function splitSelectedOverlay(frame = project.currentFrame) {
    const splitFrame = clamp(Math.round(frame), 0, frameCount());
    const layer = splitCandidateAt(splitFrame);
    if (!layer || splitFrame <= layer.startFrame || splitFrame > layer.endFrame) {
      showToast("请把播放头放在选中片段内部再切开");
      return;
    }
    const oldEnd = layer.endFrame;
    layer.endFrame = splitFrame - 1;
    const right = {
      ...layer,
      id: `layer-${Date.now()}-${project.overlays.length}`,
      name: `${layer.name}（切分）`,
      startFrame: splitFrame,
      endFrame: oldEnd,
      sourceStartTime: layer.sourceStartTime + (splitFrame - layer.startFrame) / project.fps,
    };
    const index = project.overlays.indexOf(layer);
    project.overlays.splice(index + 1, 0, right);
    selectedOverlayId = right.id;
    rebuildLayers();
    rebuildTimeline();
    render();
    showToast(`已在第 ${splitFrame} 帧分割；左右片段仍共用同一个素材文件`);
  }

  function fitSelectedOverlayToSource() {
    const layer = selectedOverlay();
    if (!layer) return;
    layer.sourceStartTime = 0;
    const fullLength = Math.max(1, Math.round(layerMediaDuration(layer) * project.fps));
    layer.endFrame = Math.min(frameCount(), layer.startFrame + fullLength - 1);
    rebuildTimeline();
    setFrame(project.currentFrame);
    showToast(`已恢复源素材完整长度：${layerMediaDuration(layer).toFixed(2)} 秒`);
  }

  function updateSelectedOverlay(field, value) {
    const layer = selectedOverlay();
    if (!layer) return;
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    if (field === "startFrame") {
      const length = clipLengthFrames(layer);
      layer.startFrame = clamp(Math.round(number), 0, frameCount());
      layer.endFrame = clamp(layer.startFrame + length - 1, layer.startFrame, frameCount());
    } else if (field === "endFrame") {
      const maxBySource = layer.kind === "video"
        ? layer.startFrame + Math.max(1, Math.floor((layerMediaDuration(layer) - layer.sourceStartTime) * project.fps)) - 1
        : frameCount();
      layer.endFrame = clamp(Math.round(number), layer.startFrame, Math.min(frameCount(), maxBySource));
    } else if (field === "sourceStartTime") {
      layer.sourceStartTime = clamp(number, 0, Math.max(layerMediaDuration(layer) - 1 / project.fps, 0));
      const maxEnd = layer.startFrame + Math.max(1, Math.floor((layerMediaDuration(layer) - layer.sourceStartTime) * project.fps)) - 1;
      layer.endFrame = Math.min(layer.endFrame, maxEnd, frameCount());
    }
    rebuildTimeline();
    setFrame(project.currentFrame);
  }

  function updateSelectedOverlayOption(field, value) {
    const layer = selectedOverlay();
    if (!layer) return;
    if (field === "maskMode") layer.maskMode = value === "outside" ? "outside" : "inside";
    if (field === "effect") layer.effect = normalizeOverlayEffect(value);
    if (field === "effectIntensity") layer.effectIntensity = clamp(Number(value) || .75, .2, 1);
    feedbackOverlayId = null;
    feedbackFrame = -1;
    rebuildLayers();
    rebuildTimeline();
    render();
  }

  function addOverlay(asset) {
    const pending = project.overlays.find(layer => !layer.element && layer.name === asset.name && layer.kind === asset.kind);
    if (pending) {
      Object.assign(pending, {
        element: asset.element,
        url: asset.url,
        file: asset.file,
        size: asset.size,
        type: asset.type,
        mediaDuration: asset.kind === "video" && Number.isFinite(asset.duration) ? asset.duration : 3,
      });
      selectedOverlayId = pending.id;
      rebuildLayers();
      rebuildTimeline();
      setFrame(pending.startFrame);
      showToast(`已重新关联 ${asset.name}`);
      return;
    }
    const lastEnd = project.overlays.reduce((max, layer) => Math.max(max, layer.endFrame), -1);
    const startFrame = lastEnd < frameCount() ? lastEnd + 1 : project.currentFrame;
    const mediaDuration = asset.kind === "video" && Number.isFinite(asset.duration) ? asset.duration : 3;
    const fullLength = Math.max(1, Math.round(mediaDuration * project.fps));
    const length = Math.max(1, Math.min(fullLength, frameCount() - startFrame + 1));
    const layer = {
      id: `layer-${Date.now()}-${project.overlays.length}`,
      name: asset.name,
      kind: asset.kind,
      element: asset.element,
      url: asset.url,
      file: asset.file,
      mediaDuration,
      sourceStartTime: 0,
      opacity: 1,
      enabled: true,
      maskMode: "inside",
      effect: "none",
      effectIntensity: .75,
      startFrame,
      endFrame: Math.min(frameCount(), startFrame + length - 1),
    };
    project.overlays.push(layer);
    selectedOverlayId = layer.id;
    rebuildLayers();
    rebuildTimeline();
    setFrame(layer.startFrame);
    showToast(length < fullLength
      ? `已加入 ${asset.name}；受主视频结尾限制，当前显示 ${(length / project.fps).toFixed(2)} 秒`
      : `已按源素材完整长度加入 ${asset.name}（${mediaDuration.toFixed(2)} 秒）`);
  }

  function removeOverlay(id) {
    project.overlays = project.overlays.filter(item => item.id !== id);
    if (selectedOverlayId === id) selectedOverlayId = project.overlays[0]?.id || null;
    rebuildLayers();
    rebuildTimeline();
    render();
  }

  function setFrame(frame, { syncMedia = true } = {}) {
    project.currentFrame = clamp(Math.round(frame), 0, frameCount());
    const time = currentTime();
    const sourceTime = time === 0 ? .001 : time;
    if (syncMedia && video && project.video && Math.abs(video.currentTime - sourceTime) > .0005) video.currentTime = Math.min(sourceTime, project.duration - .001);
    const activeLayer = activeOverlayAt(project.currentFrame);
    const mediaPlaying = Boolean(video && !video.paused);
    const activeChanged = (activeLayer?.id || null) !== lastActiveOverlayId;
    for (const layer of project.overlays) {
      if (layer.kind !== "video" || !layer.element) continue;
      if (layer !== activeLayer) {
        if (layer.element !== activeLayer?.element) layer.element.pause?.();
        continue;
      }
      const mediaDuration = layerMediaDuration(layer);
      const clipTime = layer.sourceStartTime + (project.currentFrame - layer.startFrame) / project.fps;
      const targetTime = clamp(clipTime, 0, Math.max(mediaDuration - .001, 0));
      const drift = Math.abs(layer.element.currentTime - targetTime);
      const seekThreshold = mediaPlaying && !activeChanged ? .25 : .015;
      if (drift > seekThreshold && !layer.element.seeking) layer.element.currentTime = targetTime;
      if (mediaPlaying && layer.element.paused) layer.element.play().catch(() => {});
    }

    const upcomingLayer = project.overlays
      .filter(layer => layer.enabled && layer.kind === "video" && layer.element
        && layer.startFrame > project.currentFrame
        && layer.startFrame - project.currentFrame <= Math.max(3, Math.round(project.fps / 2)))
      .sort((a, b) => a.startFrame - b.startFrame)[0];
    if (upcomingLayer && upcomingLayer.element !== activeLayer?.element) {
      upcomingLayer.element.pause?.();
      const preloadTime = clamp(upcomingLayer.sourceStartTime, 0, Math.max(layerMediaDuration(upcomingLayer) - .001, 0));
      if (Math.abs(upcomingLayer.element.currentTime - preloadTime) > .015 && !upcomingLayer.element.seeking) {
        upcomingLayer.element.currentTime = preloadTime;
      }
    }
    lastActiveOverlayId = activeLayer?.id || null;
    updateTransport();
    render();
  }

  function togglePlay() {
    if (!project.video?.element && mode === "desktop") return showToast("请先打开视频");
    const playing = video && !video.paused;
    if (playing || mode === "mini" && raf) pause();
    else play();
  }

  async function play() {
    if (mode === "desktop" && project.video?.element) {
      await video.play();
      const activeLayer = activeOverlayAt(project.currentFrame);
      if (activeLayer?.kind === "video" && activeLayer.element) activeLayer.element.play().catch(() => {});
    }
    lastRender = performance.now();
    raf = requestAnimationFrame(tick);
    updatePlayButton(true);
  }

  function pause() {
    if (video) video.pause();
    for (const layer of project.overlays) layer.element?.pause?.();
    cancelAnimationFrame(raf);
    raf = 0;
    updatePlayButton(false);
  }

  function updatePlayButton(playing) {
    const button = $("#playButton");
    button.classList.toggle("is-playing", playing);
    button.setAttribute("aria-label", playing ? "暂停" : "播放");
    button.title = playing ? "暂停" : "播放";
  }

  function tick(now) {
    if (mode === "desktop" && project.video?.element) {
      setFrame(frameAtTime(video.currentTime), { syncMedia: false });
      if (video.ended) return pause();
    } else {
      const elapsed = (now - lastRender) / 1000;
      lastRender = now;
      setFrame(project.currentFrame + elapsed * project.fps, { syncMedia: false });
      if (project.currentFrame >= frameCount()) return pause();
    }
    raf = requestAnimationFrame(tick);
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawBackground();
    const points = displayPointsAt(project.currentFrame);
    const activeIds = activeFingerIdsAt(project.currentFrame);
    const maskPoints = points.filter(point => point.hand === "Custom" || activeIds.has(point.id));
    const maskShapes = buildMaskShapes(maskPoints);
    if (maskShapes.length) drawOverlayLayers(maskShapes);
    drawMask(maskShapes, points, activeIds);
    rebuildPointList(points, activeIds);
    rebuildFingerSelectionControls(activeIds);
    rebuildManualRangeControls();
    rebuildTrackingSmoothingControls();
    rebuildClipEditor();
  }

  function drawBackground() {
    if (project.video?.element && video.readyState >= 2) {
      drawCover(video);
      return;
    }
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#18202a");
    gradient.addColorStop(1, "#07090d");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(255,255,255,.04)";
    ctx.lineWidth = 1;
    const grid = Math.max(42, canvas.width / 18);
    for (let x = 0; x < canvas.width; x += grid) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
    for (let y = 0; y < canvas.height; y += grid) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
  }

  function drawOverlayLayers(maskShapes) {
    const layer = activeOverlayAt(project.currentFrame);
    if (!layer?.element) return;

    ensureCanvasSize(overlayBaseCanvas, overlayBaseCtx);
    overlayBaseCtx.clearRect(0, 0, canvas.width, canvas.height);
    overlayBaseCtx.drawImage(canvas, 0, 0);

    ensureCanvasSize(overlayMaskCanvas, overlayMaskCtx);
    overlayMaskCtx.clearRect(0, 0, canvas.width, canvas.height);
    overlayMaskCtx.fillStyle = "#fff";
    for (const shape of maskShapes) {
      if (shape.length < 3) continue;
      pathForContext(overlayMaskCtx, shape);
      overlayMaskCtx.fill("nonzero");
    }

    drawOverlayMedia(layer);

    ctx.save();
    ctx.globalCompositeOperation = layer.maskMode === "outside" ? "destination-out" : "destination-in";
    ctx.drawImage(overlayMaskCanvas, 0, 0);
    ctx.globalCompositeOperation = "destination-over";
    ctx.drawImage(overlayBaseCanvas, 0, 0);
    ctx.restore();
  }

  function ensureCanvasSize(targetCanvas, targetCtx, width = canvas.width, height = canvas.height) {
    if (targetCanvas.width === width && targetCanvas.height === height) return;
    targetCanvas.width = width;
    targetCanvas.height = height;
    targetCtx.imageSmoothingEnabled = true;
  }

  function drawCover(media, targetCtx = ctx) {
    if (media instanceof HTMLVideoElement && media.readyState < 2) return false;
    if (media instanceof HTMLImageElement && (!media.complete || !media.naturalWidth)) return false;
    const targetCanvas = targetCtx.canvas;
    const sw = media.videoWidth || media.naturalWidth || media.width || targetCanvas.width;
    const sh = media.videoHeight || media.naturalHeight || media.height || targetCanvas.height;
    if (!sw || !sh) return false;
    const scale = Math.max(targetCanvas.width / sw, targetCanvas.height / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    try {
      targetCtx.drawImage(media, (targetCanvas.width - dw) / 2, (targetCanvas.height - dh) / 2, dw, dh);
      return true;
    } catch (error) {
      console.warn("Canvas media draw failed", error);
      return false;
    }
  }

  function drawOverlayMedia(layer) {
    ensureCanvasSize(overlaySourceCanvas, overlaySourceCtx);
    overlaySourceCtx.clearRect(0, 0, canvas.width, canvas.height);
    if (!drawCover(layer.element, overlaySourceCtx)) return;
    const source = overlaySourceCanvas;
    const effect = normalizeOverlayEffect(layer.effect);
    const intensity = clamp(Number(layer.effectIntensity) || .75, .2, 1);
    const durationFrames = Math.max(1, layer.endFrame - layer.startFrame + 1);
    const progress = clamp((project.currentFrame - layer.startFrame) / durationFrames, 0, 1);
    const time = currentTime();
    const opacity = clamp(Number(layer.opacity), 0, 1);

    ctx.save();
    if (effect === "none") {
      ctx.globalAlpha = opacity;
      ctx.drawImage(source, 0, 0);
    } else if (effect === "glitch") {
      ctx.globalAlpha = opacity;
      ctx.filter = `contrast(${110 + intensity * 45}%) saturate(${120 + intensity * 80}%)`;
      ctx.drawImage(source, 0, 0);
      ctx.filter = "none";
      const rows = 12;
      for (let i = 0; i < rows; i++) {
        const y = (i * 97 + project.currentFrame * 31) % canvas.height;
        const height = 5 + (i * 19) % Math.max(8, Math.round(canvas.height * .055));
        const shift = Math.sin(project.currentFrame * .73 + i * 2.1) * canvas.width * .035 * intensity;
        ctx.globalAlpha = opacity * (.16 + .18 * intensity);
        ctx.drawImage(source, 0, y, canvas.width, height, shift, y, canvas.width, height);
      }
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = opacity * .14 * intensity;
      ctx.fillStyle = project.currentFrame % 4 < 2 ? "#ff315d" : "#26d9ff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else if (effect === "neon-scan") {
      ctx.globalAlpha = opacity;
      ctx.filter = `contrast(${110 + intensity * 30}%) saturate(${120 + intensity * 70}%)`;
      ctx.drawImage(source, 0, 0);
      ctx.filter = "none";
      const y = progress * canvas.height;
      const beam = Math.max(24, canvas.height * .075);
      const gradient = ctx.createLinearGradient(0, y - beam, 0, y + beam);
      gradient.addColorStop(0, "rgba(38,217,255,0)");
      gradient.addColorStop(.48, `rgba(38,217,255,${.38 * intensity})`);
      gradient.addColorStop(.52, `rgba(255,49,93,${.32 * intensity})`);
      gradient.addColorStop(1, "rgba(255,49,93,0)");
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = opacity;
      ctx.fillStyle = gradient;
      ctx.fillRect(0, y - beam, canvas.width, beam * 2);
      ctx.strokeStyle = `rgba(255,255,255,${.7 * intensity})`;
      ctx.lineWidth = Math.max(1, canvas.height * .003);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    } else if (effect === "shockwave") {
      ctx.globalAlpha = opacity;
      ctx.drawImage(source, 0, 0);
      const radius = Math.hypot(canvas.width, canvas.height) * .55 * progress;
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = opacity * (1 - progress) * intensity;
      ctx.strokeStyle = "#ffd65c";
      ctx.lineWidth = Math.max(4, canvas.width * .014 * (1 - progress));
      ctx.beginPath(); ctx.arc(canvas.width / 2, canvas.height / 2, radius, 0, Math.PI * 2); ctx.stroke();
    } else if (effect === "dark-focus") {
      ctx.globalAlpha = opacity;
      ctx.filter = `contrast(${108 + intensity * 22}%)`;
      ctx.drawImage(source, 0, 0);
      ctx.filter = "none";
      const gradient = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, canvas.width * .12, canvas.width / 2, canvas.height / 2, canvas.width * .72);
      gradient.addColorStop(0, "rgba(0,0,0,0)");
      gradient.addColorStop(1, `rgba(0,0,0,${.78 * intensity})`);
      ctx.globalAlpha = opacity;
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else if (effect === "feedback") {
      ensureCanvasSize(overlayFeedbackCanvas, overlayFeedbackCtx);
      const consecutive = feedbackOverlayId === layer.id && Math.abs(project.currentFrame - feedbackFrame) <= 2;
      ctx.globalAlpha = opacity;
      ctx.drawImage(source, 0, 0);
      if (consecutive) {
        ctx.globalCompositeOperation = "screen";
        for (let i = 1; i <= 3; i++) {
          const scale = 1 + i * .018 * intensity;
          const width = canvas.width * scale;
          const height = canvas.height * scale;
          ctx.globalAlpha = opacity * intensity * (.18 / i);
          ctx.drawImage(overlayFeedbackCanvas, (canvas.width - width) / 2 + i * 4, (canvas.height - height) / 2 - i * 3, width, height);
        }
      }
      overlayFeedbackCtx.clearRect(0, 0, canvas.width, canvas.height);
      overlayFeedbackCtx.drawImage(source, 0, 0);
      feedbackOverlayId = layer.id;
      feedbackFrame = project.currentFrame;
    } else if (effect === "rgb-split") {
      const offset = Math.max(5, canvas.width * .025 * intensity);
      ctx.globalAlpha = opacity;
      ctx.filter = `contrast(${108 + intensity * 28}%) saturate(${125 + intensity * 80}%)`;
      ctx.drawImage(source, 0, 0);
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = opacity * .24 * intensity;
      ctx.filter = "sepia(1) saturate(12) hue-rotate(315deg)";
      ctx.drawImage(source, -offset, 0);
      ctx.filter = "sepia(1) saturate(10) hue-rotate(145deg)";
      ctx.drawImage(source, offset, 0);
      ctx.filter = "none";
    } else if (effect === "pixel-poster") {
      const block = Math.max(6, Math.round(8 + 28 * intensity));
      const width = Math.max(24, Math.round(canvas.width / block));
      const height = Math.max(24, Math.round(canvas.height / block));
      ensureCanvasSize(overlayAuxCanvas, overlayAuxCtx, width, height);
      overlayAuxCtx.clearRect(0, 0, width, height);
      overlayAuxCtx.filter = `contrast(${120 + intensity * 55}%) saturate(${125 + intensity * 75}%)`;
      overlayAuxCtx.drawImage(source, 0, 0, width, height);
      overlayAuxCtx.filter = "none";
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = opacity;
      ctx.drawImage(overlayAuxCanvas, 0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
    } else if (effect === "liquid-warp") {
      const slices = 46;
      const sliceHeight = Math.max(2, Math.ceil(canvas.height / slices));
      const amplitude = Math.max(8, canvas.width * .045 * intensity);
      ctx.globalAlpha = opacity;
      for (let i = 0; i < slices; i++) {
        const y = i * sliceHeight;
        const shift = Math.sin(i * .62 + time * 5.1) * amplitude + Math.cos(i * .21 - time * 3.4) * amplitude * .35;
        ctx.drawImage(source, 0, y, canvas.width, sliceHeight + 1, shift, y, canvas.width, sliceHeight + 1);
      }
    } else if (effect === "raster-slice") {
      ctx.globalAlpha = opacity;
      ctx.drawImage(source, 0, 0);
      const rows = 26;
      const amplitude = Math.max(8, canvas.width * .05 * intensity);
      for (let i = 0; i < rows; i++) {
        const y = (i * 43 + project.currentFrame * 5) % canvas.height;
        const height = 3 + (i * 13) % Math.max(8, Math.round(canvas.height * .04));
        const shift = Math.sin(time * 7 + i * 1.7) * amplitude;
        ctx.globalAlpha = opacity * (.25 + .5 * intensity);
        ctx.drawImage(source, 0, y, canvas.width, height, shift, y, canvas.width, height);
      }
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = opacity * .5 * intensity;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, progress * canvas.height, canvas.width, Math.max(2, canvas.height * .006));
    }
    ctx.restore();
  }

  function pathForContext(targetCtx, points) {
    targetCtx.beginPath();
    points.forEach((point, index) => {
      const x = point.x * canvas.width;
      const y = point.y * canvas.height;
      if (index === 0) targetCtx.moveTo(x, y); else targetCtx.lineTo(x, y);
    });
    targetCtx.closePath();
  }

  function pathFor(points) {
    pathForContext(ctx, points);
  }

  function drawMask(maskShapes, points, activeIds) {
    for (const shape of maskShapes) {
      if (shape.length < 2) continue;
      pathFor(shape);
      ctx.strokeStyle = "rgba(255,255,255,.92)";
      ctx.lineWidth = Math.max(2, canvas.width / 640);
      ctx.setLineDash(exportRenderMode ? [] : [10, 7]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (exportRenderMode) return;
    const radius = Math.max(7, canvas.width / 125);
    for (const point of points) {
      const active = point.hand === "Custom" || activeIds.has(point.id);
      const x = point.x * canvas.width;
      const y = point.y * canvas.height;
      ctx.save();
      ctx.globalAlpha = active ? 1 : .28;
      ctx.beginPath();
      ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,.65)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = point.color || COLORS[point.finger] || "#fff";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.font = `${Math.max(12, canvas.width / 85)}px sans-serif`;
      ctx.fillStyle = "#fff";
      ctx.fillText(point.label || point.id, x + radius + 7, y - radius - 3);
      ctx.restore();
    }
  }

  function setExportRenderMode(enabled) {
    exportRenderMode = Boolean(enabled);
    render();
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const drawnWidth = canvas.width * scale;
    const drawnHeight = canvas.height * scale;
    const offsetX = (rect.width - drawnWidth) / 2;
    const offsetY = (rect.height - drawnHeight) / 2;
    return { x: (event.clientX - rect.left - offsetX) / drawnWidth, y: (event.clientY - rect.top - offsetY) / drawnHeight, pixelScale: scale };
  }

  function pointUnderPointer(event) {
    const pointer = canvasPoint(event);
    let found = null;
    let best = 28 / Math.max(canvas.clientWidth, 1);
    for (const point of displayPointsAt(project.currentFrame)) {
      const distance = Math.hypot(pointer.x - point.x, pointer.y - point.y);
      if (distance < best) { found = point; best = distance; }
    }
    return found;
  }

  function updateProjectStatus() {
    $("#projectStatus").textContent = `${project.video?.name || project.title} · ${project.width}×${project.height} · ${project.fps} fps`;
  }

  function updateTransport() {
    $("#timecode").textContent = `${formatTime(currentTime(), project.fps)} / ${formatTime(project.duration, project.fps)}`;
    $("#frameReadout").textContent = `第 ${project.currentFrame} 帧`;
    const laneWidth = Math.max(600, frameCount() * Number($("#timelineZoom").value || 2));
    timeline.style.width = `${laneWidth + 112}px`;
    const x = 112 + project.currentFrame / frameCount() * laneWidth;
    $("#playhead").style.left = `${x}px`;
  }

  function positionOverlayClipElement(clip, layer) {
    clip.style.left = `${layer.startFrame / frameCount() * 100}%`;
    clip.style.width = `${clipLengthFrames(layer) / frameCount() * 100}%`;
    const mode = layer.maskMode === "outside" ? "反选蒙版" : "蒙版内";
    const effect = OVERLAY_EFFECT_LABELS[normalizeOverlayEffect(layer.effect)];
    clip.title = `${layer.name} · 第 ${layer.startFrame}–${layer.endFrame} 帧 · ${mode} · ${effect} · 拖动主体移动，拖动两边修剪`;
  }

  function beginOverlayPointerEdit(event, layer, clip, lane, mode) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectedOverlayId = layer.id;
    for (const item of lane.querySelectorAll(".mask-media-clip")) item.classList.toggle("selected", item === clip);
    rebuildLayers();
    rebuildClipEditor();
    overlayPointerEdit = {
      pointerId: event.pointerId,
      mode,
      layer,
      clip,
      lane,
      startX: event.clientX,
      initialStart: layer.startFrame,
      initialEnd: layer.endFrame,
      initialSourceStart: layer.sourceStartTime,
      moved: false,
    };
    clip.classList.add("editing");
    try { clip.setPointerCapture?.(event.pointerId); } catch {}
  }

  function updateOverlayPointerEdit(event) {
    const edit = overlayPointerEdit;
    if (!edit || event.pointerId !== edit.pointerId) return;
    event.preventDefault();
    const laneWidth = Math.max(edit.lane.getBoundingClientRect().width, 1);
    const deltaFrames = Math.round((event.clientX - edit.startX) / laneWidth * frameCount());
    if (deltaFrames === 0 && !edit.moved) return;
    edit.moved = true;
    const { layer } = edit;
    if (edit.mode === "move") {
      const length = edit.initialEnd - edit.initialStart + 1;
      const maxStart = Math.max(0, frameCount() - length + 1);
      layer.startFrame = clamp(edit.initialStart + deltaFrames, 0, maxStart);
      layer.endFrame = layer.startFrame + length - 1;
    } else if (edit.mode === "trim-start") {
      let startFrame = clamp(edit.initialStart + deltaFrames, 0, edit.initialEnd);
      if (layer.kind === "video") {
        const earliestStart = edit.initialStart - Math.floor(edit.initialSourceStart * project.fps);
        startFrame = Math.max(startFrame, earliestStart);
        layer.sourceStartTime = clamp(
          edit.initialSourceStart + (startFrame - edit.initialStart) / project.fps,
          0,
          Math.max(layerMediaDuration(layer) - 1 / project.fps, 0),
        );
      }
      layer.startFrame = startFrame;
    } else if (edit.mode === "trim-end") {
      const maxBySource = layer.kind === "video"
        ? layer.startFrame + Math.max(1, Math.floor((layerMediaDuration(layer) - layer.sourceStartTime) * project.fps)) - 1
        : frameCount();
      layer.endFrame = clamp(edit.initialEnd + deltaFrames, layer.startFrame, Math.min(frameCount(), maxBySource));
    }
    positionOverlayClipElement(edit.clip, layer);
    rebuildClipEditor();
  }

  function finishOverlayPointerEdit(event) {
    const edit = overlayPointerEdit;
    if (!edit || event.pointerId !== edit.pointerId) return;
    try { edit.clip.releasePointerCapture?.(event.pointerId); } catch {}
    edit.clip.classList.remove("editing");
    overlayPointerEdit = null;
    if (!edit.moved) return;
    rebuildTimeline();
    setFrame(project.currentFrame);
    const action = edit.mode === "move" ? "移动" : "修剪";
    showToast(`片段已${action}到第 ${edit.layer.startFrame}–${edit.layer.endFrame} 帧`);
  }

  function positionManualRangeSegment(segment, range) {
    segment.style.left = `${range.startFrame / frameCount() * 100}%`;
    segment.style.width = `${Math.max(1, range.endFrame - range.startFrame + 1) / frameCount() * 100}%`;
    segment.querySelector(".manual-range-label").textContent = `${range.startFrame}–${range.endFrame}`;
    segment.title = `手动修正区间：第 ${range.startFrame} 至 ${range.endFrame} 帧 · 拖动两边调整范围`;
  }

  function beginManualRangePointerEdit(event, range, segment, lane, mode) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const index = project.manualCorrectionRanges.indexOf(range);
    const previous = project.manualCorrectionRanges[index - 1];
    const next = project.manualCorrectionRanges[index + 1];
    manualRangePointerEdit = {
      pointerId: event.pointerId,
      mode,
      range,
      segment,
      lane,
      startX: event.clientX,
      initialStart: range.startFrame,
      initialEnd: range.endFrame,
      minStart: previous ? previous.endFrame + 1 : 0,
      maxEnd: next ? next.startFrame - 1 : frameCount(),
      moved: false,
    };
    segment.classList.add("editing");
    try { segment.setPointerCapture?.(event.pointerId); } catch {}
  }

  function updateManualRangePointerEdit(event) {
    const edit = manualRangePointerEdit;
    if (!edit || event.pointerId !== edit.pointerId) return;
    event.preventDefault();
    const laneWidth = Math.max(edit.lane.getBoundingClientRect().width, 1);
    const deltaFrames = Math.round((event.clientX - edit.startX) / laneWidth * frameCount());
    if (deltaFrames === 0 && !edit.moved) return;
    edit.moved = true;
    if (edit.mode === "trim-start") {
      edit.range.startFrame = clamp(edit.initialStart + deltaFrames, edit.minStart, edit.initialEnd);
    } else {
      edit.range.endFrame = clamp(edit.initialEnd + deltaFrames, edit.initialStart, edit.maxEnd);
    }
    positionManualRangeSegment(edit.segment, edit.range);
    rebuildManualRangeControls();
  }

  function finishManualRangePointerEdit(event) {
    const edit = manualRangePointerEdit;
    if (!edit || event.pointerId !== edit.pointerId) return;
    try { edit.segment.releasePointerCapture?.(event.pointerId); } catch {}
    edit.segment.classList.remove("editing");
    manualRangePointerEdit = null;
    if (!edit.moved) return;
    restoreManualPointsOutsideRanges();
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
    showToast(`手动修正区间已调整为第 ${edit.range.startFrame}–${edit.range.endFrame} 帧`);
  }

  function rebuildTimeline() {
    const lane = $("#keyframeLane");
    lane.textContent = "";
    for (const keyframe of project.keyframes) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "key-dot";
      dot.title = `第 ${keyframe.frame} 帧 · ${keyframe.points.length} 点`;
      dot.style.left = `${keyframe.frame / frameCount() * 100}%`;
      dot.addEventListener("click", () => setFrame(keyframe.frame));
      lane.append(dot);
    }
    const selectionLane = $("#fingerSelectionLane");
    selectionLane.textContent = "";
    project.fingerSelectionKeyframes.forEach((keyframe, index) => {
      const nextFrame = project.fingerSelectionKeyframes[index + 1]?.frame ?? frameCount();
      const segment = document.createElement("button");
      segment.type = "button";
      segment.className = "selection-segment";
      segment.style.left = `${keyframe.frame / frameCount() * 100}%`;
      segment.style.width = `${Math.max(0, nextFrame - keyframe.frame) / frameCount() * 100}%`;
      segment.textContent = `${keyframe.activeIds.length} 指`;
      segment.title = `第 ${keyframe.frame} 帧开始 · ${fingerSelectionLabel(keyframe.activeIds)}`;
      segment.addEventListener("click", () => setFrame(keyframe.frame));
      selectionLane.append(segment);
    });
    const correctionLane = $("#manualCorrectionLane");
    correctionLane.textContent = "";
    for (const range of project.manualCorrectionRanges) {
      const segment = document.createElement("button");
      segment.type = "button";
      segment.className = "manual-correction-segment";
      const startHandle = document.createElement("span");
      startHandle.className = "clip-trim-handle manual-range-handle start";
      startHandle.title = "拖动调整手动修正起始帧";
      const label = document.createElement("span");
      label.className = "manual-range-label";
      const endHandle = document.createElement("span");
      endHandle.className = "clip-trim-handle manual-range-handle end";
      endHandle.title = "拖动调整手动修正结束帧";
      segment.append(startHandle, label, endHandle);
      positionManualRangeSegment(segment, range);
      segment.addEventListener("click", event => {
        if (event.target === startHandle || event.target === endHandle) return;
        setFrame(range.startFrame);
      });
      segment.addEventListener("pointerdown", event => {
        if (event.target !== startHandle && event.target !== endHandle) return;
        beginManualRangePointerEdit(event, range, segment, correctionLane, event.target === startHandle ? "trim-start" : "trim-end");
      });
      segment.addEventListener("pointermove", updateManualRangePointerEdit);
      segment.addEventListener("pointerup", finishManualRangePointerEdit);
      segment.addEventListener("pointercancel", finishManualRangePointerEdit);
      correctionLane.append(segment);
    }
    const maskLane = $("#maskMediaLane");
    maskLane.textContent = "";
    for (const layer of project.overlays) {
      const clip = document.createElement("button");
      clip.type = "button";
      clip.className = "mask-media-clip";
      if (layer.id === selectedOverlayId) clip.classList.add("selected");
      if (!layer.enabled) clip.classList.add("disabled");
      positionOverlayClipElement(clip, layer);
      const startHandle = document.createElement("span");
      startHandle.className = "clip-trim-handle start";
      startHandle.title = "拖动修剪片段开头";
      const name = document.createElement("span");
      name.className = "clip-name";
      name.textContent = layer.name;
      const endHandle = document.createElement("span");
      endHandle.className = "clip-trim-handle end";
      endHandle.title = "拖动修剪片段结尾";
      clip.append(startHandle, name, endHandle);
      clip.addEventListener("click", () => selectOverlay(layer.id, { jump: false }));
      clip.addEventListener("pointerdown", event => {
        const mode = event.target === startHandle ? "trim-start" : event.target === endHandle ? "trim-end" : "move";
        beginOverlayPointerEdit(event, layer, clip, maskLane, mode);
      });
      clip.addEventListener("pointermove", updateOverlayPointerEdit);
      clip.addEventListener("pointerup", finishOverlayPointerEdit);
      clip.addEventListener("pointercancel", finishOverlayPointerEdit);
      maskLane.append(clip);
    }
    rebuildClipEditor();
    updateTransport();
  }

  function rebuildFingerSelectionControls(activeIds) {
    const exact = project.fingerSelectionKeyframes.find(item => item.frame === project.currentFrame);
    const source = fingerSelectionKeyframeAt(project.currentFrame);
    $("#fingerSelectionStatus").textContent = `当前沿用第 ${source?.frame ?? 0} 帧的选择，共 ${activeIds.size} 根；修改勾选会从第 ${project.currentFrame} 帧开始生效。`;
    $("#removeFingerSelectionKeyframe").disabled = !exact || project.currentFrame === 0;
    $("#autoFillMissingFingers").checked = project.autoFillMissingFingers;
    $("#manualCorrectionFollow").checked = project.manualCorrectionFollow;
    $("#manualCorrectionThreshold").value = String(project.manualCorrectionThreshold);
    $("#manualCorrectionThreshold").disabled = !project.manualCorrectionFollow;
    for (const input of $("#fingerSelectionGrid").querySelectorAll("input[data-finger-id]")) {
      input.checked = activeIds.has(input.dataset.fingerId);
    }
  }

  function rebuildManualRangeControls() {
    const range = manualCorrectionRangeAt(project.currentFrame);
    if (pendingManualRangeStart !== null) {
      $("#manualRangeStatus").textContent = `已选择第 ${pendingManualRangeStart} 帧为起点；移动播放头后设置终点。`;
    } else if (range) {
      $("#manualRangeStatus").textContent = `当前位于手动修正区间：第 ${range.startFrame}–${range.endFrame} 帧。`;
    } else {
      $("#manualRangeStatus").textContent = "当前帧使用自动轨迹；先设置起点和终点后才能拖动标准手指。";
    }
    $("#manualRangeEnd").disabled = pendingManualRangeStart === null;
    $("#removeManualRange").disabled = !range;
  }

  function rebuildTrackingSmoothingControls() {
    const enabled = $("#trackingSmoothingEnabled");
    const threshold = $("#trackingSmoothingThreshold");
    if (!enabled || !threshold) return;
    enabled.checked = project.trackingSmoothingEnabled;
    threshold.value = String(normalizeTrackingSmoothingThreshold(project.trackingSmoothingThreshold));
    threshold.disabled = !project.trackingSmoothingEnabled;
  }

  function rebuildPointList(points, activeIds) {
    const list = $("#pointList");
    const missingList = $("#missingFingerList");
    const viewport = $("#pointListViewport");
    const previousScrollTop = viewport.scrollTop;
    list.textContent = "";
    missingList.textContent = "";
    if (!points.length && !activeIds.size) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "本帧没有伸直的手指";
      list.append(empty);
      viewport.scrollTop = previousScrollTop;
      return;
    }
    for (const point of points) {
      const row = document.createElement("div");
      row.className = "point-row";
      row.dataset.pointId = point.id;
      const active = point.hand === "Custom" || activeIds.has(point.id);
      if (!active) row.classList.add("inactive");
      if (point.source === "auto-filled") row.classList.add("auto-filled");
      if (point.source === "manual-follow") row.classList.add("manual-follow");
      const dot = document.createElement("i");
      dot.className = "point-dot";
      dot.style.setProperty("--dot", point.color || COLORS[point.finger] || "#fff");
      const name = document.createElement("strong");
      name.textContent = point.label || point.id;
      const pos = document.createElement("small");
      pos.textContent = `${Math.round(point.x * project.width)}, ${Math.round(point.y * project.height)}`;
      const state = document.createElement("small");
      state.className = "point-state";
      state.textContent = !active
        ? "未参与"
        : point.source === "auto-filled"
          ? autoFillLabel(point.fillMode)
          : point.source === "manual-follow"
            ? "位置锁定"
            : point.source === "manual"
              ? "手动锚点"
              : "生效";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = point.source === "auto-filled" ? "固定" : "×";
      remove.title = point.source === "auto-filled" ? "把自动补齐位置写成当前帧手动关键帧" : "删除当前帧的点";
      remove.addEventListener("click", () => point.source === "auto-filled" ? addFingerPointFromSeed(point) : removePoint(point.id));
      row.append(dot, name, pos, state, remove);
      list.append(row);
    }
    const presentIds = new Set(points.map(point => point.id));
    for (const id of activeIds) {
      if (presentIds.has(id)) continue;
      const row = document.createElement("div");
      row.className = "missing-point-row";
      row.dataset.pointId = id;
      const name = document.createElement("strong");
      name.textContent = `${fingerSelectionLabel([id])}：本段没有可参考的位置`;
      const add = document.createElement("button");
      add.type = "button";
      add.textContent = "+ 补点";
      add.addEventListener("click", () => addFingerPoint(id));
      row.append(name, add);
      missingList.append(row);
    }
    viewport.scrollTop = previousScrollTop;
  }

  function addFingerPointFromSeed(seed) {
    if (!manualCorrectionRangeAt(project.currentFrame)) {
      showToast("请先在时间轴设置手动修正区间");
      return;
    }
    const keyframe = ensureKeyframe(project.currentFrame);
    if (!keyframe.points.some(point => point.id === seed.id)) {
      const point = {
        ...seed,
        source: "manual",
        manualBaseX: seed.x,
        manualBaseY: seed.y,
        manualBaseSource: seed.source || "auto",
      };
      delete point.fillMode;
      keyframe.points.push(point);
      keyframe.source = "manual";
    }
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
    showToast("已写入当前帧手动锚点");
  }

  function autoFillLabel(mode) {
    if (mode === "interpolated") return "插值补齐";
    if (mode === "backfilled") return "向前补齐";
    return "保持补齐";
  }

  function rebuildClipEditor() {
    const layer = selectedOverlay();
    $("#selectedClipName").textContent = layer ? layer.name : "尚未选择片段";
    const fields = ["#clipStartFrame", "#clipEndFrame", "#clipSourceStart", "#clipMaskMode", "#clipEffect", "#clipEffectIntensity"];
    for (const selector of fields) $(selector).disabled = !layer;
    if (layer) {
      $("#clipStartFrame").value = String(layer.startFrame);
      $("#clipEndFrame").value = String(layer.endFrame);
      $("#clipSourceStart").value = String(Math.round(layer.sourceStartTime * 1000) / 1000);
      $("#clipMaskMode").value = layer.maskMode === "outside" ? "outside" : "inside";
      $("#clipEffect").value = normalizeOverlayEffect(layer.effect);
      $("#clipEffectIntensity").value = String(layer.effectIntensity ?? .75);
      $("#clipEffectIntensity").disabled = normalizeOverlayEffect(layer.effect) === "none";
      const mode = layer.maskMode === "outside" ? "反选蒙版" : "蒙版内";
      const effect = OVERLAY_EFFECT_LABELS[normalizeOverlayEffect(layer.effect)];
      $("#selectedClipMeta").textContent = `${layer.kind === "video" ? "视频" : "图片"} · ${clipLengthFrames(layer)} 帧 · 源 ${layerMediaDuration(layer).toFixed(2)} 秒 · ${mode} · ${effect}`;
    } else {
      $("#clipStartFrame").value = "";
      $("#clipEndFrame").value = "";
      $("#clipSourceStart").value = "";
      $("#clipMaskMode").value = "inside";
      $("#clipEffect").value = "none";
      $("#clipEffectIntensity").value = ".75";
      $("#selectedClipMeta").textContent = "拖动 clip 主体移动；拖动左右边缘修剪";
    }
    const index = layer ? project.overlays.indexOf(layer) : -1;
    $("#clipMoveEarlier").disabled = index <= 0;
    $("#clipMoveLater").disabled = index < 0 || index >= project.overlays.length - 1;
    const canSplit = canSplitOverlayAt(project.currentFrame);
    $("#clipCut").disabled = !canSplit;
    $("#splitClipButton").disabled = !canSplit;
    $("#clipFitSource").disabled = !layer;
    $("#clipDelete").disabled = !layer;
  }

  function rebuildLayers() {
    const list = $("#layerList");
    list.textContent = "";
    if (!project.overlays.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "尚未添加素材；蒙版区域暂时显示原视频";
      list.append(empty);
      return;
    }
    for (const layer of project.overlays) {
      const row = document.createElement("div");
      row.className = "layer-row";
      if (layer.id === selectedOverlayId) row.classList.add("selected");
      row.addEventListener("click", event => {
        if (event.target.matches("input,button")) return;
        selectOverlay(layer.id, { jump: false });
      });
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = layer.enabled;
      toggle.addEventListener("change", () => { layer.enabled = toggle.checked; rebuildTimeline(); render(); });
      const name = document.createElement("strong");
      name.textContent = layer.name;
      const mediaState = document.createElement("small");
      mediaState.textContent = layer.element
        ? [layer.maskMode === "outside" ? "反选" : "", normalizeOverlayEffect(layer.effect) !== "none" ? OVERLAY_EFFECT_LABELS[layer.effect] : ""].filter(Boolean).join(" · ")
        : "未关联";
      mediaState.title = layer.element ? "" : "工程 JSON 不包含媒体文件，请重新添加同名素材或使用“保存到本机”";
      const opacity = document.createElement("input");
      opacity.type = "range";
      opacity.min = "0";
      opacity.max = "1";
      opacity.step = ".05";
      opacity.value = String(layer.opacity);
      opacity.title = "透明度";
      opacity.addEventListener("input", () => { layer.opacity = Number(opacity.value); render(); });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "删除";
      remove.addEventListener("click", () => removeOverlay(layer.id));
      row.append(toggle, name, mediaState, opacity, remove);
      list.append(row);
    }
    rebuildClipEditor();
  }

  function loadDemo() {
    project.title = "五指蒙版演示";
    project.width = 1280;
    project.height = 720;
    project.duration = 6;
    project.keyframes = [];
    project.fingerSelectionKeyframes = [{ frame: 0, activeIds: [...DEFAULT_ACTIVE_FINGER_IDS] }];
    project.manualCorrectionRanges = [{ startFrame: 0, endFrame: frameCount() }];
    project.autoFillMissingFingers = false;
    project.manualCorrectionFollow = true;
    project.manualCorrectionThreshold = .04;
    project.trackingSmoothingEnabled = true;
    project.trackingSmoothingThreshold = .02;
    const fingers = ["thumb", "index", "middle", "ring", "pinky"];
    for (let frame = 0; frame <= frameCount(); frame += 15) {
      const t = frame / frameCount();
      const points = [];
      for (let handIndex = 0; handIndex < 2; handIndex++) {
        fingers.forEach((finger, i) => {
          const hidden = finger === "ring" && t > .45 && t < .62;
          if (hidden) return;
          const left = handIndex === 0;
          points.push({ id: `${left ? "left" : "right"}:${finger}`, hand: left ? "Left" : "Right", finger, label: `${left ? "左" : "右"}${FINGERS[i].label}`, x: (left ? .22 : .78) + (i - 2) * .035 + Math.sin(t * Math.PI * 2 + i) * .025, y: .57 - Math.abs(i - 2) * .06 + Math.cos(t * Math.PI * 2 + i) * .025, color: FINGERS[i].color, confidence: 1, source: "demo" });
        });
      }
      project.keyframes.push({ frame, time: frame / project.fps, points, source: "demo" });
    }
    canvas.width = project.width;
    canvas.height = project.height;
    fitCanvasToStage();
    emptyState.hidden = true;
    updateProjectStatus();
    rebuildTimeline();
    setFrame(0);
    showToast("已载入十指演示；中段无名指收起并自动隐藏");
  }

  canvas.addEventListener("pointerdown", event => {
    const point = pointUnderPointer(event);
    if (!point) return;
    if (DEFAULT_ACTIVE_FINGER_IDS.includes(point.id) && !manualCorrectionRangeAt(project.currentFrame)) {
      showToast("当前帧不在手动修正区间，请先设置区间");
      return;
    }
    draggingId = point.id;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (!draggingId) return;
    const pointer = canvasPoint(event);
    updatePoint(draggingId, pointer.x, pointer.y);
  });
  canvas.addEventListener("pointerup", event => {
    const changed = Boolean(draggingId);
    draggingId = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (changed) {
      rebuildManualFollowTracks();
      rebuildTimeline();
      render();
      showToast("已写入区间内手动锚点，并检查后续跳点");
    }
  });
  canvas.addEventListener("pointercancel", () => {
    const changed = Boolean(draggingId);
    draggingId = null;
    if (changed) {
      rebuildManualFollowTracks();
      rebuildTimeline();
      render();
    }
  });
  function buildFingerSelectionControls() {
    const grid = $("#fingerSelectionGrid");
    grid.textContent = "";
    for (const hand of HANDS) {
      const row = document.createElement("div");
      row.className = "finger-hand-row";
      const title = document.createElement("strong");
      title.textContent = hand.label;
      row.append(title);
      for (const finger of FINGERS) {
        const id = `${hand.id}:${finger.id}`;
        const label = document.createElement("label");
        label.className = "finger-toggle";
        label.title = `${hand.label}${finger.label}`;
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.fingerId = id;
        input.addEventListener("change", () => {
          const activeIds = [...grid.querySelectorAll("input[data-finger-id]:checked")].map(item => item.dataset.fingerId);
          setFingerSelectionAt(project.currentFrame, activeIds);
          showToast(`已从第 ${project.currentFrame} 帧更新生效手指`);
        });
        const name = document.createElement("span");
        name.textContent = finger.label.replace("指", "");
        label.append(input, name);
        row.append(label);
      }
      grid.append(row);
    }
  }

  function fingerSelectionLabel(activeIds) {
    if (!activeIds.length) return "不启用手指";
    return activeIds.map(id => {
      const [handId, fingerId] = id.split(":");
      const hand = HANDS.find(item => item.id === handId);
      const finger = FINGERS.find(item => item.id === fingerId);
      return `${hand?.label || handId}${finger?.label || fingerId}`;
    }).join("、");
  }

  buildFingerSelectionControls();
  $("#playButton").addEventListener("click", togglePlay);
  $("#prevFrame").addEventListener("click", () => setFrame(project.currentFrame - 1));
  $("#nextFrame").addEventListener("click", () => setFrame(project.currentFrame + 1));
  $("#addPointButton").addEventListener("click", addPoint);
  $("#removeFingerSelectionKeyframe").addEventListener("click", () => removeFingerSelectionAt(project.currentFrame));
  $("#manualRangeStart").addEventListener("click", setManualRangeStart);
  $("#manualRangeEnd").addEventListener("click", finishManualRange);
  $("#removeManualRange").addEventListener("click", () => removeManualRangeAt(project.currentFrame));
  $("#autoFillMissingFingers").addEventListener("change", event => {
    project.autoFillMissingFingers = event.target.checked;
    render();
  });
  $("#manualCorrectionFollow").addEventListener("change", event => {
    project.manualCorrectionFollow = event.target.checked;
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
    showToast(project.manualCorrectionFollow ? "已开启手动修正向后跟随" : "已恢复原始识别轨迹");
  });
  $("#manualCorrectionThreshold").addEventListener("change", event => {
    project.manualCorrectionThreshold = normalizeManualCorrectionThreshold(event.target.value);
    rebuildManualFollowTracks();
    rebuildTimeline();
    render();
    showToast(`跳点阈值已设为 ${Math.round(project.manualCorrectionThreshold * 100)}%`);
  });
  $("#trackingSmoothingEnabled")?.addEventListener("change", event => {
    project.trackingSmoothingEnabled = event.target.checked;
    rebuildManualFollowTracks();
    render();
    showToast(project.trackingSmoothingEnabled ? "已开启轻微抖动平滑" : "已恢复识别原始坐标");
  });
  $("#trackingSmoothingThreshold")?.addEventListener("change", event => {
    project.trackingSmoothingThreshold = normalizeTrackingSmoothingThreshold(event.target.value);
    rebuildManualFollowTracks();
    render();
    showToast(`平滑阈值已设为 ${Math.round(project.trackingSmoothingThreshold * 100)}%`);
  });
  $("#clipStartFrame").addEventListener("change", event => updateSelectedOverlay("startFrame", event.target.value));
  $("#clipEndFrame").addEventListener("change", event => updateSelectedOverlay("endFrame", event.target.value));
  $("#clipSourceStart").addEventListener("change", event => updateSelectedOverlay("sourceStartTime", event.target.value));
  $("#clipMaskMode").addEventListener("change", event => {
    updateSelectedOverlayOption("maskMode", event.target.value);
    showToast(event.target.value === "outside" ? "该片段已改为反选蒙版" : "该片段已恢复蒙版内显示");
  });
  $("#clipEffect").addEventListener("change", event => {
    updateSelectedOverlayOption("effect", event.target.value);
    showToast(`片段特效：${OVERLAY_EFFECT_LABELS[normalizeOverlayEffect(event.target.value)]}`);
  });
  $("#clipEffectIntensity").addEventListener("input", event => updateSelectedOverlayOption("effectIntensity", event.target.value));
  $("#clipMoveEarlier").addEventListener("click", () => selectedOverlay() && moveOverlay(selectedOverlayId, -1));
  $("#clipMoveLater").addEventListener("click", () => selectedOverlay() && moveOverlay(selectedOverlayId, 1));
  $("#clipCut").addEventListener("click", () => splitSelectedOverlay());
  $("#splitClipButton").addEventListener("click", () => splitSelectedOverlay());
  $("#clipFitSource").addEventListener("click", fitSelectedOverlayToSource);
  $("#clipDelete").addEventListener("click", () => selectedOverlay() && removeOverlay(selectedOverlayId));
  $("#timelineZoom").addEventListener("input", rebuildTimeline);
  scroller.addEventListener("pointerdown", event => {
    if (!event.target.classList.contains("track-lane")) return;
    const rect = event.target.getBoundingClientRect();
    setFrame((event.clientX - rect.left) / rect.width * frameCount());
  });
  window.addEventListener("keydown", event => {
    if (event.target.matches("input,select,textarea")) return;
    if (event.code === "Space") { event.preventDefault(); togglePlay(); }
    if (event.code === "ArrowLeft") setFrame(project.currentFrame - 1);
    if (event.code === "ArrowRight") setFrame(project.currentFrame + 1);
    if (event.key.toLowerCase() === "s" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      splitSelectedOverlay();
    }
    if (event.key.toLowerCase() === "b" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      splitSelectedOverlay();
    }
  });

  rebuildLayers();
  rebuildTimeline();
  render();

  return {
    project,
    video,
    canvas,
    loadTracking,
    loadDemo,
    setVideoElement,
    addOverlay,
    setFrame,
    setKeyframes,
    applyLandmarkTracking,
    applyDetectedHandsAtCurrentFrame,
    detectionSourceAt,
    attachOverlayMedia,
    serializeProject,
    render,
    setExportRenderMode,
    showToast,
    pause,
  };
}

function formatTime(seconds, fps = 30) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const frames = Math.floor((safe % 1) * fps);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}
