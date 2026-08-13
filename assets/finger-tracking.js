export const FINGERS = [
  { id: "thumb", label: "拇指", tip: 4, joints: [1, 2, 3, 4], color: "#ff7a90" },
  { id: "index", label: "食指", tip: 8, joints: [5, 6, 7, 8], color: "#ffd85a" },
  { id: "middle", label: "中指", tip: 12, joints: [9, 10, 11, 12], color: "#74e6a7" },
  { id: "ring", label: "无名指", tip: 16, joints: [13, 14, 15, 16], color: "#63bcff" },
  { id: "pinky", label: "小指", tip: 20, joints: [17, 18, 19, 20], color: "#bd8cff" },
];

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function angle(a, b, c) {
  const ux = a[0] - b[0];
  const uy = a[1] - b[1];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const denom = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1e-6;
  const cosine = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denom));
  return Math.acos(cosine) * 180 / Math.PI;
}

function palmCenter(lm) {
  const ids = [0, 5, 9, 13, 17];
  return ids.reduce((sum, id) => [sum[0] + lm[id][0] / ids.length, sum[1] + lm[id][1] / ids.length], [0, 0]);
}

export function isFingerExtended(lm, fingerId) {
  if (!lm || lm.length < 21) return false;
  const finger = FINGERS.find(item => item.id === fingerId);
  const [mcp, pip, dip, tip] = finger.joints;
  const center = palmCenter(lm);
  const straightAtPip = angle(lm[mcp], lm[pip], lm[dip]);
  const straightAtDip = angle(lm[pip], lm[dip], lm[tip]);
  const reach = distance(lm[tip], center) / Math.max(distance(lm[pip], center), 1e-6);

  if (fingerId === "thumb") {
    const thumbBase = angle(lm[1], lm[2], lm[3]);
    return straightAtDip > 142 && thumbBase > 125 && reach > 1.08;
  }
  return straightAtPip > 145 && straightAtDip > 145 && reach > 1.08;
}

export function fingertipPointsForHands(hands, { forceFingerIds = [] } = {}) {
  const points = [];
  const forced = new Set(forceFingerIds);
  const orderedHands = normalizeHandSides(hands);
  orderedHands.forEach(hand => {
    const side = hand.handedness;
    for (const finger of FINGERS) {
      const id = `${side.toLowerCase()}:${finger.id}`;
      if (!forced.has(id) && !isFingerExtended(hand.landmarks, finger.id)) continue;
      const tip = hand.landmarks[finger.tip];
      points.push({
        id,
        hand: side,
        finger: finger.id,
        label: `${side === "Left" ? "左" : "右"}${finger.label}`,
        x: tip[0],
        y: tip[1],
        confidence: hand.confidence ?? 1,
        color: finger.color,
        source: "auto",
      });
    }
  });
  return points;
}

function normalizeHandSides(hands) {
  const ordered = [...(hands || [])]
    .filter(hand => hand?.landmarks?.length >= 21)
    .sort((a, b) => a.landmarks[0][0] - b.landmarks[0][0]);
  if (ordered.length === 2) {
    const sides = ordered.map(hand => hand.handedness === "Left" || hand.handedness === "Right" ? hand.handedness : null);
    if (!sides[0] || !sides[1] || sides[0] === sides[1]) {
      // 自拍/镜像画面中，画面左侧通常是人物右手，右侧是人物左手。
      return [
        { ...ordered[0], handedness: "Right" },
        { ...ordered[1], handedness: "Left" },
      ];
    }
  }
  return ordered.map(hand => ({
    ...hand,
    handedness: hand.handedness === "Left" || hand.handedness === "Right"
      ? hand.handedness
      : hand.landmarks[0][0] < .5 ? "Right" : "Left",
  }));
}

export function buildTrackingKeyframes(landmarkData, fps = 30, { forceFingerIdsAtFrame } = {}) {
  const seenFrames = new Map();
  for (const sample of landmarkData.frames || []) {
    const frame = Math.max(0, Math.round(sample.time * fps));
    const points = fingertipPointsForHands(sample.hands, {
      forceFingerIds: forceFingerIdsAtFrame?.(frame) || [],
    });
    seenFrames.set(frame, {
      frame,
      time: frame / fps,
      points: points.map(point => ({ ...point, x: round(point.x), y: round(point.y) })),
      source: "auto",
    });
  }
  return [...seenFrames.values()].sort((a, b) => a.frame - b.frame);
}

export function convexHull(points) {
  if (points.length <= 2) return points.slice();
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
