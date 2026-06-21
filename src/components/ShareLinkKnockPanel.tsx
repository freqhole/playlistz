// modal overlay shown when a share link requires a knock before syncing.
// lets the user write a message to the owner and send the knock.
import { createSignal, Show } from "solid-js";
import { knockForDocAccess } from "../services/sharingService.js";
import { ensureSharingReady } from "../services/sharingService.js";

interface ShareLinkKnockPanelProps {
  ownerNodeId: string;
  docId: string;
  title?: string;
  ownerName?: string;
  onAccepted: (docId: string) => void;
  onDismiss: () => void;
}

export function ShareLinkKnockPanel(props: ShareLinkKnockPanelProps) {
  const [message, setMessage] = createSignal("");
  const [status, setStatus] = createSignal<
    "idle" | "sending" | "pending" | "denied" | "error"
  >("idle");
  const [errorText, setErrorText] = createSignal("");

  const handleSendKnock = async () => {
    setStatus("sending");
    setErrorText("");
    try {
      await ensureSharingReady();
      const result = await knockForDocAccess(
        props.ownerNodeId,
        props.docId,
        message(),
        props.title
      );
      if (result.status === "accepted") {
        props.onAccepted(props.docId);
      } else if (result.status === "denied") {
        setStatus("denied");
      } else {
        setStatus("pending");
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "knock failed");
      setStatus("error");
    }
  };

  const ownerLabel = () =>
    props.ownerName || props.ownerNodeId.slice(0, 12) + "...";

  return (
    <div
      data-testid="share-knock-panel"
      class="fixed inset-0 flex items-center justify-center z-50 bg-black/80 backdrop-blur-sm"
    >
      <div class="bg-black border border-gray-700 p-6 max-w-sm w-full mx-4 space-y-4 font-mono">
        <h2 class="text-white text-sm font-medium">knock to access playlist</h2>

        <div class="space-y-1">
          <p class="text-gray-400 text-xs">
            <span class="text-gray-200">{ownerLabel()}</span> has shared{" "}
            <Show when={props.title} fallback={<span>a playlist</span>}>
              <span class="text-white">"{props.title}"</span>
            </Show>{" "}
            with access control enabled. send a knock to request access.
          </p>
        </div>

        <Show
          when={
            status() === "idle" ||
            status() === "sending" ||
            status() === "error"
          }
        >
          <div class="space-y-2">
            <label class="block text-xs text-gray-400">
              message to owner (optional)
            </label>
            <textarea
              data-testid="input-knock-message"
              value={message()}
              onInput={(e) => setMessage(e.currentTarget.value)}
              placeholder="hi, found your link and would love to listen..."
              rows="3"
              disabled={status() === "sending"}
              class="w-full bg-black text-white text-xs border border-gray-700 px-2 py-1.5 focus:outline-none focus:border-magenta-500 resize-none disabled:opacity-50"
            />
            <Show when={errorText()}>
              <p class="text-red-400 text-xs">{errorText()}</p>
            </Show>
          </div>

          <div class="flex gap-2">
            <button
              data-testid="btn-send-knock"
              onClick={() => void handleSendKnock()}
              disabled={status() === "sending"}
              class="flex-1 px-3 py-2 bg-magenta-500 hover:bg-magenta-600 disabled:bg-magenta-400 text-white text-sm transition-colors"
            >
              {status() === "sending" ? "sending..." : "send knock"}
            </button>
            <button
              onClick={props.onDismiss}
              disabled={status() === "sending"}
              class="px-3 py-2 border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white text-sm transition-colors"
            >
              cancel
            </button>
          </div>
        </Show>

        <Show when={status() === "pending"}>
          <div class="space-y-3">
            <p class="text-gray-300 text-xs">
              knock sent - waiting for{" "}
              <span class="text-white">{ownerLabel()}</span> to accept. you can
              dismiss this and try again later.
            </p>
            <button
              onClick={props.onDismiss}
              class="w-full px-3 py-2 border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white text-sm transition-colors"
            >
              dismiss
            </button>
          </div>
        </Show>

        <Show when={status() === "denied"}>
          <div class="space-y-3">
            <p class="text-red-400 text-xs">
              access denied by the playlist owner.
            </p>
            <button
              onClick={props.onDismiss}
              class="w-full px-3 py-2 border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white text-sm transition-colors"
            >
              dismiss
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
