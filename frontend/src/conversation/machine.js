// idle -> listening -> thinking -> speaking -> idle. CANCEL/RESET/FAIL return to idle from anywhere.
export const STATES = ["idle", "listening", "thinking", "speaking"];
export function transition(state, event) {
  switch (event) {
    case "CANCEL":
    case "RESET":
    case "FAIL":
    case "DONE":
      return "idle";
    case "LISTEN": // barge-in is allowed: pressing talk while speaking interrupts
      return "listening";
    case "SUBMIT": // release after listening, or a typed question
      return state === "idle" || state === "listening" ? "thinking" : state;
    case "SPEAK":
      return state === "thinking" ? "speaking" : state;
    default:
      return state;
  }
}
export const isBusy = (state) => state !== "idle";
