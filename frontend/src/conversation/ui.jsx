import React, { useEffect, useRef } from "react";

const typing = (el) =>
  !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest?.("dialog[open]"));

/**
 * Push-to-talk button handlers + global keys: hold Space to talk, Esc cancels.
 * Pointer capture keeps the hold alive if a finger drifts off the button.
 */
export function usePushToTalk(controller, { enabled = true } = {}) {
  const buttonRef = useRef(null);
  const held = useRef("");
  const down = (source) => {
    if (!enabled || held.current) return;
    held.current = source;
    controller.startListening();
  };
  const up = (source) => {
    if (held.current !== source) return;
    held.current = "";
    controller.stopListening();
  };
  useEffect(() => {
    const keydown = (e) => {
      if (e.code === "Escape") {
        held.current = "";
        controller.cancel();
        return;
      }
      if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (typing(t)) return;
      const other = t?.closest?.("button, a, summary, [role=button]");
      if (other && other !== buttonRef.current) return;
      e.preventDefault();
      down("key");
    };
    const keyup = (e) => {
      if (e.code === "Space") up("key");
    };
    const blur = () => {
      if (held.current) {
        held.current = "";
        controller.cancel();
      }
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
    };
  }, [controller, enabled]);
  return {
    ref: buttonRef,
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      down("pointer");
    },
    onPointerUp: () => up("pointer"),
    onPointerCancel: () => up("pointer"),
    onContextMenu: (e) => e.preventDefault(),
  };
}

/** Level meter that never re-renders React: writes a CSS variable each frame. */
export function LevelMeter({ controller, active }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!active) return;
    let raf;
    const loop = () => {
      const level = controller.d.recorder.level || 0;
      ref.current?.style.setProperty("--level", level.toFixed(3));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [controller, active]);
  return (
    <span className="level-meter" ref={ref} role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-hidden={!active}>
      <i />
    </span>
  );
}

/** Reply caption with the spoken word highlighted when word timings line up with the text. */
export function ReplyCaption({ text, words, wordIndex }) {
  if (!text) return null;
  const tokens = text.split(/\s+/).filter(Boolean);
  const aligned = words?.length && words.length <= tokens.length && wordIndex >= 0 && wordIndex < tokens.length;
  return (
    <p className="caption-reply" data-testid="caption-reply" aria-hidden={aligned ? undefined : undefined}>
      {aligned
        ? tokens.map((tok, i) => (
            <React.Fragment key={i}>
              <span className={i === wordIndex ? "word is-current" : i < wordIndex ? "word is-spoken" : "word"}>{tok}</span>{" "}
            </React.Fragment>
          ))
        : text}
    </p>
  );
}

export function ProviderBadge({ snap, always = false }) {
  if (!snap.provider) return null;
  if (!snap.demo && !always) return null;
  return (
    <span className={`provider-badge ${snap.demo ? "is-demo" : ""}`} data-testid="provider-badge">
      {snap.scripted ? "Scripted demo (prepared answers, not AI)" : snap.demo ? "Demo answers (no AI key)" : snap.provider}
    </span>
  );
}
