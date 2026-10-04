export type PlaybackStatus =
  "Connecting" | "Live" | "Reconnecting" | "Stopped" | "Paused" | "Unavailable";
export interface Connection {
  close: () => void;
  id: string;
}

function gatherIce(peer: RTCPeerConnection, signal: AbortSignal) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", change);
      signal.removeEventListener("abort", abort);
    };
    const change = () => {
      if (peer.iceGatheringState === "complete") {
        clean();
        resolve();
      }
    };
    const abort = () => {
      clean();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      clean();
      reject(new Error("Network setup timed out"));
    }, 8000);
    peer.addEventListener("icegatheringstatechange", change);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function connectCamera(
  camera: string,
  quality: string,
  video: HTMLVideoElement,
  signal: AbortSignal,
  onStatus: (status: PlaybackStatus) => void,
  onFailure: () => void,
): Promise<Connection> {
  const peer = new RTCPeerConnection({ iceServers: [] });
  let resource: string | undefined;
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
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
  signal.addEventListener("abort", close, { once: true });
  peer.addTransceiver("video", { direction: "recvonly" });
  peer.addTransceiver("audio", { direction: "recvonly" });
  peer.ontrack = (event) => {
    if (!signal.aborted) {
      const stream = video.srcObject as MediaStream | null;
      if (stream) stream.addTrack(event.track);
      else video.srcObject = new MediaStream([event.track]);
      void video.play().catch(() => {});
    }
  };
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  peer.onconnectionstatechange = () => {
    clearTimeout(disconnectTimer);
    if (closing || signal.aborted) return;
    if (peer.connectionState === "failed" || peer.connectionState === "closed")
      onFailure();
    else if (peer.connectionState === "disconnected")
      disconnectTimer = setTimeout(onFailure, 5000);
  };
  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await gatherIce(peer, signal);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const response = await fetch(`/api/streams/${camera}/${quality}`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: peer.localDescription?.sdp,
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
    // A stopped tile can race an SDP response. Revoke the session even if fetch already completed.
    if (signal.aborted) {
      closing = false;
      close();
      throw new DOMException("Aborted", "AbortError");
    }
    await peer.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    });
    const playing = () => onStatus("Live");
    video.addEventListener("playing", playing);
    const originalClose = close;
    return {
      id: resource.split("/").at(-1)!,
      close: () => {
        clearTimeout(disconnectTimer);
        video.removeEventListener("playing", playing);
        originalClose();
      },
    };
  } catch (error) {
    clearTimeout(disconnectTimer);
    close();
    throw error;
  }
}
