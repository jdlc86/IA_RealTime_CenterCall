import baseHandler from "./index-v5";
// Runtime chain now ends at V54. Governed post-tool speech liveness is composed
// through governed-speech-liveness-coordinator instead of a V55 subclass.
export { CallSession } from "./call-session-v54-close-confirmation-authority";

export default baseHandler;