import { HostedProvider, useHosted } from "./hosted/HostedAccount";
import type { Hosts } from "./adapters/legacy/hosts";
import type { Updater } from "./adapters/legacy/identity";
import { LegacyHost } from "./adapters/legacy/LegacyHost";
import { useHosts } from "./adapters/legacy/hosts";
import { useDesktopUpdater } from "./adapters/legacy/updater";
import { Root } from "./ui/Root";

/**
 * Thin router: mounts one backend adapter per connected host and hands the
 * active one to the interface. Everything visible lives under ui/ and talks
 * to core/ interfaces only.
 */
export function App() {
  const hosts = useHosts();
  const updater = useDesktopUpdater();
  return <HostedProvider hosts={hosts}><HostViews hosts={hosts} updater={updater} /></HostedProvider>;
}

function HostViews({ hosts, updater }: { hosts: Hosts; updater: Updater }) {
  const hosted = useHosted();
  return (
    <>
      {hosts.hosts.map(host => (
        <LegacyHost key={`${hosted?.epoch ?? 0}:${host.id}`} host={host} hosts={hosts} updater={updater}>
          <Root />
        </LegacyHost>
      ))}
    </>
  );
}
