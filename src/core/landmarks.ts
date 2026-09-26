/** BlazePose 33-landmark topology indices (MediaPipe PoseLandmarker). */
export const LM = {
  nose: 0,
  leftEyeInner: 1,
  leftEye: 2,
  leftEyeOuter: 3,
  rightEyeInner: 4,
  rightEye: 5,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftThumb: 21,
  rightThumb: 22,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const;

export const NUM_LANDMARKS = 33;

/** Landmarks that must be visible to play (upper body). */
export const UPPER_BODY = [
  LM.nose,
  LM.leftShoulder,
  LM.rightShoulder,
  LM.leftElbow,
  LM.rightElbow,
  LM.leftWrist,
  LM.rightWrist,
] as const;

export const ARM = {
  left: {
    shoulder: LM.leftShoulder,
    elbow: LM.leftElbow,
    wrist: LM.leftWrist,
    index: LM.leftIndex,
    pinky: LM.leftPinky,
  },
  right: {
    shoulder: LM.rightShoulder,
    elbow: LM.rightElbow,
    wrist: LM.rightWrist,
    index: LM.rightIndex,
    pinky: LM.rightPinky,
  },
} as const;

/** Skeleton connections for debug overlays. */
export const POSE_BONES: ReadonlyArray<readonly [number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [15, 17],
  [15, 19],
  [17, 19],
  [16, 18],
  [16, 20],
  [18, 20],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
  [0, 2],
  [0, 5],
  [2, 7],
  [5, 8],
  [9, 10],
];
