import { iceFragment } from "./ice";

export type PlaybackStatus =
  | "Connecting"
  | "Live"
  | "Reconnecting"
  | "Stopped"
  | "Tap to play"
  | "Unavailable";
export interface Connection {
  close: () => void;
  resume: () => void;
  id: string;
}

export async function connectCamera(
  camera: string,
  quality: string,
  video: HTMLVideoElement,
  signal: AbortSignal,
  onStatus: (status: PlaybackStatus) => void,
  onFailure: () => void,
): Promise<Connection> {
  const peer = new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: "max-bundle",
  });
  let resource: string | undefined;
  let closing = false,
    answered = false,
    failed = false;
  let offerSdp = "";
  let lastStatus: PlaybackStatus | undefined;
  let candidates: RTCIceCandidateInit[] = [];
  let patchQueue = Promise.resolve();
  let candidateTimer: ReturnType<typeof setTimeout> | undefined;
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  const status = (value: PlaybackStatus) => {
    if (!closing && !signal.aborted && value !== lastStatus) {
      lastStatus = value;
      onStatus(value);
    }
  };
  const decoded = () => {
    if (video.videoWidth > 0 && video.readyState >= 2 && !video.paused)
      status("Live");
  };
  const play = () => {
    if (closing || signal.aborted || document.hidden || !video.srcObject)
      return;
    void video
      .play()
      .then(decoded)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "NotAllowedError")
          status("Tap to play");
      });
  };
  const visibility = () => {
    clearTimeout(disconnectTimer);
    clearTimeout(connectTimer);
    if (document.hidden) return;
    if (["failed", "closed"].includes(peer.connectionState)) failure();
    else {
      play();
      connectionState();
      armConnectionDeadline();
    }
  };
  const close = () => {
    if (closing) return;
    closing = true;
    clearTimeout(candidateTimer);
    clearTimeout(disconnectTimer);
    clearTimeout(connectTimer);
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    peer.onicecandidate = null;
    video.removeEventListener("playing", decoded);
    video.removeEventListener("loadeddata", decoded);
    video.removeEventListener("timeupdate", decoded);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", close);
    peer.getReceivers().forEach((receiver) => receiver.track?.stop());
    peer.close();
    video.pause();
    video.srcObject = null;
    if (resource)
      void fetch(resource, { method: "DELETE", keepalive: true }).catch(
        () => {},
      );
    signal.removeEventListener("abort", close);
  };
  function failure() {
    if (closing || failed || signal.aborted || document.hidden) return;
    failed = true;
    close();
    onFailure();
  }
  function connectionState() {
    clearTimeout(disconnectTimer);
    if (closing || signal.aborted) return;
    if (peer.connectionState === "connected") {
      clearTimeout(connectTimer);
      play();
    } else if (
      peer.connectionState === "failed" ||
      peer.connectionState === "closed"
    )
      failure();
    else if (peer.connectionState === "disconnected" && !document.hidden)
      disconnectTimer = setTimeout(failure, 5000);
  }
  function armConnectionDeadline() {
    clearTimeout(connectTimer);
    if (
      closing ||
      !answered ||
      document.hidden ||
      peer.connectionState === "connected"
    )
      return;
    connectTimer = setTimeout(() => {
      if (peer.connectionState !== "connected") failure();
    }, 20000);
  }
  function flushCandidates() {
    if (!answered || !resource || !candidates.length || closing) return;
    const body = iceFragment(offerSdp, candidates);
    candidates = [];
    const target = resource;
    patchQueue = patchQueue
      .then(async () => {
        if (closing || signal.aborted) return;
        const response = await fetch(target, {
          method: "PATCH",
          headers: { "Content-Type": "application/trickle-ice-sdpfrag" },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        });
        if (!response.ok) throw new Error("Connection update failed");
      })
      .catch(() => {
        if (!closing && !signal.aborted && peer.connectionState !== "connected")
          failure();
      });
  }
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) {
    close();
    throw new DOMException("Aborted", "AbortError");
  }
  // Register readiness before negotiating: Safari can fire playing while the
  // remote description promise is still resolving. Never label audio alone Live.
  video.addEventListener("playing", decoded);
  video.addEventListener("loadeddata", decoded);
  video.addEventListener("timeupdate", decoded);
  document.addEventListener("visibilitychange", visibility);
  // Navigation/reload releases its lease; changing tabs only changes visibility.
  window.addEventListener("pagehide", close, { once: true });
  video.defaultMuted = video.muted;
  peer.addTransceiver("video", { direction: "recvonly" });
  peer.addTransceiver("audio", { direction: "recvonly" });
  peer.ontrack = (event) => {
    if (closing || signal.aborted) return;
    const stream = video.srcObject as MediaStream | null;
    if (stream) stream.addTrack(event.track);
    else video.srcObject = new MediaStream([event.track]);
    play();
  };
  peer.onconnectionstatechange = connectionState;
  peer.onicecandidate = (event) => {
    if (!event.candidate || closing) return;
    candidates.push(event.candidate.toJSON());
    clearTimeout(candidateTimer);
    candidateTimer = setTimeout(flushCandidates, 50);
  };
  try {
    const offer = await peer.createOffer();
    offerSdp = offer.sdp!;
    await peer.setLocalDescription(offer);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    // Trickle ICE starts camera negotiation immediately instead of waiting up
    // to eight seconds for every interface to finish gathering candidates.
    const response = await fetch(`/api/streams/${camera}/${quality}`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offerSdp,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (response.status === 401) {
      window.location.replace("/login");
      throw new Error("Locked");
    }
    if (!response.ok) throw new Error("Camera unavailable");
    resource = response.headers.get("location") ?? undefined;
    if (
      !resource ||
      !/^\/api\/streams\/sessions\/[a-f0-9-]{36}$/.test(resource)
    )
      throw new Error("Invalid video session");
    if (signal.aborted || closing) {
      closing = false;
      close();
      throw new DOMException("Aborted", "AbortError");
    }
    await peer.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    });
    if (closing || signal.aborted)
      throw new DOMException("Aborted", "AbortError");
    answered = true;
    flushCandidates();
    decoded();
    armConnectionDeadline();
    connectionState();
    return { id: resource.split("/").at(-1)!, close, resume: play };
  } catch (error) {
    close();
    throw error;
  }
}
