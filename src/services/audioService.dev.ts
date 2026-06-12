// dev-only hook registrations for audio service.
//
// registers window.__seekTo, __triggerTrackEnd, __triggerAudioError.
// these are time-acceleration hooks, not transport mocks - they drive
// the real audio element without substituting any service boundary.
//
// only loaded in DEV builds (via src/dev-hooks.ts).

import {
  _devSeekTo,
  _devTriggerTrackEnd,
  _devTriggerAudioError,
} from "./audioService.js";

export function registerAudioDevHooks(): void {
  window.__seekTo = _devSeekTo;
  window.__triggerTrackEnd = _devTriggerTrackEnd;
  window.__triggerAudioError = _devTriggerAudioError;
}
