
import { createSignal, onMount, onCleanup } from "solid-js";
import { saveSetting, loadSetting } from "../services/indexedDBService.js";

const SIDEBAR_SETTING_KEY = "sidebarCollapsed";

export function useUIState() {
  const [isMobile, setIsMobile] = createSignal(false);

  // visual state: whether the sidebar is currently hidden.
  // starts collapsed - visibility is derived from edit mode + preference
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(true);

  // persisted preference: how the user last toggled the sidebar.
  // applied whenever the sidebar is allowed to show (edit mode / no playlists).
  // default open (false).
  const [sidebarPreferredCollapsed, setSidebarPreferredCollapsed] =
    createSignal(false);

  // user toggle: flips visual state and persists it as the preference
  const toggleSidebar = () => {
    const next = !sidebarCollapsed();
    setSidebarCollapsed(next);
    setSidebarPreferredCollapsed(next);
    saveSetting(SIDEBAR_SETTING_KEY, next);
  };

  const [isDragOver, setIsDragOver] = createSignal(false);

  const [backgroundImageUrl, setBackgroundImageUrl] = createSignal<
    string | null
  >(null);

  const [imageUrlCache] = createSignal(new Map<string, string>());

  const checkMobile = () => {
    const mobile = window.innerWidth < 900;
    setIsMobile(mobile);
  };

  // window resize for mobile detection
  const handleResize = () => {
    checkMobile();
  };

  // escape key for closing modals/dialogs
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // this can be extended by components using this hook
      return { key: e.key, preventDefault: () => e.preventDefault() };
    }
    return undefined;
  };

  // init + cleanup for mobile detection
  onMount(() => {
    // restore persisted sidebar preference (default: open = false)
    loadSetting<boolean>(SIDEBAR_SETTING_KEY).then((stored) => {
      if (stored !== null) {
        setSidebarPreferredCollapsed(stored);
      }
    });

    checkMobile();
    window.addEventListener("resize", handleResize);
    document.addEventListener("keydown", handleKeyDown);

    onCleanup(() => {
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("keydown", handleKeyDown);
    });
  });

  // trash image URLs when component unmounts
  onCleanup(() => {
    const cache = imageUrlCache();
    cache.forEach((url) => {
      if (url.startsWith("blob:")) {
        URL.revokeObjectURL(url);
      }
    });
    cache.clear();
  });

  return {
    isMobile,
    sidebarCollapsed,
    sidebarPreferredCollapsed,
    isDragOver,
    backgroundImageUrl,
    imageUrlCache,

    // setterz
    setIsMobile,
    setSidebarCollapsed,
    toggleSidebar,
    setIsDragOver,
    setBackgroundImageUrl,

    // utilz
    checkMobile,
  };
}
