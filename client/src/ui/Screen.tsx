import type { FormEvent } from 'react';
import type { ScreenProps } from '../contracts/ui';

/** Unstyled contract fixture. Visual and interaction design belongs to Opus. */
export function Screen(props: ScreenProps) {
  const emit = (action: string, itemId?: string, values: Record<string, string | boolean> = {}) => props.onIntent({ screen: props.id, action, itemId, values });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values: Record<string, string | boolean> = {};
    for (const field of props.fields ?? []) values[field.name] = field.type === 'checkbox' ? data.has(field.name) : String(data.get(field.name) ?? '');
    void emit('submit', undefined, values);
  }
  return <section data-testid={`screen-${props.id}`} aria-busy={props.busy}>
    <h1>{props.title}</h1>
    <p role="status">{props.phase}</p>
    {props.error && <p role="alert">{props.error}</p>}
    {props.fields && <form onSubmit={submit}>
      {props.fields.map(field => <label key={field.name}>{field.label}<input name={field.name} type={field.type ?? 'text'} defaultValue={field.value} required={field.required} disabled={props.busy} /></label>)}
      <button disabled={props.busy} type="submit">{props.submitLabel ?? 'Submit'}</button>
    </form>}
    <ul>{props.items?.map(item => <li key={item.id} data-item-id={item.id}>{item.text}{item.actions?.map(action => <button key={action.id} disabled={props.busy || action.disabled} onClick={() => void emit(action.id, item.id)}>{action.label}</button>)}</li>)}</ul>
    {props.actions?.map(action => <button key={action.id} disabled={props.busy || action.disabled} onClick={() => void emit(action.id)}>{action.label}</button>)}
  </section>;
}
