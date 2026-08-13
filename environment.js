(() => {
  const development = /\/board-game\/dev(?:\/|$)/.test(location.pathname);
  const prefix = development ? "board-game:dev:" : "board-game:prod:";
  const keys = new Set(["word-card-players", "word-card-player-count", "word-card-set", "word-card-word-sets"]);
  const get = localStorage.getItem.bind(localStorage);
  const set = localStorage.setItem.bind(localStorage);
  const remove = localStorage.removeItem.bind(localStorage);
  const scoped = key => keys.has(key) ? `${prefix}${key}` : key;

  localStorage.getItem = key => {
    const value = get(scoped(key));
    if (value !== null || development || !keys.has(key)) return value;
    const legacy = get(key);
    if (legacy !== null) set(scoped(key), legacy);
    return legacy;
  };
  localStorage.setItem = (key, value) => set(scoped(key), value);
  localStorage.removeItem = key => {
    remove(scoped(key));
    if (!development && keys.has(key)) remove(key);
  };

  if (!development) return;
  const setDevelopmentTitle = () => {
    document.title = "貴族のひそめごと DEV";
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", "貴族のひそめごと DEV");
  };
  setDevelopmentTitle();
  window.addEventListener("load", setDevelopmentTitle, { once: true });
  const style = document.createElement("style");
  style.textContent = ".dev-badge{position:fixed;z-index:2000;top:8px;right:8px;padding:3px 7px;border:1px solid #f0c36e;border-radius:999px;background:#2f2416;color:#ffe5a7;font:800 11px/1 system-ui,sans-serif;letter-spacing:.08em;pointer-events:none}";
  document.head.append(style);
  const badge = document.createElement("div");
  badge.className = "dev-badge";
  badge.setAttribute("aria-label", "開発版");
  badge.textContent = "DEV";
  document.body.prepend(badge);
})();
