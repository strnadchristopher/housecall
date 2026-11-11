/**
 * Design workbench. Mounts the real contract Screen with fixture props in the
 * same DOM shape App.tsx produces (#root > div > shell + content + media).
 * Fixture media streams are drawn on canvases and labelled as fixtures.
 * Not part of the shipped client bundle.
 */
import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { Intent } from '../../contracts/ui';
import { Screen } from '../Screen';
import { setTheme, setUi } from '../store';
import { themeOrder, type ThemeId } from '../tokens/themes';
import { scenes, sceneScreens } from './fixtures';

declare global { interface Window { __intents: Intent[] } }
window.__intents = [];
const onIntent = async (i: Intent) => { window.__intents.push(i); console.info('[intent]', JSON.stringify(i)); };

const params = new URLSearchParams(location.search);
const theme = params.get('theme') as ThemeId | null;
if (theme && themeOrder.includes(theme)) setTheme(theme);

function fixtureStream(n: number, w = 640, h = 360) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const hue = [28, 150, 200, 340, 70, 110][n % 6];
  const draw = () => {
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${hue} 18% 22%)`);
    grad.addColorStop(1, `hsl(${hue} 22% 10%)`);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.font = '600 22px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(`Fixture stream ${n + 1}`, w / 2, h / 2 - 6);
    g.font = '15px system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillText('canvas, not a camera', w / 2, h / 2 + 20);
  };
  draw();
  const stream = c.captureStream(5);
  setInterval(draw, 400);
  return stream;
}

function FixtureVideo({ n, testid }: { n: number; testid: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = fixtureStream(n, testid === 'remote-media' ? 640 : 1280, testid === 'remote-media' ? 360 : 720);
    void el.play().catch(() => {});
  }, [n, testid]);
  return <video ref={ref} muted playsInline autoPlay data-testid={testid} controls={testid === 'remote-media'} />;
}

function Index() {
  return (
    <main style={{ padding: 32, fontFamily: 'system-ui', color: 'var(--cc-ink)', overflow: 'auto', height: '100dvh' }}>
      <h1 className="cc-display" style={{ fontSize: 36, fontWeight: 400 }}>Housecall UI workbench</h1>
      <p style={{ color: 'var(--cc-ink-3)', margin: '8px 0 20px' }}>Fixture props only. Themes: {themeOrder.map(t => <a key={t} style={{ color: 'var(--cc-accent)', marginRight: 10 }} href={`?theme=${t}`}>{t}</a>)}</p>
      <ul style={{ columns: 3, listStyle: 'none', padding: 0 }}>
        {scenes.map(s => <li key={s.name} style={{ padding: '3px 0' }}><a style={{ color: 'var(--cc-ink)' }} href={`?scene=${s.name}${theme ? `&theme=${theme}` : ''}`}>{s.name}</a> <span style={{ color: 'var(--cc-ink-3)' }}>{s.note}</span></li>)}
      </ul>
    </main>
  );
}

function Workbench() {
  const scene = sceneScreens(params.get('scene') ?? '');
  useEffect(() => { if (scene?.drawer) setTimeout(() => setUi({ drawer: true }), 50); }, [scene]);
  if (!scene) return <Index />;
  return (
    <div>
      {scene.screens.map(p => <Screen key={p.id} {...p} onIntent={onIntent} />)}
      {scene.media === 'plex' && <FixtureVideo n={0} testid="plex-media" />}
      {scene.media === 'video' && <FixtureVideo n={2} testid="uploaded-media" />}
      {scene.media === 'dj' && <audio data-testid="dj-media" controls aria-label="Shared DJ playback" />}
      {Array.from({ length: scene.streams ?? 0 }, (_, i) => <FixtureVideo key={i} n={i} testid="remote-media" />)}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Workbench /></StrictMode>);
