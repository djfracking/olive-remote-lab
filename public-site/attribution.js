(() => {
  "use strict";

  const allowedSources = new Set([
    "direct",
    "site-home",
    "site-o4hd",
    "site-remote-app",
    "site-waking-up",
    "site-library-recovery",
    "diyaudio-one",
    "stereonet-olive4",
    "avs-official",
    "martinlogan-firmware",
    "whathifi-waking",
    "reddit-o4hd-ssd",
    "reddit-one-update",
    "forumhifi-opus4",
    "ls35a-o3hd",
    "audiostereo-o4hd",
    "youtube-o4hd",
    "youtube-one",
  ]);

  const querySource = new URLSearchParams(window.location.search).get("source");
  const defaultSource = document.documentElement.dataset.defaultSource || "direct";
  const source = allowedSources.has(querySource)
    ? querySource
    : allowedSources.has(defaultSource)
      ? defaultSource
      : "direct";

  document.querySelectorAll("[data-source-form]").forEach((form) => {
    const field = form.querySelector("input[name='source']");
    if (field) field.value = source;
  });

  document.querySelectorAll("a[data-source-link]").forEach((link) => {
    const url = new URL(link.href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    url.searchParams.set("source", source);
    link.href = `${url.pathname}${url.search}${url.hash}`;
  });
})();
