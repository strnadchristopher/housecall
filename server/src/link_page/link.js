// Reads the login code from the address fragment, which the browser never sends to the server.
// Nothing here makes a network request. The code goes only into the "Continue in browser" link.
(function () {
  var fragment = location.hash;
  history.replaceState(null, "", "/link");
  var host = document.getElementById("host");
  host.textContent = "Log in on " + location.host;
  var ok = /^#hcl1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(fragment);
  if (ok) {
    document.getElementById("web").href = "/#link=" + fragment.slice(1);
    document.getElementById("ok").hidden = false;
  } else {
    document.getElementById("bad").hidden = false;
  }
  fragment = "";
})();
