export interface Playlist {
  id: string; // UUID or AutomergeUrl (doc-backed)
  title: string; // User-editable playlist name
  description?: string; // Optional description
  imageData?: ArrayBuffer; // Full-size image data (optional, populated on-demand from blob store)
  thumbnailData?: ArrayBuffer; // Thumbnail image data (optional, populated on-demand)
  imageType?: string; // MIME type for the image
  createdAt: number; // Timestamp
  updatedAt: number; // Timestamp
  songIds: string[]; // Ordered array of song IDs
  needsImageLoad?: boolean;
  imageFilePath?: string;
  rev?: number; // Revision number for standalone mode (starts at 0, incremented on download)
  // internal: primary image sha for lazy blob store loading (set by docToPlaylist)
  _primaryImageSha?: string;
  // background image filter settings
  bgFilterEnabled?: boolean; // default: true
  bgFilterBlur?: number; // default: 3 (px)
  bgFilterContrast?: number; // default: 3
  bgFilterBrightness?: number; // default: 0.4
  // cover image filter (the blurred thumbnail in the playlist header)
  coverFilterEnabled?: boolean; // default: true
  coverFilterBlur?: number; // default: 3 (px)
  // background image layout
  bgSize?: string;     // css background-size, default: "cover"
  bgPosition?: string; // css background-position, default: "top"
  bgRepeat?: string;   // css background-repeat, default: "no-repeat"
  // remote source metadata: set for playlists received from a remote peer
  remoteNodeId?: string; // iroh node id of the peer who shared this
  remoteName?: string; // their display name at time of sync
  remoteAvatarDataUrl?: string; // their avatar data url at time of sync
  isForked?: boolean; // true once the user has forked to a local editable copy
}

export interface Song {
  id: string; // UUID
  file?: File; // Original audio file (only available during upload or when loaded for playback)
  blobUrl?: string; // Object URL for audio playback (created on-demand)
  audioData?: ArrayBuffer; // Audio data (legacy, no longer stored in idb)
  mimeType: string; // MIME type for recreating blob from stored data
  originalFilename: string; // Original filename with extension for downloads
  fileSize?: number; // File size in bytes
  title: string; // User-editable song title
  artist: string; // User-editable artist name
  album: string; // User-editable album name
  duration: number; // Length in seconds
  position: number; // Position within playlist (0-based)
  imageData?: ArrayBuffer; // Cover art data (optional, populated on-demand from blob store)
  thumbnailData?: ArrayBuffer; // Thumbnail cover art (optional, populated on-demand)
  imageType?: string; // MIME type for the cover art
  createdAt: number; // Timestamp
  updatedAt: number; // Timestamp
  playlistId: string; // Reference to parent playlist (or docId for doc-backed songs)
  standaloneFilePath?: string; // Path to audio file in standalone mode
  needsImageLoad?: boolean;
  imageFilePath?: string;
  sha?: string; // SHA-256 hash of the raw audio data (blob store key)
  sha256?: string; // Alias for sha, set by doc adapter
  // image refs from automerge doc (for blob store image loading)
  images?: Array<{ blobId: string; isPrimary: boolean; blobType: string }>;
}

export interface AudioState {
  currentSong: Song | null;
  currentPlaylist: Playlist | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  currentIndex: number;
  queue: Song[];
  repeatMode: "none" | "one" | "all";
  isShuffled: boolean;
  isLoading: boolean;
}

export interface PlaylistStats {
  totalSongs: number;
  totalDuration: number; // in seconds
  lastPlayed?: number; // timestamp
}

// For file upload processing
export interface FileUploadResult {
  success: boolean;
  song?: Song;
  error?: string;
}

// For metadata extraction
export interface AudioMetadata {
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  coverArtData?: ArrayBuffer; // Full-size cover art data as ArrayBuffer
  coverArtThumbnailData?: ArrayBuffer; // Thumbnail cover art data as ArrayBuffer (300x300)
  coverArtType?: string; // MIME type for the cover art
}
