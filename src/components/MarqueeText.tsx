/* @jsxImportSource solid-js */
// hover-triggered marquee for long text in constrained rows.
// ported from tomb/client/spume/src/components/text/MarqueeText.tsx.
// scrolls on hover when content overflows; does nothing when it fits.

import {
  Accessor,
  createEffect,
  createMemo,
  createSignal,
  onMount,
} from "solid-js";

interface Props {
  text: string;
  class?: string;
  title?: string;
  // external hover state - pass a signal accessor when the row manages hover
  isHovering?: boolean | Accessor<boolean>;
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes marquee-scroll {
      0%, 5%   { transform: translateX(0); }
      45%, 55% { transform: translateX(var(--marquee-offset)); }
      95%, 100%{ transform: translateX(0); }
    }
  `;
  document.head.appendChild(style);
}

export function MarqueeText(props: Props) {
  const [overflows, setOverflows] = createSignal(false);
  const [offset, setOffset] = createSignal(0);
  const [internalHover, setInternalHover] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;
  let textRef: HTMLSpanElement | undefined;

  const isHovering = () => {
    const ext = props.isHovering;
    if (ext === undefined) return internalHover();
    return typeof ext === "function" ? ext() : ext;
  };

  const checkOverflow = () => {
    if (!containerRef || !textRef) return;
    const cw = containerRef.offsetWidth;
    const tw = textRef.scrollWidth;
    const does = tw > cw;
    setOverflows(does);
    if (does) setOffset(cw - tw - 8);
  };

  onMount(() => {
    injectStyles();
    requestAnimationFrame(checkOverflow);
  });

  createEffect(() => {
    props.text;
    requestAnimationFrame(checkOverflow);
  });

  const duration = () => Math.max(2, 2 + Math.abs(offset()) * 0.02);

  const animation = createMemo(() => {
    if (!overflows() || !isHovering()) return "none";
    return `marquee-scroll ${duration()}s ease-in-out infinite`;
  });

  return (
    <div
      ref={containerRef!}
      class={`overflow-hidden ${props.class ?? ""}`}
      title={props.title ?? props.text}
      onMouseEnter={
        props.isHovering === undefined
          ? () => setInternalHover(true)
          : undefined
      }
      onMouseLeave={
        props.isHovering === undefined
          ? () => setInternalHover(false)
          : undefined
      }
    >
      <span
        ref={textRef!}
        class="block whitespace-nowrap"
        style={{ "--marquee-offset": `${offset()}px`, animation: animation() }}
      >
        {props.text}
      </span>
    </div>
  );
}
