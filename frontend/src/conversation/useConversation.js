import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { api } from "../speech/client.js";
import { ConversationController } from "./controller.js";
import { MicRecorder, listMicrophones, listSpeakers, readSavedMic, saveMic } from "./recorder.js";
import { LipSyncPlayer } from "../lipsync/player.js";

const SPEAKER_KEY = "roto-speaker-device";
const read = (key) => {
  try {
    return sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
};
/**
 * React binding. `getRig()` returns the viewer's speech rig (or undefined while loading or after a
 * WebGL failure; audio and captions still work without it).
 */
export function useConversation({ getRig, language, cancelOnHide = () => true }) {
  const player = useMemo(() => {
    const p = new LipSyncPlayer();
    p.sinkId = read(SPEAKER_KEY);
    return p;
  }, []);
  const deviceRef = useRef(readSavedMic());
  const hideRef = useRef(cancelOnHide);
  hideRef.current = cancelOnHide;
  const langRef = useRef(language);
  langRef.current = language;
  const rigRef = useRef(getRig);
  rigRef.current = getRig;
  const controller = useMemo(() => {
    const recorder = new MicRecorder({
      getDeviceId: () => readSavedMic(), // always the freshest choice (the Settings tab may have changed it in another window)
      onAutoStop: () => controller.stopListening(),
    });
    const controller = new ConversationController({
      api,
      // ?pipeline=off speaks the whole reply in one request (for latency A/B measurements).
      pipeline: new URLSearchParams(location.search).get("pipeline") !== "off",
      // ?stream=off uses the non-streamed chat call (for latency A/B measurements).
      stream: new URLSearchParams(location.search).get("stream") !== "off",
      player,
      recorder,
      language: () => langRef.current,
      onGesture: (name) => rigRef.current()?.gesture(name),
      onSentence: (info) => rigRef.current()?.sentence(info),
      onWord: (index) => rigRef.current()?.onWord(index),
    });
    return controller;
  }, [player]);
  const [snap, setSnap] = useState(controller.snapshot);
  // Test/diagnostic handle (read-only use): lets the end-to-end harness observe state and latency.
  useEffect(() => {
    window.__ROTO_CONVERSATION__ = controller;
    return () => {
      if (window.__ROTO_CONVERSATION__ === controller) delete window.__ROTO_CONVERSATION__;
    };
  }, [controller]);
  useEffect(() => {
    const off = controller.subscribe(setSnap);
    controller.init();
    return () => {
      off();
      controller.dispose();
      player.dispose();
    };
  }, [controller, player]);
  useEffect(() => {
    rigRef.current()?.setPhase(snap.state);
  }, [snap.state]);
  // Stop everything when the page is hidden or closed.
  useEffect(() => {
    const hide = () => document.hidden && hideRef.current() && controller.cancel();
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [controller]);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceIdState] = useState(deviceRef.current);
  const refreshDevices = useCallback(() => listMicrophones().then(setDevices).catch(() => {}), []);
  const setDeviceId = useCallback((id) => {
    deviceRef.current = id;
    setDeviceIdState(id);
    saveMic(id);
  }, []);
  useEffect(() => {
    refreshDevices(); // labels are generic until the user has granted mic access once
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
  }, [refreshDevices]);
  useEffect(() => {
    if (snap.state === "listening") refreshDevices();
  }, [snap.state, refreshDevices]);
  const [speakers, setSpeakers] = useState([]);
  const [speakerId, setSpeakerIdState] = useState(player.sinkId);
  const [speakerError, setSpeakerError] = useState("");
  const outputSupported = LipSyncPlayer.canSelectOutput();
  const refreshSpeakers = useCallback(() => listSpeakers().then(setSpeakers).catch(() => {}), []);
  const setSpeakerId = useCallback(
    async (id) => {
      setSpeakerIdState(id);
      setSpeakerError("");
      try {
        sessionStorage.setItem(SPEAKER_KEY, id);
      } catch {}
      try {
        player.unlock(); // output routing needs the context; this runs inside the click
        await player.setOutputDevice(id);
      } catch {
        setSpeakerError("This speaker could not be selected. Using the system default.");
      }
    },
    [player],
  );
  useEffect(() => {
    refreshSpeakers();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshSpeakers);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshSpeakers);
  }, [refreshSpeakers]);
  return {
    controller, snap, player, devices, deviceId, setDeviceId, refreshDevices,
    speakers, speakerId, setSpeakerId, outputSupported, speakerError, refreshSpeakers,
  };
}
