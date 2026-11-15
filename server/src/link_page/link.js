// LINK-V1: strip the code synchronously before parsing, rendering, or setting a link.
(function () {
  var fragment = location.hash.slice(1);
  history.replaceState(null, "", "/link");
  var origin;
  try { origin = new URL(location.origin); } catch (_) { fragment = ""; }
  var allowed = origin && origin.origin === location.origin && !origin.username && !origin.password && (origin.protocol === "https:" || origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].indexOf(origin.hostname) !== -1);
  var valid = allowed && (location.origin + "/link#" + fragment).length <= 512 && /^hcl1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(fragment);
  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("ok").hidden = !valid;
    document.getElementById("missing").hidden = !!valid;
    if (valid) {
      document.getElementById("host").textContent = location.host;
      document.getElementById("web").href = "/#link=" + fragment;
    } else document.getElementById("ok").remove();
    fragment = "";
  }, { once: true });
})();
