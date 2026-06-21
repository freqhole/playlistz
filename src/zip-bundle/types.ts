// types for the zip-bundle export.
// no playlistz-internal type dependencies - safe to import from spume or node.

// key is sha256 hex (64 chars). both playlistz (IDB) and spume (Song.sha256)
// carry this. callers close over whatever mapping turns sha256 into bytes.
export type BlobFetcher = (sha256: string) => Promise<ArrayBuffer | undefined>;

export interface PlaylistZipSong {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration: number;
  originalFilename: string;
  mimeType: string;
  sha?: string; // audio blob sha256 - BlobFetcher key
  imageSha?: string; // cover image sha256 - BlobFetcher key
  imageType?: string; // mime type of cover image
  fileSize?: number;
  lyrics?: string;
}

export interface PlaylistZipEntry {
  playlist: {
    id: string;
    title: string;
    description?: string;
    rev?: number;
    imageSha?: string; // sha256 of playlist cover image blob
    imageType?: string; // mime type of playlist cover image
    bgFilterEnabled?: boolean;
    bgFilterBlur?: number;
    bgFilterContrast?: number;
    bgFilterBrightness?: number;
    coverFilterEnabled?: boolean;
    coverFilterBlur?: number;
  };
  songs: PlaylistZipSong[];
}

export interface PlaylistZipOptions {
  includeImages?: boolean;
  generateM3U?: boolean;
  includeHTML?: boolean;
  // explicit url to fetch freqhole-playlistz.js for embedding.
  // when omitted in a browser context falls back to
  // window.location.origin + "/freqhole-playlistz.js".
  // set to null to skip embedding the app bundle entirely.
  appBundleUrl?: string | null;
}
