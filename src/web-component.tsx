import { customElement } from "solid-element";
import { Playlistz } from "./components";
import "./styles.css";

customElement("freqhole-playlistz", {}, () => {
  return <Playlistz />;
});
