/* @jsxImportSource solid-js */
import { render } from "solid-js/web";
import { Playlistz } from "./components/index.js";
import "./styles.css";

customElements.define(
  "freqhole-playlistz",
  class extends HTMLElement {
    connectedCallback() {
      render(() => <Playlistz />, this);
    }
  }
);
