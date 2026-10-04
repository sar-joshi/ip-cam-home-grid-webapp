export interface CaptureFile {
  blob: Blob;
  filename: string;
  kind: "snapshot" | "recording";
  detail: string;
}
export interface Recording {
  stop: () => Promise<void>;
  audio: boolean;
}
export const CLIP_MAX_MS = 5 * 60 * 1000;
export const CLIP_MAX_BYTES = 32 * 1024 * 1024;

export function captureFilename(
  name: string,
  extension: string,
  now = new Date(),
) {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "camera";
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `HomeGrid-${safe}-${timestamp}.${extension}`;
}

export async function snapshot(
  video: HTMLVideoElement,
  name: string,
): Promise<CaptureFile> {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2)
    throw new Error("Wait for the live video before taking a snapshot.");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Snapshots are unavailable in this browser.");
  context.drawImage(video, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error("Snapshot failed.")),
      "image/png",
    ),
  );
  return {
    blob,
    filename: captureFilename(name, "png"),
    kind: "snapshot",
    detail: `${canvas.width} × ${canvas.height}`,
  };
}

export function recordingMimeType(supported: (type: string) => boolean) {
  return [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ].find(supported);
}

export async function record(
  video: HTMLVideoElement,
  name: string,
  signal: AbortSignal,
  onFile: (file: CaptureFile) => void,
  onError: (message: string) => void,
  onEnd?: () => void,
): Promise<Recording> {
  if (typeof MediaRecorder === "undefined")
    throw new Error("Recording is unavailable in this browser.");
  const source = video.srcObject as MediaStream | null;
  if (!source || !video.videoWidth || video.readyState < 2)
    throw new Error("Wait for the live video before recording.");
  // An unmuted silent Sub 2 may still be negotiating its Sub 1 audio fallback.
  // Select tracks once: adding tracks to an active MediaRecorder invalidates it.
  const deadline = Date.now() + 8000;
  while (
    !video.muted &&
    !source
      .getAudioTracks()
      .some((track) => !track.muted && track.readyState === "live") &&
    Date.now() < deadline &&
    !signal.aborted
  )
    await new Promise((resolve) => setTimeout(resolve, 200));
  signal.throwIfAborted();
  const selected = source
    .getTracks()
    .filter(
      (track) =>
        track.readyState === "live" &&
        (track.kind === "video" || (!video.muted && !track.muted)),
    );
  if (!selected.some((track) => track.kind === "video"))
    throw new Error("The video stream ended before recording started.");
  const supportedType = recordingMimeType((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  if (!supportedType) {
    throw new Error("This browser cannot record this video format.");
  }
  const mimeType: string = supportedType;
  const tracks = selected.map((track) => track.clone());
  let stream = new MediaStream(tracks);
  let audioContext: AudioContext | undefined;
  const release = () => {
    stream.getTracks().forEach((track) => track.stop());
    tracks.forEach((track) => track.stop());
    void audioContext?.close();
  };
  // Camera G.711 arrives at 8 kHz. Resample locally for the native AAC encoder;
  // its input must not depend on the camera's telephony sample rate.
  if (mimeType.startsWith("video/mp4") && stream.getAudioTracks().length) {
    try {
      audioContext = new AudioContext({ sampleRate: 48000 });
      await audioContext.resume();
      signal.throwIfAborted();
      const input = audioContext.createMediaStreamSource(
        new MediaStream(stream.getAudioTracks()),
      );
      const output = audioContext.createMediaStreamDestination();
      input.connect(output);
      stream = new MediaStream([
        ...stream.getVideoTracks(),
        ...output.stream.getAudioTracks(),
      ]);
    } catch {
      release();
      throw new Error("Audio recording could not start. Try recording muted.");
    }
  }
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: Math.min(
        4000000,
        Math.max(600000, video.videoWidth * video.videoHeight * 2),
      ),
      audioBitsPerSecond: 128000,
    });
  } catch {
    release();
    throw new Error("Recording could not start in this browser.");
  }
  const chunks: Blob[] = [];
  let bytes = 0;
  let reason = "";
  let finalized = false;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let finish: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    clearTimeout(timer);
    if (recorder.state !== "inactive") recorder.stop();
    // A failed platform encoder must never prevent the user from locking.
    if (!finalized && !stopTimer)
      stopTimer = setTimeout(() => {
        reason = "Recording interrupted";
        finalize();
      }, 5000);
    return finished;
  };
  recorder.ondataavailable = (event) => {
    if (finalized) return;
    if (event.data.size) {
      chunks.push(event.data);
      bytes += event.data.size;
    }
    if (bytes >= CLIP_MAX_BYTES && recorder.state !== "inactive") {
      reason = "Size limit reached";
      void stop();
    }
  };
  recorder.onerror = () => {
    onError("Recording was interrupted. Any captured video will be saved.");
    void stop();
  };
  const audio = selected.some((track) => track.kind === "audio");
  function finalize() {
    if (finalized) return;
    finalized = true;
    clearTimeout(timer);
    clearTimeout(stopTimer);
    release();
    signal.removeEventListener("abort", stop);
    try {
      if (chunks.length) {
        const type = recorder.mimeType || mimeType;
        onFile({
          blob: new Blob(chunks, { type }),
          filename: captureFilename(
            name,
            type.startsWith("video/mp4") ? "mp4" : "webm",
          ),
          kind: "recording",
          detail: reason || (audio ? "Video and audio" : "Video only"),
        });
        chunks.length = 0;
      } else onError("No video was recorded. Try a longer clip.");
    } finally {
      onEnd?.();
      finish();
    }
  }
  recorder.onstop = finalize;
  const timer = setTimeout(() => {
    reason = "Five-minute limit reached";
    void stop();
  }, CLIP_MAX_MS);
  try {
    recorder.start(1000);
  } catch {
    clearTimeout(timer);
    release();
    throw new Error("Recording could not start in this browser.");
  }
  signal.addEventListener("abort", stop, { once: true });
  return { stop, audio };
}

export function downloadCapture(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}
