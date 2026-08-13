import { createEditor } from "./app.js?v=20260810-26";

const editor = createEditor({ mode: "desktop" });
const $ = selector => document.querySelector(selector);
let landmarker = null;
const LOCAL_DB_NAME = "manual-tracking-editor";
const LOCAL_DB_VERSION = 1;
const LOCAL_STORE_NAME = "projects";
const LOCAL_PROJECT_ID = "last-project";
editor.video.addEventListener("loadeddata", editor.render);
editor.video.addEventListener("seeked", editor.render);

$("#videoInput").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  await loadVideoFile(file);
  $("#analyzeStatus").textContent = "视频已就绪，可以开始识别";
});

$("#trackingInput").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    editor.loadTracking(JSON.parse(await file.text()));
  } catch (error) {
    editor.showToast(`轨迹导入失败：${error.message}`);
  }
});

$("#imageOverlayInput").addEventListener("change", event => addOverlayFiles(event.target.files, "image"));
$("#videoOverlayInput").addEventListener("change", event => addOverlayFiles(event.target.files, "video"));

$("#analyzeButton").addEventListener("click", () => analyzeVideo());
$("#reanalyzeButton").addEventListener("click", () => analyzeVideo({ preserveEdits: true, forceSelectedFingers: true }));
$("#detectCurrentFrameButton").addEventListener("click", detectCurrentFrame);
$("#exportProjectButton").addEventListener("click", () => {
  const json = JSON.stringify(editor.serializeProject(), null, 2);
  saveBlob(new Blob([json], { type: "application/json" }), `${safeName(editor.project.video?.name || "manual-tracking")}.mtrack.json`);
  editor.showToast("工程 JSON 已导出");
});
$("#exportVideoButton").addEventListener("click", exportPreview);
$("#saveBrowserProjectButton").addEventListener("click", saveBrowserProject);
$("#restoreBrowserProjectButton").addEventListener("click", restoreBrowserProject);
const initialRecordingFormat = preferredRecordingFormat();
$("#exportVideoButton").dataset.exportFormat = initialRecordingFormat?.extension || "none";
$("#exportVideoButton").textContent = initialRecordingFormat?.extension === "mp4" ? "导出 MP4" : "导出视频";
$("#exportVideoButton").title = initialRecordingFormat?.extension === "mp4"
  ? "导出带原视频声音的 MP4；隐藏指尖圆点并使用实线框"
  : "当前浏览器不支持 MP4 时自动导出 WebM";

async function loadVideoFile(file) {
  const url = URL.createObjectURL(file);
  const video = editor.video;
  video.src = url;
  await waitFor(video, "loadedmetadata");
  editor.setVideoElement(video, { name: file.name, size: file.size, type: file.type, file, url, element: video });
  setRecognitionButtonsEnabled(true);
  $("#exportVideoButton").disabled = false;
}

async function addOverlayFiles(files, kind) {
  for (const file of files || []) {
    editor.addOverlay(await createOverlayAsset(file, kind));
  }
}

async function createOverlayAsset(file, kind) {
  const url = URL.createObjectURL(file);
  const element = kind === "image" ? new Image() : document.createElement("video");
  if (kind === "video") {
    element.preload = "auto";
    element.muted = true;
    element.playsInline = true;
  }
  element.src = url;
  await waitFor(element, kind === "image" ? "load" : "loadeddata");
  element.addEventListener(kind === "image" ? "load" : "loadeddata", editor.render);
  if (kind === "video") element.addEventListener("seeked", editor.render);
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    kind,
    duration: kind === "video" ? element.duration : 3,
    file,
    url,
    element,
  };
}

async function ensureLandmarker() {
  if (landmarker) return landmarker;
  $("#analyzeStatus").textContent = "正在载入离线手部模型…";
  const { FilesetResolver, HandLandmarker } = await import("../vendor/vision_bundle.mjs");
  const vision = await FilesetResolver.forVisionTasks("../vendor/wasm");
  landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: "../vendor/hand_landmarker.task" },
    runningMode: "IMAGE",
    numHands: 2,
    minHandDetectionConfidence: .45,
    minHandPresenceConfidence: .45,
    minTrackingConfidence: .45,
  });
  return landmarker;
}

async function analyzeVideo({ preserveEdits = false, forceSelectedFingers = false } = {}) {
  const button = forceSelectedFingers ? $("#reanalyzeButton") : $("#analyzeButton");
  const progress = $("#analyzeProgress");
  const status = $("#analyzeStatus");
  const sampleFps = Number($("#sampleFps").value);
  const video = editor.video;
  if (!editor.project.video || !video.videoWidth) return;
  setRecognitionButtonsEnabled(false);
  editor.pause();
  const returnFrame = editor.project.currentFrame;

  try {
    const model = await ensureLandmarker();
    const surface = createDetectionSurface(video);
    const count = Math.ceil(video.duration * sampleFps);
    const frames = [];

    for (let index = 0; index < count; index++) {
      const time = Math.min(video.duration - .002, index / sampleFps);
      await seek(video, time);
      const candidates = detectHandsFromCurrentFrame(model, video, surface);
      frames.push({ time, hands: candidates });
      progress.value = (index + 1) / count;
      status.textContent = `正在识别 ${index + 1}/${count} · ${(time).toFixed(1)} 秒`;
      if (index % 5 === 0) await nextPaint();
    }

    const tracking = {
      schema: "gesture-ribbon.landmarks.v2",
      source: { name: editor.project.video.name, width: video.videoWidth, height: video.videoHeight, duration: video.duration, sampleFps },
      frames,
    };
    if (preserveEdits) editor.applyLandmarkTracking(tracking, { preserveEdits: true, forceSelectedFingers });
    else editor.loadTracking(tracking);
    editor.setFrame(preserveEdits ? returnFrame : 0);
    status.textContent = preserveEdits
      ? `重识别完成：${frames.length} 个采样帧，已保留手动修正和生效区间`
      : `识别完成：${frames.length} 个采样帧，可逐帧修正`;
  } catch (error) {
    status.textContent = `识别失败：${error.message}`;
    editor.showToast("识别失败，请看右侧错误信息");
  } finally {
    setRecognitionButtonsEnabled(true);
  }
}

async function detectCurrentFrame() {
  const status = $("#analyzeStatus");
  if (!editor.project.video) return;
  setRecognitionButtonsEnabled(false);
  editor.pause();
  try {
    const model = await ensureLandmarker();
    const source = editor.detectionSourceAt(editor.project.currentFrame);
    const media = source.element;
    const { width, height } = mediaDimensions(media);
    if (!media || !width || !height) throw new Error("当前最上层媒体尚未准备好");
    if (source.kind === "video") await seek(media, source.time);
    const detectedHands = detectHandsFromCurrentFrame(model, media, createDetectionSurface(media));
    const hands = mapHandsToProject(detectedHands, media);
    const result = editor.applyDetectedHandsAtCurrentFrame(hands);
    const sourceLabel = source.sourceType === "overlay" ? `上层 Clip「${shortName(source.name)}」` : "原视频";
    status.textContent = `当前第 ${editor.project.currentFrame} 帧 · 检测来源：${sourceLabel}：找到 ${result.detectedHands} 只手，重新定位 ${result.activePoints} 个生效手指，其中 ${result.changedPoints} 个坐标发生变化`;
    editor.showToast(result.activePoints ? `已根据${sourceLabel}重新定位 ${result.activePoints} 个手指` : `${sourceLabel}没有找到生效手指`);
  } catch (error) {
    status.textContent = `当前帧查找失败：${error.message}`;
  } finally {
    setRecognitionButtonsEnabled(true);
  }
}

function setRecognitionButtonsEnabled(enabled) {
  for (const id of ["#analyzeButton", "#reanalyzeButton", "#detectCurrentFrameButton"]) $(id).disabled = !enabled;
}

function mediaDimensions(media) {
  return {
    width: media?.videoWidth || media?.naturalWidth || media?.width || 0,
    height: media?.videoHeight || media?.naturalHeight || media?.height || 0,
  };
}

function createDetectionSurface(media) {
  const { width, height } = mediaDimensions(media);
  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = width;
  fullCanvas.height = height;
  return {
    fullCanvas,
    fullContext: fullCanvas.getContext("2d", { willReadFrequently: true }),
    cropCanvas: document.createElement("canvas"),
  };
}

function detectHandsFromCurrentFrame(model, media, surface) {
  const { fullCanvas, fullContext, cropCanvas } = surface;
  const cropContext = cropCanvas.getContext("2d", { willReadFrequently: true });
  fullContext.drawImage(media, 0, 0, fullCanvas.width, fullCanvas.height);
  let candidates = resultHands(model.detect(fullCanvas));
  if (candidates.length < 2) {
    candidates = [];
    for (const crop of [{ x: 0, width: .62 }, { x: .38, width: .62 }]) {
      cropCanvas.width = Math.round(fullCanvas.width * crop.width);
      cropCanvas.height = fullCanvas.height;
      cropContext.drawImage(fullCanvas, Math.round(fullCanvas.width * crop.x), 0, cropCanvas.width, fullCanvas.height, 0, 0, cropCanvas.width, fullCanvas.height);
      for (const hand of resultHands(model.detect(cropCanvas))) {
        candidates.push({ ...hand, landmarks: hand.landmarks.map(point => [crop.x + point[0] * crop.width, point[1], point[2]]) });
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    candidates = candidates.filter((hand, i, all) => all.slice(0, i).every(other => Math.hypot(hand.landmarks[0][0] - other.landmarks[0][0], hand.landmarks[0][1] - other.landmarks[0][1]) > .11)).slice(0, 2);
  }
  candidates.sort((a, b) => a.landmarks[0][0] - b.landmarks[0][0]);
  return candidates;
}

function mapHandsToProject(hands, media) {
  const { width: sourceWidth, height: sourceHeight } = mediaDimensions(media);
  const targetWidth = editor.project.width;
  const targetHeight = editor.project.height;
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
  const offsetX = (targetWidth - drawnWidth) / 2;
  const offsetY = (targetHeight - drawnHeight) / 2;
  return hands.map(hand => ({
    ...hand,
    landmarks: hand.landmarks.map(point => [
      (offsetX + point[0] * drawnWidth) / targetWidth,
      (offsetY + point[1] * drawnHeight) / targetHeight,
      point[2],
    ]),
  }));
}

function shortName(name) {
  const safe = String(name || "上层素材");
  return safe.length > 24 ? `${safe.slice(0, 24)}…` : safe;
}

function resultHands(result) {
  return (result.landmarks || []).map((landmarks, index) => ({
    handedness: result.handednesses?.[index]?.[0]?.categoryName || null,
    confidence: result.handednesses?.[index]?.[0]?.score || 0,
    landmarks: landmarks.map(point => [point.x, point.y, point.z]),
  }));
}

async function saveBrowserProject() {
  const button = $("#saveBrowserProjectButton");
  button.disabled = true;
  try {
    const record = {
      id: LOCAL_PROJECT_ID,
      savedAt: new Date().toISOString(),
      project: editor.serializeProject(),
      media: {
        video: editor.project.video?.file || null,
        overlays: editor.project.overlays.map(layer => ({ id: layer.id, name: layer.name, kind: layer.kind, file: layer.file || null })),
      },
    };
    await putLocalProject(record);
    editor.showToast("工程和媒体已保存到当前浏览器");
  } catch (error) {
    editor.showToast(`本机保存失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function restoreBrowserProject() {
  const button = $("#restoreBrowserProjectButton");
  button.disabled = true;
  editor.pause();
  try {
    const record = await getLocalProject();
    if (!record?.project) {
      editor.showToast("当前浏览器还没有保存过工程");
      return;
    }
    editor.loadTracking(record.project);
    if (record.media?.video) await loadVideoFile(record.media.video);
    for (const saved of record.media?.overlays || []) {
      if (!saved.file) continue;
      editor.attachOverlayMedia(saved.id, await createOverlayAsset(saved.file, saved.kind));
    }
    editor.setFrame(record.project.currentFrame || 0);
    $("#analyzeStatus").textContent = `已恢复 ${new Date(record.savedAt).toLocaleString()} 保存的工程，无需重新识别`;
    editor.showToast("已恢复上次工程和识别进度");
  } catch (error) {
    editor.showToast(`恢复失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function openLocalDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LOCAL_STORE_NAME)) database.createObjectStore(LOCAL_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开浏览器工程库"));
  });
}

async function putLocalProject(record) {
  const database = await openLocalDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCAL_STORE_NAME, "readwrite");
    transaction.objectStore(LOCAL_STORE_NAME).put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("无法写入浏览器工程库"));
    transaction.onabort = () => reject(transaction.error || new Error("浏览器空间不足，保存已取消"));
  });
  database.close();
}

async function getLocalProject() {
  const database = await openLocalDatabase();
  const record = await new Promise((resolve, reject) => {
    const transaction = database.transaction(LOCAL_STORE_NAME, "readonly");
    const request = transaction.objectStore(LOCAL_STORE_NAME).get(LOCAL_PROJECT_ID);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("无法读取浏览器工程库"));
  });
  database.close();
  return record;
}

async function exportPreview() {
  if (!window.MediaRecorder || !editor.canvas.captureStream) return editor.showToast("当前浏览器不支持直接录制预览");
  editor.pause();
  editor.setFrame(0);
  const stream = editor.canvas.captureStream(editor.project.fps);
  const sourceStream = editor.video.captureStream?.();
  const audioTrack = sourceStream?.getAudioTracks?.()[0];
  if (audioTrack) stream.addTrack(audioTrack);
  const formats = supportedRecordingFormats();
  if (!formats.length) return editor.showToast("浏览器没有可用的视频编码器");
  const chunks = [];
  let recorder;
  let format;
  for (const candidate of formats) {
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: candidate.mimeType,
        videoBitsPerSecond: 10_000_000,
        audioBitsPerSecond: 192_000,
      });
      format = candidate;
      break;
    } catch {}
  }
  if (!recorder || !format) return editor.showToast("无法启动浏览器视频编码器");
  let exportFailed = false;
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = () => {
    if (!exportFailed) saveBlob(new Blob(chunks, { type: format.mimeType }), `${safeName(editor.project.video?.name || "manual-tracking")}-export.${format.extension}`);
    editor.setExportRenderMode(false);
    editor.setFrame(0);
    if (!exportFailed) editor.showToast(`${format.extension.toUpperCase()} 视频已导出`);
  };
  recorder.onerror = event => {
    exportFailed = true;
    editor.setExportRenderMode(false);
    editor.showToast(`视频导出失败：${event.error?.message || "编码器错误"}`);
  };
  editor.video.onended = () => recorder.state === "recording" && recorder.stop();
  editor.setExportRenderMode(true);
  recorder.start(250);
  editor.showToast(`正在实时导出 ${format.extension.toUpperCase()}，请不要切换标签页`);
  document.querySelector("#playButton").click();
}

function preferredRecordingFormat() {
  return supportedRecordingFormats()[0] || null;
}

function supportedRecordingFormats() {
  if (!window.MediaRecorder) return [];
  return [
    { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4" },
    { mimeType: "video/mp4;codecs=avc1.42E01E", extension: "mp4" },
    { mimeType: "video/mp4", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" },
  ].filter(format => MediaRecorder.isTypeSupported(format.mimeType));
}

function waitFor(target, eventName) {
  return new Promise((resolve, reject) => {
    if (eventName === "loadedmetadata" && target.readyState >= 1
      || eventName === "loadeddata" && target.readyState >= 2
      || eventName === "load" && target.complete) return resolve();
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("媒体文件无法读取")); };
    const cleanup = () => { target.removeEventListener(eventName, done); target.removeEventListener("error", fail); };
    target.addEventListener(eventName, done, { once: true });
    target.addEventListener("error", fail, { once: true });
  });
}

function seek(video, time) {
  if (Math.abs(video.currentTime - time) < .001) return Promise.resolve();
  return new Promise(resolve => {
    video.addEventListener("seeked", resolve, { once: true });
    video.currentTime = time;
  });
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function safeName(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[^\w\-\u4e00-\u9fff]+/g, "-");
}

function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}
