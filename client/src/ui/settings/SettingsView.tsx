import { useIdentity } from "../../core/context";
import { DeviceMenu } from "../call/DeviceMenu";
import { copy } from "../copy";
import { ErrorLine, IconButton, cx } from "../kit";
import { useNav, type SettingsSection } from "../shell/nav";
import { usePhone } from "../tokens/motion";
import { IntegrationSetup } from "../setup/IntegrationSetup";
import { About, Account, Channels, ServerProfile, Devices, Invites, Notifications, ReportProblem, Reports, Roles } from "./sections";

/** Account and server settings in one place; owner-only sections appear for the owner. */
export function SettingsView() {
  const identity = useIdentity();
  const nav = useNav();
  const phone = usePhone();
  const personal: [SettingsSection, string][] = [
    ["account", copy.settings.account], ["devices", copy.settings.devices], ["notifications", copy.settings.notifications],
    ["call", copy.settings.call], ["report", copy.settings.report],
  ];
  const server: [SettingsSection, string][] = [
    ...(identity.owner ? [["server", copy.settings.serverProfile], ["invites", copy.settings.invites], ["channels", copy.settings.channels], ["roles", copy.settings.roles], ["reports", copy.settings.reports]] as [SettingsSection, string][] : []),
    ["integrations", copy.settings.integrations],
    ["about", copy.settings.about],
  ];
  const item = ([id, label]: [SettingsSection, string]) => (
    <li key={id}>
      <button type="button" className={cx("hc-channel", nav.section === id && "is-current")} aria-current={nav.section === id ? "page" : undefined}
        onClick={() => nav.set({ section: id })}>{label}</button>
    </li>
  );
  const title = [...personal, ...server].find(([id]) => id === nav.section)?.[1];
  return (
    <div className="hc-settings" data-testid="screen-settings">
      <header className="hc-header">
        <IconButton icon={phone ? "back" : "close"} label={phone ? copy.common.back : copy.common.close} onClick={() => nav.set(phone ? { main: "chat", screen: "list" } : { main: "chat" })} />
        <div className="hc-header__title"><h1>{copy.settings.label}</h1></div>
      </header>
      <div className="hc-settings__body">
        <nav className="hc-settings__nav" aria-label={copy.settings.label}>
          <ul>{personal.map(item)}</ul>
          <h2 className="hc-label">{copy.settings.server}</h2>
          <ul>{server.map(item)}</ul>
        </nav>
        <section className="hc-settings__pane" aria-labelledby="hc-settings-title">
          <h2 id="hc-settings-title">{title}</h2>
          <ErrorLine text={identity.error} onDismiss={identity.clearError} dismissLabel={copy.common.dismiss} />
          {nav.section === "account" && identity.me && <Account />}
          {nav.section === "server" && identity.owner && <ServerProfile />}
          {nav.section === "devices" && <Devices />}
          {nav.section === "notifications" && <Notifications />}
          {nav.section === "call" && <DeviceMenu />}
          {nav.section === "report" && <ReportProblem />}
          {nav.section === "invites" && <Invites />}
          {nav.section === "channels" && <Channels />}
          {nav.section === "roles" && <Roles />}
          {nav.section === "reports" && <Reports />}
          {nav.section === "integrations" && <IntegrationSetup />}
          {nav.section === "about" && <About />}
        </section>
      </div>
    </div>
  );
}
