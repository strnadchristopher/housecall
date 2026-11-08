import type { ComponentType } from 'react';
import type { ScreenId, ScreenProps } from '../contracts/ui';
import './styles/index.css';
import { ContractForm, ItemList, Page } from './contract';
import { ConversationScreen } from './chat/Conversation';
import { ComposerScreen } from './chat/Composer';
import { OnboardingScreen } from './Onboarding';
import { ShellScreen } from './Shell';
import { ActivitiesScreen } from './screens/Activities';
import { DjScreen, GifsScreen, GimmeScreen, LinkPreviewScreen, PlexScreen, ReportScreen, ReportsAdminScreen, UploadsScreen } from './screens/Media';
import {
  ChannelsAdminScreen, DevicesScreen, DirectMessagesScreen, InvitesAdminScreen, MembersScreen, NotificationsScreen,
  RolesAdminScreen, SearchScreen, ServersAdminScreen, useView,
} from './screens/People';
import { SettingsScreen } from './screens/Settings';
import { VoiceScreen } from './screens/Voice';
import { bootUi } from './store';

bootUi();

const SCREENS: Partial<Record<ScreenId, ComponentType<ScreenProps>>> = {
  setup: OnboardingScreen,
  invite: OnboardingScreen,
  login: OnboardingScreen,
  shell: ShellScreen,
  conversation: ConversationScreen,
  composer: ComposerScreen,
  search: SearchScreen,
  pins: SearchScreen,
  members: MembersScreen,
  'direct-messages': DirectMessagesScreen,
  uploads: UploadsScreen,
  media: LinkPreviewScreen,
  gifs: GifsScreen,
  voice: VoiceScreen,
  activities: ActivitiesScreen,
  plex: PlexScreen,
  dj: DjScreen,
  gimme: GimmeScreen,
  notifications: NotificationsScreen,
  settings: SettingsScreen,
  devices: DevicesScreen,
  'invites-admin': InvitesAdminScreen,
  report: ReportScreen,
  'reports-admin': ReportsAdminScreen,
  'servers-admin': ServersAdminScreen,
  'channels-admin': ChannelsAdminScreen,
  'roles-admin': RolesAdminScreen,
};

/**
 * The contract entry point (client/src/contracts/ui.ts). App.tsx renders every
 * screen through this one component; it dispatches to the designed screen for
 * props.id. Unknown screens get a designed generic page, so a new contract
 * screen still works before it has bespoke design.
 */
export function Screen(props: ScreenProps) {
  const Designed = SCREENS[props.id] ?? GenericScreen;
  return <Designed {...props} />;
}

export function GenericScreen(props: ScreenProps) {
  useView(props.id);
  return (
    <Page props={props}>
      {props.fields?.length ? <ContractForm props={props} /> : null}
      <ItemList props={props} className="cc-rows" />
    </Page>
  );
}
