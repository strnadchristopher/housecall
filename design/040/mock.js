/*
 * Mockup helper. No framework, no network: it only stamps repeated markup (icons, the left column,
 * the right column) so each mockup file holds the surface it is about. The class names and the DOM
 * shape here are the ones the spec names; the data is made up.
 *
 *   <i data-i="mic"></i>                      an icon           (data-off draws the slash)
 *   <span data-av="mara" data-size="sm">      an avatar
 *   <nav data-part="left" data-opts='{..}'>   the left column   (see left() for the options)
 *   <aside data-part="right" data-tab="people|chat">
 *   <* data-show="a b"> / <* data-hide="a">   kept or removed by the ?s=<state> query
 */
(() => {
  const ICONS = window.HC_ICONS;
  const state = new URLSearchParams(location.search).get("s") || "";
  document.documentElement.dataset.s = state;
  const phone = matchMedia("(max-width: 47.5em)").matches;
  document.documentElement.dataset.phone = phone ? "1" : "0";

  const icon = (name, off) => `<svg class="hc-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="${ICONS[name] || ""}"/>${off ? `<path d="${ICONS.slash}"/>` : ""}</svg>`;
  const hash = text => { let v = 0; for (let i = 0; i < text.length; i++) v = (v * 31 + text.charCodeAt(i)) >>> 0; return v; };
  const av = (name, size = "md", extra = "") => `<span class="hc-avatar hc-avatar--${size} ${extra}" data-tone="${hash(name) % 6}" aria-hidden="true">${name[0].toUpperCase()}</span>`;
  const ibtn = (name, label, cls = "", off = false) => `<button type="button" class="hc-ibtn ${cls}" aria-label="${label}">${icon(name, off)}</button>`;
  const live = '<button type="button" class="hc-livepill" aria-label="mara is live. Preview the stream">LIVE</button>';

  /** One person inside a voice channel. flags: live, camera, muted, deafened, speaking, me */
  const vrow = (name, flags = "") => {
    const f = new Set(flags.split(" "));
    return `<li class="hc-vrow${f.has("speaking") ? " is-speaking" : ""}${f.has("me") ? " is-me" : ""}">
      <button type="button" class="hc-vrow__open" aria-label="${name}"></button>
      <span class="hc-face${f.has("speaking") ? " is-speaking" : ""}">${av(name, "xs")}</span>
      <span class="hc-vrow__name">${name}</span>
      <span class="hc-vrow__state">${f.has("live") ? live : ""}${f.has("camera") ? icon("camera") : ""}${f.has("deafened") ? icon("headphones", true) : f.has("muted") ? icon("mic", true) : ""}</span>
    </li>`;
  };
  const channel = (kind, name, o = {}) => `<li>
    <div class="hc-channel${o.current ? " is-current" : ""}${o.unread ? " is-unread" : ""}${o.lit ? " is-lit" : ""}${o.joined ? " is-joined" : ""}${o.hover ? " is-hover" : ""}">
      <button type="button" class="hc-channel__open" ${o.current ? 'aria-current="page"' : ""} aria-label="Open ${name}"></button>
      <span class="hc-channel__glyph">${icon(kind === "voice" ? "speaker" : "hash")}</span>
      <span class="hc-channel__name">${name}</span>
      ${kind === "voice" ? `<span class="hc-channel__side">${ibtn("chat", `Chat in ${name}`)}</span>` : ""}
      ${o.mentions ? `<span class="hc-count" aria-label="${o.mentions} mentions">${o.mentions}</span>` : ""}
      ${o.people ? `<span class="hc-channel__n" aria-label="${o.people.length} inside">${o.people.length}</span>` : ""}
    </div>
    ${o.people ? `<ul class="hc-voice__people" aria-label="In ${name}">${o.people.map(p => vrow(...p)).join("")}</ul>` : ""}
  </li>`;

  const signal = (bars, busy) => `<button type="button" class="hc-signal hc-tipped" data-bars="${bars}" ${busy ? "data-busy" : ""} aria-label="Connection">
      <i></i><i></i><i></i><span class="hc-tip" role="tooltip" data-side="start">${bars ? "32 ms to server" : "No connection"}</span></button>`;
  const CALL = {
    connected: { bars: 3, line: "Voice connected" },
    weak: { bars: 1, line: "Weak connection" },
    connecting: { bars: 0, busy: true, line: "Connecting" },
    reconnecting: { bars: 0, busy: true, line: "Reconnecting" },
    failed: { bars: 0, line: "Call failed" },
  };
  const callcard = (kind, o = {}) => {
    const c = CALL[kind];
    return `<section class="hc-callcard" data-state="${kind}" aria-label="Current call">
      ${signal(c.bars, c.busy)}
      <button type="button" class="hc-callcard__main" aria-label="Open Lounge"><strong>${o.name || "Lounge"}</strong><small>${c.line}</small></button>
      <div class="hc-callcard__ctl" role="toolbar" aria-label="Call">
        ${kind === "failed" ? '<button type="button" class="hc-btn">Try again</button>'
          : ibtn("mic", o.muted ? "Unmute" : "Mute", o.muted ? "is-active" : "", o.muted) + ibtn("headphones", o.deafened ? "Undeafen" : "Deafen", o.deafened ? "is-active" : "", o.deafened)}
        ${ibtn("leave", "Leave", "hc-ibtn--danger")}
      </div>
    </section>`;
  };

  const LOUNGE = [["mara", "live speaking"], ["june", "camera"], ["felix", "muted"]];
  /**
   * opts: current (channel name), call (key of CALL or ""), me (in Lounge), owner (default true),
   *       lounge ("full" | "empty"), muted, deafened, bio, unread, offline
   */
  const left = (o = {}) => {
    const cur = o.current ?? "general";
    const owner = o.owner !== false;
    const add = label => owner ? `<button type="button" class="hc-group__add" aria-label="${label}">${icon("plus")}</button>` : "";
    const lounge = [...(o.lounge === "empty" ? [] : LOUNGE), ...(o.me ? [["theo", `me${o.deafened ? " deafened" : o.muted ? " muted" : ""}`]] : [])];
    return `
    <div class="hc-picker">
      <button type="button" class="hc-picker__trigger" aria-haspopup="listbox">
        <svg class="hc-logo" viewBox="0 0 32 32" aria-hidden="true"><path class="hc-logo__ink" d="M6 3H12V10.83A10 10 0 0 1 26 20V29H20V20A4 4 0 0 0 12 20V29H6Z"/><path class="hc-logo__lit" d="M12 29V20A4 4 0 0 1 20 20V29Z"/><path class="hc-logo__leaf" d="M12 29V20A4 4 0 0 1 12.6 17.9L15.4 19.6V29Z"/></svg>
        <span class="hc-picker__name"><strong>Theo's place</strong><small ${o.offline ? 'data-state="off"' : ""}>${o.offline ? "Reconnecting" : "Connected"}</small></span>
        <span class="hc-picker__chev">${icon("down")}</span>
      </button>
    </div>
    <div class="hc-channels">
      <section class="hc-group" aria-labelledby="g-text">
        <div class="hc-group__head"><h2 class="hc-group__label" id="g-text">Text channels</h2>${add("Create text channel")}</div>
        <ul class="hc-group__list">
          ${channel("text", "general", { current: cur === "general" })}
          ${channel("text", "kitchen", { current: cur === "kitchen", unread: o.unread !== false })}
          ${channel("text", "movie-night", { current: cur === "movie-night", unread: true, mentions: o.unread !== false ? 2 : 0 })}
          ${channel("text", "photos", { current: cur === "photos" })}
        </ul>
      </section>
      <section class="hc-group" aria-labelledby="g-voice">
        <div class="hc-group__head"><h2 class="hc-group__label" id="g-voice">Voice channels</h2>${add("Create voice channel")}</div>
        <ul class="hc-group__list">
          ${channel("voice", "Lounge", { current: cur === "Lounge", lit: lounge.length > 0, joined: !!o.me, people: lounge.length ? lounge : undefined })}
          ${channel("voice", "Porch", { current: cur === "Porch" })}
          ${channel("voice", "Workshop", { current: cur === "Workshop", lit: true, people: [["noor", "deafened"]] })}
        </ul>
      </section>
    </div>
    ${o.call ? callcard(o.call, o) : ""}
    <footer class="hc-userbar">
      <button type="button" class="hc-userbar__me" aria-label="Your profile">
        ${av("theo")}
        <span class="hc-userbar__name"><strong>theo</strong><small ${o.offline ? 'data-state="off"' : ""}>${o.offline ? "Reconnecting" : o.bio ?? "Kettle's on. Knock first."}</small></span>
      </button>
      <span class="hc-userbar__mail">${ibtn("mail", "Direct messages")}<span class="hc-dot" role="img" aria-label="1 mention"></span></span>
      ${ibtn("gear", "Settings")}
    </footer>`;
  };

  const PEOPLE = [["felix", "", "Sound guy. Asleep by ten."], ["june", "", "Bringing the popcorn"], ["mara", "", ""], ["noor", "", "Night shifts this week"], ["theo", "Owner", "Kettle's on. Knock first."]];
  const sideChat = `
    <div class="hc-messages" style="padding-inline:0"><ol>
      ${[["june", "9:02 PM", "is the stream lagging for anyone?"], ["felix", "9:02 PM", "smooth here"], ["mara", "9:03 PM", "switching to the other window, one sec"]].map(([n, t, b]) => `
      <li class="hc-msg" style="padding-inline: var(--hc-space-2)"><div class="hc-msg__gutter">${av(n)}</div><div class="hc-msg__main"><p class="hc-msg__head"><strong>${n}</strong><time>${t}</time></p><div class="hc-md"><p>${b}</p></div></div></li>`).join("")}
    </ol></div>
    <form class="hc-composer is-compact"><div class="hc-composer__row"><textarea rows="1" placeholder="Message Lounge" aria-label="Message"></textarea>${ibtn("emoji", "Emoji")}${ibtn("send", "Send", "hc-composer__send")}</div></form>`;
  const right = (tab = "people", o = {}) => `
    <div class="hc-tabs" role="tablist" aria-label="Details">
      ${o.chat ? `<button type="button" role="tab" class="hc-tab${tab === "chat" ? " is-current" : ""}">Chat</button>` : ""}
      <button type="button" role="tab" class="hc-tab${tab === "people" ? " is-current" : ""}">People</button>
      <button type="button" role="tab" class="hc-tab${tab === "apps" ? " is-current" : ""}">Apps</button>
      <span class="hc-tabs__end">${phone ? ibtn("close", "Close") : ""}</span>
    </div>
    <div class="hc-side__body${tab === "chat" ? " hc-side__body--chat" : ""}">
      ${tab === "chat" ? sideChat : `<ul class="hc-people">${PEOPLE.map(([n, role, bio]) => `
        <li><button type="button" class="hc-person__open" aria-label="${n}"></button>${av(n)}<span><strong>${n}${role ? ` <em class="hc-role">${role}</em>` : ""}</strong>${bio ? `<small>${bio}</small>` : ""}</span></li>`).join("")}</ul>`}
    </div>`;

  const MSGS = [
    ["mara", "8:35 PM", "Who set this up? It's fast."],
    ["theo", "8:35 PM", "Runs on the little box under my desk."],
    ["june", "8:36 PM", "The real cloud was the friends we made along the way"],
    ["mara", "8:41 PM", "Is the film still on for Friday?"],
    ["theo", "8:41 PM", "Yes. <strong>8 pm</strong>, my place. Bring the good blanket.", { reacts: [["🙌", 1], ["🎬", 2, true]], pinned: true }],
    ["june", "8:44 PM", "I'll bring popcorn. Salted or the fancy caramel one?"],
    ["felix", "8:44 PM", "Both. Obviously.", { open: true }],
    ["mara", "8:52 PM", `Hopping in Lounge if anyone wants to pick the film live. <span class="hc-mention is-me">@theo</span> you around?`, { mention: true }],
  ];
  const bar = `<div class="hc-msg__bar" role="toolbar" aria-label="Messages">
      ${[["reply", "Reply"], ["emoji", "React"], ["pin", "Pin"], ["link", "Preview"], ["edit", "Edit"], ["trash", "Unsend", "hc-ibtn--danger"]].map(([i, l, c]) => `<button type="button" class="hc-ibtn ${c || ""}" aria-label="${l}">${icon(i)}<span class="hc-msg__lab">${l}</span></button>`).join("")}</div>`;
  const messages = (o = {}) => `<div class="hc-messages"><ol>
      <li class="hc-msg"><p class="hc-day">Today</p></li>
      ${MSGS.map(([n, t, b, x = {}]) => `
      <li class="hc-msg${x.mention ? " is-mention" : ""}${o.open && x.open ? " is-open" : ""}" tabindex="-1">
        <div class="hc-msg__gutter">${av(n)}</div>
        <div class="hc-msg__main">
          <p class="hc-msg__head"><strong>${n}</strong><time>${t}</time>${x.pinned ? `<span class="hc-msg__flag">${icon("pin")}Pinned</span>` : ""}</p>
          <div class="hc-md"><p>${b}</p></div>
          ${x.reacts ? `<div class="hc-reacts">${x.reacts.map(([e, c, mine]) => `<button type="button" class="hc-react${mine ? " is-mine" : ""}"><span>${e}</span><span>${c}</span></button>`).join("")}</div>` : ""}
          ${bar}
        </div>
      </li>`).join("")}
    </ol></div>`;
  const composer = (name, o = {}) => `<form class="hc-composer">${o.above || ""}
      <div class="hc-composer__row">${ibtn("plus", "Attach file")}${phone ? ibtn("snap", "Take a snap") : ""}<textarea rows="1" placeholder="Message ${name}" aria-label="Message" ${o.disabled ? "disabled" : ""}></textarea>${ibtn("emoji", "Emoji")}<button type="button" class="hc-ibtn hc-composer__send" aria-label="Send" disabled>${icon("send")}</button></div></form>`;
  const header = (kind, name, o = {}) => `<header class="hc-header">
      ${phone ? `<span class="hc-header__menu">${ibtn("menu", "Menu")}</span>` : ""}
      <div class="hc-header__title">
        ${kind === "dm" ? av(name, "sm") : `<span class="hc-header__glyph">${icon(kind === "voice" ? "speaker" : "hash")}</span>`}
        <h1>${name}</h1>${o.meta ? `<span class="hc-header__meta">${o.meta}</span>` : ""}
      </div>
      ${o.buttons ?? (ibtn("search", "Search") + ibtn("pin", "Pins") + (phone || o.people ? ibtn("people", "People") : "") + ibtn("settings", "Server settings"))}
    </header>`;

  window.HC = { icon, av, ibtn, vrow, channel, callcard, signal, left, right, messages, composer, header, live, state, phone };

  const stamp = root => {
    root.querySelectorAll("[data-show]").forEach(el => { if (!el.dataset.show.split(" ").includes(state || "default")) el.remove(); });
    root.querySelectorAll("[data-hide]").forEach(el => { if (el.dataset.hide.split(" ").includes(state || "default")) el.remove(); });
    root.querySelectorAll("[data-show-phone]").forEach(el => { if ((el.dataset.showPhone === "1") !== phone) el.remove(); });
    root.querySelectorAll("[data-part]").forEach(el => {
      const o = el.dataset.opts ? JSON.parse(el.dataset.opts) : {};
      const so = el.dataset["opts-" + state] || el.getAttribute(`data-opts-${state}`);
      Object.assign(o, so ? JSON.parse(so) : {});
      const p = el.dataset.part;
      el.innerHTML = p === "left" ? left(o) : p === "right" ? right(el.dataset.tab, o) : p === "messages" ? messages(o) : p === "composer" ? composer(o.name || "general", o)
        : p === "header" ? header(o.kind || "text", o.name || "general", o) : p === "callcard" ? callcard(o.call || "connected", o) : "";
    });
    root.querySelectorAll("[data-i]").forEach(el => { el.outerHTML = icon(el.dataset.i, el.hasAttribute("data-off")); });
    root.querySelectorAll("[data-av]").forEach(el => { el.outerHTML = av(el.dataset.av, el.dataset.size || "md", el.className); });
  };
  document.addEventListener("DOMContentLoaded", () => {
    stamp(document);
    // Mock-only: a class stands in for :hover and :focus-visible so a screenshot can show them.
    document.querySelectorAll("[data-tip-open]").forEach(el => el.setAttribute("data-open", ""));
    document.documentElement.dataset.ready = "1";
  });
})();
