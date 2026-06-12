// shared mini header used by the all-playlists and share panels.
// shows thumbnail, a small label ("all playlistz", "sharez", etc.),
// the playlist title, and a close button.
// text is wrapped in tight bg-black/80 spans for legibility over blurred bg.

import { Show, JSX } from "solid-js";
import { getImageUrlForContext } from "../../services/imageService.js";
import type { Playlist } from "../../types/playlist.js";

interface Props {
  playlist: Playlist;
  label: string;
  isMobile: boolean;
  style?: JSX.CSSProperties;
  onClose: () => void;
  closeTitle?: string;
}

export function PanelMiniHeader(props: Props) {
  const imageUrl = () => getImageUrlForContext(props.playlist, "thumbnail");

  const fallbackIcon = (size: number) => (
    <div class="w-full h-full flex items-center justify-center">
      <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
        <path d="M50 81L25 31L75 31L60.7222 68.1429L50 81Z" fill="#FF00FF" />
      </svg>
    </div>
  );

  return (
    <div
      style={props.style}
      class={`flex items-center gap-3 ${props.isMobile ? "p-2" : "px-6 py-4"}`}
    >
      {/* thumbnail */}
      <div class="w-10 h-10 flex-shrink-0 overflow-hidden">
        <Show when={imageUrl()} fallback={fallbackIcon(32)}>
          <img src={imageUrl()!} alt="" class="w-full h-full object-cover" />
        </Show>
      </div>
      {/* current title */}
      <div class="flex-1 min-w-0 flex flex-col gap-0.5">
        <div class="truncate">
          <span class="text-md font-bold text-white px-1 py-0.5 bg-black/80">
            {props.playlist.title}
          </span>
        </div>
        <span class="text-sm uppercase tracking-widest px-1 bg-black/80 inline-block w-fit">
          {props.playlist.description}
        </span>
      </div>

      {/* label */}
      <span class="text-md text-magenta-400 uppercase tracking-widest px-1 bg-black/80 inline-block w-fit">
        {props.label}
      </span>

      {/* close button */}
      <button
        onClick={props.onClose}
        title={props.closeTitle ?? "close"}
        class="p-1 text-gray-400 hover:text-white transition-colors ml-1"
      >
        <svg
          class="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}
