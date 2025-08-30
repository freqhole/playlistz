import { customElement } from "solid-element";
import { PlaylistManager } from "./components/PlaylistManager";
import "./styles.css";

customElement("freqhole-playlistz", {}, () => {
  return <PlaylistManager />;
});