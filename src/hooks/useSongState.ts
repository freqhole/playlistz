
import { createSignal, batch } from "solid-js";
import type { Song, Playlist } from "../types/playlist.js";
import { updateSongInDoc } from "../services/playlistDocService.js";
import { log } from "../utils/log.js";
import {
  playSong,
  playSongFromPlaylist,
  togglePlayback,
  audioState,
} from "../services/audioService.js";

export function useSongState() {
  const [editingSong, setEditingSong] = createSignal<Song | null>(null);
  const [editingPlaylist, setEditingPlaylist] = createSignal(false);

  // true when any edit panel is open
  const isEditMode = () => editingSong() !== null || editingPlaylist();

  const [error, setError] = createSignal<string | null>(null);

  // note: does not clear playlist edit mode - the song edit panel can
  // coexist below the playlist edit panel
  const handleEditSong = (song: Song) => {
    setEditingSong(song);
  };

  const handleEditPlaylist = () => {
    setEditingSong(null);
    setEditingPlaylist(true);
  };

  // batched so dependent effects see both signals cleared at once
  // (otherwise clearing the song while playlist edit is still open would
  // re-trigger the default-song effect and re-open the song panel)
  const handleCloseEdit = () => {
    batch(() => {
      setEditingSong(null);
      setEditingPlaylist(false);
    });
  };

  // handle song update after editing - keeps the edit panel open and refreshes
  // the editing song reference with the saved values
  const handleSongSaved = async (updatedSong: Song) => {
    try {
      setError(null);
      // song.playlistId is the docId for doc-backed songs
      await updateSongInDoc(updatedSong.playlistId, updatedSong.id, updatedSong);
      setEditingSong(updatedSong);
    } catch (err) {
      log.error("song.save", "error saving song:", err);
      setError("failed to save song changes");
    }
  };

  const handlePlaySong = async (song: Song, playlist?: Playlist) => {
    try {
      setError(null);
      if (playlist) {
        await playSongFromPlaylist(song, playlist);
      } else {
        await playSong(song);
      }
    } catch (err) {
      log.error("song.play", "error playing song:", err);
      setError("failed to play song");
    }
  };

  const handlePauseSong = async () => {
    try {
      setError(null);
      await togglePlayback();
    } catch (err) {
      log.error("song.play", "error pausing song:", err);
      setError("Failed to pause song");
    }
  };

  const isSongPlaying = (songId: string) => {
    const currentSong = audioState.currentSong();
    return currentSong?.id === songId && audioState.isPlaying();
  };

  // is song currently selected (but maybe paused)
  const isSongSelected = (songId: string) => {
    const currentSong = audioState.currentSong();
    return currentSong?.id === songId;
  };

  return {
    editingSong,
    editingPlaylist,
    isEditMode,
    error,

    // setterz
    setEditingSong,
    setEditingPlaylist,

    // actionz
    handleEditSong,
    handleEditPlaylist,
    handleCloseEdit,
    handleSongSaved,
    handlePlaySong,
    handlePauseSong,

    // utilz
    isSongPlaying,
    isSongSelected,
  };
}
