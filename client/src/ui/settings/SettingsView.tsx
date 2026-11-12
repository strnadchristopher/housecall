import { useState, type ReactNode } from "react";
import { useIdentity } from "../../core/context";
import { DeviceMenu } from "../call/DeviceMenu";
import { copy } from "../copy";
import { Avatar, ErrorLine, Icon, IconButton, NavRow, cx, type IconName } from "../kit";
import { useNav, type SettingsSection } from "../shell/nav";
import { ACCENTS, applyAccent, readAccent, type AccentId } from "../tokens/accent";
import { usePhone } from "../tokens/motion";
import { IntegrationSetup } from "../setup/IntegrationSetup";
import { About, AccessRequests, Account, Appearance, Channels, ServerProfile, Devices, InvitePeople, Invites, Notifications, ReportProblem, Reports, Roles } from "./sections";

type Row = { id: SettingsSection; label: string; icon?: IconName; lead?: ReactNode; detail?: string; badge?: number };
type Group = { label: string; rows: Row[] };

/**
 * Settings as a tree. On a phone: a root of grouped rows (you, this server, help), each drilling into its
 * section, with Back returning to the root; Back on the root returns to the chat. On wide screens the same
 * rows sit in a column beside the open section.
 */
export function SettingsView() {
  const identity = useIdentity();
  const nav = useNav();
  const phone = usePhone();
  const [accent, setAccent] = useState<AccentId>(() => readAccent());
  const me = identity.me;
  const groups: Group[] = [
    { label: copy.settings.you, rows: [
      { id: "account", label: copy.settings.account, lead: me ? <Avatar name={me.name} src={me.avatarUrl} size="sm" /> : <Icon name="people" />, detail: phone ? me?.name : undefined },
      { id: "appearance", label: copy.settings.appearance, icon: "accent", detail: ACCENTS.find(option => option.id === accent)?.label },
      { id: "notifications", label: copy.settings.notifications, icon: "bell" },
      { id: "call", label: copy.settings.call, icon: "mic" },
      { id: "devices", label: copy.settings.devices, icon: "screen" },
    ] },
    { label: identity.serverName, rows: [
      ...(identity.owner ? [
        { id: "server", label: copy.settings.serverProfile, lead: <Avatar name={identity.serverName} src={identity.serverIconUrl} size="sm" shape="squircle" /> },
        { id: "invites", label: copy.settings.invites, icon: "link" },
        { id: "access", label: copy.settings.access, icon: "door", badge: identity.accessRequestsPending },
        { id: "channels", label: copy.settings.channels, icon: "hash" },
        { id: "roles", label: copy.settings.roles, icon: "people" },
        { id: "reports", label: copy.settings.reports, icon: "file" },
      ] as Row[] : [
        { id: "invite-people", label: copy.settings.invitePeople, icon: "link" },
      ] as Row[]),
      { id: "integrations", label: copy.settings.integrations, icon: "chords" },
    ] },
    { label: copy.settings.help, rows: [
      { id: "report", label: copy.settings.report, icon: "flag" },
      { id: "about", label: copy.settings.about, icon: "info" },
    ] },
  ];
  const section = nav.section ?? (phone ? null : "account");
  const title = groups.flatMap(group => group.rows).find(row => row.id === section)?.label;
  const detailOnPhone = phone && !!section;
  const close = () => nav.set({ main: "chat", section: null });
  const chooseAccent = (id: AccentId) => setAccent(applyAccent(id));

  return (
    <div className="hc-settings" data-testid="screen-settings" data-depth={section ? "detail" : "root"}>
      <header className="hc-header">
        {phone
          ? <IconButton icon="back" label={detailOnPhone ? copy.settings.label : copy.common.back} onClick={detailOnPhone ? () => nav.set({ section: null }) : close} />
          : <IconButton icon="close" label={copy.common.close} onClick={close} />}
        <div className="hc-header__title"><h1>{detailOnPhone ? title : copy.settings.label}</h1></div>
      </header>
      <div className="hc-settings__body">
        {!detailOnPhone && (
          <nav key="root" className={cx("hc-settings__nav", phone && "hc-anim-slide-left")} aria-label={copy.settings.label}>
            {groups.map(group => (
              <section key={group.label} className="hc-settings__group" aria-label={group.label}>
                <h2 className="hc-settings__grouplabel">{group.label}</h2>
                <ul className="hc-navgroup">
                  {group.rows.map(row => (
                    <li key={row.id}>
                      <NavRow label={row.label} detail={row.detail} current={!phone && section === row.id}
                        badge={row.badge} badgeLabel={row.badge ? copy.settings.waiting(row.badge) : undefined}
                        lead={row.lead ?? (row.icon && <span className={row.id === "appearance" ? "hc-navrow__accent" : undefined}><Icon name={row.icon} /></span>)}
                        onClick={() => nav.set({ section: row.id })} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </nav>
        )}
        {section && (
          <section key={section} className="hc-settings__pane hc-anim-slide-right" aria-label={title}>
            {!phone && <h2>{title}</h2>}
            <ErrorLine text={identity.error} onDismiss={identity.clearError} dismissLabel={copy.common.dismiss} />
            {section === "account" && identity.me && <Account />}
            {section === "appearance" && <Appearance accent={accent} onChange={chooseAccent} />}
            {section === "server" && identity.owner && <ServerProfile />}
            {section === "devices" && <Devices />}
            {section === "notifications" && <Notifications />}
            {section === "call" && <DeviceMenu />}
            {section === "report" && <ReportProblem />}
            {section === "invites" && identity.owner && <Invites />}
            {section === "access" && identity.owner && <AccessRequests />}
            {section === "invite-people" && <InvitePeople />}
            {section === "channels" && <Channels />}
            {section === "roles" && <Roles />}
            {section === "reports" && <Reports />}
            {section === "integrations" && <IntegrationSetup />}
            {section === "about" && <About />}
          </section>
        )}
      </div>
    </div>
  );
}
