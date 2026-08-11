(() => {
  let preferred = "";
  try { preferred = localStorage.getItem("capacity-atlas-locale") || ""; } catch {}
  if (!preferred) preferred = navigator.language || "";
  if (!String(preferred).toLowerCase().startsWith("en")) return;
  document.documentElement.lang = "en";
  document.documentElement.dataset.localePending = "true";
  setTimeout(() => { delete document.documentElement.dataset.localePending; }, 3_000);
})();
