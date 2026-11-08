import type { ScreenProps } from '../../contracts/ui';
import { Icon } from '../icons/Icon';
import { Page } from '../contract';
import { Avatar, cx } from '../primitives';
import { setTheme, useUi } from '../store';
import { themeOrder, themeVars, themes } from '../tokens/themes';
import { useView } from './People';

const CAP_NAMES: Record<string, string> = {
  passkeys: 'Passkeys', giphy: 'GIF search', plex: 'Plex watch party', dj: 'Steve Forever DJ', vm: 'Shared VM',
  voice: 'Voice and video', sfu: 'Voice and video', activity_sync: 'Activity sync', gimme_dry_run: 'Gimme in dry-run mode', gimme: 'Gimme requests',
  push: 'Push notifications', uploads: 'Uploads', reports: 'Reports', scanning: 'Upload scanning', transcoding: 'Video transcoding',
};

/** Settings: appearance (themes live only in ui/tokens) and what this server can do. */
export function SettingsScreen(props: ScreenProps) {
  useView(props.id);
  const current = useUi(s => s.theme);
  const items = props.items ?? [];
  return (
    <Page props={props} icon="gear" title="Settings" wide subtitle={<span className="cc-sr">{props.title}</span>}>
      <section aria-labelledby="cc-appearance" className="cc-settings__sec">
        <h2 id="cc-appearance" className="cc-section-title">Appearance</h2>
        <div className="cc-themes" role="radiogroup" aria-label="Theme">
          {themeOrder.map(id => {
            const t = themes[id];
            const on = current === id;
            return (
              <button key={id} type="button" role="radio" aria-checked={on} className={cx('cc-theme', on && 'is-on')} onClick={() => setTheme(id)}
                style={themeVars(id) as React.CSSProperties} data-cc-scheme={t.scheme}>
                <span className="cc-theme__view" aria-hidden>
                  <span className="cc-theme__side"><i /><i /><i className="is-on" /><i /></span>
                  <span className="cc-theme__chat">
                    <span className="cc-theme__msg"><Avatar name={t.name} size={18} presence={false} /><span><b>{t.name.toLowerCase()}</b><em>see you at eight <span className="cc-mention">@you</span></em></span></span>
                    <span className="cc-theme__box"><span /><span className="cc-theme__send" /></span>
                  </span>
                </span>
                <span className="cc-theme__name cc-display">{t.name}</span>
                <span className="cc-theme__note">{t.note}</span>
                {on && <Icon name="check" size={16} className="cc-theme__tick" />}
              </button>
            );
          })}
        </div>
        <p className="cc-muted">Saved on this device only.</p>
      </section>

      <section aria-labelledby="cc-caps" className="cc-settings__sec">
        <h2 id="cc-caps" className="cc-section-title">This server</h2>
        {items.length ? (
          <ul className="cc-caps">
            {items.map(i => {
              const m = /^(.*): (available|unavailable)$/.exec(i.text);
              const on = m?.[2] === 'available';
              return (
                <li key={i.id} data-item-id={i.id} className={cx('cc-cap', on ? 'is-on' : 'is-off')}>
                  <Icon name={on ? 'check' : 'close'} size={15} />
                  <span className="cc-cap__name">{CAP_NAMES[m?.[1] ?? ''] ?? (m?.[1] ?? i.text).replace(/_/g, ' ')}</span>
                  <span className="cc-sr">{i.text}</span>
                  <span className="cc-cap__state" aria-hidden>{m ? (on ? 'On' : 'Off') : ''}</span>
                </li>
              );
            })}
          </ul>
        ) : <p className="cc-muted">The server has not reported its capabilities yet.</p>}
      </section>
    </Page>
  );
}
