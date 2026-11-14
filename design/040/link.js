// HC-040 section 10.6, LINK-V1 section 3. Ships as link/link.js beside link/index.html (the CSP forbids inline script).
// The code lives after the # and never reaches the server. It is NEVER handed to the app: "Open in Housecall" is the
// fixed text housecall://link-scan and the person scans again inside the app (R-0). Only the web client receives it.
(function () {
  var code = location.hash.slice(1);
  // First thing: take the code out of the address bar and this tab's history entry (R-15).
  try { history.replaceState(null, "", "/link"); } catch (error) { /* file:// mockup: not allowed, nothing to hide */ }
  var ok = code.length <= 512 && /^hcl1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(code);
  document.getElementById("ok").hidden = !ok;
  document.getElementById("missing").hidden = ok;
  if (!ok) return;
  document.getElementById("host").textContent = location.host || "this server";
  document.getElementById("web").href = "/#link=" + code;
})();
